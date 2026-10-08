//! Bounded styled-scope title checks; original assertions remain untouched.
use mb_core::model::{BlockKind, Inline};
fn links(items: &[Inline], out: &mut Vec<(String, Option<String>)>) {
    for item in items {
        match item {
            Inline::Link {
                dest,
                title,
                content,
            } => {
                out.push((dest.clone(), title.clone()));
                links(content, out);
            }
            Inline::Strong(c)
            | Inline::Emphasis(c)
            | Inline::Strikethrough(c)
            | Inline::Highlight(c)
            | Inline::MbStyle { content: c, .. } => links(c, out),
            _ => {}
        }
    }
}
fn check(source: &str, expected: Vec<(String, Option<String>)>) {
    let model = mb_core::parse(source);
    let canonical = mb_core::to_markdown(&model);
    let html = mb_core::html::document(&model, &mb_core::html::Urls::default());
    let mut actual = Vec::new();
    for b in &model.blocks {
        if let BlockKind::Paragraph(c) = &b.kind {
            links(c, &mut actual);
        }
    }
    println!(
        "SOURCE={source:?}\nEXPECTED_LINKS={expected:?}\nACTUAL_LINKS={actual:?}\nMODEL={model:#?}\nCANONICAL={canonical:?}\nHTML={html:?}"
    );
    assert_eq!(
        actual, expected,
        "authored whole-note link destination/title presence lost: {source:?}"
    );
    assert_eq!(
        mb_core::parse(&canonical),
        model,
        "whole-note model/source reparse drift"
    );
    assert_eq!(
        html.matches("<a ").count(),
        expected.len(),
        "rendered link count"
    );
    let expected_titles = expected.iter().filter(|(_, t)| t.is_some()).count();
    assert_eq!(
        html.matches(" title=\"").count(),
        expected_titles,
        "rendered title presence"
    );
}

#[test]
fn plain_absent() {
    check(
        r####"[literal](https://example.org)"####,
        vec![("https://example.org".into(), None)],
    );
}

#[test]
fn plain_empty() {
    check(
        r####"[literal](https://example.org "")"####,
        vec![("https://example.org".into(), Some("".into()))],
    );
}

#[test]
fn plain_nonempty() {
    check(
        r####"[literal](https://example.org "Hover")"####,
        vec![("https://example.org".into(), Some("Hover".into()))],
    );
}

#[test]
fn styled_inline_absent() {
    check(
        r####":mb-style[[literal](https://example.org)]{underline="true"}"####,
        vec![("https://example.org".into(), None)],
    );
}

#[test]
fn styled_inline_empty() {
    check(
        r####":mb-style[[literal](https://example.org "")]{underline="true"}"####,
        vec![("https://example.org".into(), Some("".into()))],
    );
}

#[test]
fn styled_inline_nonempty() {
    check(
        r####":mb-style[[literal](https://example.org "Hover")]{underline="true"}"####,
        vec![("https://example.org".into(), Some("Hover".into()))],
    );
}

#[test]
fn styled_reference_external_empty() {
    check(
        r####":mb-style[[literal][id]]{underline="true"}

[id]: https://example.org """####,
        vec![("https://example.org".into(), Some("".into()))],
    );
}

#[test]
fn mixed_reference_external_empty() {
    check(
        r####"[outside][id] :mb-style[[literal][id]]{underline="true"}

[id]: https://example.org """####,
        vec![
            ("https://example.org".into(), Some("".into())),
            ("https://example.org".into(), Some("".into())),
        ],
    );
}

#[test]
fn styled_reference_external_absent() {
    check(
        r####":mb-style[[literal][id]]{underline="true"}

[id]: https://example.org"####,
        vec![("https://example.org".into(), None)],
    );
}

#[test]
fn mixed_reference_external_absent() {
    check(
        r####"[outside][id] :mb-style[[literal][id]]{underline="true"}

[id]: https://example.org"####,
        vec![
            ("https://example.org".into(), None),
            ("https://example.org".into(), None),
        ],
    );
}

#[test]
fn styled_reference_external_nonempty() {
    check(
        r####":mb-style[[literal][id]]{underline="true"}

[id]: https://example.org "Hover""####,
        vec![("https://example.org".into(), Some("Hover".into()))],
    );
}

#[test]
fn mixed_reference_external_nonempty() {
    check(
        r####"[outside][id] :mb-style[[literal][id]]{underline="true"}

[id]: https://example.org "Hover""####,
        vec![
            ("https://example.org".into(), Some("Hover".into())),
            ("https://example.org".into(), Some("Hover".into())),
        ],
    );
}

#[test]
fn styled_reference_collapsed() {
    check(
        r####":mb-style[[literal][]]{underline="true"}

[literal]: https://example.org """####,
        vec![("https://example.org".into(), Some("".into()))],
    );
}

#[test]
fn styled_reference_shortcut() {
    check(
        r####":mb-style[[literal]]{underline="true"}

[literal]: https://example.org """####,
        vec![("https://example.org".into(), Some("".into()))],
    );
}

#[test]
fn definition_spelling_inside_scope_literal() {
    check(
        r####":mb-style[[literal][id] [id]: https://example.org ""]{underline="true"}"####,
        vec![],
    );
}

#[test]
fn styled_empty_delimiter_single() {
    check(
        r####":mb-style[[literal](https://example.org '')]{underline="true"}"####,
        vec![("https://example.org".into(), Some("".into()))],
    );
}

#[test]
fn styled_empty_delimiter_parentheses() {
    check(
        r####":mb-style[[literal](https://example.org ())]{underline="true"}"####,
        vec![("https://example.org".into(), Some("".into()))],
    );
}

#[test]
fn styled_escaped_nonempty_title() {
    check(
        r####":mb-style[[literal](https://example.org "say \"hi\" and \\ path")]{underline="true"}"####,
        vec![(
            "https://example.org".into(),
            Some("say \"hi\" and \\ path".into()),
        )],
    );
}

#[test]
fn styled_destination_parens() {
    check(
        r####":mb-style[[literal](<u()>)]{underline="true"}"####,
        vec![("u()".into(), None)],
    );
}

#[test]
fn styled_destination_double() {
    check(
        r####":mb-style[[literal](<u"">)]{underline="true"}"####,
        vec![("u\"\"".into(), None)],
    );
}

#[test]
fn styled_destination_single() {
    check(
        r####":mb-style[[literal](<u''>)]{underline="true"}"####,
        vec![("u''".into(), None)],
    );
}

#[test]
fn styled_code_label_empty() {
    check(
        r####":mb-style[[`literal`](https://example.org "")]{underline="true"}"####,
        vec![("https://example.org".into(), Some("".into()))],
    );
}

#[test]
fn literal_code_excludes_link() {
    check(
        r####":mb-style[before `[literal](u "")` after]{underline="true"}"####,
        vec![],
    );
}

#[test]
fn nested_style_native_wrappers() {
    check(
        r####":mb-style[**:mb-style[*[literal](https://example.org "")*]{color="red"}**]{underline="true"}"####,
        vec![("https://example.org".into(), Some("".into()))],
    );
}

#[test]
fn finite_underline() {
    check(
        r####":mb-style[[underline](https://example.org) [underline](https://example.org "") [underline](https://example.org "Hover")]{underline="true"}"####,
        vec![
            ("https://example.org".into(), None),
            ("https://example.org".into(), Some("".into())),
            ("https://example.org".into(), Some("Hover".into())),
        ],
    );
}

#[test]
fn finite_color_gray() {
    check(
        r####":mb-style[[color_gray](https://example.org) [color_gray](https://example.org "") [color_gray](https://example.org "Hover")]{color="gray"}"####,
        vec![
            ("https://example.org".into(), None),
            ("https://example.org".into(), Some("".into())),
            ("https://example.org".into(), Some("Hover".into())),
        ],
    );
}

#[test]
fn finite_color_brown() {
    check(
        r####":mb-style[[color_brown](https://example.org) [color_brown](https://example.org "") [color_brown](https://example.org "Hover")]{color="brown"}"####,
        vec![
            ("https://example.org".into(), None),
            ("https://example.org".into(), Some("".into())),
            ("https://example.org".into(), Some("Hover".into())),
        ],
    );
}

#[test]
fn finite_color_orange() {
    check(
        r####":mb-style[[color_orange](https://example.org) [color_orange](https://example.org "") [color_orange](https://example.org "Hover")]{color="orange"}"####,
        vec![
            ("https://example.org".into(), None),
            ("https://example.org".into(), Some("".into())),
            ("https://example.org".into(), Some("Hover".into())),
        ],
    );
}

#[test]
fn finite_color_yellow() {
    check(
        r####":mb-style[[color_yellow](https://example.org) [color_yellow](https://example.org "") [color_yellow](https://example.org "Hover")]{color="yellow"}"####,
        vec![
            ("https://example.org".into(), None),
            ("https://example.org".into(), Some("".into())),
            ("https://example.org".into(), Some("Hover".into())),
        ],
    );
}

#[test]
fn finite_color_green() {
    check(
        r####":mb-style[[color_green](https://example.org) [color_green](https://example.org "") [color_green](https://example.org "Hover")]{color="green"}"####,
        vec![
            ("https://example.org".into(), None),
            ("https://example.org".into(), Some("".into())),
            ("https://example.org".into(), Some("Hover".into())),
        ],
    );
}

#[test]
fn finite_color_blue() {
    check(
        r####":mb-style[[color_blue](https://example.org) [color_blue](https://example.org "") [color_blue](https://example.org "Hover")]{color="blue"}"####,
        vec![
            ("https://example.org".into(), None),
            ("https://example.org".into(), Some("".into())),
            ("https://example.org".into(), Some("Hover".into())),
        ],
    );
}

#[test]
fn finite_color_purple() {
    check(
        r####":mb-style[[color_purple](https://example.org) [color_purple](https://example.org "") [color_purple](https://example.org "Hover")]{color="purple"}"####,
        vec![
            ("https://example.org".into(), None),
            ("https://example.org".into(), Some("".into())),
            ("https://example.org".into(), Some("Hover".into())),
        ],
    );
}

#[test]
fn finite_color_pink() {
    check(
        r####":mb-style[[color_pink](https://example.org) [color_pink](https://example.org "") [color_pink](https://example.org "Hover")]{color="pink"}"####,
        vec![
            ("https://example.org".into(), None),
            ("https://example.org".into(), Some("".into())),
            ("https://example.org".into(), Some("Hover".into())),
        ],
    );
}

#[test]
fn finite_color_red() {
    check(
        r####":mb-style[[color_red](https://example.org) [color_red](https://example.org "") [color_red](https://example.org "Hover")]{color="red"}"####,
        vec![
            ("https://example.org".into(), None),
            ("https://example.org".into(), Some("".into())),
            ("https://example.org".into(), Some("Hover".into())),
        ],
    );
}

#[test]
fn finite_background_gray() {
    check(
        r####":mb-style[[background_gray](https://example.org) [background_gray](https://example.org "") [background_gray](https://example.org "Hover")]{background="gray"}"####,
        vec![
            ("https://example.org".into(), None),
            ("https://example.org".into(), Some("".into())),
            ("https://example.org".into(), Some("Hover".into())),
        ],
    );
}

#[test]
fn finite_background_brown() {
    check(
        r####":mb-style[[background_brown](https://example.org) [background_brown](https://example.org "") [background_brown](https://example.org "Hover")]{background="brown"}"####,
        vec![
            ("https://example.org".into(), None),
            ("https://example.org".into(), Some("".into())),
            ("https://example.org".into(), Some("Hover".into())),
        ],
    );
}

#[test]
fn finite_background_orange() {
    check(
        r####":mb-style[[background_orange](https://example.org) [background_orange](https://example.org "") [background_orange](https://example.org "Hover")]{background="orange"}"####,
        vec![
            ("https://example.org".into(), None),
            ("https://example.org".into(), Some("".into())),
            ("https://example.org".into(), Some("Hover".into())),
        ],
    );
}

#[test]
fn finite_background_yellow() {
    check(
        r####":mb-style[[background_yellow](https://example.org) [background_yellow](https://example.org "") [background_yellow](https://example.org "Hover")]{background="yellow"}"####,
        vec![
            ("https://example.org".into(), None),
            ("https://example.org".into(), Some("".into())),
            ("https://example.org".into(), Some("Hover".into())),
        ],
    );
}

#[test]
fn finite_background_green() {
    check(
        r####":mb-style[[background_green](https://example.org) [background_green](https://example.org "") [background_green](https://example.org "Hover")]{background="green"}"####,
        vec![
            ("https://example.org".into(), None),
            ("https://example.org".into(), Some("".into())),
            ("https://example.org".into(), Some("Hover".into())),
        ],
    );
}

#[test]
fn finite_background_blue() {
    check(
        r####":mb-style[[background_blue](https://example.org) [background_blue](https://example.org "") [background_blue](https://example.org "Hover")]{background="blue"}"####,
        vec![
            ("https://example.org".into(), None),
            ("https://example.org".into(), Some("".into())),
            ("https://example.org".into(), Some("Hover".into())),
        ],
    );
}

#[test]
fn finite_background_purple() {
    check(
        r####":mb-style[[background_purple](https://example.org) [background_purple](https://example.org "") [background_purple](https://example.org "Hover")]{background="purple"}"####,
        vec![
            ("https://example.org".into(), None),
            ("https://example.org".into(), Some("".into())),
            ("https://example.org".into(), Some("Hover".into())),
        ],
    );
}

#[test]
fn finite_background_pink() {
    check(
        r####":mb-style[[background_pink](https://example.org) [background_pink](https://example.org "") [background_pink](https://example.org "Hover")]{background="pink"}"####,
        vec![
            ("https://example.org".into(), None),
            ("https://example.org".into(), Some("".into())),
            ("https://example.org".into(), Some("Hover".into())),
        ],
    );
}

#[test]
fn finite_background_red() {
    check(
        r####":mb-style[[background_red](https://example.org) [background_red](https://example.org "") [background_red](https://example.org "Hover")]{background="red"}"####,
        vec![
            ("https://example.org".into(), None),
            ("https://example.org".into(), Some("".into())),
            ("https://example.org".into(), Some("Hover".into())),
        ],
    );
}

#[test]
fn finite_size_small() {
    check(
        r####":mb-style[[size_small](https://example.org) [size_small](https://example.org "") [size_small](https://example.org "Hover")]{size="small"}"####,
        vec![
            ("https://example.org".into(), None),
            ("https://example.org".into(), Some("".into())),
            ("https://example.org".into(), Some("Hover".into())),
        ],
    );
}

#[test]
fn finite_size_large() {
    check(
        r####":mb-style[[size_large](https://example.org) [size_large](https://example.org "") [size_large](https://example.org "Hover")]{size="large"}"####,
        vec![
            ("https://example.org".into(), None),
            ("https://example.org".into(), Some("".into())),
            ("https://example.org".into(), Some("Hover".into())),
        ],
    );
}

#[test]
fn finite_all_dimensions() {
    check(
        r####":mb-style[[all_dimensions](https://example.org) [all_dimensions](https://example.org "") [all_dimensions](https://example.org "Hover")]{underline="true" color="red" background="yellow" size="large"}"####,
        vec![
            ("https://example.org".into(), None),
            ("https://example.org".into(), Some("".into())),
            ("https://example.org".into(), Some("Hover".into())),
        ],
    );
}
