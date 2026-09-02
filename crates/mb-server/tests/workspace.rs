//! Workspace layout storage (`SPEC.md` §8.1), at the store level.
//!
//! The permission boundary is in `tests/leak_suite.rs` under E15 and the HTTP route is in
//! `tests/http.rs`. What is here is the behaviour of the file itself: what happens to a
//! layout that is too big, is not JSON, was never written, or is written while the last
//! attempt left a temporary file behind.
//!
//! The bias throughout is that **losing a layout is acceptable and corrupting one is not**.
//! It is derived state under `.memberberry/` (Invariant I1, §22.4), so the worst honest
//! outcome is that the user's panes reset.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod support;

use mb_core::Username;
use mb_server::workspace::{DeviceId, MAX_LAYOUT_BYTES, WorkspaceStore};
use support::TempDir;

fn user() -> Username {
    Username::parse("alice").expect("username")
}

fn device() -> DeviceId {
    DeviceId::parse("laptop").expect("device")
}

/// A minimal layout that the client's own validator would accept.
const LAYOUT: &str = r#"{"format":1,"vault":"personal","focusedGroup":"g","root":{"kind":"group","id":"g","tabs":[],"activeTab":null}}"#;

#[test]
fn a_saved_layout_comes_back_byte_for_byte() {
    // Byte-for-byte matters: the client compares what it loaded against what it would save
    // to decide whether anything changed, and a server that reformatted the JSON would make
    // every load look like an edit.
    let dir = TempDir::new("workspace-roundtrip");
    let store = WorkspaceStore::new(dir.path());

    store.save(&user(), &device(), LAYOUT).expect("save");
    assert_eq!(
        store.load(&user(), &device()).expect("load"),
        Some(LAYOUT.to_string())
    );
}

#[test]
fn a_device_that_never_saved_a_layout_is_not_an_error() {
    // The first visit from a new device. The client opens a fresh workspace, which is also
    // what it does for a layout it cannot parse — so there is nothing to distinguish.
    let dir = TempDir::new("workspace-absent");
    let store = WorkspaceStore::new(dir.path());
    assert_eq!(store.load(&user(), &device()).expect("load"), None);
}

#[test]
fn saving_replaces_the_previous_layout_rather_than_appending() {
    let dir = TempDir::new("workspace-replace");
    let store = WorkspaceStore::new(dir.path());
    let second = r#"{"format":1,"vault":"personal","focusedGroup":"h","root":{"kind":"group","id":"h","tabs":[],"activeTab":null}}"#;

    store.save(&user(), &device(), LAYOUT).expect("first save");
    store.save(&user(), &device(), second).expect("second save");
    assert_eq!(
        store.load(&user(), &device()).expect("load"),
        Some(second.to_string())
    );
}

#[test]
fn two_devices_belonging_to_one_user_keep_separate_layouts() {
    // §8.1: not synced. A phone and a 32" monitor legitimately differ, and this is the
    // mechanism — same user, different file.
    let dir = TempDir::new("workspace-two-devices");
    let store = WorkspaceStore::new(dir.path());
    let phone = DeviceId::parse("pixel-7a").expect("device");
    let phone_layout = r#"{"format":1,"vault":"personal","focusedGroup":"p","root":{"kind":"group","id":"p","tabs":[],"activeTab":null}}"#;

    store.save(&user(), &device(), LAYOUT).expect("laptop save");
    store
        .save(&user(), &phone, phone_layout)
        .expect("phone save");

    assert_eq!(
        store.load(&user(), &device()).expect("laptop load"),
        Some(LAYOUT.to_string())
    );
    assert_eq!(
        store.load(&user(), &phone).expect("phone load"),
        Some(phone_layout.to_string())
    );
}

#[test]
fn a_layout_that_is_not_json_is_refused_rather_than_stored() {
    // Not schema validation — the shape belongs to the client. This is here so that whatever
    // is on disk is at least parseable, rather than one bad request producing a file that
    // fails to load for the rest of the vault's life.
    let dir = TempDir::new("workspace-not-json");
    let store = WorkspaceStore::new(dir.path());

    assert!(store.save(&user(), &device(), "{ not json").is_err());
    assert_eq!(
        store.load(&user(), &device()).expect("load"),
        None,
        "a refused save must leave nothing behind"
    );
}

#[test]
fn an_oversized_layout_is_refused_and_does_not_replace_a_good_one() {
    // A member is trusted to read notes, not to fill someone's disk.
    let dir = TempDir::new("workspace-oversize");
    let store = WorkspaceStore::new(dir.path());
    store.save(&user(), &device(), LAYOUT).expect("good save");

    let huge = format!("{{\"pad\":\"{}\"}}", "x".repeat(MAX_LAYOUT_BYTES));
    assert!(huge.len() > MAX_LAYOUT_BYTES);
    assert!(store.save(&user(), &device(), &huge).is_err());

    assert_eq!(
        store.load(&user(), &device()).expect("load"),
        Some(LAYOUT.to_string()),
        "a refused save must not destroy the layout that was already there"
    );
}

#[test]
fn a_layout_exactly_at_the_ceiling_is_accepted() {
    // The boundary, in the direction that is a bug if wrong: refusing a legal layout costs
    // the user their panes on every save.
    let dir = TempDir::new("workspace-boundary");
    let store = WorkspaceStore::new(dir.path());
    let prefix = "{\"pad\":\"";
    let suffix = "\"}";
    let pad = MAX_LAYOUT_BYTES - prefix.len() - suffix.len();
    let exact = format!("{prefix}{}{suffix}", "x".repeat(pad));
    assert_eq!(exact.len(), MAX_LAYOUT_BYTES);

    store.save(&user(), &device(), &exact).expect("save");
    assert_eq!(
        store
            .load(&user(), &device())
            .expect("load")
            .map(|l| l.len()),
        Some(MAX_LAYOUT_BYTES)
    );
}

#[test]
fn saving_leaves_no_temporary_file_behind() {
    // The write goes through a temporary file and a rename. One left behind would accumulate
    // per save, inside the user's vault, where they would eventually notice it.
    let dir = TempDir::new("workspace-temp");
    let store = WorkspaceStore::new(dir.path());
    store.save(&user(), &device(), LAYOUT).expect("save");

    let folder = dir
        .path()
        .join(".memberberry")
        .join("workspace")
        .join("alice");
    let names: Vec<String> = std::fs::read_dir(&folder)
        .expect("reading the workspace directory")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    assert_eq!(names, vec!["laptop.json".to_string()]);
}

#[test]
fn forgetting_a_layout_is_idempotent() {
    let dir = TempDir::new("workspace-forget");
    let store = WorkspaceStore::new(dir.path());
    store.save(&user(), &device(), LAYOUT).expect("save");

    store.forget(&user(), &device()).expect("first forget");
    assert_eq!(store.load(&user(), &device()).expect("load"), None);
    // Forgetting something already gone succeeded.
    store.forget(&user(), &device()).expect("second forget");
}

#[test]
fn deleting_the_derived_state_directory_loses_only_the_layout() {
    // Invariant I1 (§22.4): `rm -rf .memberberry/` and everything still works. A layout is
    // the one thing that legitimately does not survive it, and losing it must be graceful.
    let dir = TempDir::new("workspace-i1");
    dir.write("Note.md", "# Note\n");
    let store = WorkspaceStore::new(dir.path());
    store.save(&user(), &device(), LAYOUT).expect("save");

    std::fs::remove_dir_all(dir.path().join(".memberberry")).expect("removing derived state");

    assert_eq!(store.load(&user(), &device()).expect("load"), None);
    assert!(
        dir.path().join("Note.md").exists(),
        "the notes are untouched"
    );
    // And saving again rebuilds the directory rather than failing.
    store.save(&user(), &device(), LAYOUT).expect("save again");
    assert_eq!(
        store.load(&user(), &device()).expect("load"),
        Some(LAYOUT.to_string())
    );
}
