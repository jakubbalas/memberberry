//! Unlinked mentions (`SPEC.md` §9.5) and their E8 boundary.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

mod support;

use mb_index::{Index, NoteInput, Stamp};
use support::{TempDir, indexed, user, viewer_everywhere, viewer_except};

const LIMIT: usize = 50;

fn published(notes: &[(&str, &str)]) -> Index {
    let mut index = indexed(notes);
    index.publish().expect("publish");
    index
}

#[test]
fn a_note_naming_the_target_without_linking_to_it_is_a_mention() {
    let mut index = published(&[
        (
            "Projects/Roadmap.md",
            "# Product Roadmap\n\nThe orchard release ships Friday.\n",
        ),
        (
            "Meetings/Monday.md",
            "# Monday\n\nWe discussed the Product Roadmap at length.\n",
        ),
    ]);
    let access = viewer_everywhere("alice");
    let reader = index.reader(&access, &user("alice")).expect("reader");

    let mentions = reader
        .unlinked_mentions("Projects/Roadmap.md", LIMIT)
        .expect("mentions");
    assert_eq!(mentions.len(), 1);
    assert_eq!(mentions[0].path, "Meetings/Monday.md");
    assert_eq!(mentions[0].title.as_deref(), Some("Monday"));
    assert_eq!(
        mentions[0].contexts,
        ["We discussed the Product Roadmap at length."]
    );
}

#[test]
fn a_note_that_already_links_here_is_a_backlink_and_not_a_mention() {
    let mut index = published(&[
        ("Projects/Roadmap.md", "# Product Roadmap\n\nBody.\n"),
        (
            "Meetings/Monday.md",
            "# Monday\n\nWe reviewed [[Projects/Roadmap]] and the Product Roadmap again.\n",
        ),
    ]);
    let access = viewer_everywhere("alice");
    let reader = index.reader(&access, &user("alice")).expect("reader");

    assert_eq!(
        reader
            .backlinks("Projects/Roadmap.md")
            .expect("links")
            .len(),
        1
    );
    assert!(
        reader
            .unlinked_mentions("Projects/Roadmap.md", LIMIT)
            .expect("mentions")
            .is_empty()
    );
}

#[test]
fn the_target_does_not_mention_itself() {
    let mut index = published(&[(
        "Projects/Roadmap.md",
        "# Product Roadmap\n\nThe Product Roadmap is this note.\n",
    )]);
    let access = viewer_everywhere("alice");
    let reader = index.reader(&access, &user("alice")).expect("reader");

    assert!(
        reader
            .unlinked_mentions("Projects/Roadmap.md", LIMIT)
            .expect("mentions")
            .is_empty()
    );
}

#[test]
fn an_alias_and_a_filename_are_both_names_a_mention_may_use() {
    let mut index = published(&[
        (
            "Projects/Roadmap.md",
            "---\naliases: [\"The Plan\"]\n---\n\n# Product Roadmap\n\nBody.\n",
        ),
        ("Alias.md", "# Alias\n\nCheck The Plan before Friday.\n"),
        ("Stem.md", "# Stem\n\nThe Roadmap is agreed.\n"),
    ]);
    let access = viewer_everywhere("alice");
    let reader = index.reader(&access, &user("alice")).expect("reader");

    let paths: Vec<_> = reader
        .unlinked_mentions("Projects/Roadmap.md", LIMIT)
        .expect("mentions")
        .into_iter()
        .map(|group| group.path)
        .collect();
    assert_eq!(paths, ["Alias.md", "Stem.md"]);
}

#[test]
fn a_mention_matches_whole_words_rather_than_a_prefix_or_a_near_miss() {
    let mut index = published(&[
        ("Roadmap.md", "# Roadmap\n\nBody.\n"),
        ("Plural.md", "# Plural\n\nWe keep two roadmaps.\n"),
        ("Typo.md", "# Typo\n\nThe roadmpa is agreed.\n"),
    ]);
    let access = viewer_everywhere("alice");
    let reader = index.reader(&access, &user("alice")).expect("reader");

    assert!(
        reader
            .unlinked_mentions("Roadmap.md", LIMIT)
            .expect("mentions")
            .is_empty()
    );
}

#[test]
fn mentions_are_grouped_by_note_in_document_order_rather_than_by_score() {
    // why: the blocks below are arranged so relevance order and document order disagree —
    // `Journal.md`'s *second* block names the target three times and outscores its first,
    // and `Ledger.md`'s single block lands between them. Left in score order the groups come
    // out as Journal, Ledger, Journal: one note listed twice, with its blocks out of order.
    let mut index = published(&[
        ("Roadmap.md", "# Roadmap\n\nBody.\n"),
        (
            "Journal.md",
            "# Journal\n\nWe read the Roadmap once.\n\nRoadmap, Roadmap, Roadmap.\n",
        ),
        ("Ledger.md", "# Ledger\n\nRoadmap and Roadmap.\n"),
    ]);
    let access = viewer_everywhere("alice");
    let reader = index.reader(&access, &user("alice")).expect("reader");

    let mentions = reader
        .unlinked_mentions("Roadmap.md", LIMIT)
        .expect("mentions");
    let paths: Vec<_> = mentions.iter().map(|group| group.path.as_str()).collect();
    assert_eq!(paths, ["Journal.md", "Ledger.md"]);
    assert_eq!(
        mentions[0].contexts,
        ["We read the Roadmap once.", "Roadmap, Roadmap, Roadmap."]
    );
}

#[test]
fn e8_a_mention_from_an_unreadable_note_is_absent() {
    let mut index = published(&[
        ("Roadmap.md", "# Roadmap\n\nBody.\n"),
        (
            "Private/Salary.md",
            "# Compensation\n\nThe canary Roadmap costs money.\n",
        ),
        ("Shared/Notes.md", "# Notes\n\nThe Roadmap is agreed.\n"),
    ]);

    let limited = viewer_except("alice", &["Private"]);
    let reader = index.reader(&limited, &user("alice")).expect("reader");
    let mentions = reader
        .unlinked_mentions("Roadmap.md", LIMIT)
        .expect("mentions");
    assert_eq!(mentions.len(), 1);
    assert_eq!(mentions[0].path, "Shared/Notes.md");
    assert!(
        !mentions
            .iter()
            .any(|group| group.contexts.iter().any(|text| text.contains("canary")))
    );

    let all = viewer_everywhere("bob");
    let reader = index.reader(&all, &user("bob")).expect("reader");
    assert_eq!(
        reader
            .unlinked_mentions("Roadmap.md", LIMIT)
            .expect("mentions")
            .len(),
        2
    );
}

#[test]
fn e8_an_unreadable_target_has_no_mentions_because_it_does_not_exist() {
    let mut index = published(&[
        ("Private/Salary.md", "# Compensation\n\nBody.\n"),
        (
            "Shared/Notes.md",
            "# Notes\n\nCompensation is under review.\n",
        ),
    ]);

    let limited = viewer_except("alice", &["Private"]);
    let reader = index.reader(&limited, &user("alice")).expect("reader");
    assert!(
        reader
            .unlinked_mentions("Private/Salary.md", LIMIT)
            .expect("mentions")
            .is_empty()
    );

    let all = viewer_everywhere("bob");
    let reader = index.reader(&all, &user("bob")).expect("reader");
    assert_eq!(
        reader
            .unlinked_mentions("Private/Salary.md", LIMIT)
            .expect("mentions")
            .len(),
        1
    );
}

#[test]
fn a_missing_note_and_a_zero_limit_are_values_rather_than_errors() {
    let mut index = published(&[("Roadmap.md", "# Roadmap\n\nBody.\n")]);
    let access = viewer_everywhere("alice");
    let reader = index.reader(&access, &user("alice")).expect("reader");

    assert!(
        reader
            .unlinked_mentions("Nowhere.md", LIMIT)
            .expect("missing note")
            .is_empty()
    );
    assert!(
        reader
            .unlinked_mentions("Roadmap.md", 0)
            .expect("zero limit")
            .is_empty()
    );
}

#[test]
fn a_text_index_written_under_an_older_schema_is_rebuilt_rather_than_refused() {
    // why: the search directory is derived state, and `schema.rs` rebuilds SQLite on a
    // version mismatch rather than migrating it. A stale text index has to behave the same
    // way or a schema change becomes a server that will not start (I1).
    let dir = TempDir::new("search-schema");
    let database = dir.path().join("graph.sqlite");
    let search = dir.path().join("search-v1");
    std::fs::create_dir_all(&search).expect("search dir");
    let mut builder = tantivy::schema::Schema::builder();
    builder.add_text_field("something_else", tantivy::schema::TEXT);
    tantivy::Index::create_in_dir(&search, builder.build()).expect("foreign index");

    let mut index = Index::open(&database).expect("open over a foreign text index");
    index
        .upsert(&NoteInput {
            path: "Roadmap.md".to_string(),
            markdown: "# Roadmap\n\nBody.\n".to_string(),
            stamp: Stamp::from_parts(17, 1),
        })
        .expect("upsert");
    index.publish().expect("publish");
    let access = viewer_everywhere("alice");
    let reader = index.reader(&access, &user("alice")).expect("reader");
    assert_eq!(reader.search("roadmap", 10).expect("search").len(), 1);
}
