//! Creating a note, over a real vault (`SPEC.md` §6.10, E17).
//!
//! The reason this operation needs its own suite is that it is the first write path that can
//! bring a *path* into being. Everything before it wrote to a file the ACL had already been
//! consulted about; this one is asked about a name that does not exist yet, which is exactly
//! the shape that leaks — "you cannot create that" and "that is already there" are different
//! answers about a note the caller may not be allowed to know exists.

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
use mb_server::create::{CreateError, CreateNote};
use mb_server::vault::Slug;
use support::TempDir;

struct Fixture {
    dir: TempDir,
    vault: Vault,
    index: Arc<Mutex<Index>>,
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
            mb_server::indexing::reconcile(&vault, &mut open).expect("building the index");
        }
        Self { dir, vault, index }
    }

    fn create<'a>(&'a self, access: &'a Access, actor: &str) -> CreateNote<'a> {
        CreateNote::new(
            &self.vault,
            access,
            Username::parse(actor).expect("username"),
            &self.index,
        )
    }

    fn read(&self, path: &str) -> String {
        std::fs::read_to_string(self.dir.path().join(path))
            .unwrap_or_else(|_| panic!("{path} should exist"))
    }

    fn exists(&self, path: &str) -> bool {
        self.dir.path().join(path).exists()
    }

    /// Whether the index has caught up with a note this user may read.
    fn indexed(&self, access: &Access, actor: &str, note: &str) -> bool {
        let user = Username::parse(actor).expect("username");
        let mut index = self.index.lock().expect("index lock");
        let reader = index.reader(access, &user).expect("reader");
        reader.contains(note).expect("contains")
    }
}

fn owner_of(user: &str) -> Access {
    Access::new(
        vec![Member {
            user: Username::parse(user).expect("username"),
            role: Role::Owner,
        }],
        Vec::new(),
    )
    .expect("access")
}

#[test]
fn an_owner_creates_a_note_in_an_empty_vault() {
    let fixture = Fixture::new("create-empty", &[]);
    let access = owner_of("alice");

    let created = fixture
        .create(&access, "alice")
        .note("Welcome.md")
        .expect("the note should be created");

    assert_eq!(created.path, "Welcome.md");
    // C2: the note is plain Markdown on disk, readable in a text editor with no server.
    assert_eq!(fixture.read("Welcome.md"), "# Welcome\n");
}

#[test]
fn a_created_note_is_immediately_visible_in_the_index() {
    let fixture = Fixture::new("create-indexed", &[]);
    let access = owner_of("alice");

    fixture
        .create(&access, "alice")
        .note("Welcome.md")
        .expect("created");

    // Without the sweep this is false, and the note exists on disk but not in the tree.
    assert!(fixture.indexed(&access, "alice", "Welcome.md"));
}

#[test]
fn creating_a_note_in_a_new_folder_makes_the_folder() {
    let fixture = Fixture::new("create-nested", &[]);
    let access = owner_of("alice");

    let created = fixture
        .create(&access, "alice")
        .note("Projects/Deep/Plan.md")
        .expect("created");

    assert_eq!(created.path, "Projects/Deep/Plan.md");
    assert_eq!(fixture.read("Projects/Deep/Plan.md"), "# Plan\n");
}

#[test]
fn a_viewer_cannot_create_a_note() {
    let fixture = Fixture::new("create-viewer", &[]);
    let access = Access::new(
        vec![Member {
            user: Username::parse("bob").expect("username"),
            role: Role::Viewer,
        }],
        Vec::new(),
    )
    .expect("access");

    let refused = fixture.create(&access, "bob").note("Sneaky.md");

    assert!(matches!(refused, Err(CreateError::Denied)), "{refused:?}");
    assert!(!fixture.exists("Sneaky.md"), "nothing may be written");
}

#[test]
fn a_non_member_cannot_create_a_note() {
    let fixture = Fixture::new("create-stranger", &[]);
    let access = owner_of("alice");

    let refused = fixture.create(&access, "mallory").note("Sneaky.md");

    assert!(matches!(refused, Err(CreateError::Denied)), "{refused:?}");
    assert!(!fixture.exists("Sneaky.md"));
}

#[test]
fn a_folder_grant_scopes_where_a_note_may_be_created() {
    let fixture = Fixture::new("create-scoped", &[]);
    // Vault-wide viewer, editor on one folder — §6.2's per-folder grant.
    let access = Access::new(
        vec![Member {
            user: Username::parse("bob").expect("username"),
            role: Role::Viewer,
        }],
        vec![Rule {
            path: NotePath::parse("Shared").expect("path"),
            grants: BTreeMap::from([(Username::parse("bob").expect("username"), Role::Editor)]),
        }],
    )
    .expect("access");

    let inside = fixture.create(&access, "bob").note("Shared/Notes.md");
    let outside = fixture.create(&access, "bob").note("Private/Notes.md");

    assert!(inside.is_ok(), "{inside:?}");
    assert!(matches!(outside, Err(CreateError::Denied)), "{outside:?}");
    assert!(fixture.exists("Shared/Notes.md"));
    assert!(!fixture.exists("Private/Notes.md"));
}

#[test]
fn creating_over_an_existing_note_refuses_and_leaves_it_alone() {
    let fixture = Fixture::new("create-clash", &[("Welcome.md", "# Mine\n\nOriginal.\n")]);
    let access = owner_of("alice");

    let refused = fixture.create(&access, "alice").note("Welcome.md");

    assert!(
        matches!(refused, Err(CreateError::Exists(_))),
        "{refused:?}"
    );
    assert_eq!(fixture.read("Welcome.md"), "# Mine\n\nOriginal.\n");
}

/// The ordering rule from §6.5: authorization is answered before the filesystem is.
///
/// why: `Exists` is an answer about a path. If it came first, anyone who could reach the
/// route could map a vault's notes by trying to create over them — including notes in
/// folders they have no access to at all. So a caller who may not write there gets `Denied`
/// whether or not a note is sitting at that path, and the two cases are indistinguishable.
#[test]
fn a_denied_caller_cannot_tell_an_occupied_path_from_an_empty_one() {
    let fixture = Fixture::new(
        "create-probe",
        &[("Secret/Plans.md", "# Plans\n\nNot for bob.\n")],
    );
    let access = Access::new(
        vec![Member {
            user: Username::parse("bob").expect("username"),
            role: Role::Viewer,
        }],
        Vec::new(),
    )
    .expect("access");

    let occupied = fixture.create(&access, "bob").note("Secret/Plans.md");
    let empty = fixture.create(&access, "bob").note("Secret/Nothing.md");

    assert!(matches!(occupied, Err(CreateError::Denied)), "{occupied:?}");
    assert!(matches!(empty, Err(CreateError::Denied)), "{empty:?}");
    assert_eq!(
        occupied.unwrap_err().to_string(),
        empty.unwrap_err().to_string(),
        "the two refusals must be one refusal"
    );
}

#[test]
fn a_path_that_climbs_out_of_the_vault_is_refused() {
    let fixture = Fixture::new("create-traversal", &[]);
    let access = owner_of("alice");

    for attempt in [
        "../Escaped.md",
        "Projects/../../Escaped.md",
        "/tmp/Escaped.md",
        "./Hidden.md",
        ".hidden/Note.md",
    ] {
        let refused = fixture.create(&access, "alice").note(attempt);
        assert!(
            matches!(refused, Err(CreateError::InvalidName(_))),
            "{attempt} should be refused, got {refused:?}"
        );
    }
    assert!(!fixture.dir.path().join("../Escaped.md").exists());
}

/// A symlinked folder inside the vault must not become a way to write outside it.
///
/// why: this is the case a parent-only containment check cannot see. `Away` resolves outside
/// the vault, so `Away/Deep` does not canonicalize at all, and a check that gave up there
/// would fall through to `create_dir_all` — which follows the symlink and writes to the real
/// directory. The check has to walk up to the deepest ancestor that *does* resolve.
#[cfg(unix)]
#[test]
fn a_symlinked_folder_cannot_be_used_to_write_outside_the_vault() {
    let fixture = Fixture::new("create-symlink", &[]);
    let outside = TempDir::new("create-symlink-outside");
    std::os::unix::fs::symlink(outside.path(), fixture.dir.path().join("Away"))
        .expect("the symlink out of the vault");
    let access = owner_of("alice");

    let refused = fixture
        .create(&access, "alice")
        .note("Away/Deep/Escaped.md");

    assert!(
        matches!(refused, Err(CreateError::InvalidName(_))),
        "{refused:?}"
    );
    assert!(
        !outside.path().join("Deep/Escaped.md").exists(),
        "nothing may be written outside the vault"
    );
}

#[test]
fn a_name_that_is_not_a_note_is_refused() {
    let fixture = Fixture::new("create-shape", &[]);
    let access = owner_of("alice");

    for attempt in ["", "Welcome", "Welcome.txt", "Projects/", "  "] {
        let refused = fixture.create(&access, "alice").note(attempt);
        assert!(
            matches!(refused, Err(CreateError::InvalidName(_))),
            "{attempt:?} should be refused, got {refused:?}"
        );
    }
}

/// The heading is the note's own name, whatever folder it is in.
#[test]
fn a_new_note_is_titled_by_its_filename_not_its_path() {
    let fixture = Fixture::new("create-title", &[]);
    let access = owner_of("alice");

    fixture
        .create(&access, "alice")
        .note("Projects/Q3 Planning.md")
        .expect("created");

    assert_eq!(fixture.read("Projects/Q3 Planning.md"), "# Q3 Planning\n");
    // And the title the rest of the system reads comes from that Markdown, not from us.
    let parsed = mb_core::parse(&fixture.read("Projects/Q3 Planning.md"));
    assert_eq!(
        mb_core::extract::title(&parsed).as_deref(),
        Some("Q3 Planning")
    );
}

/// Two creations of one name: exactly one wins, and the loser does not truncate the winner.
#[test]
fn creating_the_same_name_twice_leaves_the_first_note_intact() {
    let fixture = Fixture::new("create-race", &[]);
    let access = owner_of("alice");

    let first = fixture.create(&access, "alice").note("Once.md");
    // Simulating the interleaving rather than racing threads: the property is that the second
    // call cannot overwrite, which is what `create_new` buys and what a seeded race could
    // only demonstrate flakily.
    std::fs::write(
        fixture.dir.path().join("Once.md"),
        "# Once\n\nEdited already.\n",
    )
    .expect("an edit between the two calls");
    let second = fixture.create(&access, "alice").note("Once.md");

    assert!(first.is_ok(), "{first:?}");
    assert!(matches!(second, Err(CreateError::Exists(_))), "{second:?}");
    assert_eq!(fixture.read("Once.md"), "# Once\n\nEdited already.\n");
}

/// `NotePath` is the type the ACL is asked about, so a name it rejects must never reach it.
#[test]
fn every_accepted_name_parses_as_a_note_path() {
    let fixture = Fixture::new("create-notepath", &[]);
    let access = owner_of("alice");

    for name in ["A.md", "Folder/B.md", "Deep/Nested/C.md", "Ünïcode ✨.md"] {
        let created = fixture.create(&access, "alice").note(name);
        assert!(created.is_ok(), "{name} should be creatable: {created:?}");
        assert!(
            NotePath::parse(name).is_ok(),
            "{name} was accepted but is not a NotePath"
        );
    }
}
