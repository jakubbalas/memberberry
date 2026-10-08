//! The bounded, Rust-owned namespace formatting contract.
// why: integration tests, not library code (AGENTS.md 4.2) — a panic is the failure report.
#![allow(
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::panic
)]
use mb_core::{parse, to_markdown};
fn to_html(doc: &mb_core::Document) -> String {
    mb_core::html::document(doc, &mb_core::html::Urls::default())
}

#[test]
fn underline_is_native_safe_and_canonical() {
    let source =
        ":mb-style[hello **world** and [link](<https://example.test/a(b)>)]{underline=\"true\"}\n";
    let doc = parse(source);
    let canonical = to_markdown(&doc);
    assert_eq!(to_markdown(&parse(&canonical)), canonical);
    assert!(canonical.contains(":mb-style["));
    let html = to_html(&doc);
    assert!(html.contains("class=\"mb-underline\""), "{html}");
    assert!(html.contains("<strong>world</strong>"), "{html}");
    assert!(!html.contains("style="));
    assert_eq!(parse(&to_markdown(&doc)), doc);
}

#[test]
fn empty_guards_and_atom_only_labels_never_create_empty_namespace_marks() {
    for label in ["", "`code`", "$x$", "[[Wiki]]", "#tag", ":berry:"] {
        let source = format!(":mb-style[{label}]{{underline=\"true\" color=\"red\"}}");
        let doc = parse(&source);
        let canonical = to_markdown(&doc);
        assert!(
            !canonical.contains(":mb-style["),
            "{source:?} -> {canonical:?}"
        );
        assert!(!to_html(&doc).contains("mb-underline"));
        assert_eq!(parse(&canonical), doc);
    }
    let doc = parse(r#":mb-style[hello `code`]{underline="true" color="red"}"#);
    assert!(!to_markdown(&doc).contains(":mb-style[]"));
}

#[test]
fn styled_native_mark_order_matches_the_wire_set_without_losing_marks() {
    let doc = parse(r#":mb-style[~~*A*~~]{size="small"}"#);
    let canonical = to_markdown(&doc);
    assert_eq!(canonical, ":mb-style[*~~A~~*]{size=\"small\"}\n");
    assert!(to_html(&doc).contains("<em><del>A</del></em>"));
    assert_eq!(parse(&canonical), doc);
}

#[test]
fn nesting_is_bounded_and_inner_same_dimension_wins() {
    let source = r#":mb-style[a :mb-style[b]{color="blue"} c]{color="red" underline="true"}"#;
    let doc = parse(source);
    let canonical = to_markdown(&doc);
    assert_eq!(
        canonical,
        ":mb-style[:mb-style[a ]{color=\"red\"}:mb-style[b]{color=\"blue\"}:mb-style[ c]{color=\"red\"}]{underline=\"true\"}\n"
    );
    assert_eq!(parse(&canonical), doc);
    let mut deep = "KEEP".to_string();
    for _ in 0..17 {
        deep = format!(":mb-style[{deep}]{{underline=\"true\"}}");
    }
    let doc = parse(&deep);
    assert!(
        !to_html(&doc).contains("mb-underline"),
        "over-budget source became formatting"
    );
    assert!(mb_core::to_markdown(&doc).contains("KEEP"));
    assert_eq!(parse(&to_markdown(&doc)), doc);
}

#[test]
fn constructed_style_depth_and_nontext_content_are_rejected() {
    use mb_core::model::{Block, BlockKind, Document, Inline, MbStyleProperty};
    let styled = |content| Inline::MbStyle {
        property: MbStyleProperty::Underline,
        content,
    };
    let invalid = Document::new(vec![Block::new(BlockKind::Paragraph(vec![styled(vec![
        Inline::Code("x".into()),
    ])]))]);
    assert!(mb_core::schema::validate(&invalid).is_err());
    let mut deep = Inline::Text("KEEP".into());
    for _ in 0..17 {
        deep = styled(vec![deep]);
    }
    let invalid = Document::new(vec![Block::new(BlockKind::Paragraph(vec![deep]))]);
    assert!(mb_core::schema::validate(&invalid).is_err());
    let canonical = mb_core::canonicalize(invalid);
    assert_eq!(mb_core::schema::validate(&canonical), Ok(()));
    assert_eq!(parse(&to_markdown(&canonical)), canonical);
}

#[test]
fn extraction_transclusion_and_conflicts_visit_styled_labels() {
    use mb_core::model::Anchor;
    let source = "# :mb-style[Styled **Heading**]{color=\"blue\"}\n\n:mb-style[words [[Target]] #tag :berry: $x$ `code`]{underline=\"true\"} ^spot\n\n# Next\n\nother\n";
    let doc = parse(source);
    let facts = mb_core::extract::extract(&doc);
    assert_eq!(facts.headings[0].1, "Styled Heading");
    assert_eq!(facts.links[0].target, "Target");
    assert_eq!(facts.tags, ["tag"]);
    assert_eq!(facts.emoji, ["berry"]);
    assert!(facts.anchors[0].text.starts_with("words Target"));
    let section = mb_core::transclude::slice(&doc, Some(&Anchor::Heading("Styled Heading".into())))
        .expect("styled heading matches");
    assert_eq!(section.len(), 2);
    let old = parse(r#":mb-style[base]{color="blue"}"#);
    let mine = parse(r#":mb-style[mine]{underline="true"}"#);
    let theirs = parse(r#":mb-style[theirs]{background="pink"}"#);
    let merged = mb_core::conflict::merge(Some(&old), &mine, &theirs, "2026-10-04T00:00:00Z");
    assert_eq!(mb_core::conflict::count(&merged), 1);
    assert_eq!(parse(&to_markdown(&merged)), merged);
    let html = to_html(&merged);
    assert!(html.contains("mb-underline"));
    assert!(html.contains("mb-background-pink"));
}

#[test]
fn invalid_metadata_preserves_every_literal_byte_and_note_tail() {
    for attrs in [
        "",
        "color=\"red\" color=\"blue\"",
        "style=\"font-weight:bold\"",
        "class=\"mb-color-red\"",
        "Underline=\"true\"",
        "color='red'",
        "color=\"red\\\"",
        "size=\"normal\"",
        "background=\"default\"",
        "underline=\"false\"",
    ] {
        let source = format!(":mb-style[KEEP 彩色]{{{attrs}}} SENTINEL tail");
        let doc = parse(&source);
        let text = match &doc.blocks[0].kind {
            mb_core::BlockKind::Paragraph(c) => mb_core::extract::plain_text(c),
            _ => panic!("paragraph"),
        };
        assert_eq!(text, source);
        assert!(
            !to_html(&doc).contains("<span class=\"mb-"),
            "{source:?}: {}",
            to_html(&doc)
        );
        assert_eq!(parse(&to_markdown(&doc)), doc);
    }
}

#[test]
fn namespace_metadata_is_not_a_rename_target() {
    let source = r##":mb-style[hello #old [[Old]]]{unknown="#old [[Old]]"} SENTINEL"##;
    let tag = mb_core::rewrite::rename_tag(source, "old", "new").expect("valid label rename");
    assert_eq!(tag.count(), 1);
    assert_eq!(
        tag.text(),
        r##":mb-style[hello #new [[Old]]]{unknown="#old [[Old]]"} SENTINEL"##
    );
    let link = mb_core::rewrite::rename_link_target(source, &["Old".to_string()], "New")
        .expect("valid link rename");
    assert_eq!(link.count(), 1);
    assert_eq!(
        link.text(),
        r##":mb-style[hello #old [[New]]]{unknown="#old [[Old]]"} SENTINEL"##
    );
}

#[test]
fn authored_placeholder_characters_are_not_reinterpreted() {
    let source = "%\u{2}0% :mb-style[x]{underline=\"true\"} %\u{2}0%".to_string();
    let doc = parse(&source);
    assert_eq!(
        mb_core::extract::plain_text(match &doc.blocks[0].kind {
            mb_core::BlockKind::Paragraph(c) => c,
            _ => panic!("paragraph"),
        }),
        "%\u{2}0% x %\u{2}0%"
    );
    assert_eq!(parse(&to_markdown(&doc)), doc);
}

#[test]
fn literal_inline_html_brackets_do_not_close_a_directive_label_or_execute_markup() {
    let source = r#":mb-style[before <span title="]">after</span>]{underline="true"}"#;
    let doc = parse(source);
    let html = to_html(&doc);
    assert!(html.contains("class=\"mb-underline\""), "{html}");
    assert!(
        html.contains("&lt;span title=\"]\"&gt;after&lt;/span&gt;"),
        "{html}"
    );
    assert!(!html.contains("<span title="));
    assert_eq!(parse(&to_markdown(&doc)), doc);
}

#[test]
fn mixed_inline_scopes_preserve_text_native_marks_and_atoms() {
    for source in [
        r#":mb-style[**bold** *em* ~~strike~~ ==mark== [link](https://example.test/a]b)]{underline="true" color="red"}"#,
        r#"**before :mb-style[inner]{underline="true"} after**"#,
        r#"[before :mb-style[inner]{underline="true"} after](https://example.test)"#,
        r#":mb-style[text [[Wiki#Head|alias]] #tag :berry: $x[y]$ `code]` end]{underline="true"}"#,
        r#":mb-style[\[literal\] \\ RTL مرحبا 😀]{underline="true"}"#,
        "| :mb-style[a\\|b]{underline=\"true\"} | :mb-style[c]{color=\"blue\"} |\n| --- | --- |\n| :mb-style[x<br>y]{size=\"large\"} | end |",
    ] {
        let doc = parse(source);
        let canonical = to_markdown(&doc);
        assert!(
            to_html(&doc).contains("class=\"mb-"),
            "{source:?} -> {canonical:?}"
        );
        assert!(!canonical.contains('\u{2}'), "placeholder leaked");
        assert_eq!(parse(&canonical), doc, "{source:?} -> {canonical:?}");
        assert_eq!(to_markdown(&parse(&canonical)), canonical);
    }
    let doc = parse(r#":mb-style[a [[Wiki]] #tag :berry: $x$ `code` z]{underline="true"}"#);
    let canonical = to_markdown(&doc);
    for atom in ["[[Wiki]]", "#tag", ":berry:", "$x$", "`code`"] {
        assert!(canonical.contains(atom), "{canonical}");
    }
    assert_eq!(
        mb_core::extract::plain_text(match &doc.blocks[0].kind {
            mb_core::BlockKind::Paragraph(c) => c,
            _ => panic!("paragraph"),
        }),
        "a Wiki #tag :berry: x code z"
    );
    let html = to_html(&doc);
    assert!(html.contains("</span><a class=\"mb-wikilink\""), "{html}");
}

#[test]
fn directives_inside_protected_math_and_code_remain_verbatim() {
    for source in [
        "$$\n:mb-style[x]{underline=\"true\"}\n$$\n",
        "$$:mb-style[x]{underline=\"true\"}$$\n",
        "$:mb-style[x]{underline=\"true\"}$\n",
        "`:mb-style[x]{underline=\"true\"}`\n",
        "```md\n:mb-style[x]{underline=\"true\"}\n```\n",
        "> ```md\n> :mb-style[x]{underline=\"true\"}\n> ```\n",
    ] {
        let doc = parse(source);
        let canonical = to_markdown(&doc);
        assert!(
            canonical.contains(":mb-style[x]{underline=\"true\"}"),
            "{source:?} -> {canonical:?}"
        );
        assert!(!to_html(&doc).contains("class=\"mb-underline\""));
        assert!(
            !canonical.contains('\u{2}'),
            "placeholder leaked: {canonical:?}"
        );
        assert_eq!(parse(&canonical), doc);
    }
}

#[test]
fn horizontal_attribute_separators_are_canonical_and_metadata_budget_is_literal() {
    let source = ":mb-style[KEEP]{  size=\"large\"\tbackground=\"yellow\"  color=\"red\"\tunderline=\"true\" }";
    let canonical =
        ":mb-style[KEEP]{underline=\"true\" color=\"red\" background=\"yellow\" size=\"large\"}\n";
    assert_eq!(to_markdown(&parse(source)), canonical);
    let over_budget = format!(
        ":mb-style[KEEP]{{underline=\"true\"{} }} SENTINEL",
        " ".repeat(256)
    );
    let doc = parse(&over_budget);
    assert!(!to_html(&doc).contains("mb-underline"));
    assert_eq!(
        mb_core::extract::plain_text(match &doc.blocks[0].kind {
            mb_core::BlockKind::Paragraph(c) => c,
            _ => panic!("paragraph"),
        }),
        over_budget
    );
    assert_eq!(parse(&to_markdown(&doc)), doc);
}

#[test]
fn finite_sizes_keep_all_four_dimensions_in_order() {
    for size in ["small", "large"] {
        let source = format!(
            ":mb-style[ sized ]{{size=\"{size}\" background=\"yellow\" color=\"red\" underline=\"true\"}}"
        );
        let doc = parse(&source);
        let canonical = to_markdown(&doc);
        assert_eq!(
            canonical,
            format!(
                ":mb-style[ sized ]{{underline=\"true\" color=\"red\" background=\"yellow\" size=\"{size}\"}}\n"
            )
        );
        assert!(to_html(&doc).contains(&format!("mb-size-{size}")));
        assert_eq!(parse(&canonical), doc);
    }
    for size in ["normal", "Large", "1em", "999", ""] {
        let html = to_html(&parse(&format!(
            ":mb-style[text]{{size=\"{size}\"}} SENTINEL"
        )));
        assert!(!html.contains("mb-size-"));
        assert!(html.contains("SENTINEL"));
    }
}

#[test]
fn finite_background_coexists_with_native_highlight() {
    for color in [
        "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red",
    ] {
        let source = format!(
            ":mb-style[==highlight==]{{background=\"{color}\" color=\"red\" underline=\"true\"}}"
        );
        let doc = parse(&source);
        let canonical = to_markdown(&doc);
        assert!(
            canonical.contains(&format!(
                "underline=\"true\" color=\"red\" background=\"{color}\""
            )),
            "{canonical}"
        );
        let html = to_html(&doc);
        assert!(html.contains(&format!("mb-background-{color}")), "{html}");
        assert!(html.contains("<mark>highlight</mark>"));
        assert_eq!(parse(&canonical), doc);
    }
}

#[test]
fn finite_color_is_canonical_and_safe() {
    for color in [
        "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red",
    ] {
        let source = format!(":mb-style[彩色 **bold**]{{color=\"{color}\" underline=\"true\"}}\n");
        let doc = parse(&source);
        let canonical = to_markdown(&doc);
        assert!(
            canonical.contains(&format!("underline=\"true\" color=\"{color}\"")),
            "{canonical}"
        );
        assert!(to_html(&doc).contains(&format!("mb-color-{color}")));
        assert_eq!(parse(&canonical), doc);
        assert_eq!(mb_core::canonicalize(doc.clone()), doc);
    }
    for color in ["default", "Red", "#ff0000", "url(evil)", "red\\", ""] {
        let source = format!(":mb-style[text]{{color=\"{color}\"}} SENTINEL");
        let html = to_html(&parse(&source));
        assert!(!html.contains("mb-color-"), "{html}");
        assert!(html.contains("SENTINEL"));
    }
}

#[test]
fn rejected_and_escaped_underline_stay_readable() {
    for source in [
        ":mb-style[text]{underline=\"false\"} SENTINEL",
        ":mb-style[text]{underline=\"true\" underline=\"true\"} SENTINEL",
        ":mb-style[text]{onclick=\"evil\"} SENTINEL",
        "\\:mb-style[text]{underline=\"true\"} SENTINEL",
        ":mb-style[text]{underline=\"true\" SENTINEL",
    ] {
        let doc = parse(source);
        let html = to_html(&doc);
        assert!(!html.contains("mb-underline"), "{source}: {html}");
        assert!(html.contains(":mb-style["), "{source}: {html}");
        assert!(html.contains("SENTINEL"));
        let canonical = to_markdown(&doc);
        assert_eq!(to_markdown(&parse(&canonical)), canonical, "{source}");
    }
}

#[test]
fn styled_link_with_several_text_runs_stays_one_link() {
    use mb_core::model::{Block, BlockKind, Document, Inline, MbStyleProperty};
    let link = Inline::Link {
        dest: "https://example.test".into(),
        title: None,
        content: vec![Inline::Text("0".into()), Inline::Text("'".into())],
    };
    let doc = mb_core::canonicalize(Document::new(vec![Block::new(BlockKind::Paragraph(vec![
        Inline::MbStyle {
            property: MbStyleProperty::Underline,
            content: vec![link],
        },
    ]))]));
    assert_eq!(
        to_markdown(&doc),
        ":mb-style[[0'](https://example.test)]{underline=\"true\"}\n"
    );
}

fn underlined(inline: mb_core::model::Inline) -> String {
    use mb_core::model::{Block, BlockKind, Document, Inline, MbStyleProperty};
    to_markdown(&mb_core::canonicalize(Document::new(vec![Block::new(
        BlockKind::Paragraph(vec![Inline::MbStyle {
            property: MbStyleProperty::Underline,
            content: vec![inline],
        }]),
    )])))
}

#[test]
fn redundant_inner_style_does_not_split_its_link() {
    use mb_core::model::{Inline, MbStyleProperty};
    let link = Inline::Link {
        dest: "u".into(),
        title: None,
        content: vec![
            Inline::MbStyle {
                property: MbStyleProperty::Underline,
                content: vec![Inline::Text("x".into())],
            },
            Inline::Text("y".into()),
        ],
    };
    assert_eq!(underlined(link), ":mb-style[[xy](u)]{underline=\"true\"}\n");
}

#[test]
fn a_dropped_inexpressible_wrapper_does_not_split_its_styled_link() {
    use mb_core::model::Inline;
    let strong = Inline::Strong(vec![
        Inline::Link {
            dest: "u".into(),
            title: None,
            content: vec![
                Inline::Text("A".into()),
                Inline::Strikethrough(vec![Inline::Text("<".into())]),
            ],
        },
        Inline::Text("a".into()),
    ]);
    assert_eq!(
        underlined(strong),
        ":mb-style[**[A\\<](u)a**]{underline=\"true\"}\n"
    );
}
