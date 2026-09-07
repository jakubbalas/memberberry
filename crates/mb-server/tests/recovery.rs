//! Invariant I1 across the durable note, CRDT, index and permission boundaries (§22.4).

#![allow(clippy::expect_used, clippy::panic)]

mod support;

use mb_core::Username;
use mb_crdt::{apply_external_markdown, document_from_update_v1, document_from_yrs};
use mb_server::indexing::IndexRegistry;
use mb_server::repository::AuthorizedVault;
use mb_server::sync::NoteCoordinator;
use mb_server::vault::Slug;
use mb_server::watch::Changes;
use mb_server::{AccessFile, Vault};
use support::TempDir;
use yrs::{ReadTxn, Transact};

const POLICY: &str = r#"
[[members]]
user = "alice"
role = "owner"

[[members]]
user = "bob"
role = "viewer"

[[rules]]
path = "Private"
[rules.grant]
bob = "none"
"#;

const EDITED: &str = "---\ntitle: Recovery\ntags: [recovery]\n---\n\n# Recovered\n\n[[Target]] and #project/recovery\n\n- [ ] Verify recovery 📅 2026-09-06\n\nمرحبا 👋 café\n";

fn open(dir: &TempDir) -> Vault {
    Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("reopen the vault from durable files")
}

fn fixture() -> TempDir {
    let dir = TempDir::new("i1-recovery");
    dir.write("access.toml", POLICY);
    dir.write("notes/Source.md", "before\n");
    dir.write("notes/Target.md", "# Target\n");
    dir.write(
        "notes/Private/Secret.md",
        "# Secret\n\n[[Target]] #secret\n",
    );
    dir
}

fn edit(vault: &Vault, markdown: &str) {
    let canonical = vault.canonical_note("Source.md").expect("note");
    let mut coordinator = NoteCoordinator::open(vault, &canonical).expect("coordinator");
    let replica = document_from_update_v1(&coordinator.full_update()).expect("replica");
    let vector = replica.transact().state_vector();
    apply_external_markdown(&replica, markdown).expect("edit the replica");
    let update = replica.transact().encode_state_as_update_v1(&vector);
    coordinator
        .apply_remote_update(&update, std::time::Instant::now())
        .expect("accept the remote update");
    coordinator
        .flush()
        .expect("materialize before deleting merge history");
}

#[derive(Debug, PartialEq, Eq)]
struct ReadableState {
    notes: Vec<(String, String, mb_core::extract::Extracted)>,
    backlinks: Vec<mb_index::BacklinkGroup>,
    tags: Vec<mb_index::TagNode>,
    graph: mb_index::VaultGraph,
}

fn read_state(vault: &Vault, username: &str) -> ReadableState {
    let access = AccessFile::load(vault.root()).expect("load durable ACL");
    let user = Username::parse(username).expect("user");
    let repository = AuthorizedVault::new(vault, access.policy(), user.clone());
    let notes = repository
        .notes()
        .expect("filtered notes")
        .into_iter()
        .map(|path| {
            let markdown = repository.read(&path).expect("filtered source");
            let extracted = mb_core::extract(&mb_core::parse(&markdown));
            (path, markdown, extracted)
        })
        .collect();
    let registry = IndexRegistry::default();
    assert!(
        registry
            .maintain(std::iter::once(vault), &Changes::All)
            .is_empty()
    );
    let index = registry.get(vault).expect("index");
    let mut index = index.lock().expect("index lock");
    let reader = index
        .reader(access.policy(), &user)
        .expect("filtered reader");
    ReadableState {
        notes,
        backlinks: reader.backlinks("Target.md").expect("backlinks"),
        tags: reader.tags().expect("tags"),
        graph: reader.vault_graph(None).expect("graph"),
    }
}

#[test]
fn deleting_all_derived_state_preserves_edited_notes_and_rebuilds_a_writable_replica() {
    let dir = fixture();
    let before = {
        let vault = open(&dir);
        edit(&vault, EDITED);
        let state = read_state(&vault, "alice");
        let source = state
            .notes
            .iter()
            .find(|(path, _, _)| path == "Source.md")
            .expect("edited note in the baseline");
        assert_eq!(source.1, mb_core::normalize(EDITED));
        assert_eq!(
            source.2.tasks.len(),
            1,
            "the fixture must exercise task recovery"
        );
        assert_eq!(
            state.backlinks.len(),
            2,
            "both inbound links exist before deletion"
        );
        assert!(
            !state.tags.is_empty(),
            "the baseline must contain indexed tags"
        );
        assert!(
            !state.graph.edges.is_empty(),
            "the baseline must contain graph edges"
        );
        state
    };
    assert!(dir.path().join(".memberberry/crdt").is_dir());
    assert!(dir.path().join(".memberberry/index/graph.sqlite").is_file());
    std::fs::remove_dir_all(dir.path().join(".memberberry")).expect("delete ALL derived state");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("access.toml")).expect("ACL survived"),
        POLICY
    );

    let restarted = open(&dir);
    assert_eq!(read_state(&restarted, "alice"), before);
    let canonical = restarted
        .canonical_note("Source.md")
        .expect("recovered note");
    let coordinator = NoteCoordinator::open(&restarted, &canonical).expect("reseed from Markdown");
    let replica = document_from_update_v1(&coordinator.full_update()).expect("fresh replica");
    assert_eq!(
        mb_core::to_markdown(&document_from_yrs(&replica).expect("materialize recovered CRDT")),
        mb_core::normalize(EDITED),
    );
    drop(coordinator);
    edit(&restarted, "# Still writable\n\n[[Target]]\n");
    let reopened = open(&dir);
    let access = AccessFile::load(reopened.root()).expect("ACL");
    let view = AuthorizedVault::new(
        &reopened,
        access.policy(),
        Username::parse("alice").expect("user"),
    );
    assert_eq!(
        view.read("Source.md").expect("second edit"),
        "# Still writable\n\n[[Target]]\n"
    );
}

#[test]
fn e5_i1_rebuild_preserves_denials_across_repository_links_tags_and_graph() {
    let dir = fixture();
    let before = {
        let vault = open(&dir);
        edit(&vault, EDITED);
        let state = read_state(&vault, "bob");
        assert_eq!(state.notes.len(), 2);
        assert_eq!(state.backlinks.len(), 1);
        assert!(state.tags.iter().all(|tag| tag.key != "secret"));
        assert!(
            state
                .graph
                .nodes
                .iter()
                .all(|node| node.path.as_deref() != Some("Private/Secret.md"))
        );
        state
    };
    std::fs::remove_dir_all(dir.path().join(".memberberry")).expect("delete derived state");
    let restarted = open(&dir);
    assert_eq!(read_state(&restarted, "bob"), before);
    let access = AccessFile::load(restarted.root()).expect("reloaded ACL");
    let bob = AuthorizedVault::new(
        &restarted,
        access.policy(),
        Username::parse("bob").expect("user"),
    );
    for path in ["Private/Secret.md", "Absent.md"] {
        assert!(matches!(bob.read(path), Err(mb_server::Error::NotFound)));
    }
    let outsider = read_state(&restarted, "outsider");
    assert!(outsider.notes.is_empty());
    assert!(outsider.backlinks.is_empty());
    assert!(outsider.tags.is_empty());
    assert!(outsider.graph.nodes.is_empty());
}

#[test]
fn i1_missing_acl_after_rebuild_denies_every_read() {
    let dir = fixture();
    {
        let vault = open(&dir);
        edit(&vault, EDITED);
        assert!(!read_state(&vault, "alice").notes.is_empty());
    }
    std::fs::remove_dir_all(dir.path().join(".memberberry")).expect("delete derived state");
    std::fs::remove_file(dir.path().join("access.toml")).expect("simulate missing ACL");
    let denied = read_state(&open(&dir), "alice");
    assert!(denied.notes.is_empty());
    assert!(denied.backlinks.is_empty());
    assert!(denied.tags.is_empty());
    assert!(denied.graph.nodes.is_empty());
}
