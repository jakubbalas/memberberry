//! Resolving a reference the caller supplies (`SPEC.md` §4.3, §9.2, E9).
//!
//! `backlinks.rs` covers resolution of the links already *in* the index. This covers
//! `Reader::resolve`, which answers the same question for a reference handed in from
//! outside — a transclusion being rendered — and has to give the same answer.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

mod support;

use support::{indexed, user, viewer_everywhere, viewer_except};

const VAULT: &[(&str, &str)] = &[
    ("Projects/Roadmap.md", "# The Plan\n"),
    ("Archive/Roadmap.md", "# Old\n"),
    ("Projects/Q3.md", "see [[Roadmap]]\n"),
    (
        "Aliased.md",
        "---\naliases:\n  - Nickname\n---\n# Aliased\n",
    ),
    // Nothing titleable: `extract::title` falls back to the first paragraph, so a note
    // with no text at all is what "no title" actually looks like.
    ("Untitled.md", "***\n"),
];

/// The path `reference` resolves to when read from `source`, for a user who reads all.
fn resolved(source: &str, reference: &str) -> Option<String> {
    let mut index = indexed(VAULT);
    let access = viewer_everywhere("alice");
    let reader = index.reader(&access, &user("alice")).expect("reader");
    reader
        .resolve(source, reference)
        .expect("resolve")
        .map(|target| target.path)
}

/// The same, for a user denied `denied`.
fn resolved_without(denied: &[&str], source: &str, reference: &str) -> Option<String> {
    let mut index = indexed(VAULT);
    let access = viewer_except("alice", denied);
    let reader = index.reader(&access, &user("alice")).expect("reader");
    reader
        .resolve(source, reference)
        .expect("resolve")
        .map(|target| target.path)
}

#[test]
fn a_bare_name_resolves_to_the_nearest_note_of_that_name() {
    assert_eq!(
        resolved("Projects/Q3.md", "Roadmap").as_deref(),
        Some("Projects/Roadmap.md")
    );
}

#[test]
fn the_source_note_only_breaks_the_tie() {
    assert_eq!(
        resolved("Archive/Notes.md", "Roadmap").as_deref(),
        Some("Archive/Roadmap.md"),
        "the same reference means a different note read from a different folder"
    );
}

#[test]
fn a_full_path_beats_a_nearer_bare_name() {
    assert_eq!(
        resolved("Projects/Q3.md", "Archive/Roadmap").as_deref(),
        Some("Archive/Roadmap.md"),
        "writing the path is how a human disambiguates, so it always wins (§4.3)"
    );
}

#[test]
fn a_reference_may_be_written_with_its_extension() {
    assert_eq!(
        resolved("Projects/Q3.md", "Projects/Roadmap.md").as_deref(),
        Some("Projects/Roadmap.md")
    );
}

#[test]
fn a_reference_matches_case_insensitively() {
    assert_eq!(
        resolved("Projects/Q3.md", "rOADMAP").as_deref(),
        Some("Projects/Roadmap.md")
    );
}

#[test]
fn an_alias_resolves_to_the_note_that_declares_it() {
    assert_eq!(
        resolved("Projects/Q3.md", "Nickname").as_deref(),
        Some("Aliased.md")
    );
}

#[test]
fn a_reference_to_nothing_resolves_to_nothing() {
    assert_eq!(resolved("Projects/Q3.md", "Absent"), None);
}

#[test]
fn an_empty_reference_resolves_to_nothing() {
    for reference in ["", "   ", ".md"] {
        assert_eq!(
            resolved("Projects/Q3.md", reference),
            None,
            "{reference:?} names no note, and must not match the first row in the table"
        );
    }
}

#[test]
fn a_resolved_target_carries_the_notes_title() {
    let mut index = indexed(VAULT);
    let access = viewer_everywhere("alice");
    let reader = index.reader(&access, &user("alice")).expect("reader");
    let target = reader
        .resolve("Projects/Q3.md", "Roadmap")
        .expect("resolve")
        .expect("a target");
    assert_eq!(target.title.as_deref(), Some("The Plan"));
    let untitled = reader
        .resolve("Projects/Q3.md", "Untitled")
        .expect("resolve")
        .expect("a target");
    assert_eq!(
        untitled.title, None,
        "a note with nothing titleable has no title, rather than a made-up one"
    );
}

#[test]
fn an_unreadable_note_is_not_a_candidate() {
    assert_eq!(
        resolved_without(&["Projects/Roadmap.md"], "Projects/Q3.md", "Roadmap").as_deref(),
        Some("Archive/Roadmap.md"),
        "the nearest candidate the user may read wins; the nearer one does not exist for them"
    );
}

#[test]
fn a_reference_to_an_unreadable_note_resolves_to_nothing() {
    assert_eq!(
        resolved_without(
            &["Projects/Roadmap.md", "Archive/Roadmap.md"],
            "Projects/Q3.md",
            "Roadmap"
        ),
        None,
        "indistinguishable from a reference to a note that was never written (§6.5)"
    );
}

#[test]
fn an_unreadable_notes_alias_is_not_a_candidate() {
    assert_eq!(
        resolved_without(&["Aliased.md"], "Projects/Q3.md", "Nickname"),
        None,
        "an alias is a name, and a name of an unreadable note is one nobody may resolve"
    );
}

#[test]
fn resolution_agrees_with_the_link_already_in_the_index() {
    // The two paths must give one answer: the panel that says "Q3 embeds this note" and the
    // embed that renders it resolve the same reference, and disagreeing would put a
    // backlink row next to content from a different note.
    let mut index = indexed(VAULT);
    let access = viewer_everywhere("alice");
    let reader = index.reader(&access, &user("alice")).expect("reader");
    let by_query = reader
        .resolve("Projects/Q3.md", "Roadmap")
        .expect("resolve")
        .expect("a target");
    let inbound: Vec<String> = reader
        .backlinks(&by_query.path)
        .expect("backlinks")
        .into_iter()
        .map(|group| group.path)
        .collect();
    assert_eq!(
        inbound,
        vec!["Projects/Q3.md".to_string()],
        "the note `resolve` picked is the one the index says `Q3` links to"
    );
}
