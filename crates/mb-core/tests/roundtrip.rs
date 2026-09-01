//! The foundation suite (`SPEC.md` §22.1).
//!
//! `AGENTS.md` §2.4 forbids weakening these. If one fails, the serializer or the escaper is
//! wrong and a user's file would be corrupted on their next keystroke — never the test.
//!
//! ## Soak status
//!
//! Green at the 512 cases below, at `PROPTEST_CASES=20000`, and at `PROPTEST_CASES=100000`:
//!
//! ```text
//! PROPTEST_CASES=100000 cargo test -p mb-core --test roundtrip --release
//! ```
//!
//! The flanking corner that used to surface at 100k is closed. `canonical::class` now looks
//! up Unicode general categories exactly instead of approximating them, which is what
//! `pulldown-cmark` does — two approximations were tried first and the suite rejected both
//! (`is_ascii_punctuation` misses `¡`; "not alphanumeric" wrongly claims `U+E000`).
//!
//! ## Fuzzing
//!
//! These properties are also driven by libFuzzer — `make fuzz`, targets in `fuzz/`. It
//! reaches corners the generators do not, and found seven real convergence defects that the
//! suite below had not: empty and block-construct math bodies, a heading ending in `#`,
//! escaped `$$` fences being read as math, a math body holding `$…$`, a code block's
//! trailing blank line, math body indentation, and two code-fence info-string bugs. Every
//! one has a named regression test in `markdown.rs`.
//!
//! One finding is **not** fixed, because it is not ours: `pulldown-cmark` 0.13.4 panics on
//! `"- [8]:q\n      "`. See `SPEC.md` §22.1 — `make fuzz TARGET=parse` will rediscover it
//! within minutes, which is intended until there is an upstream fix to move to.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

mod support;

use mb_core::{normalize, parse, to_markdown};
use proptest::prelude::*;

proptest! {
    #![proptest_config(ProptestConfig { cases: 512, ..ProptestConfig::default() })]

    /// `canonicalize` must reach a fixpoint in one call. If it does not, every other property
    /// here becomes untrustworthy: the "expected" document would itself be unreachable.
    #[test]
    fn canonicalize_is_idempotent(doc in support::document()) {
        let again = mb_core::canonicalize(doc.clone());
        prop_assert_eq!(&again.blocks, &doc.blocks, "canonicalize did not reach a fixpoint");
    }

    /// The core contract: rendering a document and reading it back yields the same document.
    #[test]
    fn parse_of_serialize_is_identity(doc in support::document()) {
        let markdown = to_markdown(&doc);
        let reparsed = parse(&markdown);
        prop_assert_eq!(
            &reparsed.blocks,
            &doc.blocks,
            "round trip diverged\n--- markdown ---\n{}\n--- expected ---\n{:#?}\n--- got ---\n{:#?}",
            markdown,
            doc.blocks,
            reparsed.blocks
        );
    }

    /// Normalisation converges in one pass, over **arbitrary** input — no generator
    /// restrictions at all. This is what makes the one-time git diff in SPEC 4.5 one-time.
    #[test]
    fn normalize_is_idempotent_for_any_string(input in ".{0,400}") {
        let once = normalize(&input);
        let twice = normalize(&once);
        prop_assert_eq!(&once, &twice, "normalisation did not converge for input {:?}", input);
    }

    /// Same property, over input shaped like real Markdown so the interesting paths are hit.
    #[test]
    fn normalize_is_idempotent_for_markdown_soup(input in markdown_soup()) {
        let once = normalize(&input);
        let twice = normalize(&once);
        prop_assert_eq!(&once, &twice, "normalisation did not converge for input {:?}", input);
    }

    /// Totality: parsing must never panic, hang, or reject. `mb-core` is compiled into the
    /// browser, so a panic here is a crashed editor with unsaved work.
    #[test]
    fn parse_never_panics(input in ".{0,600}") {
        let doc = parse(&input);
        let _ = to_markdown(&doc);
        let _ = mb_core::extract(&doc);
    }

    #[test]
    fn parse_never_panics_on_markdown_soup(input in markdown_soup()) {
        let doc = parse(&input);
        let _ = to_markdown(&doc);
        let _ = mb_core::extract(&doc);
    }

    /// Anything the parser produces must be expressible in the ProseMirror schema.
    ///
    /// This is the property that keeps `schema.json` honest against real input rather than
    /// against hand-written examples. A note that parses into a document the editor cannot
    /// represent is a note that cannot be opened — over arbitrary input, including input no
    /// one would write on purpose.
    #[test]
    fn parse_output_is_always_schema_valid(input in ".{0,600}") {
        let doc = parse(&input);
        prop_assert_eq!(mb_core::schema::validate(&doc), Ok(()), "input {:?}", input);
    }

    #[test]
    fn parse_output_is_always_schema_valid_for_markdown_soup(input in markdown_soup()) {
        let doc = parse(&input);
        prop_assert_eq!(mb_core::schema::validate(&doc), Ok(()), "input {:?}", input);
    }

    /// The same guarantee for the *other* way into the model. The editor and the CRDT layer
    /// construct documents directly rather than by parsing, and canonicalization is the
    /// single funnel they pass through — so it, not just the parser, has to land in the
    /// schema.
    #[test]
    fn canonicalize_output_is_always_schema_valid(doc in support::document()) {
        let canonical = mb_core::canonicalize(doc);
        prop_assert_eq!(mb_core::schema::validate(&canonical), Ok(()));
    }

    /// Serialized output is always exactly one trailing newline, never zero or two (§4.5).
    #[test]
    fn output_ends_with_single_newline(doc in support::document()) {
        let out = to_markdown(&doc);
        prop_assert!(out.ends_with('\n'), "missing trailing newline: {:?}", out);
        prop_assert!(!out.ends_with("\n\n"), "multiple trailing newlines: {:?}", out);
    }

    /// No line may carry trailing whitespace (§4.5) — it produces noisy diffs and some
    /// editors strip it, which would make files churn between clients.
    ///
    /// Fenced code block interiors are exempt: whitespace there is *content*, and preserving
    /// it byte-for-byte matters more than tidy diffs. `code_block_trailing_space_is_content`
    /// in `markdown.rs` asserts that preservation directly.
    #[test]
    fn output_has_no_trailing_whitespace_outside_code(doc in support::document()) {
        let out = to_markdown(&doc);
        let mut in_fence = false;
        for (n, line) in out.lines().enumerate() {
            let bare = strip_container_prefix(line);
            if bare.starts_with("```") {
                in_fence = !in_fence;
                continue;
            }
            if in_fence {
                continue;
            }
            prop_assert_eq!(
                line.trim_end(), line,
                "line {} has trailing whitespace in:\n{}", n + 1, out
            );
        }
    }
}

/// Strips quote, list and task-marker prefixes so a fence nested inside containers is still
/// recognised as a fence. Written as a loop rather than a character class because `- [ ] ```
/// contains characters that are meaningful on their own.
fn strip_container_prefix(line: &str) -> &str {
    let mut rest = line;
    loop {
        let start = rest;
        rest = rest.trim_start_matches([' ', '\t']);
        if let Some(r) = rest.strip_prefix('>') {
            rest = r;
        }
        for marker in ["- ", "* ", "+ "] {
            if let Some(r) = rest.strip_prefix(marker) {
                rest = r;
                break;
            }
        }
        // Ordered markers carry an arbitrary number: `2. `, `10) `.
        let digits = rest.chars().take_while(char::is_ascii_digit).count();
        if digits > 0 {
            let after = rest.get(digits..).unwrap_or("");
            for marker in [". ", ") "] {
                if let Some(r) = after.strip_prefix(marker) {
                    rest = r;
                    break;
                }
            }
        }
        for marker in ["[ ] ", "[x] ", "[-] "] {
            if let Some(r) = rest.strip_prefix(marker) {
                rest = r;
                break;
            }
        }
        if rest == start {
            return rest;
        }
    }
}

/// Fragments of real Markdown, assembled randomly. Far more likely to hit parser corners
/// than uniform random text, which is almost always inert prose.
fn markdown_soup() -> impl Strategy<Value = String> {
    let fragment = prop_oneof![
        Just("# Heading".to_string()),
        Just("###### deep".to_string()),
        Just("- item".to_string()),
        Just("- [ ] task 📅 2026-09-05 ⏫".to_string()),
        Just("- [x] done ✅ 2026-08-28".to_string()),
        Just("- [-] cancelled".to_string()),
        Just("1. first".to_string()),
        Just("> quoted".to_string()),
        Just("> [!note] Title".to_string()),
        Just("> [!warning]- Folded".to_string()),
        Just("```rust\nfn main() {}\n```".to_string()),
        Just("| a | b |\n| --- | :-: |\n| 1 | 2 |".to_string()),
        Just("---".to_string()),
        Just("$$\nx = 1\n$$".to_string()),
        Just("text with [[Wiki Link]] and ![[Embed#Heading]]".to_string()),
        Just("![[Note#^block-id]] plus #tag/nested".to_string()),
        Just("**bold** _em_ ~~strike~~ ==highlight== `code` $x^2$".to_string()),
        Just(":shortcode: and 🎉 literal".to_string()),
        Just("anchored paragraph ^my-anchor".to_string()),
        Just("![alt](media/ab/cd/hash.png)".to_string()),
        Just("[link](https://example.com)".to_string()),
        Just("a\\*escaped\\* \\#nottag \\[\\[notlink\\]\\]".to_string()),
        Just("<div>raw html</div>".to_string()),
        Just("   ".to_string()),
        Just(String::new()),
    ];
    prop::collection::vec(fragment, 0..8).prop_map(|parts| parts.join("\n\n"))
}
