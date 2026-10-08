//! Coordinated bounded namespace contract, exercised through public Rust APIs.
#[test]
fn bounded_namespace_roundtrips_all_dimensions_without_inline_css() {
    let source = ":mb-style[**彩色** [link](https://example.test \"\")]{size=\"large\" background=\"yellow\" color=\"red\" underline=\"true\"}";
    let model = mb_core::parse(source);
    let canonical = mb_core::to_markdown(&model);
    assert_eq!(
        canonical,
        ":mb-style[**彩色** [link](https://example.test \"\")]{underline=\"true\" color=\"red\" background=\"yellow\" size=\"large\"}\n"
    );
    assert_eq!(mb_core::parse(&canonical), model);
    let html = mb_core::html::document(&model, &mb_core::html::Urls::default());
    for class in [
        "mb-underline",
        "mb-color-red",
        "mb-background-yellow",
        "mb-size-large",
    ] {
        assert!(html.contains(class), "missing {class}: {html}");
    }
    assert!(!html.contains("style="));
}
