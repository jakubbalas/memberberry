//! Permission leak suite for enforcement points implemented through M5 (`SPEC.md` §22.5).
//!
//! This suite is deliberately organised by enforcement point rather than feature. Adding a
//! content-bearing surface means extending this file before that surface can ship.
//!
//! The wire-level counterparts for E2-E4 live in `tests/websocket.rs`, which drives real
//! sockets; the cases here pin the properties those frames must never violate.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod support;

use mb_core::{Access, Member, Role, Username};
use mb_server::Vault;
use mb_server::repository::AuthorizedVault;
use mb_server::sync::ConnectionId;
use mb_server::vault::Slug;
use support::TempDir;

/// E5: every repository query is pre-filtered and an unreadable note is indistinguishable
/// from a missing note, including metadata lookup and source reads.
#[test]
fn e5_repository_never_reveals_an_unreadable_note() {
    let dir = TempDir::new("leak-repository");
    dir.write("Shared.md", "# Shared\n");
    dir.write("Private/Salary.md", "# Salary Review\n");
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let alice = Username::parse("alice").expect("username");
    let access = Access::new(
        vec![Member {
            user: alice.clone(),
            role: Role::Viewer,
        }],
        vec![mb_core::Rule {
            path: mb_core::NotePath::parse("Private").expect("path"),
            grants: std::collections::BTreeMap::from([(alice.clone(), Role::None)]),
        }],
    )
    .expect("policy");
    let view = AuthorizedVault::new(&vault, &access, alice);

    assert_eq!(view.notes().expect("notes"), vec!["Shared.md"]);
    assert_eq!(view.find_by_name("Salary"), None);
    assert!(matches!(
        view.resolve("Private/Salary.md"),
        Err(mb_server::Error::NotFound)
    ));
    assert!(matches!(
        view.read("Private/Salary.md"),
        Err(mb_server::Error::NotFound)
    ));
}

/// E1: an admin without an ACL membership has no implicit content access.
#[test]
fn e1_server_admin_is_not_a_vault_reader() {
    let dir = TempDir::new("leak-admin");
    dir.write("Private.md", "# Private\n");
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let access = Access::new(Vec::new(), Vec::new()).expect("empty policy");
    let admin = Username::parse("server-admin").expect("username");
    let view = AuthorizedVault::new(&vault, &access, admin);

    assert!(view.notes().expect("notes").is_empty());
    assert_eq!(view.find_by_name("Private"), None);
    assert!(matches!(
        view.read("Private.md"),
        Err(mb_server::Error::NotFound)
    ));
}

/// E2/E3/E4: the sync boundary denies every failure the same way.
///
/// The invisibility rule (§6.5) applies to *how* a frame is refused, not only to what it
/// carries. An unknown vault, an unresolvable path and a note the caller merely cannot read
/// must be one indistinguishable answer — and so must a caller who is sent nothing at all,
/// which is why the wire test asserts a frame arrives for each of the six probes rather
/// than only that no content does.
#[test]
fn e2_e3_e4_sync_denials_are_indistinguishable() {
    let dir = TempDir::new("leak-sync-denial");
    dir.write("Private.md", "# Private\n");
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let access = Access::new(Vec::new(), Vec::new()).expect("empty policy");
    let outsider = Username::parse("outsider").expect("username");

    // The two probes differ in exactly the way an attacker cares about — one resolves to a
    // real file, one does not — and must still produce one answer. Resolution succeeding is
    // what an earlier revision leaked: it took the caller down a branch that replied, while
    // the unresolvable path fell through to silence.
    assert!(vault.canonical_note("Private.md").is_ok());
    assert!(vault.canonical_note("Absent.md").is_err());
    for note in ["Private.md", "Absent.md"] {
        let path = mb_core::NotePath::parse(note).expect("path");
        assert_eq!(
            access.effective_role(&outsider, &path),
            Role::None,
            "{note} must be denied identically whether or not it exists"
        );
    }
}

/// E4: presence is data. A room only ever holds readers, and re-checks on every frame.
#[test]
fn e4_awareness_reaches_only_current_readers() {
    let dir = TempDir::new("leak-awareness");
    dir.write("One.md", "# One\n");
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let canonical = vault.canonical_note("One.md").expect("canonical");
    let registry = mb_server::sync::SyncRegistry::default();
    let reader = Username::parse("reader").expect("username");
    let revoked = Username::parse("revoked").expect("username");
    let (to_reader, mut reader_inbox) = tokio::sync::mpsc::unbounded_channel();
    let (to_revoked, mut revoked_inbox) = tokio::sync::mpsc::unbounded_channel();
    registry
        .subscribe(
            &vault,
            &canonical,
            "One.md",
            &reader,
            ConnectionId::issue(),
            to_reader,
        )
        .expect("subscribe");
    registry
        .subscribe(
            &vault,
            &canonical,
            "One.md",
            &revoked,
            ConnectionId::issue(),
            to_revoked,
        )
        .expect("subscribe");
    // `subscribe` returns the initial state to its caller; the channel carries only
    // subsequent broadcasts.

    registry.broadcast_awareness(
        &vault,
        &canonical,
        mb_server::sync::Announcement {
            user: reader.as_str(),
            connection: ConnectionId::issue(),
            clients: &[7],
            state: serde_json::json!({ "cursor": 4 }),
        },
        &|_, _, user| user != &revoked,
    );

    assert!(
        reader_inbox.try_recv().is_ok(),
        "a current reader sees presence"
    );
    assert!(
        revoked_inbox.try_recv().is_err(),
        "presence reveals who is reading which note and follows the same filter as content"
    );
}

/// E15: a workspace layout is one user's private list of open notes.
///
/// `SPEC.md` §8.1 originally keyed the file by device alone, which made it readable by every
/// other member of the vault — the same class of disclosure §6.4 E4 already
/// permission-filters awareness for, because both reveal which note a person is reading. The
/// path now carries the user, and this is the test that it is the *authenticated* user rather
/// than anything a caller can choose.
#[test]
fn e15_a_workspace_layout_is_not_readable_by_another_member() {
    use mb_server::workspace::{DeviceId, WorkspaceStore};

    let dir = TempDir::new("leak-workspace");
    dir.write("Shared.md", "# Shared\n");
    let store = WorkspaceStore::new(dir.path());

    let alice = Username::parse("alice").expect("username");
    let bob = Username::parse("bob").expect("username");
    // The same device id on purpose: two people at one shared machine is the case that
    // collides if the path does not carry the user.
    let laptop = DeviceId::parse("shared-laptop").expect("device");

    let alices = r#"{"format":1,"vault":"personal","focusedGroup":"g","root":{"kind":"group","id":"g","tabs":[{"id":"t","note":"Private/Salary.md","mode":"edit","scroll":0,"history":["Private/Salary.md"],"historyIndex":0}],"activeTab":"t"}}"#;
    store.save(&alice, &laptop, alices).expect("alice saves");

    assert_eq!(
        store.load(&bob, &laptop).expect("bob loads"),
        None,
        "one member must not read another's layout, even from the same device"
    );
    assert_eq!(
        store.load(&alice, &laptop).expect("alice loads"),
        Some(alices.to_string()),
        "and her own must still come back unchanged"
    );

    // Bob writing his own does not disturb hers.
    let bobs = r#"{"format":1,"vault":"personal","focusedGroup":"g","root":{"kind":"group","id":"g","tabs":[],"activeTab":null}}"#;
    store.save(&bob, &laptop, bobs).expect("bob saves");
    assert_eq!(
        store.load(&alice, &laptop).expect("alice loads"),
        Some(alices.to_string())
    );
}

/// E15: a device id becomes a filename, so it cannot be allowed to name a path.
#[test]
fn e15_a_device_id_cannot_escape_the_workspace_directory() {
    use mb_server::workspace::DeviceId;

    for hostile in [
        "../../../etc/passwd",
        "..",
        ".",
        "a/b",
        "a\\b",
        "",
        "with space",
        "sémi-colon",
        "nul\0byte",
        &"x".repeat(65),
    ] {
        assert!(
            matches!(DeviceId::parse(hostile), Err(mb_server::Error::NotFound)),
            "`{hostile}` must not parse as a device id"
        );
    }
    // And the shapes a real client generates do.
    for usable in ["laptop", "Pixel-7a", "device_1", "0", &"x".repeat(64)] {
        assert!(DeviceId::parse(usable).is_ok(), "`{usable}` should parse");
    }
}
