//! Link resolution and the backlinks query (`SPEC.md` §4.3, §9.5).

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

mod support;

use support::{indexed, user, viewer_everywhere};

/// Backlink source paths for `path`, as one user who may read everything.
fn sources(notes: &[(&str, &str)], path: &str) -> Vec<String> {
    let mut index = indexed(notes);
    let access = viewer_everywhere("alice");
    let reader = index.reader(&access, &user("alice")).expect("reader");
    reader
        .backlinks(path)
        .expect("backlinks")
        .into_iter()
        .map(|group| group.path)
        .collect()
}

#[test]
fn a_wikilink_by_bare_name_reaches_a_note_in_a_folder() {
    assert_eq!(
        sources(
            &[
                ("Projects/Roadmap.md", "# Roadmap\n"),
                ("Q3.md", "see [[Roadmap]]\n"),
            ],
            "Projects/Roadmap.md"
        ),
        vec!["Q3.md"]
    );
}

#[test]
fn a_wikilink_is_matched_case_insensitively() {
    assert_eq!(
        sources(
            &[
                ("Roadmap.md", "# Roadmap\n"),
                ("Q3.md", "see [[roadmap]]\n")
            ],
            "Roadmap.md"
        ),
        vec!["Q3.md"]
    );
}

#[test]
fn a_wikilink_reaches_a_note_by_its_frontmatter_alias() {
    assert_eq!(
        sources(
            &[
                ("Architecture.md", "---\naliases: [MB Architecture]\n---\n"),
                ("Q3.md", "see [[MB Architecture]]\n"),
            ],
            "Architecture.md"
        ),
        vec!["Q3.md"]
    );
}

#[test]
fn a_decomposed_filename_is_reached_by_a_composed_wikilink() {
    // What macOS does to every accented note name: the directory listing is NFD, the note
    // text is NFC, and a byte comparison makes the note unreachable through its own link.
    assert_eq!(
        sources(
            &[("Cafe\u{301}.md", "# Café\n"), ("Q3.md", "see [[Café]]\n"),],
            "Cafe\u{301}.md"
        ),
        vec!["Q3.md"]
    );
}

#[test]
fn a_colliding_name_resolves_to_the_nearest_note() {
    // §4.3: `[[Roadmap]]` in `Projects/Q3.md` means the Roadmap in `Projects/`.
    let notes = &[
        ("Archive/Roadmap.md", "# Old\n"),
        ("Projects/Roadmap.md", "# Current\n"),
        ("Projects/Q3.md", "see [[Roadmap]]\n"),
    ];
    assert_eq!(
        sources(notes, "Projects/Roadmap.md"),
        vec!["Projects/Q3.md"]
    );
    assert!(
        sources(notes, "Archive/Roadmap.md").is_empty(),
        "a link resolves to exactly one note, so the far one gets no backlink"
    );
}

#[test]
fn a_full_path_beats_a_nearer_bare_name() {
    // Writing the path is how a human disambiguates (§4.3), so it must win over nearness.
    let notes = &[
        ("Archive/Roadmap.md", "# Old\n"),
        ("Projects/Roadmap.md", "# Current\n"),
        ("Projects/Q3.md", "see [[Archive/Roadmap]]\n"),
    ];
    assert_eq!(sources(notes, "Archive/Roadmap.md"), vec!["Projects/Q3.md"]);
    assert!(sources(notes, "Projects/Roadmap.md").is_empty());
}

#[test]
fn equally_near_candidates_resolve_to_the_shallowest_then_alphabetically() {
    // Determinism matters more than which one wins: the answer must never depend on
    // filesystem or rowid order.
    let notes = &[
        ("b/Roadmap.md", "# B\n"),
        ("a/deep/Roadmap.md", "# Deep\n"),
        ("Roadmap.md", "# Root\n"),
        ("Q3.md", "see [[Roadmap]]\n"),
    ];
    assert_eq!(sources(notes, "Roadmap.md"), vec!["Q3.md"]);
    assert!(sources(notes, "b/Roadmap.md").is_empty());
}

#[test]
fn a_link_to_a_note_that_does_not_exist_produces_no_backlink_anywhere() {
    let mut index = indexed(&[("Q3.md", "see [[Nowhere]]\n")]);
    let access = viewer_everywhere("alice");
    let reader = index.reader(&access, &user("alice")).expect("reader");
    assert!(
        reader
            .backlinks("Nowhere.md")
            .expect("backlinks")
            .is_empty()
    );
    assert!(!reader.contains("Nowhere.md").expect("contains"));
}

#[test]
fn a_notes_own_self_link_appears_in_its_backlinks() {
    // It is a real inbound link and hiding it would be a special case with no reason.
    assert_eq!(sources(&[("A.md", "see [[A]]\n")], "A.md"), vec!["A.md"]);
}

#[test]
fn backlinks_from_one_note_are_grouped_and_ordered_by_document_position() {
    let mut index = indexed(&[
        ("Target.md", "# Target\n"),
        (
            "Source.md",
            "first [[Target]] mention\n\nsecond [[Target|alias]] mention ^s2\n",
        ),
    ]);
    let access = viewer_everywhere("alice");
    let reader = index.reader(&access, &user("alice")).expect("reader");
    let groups = reader.backlinks("Target.md").expect("backlinks");
    assert_eq!(groups.len(), 1, "two links from one note are one group");
    assert_eq!(groups[0].path, "Source.md");
    assert_eq!(groups[0].links.len(), 2);
    assert_eq!(
        groups[0].links[0].context.as_deref(),
        Some("first Target mention")
    );
    assert_eq!(
        groups[0].links[1].context.as_deref(),
        Some("second alias mention")
    );
    assert_eq!(groups[0].links[1].source_block.as_deref(), Some("s2"));
}

#[test]
fn groups_are_ordered_by_source_path() {
    assert_eq!(
        sources(
            &[
                ("Target.md", "# T\n"),
                ("zebra.md", "[[Target]]\n"),
                ("apple.md", "[[Target]]\n"),
            ],
            "Target.md"
        ),
        vec!["apple.md", "zebra.md"]
    );
}

#[test]
fn a_group_carries_the_source_notes_title() {
    let mut index = indexed(&[
        ("Target.md", "# T\n"),
        ("Source.md", "# The Source\n\n[[Target]]\n"),
    ]);
    let access = viewer_everywhere("alice");
    let reader = index.reader(&access, &user("alice")).expect("reader");
    let groups = reader.backlinks("Target.md").expect("backlinks");
    assert_eq!(groups[0].title.as_deref(), Some("The Source"));
}

#[test]
fn an_embed_is_distinguished_from_a_link_and_keeps_its_anchor() {
    let mut index = indexed(&[
        ("Target.md", "# T\n\n## Goals\n"),
        ("Source.md", "![[Target#Goals]] and [[Target#^b1]]\n"),
    ]);
    let access = viewer_everywhere("alice");
    let reader = index.reader(&access, &user("alice")).expect("reader");
    let links = &reader.backlinks("Target.md").expect("backlinks")[0].links;
    assert!(links[0].embed);
    assert_eq!(
        links[0].anchor,
        Some(mb_core::model::Anchor::Heading("Goals".to_string()))
    );
    assert!(!links[1].embed);
    assert_eq!(
        links[1].anchor,
        Some(mb_core::model::Anchor::Block("b1".to_string()))
    );
}

#[test]
fn a_link_keeps_the_spelling_the_source_file_used() {
    // What a rename has to rewrite (§6.6) is the text in the file, not the resolved path.
    let mut index = indexed(&[
        ("Projects/Target.md", "# T\n"),
        ("Source.md", "[[Target|see this]]\n"),
    ]);
    let access = viewer_everywhere("alice");
    let reader = index.reader(&access, &user("alice")).expect("reader");
    let links = &reader.backlinks("Projects/Target.md").expect("backlinks")[0].links;
    assert_eq!(links[0].target_raw, "Target");
}

#[test]
fn a_deleted_note_stops_being_a_backlink_source() {
    let mut index = indexed(&[("Target.md", "# T\n"), ("Source.md", "[[Target]]\n")]);
    index.remove("Source.md").expect("remove");
    let access = viewer_everywhere("alice");
    let reader = index.reader(&access, &user("alice")).expect("reader");
    assert!(reader.backlinks("Target.md").expect("backlinks").is_empty());
}

#[test]
fn a_renamed_note_keeps_receiving_links_written_to_its_new_name() {
    // Resolution happens at query time against names, so a note that appears later picks
    // up the links that were already pointing at its name — no relink pass, and a ghost
    // link is simply one with nothing to resolve to yet.
    let mut index = indexed(&[("Source.md", "[[Roadmap]]\n")]);
    let access = viewer_everywhere("alice");
    {
        let reader = index.reader(&access, &user("alice")).expect("reader");
        assert!(
            reader
                .backlinks("Roadmap.md")
                .expect("backlinks")
                .is_empty()
        );
    }
    index
        .upsert(&mb_index::NoteInput {
            path: "Roadmap.md".to_string(),
            markdown: "# Roadmap\n".to_string(),
            stamp: mb_index::Stamp::from_parts(1, 1),
        })
        .expect("upsert");
    let reader = index.reader(&access, &user("alice")).expect("reader");
    assert_eq!(
        reader
            .backlinks("Roadmap.md")
            .expect("backlinks")
            .into_iter()
            .map(|group| group.path)
            .collect::<Vec<_>>(),
        vec!["Source.md"]
    );
}
