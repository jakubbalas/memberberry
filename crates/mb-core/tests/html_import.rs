//! HTML clipper conversion tests.

#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::unwrap_used
)]

use mb_core::{BlockKind, Inline, from_html, to_markdown};

#[test]
fn imports_body_blocks_and_nested_inline_content() {
    let document = from_html(
        "<html><head><title>ignored</title></head><body><h1>Heading</h1><p>Hello <strong>world</strong>.</p><ul><li>one</li><li>two</li></ul></body></html>",
    );
    assert!(
        matches!(
            document.blocks.first().map(|block| &block.kind),
            Some(BlockKind::Heading { .. })
        ),
        "{document:?}"
    );
    assert!(matches!(document.blocks[1].kind, BlockKind::Paragraph(_)));
    assert!(matches!(document.blocks[2].kind, BlockKind::List(_)));
    assert_eq!(
        to_markdown(&document),
        "# Heading\n\nHello **world**.\n\n- one\n- two\n"
    );
}

#[test]
fn imports_links_images_and_entities_without_emitting_raw_html() {
    let document = from_html(
        "<p>A &amp; B <a href='https://example.test/?a=1&amp;b=2' title='tip'>link</a> <img src='image.png' alt='A &lt; B'></p>",
    );
    let BlockKind::Paragraph(content) = &document.blocks[0].kind else {
        panic!("paragraph")
    };
    assert!(
        content
            .iter()
            .any(|item| matches!(item, Inline::Link { dest, .. } if dest.contains("&b=2")))
    );
    assert!(
        content
            .iter()
            .any(|item| matches!(item, Inline::Image { alt, .. } if alt == "A < B"))
    );
    assert_eq!(
        to_markdown(&document),
        "A & B [link](https://example.test/?a=1&b=2 \"tip\") ![A < B](image.png)\n"
    );
}

#[test]
fn drops_executable_elements_and_treats_unknown_tags_as_containers() {
    let document =
        from_html("<script>alert(1)</script><p>safe <custom>text</custom></p><style>.x{}</style>");
    assert_eq!(to_markdown(&document), "safe text\n");
    assert!(!to_markdown(&document).contains("alert"));
}

#[test]
fn drops_an_unclosed_executable_element_with_all_remaining_content() {
    let document = from_html("<p>safe</p><script>alert(1)");
    assert_eq!(to_markdown(&document), "safe\n");
}

#[test]
fn preserves_list_item_text_before_a_nested_list() {
    let document = from_html("<ul><li>parent<ul><li>child</li></ul></li></ul>");
    assert_eq!(to_markdown(&document), "- parent\n\n  - child\n");
}

#[test]
fn tolerates_unclosed_tags_and_decodes_numeric_entities() {
    let document = from_html("<p>broken &copy; &#x1F600;");
    assert_eq!(to_markdown(&document), "broken &copy; 😀\n");
}

fn imported(html: &str) -> String {
    to_markdown(&from_html(html))
}

#[test]
fn a_less_than_sign_not_followed_by_a_tag_name_is_text() {
    assert_eq!(
        imported("<p>a < b and c > d</p>"),
        imported("<p>a &lt; b and c &gt; d</p>")
    );
}

#[test]
fn an_empty_tag_is_text_and_an_empty_end_tag_is_ignored() {
    assert_eq!(
        imported("<p><>empty tag</></p>"),
        imported("<p>&lt;&gt;empty tag</p>")
    );
}

#[test]
fn comments_doctypes_and_processing_instructions_leave_no_trace() {
    assert_eq!(
        imported("<!DOCTYPE html><?xml version=\"1.0\"?><p>keep<!-- hidden --> me</p>"),
        "keep me\n"
    );
}

#[test]
fn an_unterminated_comment_ends_the_import_without_inventing_content() {
    assert_eq!(
        imported("<p>before</p><!-- never closed <p>after</p>"),
        "before\n"
    );
}

#[test]
fn script_style_and_template_contents_are_never_imported() {
    assert_eq!(
        imported(
            "<p>x<script>alert('<p>no</p>')</script>y</p><style>p{}</style><template><p>t</p></template>"
        ),
        "xy\n"
    );
    assert_eq!(imported("<p>a<script>unterminated <p>gone</p>"), "a\n");
}

#[test]
fn unclosed_and_stray_tags_keep_their_text() {
    assert_eq!(
        imported("<p>open <em>never closed"),
        "open *never closed*\n"
    );
    assert_eq!(imported("<p>stray</div> text</p>"), "stray text\n");
}

#[test]
fn unquoted_single_quoted_and_valueless_attributes_are_read() {
    assert_eq!(
        imported("<p><a href=https://example.com/x>unquoted</a></p>"),
        "[unquoted](https://example.com/x)\n"
    );
    assert_eq!(
        imported("<p><a href='single'>single</a></p>"),
        "[single](single)\n"
    );
    // A bare attribute is the empty string in HTML; an explicit empty title is kept (§4.2).
    assert_eq!(
        imported("<p><a href=x title>bare</a></p>"),
        "[bare](x \"\")\n"
    );
}

#[test]
fn preformatted_rules_and_quotes_become_blocks_and_empty_quotes_vanish() {
    assert_eq!(
        imported(
            "<pre>let x = 1;\n  y</pre><hr><blockquote><p>quoted</p></blockquote><blockquote></blockquote>"
        ),
        "```\nlet x = 1;\n  y\n```\n\n***\n\n> quoted\n"
    );
}
