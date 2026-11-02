//! Renaming a custom emoji rewrites shortcode spans and nothing else (`SPEC.md` §11.2).
//!
//! The same promise §6.6 makes for links: the rename runs over notes somebody else wrote,
//! including notes the owner renaming the emoji cannot read, so it may change the name
//! between the colons and no other byte. [`rebuilt`] proves that for each case.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

mod support;

use mb_core::rewrite::{Rewrite, RewriteError, rename_emoji, validate_emoji_name};
use mb_core::{Inline, model::BlockKind};
use proptest::prelude::*;

/// The rewritten text rebuilt from the source plus the reported spans.
fn rebuilt(source: &str, rewrite: &Rewrite, to: &str) -> String {
    let mut out = String::new();
    let mut cursor = 0usize;
    for span in rewrite.spans() {
        out.push_str(&source[cursor..span.start]);
        out.push_str(to);
        cursor = span.end;
    }
    out.push_str(&source[cursor..]);
    out
}

/// Asserts every reported span named `from` and nothing outside them changed.
fn assert_only_emoji_spans(source: &str, rewrite: &Rewrite, from: &str, to: &str) {
    for span in rewrite.spans() {
        let replaced = &source[span.start..span.end];
        assert!(
            replaced.eq_ignore_ascii_case(from),
            "replaced {replaced:?}, which is not the shortcode being renamed"
        );
    }
    assert_eq!(
        rebuilt(source, rewrite, to),
        rewrite.text(),
        "a byte outside a span changed"
    );
}

fn renamed(source: &str, from: &str, to: &str) -> String {
    let rewrite = rename_emoji(source, from, to).expect("verifies");
    assert_only_emoji_spans(source, &rewrite, from, to);
    rewrite.text().to_string()
}

#[test]
fn a_shortcode_in_prose_is_renamed() {
    assert_eq!(
        renamed("Party :parrot: time\n", "parrot", "bird"),
        "Party :bird: time\n"
    );
}

#[test]
fn every_occurrence_in_a_note_is_renamed_and_counted() {
    let rewrite = rename_emoji(":parrot: and :parrot:\n", "parrot", "bird").unwrap();
    assert_eq!(
        (rewrite.text(), rewrite.count()),
        (":bird: and :bird:\n", 2)
    );
}

#[test]
fn a_shortcode_is_matched_whatever_case_it_was_written_in() {
    assert_eq!(renamed("Hi :PaRRot:\n", "parrot", "bird"), "Hi :bird:\n");
}

#[test]
fn a_longer_shortcode_sharing_the_prefix_is_left_alone() {
    let source = ":parrotfish: and :parrot-2: stay\n";
    let rewrite = rename_emoji(source, "parrot", "bird").unwrap();
    assert!(!rewrite.changed());
    assert_eq!(rewrite.text(), source);
}

#[test]
fn a_note_with_no_reference_is_returned_byte_for_byte() {
    let source = "*  odd   bullets\n\n__strong__ :other:\n";
    let rewrite = rename_emoji(source, "parrot", "bird").unwrap();
    assert_eq!((rewrite.text(), rewrite.changed()), (source, false));
}

#[test]
fn a_non_canonical_note_keeps_every_other_byte() {
    let source = "*   item :parrot:\n+ other\n\n__bold__ text\n";
    assert_eq!(
        renamed(source, "parrot", "bird"),
        "*   item :bird:\n+ other\n\n__bold__ text\n"
    );
}

#[test]
fn a_shortcode_in_a_code_fence_is_text_and_stays_text() {
    let source = "```\n:parrot:\n```\n\n:parrot:\n";
    assert_eq!(
        renamed(source, "parrot", "bird"),
        "```\n:parrot:\n```\n\n:bird:\n"
    );
}

#[test]
fn a_shortcode_in_a_code_span_is_text_and_stays_text() {
    assert_eq!(
        renamed("`:parrot:` :parrot:\n", "parrot", "bird"),
        "`:parrot:` :bird:\n"
    );
}

#[test]
fn a_shortcode_in_inline_maths_is_text_and_stays_text() {
    assert_eq!(
        renamed("$a :parrot: b$ :parrot:\n", "parrot", "bird"),
        "$a :parrot: b$ :bird:\n"
    );
}

#[test]
fn an_escaped_colon_cancels_the_shortcode() {
    let source = "\\:parrot: literal\n";
    let rewrite = rename_emoji(source, "parrot", "bird").unwrap();
    assert_eq!(rewrite.text(), source);
}

#[test]
fn an_escaped_closing_colon_cancels_the_shortcode_without_refusing_the_note() {
    assert_eq!(
        renamed(":parrot\\: literal, :parrot: real\n", "parrot", "bird"),
        ":parrot\\: literal, :bird: real\n"
    );
}

#[test]
fn a_shortcode_inside_a_wikilink_target_is_part_of_the_name() {
    let source = "[[Standup :parrot: notes]]\n";
    let rewrite = rename_emoji(source, "parrot", "bird").unwrap();
    assert_eq!(rewrite.text(), source);
}

#[test]
fn a_shortcode_in_a_heading_a_callout_a_quote_a_table_and_a_list_is_reached() {
    let source = "# Title :parrot:\n\n> [!note] :parrot:\n> body :parrot:\n\n> quote :parrot:\n\n| a |\n| --- |\n| :parrot: |\n\n- item :parrot:\n";
    let out = renamed(source, "parrot", "bird");
    assert!(!out.contains(":parrot:"), "{out}");
    assert_eq!(out.matches(":bird:").count(), 6, "{out}");
}

#[test]
fn a_shortcode_inside_emphasis_and_link_text_is_reached() {
    assert_eq!(
        renamed(
            "*a :parrot:* [x :parrot:](https://e.test)\n",
            "parrot",
            "bird"
        ),
        "*a :bird:* [x :bird:](https://e.test)\n"
    );
}

#[test]
fn a_frontmatter_icon_is_renamed_quoted_or_not() {
    for (source, expected) in [
        (
            "---\nicon: \":parrot:\"\n---\n\nBody\n",
            "---\nicon: \":bird:\"\n---\n\nBody\n",
        ),
        (
            "---\nicon: ':parrot:'\n---\n\nBody\n",
            "---\nicon: ':bird:'\n---\n\nBody\n",
        ),
        (
            "---\nicon: :parrot:\n---\n\nBody\n",
            "---\nicon: :bird:\n---\n\nBody\n",
        ),
    ] {
        assert_eq!(renamed(source, "parrot", "bird"), expected, "{source}");
    }
}

#[test]
fn a_frontmatter_key_that_is_not_icon_is_left_alone() {
    let source = "---\nsummary: \":parrot:\"\n---\n\n:parrot:\n";
    assert_eq!(
        renamed(source, "parrot", "bird"),
        "---\nsummary: \":parrot:\"\n---\n\n:bird:\n"
    );
}

#[test]
fn unicode_rtl_and_emoji_around_the_shortcode_survive() {
    let source = "שלום :parrot: 🎉 café\n";
    assert_eq!(renamed(source, "parrot", "bird"), "שלום :bird: 🎉 café\n");
}

#[test]
fn surrounding_colons_on_either_name_are_accepted() {
    let rewrite = rename_emoji(":parrot:\n", ":parrot:", ":bird:").unwrap();
    assert_eq!(rewrite.text(), ":bird:\n");
}

#[test]
fn a_new_name_that_is_not_a_stored_shortcode_is_refused() {
    for bad in ["", "Bird", "two words", "a:b", "ünï", "a/b", "a]"] {
        assert_eq!(
            rename_emoji(":parrot:\n", "parrot", bad),
            Err(RewriteError::InvalidEmoji(
                bad.trim_matches(':').to_string()
            )),
            "{bad:?}"
        );
    }
}

#[test]
fn validate_emoji_name_accepts_the_manifest_alphabet() {
    for good in ["bird", "a_b", "a+b", "a-b", "123"] {
        assert!(validate_emoji_name(good).is_ok(), "{good}");
    }
}

/// Every custom emoji name a generated document carries.
fn emoji_names(doc: &mb_core::Document) -> Vec<String> {
    fn inlines(items: &[Inline], out: &mut Vec<String>) {
        for item in items {
            match item {
                Inline::Emoji(name) => out.push(name.clone()),
                Inline::Emphasis(content)
                | Inline::Strong(content)
                | Inline::Strikethrough(content)
                | Inline::Highlight(content)
                | Inline::MbStyle { content, .. }
                | Inline::Link { content, .. } => inlines(content, out),
                _ => {}
            }
        }
    }
    fn blocks(items: &[mb_core::Block], out: &mut Vec<String>) {
        for block in items {
            match &block.kind {
                BlockKind::Paragraph(content) | BlockKind::Heading { content, .. } => {
                    inlines(content, out);
                }
                BlockKind::List(list) => {
                    for item in &list.items {
                        blocks(&item.content, out);
                    }
                }
                BlockKind::Blockquote(inner) => blocks(inner, out),
                BlockKind::Callout(callout) => {
                    inlines(&callout.title, out);
                    blocks(&callout.content, out);
                }
                BlockKind::Table(table) => {
                    for cell in table.head.iter().chain(table.rows.iter().flatten()) {
                        inlines(cell, out);
                    }
                }
                _ => {}
            }
        }
    }
    let mut out = Vec::new();
    blocks(&doc.blocks, &mut out);
    out
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 256, ..ProptestConfig::default() })]

    /// Renaming an emoji a canonical note really uses always verifies, and only its spans
    /// change. A refusal on an ordinary note would make the feature useless.
    #[test]
    fn renaming_an_emoji_in_a_generated_note_verifies_within_its_spans(
        doc in support::document(),
        to in "[a-z][a-z0-9_]{1,8}z",
    ) {
        let source = mb_core::to_markdown(&doc);
        let Some(from) = emoji_names(&mb_core::parse(&source)).into_iter().next() else {
            return Ok(());
        };
        let rewrite = rename_emoji(&source, &from, &to);
        prop_assert!(rewrite.is_ok(), "refused\n--- source ---\n{}", source);
        let rewrite = rewrite.unwrap();
        prop_assert!(rewrite.changed());
        prop_assert_eq!(rebuilt(&source, &rewrite, &to), rewrite.text().to_string());
    }

    /// Renaming to a fresh name and back is the identity.
    #[test]
    fn renaming_an_emoji_there_and_back_restores_the_note(doc in support::document()) {
        let source = mb_core::to_markdown(&doc);
        let Some(from) = emoji_names(&mb_core::parse(&source)).into_iter().next() else {
            return Ok(());
        };
        let there = rename_emoji(&source, &from, "zz-fresh-zz").expect("verifies");
        let back = rename_emoji(there.text(), "zz-fresh-zz", &from).expect("verifies back");
        prop_assert_eq!(back.text(), &source);
    }

    /// Total over arbitrary input: never panics, and either refuses or confines its edits.
    #[test]
    fn any_string_is_either_renamed_within_its_spans_or_refused(input in ".{0,400}") {
        if let Ok(rewrite) = rename_emoji(&input, "a", "zzz") {
            prop_assert_eq!(rebuilt(&input, &rewrite, "zzz"), rewrite.text().to_string());
        }
    }

    /// The scanner's colon form is exercised directly with shortcode-heavy prose.
    #[test]
    fn shortcode_heavy_prose_is_renamed_within_its_spans_or_refused(
        input in "([a-c:` $\\\\#\\[\\]]|parrot|\\n){0,60}",
    ) {
        if let Ok(rewrite) = rename_emoji(&input, "parrot", "bird") {
            prop_assert_eq!(rebuilt(&input, &rewrite, "bird"), rewrite.text().to_string());
        }
    }
}
