//! Server-side full-text search (`SPEC.md` §14.1) and its E5 leak boundary.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

mod support;

use mb_index::{NoteInput, Stamp};
use support::{indexed, user, viewer_everywhere, viewer_except};

#[test]
fn body_title_tag_and_path_queries_return_matched_block_context() {
    let mut index = indexed(&[(
        "Projects/Roadmap.md",
        "---\ntags: [planning]\n---\n\n# Product Roadmap\n\nThe orchard release ships Friday.\n",
    )]);
    index.publish().expect("publish");
    let access = viewer_everywhere("alice");
    let reader = index.reader(&access, &user("alice")).expect("reader");

    for query in ["orchard", "title:roadmap", "tag:planning", "path:projects"] {
        let hits = reader.search(query, 10).expect("search");
        assert_eq!(hits.len(), 1, "query {query}");
        assert_eq!(hits[0].path, "Projects/Roadmap.md");
    }
    assert_eq!(
        reader.search("orchard", 10).expect("body search")[0].context,
        "The orchard release ships Friday."
    );
}

#[test]
fn boolean_operators_compose_terms() {
    let mut index = indexed(&[
        ("Both.md", "rust search engine\n"),
        ("Rust.md", "rust parser\n"),
        ("Search.md", "search interface\n"),
    ]);
    index.publish().expect("publish");
    let access = viewer_everywhere("alice");
    let reader = index.reader(&access, &user("alice")).expect("reader");

    let paths = reader
        .search("rust AND search", 10)
        .expect("search")
        .into_iter()
        .map(|hit| hit.path)
        .collect::<Vec<_>>();
    assert_eq!(paths, ["Both.md"]);
}

#[test]
fn plain_terms_support_prefix_and_one_edit_fuzzy_matching() {
    let mut index = indexed(&[("A.md", "The orchard release ships Friday.\n")]);
    index.publish().expect("publish");
    let access = viewer_everywhere("alice");
    let reader = index.reader(&access, &user("alice")).expect("reader");

    assert_eq!(reader.search("orch", 10).expect("prefix").len(), 1);
    assert_eq!(reader.search("orhcard", 10).expect("fuzzy").len(), 1);
}

#[test]
fn e5_search_never_returns_an_unreadable_note_or_its_fields() {
    let mut index = indexed(&[
        ("Shared.md", "ordinary visible words\n"),
        (
            "Private/Salary.md",
            "---\ntags: [secret-payroll]\n---\n\n# Compensation\n\nThe canary salary is private.\n",
        ),
    ]);
    index.publish().expect("publish");

    let limited = viewer_except("alice", &["Private"]);
    let reader = index
        .reader(&limited, &user("alice"))
        .expect("limited reader");
    for query in [
        "canary",
        "title:compensation",
        "tag:secret-payroll",
        "path:private",
    ] {
        assert!(
            reader.search(query, 10).expect("search").is_empty(),
            "{query} disclosed an unreadable note"
        );
    }

    let all = viewer_everywhere("bob");
    let reader = index.reader(&all, &user("bob")).expect("full reader");
    assert_eq!(reader.search("canary", 10).expect("search").len(), 1);
}

#[test]
fn rewriting_and_removing_a_note_remove_stale_search_hits() {
    let mut index = indexed(&[("Mutable.md", "oldword\n")]);
    index.publish().expect("first publish");

    index
        .upsert(&NoteInput {
            path: "Mutable.md".to_string(),
            markdown: "newword\n".to_string(),
            stamp: Stamp::from_parts(8, 2),
        })
        .expect("rewrite");
    index.publish().expect("second publish");
    let access = viewer_everywhere("alice");
    {
        let reader = index.reader(&access, &user("alice")).expect("reader");
        assert!(reader.search("oldword", 10).expect("old").is_empty());
        assert_eq!(reader.search("newword", 10).expect("new").len(), 1);
    }

    assert!(index.remove("Mutable.md").expect("remove"));
    index.publish().expect("third publish");
    let reader = index.reader(&access, &user("alice")).expect("reader");
    assert!(reader.search("newword", 10).expect("removed").is_empty());
}

#[test]
fn empty_and_malformed_queries_are_values_not_panics() {
    let mut index = indexed(&[("A.md", "some words\n")]);
    index.publish().expect("publish");
    let access = viewer_everywhere("alice");
    let reader = index.reader(&access, &user("alice")).expect("reader");

    assert!(reader.search("", 10).expect("empty").is_empty());
    assert!(reader.search("title:(", 10).is_err());
}
