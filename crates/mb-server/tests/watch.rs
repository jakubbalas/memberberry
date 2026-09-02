//! Filesystem watcher behaviour (`SPEC.md` §3.4).
//!
//! These tests drive a real watcher against a real directory, because the thing worth
//! testing is whether the platform actually delivers — a mocked watcher would only prove
//! the mock works. They wait on a condition rather than sleeping a fixed amount, so a slow
//! machine makes them slower, never flaky.

#![allow(clippy::expect_used, clippy::panic, clippy::unwrap_used)]

mod support;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use mb_core::Username;
use mb_server::Vault;
use mb_server::sync::{ConnectionId, NoteCoordinator, ServerFrame, SyncRegistry};
use mb_server::vault::Slug;
use mb_server::watch::{Changes, WatchSignal, watch};
use support::TempDir;

/// Polls `signal` until it reports something, or gives up.
///
/// A watcher is inherently asynchronous — the kernel decides when the event lands — so a
/// deadline is the only honest way to wait. `Changes` accumulates, so this also merges the
/// several events one write can produce.
fn changes_within(signal: &WatchSignal, budget: Duration) -> Changes {
    let deadline = Instant::now() + budget;
    let mut seen = std::collections::BTreeSet::new();
    while Instant::now() < deadline {
        match signal.take() {
            Changes::All => return Changes::All,
            Changes::Only(paths) if !paths.is_empty() => {
                seen.extend(paths);
                // One save often arrives as create + modify + chmod, so drain the tail.
                std::thread::sleep(POLL_STEP);
                if let Changes::Only(more) = signal.take() {
                    seen.extend(more);
                }
                return Changes::Only(seen);
            }
            // Sleeping rather than spinning: these tests run in parallel, and a busy loop
            // starves the very watcher threads they are waiting on.
            Changes::Only(_) => std::thread::sleep(POLL_STEP),
        }
    }
    Changes::Only(seen)
}

/// Granularity of the waits above. Small enough not to dominate, large enough to yield.
const POLL_STEP: Duration = Duration::from_millis(10);

/// Produces the lib0 update that moves `coordinator`'s state to `markdown`.
fn edit_to(coordinator: &NoteCoordinator, markdown: &str) -> Vec<u8> {
    let document = mb_crdt::document_from_update_v1(&coordinator.full_update()).unwrap();
    let vector = {
        let read = yrs::Transact::transact(&document);
        yrs::ReadTxn::state_vector(&read)
    };
    mb_crdt::apply_external_markdown(&document, markdown).unwrap();
    let read = yrs::Transact::transact(&document);
    yrs::ReadTxn::encode_state_as_update_v1(&read, &vector)
}

#[test]
fn an_external_write_is_reported_as_the_path_that_changed() {
    let dir = TempDir::new("watch-external");
    let note = dir.write("One.md", "before\n");
    let signal = Arc::new(WatchSignal::default());
    let (watcher, problems) = watch(&[dir.path().to_path_buf()], Arc::clone(&signal));
    assert!(problems.is_empty(), "{problems:?}");
    drop(changes_within(&signal, Duration::from_millis(200)));

    std::fs::write(&note, "edited in obsidian\n").unwrap();

    let changes = changes_within(&signal, Duration::from_secs(10));
    assert!(
        changes.includes(&note.canonicalize().unwrap()),
        "the edited note must be named by the watcher: {changes:?}"
    );
    drop(watcher);
}

#[test]
fn an_idle_vault_reports_nothing_to_re_read() {
    // The point of the watcher: a server with open notes and a quiet disk does no file I/O.
    let dir = TempDir::new("watch-idle");
    dir.write("One.md", "before\n");
    let signal = Arc::new(WatchSignal::default());
    let (watcher, problems) = watch(&[dir.path().to_path_buf()], Arc::clone(&signal));
    assert!(problems.is_empty(), "{problems:?}");
    drop(changes_within(&signal, Duration::from_millis(300)));

    let idle = signal.take();

    assert!(
        idle.is_empty(),
        "an untouched vault must not schedule any re-reads: {idle:?}"
    );
    drop(watcher);
}

#[test]
fn a_watched_edit_reaches_subscribers_through_one_maintenance_tick() {
    // End to end: watcher names the file, `maintain` inspects only that file, and the room
    // broadcasts the imported change.
    let dir = TempDir::new("watch-to-room");
    let note = dir.write("One.md", "before\n");
    let vault = Vault::open(Slug::parse("personal").unwrap(), "Personal", dir.path()).unwrap();
    let canonical = vault.canonical_note("One.md").unwrap();
    let registry = SyncRegistry::default();
    let user = Username::parse("alice").unwrap();
    let (outbound, mut inbox) = tokio::sync::mpsc::unbounded_channel();
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
    let signal = Arc::new(WatchSignal::default());
    let (watcher, problems) = watch(&[dir.path().to_path_buf()], Arc::clone(&signal));
    assert!(problems.is_empty(), "{problems:?}");
    drop(changes_within(&signal, Duration::from_millis(200)));

    std::fs::write(&note, "edited in obsidian\n").unwrap();
    let changes = changes_within(&signal, Duration::from_secs(10));
    assert!(
        registry
            .maintain(Instant::now(), &changes, &|_, _, _| true)
            .is_empty()
    );

    let Ok(ServerFrame::Update { .. }) = inbox.try_recv() else {
        panic!("the watched edit must reach the room as a CRDT update");
    };
    drop(watcher);
}

#[test]
fn a_note_the_watcher_did_not_name_is_not_re_read() {
    // `Changes::Only` is a filter, not a hint: a room absent from the set must be skipped,
    // or the watcher saves nothing over the old unconditional poll.
    let dir = TempDir::new("watch-filtered");
    let note = dir.write("One.md", "before\n");
    let vault = Vault::open(Slug::parse("personal").unwrap(), "Personal", dir.path()).unwrap();
    let canonical = vault.canonical_note("One.md").unwrap();
    let registry = SyncRegistry::default();
    let user = Username::parse("alice").unwrap();
    let (outbound, mut inbox) = tokio::sync::mpsc::unbounded_channel();
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
    std::fs::write(&note, "edited in obsidian\n").unwrap();

    let elsewhere = Changes::Only([PathBuf::from("/nowhere/Other.md")].into_iter().collect());
    assert!(
        registry
            .maintain(Instant::now(), &elsewhere, &|_, _, _| true)
            .is_empty()
    );
    assert!(inbox.try_recv().is_err(), "an unnamed note is left alone");

    // And the recovery sweep is what makes a missed event a delay rather than a wrong note.
    assert!(
        registry
            .maintain(Instant::now(), &Changes::All, &|_, _, _| true)
            .is_empty()
    );
    assert!(
        matches!(inbox.try_recv(), Ok(ServerFrame::Update { .. })),
        "the sweep must still find a change the watcher never reported"
    );
}

#[test]
fn an_overflowed_signal_degrades_to_checking_everything() {
    let signal = WatchSignal::default();
    signal.touched(PathBuf::from("/one.md"));
    signal.overflowed();

    assert_eq!(signal.take(), Changes::All);
    assert_eq!(
        signal.take(),
        Changes::Only(std::collections::BTreeSet::new()),
        "an overflow is consumed once, not latched forever"
    );
}

#[test]
fn a_coordinators_own_write_is_still_suppressed_when_the_watcher_reports_it() {
    // The watcher cannot tell whose write it saw, so hash-based self-write suppression has
    // to survive the switch away from polling (§3.4).
    let dir = TempDir::new("watch-self-write");
    dir.write("One.md", "before\n");
    let vault = Vault::open(Slug::parse("personal").unwrap(), "Personal", dir.path()).unwrap();
    let canonical = vault.canonical_note("One.md").unwrap();
    let registry = SyncRegistry::default();
    let user = Username::parse("alice").unwrap();
    let (outbound, mut inbox) = tokio::sync::mpsc::unbounded_channel();
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
    let coordinator = NoteCoordinator::open(&vault, &canonical).unwrap();
    let update = edit_to(&coordinator, "after\n");
    drop(coordinator);
    registry
        .apply_update(&vault, &canonical, &update, &|_, _, _| true)
        .unwrap();
    drop(inbox.try_recv().expect("the author's own echo"));

    // Flush, then tell maintenance the file changed — which it did, by our own hand.
    assert!(registry.flush_all().is_empty());
    let ours = Changes::Only(
        [dir.path().join("One.md").canonicalize().unwrap()]
            .into_iter()
            .collect(),
    );
    assert!(
        registry
            .maintain(Instant::now(), &ours, &|_, _, _| true)
            .is_empty()
    );

    assert!(
        inbox.try_recv().is_err(),
        "a coordinator's own atomic write must never loop back as an external change"
    );
}
