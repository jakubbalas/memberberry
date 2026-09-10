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
