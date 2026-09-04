//! The tag tree and the notes under a tag (`SPEC.md` §9.3).

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

mod support;

use mb_core::Access;
use mb_index::TagNode;
use support::{indexed, user, viewer_everywhere, viewer_except};

/// `(key, tag, notes)` for every tag one user can see.
fn tags(notes: &[(&str, &str)], access: &Access, as_user: &str) -> Vec<(String, String, usize)> {
    let mut index = indexed(notes);
    let reader = index.reader(access, &user(as_user)).expect("reader");
    reader
        .tags()
        .expect("tags")
        .into_iter()
        .map(|TagNode { tag, key, notes }| (key, tag, notes))
        .collect()
}

/// The same, for a user who may read everything.
fn all_tags(notes: &[(&str, &str)]) -> Vec<(String, String, usize)> {
    tags(notes, &viewer_everywhere("alice"), "alice")
}

/// Paths of the readable notes under `prefix`.
fn tagged(notes: &[(&str, &str)], access: &Access, as_user: &str, prefix: &str) -> Vec<String> {
    let mut index = indexed(notes);
    let reader = index.reader(access, &user(as_user)).expect("reader");
    reader
        .tagged(prefix)
        .expect("tagged")
        .into_iter()
        .map(|target| target.path)
        .collect()
}

#[test]
fn a_nested_tag_is_one_node_per_prefix_and_the_parent_counts_the_child() {
    assert_eq!(
        all_tags(&[("a.md", "#project/memberberry/spec\n")]),
        vec![
            ("project".to_string(), "project".to_string(), 1),
            (
                "project/memberberry".to_string(),
                "project/memberberry".to_string(),
                1
            ),
            (
                "project/memberberry/spec".to_string(),
                "project/memberberry/spec".to_string(),
                1
            ),
        ]
    );
}

#[test]
fn a_parent_counts_a_note_once_however_many_children_it_carries() {
    let counts = all_tags(&[("a.md", "#project/one #project/two #project/three\n")]);
    let project = counts
        .iter()
        .find(|(key, _, _)| key == "project")
        .expect("the parent node");
    assert_eq!(project.2, 1, "one note carrying three children is one note");
}

#[test]
fn two_notes_under_one_parent_count_two() {
    let counts = all_tags(&[("a.md", "#project/one\n"), ("b.md", "#project/two\n")]);
    assert_eq!(
        counts
            .iter()
            .find(|(key, _, _)| key == "project")
            .expect("the parent node")
            .2,
        2
    );
}

#[test]
fn case_is_not_identity_and_the_commonest_spelling_is_shown() {
    assert_eq!(
        all_tags(&[
            ("a.md", "#Project\n"),
            ("b.md", "#project\n"),
            ("c.md", "#project\n"),
        ]),
        vec![("project".to_string(), "project".to_string(), 3)],
        "one tag, counted once per note, shown as the spelling most notes use"
    );
}

#[test]
fn a_spelling_tie_is_broken_alphabetically_rather_than_by_insertion_order() {
    // why: pinned. A tie resolved by rowid would make the pane's label depend on which note
    // was indexed first, which changes when a file is touched and nothing else.
    let forwards = all_tags(&[("a.md", "#Project\n"), ("b.md", "#project\n")]);
    let backwards = all_tags(&[("a.md", "#project\n"), ("b.md", "#Project\n")]);
    assert_eq!(forwards, backwards);
    assert_eq!(forwards[0].1, "Project");
}

#[test]
fn a_frontmatter_tag_and_an_inline_tag_are_one_tag() {
    assert_eq!(
        all_tags(&[
            ("a.md", "---\ntags: [architecture]\n---\n"),
            ("b.md", "#architecture\n"),
        ]),
        vec![("architecture".to_string(), "architecture".to_string(), 2)]
    );
}

#[test]
fn a_vault_with_no_tags_has_no_nodes() {
    assert!(all_tags(&[("a.md", "# Just a heading\n")]).is_empty());
}

#[test]
fn a_tag_carried_only_by_an_unreadable_note_has_no_row_at_all() {
    let notes = &[
        ("Open.md", "#shared\n"),
        ("Private/Salary.md", "#salary #shared\n"),
    ];
    assert_eq!(
        tags(notes, &viewer_except("alice", &["Private"]), "alice"),
        vec![("shared".to_string(), "shared".to_string(), 1)],
        "the private note's own tag must not appear, and must not be counted under `shared`"
    );
}

#[test]
fn a_reader_who_may_see_nothing_sees_no_tags() {
    let notes = &[("Private/Salary.md", "#salary\n")];
    assert!(tags(notes, &viewer_except("alice", &["Private"]), "alice").is_empty());
}

#[test]
fn selecting_a_prefix_lists_every_note_nested_under_it() {
    assert_eq!(
        tagged(
            &[
                ("a.md", "#project/memberberry/spec\n"),
                ("b.md", "#project/other\n"),
                ("c.md", "#unrelated\n"),
            ],
            &viewer_everywhere("alice"),
            "alice",
            "project"
        ),
        vec!["a.md".to_string(), "b.md".to_string()]
    );
}

#[test]
fn selecting_a_prefix_names_a_note_once_however_many_matching_tags_it_carries() {
    assert_eq!(
        tagged(
            &[("a.md", "#project/one #project/two\n")],
            &viewer_everywhere("alice"),
            "alice",
            "project"
        ),
        vec!["a.md".to_string()]
    );
}

#[test]
fn a_prefix_may_be_written_in_any_case_and_with_or_without_its_hash() {
    for asked in ["Project", "#project", " project "] {
        assert_eq!(
            tagged(
                &[("a.md", "#PROJECT/spec\n")],
                &viewer_everywhere("alice"),
                "alice",
                asked
            ),
            vec!["a.md".to_string()],
            "asking for `{asked}` found nothing"
        );
    }
}

#[test]
fn an_empty_prefix_names_nothing_rather_than_everything() {
    assert!(
        tagged(
            &[("a.md", "#project\n")],
            &viewer_everywhere("alice"),
            "alice",
            "  "
        )
        .is_empty()
    );
}

#[test]
fn selecting_a_prefix_names_no_note_the_reader_cannot_see() {
    assert_eq!(
        tagged(
            &[("Open.md", "#shared\n"), ("Private/Salary.md", "#shared\n"),],
            &viewer_except("alice", &["Private"]),
            "alice",
            "shared"
        ),
        vec!["Open.md".to_string()]
    );
}

#[test]
fn a_tag_leaves_the_tree_when_its_last_note_stops_carrying_it() {
    let mut index = indexed(&[("a.md", "#project/spec\n")]);
    index
        .upsert(&mb_index::NoteInput {
            path: "a.md".to_string(),
            markdown: "no tags here\n".to_string(),
            stamp: mb_index::Stamp::from_parts(13, 99),
        })
        .expect("upsert");
    let access = viewer_everywhere("alice");
    let reader = index.reader(&access, &user("alice")).expect("reader");
    assert!(reader.tags().expect("tags").is_empty());
}
