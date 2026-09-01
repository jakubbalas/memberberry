//! What the index is built from (`SPEC.md` §9.1).
//!
//! `mb-index` writes these rows into SQLite and the client search index is derived from
//! them, so anything missed here is a note that cannot be found, a backlink that never
//! appears, or a task absent from a task view. The floor in `AGENTS.md` §2.1 is 95% for
//! this crate, and extraction is the part of it with the most branches per line.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use mb_core::extract::{plain_text, title};
use mb_core::model::{Block, BlockKind, Document, HeadingLevel, Inline, WikiLink};
use mb_core::task::{Date, Priority, TaskStatus};
use mb_core::{extract, parse};

fn ex(md: &str) -> mb_core::Extracted {
    extract(&parse(md))
}

// ---------------------------------------------------------------- frontmatter

#[test]
fn a_frontmatter_icon_shortcode_is_indexed_as_emoji() {
    // The icon drives the note's glyph in the sidebar and the graph, so it has to reach the
    // index like any inline `:shortcode:` does.
    assert_eq!(
        ex("---\nicon: :rocket:\n---\n\nbody\n").emoji,
        vec!["rocket"]
    );
}

#[test]
fn a_frontmatter_icon_that_is_not_a_shortcode_is_not_indexed() {
    // A literal glyph is stored as itself (§11.3) and names no custom emoji.
    assert!(ex("---\nicon: 🚀\n---\n\nbody\n").emoji.is_empty());
    assert!(ex("---\nicon: rocket\n---\n\nbody\n").emoji.is_empty());
}

#[test]
fn frontmatter_and_inline_tags_are_unified_without_duplicates() {
    // §9.3: one tag namespace. A tag written in both places is still one tag.
    let e = ex("---\ntags: [alpha, beta]\n---\n\ntext #beta #gamma\n");
    assert_eq!(e.tags, vec!["alpha", "beta", "gamma"]);
}

// ---------------------------------------------------------------- tasks

#[test]
fn a_task_is_indexed_with_its_text_and_metadata() {
    let e = ex("- [ ] ship it 📅 2026-09-05 ⏫\n");
    assert_eq!(e.tasks.len(), 1);
    let t = &e.tasks[0];
    assert_eq!(t.text, "ship it");
    assert_eq!(t.task.status, TaskStatus::Todo);
    assert_eq!(t.task.meta.due, Date::new(2026, 9, 5));
    assert_eq!(t.task.meta.priority, Some(Priority::High));
    assert_eq!(t.anchor, None);
}

#[test]
fn a_task_carries_its_block_anchor_so_a_task_view_can_link_back() {
    let e = ex("- [x] done ^task-1\n");
    assert_eq!(e.tasks[0].anchor.as_deref(), Some("task-1"));
    assert_eq!(e.tasks[0].task.status, TaskStatus::Done);
    assert_eq!(e.anchors, vec!["task-1"]);
}

#[test]
fn an_empty_task_is_still_indexed_with_empty_text() {
    // Regression: empty tasks used to lose their checkbox entirely, so they never reached
    // the index at all. See `an_empty_task_keeps_its_checkbox` in markdown.rs.
    let e = ex("- [ ]\n");
    assert_eq!(e.tasks.len(), 1);
    assert_eq!(e.tasks[0].text, "");
}

#[test]
fn a_task_opening_with_a_code_block_is_not_indexed_as_a_task() {
    // A consequence of the canonical rule, not an oversight: a checkbox has to sit on the
    // item's first line, so an item that opens with a fence cannot carry one and the marker
    // is dropped rather than written somewhere it would not read back. See
    // `a_task_marker_is_dropped_only_when_it_cannot_be_rendered` in markdown.rs.
    let e = ex("- [ ] \n  ```\n  code\n  ```\n");
    assert!(e.tasks.is_empty());
    assert_eq!(e.word_count, 1, "the code is still indexed as content");
}

#[test]
fn tasks_nested_in_sub_lists_are_indexed() {
    let e = ex("- outer\n  - [ ] inner\n");
    assert_eq!(e.tasks.len(), 1);
    assert_eq!(e.tasks[0].text, "inner");
}

#[test]
fn a_plain_list_item_produces_no_task() {
    assert!(ex("- just a bullet\n").tasks.is_empty());
}

// ---------------------------------------------------------------- plain_text

#[test]
fn plain_text_reads_through_every_inline_kind() {
    // Every arm, because this is what search indexes and what a task view displays: an arm
    // that returns nothing is a word the user cannot search for.
    let content = vec![
        Inline::Text("a ".into()),
        Inline::Code("code".into()),
        Inline::Text(" ".into()),
        Inline::Math("x^2".into()),
        Inline::Text(" ".into()),
        Inline::Emphasis(vec![Inline::Text("em".into())]),
        Inline::Strong(vec![Inline::Text("strong".into())]),
        Inline::Strikethrough(vec![Inline::Text("strike".into())]),
        Inline::Highlight(vec![Inline::Text("mark".into())]),
        Inline::Link {
            dest: "https://example.com".into(),
            title: None,
            content: vec![Inline::Text("link".into())],
        },
        Inline::Image {
            dest: "media/x.png".into(),
            alt: "alt".into(),
        },
        Inline::Tag("tag".into()),
        Inline::Emoji("smile".into()),
        Inline::FootnoteRef("1".into()),
        Inline::SoftBreak,
        Inline::Text("after".into()),
    ];
    assert_eq!(
        plain_text(&content),
        "a code x^2 emstrongstrikemarklinkalt#tag:smile: after"
    );
}

#[test]
fn plain_text_uses_a_wikilink_alias_when_there_is_one() {
    // The alias is what the reader sees, so it is what search should match.
    let aliased = Inline::WikiLink(WikiLink {
        target: "Target Note".into(),
        anchor: None,
        alias: Some("shown".into()),
        embed: false,
    });
    let bare = Inline::WikiLink(WikiLink {
        target: "Target Note".into(),
        anchor: None,
        alias: None,
        embed: false,
    });
    assert_eq!(plain_text(&[aliased]), "shown");
    assert_eq!(plain_text(&[bare]), "Target Note");
}

#[test]
fn plain_text_turns_a_hard_break_into_a_space() {
    assert_eq!(
        plain_text(&[
            Inline::Text("a".into()),
            Inline::HardBreak,
            Inline::Text("b".into())
        ]),
        "a b"
    );
}

// ---------------------------------------------------------------- title

#[test]
fn the_title_is_the_first_h1_even_when_a_lower_heading_comes_first() {
    let doc = parse("## sub\n\n# Real Title\n\n# Later H1\n");
    assert_eq!(title(&doc).as_deref(), Some("Real Title"));
}

#[test]
fn the_title_falls_back_to_the_first_heading_of_any_level() {
    assert_eq!(
        title(&parse("### only sub\n\ntext\n")).as_deref(),
        Some("only sub")
    );
}

#[test]
fn the_title_falls_back_to_the_opening_paragraph() {
    // A soft break inside a paragraph reads as a space, so the whole paragraph is one line
    // and becomes the title. Worth knowing before the note list exists: a note that opens
    // with a long untitled paragraph gets a long title, and wants truncating at the UI.
    assert_eq!(
        title(&parse("first line\nsecond line\n\nlater\n")).as_deref(),
        Some("first line second line")
    );
    assert_eq!(
        title(&parse("single\n\nlater\n")).as_deref(),
        Some("single")
    );
}

#[test]
fn a_blank_paragraph_does_not_become_the_title() {
    // A paragraph that renders as nothing would give the note an empty name in the sidebar.
    assert_eq!(
        title(&parse("![](media/x.png)\n\n# Heading\n")).as_deref(),
        Some("Heading")
    );
}

#[test]
fn a_note_with_nothing_titleable_has_no_title() {
    assert_eq!(title(&Document::default()), None);
    assert_eq!(title(&parse("***\n")), None);
    assert_eq!(title(&parse("```\ncode\n```\n")), None);
}

#[test]
fn a_heading_title_reads_through_its_formatting() {
    let doc = parse("# A **bold** [[Note|link]] :tada:\n");
    assert_eq!(title(&doc).as_deref(), Some("A bold link :tada:"));
}

#[test]
fn an_empty_h1_yields_an_empty_title_rather_than_falling_through() {
    // why: `#` alone is still an explicit H1. Falling through to the next paragraph would
    // silently name the note after body text the user did not choose.
    let doc = Document::new(vec![Block::new(BlockKind::Heading {
        level: HeadingLevel::H1,
        content: vec![],
    })]);
    assert_eq!(title(&doc).as_deref(), Some(""));
}

// ---------------------------------------------------------------- structure

#[test]
fn headings_are_indexed_with_their_level() {
    let e = ex("# One\n\n### Three\n");
    assert_eq!(
        e.headings,
        vec![(1, "One".to_string()), (3, "Three".to_string())]
    );
}

#[test]
fn extraction_reaches_inside_blockquotes_callouts_and_tables() {
    let e = ex(concat!(
        "> quoted [[A]]\n\n",
        "> [!note] Title [[B]]\n> body [[C]]\n\n",
        "| [[D]] |\n| --- |\n| [[E]] |\n",
    ));
    let targets: Vec<&str> = e.links.iter().map(|l| l.target.as_str()).collect();
    assert_eq!(targets, vec!["A", "B", "C", "D", "E"]);
}

#[test]
fn media_destinations_are_collected_from_images_and_links() {
    let e = ex("![x](media/ab/cd/h.png)\n\n[file](media/ab/cd/doc.pdf)\n");
    assert_eq!(e.media, vec!["media/ab/cd/h.png", "media/ab/cd/doc.pdf"]);
}

#[test]
fn code_block_words_are_counted() {
    // Code is prose for word-count purposes; a note that is mostly code is not empty.
    assert_eq!(ex("```rust\nfn main() {}\n```\n").word_count, 3);
}

#[test]
fn a_math_block_and_a_divider_contribute_nothing() {
    let e = ex("$$\nx = 1\n$$\n\n***\n");
    assert_eq!(e.word_count, 0);
    assert!(e.links.is_empty() && e.tags.is_empty() && e.anchors.is_empty());
}

#[test]
fn an_embed_is_flagged_and_anchors_are_kept() {
    let e = ex("![[Note#^block-id]] and [[Other#Heading|alias]]\n");
    assert_eq!(e.links.len(), 2);
    assert!(e.links[0].embed);
    assert!(!e.links[1].embed);
    assert_eq!(e.links[1].alias.as_deref(), Some("alias"));
}
