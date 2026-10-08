//! Observer-only use of the installed cfg(test) replay counter.
use super::*;
use std::cell::Cell;
fn check(source: &str, expected_links: usize) {
    super::title_probe_tests::REPLAYS.with(|n| n.set(0));
    let model = document(source);
    let before = super::title_probe_tests::REPLAYS.with(Cell::get);
    let markdown = crate::to_markdown(&model);
    println!(
        "SOURCE={source:?}\nMODEL={model:#?}\nCANONICAL={markdown:?}\nREPLAYS_AFTER_WHOLE_PARSE={before}"
    );
    assert_eq!(
        markdown.matches("https://example.org \"\"").count(),
        expected_links,
        "empty titles retained"
    );
    assert!(
        before <= 1,
        "whole-note title replay budget exceeded: {before}"
    );
}
#[test]
fn multiple_styled_labels_global_budget() {
    let source = (0..3)
        .map(|n| format!(":mb-style[[label{n}](https://example.org \"\")]{{color=\"red\"}}"))
        .collect::<Vec<_>>()
        .join(" ");
    check(&source, 3);
}
#[test]
fn nested_scopes_and_ordinary_links_global_budget() {
    check(
        ":mb-style[outer [one](https://example.org \"\") :mb-style[[two](https://example.org \"\")]{color=\"red\"}]{underline=\"true\"} [three](https://example.org \"\")",
        3,
    );
}
#[test]
fn many_ordinary_links_and_five_styles_global_budget() {
    let source = (0..10)
        .map(|n| {
            if n % 2 == 0 {
                format!(":mb-style[[label{n}](https://example.org \"\")]{{color=\"red\"}}")
            } else {
                format!("[label{n}](https://example.org \"\")")
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    check(&source, 10);
}
