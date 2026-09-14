//! The privileged rename, end to end over a real vault (`SPEC.md` §6.6, E14).
//!
//! The property this file exists to hold is the uncomfortable one: a rename rewrites notes
//! the actor **cannot read**, and must do so without telling them those notes are there.
//! Both halves are asserted — the rewrite happens (`a_note_the_actor_cannot_read_is_still_repointed`)
//! and the reply does not count it (`the_reply_counts_only_what_the_actor_can_read`). Either
//! one alone would pass against a broken implementation of the other.

#![allow(
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::panic
)]

mod support;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use mb_core::{Access, Member, NotePath, Role, Rule, Username};
use mb_index::Index;
use mb_server::Vault;
use mb_server::audit::AuditLog;
use mb_server::rename::{Rename, RenameError};
use mb_server::sync::SyncRegistry;
use mb_server::vault::Slug;
use support::TempDir;

/// A vault, its index and its registries — everything a rename needs, wired as `serve` does.
struct Fixture {
    dir: TempDir,
    vault: Vault,
    index: Arc<Mutex<Index>>,
    sync: SyncRegistry,
    audit: AuditLog,
}

impl Fixture {
    fn new(label: &str, notes: &[(&str, &str)]) -> Self {
        let dir = TempDir::new(label);
        for (path, body) in notes {
            dir.write(path, body);
        }
        let vault = Vault::open(
            Slug::parse("personal").expect("slug"),
            "Personal",
            dir.path(),
        )
        .expect("vault");
        let index = mb_server::indexing::IndexRegistry::default()
            .get(&vault)
            .expect("an index");
        {
            let mut open = index.lock().expect("index lock");
            // why: here rather than lazily. Every rename reads the link graph, so a fixture
            // that served an empty index would make each test below one that cannot fail.
            mb_server::indexing::reconcile(&vault, &mut open).expect("building the index");
        }
        let audit = AuditLog::new(dir.path(), 1024 * 1024).expect("audit log");
        Self {
            dir,
            vault,
            index,
            sync: SyncRegistry::default(),
            audit,
        }
    }

    fn rename<'a>(&'a self, access: &'a Access, actor: &str) -> Rename<'a> {
        Rename::new(
            &self.vault,
            access,
            Username::parse(actor).expect("username"),
            &self.index,
            &self.sync,
            Some(&self.audit),
        )
    }

    fn read(&self, path: &str) -> String {
        std::fs::read_to_string(self.dir.path().join(path)).unwrap_or_else(|_| {
            panic!("{path} should exist");
        })
    }

    fn exists(&self, path: &str) -> bool {
        self.dir.path().join(path).exists()
    }

    fn audit_lines(&self) -> Vec<serde_json::Value> {
        let raw = std::fs::read_to_string(self.dir.path().join("audit.log")).unwrap_or_default();
        raw.lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }

    /// Backlinks as one user sees them now — proof the index agrees with the files.
    fn backlink_sources(&self, access: &Access, actor: &str, note: &str) -> Vec<String> {
        let user = Username::parse(actor).expect("username");
        let mut index = self.index.lock().expect("index lock");
        let reader = index.reader(access, &user).expect("reader");
        reader
            .backlinks(note)
            .expect("backlinks")
            .into_iter()
            .map(|group| group.path)
            .collect()
    }
}

fn user(name: &str) -> Username {
    Username::parse(name).expect("username")
}

/// `alice` edits everything; `bob` edits everything except `Private/`, which he cannot see.
fn split_access() -> Access {
    Access::new(
        vec![
            Member {
                user: user("alice"),
                role: Role::Owner,
            },
            Member {
                user: user("bob"),
                role: Role::Editor,
            },
        ],
        vec![Rule {
            path: NotePath::parse("Private").expect("path"),
            grants: BTreeMap::from([(user("bob"), Role::None)]),
        }],
    )
    .expect("policy")
}

fn owner_only(name: &str) -> Access {
    Access::new(
        vec![Member {
            user: user(name),
            role: Role::Owner,
        }],
        Vec::new(),
    )
    .expect("policy")
}

#[test]
fn renaming_a_note_moves_the_file_and_repoints_every_inbound_link() {
    let fixture = Fixture::new(
        "rename-basic",
        &[
            ("Roadmap.md", "# Roadmap\n"),
            ("One.md", "See [[Roadmap]] and ![[Roadmap#Q3]].\n"),
            ("Two.md", "Nothing here.\n"),
        ],
    );
    let access = owner_only("alice");
    let renamed = fixture
        .rename(&access, "alice")
        .note("Roadmap.md", "Plan.md")
        .expect("the rename should succeed");

    assert!(!fixture.exists("Roadmap.md"), "the old file should be gone");
    assert_eq!(fixture.read("Plan.md"), "# Plan\n");
    assert_eq!(
        fixture.read("One.md"),
        "See [[Plan]] and ![[Plan#Q3]].\n",
        "both the link and the embed should follow the note"
    );
    assert_eq!(fixture.read("Two.md"), "Nothing here.\n");
    assert_eq!(renamed.notes, 1);
    assert_eq!(renamed.references, 2);
}

#[test]
fn the_index_agrees_with_the_files_after_a_rename() {
    // A rename that leaves the index naming the old path gives a backlinks panel that
    // disagrees with the note the reader is looking at, which is worse than no panel.
    let fixture = Fixture::new(
        "rename-index",
        &[
            ("Roadmap.md", "# Roadmap\n"),
            ("One.md", "See [[Roadmap]].\n"),
        ],
    );
    let access = owner_only("alice");
    fixture
        .rename(&access, "alice")
        .note("Roadmap.md", "Plan.md")
        .expect("rename");

    assert_eq!(
        fixture.backlink_sources(&access, "alice", "Plan.md"),
        vec!["One.md".to_string()]
    );
    assert!(
        fixture
            .backlink_sources(&access, "alice", "Roadmap.md")
            .is_empty()
    );
}

#[test]
fn a_note_the_actor_cannot_read_is_still_repointed() {
    // §6.6's whole reason for being privileged. `bob` cannot read `Private/Salary.md` and
    // could not write it, and its link to the renamed note is still fixed.
    let fixture = Fixture::new(
        "rename-privileged",
        &[
            ("Roadmap.md", "# Roadmap\n"),
            ("Open.md", "See [[Roadmap]].\n"),
            ("Private/Salary.md", "Budget in [[Roadmap]].\n"),
        ],
    );
    let access = split_access();
    fixture
        .rename(&access, "bob")
        .note("Roadmap.md", "Plan.md")
        .expect("rename");

    assert_eq!(fixture.read("Open.md"), "See [[Plan]].\n");
    assert_eq!(
        fixture.read("Private/Salary.md"),
        "Budget in [[Plan]].\n",
        "a link in a note the actor cannot read must not be left broken (§6.6)"
    );
}

#[test]
fn the_reply_counts_only_what_the_actor_can_read() {
    // The other half of the pair above. "3 notes updated" when the actor can see one of them
    // answers "how many notes link to this", which §6.5 forbids — a count is a claim about
    // notes that do not exist for this caller.
    let fixture = Fixture::new(
        "rename-counts",
        &[
            ("Roadmap.md", "# Roadmap\n"),
            ("Open.md", "See [[Roadmap]].\n"),
            (
                "Private/Salary.md",
                "Budget in [[Roadmap]] and [[Roadmap]].\n",
            ),
            ("Private/Board.md", "Also [[Roadmap]].\n"),
        ],
    );
    let access = split_access();
    let renamed = fixture
        .rename(&access, "bob")
        .note("Roadmap.md", "Plan.md")
        .expect("rename");

    assert_eq!(renamed.notes, 1, "bob may read exactly one of the three");
    assert_eq!(renamed.references, 1);
    // …and all three were rewritten regardless.
    assert!(fixture.read("Private/Board.md").contains("[[Plan]]"));
}

#[test]
fn the_audit_log_names_every_file_the_rewrite_touched() {
    // §6.6: audit-logged with actor, time and every file touched. This is the only place the
    // full list exists, which is what lets the reply above be as thin as it is.
    let fixture = Fixture::new(
        "rename-audit",
        &[
            ("Roadmap.md", "# Roadmap\n"),
            ("Open.md", "See [[Roadmap]].\n"),
            ("Private/Salary.md", "Budget in [[Roadmap]].\n"),
        ],
    );
    let access = split_access();
    fixture
        .rename(&access, "bob")
        .note("Roadmap.md", "Plan.md")
        .expect("rename");

    let lines = fixture.audit_lines();
    assert_eq!(lines.len(), 1, "one record per rename");
    let record = &lines[0];
    assert_eq!(record["action"], "privileged_rewrite");
    assert_eq!(record["result"], "success");
    assert_eq!(record["actor"], "bob");
    assert_eq!(record["vault"], "personal");
    let targets: Vec<&str> = record["targets"]
        .as_array()
        .expect("targets")
        .iter()
        .filter_map(|value| value.as_str())
        .collect();
    assert!(targets.contains(&"Plan.md"));
    assert!(targets.contains(&"Open.md"));
    assert!(
        targets.contains(&"Private/Salary.md"),
        "the file the actor cannot read is exactly the one the log has to record"
    );
    assert!(
        record["timestamp"].as_str().is_some_and(|at| at != "0"),
        "a record with no usable time cannot be audited"
    );
}

#[test]
fn a_note_the_actor_cannot_read_cannot_be_renamed_and_answers_as_a_missing_one() {
    let fixture = Fixture::new(
        "rename-denied-read",
        &[("Private/Salary.md", "# Salary\n"), ("Open.md", "hi\n")],
    );
    let access = split_access();
    let rename = fixture.rename(&access, "bob");
    // The two probes differ in the way an attacker cares about — one names a real file —
    // and must answer identically.
    assert!(matches!(
        rename.note("Private/Salary.md", "Pay.md"),
        Err(RenameError::Denied)
    ));
    assert!(matches!(
        rename.note("Private/Absent.md", "Pay.md"),
        Err(RenameError::Denied)
    ));
    assert!(fixture.exists("Private/Salary.md"));
}

#[test]
fn a_viewer_may_not_rename_a_note_they_can_read() {
    let fixture = Fixture::new("rename-viewer", &[("Roadmap.md", "# Roadmap\n")]);
    let access = Access::new(
        vec![Member {
            user: user("carol"),
            role: Role::Viewer,
        }],
        Vec::new(),
    )
    .expect("policy");
    assert!(matches!(
        fixture
            .rename(&access, "carol")
            .note("Roadmap.md", "Plan.md"),
        Err(RenameError::Denied)
    ));
    assert!(fixture.exists("Roadmap.md"));
}

#[test]
fn a_destination_the_actor_may_not_write_is_denied() {
    // Moving a note *into* a folder is creating one there, so the destination needs write
    // access of its own — otherwise a rename is a way to plant a note anywhere.
    let fixture = Fixture::new(
        "rename-denied-write",
        &[("Open.md", "# Open\n"), ("Private/Salary.md", "# Salary\n")],
    );
    let access = split_access();
    assert!(matches!(
        fixture
            .rename(&access, "bob")
            .note("Open.md", "Private/Open.md"),
        Err(RenameError::Denied)
    ));
    assert!(fixture.exists("Open.md"));
    assert!(!fixture.exists("Private/Open.md"));
}

#[test]
fn a_destination_that_already_exists_is_refused() {
    let fixture = Fixture::new(
        "rename-exists",
        &[("Roadmap.md", "# Roadmap\n"), ("Plan.md", "# Plan\n")],
    );
    let access = owner_only("alice");
    assert!(matches!(
        fixture
            .rename(&access, "alice")
            .note("Roadmap.md", "Plan.md"),
        Err(RenameError::Exists(_))
    ));
    assert_eq!(fixture.read("Plan.md"), "# Plan\n");
    assert!(fixture.exists("Roadmap.md"));
}

#[test]
fn a_destination_that_leaves_the_vault_is_refused() {
    let fixture = Fixture::new("rename-traversal", &[("Roadmap.md", "# Roadmap\n")]);
    let access = owner_only("alice");
    let rename = fixture.rename(&access, "alice");
    for destination in [
        "../escaped.md",
        "/etc/passwd.md",
        "sub/../../escaped.md",
        ".hidden/Plan.md",
        "Plan.txt",
        "",
    ] {
        assert!(
            matches!(
                rename.note("Roadmap.md", destination),
                Err(RenameError::InvalidName(_))
            ),
            "{destination:?} should not be a usable destination"
        );
    }
    assert!(fixture.exists("Roadmap.md"));
}

#[test]
fn a_link_that_resolves_to_a_different_note_of_the_same_name_is_left_alone() {
    // §4.3 resolves a bare name by nearest path, so `[[Roadmap]]` in `Archive/` means the
    // one in `Archive/`. Rewriting it because the *other* `Roadmap` moved would break a link
    // that was pointing exactly where its author meant.
    let fixture = Fixture::new(
        "rename-collision",
        &[
            ("Projects/Roadmap.md", "# Projects roadmap\n"),
            ("Archive/Roadmap.md", "# Archive roadmap\n"),
            ("Projects/Q3.md", "See [[Roadmap]].\n"),
            ("Archive/Old.md", "See [[Roadmap]].\n"),
        ],
    );
    let access = owner_only("alice");
    fixture
        .rename(&access, "alice")
        .note("Projects/Roadmap.md", "Projects/Plan.md")
        .expect("rename");

    assert_eq!(fixture.read("Projects/Q3.md"), "See [[Plan]].\n");
    assert_eq!(
        fixture.read("Archive/Old.md"),
        "See [[Roadmap]].\n",
        "the archived link still means the archived note"
    );
}

#[test]
fn an_ambiguous_new_name_is_written_as_a_path_so_it_cannot_resolve_elsewhere() {
    let fixture = Fixture::new(
        "rename-ambiguous",
        &[
            ("Projects/Roadmap.md", "# Roadmap\n"),
            ("Archive/Plan.md", "# Another plan\n"),
            ("Projects/Q3.md", "See [[Roadmap]].\n"),
        ],
    );
    let access = owner_only("alice");
    fixture
        .rename(&access, "alice")
        .note("Projects/Roadmap.md", "Projects/Plan.md")
        .expect("rename");

    assert_eq!(
        fixture.read("Projects/Q3.md"),
        "See [[Projects/Plan]].\n",
        "a bare `Plan` could resolve to `Archive/Plan.md`, so the path is written instead"
    );
}

#[test]
fn a_note_that_links_to_itself_is_rewritten_at_its_new_path() {
    let fixture = Fixture::new(
        "rename-self",
        &[("Roadmap.md", "# Roadmap\n\nSee [[Roadmap]] above.\n")],
    );
    let access = owner_only("alice");
    fixture
        .rename(&access, "alice")
        .note("Roadmap.md", "Plan.md")
        .expect("rename");

    assert!(!fixture.exists("Roadmap.md"));
    assert_eq!(fixture.read("Plan.md"), "# Plan\n\nSee [[Plan]] above.\n");
}

#[test]
fn nothing_is_written_when_one_note_cannot_be_rewritten_safely() {
    // The new name is fine on its own, but spliced into `Other.md` its `$` pairs with the
    // one already on that line and the link stops being a link. Every note is refused, not
    // just that one: a half-applied rename is worse than none.
    let fixture = Fixture::new(
        "rename-unverified",
        &[
            ("Roadmap.md", "# Roadmap\n"),
            ("Other.md", "Costs $5 and [[Roadmap]] here.\n"),
        ],
    );
    let access = owner_only("alice");
    assert!(matches!(
        fixture
            .rename(&access, "alice")
            .note("Roadmap.md", "Q1$Q2.md"),
        Err(RenameError::Unverified)
    ));
    assert!(fixture.exists("Roadmap.md"), "the note must not have moved");
    assert_eq!(fixture.read("Other.md"), "Costs $5 and [[Roadmap]] here.\n");
}

#[test]
fn the_crdt_sidecar_follows_the_note() {
    // A sidecar left behind is not tidiness: the next note created at the old path would
    // open against it and come back with the renamed note's content (§3.3).
    let fixture = Fixture::new("rename-sidecar", &[("Roadmap.md", "# Roadmap\n")]);
    let canonical = fixture
        .vault
        .canonical_note("Roadmap.md")
        .expect("canonical");
    let coordinator =
        mb_server::sync::NoteCoordinator::open(&fixture.vault, &canonical).expect("coordinator");
    drop(coordinator);
    let crdt = fixture.dir.path().join(".memberberry/crdt");
    let before: Vec<String> = std::fs::read_dir(&crdt)
        .expect("crdt dir")
        .filter_map(|entry| Some(entry.ok()?.file_name().to_string_lossy().into_owned()))
        .collect();
    assert!(
        !before.is_empty(),
        "the fixture must create a sidecar first"
    );

    let access = owner_only("alice");
    fixture
        .rename(&access, "alice")
        .note("Roadmap.md", "Plan.md")
        .expect("rename");

    let after: Vec<String> = std::fs::read_dir(&crdt)
        .expect("crdt dir")
        .filter_map(|entry| Some(entry.ok()?.file_name().to_string_lossy().into_owned()))
        .collect();
    assert_eq!(
        after.len(),
        before.len(),
        "nothing gained, nothing left over"
    );
    assert!(
        after.iter().all(|name| !before.contains(name)),
        "every sidecar should have moved to the new identity's name"
    );
}

#[test]
fn renaming_a_tag_moves_it_and_every_tag_nested_under_it() {
    let fixture = Fixture::new(
        "rename-tag",
        &[
            ("One.md", "A #project note.\n"),
            ("Two.md", "---\ntags: [project/memberberry]\n---\n\nBody\n"),
            ("Three.md", "Untagged, mentions #projection.\n"),
        ],
    );
    let access = owner_only("alice");
    let renamed = fixture
        .rename(&access, "alice")
        .tag("project", "work")
        .expect("the tag rename should succeed");

    assert_eq!(fixture.read("One.md"), "A #work note.\n");
    assert_eq!(
        fixture.read("Two.md"),
        "---\ntags: [work/memberberry]\n---\n\nBody\n"
    );
    assert_eq!(
        fixture.read("Three.md"),
        "Untagged, mentions #projection.\n"
    );
    assert_eq!(renamed.to, "work");
    assert_eq!(renamed.notes, 2);
}

#[test]
fn a_tag_rename_reaches_notes_the_actor_cannot_read_without_counting_them() {
    let fixture = Fixture::new(
        "rename-tag-privileged",
        &[
            ("Open.md", "A #project note.\n"),
            ("Private/Salary.md", "Also #project.\n"),
        ],
    );
    let access = Access::new(
        vec![Member {
            user: user("bob"),
            role: Role::Owner,
        }],
        vec![Rule {
            path: NotePath::parse("Private").expect("path"),
            grants: BTreeMap::from([(user("bob"), Role::None)]),
        }],
    )
    .expect("policy");
    let renamed = fixture
        .rename(&access, "bob")
        .tag("project", "work")
        .expect("rename");

    assert_eq!(fixture.read("Private/Salary.md"), "Also #work.\n");
    assert_eq!(renamed.notes, 1, "bob may read one of the two");
}

#[test]
fn only_a_vault_owner_may_rename_a_tag() {
    // A tag is a name spread across notes with different ACLs, so there is no "the tag's
    // owner" to justify the privilege the way a note's does. §6.6 requires vault-wide owner.
    let fixture = Fixture::new("rename-tag-denied", &[("One.md", "A #project note.\n")]);
    let access = split_access();
    assert!(matches!(
        fixture.rename(&access, "bob").tag("project", "work"),
        Err(RenameError::Denied)
    ));
    assert_eq!(fixture.read("One.md"), "A #project note.\n");
    // The same vault, the same call, by somebody who is an owner.
    assert!(
        fixture
            .rename(&access, "alice")
            .tag("project", "work")
            .is_ok()
    );
}

#[test]
fn a_new_tag_that_is_not_spelled_like_a_tag_is_refused() {
    let fixture = Fixture::new("rename-tag-invalid", &[("One.md", "A #project note.\n")]);
    let access = owner_only("alice");
    let rename = fixture.rename(&access, "alice");
    for tag in ["wo rk", "", "123", "a]b"] {
        assert!(
            matches!(rename.tag("project", tag), Err(RenameError::InvalidName(_))),
            "{tag:?} should not be usable as a tag"
        );
    }
    assert_eq!(fixture.read("One.md"), "A #project note.\n");
}

#[test]
fn a_tag_rename_is_audited_like_a_note_rename() {
    let fixture = Fixture::new("rename-tag-audit", &[("One.md", "A #project note.\n")]);
    let access = owner_only("alice");
    fixture
        .rename(&access, "alice")
        .tag("project", "work")
        .expect("rename");

    let lines = fixture.audit_lines();
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0]["action"], "privileged_rewrite");
    let targets: Vec<&str> = lines[0]["targets"]
        .as_array()
        .expect("targets")
        .iter()
        .filter_map(|value| value.as_str())
        .collect();
    assert_eq!(targets, vec!["work", "One.md"]);
}
