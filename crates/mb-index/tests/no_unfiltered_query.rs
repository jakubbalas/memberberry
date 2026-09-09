//! There is no unfiltered query in this crate, and this test is why (`AGENTS.md` §3.1, E5).
//!
//! §6.5 puts the readable-set filter at the index layer so features cannot forget it. That
//! only holds if a query cannot reach a base table, so this walks the crate's own SQL and
//! checks every table named after `FROM` or `JOIN` against an allowlist per module:
//!
//! - `readable.rs` defines the filter and therefore names base tables — that is its job;
//! - `schema.rs` and `write.rs` maintain the index and are not read paths;
//! - **everything else may name only the filtered views.**
//!
//! It is a text scan, which is crude, and it is the kind of crude that keeps working: a new
//! query in a new module is covered the day it is written, with no registration step to
//! forget. `readable.rs` is small enough to review by eye, which is the point of it being
//! the only exception.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

/// The views that carry the readable-set join, plus the set itself.
const FILTERED: &[&str] = &[
    "v_notes",
    "v_note_names",
    "v_links",
    "v_resolved",
    "v_tags",
    "v_blocks",
    "v_tasks",
    "v_media_refs",
    "readable",
];

/// Modules whose job is to define the filter or to write the index.
const NOT_A_READ_PATH: &[&str] = &[
    "readable.rs",
    "schema.rs",
    "write.rs",
    "testing.rs",
    "zones.rs",
];

/// Every table or view named directly after `FROM` or `JOIN` in `source`.
fn tables_named(source: &str) -> Vec<String> {
    let mut found = Vec::new();
    for keyword in ["FROM ", "JOIN "] {
        let mut rest = source;
        while let Some(at) = rest.find(keyword) {
            rest = &rest[at + keyword.len()..];
            let name: String = rest
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            if !name.is_empty() {
                found.push(name);
            }
        }
    }
    found
}

#[test]
fn no_read_path_names_a_base_table() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut checked = 0;
    for entry in std::fs::read_dir(&dir).expect("reading src/") {
        let path = entry.expect("dir entry").path();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .expect("file name")
            .to_string();
        if !name.ends_with(".rs") || NOT_A_READ_PATH.contains(&name.as_str()) {
            continue;
        }
        let source = std::fs::read_to_string(&path).expect("reading a module");
        checked += 1;
        for table in tables_named(&source) {
            assert!(
                FILTERED.contains(&table.as_str()),
                "{name} queries `{table}` directly. Every read goes through a filtered view \
                 (SPEC.md §6.5, E5) — add the view to `readable.rs` rather than the table here."
            );
        }
    }
    assert!(
        checked >= 2,
        "the scan found {checked} read-path modules, which means it stopped seeing them"
    );
}

#[test]
fn the_scan_can_see_an_unfiltered_query() {
    // A test that cannot fail is worse than no test (`AGENTS.md` §2.3). This pins the
    // detector itself, so the suite above cannot quietly stop detecting anything.
    assert_eq!(
        tables_named("SELECT n.path FROM notes n JOIN readable r ON r.note_id = n.id"),
        vec!["notes", "readable"]
    );
    assert_eq!(
        tables_named("SELECT id FROM v_notes WHERE path = ?1"),
        vec!["v_notes"]
    );
    assert!(tables_named("no sql here at all").is_empty());
}

#[test]
fn every_view_joins_the_readable_set() {
    // why: a structural test rather than a behavioural one. Both filters below are
    // *individually* sufficient for the queries that exist today — `backlinks` joins
    // `v_notes` and reads `v_resolved`, so removing the readable-set join from either one
    // alone changes no result, and a mutation probe on `v_links` was caught by nothing.
    // Defence in depth is the right shape and it is exactly the shape no behavioural test
    // can hold in place, so what holds it is this: a view here is filtered or it is a
    // failure, whether or not a query happens to observe it.
    let source = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/readable.rs"),
    )
    .expect("reading readable.rs");
    let mut views = 0;
    for chunk in source.split("CREATE TEMP VIEW ").skip(1) {
        let definition = chunk.split(';').next().expect("a view definition");
        let name: String = definition
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect();
        // The body only — a view whose own name starts with `v_` would otherwise satisfy
        // the check by being named, which is how the first version of this test passed a
        // mutation that removed the join it exists to require.
        let body = definition.split_once(" AS").expect("AS").1;
        views += 1;
        assert!(
            body.contains("readable") || body.contains("v_"),
            "view {name} reads a base table without joining the readable set (E5)"
        );
    }
    assert_eq!(
        views,
        FILTERED.len() - 1,
        "the allowlist and the views have drifted: every filtered name except `readable` \
         itself is a view, so a new view has to appear in both"
    );
}

#[test]
fn the_reader_is_the_only_public_way_to_query() {
    // Prose in a doc comment does not stop anyone. What does is that `Reader` has no public
    // constructor and `Index` exposes no connection, so this test is a placeholder for the
    // property and the compiler is what enforces it. Kept because the day someone adds
    // `pub fn connection(&self)`, the diff should have a red test next to it.
    let source = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs"),
    )
    .expect("reading lib.rs");
    assert!(
        !source.contains("pub fn conn") && !source.contains("pub conn"),
        "mb-index must not expose its connection: every query would then be able to skip \
         the readable-set filter (E5)"
    );
}
