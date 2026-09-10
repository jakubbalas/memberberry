#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod support;

use std::time::Instant;

use mb_core::Username;
use mb_crdt::{
    apply_external_markdown, document_from_update_v1, document_from_yrs, encode_update_v1,
};
use mb_server::Vault;
use mb_server::sync::{
    Announcement, ConnectionId, ExternalUpdate, MARKDOWN_WRITE_DEBOUNCE, NoteCoordinator,
    ServerFrame, SyncRegistry,
};
use mb_server::vault::Slug;
use mb_server::watch::Changes;
use support::TempDir;
use yrs::updates::decoder::Decode;
use yrs::{ReadTxn, Transact, WriteTxn, XmlElementPrelim, XmlFragment};

fn vault(dir: &TempDir) -> Vault {
    Vault::open(Slug::parse("personal").unwrap(), "Personal", dir.path()).unwrap()
}

#[test]
fn remote_updates_are_durable_debounced_and_written_as_canonical_markdown() {
    let dir = TempDir::new("sync-write");
    let note = dir.write("notes/One.md", "before\n");
    let vault = vault(&dir);
    let mut coordinator =
        NoteCoordinator::open(&vault, &vault.canonical_note("One.md").unwrap()).unwrap();
    let remote = document_from_update_v1(&coordinator.full_update()).unwrap();
    let vector = remote.transact().state_vector();
    apply_external_markdown(&remote, "after\n").unwrap();
    let update = remote.transact().encode_state_as_update_v1(&vector);
    let now = Instant::now();

    coordinator.apply_remote_update(&update, now).unwrap();
    assert!(!coordinator.flush_if_due(now).unwrap());
    assert_eq!(std::fs::read_to_string(&note).unwrap(), "before\n");
    assert!(
        coordinator
            .flush_if_due(now + MARKDOWN_WRITE_DEBOUNCE)
            .unwrap()
    );
    assert_eq!(std::fs::read_to_string(&note).unwrap(), "after\n");
    assert!(
        dir.path()
            .join(".memberberry/crdt")
            .read_dir()
            .unwrap()
            .next()
            .is_some()
    );
}

#[test]
fn restoring_a_version_is_a_crdt_edit_for_open_readers() {
    let dir = TempDir::new("sync-restore");
    let note = dir.write("One.md", "current\n");
    let vault = vault(&dir);
    let canonical = vault.canonical_note("One.md").unwrap();
    let registry = SyncRegistry::default();
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let connection = ConnectionId::issue();
    let initial = registry
        .subscribe(
            &vault,
            &canonical,
            "One.md",
            &Username::parse("alice").unwrap(),
            connection,
            sender,
        )
        .unwrap();
    assert!(matches!(initial, ServerFrame::Sync { .. }));

    registry
        .restore(&vault, &canonical, "restored\n", "alice", &|_, _, _| true)
        .unwrap();

    assert_eq!(std::fs::read_to_string(note).unwrap(), "restored\n");
    assert!(matches!(
        receiver.try_recv(),
        Ok(ServerFrame::Update { .. })
    ));
}

#[test]
fn invalid_remote_structure_is_rejected_without_mutating_live_state() {
    let dir = TempDir::new("sync-invalid");
    dir.write("One.md", "safe\n");
    let vault = vault(&dir);
    let mut coordinator =
        NoteCoordinator::open(&vault, &vault.canonical_note("One.md").unwrap()).unwrap();
    let before = coordinator.full_update();
    let malformed = yrs::Doc::new();
    let mut transaction = malformed.transact_mut();
    let root = transaction.get_or_insert_xml_fragment(mb_crdt::PROSEMIRROR_ROOT);
    transaction.get_or_insert_map(mb_crdt::FRONTMATTER_ROOT);
    root.push_back(&mut transaction, XmlElementPrelim::empty("database_view"));
    drop(transaction);

    assert!(
        coordinator
            .apply_remote_update(&encode_update_v1(&malformed), Instant::now())
            .is_err()
    );
    assert_eq!(coordinator.full_update(), before);
}

#[test]
fn own_atomic_write_is_suppressed_but_external_edit_becomes_a_crdt_update() {
    let dir = TempDir::new("sync-external");
    let note = dir.write("One.md", "before\n");
    let vault = vault(&dir);
    let mut coordinator =
        NoteCoordinator::open(&vault, &vault.canonical_note("One.md").unwrap()).unwrap();
    coordinator.flush().unwrap();
    assert_eq!(
        coordinator.inspect_external_change().unwrap(),
        ExternalUpdate::SelfWrite
    );

    let subscriber = document_from_update_v1(&coordinator.full_update()).unwrap();
    std::fs::write(&note, "external\n").unwrap();
    let ExternalUpdate::Applied(update) = coordinator.inspect_external_change().unwrap() else {
        panic!("external content must apply");
    };
    subscriber
        .transact_mut()
        .apply_update(yrs::Update::decode_v1(&update).unwrap())
        .unwrap();
    assert_eq!(
        mb_core::to_markdown(&document_from_yrs(&subscriber).unwrap()),
        "external\n"
    );
}

#[test]
fn an_applied_external_edit_is_not_applied_a_second_time() {
    // The bug: `inspect_external_change` applied the file and left the last-written marker
    // holding whatever the server wrote *before* it. Every later inspection therefore read the
    // same file as a fresh external edit — and the watcher is a hint that fires often, with a
    // periodic sweep behind it (§3.4) — so an unchanged file kept being re-applied.
    let dir = TempDir::new("sync-external-twice");
    let note = dir.write("One.md", "before\n");
    let vault = vault(&dir);
    let mut coordinator =
        NoteCoordinator::open(&vault, &vault.canonical_note("One.md").unwrap()).unwrap();
    coordinator.flush().unwrap();

    std::fs::write(&note, "external\n").unwrap();
    assert!(matches!(
        coordinator.inspect_external_change().unwrap(),
        ExternalUpdate::Applied(_)
    ));

    assert_eq!(
        coordinator.inspect_external_change().unwrap(),
        ExternalUpdate::SelfWrite,
        "a file the CRDT has already accounted for is not an external edit",
    );
}

#[test]
fn a_stale_file_never_reverts_an_edit_made_after_it_was_imported() {
    // What that bug cost, which is why it is data loss rather than wasted work: after an
    // Obsidian edit was imported, the next inspection diffed the *same* file against a
    // document that had moved on — and the diff's job is to make the document match the file,
    // so it deleted whatever had been typed in between.
    let dir = TempDir::new("sync-external-revert");
    let note = dir.write("One.md", "before\n");
    let vault = vault(&dir);
    let mut coordinator =
        NoteCoordinator::open(&vault, &vault.canonical_note("One.md").unwrap()).unwrap();
    coordinator.flush().unwrap();

    std::fs::write(&note, "external\n").unwrap();
    assert!(matches!(
        coordinator.inspect_external_change().unwrap(),
        ExternalUpdate::Applied(_)
    ));

    // Somebody types, or an offline client reconnects and flushes. The file is untouched.
    let update = edit_to(&coordinator, "external and then mine\n");
    coordinator
        .apply_remote_update(&update, Instant::now())
        .unwrap();

    coordinator.inspect_external_change().unwrap();

    let live = document_from_update_v1(&coordinator.full_update()).unwrap();
    assert_eq!(
        mb_core::to_markdown(&document_from_yrs(&live).unwrap()),
        "external and then mine\n",
    );
}

/// Produces the lib0 update that moves `coordinator`'s current state to `markdown`.
fn edit_to(coordinator: &NoteCoordinator, markdown: &str) -> Vec<u8> {
    let remote = document_from_update_v1(&coordinator.full_update()).unwrap();
    let vector = remote.transact().state_vector();
    apply_external_markdown(&remote, markdown).unwrap();
    remote.transact().encode_state_as_update_v1(&vector)
}

#[test]
fn a_restart_recovers_edits_the_debounce_never_wrote() {
    // SPEC §3.3 makes the CRDT sidecar the crash-safe layer: an update is durable the
    // moment it is accepted, not when the 800ms debounce fires. An earlier revision opened
    // from the sidecar with no record of what it had last written, so the first external
    // inspection treated the stale file as an incoming edit and reverted the accepted,
    // already-broadcast updates on top of it.
    let dir = TempDir::new("sync-crash-recovery");
    let note = dir.write("One.md", "before\n");
    let vault = vault(&dir);
    let mut coordinator =
        NoteCoordinator::open(&vault, &vault.canonical_note("One.md").unwrap()).unwrap();
    coordinator
        .apply_remote_update(&edit_to(&coordinator, "flushed\n"), Instant::now())
        .unwrap();
    coordinator.flush().unwrap();
    coordinator
        .apply_remote_update(
            &edit_to(&coordinator, "accepted but unflushed\n"),
            Instant::now(),
        )
        .unwrap();
    drop(coordinator);
    assert_eq!(std::fs::read_to_string(&note).unwrap(), "flushed\n");

    let mut restarted =
        NoteCoordinator::open(&vault, &vault.canonical_note("One.md").unwrap()).unwrap();

    let recovered =
        document_from_yrs(&document_from_update_v1(&restarted.full_update()).unwrap()).unwrap();
    assert_eq!(
        mb_core::to_markdown(&recovered),
        "accepted but unflushed\n",
        "the sidecar is authoritative over Markdown this coordinator itself wrote"
    );
    assert_eq!(
        std::fs::read_to_string(&note).unwrap(),
        "accepted but unflushed\n",
        "recovery must also re-materialize the note the restart interrupted"
    );
    assert_eq!(
        restarted.inspect_external_change().unwrap(),
        ExternalUpdate::SelfWrite,
        "the recovered write is this coordinator's own and must not loop back as external"
    );
}

#[test]
fn a_restart_still_imports_a_file_edited_while_the_server_was_down() {
    // The mirror of the case above: when the file is *not* what this coordinator last
    // wrote, someone really did edit it offline and that edit must survive the restart.
    let dir = TempDir::new("sync-offline-edit");
    let note = dir.write("One.md", "before\n");
    let vault = vault(&dir);
    let mut coordinator =
        NoteCoordinator::open(&vault, &vault.canonical_note("One.md").unwrap()).unwrap();
    coordinator
        .apply_remote_update(&edit_to(&coordinator, "flushed\n"), Instant::now())
        .unwrap();
    coordinator.flush().unwrap();
    drop(coordinator);

    std::fs::write(&note, "edited in obsidian\n").unwrap();
    let mut restarted =
        NoteCoordinator::open(&vault, &vault.canonical_note("One.md").unwrap()).unwrap();

    assert_eq!(
        std::fs::read_to_string(&note).unwrap(),
        "edited in obsidian\n",
        "an offline edit must not be clobbered by recovery"
    );
    let ExternalUpdate::Applied(_) = restarted.inspect_external_change().unwrap() else {
        panic!("the offline edit must import as an external change");
    };
    let imported =
        document_from_yrs(&document_from_update_v1(&restarted.full_update()).unwrap()).unwrap();
    assert_eq!(mb_core::to_markdown(&imported), "edited in obsidian\n");
}

#[test]
fn a_reader_who_loses_access_stops_receiving_frames_without_disconnecting() {
    // AGENTS.md §3.1: authorize per frame, not per connection. E2 admitted this peer to the
    // room; that says nothing about the frame being sent now, so every broadcast re-asks.
    let dir = TempDir::new("sync-revocation");
    dir.write("One.md", "before\n");
    let vault = vault(&dir);
    let canonical = vault.canonical_note("One.md").unwrap();
    let registry = SyncRegistry::default();
    let alice = mb_core::Username::parse("alice").unwrap();
    let bob = mb_core::Username::parse("bob").unwrap();
    let (to_alice, mut alice_inbox) = tokio::sync::mpsc::unbounded_channel();
    let (to_bob, mut bob_inbox) = tokio::sync::mpsc::unbounded_channel();
    let ServerFrame::Sync { update: state, .. } = registry
        .subscribe(
            &vault,
            &canonical,
            "One.md",
            &alice,
            ConnectionId::issue(),
            to_alice,
        )
        .unwrap()
    else {
        panic!("subscribing returns the document state");
    };
    registry
        .subscribe(
            &vault,
            &canonical,
            "One.md",
            &bob,
            ConnectionId::issue(),
            to_bob,
        )
        .unwrap();

    let baseline = document_from_update_v1(&state).unwrap();
    let vector = baseline.transact().state_vector();
    apply_external_markdown(&baseline, "after\n").unwrap();
    let update = baseline.transact().encode_state_as_update_v1(&vector);

    // Bob's role has gone to `none` since he subscribed.
    registry
        .apply_update(&vault, &canonical, &update, &|_, _, user| user != &bob)
        .unwrap();

    assert!(
        matches!(alice_inbox.try_recv(), Ok(ServerFrame::Update { .. })),
        "a permitted reader still receives the edit"
    );
    assert!(
        bob_inbox.try_recv().is_err(),
        "a reader who lost access must receive nothing, connected or not"
    );
    assert!(
        bob_inbox.is_closed(),
        "and must be dropped from the room rather than skipped once"
    );
}

/// Builds a registry with one subscribed peer over a fresh single-note vault.
fn room(
    dir: &TempDir,
) -> (
    Vault,
    SyncRegistry,
    Username,
    tokio::sync::mpsc::UnboundedReceiver<ServerFrame>,
) {
    let vault = vault(dir);
    let canonical = vault.canonical_note("One.md").unwrap();
    let registry = SyncRegistry::default();
    let user = Username::parse("alice").unwrap();
    let (outbound, inbox) = tokio::sync::mpsc::unbounded_channel();
    registry
        .subscribe(
            &vault,
            &canonical,
            "One.md",
            &user,
            ConnectionId::issue(),
            outbound,
        )
        .unwrap();
    (vault, registry, user, inbox)
}

/// An authorizer that permits everyone, for tests whose subject is not permissions.
fn permit_all(_: &str, _: &str, _: &Username) -> bool {
    true
}

#[test]
fn maintenance_writes_a_due_note_once_and_does_not_replay_its_own_write() {
    let dir = TempDir::new("sync-maintain-write");
    let note = dir.write("One.md", "before\n");
    let (vault, registry, _user, mut inbox) = room(&dir);
    let canonical = vault.canonical_note("One.md").unwrap();
    let coordinator = NoteCoordinator::open(&vault, &canonical).unwrap();
    let update = edit_to(&coordinator, "after\n");
    drop(coordinator);
    registry
        .apply_update(&vault, &canonical, &update, &permit_all)
        .unwrap();
    assert!(matches!(inbox.try_recv(), Ok(ServerFrame::Update { .. })));

    let start = Instant::now();
    assert!(
        registry
            .maintain(start, &Changes::All, &permit_all)
            .is_empty()
    );
    assert_eq!(
        std::fs::read_to_string(&note).unwrap(),
        "before\n",
        "the debounce has not elapsed"
    );

    assert!(
        registry
            .maintain(start + MARKDOWN_WRITE_DEBOUNCE, &Changes::All, &permit_all)
            .is_empty()
    );
    assert_eq!(std::fs::read_to_string(&note).unwrap(), "after\n");
    assert!(
        inbox.try_recv().is_err(),
        "a coordinator's own atomic write must not come back as an external change"
    );
}

#[test]
fn maintenance_broadcasts_a_file_edited_underneath_an_open_room() {
    let dir = TempDir::new("sync-maintain-external");
    let note = dir.write("One.md", "before\n");
    let (vault, registry, _user, mut inbox) = room(&dir);

    std::fs::write(&note, "edited in obsidian\n").unwrap();
    assert!(
        registry
            .maintain(Instant::now(), &Changes::All, &permit_all)
            .is_empty()
    );

    let Ok(ServerFrame::Update { update, note, .. }) = inbox.try_recv() else {
        panic!("an external edit reaches every subscriber as a normal CRDT update");
    };
    assert_eq!(note, "One.md");
    let subscriber = document_from_update_v1(
        &NoteCoordinator::open(&vault, &vault.canonical_note("One.md").unwrap())
            .unwrap()
            .full_update(),
    )
    .unwrap();
    subscriber
        .transact_mut()
        .apply_update(yrs::Update::decode_v1(&update).unwrap())
        .unwrap();
    assert_eq!(
        mb_core::to_markdown(&document_from_yrs(&subscriber).unwrap()),
        "edited in obsidian\n"
    );
}

#[test]
fn maintenance_does_not_broadcast_a_file_nobody_touched() {
    let dir = TempDir::new("sync-maintain-quiet");
    dir.write("One.md", "before\n");
    let (_vault, registry, _user, mut inbox) = room(&dir);

    for _ in 0..3 {
        assert!(
            registry
                .maintain(Instant::now(), &Changes::All, &permit_all)
                .is_empty()
        );
    }

    assert!(
        inbox.try_recv().is_err(),
        "an unchanged file must produce no frames at all"
    );
}

#[test]
fn shutdown_materializes_every_note_whose_debounce_had_not_fired() {
    let dir = TempDir::new("sync-shutdown-flush");
    let note = dir.write("One.md", "before\n");
    let (vault, registry, _user, _inbox) = room(&dir);
    let canonical = vault.canonical_note("One.md").unwrap();
    let coordinator = NoteCoordinator::open(&vault, &canonical).unwrap();
    let update = edit_to(&coordinator, "after\n");
    drop(coordinator);
    registry
        .apply_update(&vault, &canonical, &update, &permit_all)
        .unwrap();
    assert_eq!(std::fs::read_to_string(&note).unwrap(), "before\n");

    assert!(registry.flush_all().is_empty());

    assert_eq!(
        std::fs::read_to_string(&note).unwrap(),
        "after\n",
        "an orderly stop leaves Layer 1 current for git, backups and Obsidian"
    );

    let untouched = std::fs::metadata(&note).unwrap().modified().unwrap();
    assert!(registry.flush_all().is_empty());
    assert_eq!(
        std::fs::metadata(&note).unwrap().modified().unwrap(),
        untouched,
        "a note with nothing outstanding is not rewritten, so external watchers stay quiet"
    );
}

#[test]
fn an_update_for_a_document_nobody_subscribed_is_refused() {
    let dir = TempDir::new("sync-unsubscribed");
    dir.write("One.md", "before\n");
    let vault = vault(&dir);
    let canonical = vault.canonical_note("One.md").unwrap();
    let registry = SyncRegistry::default();

    assert!(
        registry
            .apply_update(&vault, &canonical, &[0], &permit_all)
            .is_err(),
        "the registry never opens a writer off an update frame alone"
    );
}

#[test]
fn leaving_a_document_retracts_the_departing_cursor_at_once() {
    // §7.5: a disconnected client's presence is removed on socket close, not left for
    // `y-protocols` to time out 30 seconds later.
    let dir = TempDir::new("sync-departure");
    dir.write("One.md", "before\n");
    let vault = vault(&dir);
    let canonical = vault.canonical_note("One.md").unwrap();
    let registry = SyncRegistry::default();
    let stays = Username::parse("stays").unwrap();
    let leaves = Username::parse("leaves").unwrap();
    let (to_stays, mut stays_inbox) = tokio::sync::mpsc::unbounded_channel();
    let (to_leaves, _leaves_inbox) = tokio::sync::mpsc::unbounded_channel();
    let staying = ConnectionId::issue();
    let leaving = ConnectionId::issue();
    registry
        .subscribe(&vault, &canonical, "One.md", &stays, staying, to_stays)
        .unwrap();
    registry
        .subscribe(&vault, &canonical, "One.md", &leaves, leaving, to_leaves)
        .unwrap();
    registry.broadcast_awareness(
        &vault,
        &canonical,
        Announcement {
            user: leaves.as_str(),
            connection: leaving,
            clients: &[41, 42],
            state: serde_json::json!({ "cursor": 1 }),
        },
        &permit_all,
    );
    assert!(matches!(
        stays_inbox.try_recv(),
        Ok(ServerFrame::Awareness { .. })
    ));

    assert!(registry.disconnect(leaving).is_empty());

    let Ok(ServerFrame::Departed { clients, note, .. }) = stays_inbox.try_recv() else {
        panic!("the remaining reader must be told whose cursor to remove");
    };
    assert_eq!(clients, vec![41, 42]);
    assert_eq!(note, "One.md");
}

#[test]
fn the_last_reader_leaving_releases_the_room_and_writes_the_note() {
    let dir = TempDir::new("sync-release");
    let note = dir.write("One.md", "before\n");
    let vault = vault(&dir);
    let canonical = vault.canonical_note("One.md").unwrap();
    let registry = SyncRegistry::default();
    let user = Username::parse("alice").unwrap();
    let connection = ConnectionId::issue();
    let (outbound, _inbox) = tokio::sync::mpsc::unbounded_channel();
    registry
        .subscribe(&vault, &canonical, "One.md", &user, connection, outbound)
        .unwrap();
    let coordinator = NoteCoordinator::open(&vault, &canonical).unwrap();
    let update = edit_to(&coordinator, "after\n");
    drop(coordinator);
    registry
        .apply_update(&vault, &canonical, &update, &permit_all)
        .unwrap();

    registry
        .unsubscribe(&vault, &canonical, connection)
        .unwrap();

    assert_eq!(
        std::fs::read_to_string(&note).unwrap(),
        "after\n",
        "releasing a room materializes whatever the debounce still owed"
    );
    assert!(
        registry
            .apply_update(&vault, &canonical, &update, &permit_all)
            .is_err(),
        "a room nobody has open costs nothing: no coordinator, no polling, no memory"
    );
}

#[test]
fn subscribing_twice_on_one_connection_does_not_double_deliver() {
    let dir = TempDir::new("sync-resubscribe");
    dir.write("One.md", "before\n");
    let vault = vault(&dir);
    let canonical = vault.canonical_note("One.md").unwrap();
    let registry = SyncRegistry::default();
    let user = Username::parse("alice").unwrap();
    let connection = ConnectionId::issue();
    let (outbound, mut inbox) = tokio::sync::mpsc::unbounded_channel();
    for _ in 0..2 {
        registry
            .subscribe(
                &vault,
                &canonical,
                "One.md",
                &user,
                connection,
                outbound.clone(),
            )
            .unwrap();
    }
    let coordinator = NoteCoordinator::open(&vault, &canonical).unwrap();
    let update = edit_to(&coordinator, "after\n");
    drop(coordinator);

    registry
        .apply_update(&vault, &canonical, &update, &permit_all)
        .unwrap();

    assert!(matches!(inbox.try_recv(), Ok(ServerFrame::Update { .. })));
    assert!(
        inbox.try_recv().is_err(),
        "a reconnecting client that re-subscribes must not receive every frame twice"
    );
}

#[test]
fn deleting_the_derived_state_directory_loses_nothing() {
    // Invariant I1 (SPEC 22.4): `.memberberry/` is derived. Deleting it must leave a vault
    // that rebuilds from Markdown alone. M5 added a `.last-write` marker in there, so the
    // invariant is worth re-asserting against the sync path specifically.
    let dir = TempDir::new("sync-invariant-i1");
    let note = dir.write("One.md", "before\n");
    let vault = vault(&dir);
    let canonical = vault.canonical_note("One.md").unwrap();
    let mut coordinator = NoteCoordinator::open(&vault, &canonical).unwrap();
    coordinator
        .apply_remote_update(&edit_to(&coordinator, "after\n"), Instant::now())
        .unwrap();
    coordinator.flush().unwrap();
    drop(coordinator);
    assert!(dir.path().join(".memberberry/crdt").is_dir());

    std::fs::remove_dir_all(dir.path().join(".memberberry")).unwrap();

    let mut rebuilt = NoteCoordinator::open(&vault, &canonical).unwrap();
    let document =
        document_from_yrs(&document_from_update_v1(&rebuilt.full_update()).unwrap()).unwrap();
    assert_eq!(
        mb_core::to_markdown(&document),
        "after\n",
        "the note is the source of truth; derived state only accelerates it"
    );
    // Either "this is our own write" or "nothing changed" is correct; what must never
    // happen is a phantom edit broadcast to every reader of a note nobody touched.
    assert!(
        !matches!(
            rebuilt.inspect_external_change().unwrap(),
            ExternalUpdate::Applied(_)
        ),
        "a rebuilt coordinator must not mistake the file it was built from for an edit"
    );
    assert_eq!(std::fs::read_to_string(&note).unwrap(), "after\n");
}
