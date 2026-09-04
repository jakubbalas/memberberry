//! Index maintenance against a real vault (`SPEC.md` §9.1, §3.4, §22.4).
//!
//! The unit tests in `indexing.rs` cover which paths are notes. These cover the part that
//! needs files: what a sweep finds, what the watcher's targeted path re-reads, and what
//! deleting the derived directory costs.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

mod support;

use std::collections::BTreeSet;

use mb_core::{Access, Member, Role, Username};
use mb_server::indexing::IndexRegistry;
use mb_server::vault::Slug;
use mb_server::watch::Changes;
use mb_server::{AccessFile, Vault};
use support::TempDir;

fn vault(dir: &TempDir) -> Vault {
    Vault::open(Slug::parse("v").expect("slug"), "V", dir.path()).expect("vault")
}

fn owner() -> (Access, Username) {
    let alice = Username::parse("alice").expect("username");
    let access = Access::new(
        vec![Member {
            user: alice.clone(),
            role: Role::Owner,
        }],
        vec![],
    )
    .expect("policy");
    (access, alice)
}

/// Backlink source paths for `path`, as the vault owner.
fn sources(registry: &IndexRegistry, vault: &Vault, path: &str) -> Vec<String> {
    let (access, alice) = owner();
    let index = registry.get(vault).expect("index");
    let mut index = index.lock().expect("index lock");
    let reader = index.reader(&access, &alice).expect("reader");
    reader
        .backlinks(path)
        .expect("backlinks")
        .into_iter()
        .map(|group| group.path)
        .collect()
}

#[test]
fn a_sweep_indexes_the_whole_vault() {
    let dir = TempDir::new("index-sweep");
    dir.write("Projects/Roadmap.md", "# Roadmap\n");
    dir.write("Q3.md", "ship [[Roadmap]]\n");
    let vault = vault(&dir);
    let registry = IndexRegistry::default();
    assert!(
        registry
            .maintain(std::iter::once(&vault), &Changes::All)
            .is_empty()
    );
    assert_eq!(sources(&registry, &vault, "Projects/Roadmap.md"), ["Q3.md"]);
}

#[test]
fn the_index_database_lands_under_the_derived_directory() {
    // §4.1 puts it in `.memberberry/`, which is the whole reason Invariant I1 is possible:
    // one directory to gitignore, one directory to delete.
    let dir = TempDir::new("index-location");
    dir.write("a.md", "# A\n");
    let vault = vault(&dir);
    let registry = IndexRegistry::default();
    registry.maintain(std::iter::once(&vault), &Changes::All);
    assert!(dir.path().join(".memberberry/index/graph.sqlite").is_file());
}

#[test]
fn the_index_never_indexes_itself() {
    // Its own database sits under a dotted directory, and so does another application's
    // config. A `.md` file in either must not become a note.
    let dir = TempDir::new("index-dotted");
    dir.write("a.md", "# A\n");
    dir.write(".memberberry/trash/Deleted.md", "# Deleted\n\n[[A]]\n");
    dir.write(".obsidian/notes.md", "# Config\n\n[[A]]\n");
    let vault = vault(&dir);
    let registry = IndexRegistry::default();
    registry.maintain(std::iter::once(&vault), &Changes::All);
    assert!(sources(&registry, &vault, "a.md").is_empty());
}

#[test]
fn a_watcher_hint_re_reads_only_the_paths_it_names() {
    // §3.4's fast path. The sweep is what makes the index correct; this is what makes it
    // timely, and it must not need a directory walk to do its job.
    let dir = TempDir::new("index-touched");
    dir.write("A.md", "# A\n");
    dir.write("B.md", "nothing yet\n");
    dir.write("C.md", "nothing yet\n");
    let vault = vault(&dir);
    let registry = IndexRegistry::default();
    registry.maintain(std::iter::once(&vault), &Changes::All);

    dir.write("B.md", "now [[A]]\n");
    dir.write("C.md", "also [[A]]\n");
    let touched = Changes::Only(BTreeSet::from([dir
        .path()
        .join("B.md")
        .canonicalize()
        .expect("canonicalize")]));
    registry.maintain(std::iter::once(&vault), &touched);
    assert_eq!(
        sources(&registry, &vault, "A.md"),
        ["B.md"],
        "C.md was re-read despite not being named"
    );

    // And the sweep catches up with what the watcher never mentioned.
    registry.maintain(std::iter::once(&vault), &Changes::All);
    assert_eq!(sources(&registry, &vault, "A.md"), ["B.md", "C.md"]);
}

#[test]
fn a_hint_naming_a_file_outside_the_vault_is_ignored() {
    let dir = TempDir::new("index-outside");
    let elsewhere = TempDir::new("index-elsewhere");
    dir.write("A.md", "# A\n");
    elsewhere.write("Outside.md", "[[A]]\n");
    let vault = vault(&dir);
    let registry = IndexRegistry::default();
    registry.maintain(std::iter::once(&vault), &Changes::All);
    let touched = Changes::Only(BTreeSet::from([elsewhere
        .path()
        .join("Outside.md")
        .canonicalize()
        .expect("canonicalize")]));
    assert!(
        registry
            .maintain(std::iter::once(&vault), &touched)
            .is_empty()
    );
    assert!(sources(&registry, &vault, "A.md").is_empty());
}

#[test]
fn a_sweep_drops_a_note_that_left_the_vault() {
    let dir = TempDir::new("index-deleted");
    dir.write("A.md", "# A\n");
    dir.write("B.md", "[[A]]\n");
    let vault = vault(&dir);
    let registry = IndexRegistry::default();
    registry.maintain(std::iter::once(&vault), &Changes::All);
    assert_eq!(sources(&registry, &vault, "A.md"), ["B.md"]);

    std::fs::remove_file(dir.path().join("B.md")).expect("delete");
    registry.maintain(std::iter::once(&vault), &Changes::All);
    assert!(sources(&registry, &vault, "A.md").is_empty());
}

#[test]
fn i1_deleting_the_derived_directory_costs_a_reindex_and_nothing_else() {
    // Invariant I1 (§22.4), for the index. Deliberately across two registries: an open
    // SQLite connection keeps working from a deleted inode, so a test that reused the first
    // registry would prove nothing at all.
    let dir = TempDir::new("index-i1");
    dir.write("A.md", "# A\n\n#tag/one\n");
    dir.write("B.md", "[[A]] and #tag/two\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n",
    );
    let vault = vault(&dir);
    {
        let registry = IndexRegistry::default();
        registry.maintain(std::iter::once(&vault), &Changes::All);
        assert_eq!(sources(&registry, &vault, "A.md"), ["B.md"]);
    }

    std::fs::remove_dir_all(dir.path().join(".memberberry")).expect("rm -rf .memberberry");
    assert!(dir.path().join("access.toml").is_file(), "ACLs are durable");

    let restarted = IndexRegistry::default();
    assert!(
        restarted
            .maintain(std::iter::once(&vault), &Changes::All)
            .is_empty()
    );
    assert_eq!(
        sources(&restarted, &vault, "A.md"),
        ["B.md"],
        "links did not come back after the derived directory was deleted"
    );
    // And permissions came back from `access.toml`, which is not derived state.
    let access = AccessFile::load(vault.root()).expect("access.toml");
    let index = restarted.get(&vault).expect("index");
    let mut index = index.lock().expect("lock");
    let reader = index
        .reader(access.policy(), &Username::parse("alice").expect("user"))
        .expect("reader");
    assert_eq!(reader.readable_notes(), 2);
}

#[test]
fn an_unwritable_vault_directory_degrades_to_an_in_memory_index() {
    // why: asserted rather than assumed. A read-only mount is a real deployment, and the
    // honest degradation is an index rebuilt at every start — not a vault whose backlinks
    // panel is permanently empty. The database path is a *file* here, which is the one way
    // to make `.memberberry/index/` uncreatable without depending on filesystem modes.
    let dir = TempDir::new("index-readonly");
    dir.write("A.md", "# A\n");
    dir.write("B.md", "[[A]]\n");
    dir.write(".memberberry/index", "not a directory");
    let vault = vault(&dir);
    let registry = IndexRegistry::default();
    assert!(
        registry
            .maintain(std::iter::once(&vault), &Changes::All)
            .is_empty()
    );
    assert_eq!(sources(&registry, &vault, "A.md"), ["B.md"]);
    assert!(
        !dir.path().join(".memberberry/index").is_dir(),
        "the fixture stopped reproducing the case it exists for"
    );
}

#[test]
fn one_registry_keeps_each_vault_separate() {
    // Links do not cross vaults in v1 (§4.3), which is a property of there being one index
    // per vault rather than a check anybody has to remember to write.
    let first = TempDir::new("index-vault-one");
    let second = TempDir::new("index-vault-two");
    first.write("A.md", "# A\n");
    second.write("B.md", "[[A]]\n");
    let one = Vault::open(Slug::parse("one").expect("slug"), "One", first.path()).expect("vault");
    let two = Vault::open(Slug::parse("two").expect("slug"), "Two", second.path()).expect("vault");
    let registry = IndexRegistry::default();
    registry.maintain([&one, &two].into_iter(), &Changes::All);
    assert!(
        sources(&registry, &one, "A.md").is_empty(),
        "a link in another vault resolved across the boundary"
    );
}

#[test]
fn maintaining_a_vault_whose_notes_root_disappeared_reports_rather_than_panics() {
    let dir = TempDir::new("index-gone");
    dir.write("A.md", "# A\n");
    let vault = vault(&dir);
    let registry = IndexRegistry::default();
    registry.maintain(std::iter::once(&vault), &Changes::All);
    std::fs::remove_dir_all(dir.path()).expect("remove the vault");
    let errors = registry.maintain(std::iter::once(&vault), &Changes::All);
    assert_eq!(errors.len(), 1, "{errors:?}");
    assert!(errors[0].contains("listing notes"), "{errors:?}");
}
