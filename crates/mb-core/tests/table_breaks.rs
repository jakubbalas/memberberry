use mb_core::{normalize, parse, to_markdown};
use proptest::prelude::*;

#[test]
fn table_breaks_preserve_empty_lines_and_literal_html() {
    let markdown = "| Header |\n| --- |\n| <br><br>one<br>two<br> |\n";
    assert_eq!(normalize(markdown), markdown);
    assert_eq!(
        normalize("| H |\n| --- |\n| &lt;br&gt; |\n"),
        "| H |\n| --- |\n| \\<br> |\n"
    );
    assert!(normalize("outside <br> text\n").contains("\\<br>"));
}

#[test]
fn only_bare_break_tags_gain_html_semantics_in_cells() {
    let markdown = "| H |\n| --- |\n| **one<br>two**<BR/><br />`<br>`<br onclick=evil()> |\n";
    let normalized = normalize(markdown);
    assert!(normalized.contains("**one<br>two**"));
    assert!(normalized.contains("`<br>`"));
    assert!(normalized.contains("\\<br onclick=evil()>"));
    let html = mb_core::html::document(&parse(markdown), &mb_core::html::Urls::default());
    assert!(html.contains("<br />"));
    assert!(!html.contains("<br onclick="));
    assert_eq!(normalize(&normalized), normalized);
}

proptest! {
    #![proptest_config(ProptestConfig { rng_seed: proptest::test_runner::RngSeed::Fixed(20260922), ..ProptestConfig::default() })]
    #[test]
    fn table_line_breaks_round_trip(lines in prop::collection::vec("[a-zA-Z0-9]{0,20}", 1..12)) {
        let markdown = format!("| H |\n| --- |\n| {} |\n", lines.join("<br>"));
        let parsed = parse(&markdown);
        let rendered = to_markdown(&parsed);
        prop_assert_eq!(&rendered, &markdown);
        prop_assert_eq!(parse(&rendered), parsed);
        prop_assert_eq!(normalize(&rendered), rendered);
    }
}
