// why: integration tests, not library code (AGENTS.md 4.2) — a panic is the failure report.
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]
use mb_core::rewrite::{rename_link_target, rename_link_targets, rename_tag};
use std::collections::BTreeMap;

#[test]
fn rejected_labels_rename_exact_targets_preserving_metadata_and_neighbors() {
    let source = "# Title\n\n:mb-style[é #old/sub [[Old#Heading|alias]] #old [[Old]]]{unknown=\"#old [[Old]]\"} SENTINEL\n\n`#old [[Old]]`\n";
    let tags = rename_tag(source, "old", "new").expect("checked rejected label");
    assert_eq!(tags.count(), 2);
    assert_eq!(
        tags.text(),
        "# Title\n\n:mb-style[é #new/sub [[Old#Heading|alias]] #new [[Old]]]{unknown=\"#old [[Old]]\"} SENTINEL\n\n`#old [[Old]]`\n"
    );
    let links = rename_link_target(source, &["Old".into()], "New").expect("checked rejected label");
    assert_eq!(links.count(), 2);
    assert_eq!(
        links.text(),
        "# Title\n\n:mb-style[é #old/sub [[New#Heading|alias]] #old [[New]]]{unknown=\"#old [[Old]]\"} SENTINEL\n\n`#old [[Old]]`\n"
    );
    let simultaneous = rename_link_targets(source, &BTreeMap::from([("Old".into(), "New".into())]))
        .expect("same policy for simultaneous rename");
    assert_eq!(simultaneous, links);
}

#[test]
fn rejected_label_renames_exclude_code_math_and_escapes() {
    let source = ":mb-style[ok #old [[Old]] `#old [[Old]]` $x #old [[Old]]$ \\#old \\[\\[Old\\]\\]]{unknown=\"#old [[Old]]\"}";
    let tags = rename_tag(source, "old", "new").expect("protected label syntax");
    assert_eq!(tags.count(), 1);
    assert_eq!(
        tags.text(),
        ":mb-style[ok #new [[Old]] `#old [[Old]]` $x #old [[Old]]$ \\#old \\[\\[Old\\]\\]]{unknown=\"#old [[Old]]\"}"
    );
    let links = rename_link_target(source, &["Old".into()], "New").expect("protected label syntax");
    assert_eq!(links.count(), 1);
    assert_eq!(
        links.text(),
        ":mb-style[ok #old [[New]] `#old [[Old]]` $x #old [[Old]]$ \\#old \\[\\[Old\\]\\]]{unknown=\"#old [[Old]]\"}"
    );
}

#[test]
fn rejected_label_and_ordinary_targets_are_both_renamed() {
    let source = ":mb-style[#old [[Old]]]{unknown=\"#old [[Old]]\"}\n\n#old [[Old]]\n";
    assert_eq!(
        rename_tag(source, "old", "new")
            .expect("mixed source")
            .count(),
        2
    );
    assert_eq!(
        rename_link_target(source, &["Old".into()], "New")
            .expect("mixed source")
            .count(),
        2
    );
}

#[test]
fn rejected_metadata_only_is_not_a_target() {
    let source = ":mb-style[hello]{unknown=\"#old [[Old]]\"}";
    assert_eq!(
        rename_tag(source, "old", "new").expect("no target").text(),
        source
    );
    assert_eq!(
        rename_link_target(source, &["Old".into()], "New")
            .expect("no target")
            .text(),
        source
    );
}

#[test]
fn ambiguous_unclosed_and_overbudget_labels_refuse_all_writes() {
    for source in [
        ":mb-style[#old [[Old]]]{unknown=\"#old [[Old]]\"",
        ":mb-style[#old \\[[Old]]]{unknown=\"#old [[Old]]\"}",
        &format!(":mb-style[#old [[Old]]]{{unknown=\"{}\"}}", "x".repeat(257)),
    ] {
        assert!(rename_tag(source, "old", "new").is_err(), "{source}");
        assert!(
            rename_link_target(source, &["Old".into()], "New").is_err(),
            "{source}"
        );
    }
}

#[test]
fn rejected_wrapper_stays_whole_literal_after_rename() {
    use mb_core::model::{BlockKind, Inline};
    let source = ":mb-style[#old [[Old]]]{unknown=\"#old [[Old]]\"}";
    let rewritten = rename_tag(source, "old", "new").expect("bounded label");
    let doc = mb_core::parse(rewritten.text());
    assert!(
        matches!(&doc.blocks[0].kind, BlockKind::Paragraph(content) if content == &vec![Inline::Text(rewritten.text().into())])
    );
}

#[test]
fn code_wrappers_and_unmatched_names_have_no_rename_delta() {
    for source in [
        "`:mb-style[#old [[Old]]]{unknown=\"#old [[Old]]\"}`",
        "```\n:mb-style[#old [[Old]]]{unknown=\"#old [[Old]]\"}\n```\n",
        ":mb-style[#other [[Other]]]{unknown=\"#old [[Old]]\"}",
    ] {
        assert_eq!(
            rename_tag(source, "old", "new")
                .expect("no eligible target")
                .text(),
            source
        );
        assert_eq!(
            rename_link_target(source, &["Old".into()], "New")
                .expect("no eligible target")
                .text(),
            source
        );
    }
}

#[test]
fn rejected_label_rename_preserves_original_accepted_native_link_and_empty_title() {
    let source = ":mb-style[é #old [[Old]] [native](https://example.org \"\") tail]{unknown=\"#old [[Old]]\"} SENTINEL";
    let tags = rename_tag(source, "old", "new").expect("literal gaps around native owner");
    assert_eq!(tags.count(), 1);
    assert_eq!(
        tags.text(),
        ":mb-style[é #new [[Old]] [native](https://example.org \"\") tail]{unknown=\"#old [[Old]]\"} SENTINEL"
    );
    let links = rename_link_target(source, &["Old".into()], "New").expect("native owner preserved");
    assert_eq!(links.count(), 1);
    assert_eq!(
        links.text(),
        ":mb-style[é #old [[New]] [native](https://example.org \"\") tail]{unknown=\"#old [[Old]]\"} SENTINEL"
    );
}

proptest::proptest! {
    #[test]
    fn repeated_labels_preserve_exact_metadata_and_source_spans(count in 1usize..12, prefix in "[a-z]{0,20}") {
        let wrapper = ":mb-style[#old [[Old#Heading|alias]]]{unknown=\"#old [[Old]]\"}";
        let source = format!("{prefix} {} SENTINEL", vec![wrapper; count].join(" "));
        let tags = rename_tag(&source, "old", "new").expect("repeated complete labels");
        proptest::prop_assert_eq!(tags.count(), count);
        let expected = format!("{prefix} {} SENTINEL", vec![":mb-style[#new [[Old#Heading|alias]]]{unknown=\"#old [[Old]]\"}"; count].join(" "));
        proptest::prop_assert_eq!(tags.text(), expected);
        for span in tags.spans() {
            proptest::prop_assert_eq!(&source[span.start..span.end], "old");
        }
        let links = rename_link_target(&source, &["Old".into()], "New").expect("repeated complete labels");
        proptest::prop_assert_eq!(links.count(), count);
        let expected = format!("{prefix} {} SENTINEL", vec![":mb-style[#old [[New#Heading|alias]]]{unknown=\"#old [[Old]]\"}"; count].join(" "));
        proptest::prop_assert_eq!(links.text(), expected);
    }
}
