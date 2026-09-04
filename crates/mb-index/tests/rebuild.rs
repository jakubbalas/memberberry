//! The index is derived state, and this suite is what makes that claim true.
//!
//! Invariant I1 (`SPEC.md` §22.4): `rm -rf .memberberry/` and everything still works. For
//! the index that means three things — a deleted database rebuilds, an unusable file is
//! replaced rather than fatal, and a database from a different schema version is rebuilt
//! rather than migrated (`schema.rs`).

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

mod support;

use mb_index::{Index, NoteInput, Stamp};
use support::{TempDir, user, viewer_everywhere};

fn note(path: &str, markdown: &str) -> NoteInput {
    NoteInput {
        path: path.to_string(),
        markdown: markdown.to_string(),
        stamp: Stamp::from_parts(markdown.len() as u64, 1),
    }
}

/// Indexes two linked notes at `path` and closes the database.
fn seed(path: &std::path::Path) {
    let mut index = Index::open(path).expect("open");
    index
        .upsert(&note("Target.md", "# Target\n"))
        .expect("upsert");
    index
        .upsert(&note("Source.md", "see [[Target]]\n"))
        .expect("upsert");
}

fn backlink_count(index: &mut Index, path: &str) -> usize {
    let access = viewer_everywhere("alice");
    let reader = index.reader(&access, &user("alice")).expect("reader");
    reader.backlinks(path).expect("backlinks").len()
}

#[test]
fn an_index_survives_being_closed_and_reopened() {
    let dir = TempDir::new("reopen");
    let path = dir.path().join(".memberberry/index/graph.sqlite");
    seed(&path);
    let mut index = Index::open(&path).expect("reopen");
    assert_eq!(backlink_count(&mut index, "Target.md"), 1);
}

#[test]
fn opening_creates_the_directory_it_needs() {
    let dir = TempDir::new("mkdir");
    let path = dir.path().join("deep/nested/index/graph.sqlite");
    let index = Index::open(&path).expect("open");
    assert_eq!(index.path(), Some(path.as_path()));
    assert!(path.exists());
}

#[test]
fn a_deleted_database_comes_back_empty_and_asks_for_every_note() {
    // This is Invariant I1 in one test: losing the file costs a reindex, not a feature.
    let dir = TempDir::new("deleted");
    let path = dir.path().join("index/graph.sqlite");
    seed(&path);
    std::fs::remove_file(&path).expect("delete the index");

    let mut index = Index::open(&path).expect("reopen after deletion");
    assert_eq!(backlink_count(&mut index, "Target.md"), 0);
    let plan = index
        .reconcile(&[
            ("Target.md".to_string(), Stamp::from_parts(9, 1)),
            ("Source.md".to_string(), Stamp::from_parts(16, 1)),
        ])
        .expect("reconcile");
    assert_eq!(
        plan.stale,
        vec!["Target.md", "Source.md"],
        "a plan preserves the caller's order, so a reindex walks the vault the way it listed it"
    );
}

#[test]
fn a_file_that_is_not_a_database_is_replaced() {
    let dir = TempDir::new("garbage");
    let path = dir.path().join("graph.sqlite");
    std::fs::write(&path, b"this is not a database, it is a poem").expect("write garbage");
    let mut index = Index::open(&path).expect("open over garbage");
    index.upsert(&note("a.md", "# A\n")).expect("upsert");
    assert_eq!(backlink_count(&mut index, "a.md"), 0);
}

#[test]
fn a_truncated_database_is_replaced() {
    let dir = TempDir::new("truncated");
    let path = dir.path().join("graph.sqlite");
    seed(&path);
    let bytes = std::fs::read(&path).expect("read");
    std::fs::write(&path, &bytes[..bytes.len() / 3]).expect("truncate");
    let mut index = Index::open(&path).expect("open over a truncated database");
    index.upsert(&note("a.md", "# A\n")).expect("upsert");
    assert_eq!(backlink_count(&mut index, "a.md"), 0);
}

#[test]
fn a_database_from_another_schema_version_is_rebuilt_not_migrated() {
    let dir = TempDir::new("version");
    let path = dir.path().join("graph.sqlite");
    seed(&path);
    // Stamping a future version is how a downgrade looks, and it is the case a migration
    // chain cannot handle at all.
    let conn = rusqlite::Connection::open(&path).expect("open directly");
    conn.pragma_update(None, "user_version", 999)
        .expect("stamp a foreign version");
    drop(conn);

    let mut index = Index::open(&path).expect("reopen");
    assert_eq!(
        backlink_count(&mut index, "Target.md"),
        0,
        "rows from a schema this build does not know must not be served"
    );
    index
        .upsert(&note("Target.md", "# Target\n"))
        .expect("upsert");
    index
        .upsert(&note("Source.md", "see [[Target]]\n"))
        .expect("upsert");
    assert_eq!(backlink_count(&mut index, "Target.md"), 1);
}

#[test]
fn a_stamped_version_with_no_schema_behind_it_is_rebuilt() {
    // A hand-stamped empty file reports the right version and has no tables. Trusting the
    // stamp alone would leave every query failing on a missing table forever.
    let dir = TempDir::new("stamp-only");
    let path = dir.path().join("graph.sqlite");
    let conn = rusqlite::Connection::open(&path).expect("create");
    conn.pragma_update(None, "user_version", 1).expect("stamp");
    drop(conn);

    let mut index = Index::open(&path).expect("open");
    index.upsert(&note("a.md", "# A\n")).expect("upsert");
    assert_eq!(backlink_count(&mut index, "a.md"), 0);
}

#[test]
fn an_in_memory_index_reports_no_path() {
    let index = Index::in_memory().expect("in-memory");
    assert_eq!(index.path(), None);
}

#[test]
fn opening_a_path_that_cannot_be_a_file_is_an_error_rather_than_a_panic() {
    // A directory where the database should be is a misconfiguration, not something to
    // recover from by deleting the caller's directory.
    let dir = TempDir::new("is-a-dir");
    let path = dir.path().join("graph.sqlite");
    std::fs::create_dir_all(&path).expect("create a directory in its place");
    assert!(Index::open(&path).is_err());
}
