//! The staleness stamp (`SPEC.md` §9.1, `write.rs`).

#![allow(clippy::expect_used, clippy::unwrap_used)]

mod support;

use mb_index::Stamp;
use support::TempDir;

#[test]
fn a_stamp_changes_when_a_files_length_changes() {
    let dir = TempDir::new("stamp");
    let path = dir.write("a.md", "one\n");
    let first = Stamp::of(&path).expect("stamp");
    dir.write("a.md", "one and more\n");
    assert_ne!(first, Stamp::of(&path).expect("stamp"));
}

#[test]
fn a_stamp_distinguishes_two_files_of_equal_length_by_modification_time() {
    // why: no sleep. The property under test is that the modification time participates in
    // the stamp at all — a length-only fingerprint misses every same-length edit — and that
    // is a property of how a stamp is built, not of how fast this machine's clock ticks.
    assert_ne!(Stamp::from_parts(12, 100), Stamp::from_parts(12, 200));
    assert_ne!(Stamp::from_parts(12, 100), Stamp::from_parts(13, 100));
    assert_eq!(Stamp::from_parts(12, 100), Stamp::from_parts(12, 100));
}

#[test]
fn stamping_a_missing_file_is_not_an_error() {
    // A note deleted between listing and stamping is ordinary, and it is the reconcile's
    // job to notice it is gone rather than this function's job to fail.
    assert!(Stamp::of(std::path::Path::new("/nonexistent/note.md")).is_none());
}
