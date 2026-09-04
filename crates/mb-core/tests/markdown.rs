//! Behavioural tests for the documented Markdown contract.
//!
//! These pin down the *decisions* in `SPEC.md` §4.4 and §4.5, including the places where a
//! deliberate limitation exists. A test that documents a limitation is not an excuse for it:
//! it is how the limitation stays visible and stops being rediscovered as a bug.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use mb_core::model::{
    Alignment, Anchor, Block, BlockKind, Document, HeadingLevel, Inline, List, ListItem, Table,
};
use mb_core::task::{Date, Priority, Task, TaskMeta, TaskStatus};
use mb_core::{normalize, parse, to_markdown};

fn first_kind(md: &str) -> BlockKind {
    parse(md)
        .blocks
        .into_iter()
        .next()
        .expect("expected at least one block")
        .kind
}

fn para(md: &str) -> Vec<Inline> {
    match first_kind(md) {
        BlockKind::Paragraph(c) => c,
        other => panic!("expected a paragraph, got {other:?}"),
    }
}

#[test]
fn canonicalises_bullet_and_emphasis_markers() {
    // `*` and `+` are different markers, so CommonMark reads two lists — but the canonical
    // form writes `-` for both, which would merge them anyway. Merging up front is what makes
    // the result stable (see `canonical::merge_adjacent_lists`).
    assert_eq!(normalize("* one\n+ two\n"), "- one\n- two\n");
    assert_eq!(normalize("__bold__\n"), "**bold**\n");
    assert_eq!(normalize("Heading\n=======\n"), "# Heading\n");
}

#[test]
fn normalisation_converges_in_one_pass() {
    let messy = "Heading\n===\n\n*  loose   item\n\n__b__ and _i_\n";
    let once = normalize(messy);
    assert_eq!(once, normalize(&once), "normalisation must be idempotent");
}

#[test]
fn wikilinks_carry_anchors_and_aliases() {
    let inlines = para("See [[Note#Heading|alias]] and ![[Other#^block-id]].\n");
    let links: Vec<_> = inlines
        .iter()
        .filter_map(|i| match i {
            Inline::WikiLink(w) => Some(w),
            _ => None,
        })
        .collect();
    assert_eq!(links.len(), 2);
    assert_eq!(links[0].target, "Note");
    assert_eq!(links[0].anchor, Some(Anchor::Heading("Heading".into())));
    assert_eq!(links[0].alias.as_deref(), Some("alias"));
    assert!(!links[0].embed);
    assert_eq!(links[1].anchor, Some(Anchor::Block("block-id".into())));
    assert!(links[1].embed, "`![[…]]` is an embed");
}

#[test]
fn escaped_syntax_stays_literal_through_a_round_trip() {
    // The escaper and the scanner share their predicates precisely so this holds.
    for input in [
        "\\#nottag\n",
        "\\:notshortcode:\n",
        "\\[\\[not a link\\]\\]\n",
    ] {
        let doc = parse(input);
        let out = to_markdown(&doc);
        assert_eq!(
            parse(&out).blocks,
            doc.blocks,
            "escaped literal changed for {input:?}"
        );
    }
}

#[test]
fn tag_is_not_a_number() {
    assert!(matches!(
        para("#1 is not a tag\n").first(),
        Some(Inline::Text(_))
    ));
    assert!(matches!(para("#a1 is a tag\n").first(), Some(Inline::Tag(t)) if t == "a1"));
    assert!(matches!(para("#a/b/c nested\n").first(), Some(Inline::Tag(t)) if t == "a/b/c"));
}

#[test]
fn callouts_carry_kind_fold_and_title() {
    match first_kind("> [!warning]- Careful\n>\n> body\n") {
        BlockKind::Callout(c) => {
            assert_eq!(c.kind, "warning");
            assert_eq!(c.fold, mb_core::model::Fold::Collapsed);
            assert_eq!(mb_core::extract::plain_text(&c.title), "Careful");
            assert_eq!(c.content.len(), 1);
        }
        other => panic!("expected a callout, got {other:?}"),
    }
}

#[test]
fn an_escaped_callout_marker_stays_a_blockquote() {
    // Distinguishing these two needs the source, not just the resolved text.
    assert!(matches!(
        first_kind("> \\[!note\\] hi\n"),
        BlockKind::Blockquote(_)
    ));
    assert!(matches!(
        first_kind("> [!note] hi\n"),
        BlockKind::Callout(_)
    ));
}

#[test]
fn task_metadata_parses_and_round_trips() {
    let md = "- [ ] Write tests ➕ 2026-08-28 🛫 2026-09-01 📅 2026-09-05 ⏫\n";
    let doc = parse(md);
    let extracted = mb_core::extract(&doc);
    let task = &extracted.tasks[0];
    assert_eq!(task.task.status, TaskStatus::Todo);
    assert_eq!(task.task.meta.due, Date::new(2026, 9, 5));
    assert_eq!(task.task.meta.start, Date::new(2026, 9, 1));
    assert_eq!(task.task.meta.priority, Some(Priority::High));
    assert_eq!(task.text, "Write tests");
    assert_eq!(
        to_markdown(&doc),
        md,
        "metadata must re-emit in canonical order"
    );
}

#[test]
fn unknown_task_metadata_is_preserved_verbatim() {
    // Recurrence is deferred (SPEC §10.4) but must never be destroyed.
    let md = "- [ ] Water plants 🔁 every week 📅 2026-09-05\n";
    let doc = parse(md);
    let meta = &mb_core::extract(&doc).tasks[0].task.meta;
    assert_eq!(meta.due, Date::new(2026, 9, 5));
    assert_eq!(meta.unknown, vec!["🔁 every week".to_string()]);
    assert!(to_markdown(&doc).contains("🔁 every week"));
}

#[test]
fn a_date_marker_without_a_date_is_ordinary_prose() {
    let doc = parse("- [ ] call me 📅 sometime\n");
    let task = &mb_core::extract(&doc).tasks[0];
    assert_eq!(task.task.meta.due, None);
    assert_eq!(task.text, "call me 📅 sometime");
}

#[test]
fn invalid_dates_are_rejected() {
    assert!(Date::parse("2026-02-30").is_none(), "February has no 30th");
    assert!(
        Date::parse("2025-02-29").is_none(),
        "2025 is not a leap year"
    );
    assert!(Date::parse("2024-02-29").is_some(), "2024 is a leap year");
    assert!(Date::parse("2026-13-01").is_none());
    assert!(
        Date::parse("26-01-01").is_none(),
        "the year must be four digits"
    );
}

#[test]
fn code_block_content_is_preserved_byte_for_byte() {
    // Trailing whitespace inside a fence is content, not formatting.
    let md = "```\nline with trailing   \n\ttabbed\n```\n";
    assert_eq!(normalize(md), md);
}

#[test]
fn a_leading_divider_does_not_masquerade_as_frontmatter() {
    // A file opening `---` … `---` really is frontmatter, so the ambiguity has to be resolved
    // on the way *out*: a document whose first block is a divider must not render a bare
    // `---` first, or reading it back would swallow the document into a frontmatter fence.
    let doc = parse("***\n\n---\n");
    assert_eq!(doc.blocks.len(), 2, "two thematic breaks");
    let out = to_markdown(&doc);
    assert_eq!(
        out, "***\n\n***\n",
        "dividers render as `***` (see serialize::block)"
    );
    assert_eq!(
        parse(&out).blocks.len(),
        2,
        "must not be re-read as frontmatter"
    );

    // `- ---` is itself a thematic break — four dashes separated by a space — not a list.
    assert_eq!(normalize("- ---\n"), "***\n");

    // Which is exactly why a divider *inside* a list item cannot be written `---`.
    let nested = parse("- ***\n");
    assert_eq!(to_markdown(&nested), "- ***\n");
    assert_eq!(parse(&to_markdown(&nested)).blocks, nested.blocks);
}

#[test]
fn frontmatter_round_trips_in_canonical_key_order() {
    let md = "---\nicon: 🧠\ntags: [b, a]\nid: 018f2c4e\nzz: last\n---\n\nBody\n";
    let out = normalize(md);
    let keys: Vec<&str> = out.lines().skip(1).take_while(|l| *l != "---").collect();
    assert_eq!(
        keys,
        vec!["id: 018f2c4e", "tags: [b, a]", "icon: 🧠", "zz: last"]
    );
    assert_eq!(out, normalize(&out));
}

#[test]
fn math_survives_inside_containers() {
    // pulldown-cmark's own math extension drops every block after a `$$` fence in a list,
    // which is why math is parsed here instead. This is the regression test for that.
    let md = "- $$\n  x = 1\n  $$\n\n  after\n";
    let doc = parse(md);
    let BlockKind::List(list) = &doc.blocks[0].kind else {
        panic!("expected a list")
    };
    assert_eq!(
        list.items[0].content.len(),
        2,
        "content after the math block must survive"
    );
    assert!(matches!(
        list.items[0].content[0].kind,
        BlockKind::MathBlock(_)
    ));
}

#[test]
fn math_content_that_looks_like_a_block_construct_is_preserved_but_not_recognised() {
    // Known limitation, and now the *only* remaining one of its kind. Inline `$…$` is
    // tokenised from source ahead of CommonMark (`parse::math`); display `$$…$$` is not, so
    // it is still recognised at the paragraph level, and a lone `-` between the fences ends
    // the paragraph. The content survives — nothing is lost, which is what C2 requires — but
    // it stops being maths. Extending the tokeniser to `$$` closes this.
    let doc = parse("$$\n-\n$$\n");
    assert!(
        !matches!(
            doc.blocks.first().map(|b| &b.kind),
            Some(BlockKind::MathBlock(_))
        ),
        "documents the current behaviour; update this test when M3 lands"
    );
    assert!(
        doc.blocks.len() > 1,
        "content is preserved as separate blocks, not dropped"
    );

    // Ordinary math content is unaffected.
    assert!(matches!(
        first_kind("$$\nE = mc^2\n$$\n"),
        BlockKind::MathBlock(_)
    ));
}

#[test]
fn latex_escapes_inside_math_are_kept() {
    let inlines = para("$\\{x\\}$\n");
    assert_eq!(
        inlines,
        vec![Inline::Math("\\{x\\}".into())],
        "LaTeX must not be de-escaped"
    );
    assert_eq!(normalize("$\\{x\\}$\n"), "$\\{x\\}$\n");
}

#[test]
fn a_cancelled_task_uses_the_obsidian_marker() {
    let doc = parse("- [-] Abandoned ❌ 2026-08-20\n");
    let task = &mb_core::extract(&doc).tasks[0];
    assert_eq!(task.task.status, TaskStatus::Cancelled);
    assert_eq!(task.text, "Abandoned");
    assert_eq!(to_markdown(&doc), "- [-] Abandoned ❌ 2026-08-20\n");
}

#[test]
fn raw_html_degrades_to_readable_text_rather_than_vanishing() {
    // The block model has no HTML node (SPEC §4.4). Keeping the characters honours C2;
    // only the HTML semantics are lost, and the result is stable thereafter.
    let out = normalize("<div>hello</div>\n");
    assert!(out.contains("hello"), "content must survive: {out:?}");
    assert_eq!(out, normalize(&out));
}

#[test]
fn extraction_reports_links_tags_media_and_headings() {
    let md = "---\ntags: [from/frontmatter]\n---\n\n# Title\n\nSee [[A]] and ![[B]] #inline\n\n![x](media/ab/cd/h.png)\n";
    let e = mb_core::extract(&parse(md));
    assert_eq!(e.links.len(), 2);
    assert!(e.links[1].embed);
    assert_eq!(
        e.tags,
        vec!["from/frontmatter".to_string(), "inline".to_string()]
    );
    assert_eq!(e.media, vec!["media/ab/cd/h.png".to_string()]);
    assert_eq!(e.headings, vec![(1, "Title".to_string())]);
    assert_eq!(
        mb_core::extract::title(&parse(md)).as_deref(),
        Some("Title")
    );
}

// ---------------------------------------------------------------- canonical form vs schema

#[test]
fn canonicalization_drops_a_list_with_no_items() {
    // An empty list renders as nothing, so leaving one in the normal form would put a block
    // in the model that no parse could ever return — and `canonicalize` is what the editor
    // and the CRDT layer funnel through, so they can construct one.
    let doc = Document::new(vec![Block::new(BlockKind::List(List {
        ordered: false,
        start: 1,
        items: vec![],
    }))]);
    assert_eq!(mb_core::canonicalize(doc).blocks, vec![]);
}

#[test]
fn canonicalization_keeps_a_list_whose_only_item_is_empty() {
    // `- ` on its own is real Markdown that parses back to exactly this, so unlike an empty
    // *list*, an empty *item* must survive.
    let doc = Document::new(vec![Block::new(BlockKind::List(List {
        ordered: false,
        start: 1,
        items: vec![ListItem {
            task: None,
            content: vec![],
        }],
    }))]);
    let canonical = mb_core::canonicalize(doc.clone());
    assert_eq!(canonical.blocks, doc.blocks);
    // No trailing space: §4.5 forbids it, and `-` alone still reads back as an empty item.
    assert_eq!(to_markdown(&canonical), "-\n");
    assert_eq!(parse("-\n").blocks, doc.blocks);
}

#[test]
fn canonicalization_squares_off_a_ragged_table_without_losing_cells() {
    // The serializer pads short rows out to the widest row, so a ragged table renders as a
    // rectangular one and reads back with cells the original did not have. Padding in the
    // normal form instead keeps the model and its own output in agreement.
    let cell = |s: &str| vec![Inline::Text(s.to_string())];
    let doc = Document::new(vec![Block::new(BlockKind::Table(Table {
        alignments: vec![Alignment::Left],
        head: vec![cell("a")],
        rows: vec![vec![cell("1"), cell("2"), cell("3")]],
    }))]);

    let BlockKind::Table(t) = mb_core::canonicalize(doc).blocks[0].kind.clone() else {
        panic!("expected a table");
    };
    assert_eq!(
        t.alignments,
        vec![Alignment::Left, Alignment::None, Alignment::None]
    );
    assert_eq!(t.head, vec![cell("a"), vec![], vec![]]);
    assert_eq!(t.rows, vec![vec![cell("1"), cell("2"), cell("3")]]);
}

#[test]
fn a_squared_off_table_round_trips() {
    let cell = |s: &str| vec![Inline::Text(s.to_string())];
    let doc = mb_core::canonicalize(Document::new(vec![Block::new(BlockKind::Table(Table {
        alignments: vec![Alignment::Left],
        head: vec![cell("a")],
        rows: vec![vec![cell("1"), cell("2")]],
    }))]));
    assert_eq!(parse(&to_markdown(&doc)).blocks, doc.blocks);
}

#[test]
fn canonicalization_drops_a_table_with_no_columns() {
    let doc = Document::new(vec![Block::new(BlockKind::Table(Table {
        alignments: vec![],
        head: vec![],
        rows: vec![],
    }))]);
    assert_eq!(mb_core::canonicalize(doc).blocks, vec![]);
}

#[test]
fn a_heading_level_outside_one_to_six_cannot_be_constructed() {
    assert_eq!(HeadingLevel::new(0), None);
    assert_eq!(HeadingLevel::new(7), None);
    assert_eq!(HeadingLevel::new(6), Some(HeadingLevel::H6));
    assert_eq!(HeadingLevel::clamped(9), HeadingLevel::H6);
    assert_eq!(HeadingLevel::clamped(0), HeadingLevel::H1);
}

#[test]
fn seven_hashes_is_not_a_heading() {
    // CommonMark stops at six, so `####### x` is a paragraph — which is why the model never
    // has to represent a seventh level in the first place.
    assert!(matches!(first_kind("####### x\n"), BlockKind::Paragraph(_)));
}

#[test]
fn an_empty_math_block_round_trips_rather_than_splitting_in_two() {
    // Found by `make fuzz TARGET=normalize` on the input `$$$$`, which parses as a math
    // block with no content. Rendering it as `$$\n\n$$` put a blank line between the
    // fences, so the next parse read two paragraphs instead of one math block and the file
    // changed again on the second save — breaking the one-time diff promised in SPEC §4.5.
    assert_eq!(first_kind("$$$$\n"), BlockKind::MathBlock(String::new()));
    assert_eq!(normalize("$$$$\n"), "$$\n$$\n");
    assert_eq!(normalize("$$\n$$\n"), "$$\n$$\n");
    assert_eq!(parse(&normalize("$$$$\n")).blocks, parse("$$$$\n").blocks);
}

#[test]
fn math_whose_body_would_open_a_block_still_round_trips() {
    // Found by `make fuzz TARGET=normalize` on `$$$$` and `$$****$$`. `$$` pairs up at the
    // paragraph level (see `parse::as_math_block`), so rendering `***` on its own line
    // between the fences turns it into a thematic break: the paragraph splits, the fences
    // never meet, and the file changes again on the second save — the opposite of the
    // one-time diff §4.5 promises. These bodies are the ones a parse can actually produce.
    for body in ["***", "****", "```", "", "x = 1"] {
        let doc = Document::new(vec![Block::new(BlockKind::MathBlock(body.to_string()))]);
        let markdown = to_markdown(&doc);
        assert_eq!(
            parse(&markdown).blocks,
            doc.blocks,
            "math body {body:?} rendered as {markdown:?} and did not read back"
        );
        assert_eq!(
            normalize(&markdown),
            markdown,
            "{markdown:?} is not its own canonical form"
        );
    }
}

#[test]
fn math_bodies_the_parser_cannot_produce_still_converge() {
    // Known limitation, and the reason the raw-source math tokeniser is planned: a math
    // block whose body is `# h` has no faithful rendering at all. Neither form survives —
    // `$$\n# h\n$$` reads back as a heading, `$$# h$$` as inline math — so the *structure*
    // is lost. Only an editor or the CRDT layer can construct one; no parse produces it.
    //
    // What must hold regardless is that normalisation still settles, or the file would
    // churn on every save. Content is preserved in every case.
    for body in ["# h", "- x", "> q", "1. x", "===", "|a|", "_"] {
        let doc = Document::new(vec![Block::new(BlockKind::MathBlock(body.to_string()))]);
        let markdown = to_markdown(&doc);
        let once = normalize(&markdown);
        assert_eq!(normalize(&once), once, "{markdown:?} did not converge");
        let text = body.trim_start_matches(['#', '-', '>', '=', '|', '_', ' ']);
        assert!(
            once.contains(text.trim()),
            "content lost from {body:?}: {once:?}"
        );
    }
}

#[test]
fn ordinary_math_still_uses_the_fenced_form() {
    // The single-line fallback must not leak into the common case: `$$` on its own lines is
    // what Obsidian writes and what §4.4 specifies.
    let doc = Document::new(vec![Block::new(BlockKind::MathBlock("x = 1".to_string()))]);
    assert_eq!(to_markdown(&doc), "$$\nx = 1\n$$\n");
    assert_eq!(normalize("$$\nx = 1\n$$\n"), "$$\nx = 1\n$$\n");
    assert_eq!(parse("$$\nx = 1\n$$\n").blocks, doc.blocks);
}

#[test]
fn a_heading_ending_in_a_hash_keeps_it() {
    // Found by `make fuzz TARGET=normalize` on `#\x0b#\x0b`. CommonMark strips a trailing
    // run of `#` from an ATX heading when a space precedes it — that is the optional closing
    // sequence — so `# #` reads back as an *empty* heading and the text is gone. Escaping
    // the run keeps the character and stops the file changing on the second save.
    for text in ["#", "a #", "a ##", "# #"] {
        let doc = Document::new(vec![Block::new(BlockKind::Heading {
            level: HeadingLevel::H1,
            content: vec![Inline::Text(text.to_string())],
        })]);
        let markdown = to_markdown(&doc);
        assert_eq!(
            parse(&markdown).blocks,
            doc.blocks,
            "heading {text:?} rendered as {markdown:?} and did not read back"
        );
        assert_eq!(
            normalize(&markdown),
            markdown,
            "{markdown:?} did not converge"
        );
    }
    assert_eq!(normalize("#\u{b}#\u{b}"), "# \\#\n");
}

#[test]
fn a_heading_ending_in_a_hash_without_a_space_needs_no_escape() {
    // `# a#` has no space before the `#`, so it is not a closing sequence and the character
    // survives untouched. Escaping it anyway would be noise in every C-preprocessor note.
    assert_eq!(normalize("# a#\n"), "# a#\n");
    assert_eq!(
        parse("# a#\n").blocks[0].kind,
        BlockKind::Heading {
            level: HeadingLevel::H1,
            content: vec![Inline::Text("a#".to_string())]
        }
    );
}

#[test]
fn escaped_dollar_fences_stay_literal_text() {
    // Found by `make fuzz TARGET=normalize`. `as_math_block` matches on *resolved* text,
    // where `\$\$` and `$$` are the same string — so a user escaping dollars to write about
    // them literally had the escape silently eaten and the paragraph turned into a math
    // block. The parser already consults the raw source for exactly this class of ambiguity
    // (`anchor_is_live`, `raw_blockquote_is_callout`); this is the third case.
    assert_eq!(
        first_kind("\\$\\$x\\$\\$\n"),
        BlockKind::Paragraph(vec![Inline::Text("$$x$$".to_string())])
    );
    assert_eq!(
        first_kind("\\$\\$\\$\\$\n"),
        BlockKind::Paragraph(vec![Inline::Text("$$$$".to_string())])
    );
    assert_eq!(normalize("\\$\\$x\\$\\$\n"), "\\$\\$x\\$\\$\n");

    // A half-escaped closing fence is not a fence either.
    assert!(matches!(first_kind("$$x\\$$\n"), BlockKind::Paragraph(_)));

    // Genuine math is untouched.
    assert_eq!(
        first_kind("$$\nx = 1\n$$\n"),
        BlockKind::MathBlock("x = 1".to_string())
    );
}

#[test]
fn math_containing_a_dollar_pair_survives_the_fenced_form() {
    // Found by `make fuzz TARGET=normalize`. A math body holding `$…$` — routine in LaTeX —
    // was read back as *inline* math once the body stood between fences, so the paragraph
    // was no longer all-text and the display block silently became a paragraph. The file
    // then needed a second pass to settle, breaking the one-pass promise in SPEC §4.5.
    let doc = Document::new(vec![Block::new(BlockKind::MathBlock("a$;$".to_string()))]);
    let markdown = to_markdown(&doc);
    assert_eq!(markdown, "$$\na$;$\n$$\n");
    assert_eq!(parse(&markdown).blocks, doc.blocks);
    assert_eq!(normalize(&markdown), markdown);

    // A `\$` written in the source stays escaped: the body is taken verbatim, and `\$` is
    // how LaTeX writes a literal dollar. It settles in one pass either way.
    let escaped = normalize("$$a\\$;$$$");
    assert_eq!(escaped, "$$\na\\$;$\n$$\n");
    assert_eq!(normalize(&escaped), escaped);
}

#[test]
fn a_code_block_never_ends_in_a_newline() {
    // Found by `make fuzz TARGET=normalize` on `\tq\r\r\r\r`. The newline before the closing
    // fence was being stripped twice — once by `canonical`, once by the serializer — so a
    // code body ending in one lost a line on every save and the file never settled.
    //
    // The honest limitation underneath: `pulldown-cmark` reports the same content for
    // ```` ```\nq\n``` ```` and ```` ```\nq\n\n``` ````, so a trailing blank line inside a
    // fence cannot be represented. It is dropped once, deterministically, at normalisation —
    // not eaten one line per save. Blank lines *within* the block are untouched.
    for code in ["q", "q\n", "q\n\n", "", "\n", "a\n\nb"] {
        let canonical =
            mb_core::canonicalize(Document::new(vec![Block::new(BlockKind::CodeBlock {
                lang: None,
                code: code.to_string(),
            })]));
        let markdown = to_markdown(&canonical);
        assert_eq!(
            parse(&markdown).blocks,
            canonical.blocks,
            "code {code:?} rendered as {markdown:?} and did not read back"
        );
        assert_eq!(
            normalize(&markdown),
            markdown,
            "{markdown:?} did not converge"
        );
    }
    assert_eq!(normalize("\tq\r\r\r\r"), "```\nq\n```\n");
    // Interior blank lines are content and stay.
    assert_eq!(normalize("```\na\n\nb\n```\n"), "```\na\n\nb\n```\n");
}

#[test]
fn math_body_lines_carry_no_surrounding_whitespace() {
    // Found by `make fuzz TARGET=normalize` on `$$ $ $$`. `$$` blocks are read at the
    // paragraph level, and a paragraph line comes back trimmed — so a math body holding
    // ` $ ` lost its spaces on reparse and the file changed again on the second save. It
    // also emitted a line with trailing whitespace, which §4.5 forbids outside code.
    //
    // Unlike a code fence, a `$$` block cannot preserve indentation. LaTeX does not care,
    // but it is a real difference from Obsidian and so is pinned here.
    for body in [" $ ", "  a  ", "x\n  y", "\u{b}a\u{b}", "a"] {
        let canonical = mb_core::canonicalize(Document::new(vec![Block::new(
            BlockKind::MathBlock(body.to_string()),
        )]));
        let markdown = to_markdown(&canonical);
        assert_eq!(
            parse(&markdown).blocks,
            canonical.blocks,
            "math body {body:?} rendered as {markdown:?} and did not read back"
        );
        assert_eq!(
            normalize(&markdown),
            markdown,
            "{markdown:?} did not converge"
        );
        for line in markdown.lines() {
            assert_eq!(line.trim_end(), line, "trailing whitespace in {markdown:?}");
        }
    }
    assert_eq!(normalize("$$ $ $$"), "$$\n$\n$$\n");
    assert_eq!(normalize("$$\n  x + 1\n$$\n"), "$$\nx + 1\n$$\n");
}

#[test]
fn a_language_containing_a_backtick_uses_a_tilde_fence() {
    // Found by `make fuzz TARGET=normalize`. CommonMark forbids a backtick in the info
    // string of a backtick fence — it would be ambiguous with the fence itself — so
    // ```` ```a`b ```` is not a code block at all and the block came back as prose. A tilde
    // fence has no such restriction.
    for lang in ["a`b", "`", "c++`"] {
        let doc = Document::new(vec![Block::new(BlockKind::CodeBlock {
            lang: Some(lang.to_string()),
            code: "x".to_string(),
        })]);
        let markdown = to_markdown(&doc);
        assert!(
            markdown.starts_with("~~~"),
            "expected a tilde fence: {markdown:?}"
        );
        assert_eq!(
            parse(&markdown).blocks,
            doc.blocks,
            "lang {lang:?} rendered as {markdown:?} and did not read back"
        );
        assert_eq!(
            normalize(&markdown),
            markdown,
            "{markdown:?} did not converge"
        );
    }
}

#[test]
fn an_ordinary_language_keeps_the_backtick_fence() {
    // The tilde fallback must stay rare: backtick fences are what §4.5 specifies and what
    // every other tool writes.
    assert_eq!(
        normalize("```rust\nfn main() {}\n```\n"),
        "```rust\nfn main() {}\n```\n"
    );
    assert_eq!(
        normalize("~~~rust\nfn main() {}\n~~~\n"),
        "```rust\nfn main() {}\n```\n"
    );
}

#[test]
fn a_tilde_fence_still_escapes_a_tilde_run_in_the_body() {
    let doc = Document::new(vec![Block::new(BlockKind::CodeBlock {
        lang: Some("a`b".to_string()),
        code: "~~~~\nx".to_string(),
    })]);
    let markdown = to_markdown(&doc);
    assert_eq!(
        parse(&markdown).blocks,
        doc.blocks,
        "rendered as {markdown:?}"
    );
}

#[test]
fn a_language_string_survives_backslash_and_entity_resolution() {
    // Found by `make fuzz TARGET=normalize` on "```a\\\\-". A fence's info string is not
    // literal: CommonMark resolves backslash escapes and entity references in it. Writing
    // the language back verbatim meant `a\-` became `a-` and `&amp;` became `&`, so the
    // block changed on every save.
    for lang in ["a\\-", "\\", "a\\\\b", "&amp;", "&", "c++", "rust"] {
        let doc = Document::new(vec![Block::new(BlockKind::CodeBlock {
            lang: Some(lang.to_string()),
            code: "x".to_string(),
        })]);
        let markdown = to_markdown(&doc);
        assert_eq!(
            parse(&markdown).blocks,
            doc.blocks,
            "lang {lang:?} rendered as {markdown:?} and did not read back"
        );
        assert_eq!(
            normalize(&markdown),
            markdown,
            "{markdown:?} did not converge"
        );
    }
    // Ordinary languages stay untouched — no stray backslashes in everyday notes.
    assert_eq!(normalize("```rust\nx\n```\n"), "```rust\nx\n```\n");
    assert_eq!(normalize("```c++\nx\n```\n"), "```c++\nx\n```\n");
}

#[test]
fn latex_backslash_escapes_in_display_math_survive_normalisation() {
    // Found by `make fuzz TARGET=normalize` on `$$\)$$`. Display math is recognised at the
    // paragraph level, so its body arrives as text CommonMark has already *resolved* — and
    // CommonMark resolves a backslash before any ASCII punctuation. `\{`, `\}`, `\%`, `\_`,
    // `\&` and `\\` are everyday LaTeX, so `memberberry normalize` was quietly stripping
    // backslashes out of real equations across a whole vault. Content loss, and C2 forbids it.
    for source in [
        "$$\n\\{ x \\}\n$$\n",
        "$$\nx \\% y\n$$\n",
        "$$\na \\& b\n$$\n",
        "$$\nx \\\\ y\n$$\n",
        "$$\n\\frac{1}{2}\n$$\n",
        "$$\n\\sum_{i=1}^{n} i\n$$\n",
        "$$\n\\alpha_\\beta\n$$\n",
    ] {
        assert_eq!(normalize(source), source, "{source:?} was not preserved");
    }
    assert_eq!(
        first_kind("$$\n\\{ x \\}\n$$\n"),
        BlockKind::MathBlock("\\{ x \\}".to_string())
    );
}

#[test]
fn an_empty_task_keeps_its_checkbox() {
    // Found by running `normalize` over a real Obsidian vault: `- [ ] ` on its own became
    // `- `, silently demoting a task to a bullet — and `- [x] ` silently deleted a completed
    // one. `canonical::list_item` only kept the marker when the item began with a paragraph,
    // which an empty item does not.
    assert_eq!(normalize("- [ ] \n"), "- [ ]\n");
    assert_eq!(normalize("- [ ]\n"), "- [ ]\n");
    assert_eq!(normalize("- [x] \n"), "- [x]\n");
    assert_eq!(normalize("- [-] \n"), "- [-]\n");
    assert_eq!(
        normalize("- [ ] a\n- [ ] \n- [ ] b\n"),
        "- [ ] a\n- [ ]\n- [ ] b\n"
    );

    let item = match first_kind("- [ ] \n") {
        BlockKind::List(l) => l.items.into_iter().next().expect("one item"),
        other => panic!("expected a list, got {other:?}"),
    };
    assert_eq!(item.task.expect("task marker").status, TaskStatus::Todo);
    assert!(item.content.is_empty());
}

#[test]
fn an_empty_task_emits_no_trailing_whitespace() {
    // `- [ ] ` with the trailing space would violate §4.5 and churn in git.
    for source in ["- [ ] \n", "- [x] \n", "- [-] \n"] {
        for line in normalize(source).lines() {
            assert_eq!(line.trim_end(), line, "trailing whitespace from {source:?}");
        }
    }
}

#[test]
fn an_empty_cancelled_task_is_not_duplicated() {
    // `- [-] ` produced `- [-] \[-\]`: the marker was recognised *and* left in the text,
    // because the stripper looked for `"[-] "` with a trailing space that trimming had
    // already removed. `[-]` is Memberberry's own extension, so both halves are ours.
    assert_eq!(normalize("- [-] \n"), "- [-]\n");
    assert_eq!(normalize("- [-]\n"), "- [-]\n");
    assert_eq!(normalize("- [-] x\n"), "- [-] x\n");
    let item = match first_kind("- [-]\n") {
        BlockKind::List(l) => l.items.into_iter().next().expect("one item"),
        other => panic!("expected a list, got {other:?}"),
    };
    assert_eq!(
        item.task.expect("task marker").status,
        TaskStatus::Cancelled
    );
    assert!(item.content.is_empty());
}

#[test]
fn a_task_marker_is_dropped_only_when_it_cannot_be_rendered() {
    // The rule that caused the bug is still right for its real case: a marker has to sit on
    // the item's first line, so an item opening with a code block cannot carry one.
    let item = match first_kind("- [ ] \n  ```\n  x\n  ```\n") {
        BlockKind::List(l) => l.items.into_iter().next().expect("one item"),
        other => panic!("expected a list, got {other:?}"),
    };
    assert!(
        item.content
            .iter()
            .any(|b| matches!(b.kind, BlockKind::CodeBlock { .. }))
    );
}

#[test]
fn image_alt_text_keeps_shortcodes_tags_and_math() {
    // Found by running `normalize` over a real Obsidian vault: `![:magic_wand:](url)` came
    // back as `![](url)`. Alt text was flattened with the same helper the index uses for
    // heading text, and that helper drops everything it has no plain rendering for — so any
    // alt containing an emoji shortcode, tag, wikilink or math lost it silently.
    for source in [
        "![:magic_wand:](https://example.com/a.png)\n",
        "![a #tag b](https://example.com/a.png)\n",
        "![$x^2$](https://example.com/a.png)\n",
        "![plain alt](https://example.com/a.png)\n",
        "![`code`](https://example.com/a.png)\n",
    ] {
        assert_eq!(normalize(source), source, "{source:?} was not preserved");
    }
    assert_eq!(
        para("![:magic_wand:](https://example.com/a.png)\n"),
        vec![Inline::Image {
            dest: "https://example.com/a.png".to_string(),
            alt: ":magic_wand:".to_string(),
        }]
    );
}

#[test]
fn task_metadata_is_not_inserted_inside_trailing_emphasis() {
    // Found at PROPTEST_CASES=20000. Metadata has to go before a block anchor, and the
    // serializer worked out where the anchor was by pattern-matching the rendered line —
    // so a literal `^` inside trailing emphasis looked like one, and `🔺` was spliced into
    // the middle of the emphasis. The block's `anchor` field is authoritative; ask it.
    let doc = Document::new(vec![Block::new(BlockKind::List(List {
        ordered: false,
        start: 1,
        items: vec![ListItem {
            task: Some(Task {
                status: TaskStatus::Todo,
                meta: TaskMeta {
                    priority: Some(Priority::Highest),
                    ..TaskMeta::default()
                },
            }),
            content: vec![Block::new(BlockKind::Paragraph(vec![
                Inline::Strong(vec![Inline::Text("<".to_string())]),
                Inline::Emphasis(vec![Inline::Text("! ^".to_string())]),
            ]))],
        }],
    }))]);
    let markdown = to_markdown(&doc);
    assert_eq!(
        parse(&markdown).blocks,
        doc.blocks,
        "rendered as {markdown:?}"
    );
}

#[test]
fn task_metadata_still_goes_before_a_real_block_anchor() {
    // The rule being fixed is still right for its real case: an anchor must stay last.
    let doc = Document::new(vec![Block::new(BlockKind::List(List {
        ordered: false,
        start: 1,
        items: vec![ListItem {
            task: Some(Task {
                status: TaskStatus::Todo,
                meta: TaskMeta {
                    priority: Some(Priority::High),
                    ..TaskMeta::default()
                },
            }),
            content: vec![Block::with_anchor(
                BlockKind::Paragraph(vec![Inline::Text("write it up".to_string())]),
                "note-1",
            )],
        }],
    }))]);
    let markdown = to_markdown(&doc);
    assert_eq!(markdown, "- [ ] write it up ⏫ ^note-1\n");
    assert_eq!(parse(&markdown).blocks, doc.blocks);
}

#[test]
fn image_alt_text_reads_through_every_inline_kind() {
    // Each arm of the alt reconstruction, because a missing one silently empties part of a
    // caption — which is how the `:magic_wand:` bug got in.
    for (source, alt) in [
        ("![a[^1]b](u)\n", "a[^1]b"),
        ("![*em* **strong** ~~s~~ ==h==](u)\n", "em strong s h"),
        ("![[[Target|shown]]](u)\n", "shown"),
        ("![[[Bare Target]]](u)\n", "Bare Target"),
        ("![a\\\nb](u)\n", "a b"),
    ] {
        let inlines = para(source);
        let Some(Inline::Image { alt: got, .. }) = inlines.first() else {
            panic!("expected an image from {source:?}, got {inlines:?}");
        };
        assert_eq!(got, alt, "from {source:?}");
    }
}

#[test]
fn image_alt_text_survives_a_round_trip_for_every_inline_kind() {
    for source in [
        "![a[^1]b](u)\n",
        "![*em* **strong**](u)\n",
        "![[[Target|shown]]](u)\n",
        "![a \\[bracket\\] b](u)\n",
    ] {
        let once = normalize(source);
        assert_eq!(normalize(&once), once, "{source:?} did not converge");
        assert_eq!(parse(&once).blocks, parse(source).blocks, "{source:?}");
    }
}

#[test]
fn a_blockquote_is_only_a_callout_when_its_source_says_so() {
    // `detect_callout` bails in several distinct ways; each leaves an ordinary blockquote
    // rather than inventing a callout with an empty kind.
    for source in [
        "> plain quote\n",         // no marker at all
        "> \\[!note\\] escaped\n", // escaped marker: deliberately not a callout
        "> [!unclosed note\n",     // no closing bracket
        "> ```\n> code\n> ```\n",  // first block is not a paragraph
        "> **bold** [!note]\n",    // marker not at the start
    ] {
        assert!(
            matches!(first_kind(source), BlockKind::Blockquote(_)),
            "{source:?} should stay a blockquote, got {:?}",
            first_kind(source)
        );
    }
}

#[test]
fn an_empty_blockquote_is_not_a_callout() {
    assert_eq!(first_kind(">\n"), BlockKind::Blockquote(vec![]));
}

#[test]
fn an_anchor_is_split_off_a_heading_as_well_as_a_paragraph() {
    let block = parse("# Title ^h-1\n")
        .blocks
        .into_iter()
        .next()
        .expect("a block");
    assert_eq!(block.anchor.as_deref(), Some("h-1"));
    assert_eq!(
        block.kind,
        BlockKind::Heading {
            level: HeadingLevel::H1,
            content: vec![Inline::Text("Title".to_string())]
        }
    );
}

#[test]
fn an_anchor_whose_text_run_holds_nothing_else_drops_that_run() {
    // `**bold** ^id`: the final text inline is just " ^id", so splitting the anchor off
    // leaves it empty and it has to be removed rather than left as a blank run.
    let block = parse("**bold** ^b-1\n")
        .blocks
        .into_iter()
        .next()
        .expect("a block");
    assert_eq!(block.anchor.as_deref(), Some("b-1"));
    assert_eq!(
        block.kind,
        BlockKind::Paragraph(vec![Inline::Strong(vec![Inline::Text("bold".to_string())])])
    );
    assert_eq!(normalize("**bold** ^b-1\n"), "**bold** ^b-1\n");
}

#[test]
fn a_caret_at_the_start_of_a_line_is_ordinary_text() {
    // An anchor is recognised as ` ^id` at the *end* of a block. A line that is only
    // `^lonely` has nothing before it, so it is prose — and stays prose on a round trip.
    let block = parse("^lonely\n")
        .blocks
        .into_iter()
        .next()
        .expect("a block");
    assert_eq!(block.anchor, None);
    assert_eq!(
        block.kind,
        BlockKind::Paragraph(vec![Inline::Text("^lonely".to_string())])
    );
    assert_eq!(normalize(&normalize("^lonely\n")), normalize("^lonely\n"));
}

#[test]
fn a_callout_keeps_a_block_anchor_written_on_a_lazy_body_line() {
    // Regression. A callout's header line and its lazy body lines are one Markdown
    // paragraph, so the trailing `^id` is split off that paragraph before the callout is
    // detected — and `detect_callout` used to rebuild the body block without it. The anchor
    // *and* its text were dropped: this normalized to `> body` with no `^b-1` anywhere.
    let doc = parse("> [!note] Title\n> body ^b-1\n");
    let BlockKind::Callout(callout) = &doc.blocks.first().expect("a block").kind else {
        panic!("expected a callout, got {:?}", doc.blocks);
    };
    assert_eq!(
        callout.content.first().and_then(|b| b.anchor.as_deref()),
        Some("b-1"),
        "the anchor belongs to the body line it was written on"
    );
    assert_eq!(
        normalize("> [!note] Title\n> body ^b-1\n"),
        "> [!note] Title\n>\n> body ^b-1\n"
    );
}

#[test]
fn a_callout_keeps_a_block_anchor_written_on_its_header_line() {
    // The one anchor in the model with no home: a container block cannot carry one, so an
    // anchor on the header line stays as title text rather than vanishing. Escaped on the
    // way out, so the next parse reads it as the text it now is.
    let doc = parse("> [!tip] Title ^t-1\n");
    let BlockKind::Callout(callout) = &doc.blocks.first().expect("a block").kind else {
        panic!("expected a callout, got {:?}", doc.blocks);
    };
    assert_eq!(mb_core::extract::plain_text(&callout.title), "Title ^t-1");
    assert!(callout.content.is_empty());
    assert_eq!(
        normalize("> [!tip] Title ^t-1\n"),
        "> [!tip] Title \\^t-1\n"
    );
}

#[test]
fn every_block_that_can_carry_an_anchor_keeps_it_through_a_round_trip() {
    // A table over the forms an anchor is written in, because the callout losses above were
    // invisible to every property test the crate has: the anchor was dropped *inside* parse,
    // so the model that reaches the serializer never had it, and normalizing was idempotent
    // on the way out. Nothing but naming the forms catches that.
    for source in [
        "para ^a\n",
        "# Heading ^a\n",
        "- item ^a\n",
        "1. item ^a\n",
        "- [ ] task ^a\n",
        "> quoted ^a\n",
        "> [!note] Title\n>\n> body ^a\n",
        "> [!note] Title\n> body ^a\n",
        "> [!note]\n> body ^a\n",
    ] {
        let anchors = |md: &str| {
            let doc = parse(md);
            mb_core::extract(&doc)
                .anchors
                .into_iter()
                .map(|a| a.anchor)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            anchors(source),
            vec!["a".to_string()],
            "{source:?} lost its anchor at parse time"
        );
        let once = normalize(source);
        assert_eq!(
            anchors(&once),
            vec!["a".to_string()],
            "{source:?} normalized to {once:?}, which has no anchor"
        );
        assert_eq!(normalize(&once), once, "{source:?} is not stable");
    }
}

#[test]
fn an_anchor_is_not_split_off_a_block_that_cannot_carry_one() {
    // v1 recognises anchors on paragraphs and headings only; a trailing `^id` elsewhere is
    // ordinary text and must stay that way rather than vanish into a field.
    assert!(matches!(
        first_kind("```\ncode ^x\n```\n"),
        BlockKind::CodeBlock { .. }
    ));
    assert_eq!(normalize("```\ncode ^x\n```\n"), "```\ncode ^x\n```\n");
}

#[test]
fn two_adjacent_inline_maths_fuse_into_one() {
    // Found at PROPTEST_CASES=512 once the generator reached it. `$a$$b$` is not two math
    // spans on the way back in — the `$$` in the middle is ambiguous — so the model state
    // "two adjacent Math inlines" has no faithful rendering and cannot survive a save.
    //
    // Merging is the same answer already given to two adjacent code spans a few lines above
    // in `canonical::push`, and for the same reason: it is the only expressible form.
    let doc = Document::new(vec![Block::new(BlockKind::Paragraph(vec![
        Inline::Math("a".to_string()),
        Inline::Math("b".to_string()),
    ]))]);
    let canonical = mb_core::canonicalize(doc);
    assert_eq!(
        canonical.blocks[0].kind,
        BlockKind::Paragraph(vec![Inline::Math("ab".to_string())])
    );
    let markdown = to_markdown(&canonical);
    assert_eq!(
        parse(&markdown).blocks,
        canonical.blocks,
        "rendered as {markdown:?}"
    );
    assert_eq!(normalize(&markdown), markdown);
}

#[test]
fn a_tag_containing_an_underscore_survives_inside_underscore_emphasis() {
    // Found by the property suite. Emphasis after a `**` run must use `_` as its delimiter,
    // or `***` would be ambiguous — but a tag name may itself contain `_`, and tag names
    // were emitted with no escaping at all, unlike text. `_#a-_a_` then read back as a
    // literal underscore, a shorter tag, and an emphasis around the remainder.
    let doc = Document::new(vec![Block::new(BlockKind::Paragraph(vec![
        Inline::Strong(vec![Inline::Text("x".to_string())]),
        Inline::Emphasis(vec![Inline::Tag("a-_a".to_string())]),
    ]))]);
    let markdown = to_markdown(&doc);
    assert_eq!(
        parse(&markdown).blocks,
        doc.blocks,
        "rendered as {markdown:?}"
    );
    assert_eq!(normalize(&markdown), markdown);
}

#[test]
fn a_tag_needs_no_escape_where_the_delimiter_is_a_star() {
    // The escape must stay rare: `*#a-_a*` is unambiguous, and a backslash there would be
    // noise in every note that tags with underscores.
    let doc = Document::new(vec![Block::new(BlockKind::Paragraph(vec![
        Inline::Emphasis(vec![Inline::Tag("a-_a".to_string())]),
    ]))]);
    let markdown = to_markdown(&doc);
    assert_eq!(markdown, "*#a-_a*\n");
    assert_eq!(parse(&markdown).blocks, doc.blocks);
}

#[test]
fn a_bare_tag_with_an_underscore_is_never_escaped() {
    assert_eq!(normalize("#a-_a\n"), "#a-_a\n");
    assert_eq!(
        first_kind("#a-_a\n"),
        BlockKind::Paragraph(vec![Inline::Tag("a-_a".to_string())])
    );
}

#[test]
fn a_link_title_survives_a_round_trip() {
    // Found by normalising a real vault: `[text](url "title")` came back without its title,
    // because `Inline::Link` had nowhere to put one. A title is content the author wrote.
    let doc = Document::new(vec![Block::new(BlockKind::Paragraph(vec![Inline::Link {
        dest: "https://example.com".to_string(),
        title: Some("A title".to_string()),
        content: vec![Inline::Text("text".to_string())],
    }]))]);
    assert_eq!(
        to_markdown(&doc),
        "[text](https://example.com \"A title\")\n"
    );
    assert_eq!(parse(&to_markdown(&doc)).blocks, doc.blocks);
}

#[test]
fn every_commonmark_title_form_reads_and_writes_back_double_quoted() {
    // CommonMark accepts three; one canonical form keeps the output deterministic (§4.5).
    for source in ["[t](u \"title\")\n", "[t](u 'title')\n", "[t](u (title))\n"] {
        assert_eq!(normalize(source), "[t](u \"title\")\n", "from {source:?}");
    }
    assert_eq!(normalize("[t](u \"title\")\n"), "[t](u \"title\")\n");
}

#[test]
fn a_link_without_a_title_gains_nothing() {
    assert_eq!(normalize("[t](u)\n"), "[t](u)\n");
    let BlockKind::Paragraph(inlines) = first_kind("[t](u)\n") else {
        panic!("expected a paragraph");
    };
    assert_eq!(
        inlines,
        vec![Inline::Link {
            dest: "u".to_string(),
            title: None,
            content: vec![Inline::Text("t".to_string())],
        }]
    );
}

#[test]
fn a_quote_inside_a_link_title_is_escaped() {
    // An unescaped quote would close the title early and turn the rest into a parse error.
    for title in ["say \"hi\"", "back\\slash", "both \" and \\"] {
        let doc = Document::new(vec![Block::new(BlockKind::Paragraph(vec![Inline::Link {
            dest: "u".to_string(),
            title: Some(title.to_string()),
            content: vec![Inline::Text("t".to_string())],
        }]))]);
        let markdown = to_markdown(&doc);
        assert_eq!(
            parse(&markdown).blocks,
            doc.blocks,
            "rendered as {markdown:?}"
        );
        assert_eq!(normalize(&markdown), markdown);
    }
}

#[test]
fn a_link_title_reaches_the_rendered_html() {
    let out = mb_core::html::document(
        &parse("[t](https://example.com \"Hover me\")\n"),
        &mb_core::html::Urls::default(),
    );
    assert!(out.contains("title=\"Hover me\""), "{out}");
}

// ---------------------------------------------------------------- inline math, tokenised

#[test]
fn math_bodies_that_look_like_markdown_are_now_recognised() {
    // Before the source-level tokeniser these were refused outright and left as literal
    // text, because the body had already been through CommonMark's inline parser by the
    // time anything looked for maths. All of them are ordinary LaTeX.
    for (source, body) in [
        ("$a*b$\n", "a*b"),
        ("$\\alpha[i]$\n", "\\alpha[i]"),
        ("$a<b$\n", "a<b"),
        ("$x~y$\n", "x~y"),
        ("$_a_$\n", "_a_"),
        ("$P(A|B)$\n", "P(A|B)"),
        ("$\\{x\\}$\n", "\\{x\\}"),
        ("$x_i + y_j$\n", "x_i + y_j"),
        ("$\\sum_{i=1}^{n}$\n", "\\sum_{i=1}^{n}"),
    ] {
        assert_eq!(
            para(source),
            vec![Inline::Math(body.to_string())],
            "from {source:?}"
        );
        assert_eq!(normalize(source), source, "{source:?} should be unchanged");
    }
}

#[test]
fn a_math_body_containing_a_backtick_is_still_refused() {
    // The one character the tokeniser will not take, and now for a stateable reason: a body
    // is written back verbatim — escaping it would change the maths, `\_` being a literal
    // underscore to LaTeX — and CommonMark parses code spans before backslash escapes, so a
    // raw backtick from a body can pair with a later one and swallow the text between.
    assert!(matches!(first_kind("$`x`$\n"), BlockKind::Paragraph(_)));
    assert!(!para("$`x`$\n").iter().any(|i| matches!(i, Inline::Math(_))));
}

#[test]
fn math_is_not_taken_from_inside_code() {
    // Where the code is comes from `pulldown-cmark`, not from guessing at lines.
    assert_eq!(
        first_kind("```\n$a_b$\n```\n"),
        BlockKind::CodeBlock {
            lang: None,
            code: "$a_b$".to_string()
        }
    );
    assert_eq!(para("`$a_b$`\n"), vec![Inline::Code("$a_b$".to_string())]);
    // Including a fence opened inside a list item, which no line scanner sees.
    let BlockKind::List(l) = first_kind("- ```\n  $a_b$\n  ```\n") else {
        panic!("expected a list");
    };
    assert!(matches!(
        l.items[0].content[0].kind,
        BlockKind::CodeBlock { .. }
    ));
}

#[test]
fn math_does_not_reach_across_a_table_cell() {
    // A span crossing `|` would weld two cells together. Inside a row it is refused; the
    // same body outside one is fine, which `$P(A|B)$` above already shows.
    let BlockKind::Table(t) = first_kind("| $a | b$ | c |\n| --- | --- | --- |\n") else {
        panic!("expected a table");
    };
    assert_eq!(t.head.len(), 3, "the row must keep its three cells");
}

#[test]
fn display_math_is_left_to_the_block_path() {
    assert_eq!(
        first_kind("$$\nx = 1\n$$\n"),
        BlockKind::MathBlock("x = 1".to_string())
    );
    assert_eq!(normalize("$$\nx = 1\n$$\n"), "$$\nx = 1\n$$\n");
}

#[test]
fn a_lone_dollar_is_still_prose() {
    for source in ["costs $5 and $6 more\n", "$ x $\n", "a $ b\n"] {
        assert!(
            !para(source).iter().any(|i| matches!(i, Inline::Math(_))),
            "{source:?} should not be maths"
        );
        assert_eq!(normalize(&normalize(source)), normalize(source));
    }
}

#[test]
fn an_escaped_dollar_pair_is_not_maths() {
    assert_eq!(
        para("\\$x\\$\n"),
        vec![Inline::Text("$x$".to_string())],
        "escaping must still opt out"
    );
}
