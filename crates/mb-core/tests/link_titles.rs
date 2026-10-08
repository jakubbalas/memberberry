//! Authored link-title presence: absent and explicitly empty are different models.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]
use mb_core::model::{Block, BlockKind, Document, Inline};
use proptest::prelude::*;

fn model(title: Option<&str>, code: bool) -> Document {
    Document::new(vec![Block::new(BlockKind::Paragraph(vec![Inline::Link {
        dest: "https://example.org".into(),
        title: title.map(str::to_owned),
        content: vec![if code {
            Inline::Code("literal".into())
        } else {
            Inline::Text("literal".into())
        }],
    }]))])
}

#[test]
fn empty_inline_and_reference_titles_keep_presence() {
    for code in [false, true] {
        let label = if code { "`literal`" } else { "literal" };
        for delimiter in ["\"\"", "''", "()"] {
            for source in [
                format!("[{label}](https://example.org {delimiter})"),
                format!("[{label}][id]\n\n[id]: https://example.org {delimiter}"),
                format!("[{label}][]\n\n[{label}]: https://example.org {delimiter}"),
            ] {
                assert_eq!(mb_core::parse(&source), model(Some(""), code), "{source:?}");
            }
        }
    }
}

#[test]
fn reference_definitions_preserve_title_presence_and_first_definition() {
    for source in [
        "[literal]\n\n[literal]: https://example.org \"\"",
        "[literal][ Label ]\n\n[label]: https://example.org ''",
        "[literal][id]\n\n[id]: https://example.org ()\n[id]: https://example.org",
    ] {
        assert_eq!(mb_core::parse(source), model(Some(""), false), "{source:?}");
    }
    assert_eq!(
        mb_core::parse(
            "[literal][id]\n\n[id]: https://example.org\n[id]: https://example.org \"\""
        ),
        model(None, false)
    );
}

#[test]
fn absent_title_and_delimiters_in_destinations_do_not_gain_titles() {
    for source in [
        "[literal](https://example.org)",
        "[literal][id]\n\n[id]: https://example.org",
        "<https://example.org>",
    ] {
        assert_eq!(
            mb_core::parse(source),
            if source.starts_with('<') {
                Document::new(vec![Block::new(BlockKind::Paragraph(vec![Inline::Link {
                    dest: "https://example.org".into(),
                    title: None,
                    content: vec![Inline::Text("https://example.org".into())],
                }]))])
            } else {
                model(None, false)
            },
            "{source:?}"
        );
    }
    for dest in ["u()", "u\"\"", "u''", "<u()>"] {
        let source = format!("[literal]({dest})");
        let doc = mb_core::parse(&source);
        match &doc.blocks[0].kind {
            BlockKind::Paragraph(c) => match &c[0] {
                Inline::Link { title, .. } => assert_eq!(title, &None, "{source}"),
                other => panic!("{other:?}"),
            },
            other => panic!("{other:?}"),
        }
    }
}

#[test]
fn empty_titles_keep_presence_in_commonmark_containers() {
    for source in [
        "> [literal](https://example.org \"\"\n> )",
        "- [literal](https://example.org \"\"\n  )",
        "# [literal](https://example.org \"\")",
        "[literal](<https://example.org>\"\")",
    ] {
        let parsed = mb_core::parse(source);
        let canonical = mb_core::to_markdown(&parsed);
        assert!(
            canonical.contains("https://example.org \"\""),
            "{source:?}: {canonical:?}"
        );
        assert_eq!(mb_core::parse(&canonical), parsed);
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 128, rng_seed: proptest::test_runner::RngSeed::Fixed(0x454d505459), ..ProptestConfig::default() })]
    #[test]
    fn semantic_title_reopen(title in prop::option::of(prop_oneof![Just(String::new()), "[a-zA-Z0-9 \\\"'()&🦀]{1,40}"]), code in any::<bool>()) {
        let expected = model(title.as_deref(), code);
        let markdown = mb_core::to_markdown(&expected);
        prop_assert_eq!(mb_core::parse(&markdown), expected);
    }
}
