//! What a transclusion reference names (`SPEC.md` §9.2, §22.7).
//!
//! §22.7 requires the transclusion suite to cover cycles, self-reference, depth limits,
//! missing targets, unreadable targets and deep nesting. Those five are properties of
//! *recursion* and *permissions*, so they live where those are: the resolution stack in
//! `web/src/editor/embed.test.ts`, the permission cases in `mb-server/tests/leak_suite.rs`.
//! What lives here is the slice — which blocks a reference stands for — because that is the
//! part of §9.2 that is a pure function of a document.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

mod support;

use mb_core::model::{Anchor, Block, BlockKind};
use mb_core::transclude::slice;
use proptest::prelude::*;

/// The Markdown of a slice, so a test asserts content rather than block structure.
fn sliced(markdown: &str, anchor: Option<&Anchor>) -> Option<String> {
    let doc = mb_core::parse(markdown);
    let blocks = slice(&doc, anchor)?;
    Some(mb_core::to_markdown(&mb_core::model::Document::new(blocks)))
}

const NOTE: &str = "\
Intro paragraph.

# One

under one

## One A

under one a

# Two

under two
";

#[test]
fn no_anchor_transcludes_the_whole_note() {
    let doc = mb_core::parse(NOTE);
    assert_eq!(slice(&doc, None).unwrap(), doc.blocks);
}

#[test]
fn a_heading_section_stops_at_the_next_heading_of_equal_level() {
    let section = sliced(NOTE, Some(&Anchor::Heading("One".into()))).unwrap();
    assert_eq!(section, "# One\n\nunder one\n\n## One A\n\nunder one a\n");
}

#[test]
fn a_heading_section_includes_its_own_heading() {
    let section = sliced(NOTE, Some(&Anchor::Heading("Two".into()))).unwrap();
    assert_eq!(section, "# Two\n\nunder two\n");
}

#[test]
fn a_subsection_stops_at_the_next_heading_of_higher_level() {
    let section = sliced(NOTE, Some(&Anchor::Heading("One A".into()))).unwrap();
    assert_eq!(
        section, "## One A\n\nunder one a\n",
        "`# Two` is higher than `## One A`, so it ends the subsection"
    );
}

#[test]
fn the_last_section_runs_to_the_end_of_the_note() {
    let section = sliced(
        "text\n\n# Last\n\na\n\nb\n",
        Some(&Anchor::Heading("Last".into())),
    );
    assert_eq!(section.unwrap(), "# Last\n\na\n\nb\n");
}

#[test]
fn a_heading_matches_case_insensitively() {
    assert_eq!(
        sliced(NOTE, Some(&Anchor::Heading("  oNe a ".into()))),
        sliced(NOTE, Some(&Anchor::Heading("One A".into()))),
    );
}

#[test]
fn a_heading_matches_across_unicode_composition() {
    // "Cafe\u{301}" is what a decomposing filesystem or keyboard hands over for "Café".
    let doc = "# Caf\u{e9}\n\nespresso\n";
    assert_eq!(
        sliced(doc, Some(&Anchor::Heading("Cafe\u{301}".into()))).unwrap(),
        "# Caf\u{e9}\n\nespresso\n"
    );
}

#[test]
fn a_heading_matches_on_its_visible_text_not_its_markup() {
    let doc = "# The **plan**\n\nbody\n";
    assert_eq!(
        sliced(doc, Some(&Anchor::Heading("The plan".into()))).unwrap(),
        "# The **plan**\n\nbody\n",
        "a wikilink anchor is written as the heading reads, not as it is marked up"
    );
}

#[test]
fn an_absent_heading_names_nothing() {
    assert!(sliced(NOTE, Some(&Anchor::Heading("Three".into()))).is_none());
}

#[test]
fn an_empty_section_is_the_heading_alone() {
    let section = sliced(
        "# Empty\n\n# Next\n",
        Some(&Anchor::Heading("Empty".into())),
    );
    assert_eq!(
        section.unwrap(),
        "# Empty\n",
        "a heading with nothing under it is a section, not a missing one"
    );
}

#[test]
fn a_heading_inside_a_blockquote_is_not_a_section_of_this_note() {
    let doc = "> # Quoted\n>\n> inside\n\nafter\n";
    assert!(
        sliced(doc, Some(&Anchor::Heading("Quoted".into()))).is_none(),
        "\"everything until the next heading\" has no meaning inside a block that ends first"
    );
}

#[test]
fn the_first_of_two_identical_headings_wins() {
    let doc = "# Same\n\nfirst\n\n# Same\n\nsecond\n";
    assert_eq!(
        sliced(doc, Some(&Anchor::Heading("Same".into()))).unwrap(),
        "# Same\n\nfirst\n"
    );
}

#[test]
fn a_block_anchor_names_exactly_its_block() {
    let doc = "one\n\ntwo ^target\n\nthree\n";
    assert_eq!(
        sliced(doc, Some(&Anchor::Block("target".into()))).unwrap(),
        "two ^target\n"
    );
}

#[test]
fn an_absent_block_anchor_names_nothing() {
    assert!(sliced("plain\n", Some(&Anchor::Block("nope".into()))).is_none());
}

#[test]
fn a_block_anchor_is_matched_exactly() {
    let doc = "text ^Target\n";
    assert!(
        sliced(doc, Some(&Anchor::Block("target".into()))).is_none(),
        "a block id is an identifier, not prose: folding it would make two ids one"
    );
}

#[test]
fn a_block_anchor_inside_a_callout_is_found() {
    let doc = "> [!note] Title\n> body ^inner\n\nafter\n";
    let found = sliced(doc, Some(&Anchor::Block("inner".into()))).unwrap();
    assert_eq!(found.trim(), "body ^inner");
}

#[test]
fn a_block_anchor_inside_a_list_item_is_found() {
    let doc = "- first\n- second ^pick\n";
    let found = sliced(doc, Some(&Anchor::Block("pick".into()))).unwrap();
    assert_eq!(found.trim(), "second ^pick");
}

#[test]
fn a_block_anchor_inside_a_blockquote_is_found() {
    let doc = "> quoted ^deep\n";
    let found = sliced(doc, Some(&Anchor::Block("deep".into()))).unwrap();
    assert_eq!(found.trim(), "quoted ^deep");
}

#[test]
fn a_repeated_block_anchor_resolves_to_the_first_one() {
    // Pre-order, which is also the order `extract` records anchors in, so an embed and the
    // index agree about which block a duplicated `^block-id` is. A duplicate is a malformed
    // note rather than a modelled state; agreeing is what matters.
    let doc = "first ^dup\n\nsecond ^dup\n";
    assert_eq!(
        sliced(doc, Some(&Anchor::Block("dup".into()))).unwrap(),
        "first ^dup\n"
    );
}

#[test]
fn only_a_paragraph_or_heading_can_be_the_block_a_reference_names() {
    // v1 recognises `^block-id` on paragraphs and headings only (`parse::finish_text_block`),
    // so a search for one never has to decide between a container and its child. This test
    // is what says so: if a container ever starts carrying an anchor, the pre-order search
    // above becomes a decision rather than a fact, and this goes red first.
    let doc = mb_core::parse("> [!note] T\n>\n> body ^b\n\n- item ^i\n\n> quoted ^q\n");
    let mut anchored = Vec::new();
    fn walk(blocks: &[Block], out: &mut Vec<(bool, String)>) {
        for block in blocks {
            if let Some(anchor) = &block.anchor {
                let text_block = matches!(
                    block.kind,
                    BlockKind::Paragraph(_) | BlockKind::Heading { .. }
                );
                out.push((text_block, anchor.clone()));
            }
            match &block.kind {
                BlockKind::Blockquote(inner) => walk(inner, out),
                BlockKind::Callout(callout) => walk(&callout.content, out),
                BlockKind::List(list) => {
                    for item in &list.items {
                        walk(&item.content, out);
                    }
                }
                _ => {}
            }
        }
    }
    walk(&doc.blocks, &mut anchored);
    assert_eq!(anchored.len(), 3, "three anchors, one per nesting shape");
    for (text_block, anchor) in anchored {
        assert!(text_block, "^{anchor} is on a container block");
    }
}

#[test]
fn slicing_an_empty_note_by_nothing_is_empty() {
    let doc = mb_core::parse("");
    assert_eq!(slice(&doc, None).unwrap(), Vec::<Block>::new());
}

fn heading_texts(blocks: &[Block]) -> Vec<(u8, String)> {
    blocks
        .iter()
        .filter_map(|block| match &block.kind {
            BlockKind::Heading { level, content } => {
                Some((level.get(), mb_core::extract::plain_text(content)))
            }
            _ => None,
        })
        .collect()
}

proptest! {
    /// Every heading in any document is sliceable, and the slice starts with it.
    #[test]
    fn every_heading_names_a_section_beginning_with_itself(doc in support::document()) {
        for (_, text) in heading_texts(&doc.blocks) {
            let anchor = Anchor::Heading(text.clone());
            let section = slice(&doc, Some(&anchor));
            prop_assert!(section.is_some(), "heading {text:?} named nothing");
            let section = section.unwrap_or_default();
            prop_assert!(!section.is_empty());
            let heads_the_section = matches!(section[0].kind, BlockKind::Heading { .. });
            prop_assert!(heads_the_section, "a section does not begin with its heading");
        }
    }

    /// §9.2's rule, as an invariant: nothing inside a section outranks its heading.
    #[test]
    fn a_section_contains_no_heading_of_equal_or_higher_level(doc in support::document()) {
        for (level, text) in heading_texts(&doc.blocks) {
            let section = slice(&doc, Some(&Anchor::Heading(text))).unwrap_or_default();
            for (inner, _) in heading_texts(section.get(1..).unwrap_or_default()) {
                prop_assert!(
                    inner > level,
                    "a level {inner} heading is inside a level {level} section"
                );
            }
        }
    }

    /// A section is a contiguous run of the note, not a filtered copy of it.
    #[test]
    fn a_section_is_a_contiguous_run_of_the_document(doc in support::document()) {
        for (_, text) in heading_texts(&doc.blocks) {
            let section = slice(&doc, Some(&Anchor::Heading(text))).unwrap_or_default();
            prop_assert!(
                doc.blocks.windows(section.len()).any(|window| window == section.as_slice()),
                "the slice is not a window into the document"
            );
        }
    }

    /// Slicing a section again by the same heading changes nothing.
    #[test]
    fn slicing_a_section_by_its_own_heading_is_idempotent(doc in support::document()) {
        for (_, text) in heading_texts(&doc.blocks) {
            let anchor = Anchor::Heading(text);
            let once = slice(&doc, Some(&anchor)).unwrap_or_default();
            let twice = slice(
                &mb_core::model::Document::new(once.clone()),
                Some(&anchor),
            );
            prop_assert_eq!(twice.unwrap_or_default(), once);
        }
    }

    /// No anchor at all is the document, for any document.
    #[test]
    fn the_whole_note_is_the_slice_with_no_anchor(doc in support::document()) {
        prop_assert_eq!(slice(&doc, None).unwrap_or_default(), doc.blocks.clone());
    }

    /// An arbitrary anchor never panics and never invents a block.
    #[test]
    fn an_arbitrary_anchor_is_either_a_run_of_the_note_or_nothing(
        doc in support::document(),
        raw in "[^\n]{0,12}",
    ) {
        for anchor in [Anchor::Heading(raw.clone()), Anchor::Block(raw.clone())] {
            if let Some(found) = slice(&doc, Some(&anchor)) {
                prop_assert!(!found.is_empty(), "a named slice is never empty");
            }
        }
    }
}
