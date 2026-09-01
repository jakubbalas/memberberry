//! YAML frontmatter (`SPEC.md` §4.2, §4.5).
//!
//! Deliberately a hand-rolled subset rather than a YAML dependency, which makes the shape
//! of what it *does not* understand the important thing to pin down. Anything unrecognised
//! must survive verbatim: frontmatter is where people keep Dataview queries, Templater
//! blocks and publishing config, and mangling one is losing the user's data just as surely
//! as dropping a paragraph.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use mb_core::frontmatter::{Frontmatter, YamlValue, parse, render, split};
use mb_core::normalize;

fn fm(body: &str) -> Frontmatter {
    parse(body)
}

/// Wraps a body in fences and normalises it, to check the whole round trip.
fn round_trip(body: &str) -> String {
    normalize(&format!("---\n{body}---\n\nbody\n"))
}

// ---------------------------------------------------------------- splitting

#[test]
fn a_document_without_a_fence_has_no_frontmatter() {
    assert_eq!(split("# Heading\n"), (None, "# Heading\n"));
}

#[test]
fn an_unterminated_fence_is_content_not_frontmatter() {
    // why: treating it as frontmatter would swallow the rest of the note.
    let input = "---\ntitle: x\n\nstill body\n";
    assert_eq!(split(input), (None, input));
}

#[test]
fn a_crlf_fence_is_recognised() {
    let (body, rest) = split("---\r\ntitle: x\r\n---\r\nbody\r\n");
    assert!(body.is_some(), "CRLF frontmatter must still be found");
    assert!(rest.contains("body"));
}

#[test]
fn an_empty_frontmatter_block_is_empty_not_absent() {
    let (body, rest) = split("---\n---\nbody\n");
    assert_eq!(body, Some(""));
    assert_eq!(rest, "body\n");
    assert!(parse("").is_empty());
}

// ---------------------------------------------------------------- known keys

#[test]
fn the_known_keys_are_lifted_into_their_fields() {
    let f = fm("id: abc\ncreated: 2026-01-01\nupdated: 2026-02-02\nicon: :rocket:\n");
    assert_eq!(f.id.as_deref(), Some("abc"));
    assert_eq!(f.created.as_deref(), Some("2026-01-01"));
    assert_eq!(f.updated.as_deref(), Some("2026-02-02"));
    assert_eq!(f.icon.as_deref(), Some(":rocket:"));
    assert!(f.extra.is_empty());
}

#[test]
fn quoted_scalars_are_unquoted_with_either_quote() {
    let f = fm("id: \"abc\"\ncreated: 'xyz'\n");
    assert_eq!(f.id.as_deref(), Some("abc"));
    assert_eq!(f.created.as_deref(), Some("xyz"));
}

#[test]
fn a_lone_quote_is_not_treated_as_a_quoted_string() {
    // `"` is one character; stripping "both ends" would panic or produce nonsense.
    assert_eq!(fm("id: \"\n").id.as_deref(), Some("\""));
}

// ---------------------------------------------------------------- lists

#[test]
fn a_flow_list_parses() {
    assert_eq!(fm("tags: [a, b, c]\n").tags, vec!["a", "b", "c"]);
}

#[test]
fn an_empty_flow_list_parses_to_no_items() {
    assert!(fm("tags: []\n").tags.is_empty());
    assert!(fm("tags: [  ]\n").tags.is_empty());
}

#[test]
fn a_flow_list_unquotes_its_items() {
    assert_eq!(
        fm("aliases: [\"one two\", 'three']\n").aliases,
        vec!["one two", "three"]
    );
}

#[test]
fn a_block_list_parses_and_is_rewritten_as_a_flow_list() {
    // Obsidian usually writes block lists; the canonical form is flow (§4.5). This is the
    // single most visible frontmatter change when normalising an existing vault.
    let f = fm("tags:\n  - alpha\n  - beta\n");
    assert_eq!(f.tags, vec!["alpha", "beta"]);
    assert_eq!(
        round_trip("tags:\n  - alpha\n  - beta\n"),
        "---\ntags: [alpha, beta]\n---\n\nbody\n"
    );
}

#[test]
fn a_block_list_item_is_unquoted() {
    assert_eq!(
        fm("aliases:\n  - \"quoted one\"\n").aliases,
        vec!["quoted one"]
    );
}

#[test]
fn a_bare_dash_is_a_list_item() {
    // `-` on its own is an empty YAML item; it must not be read as a key or as prose.
    let f = fm("tags:\n  -\n  - beta\n");
    assert_eq!(f.tags, vec!["", "beta"]);
}

#[test]
fn tags_written_as_a_bare_scalar_are_split_on_whitespace() {
    // Obsidian accepts `tags: alpha beta`. Keeping it a single tag would silently lose one.
    assert_eq!(fm("tags: alpha beta\n").tags, vec!["alpha", "beta"]);
    assert_eq!(fm("tags: alpha, beta\n").tags, vec!["alpha", "beta"]);
}

#[test]
fn a_single_alias_written_as_a_scalar_becomes_a_one_item_list() {
    assert_eq!(fm("aliases: just one\n").aliases, vec!["just one"]);
}

// ---------------------------------------------------------------- passthrough

#[test]
fn an_unknown_scalar_key_is_kept_in_extra() {
    let f = fm("publish: true\n");
    assert_eq!(
        f.extra.get("publish"),
        Some(&YamlValue::Scalar("true".into()))
    );
}

#[test]
fn an_unknown_list_key_is_kept_as_a_list() {
    let f = fm("cssclasses: [wide, dark]\n");
    assert_eq!(
        f.extra.get("cssclasses"),
        Some(&YamlValue::List(vec!["wide".into(), "dark".into()]))
    );
}

#[test]
fn a_nested_map_is_preserved_verbatim() {
    // The parser understands scalars and string lists. Anything richer is kept byte for
    // byte rather than reinterpreted — reinterpreting is how you lose someone's config.
    let body = "obsidian:\n  cssclass: wide\n  nested:\n    deeper: 1\n";
    let f = fm(body);
    let YamlValue::Raw(lines) = f.extra.get("obsidian").expect("kept") else {
        panic!(
            "a nested map must be Raw, got {:?}",
            f.extra.get("obsidian")
        );
    };
    assert_eq!(lines[0], "obsidian:");
    assert_eq!(lines.len(), 4);
    assert_eq!(round_trip(body), format!("---\n{body}---\n\nbody\n"));
}

#[test]
fn a_line_that_is_not_a_key_is_preserved_verbatim() {
    // A stray line — a Templater block, a comment, a paste accident — is content too.
    let body = "# a yaml comment\nid: abc\n";
    let f = fm(body);
    assert_eq!(f.id.as_deref(), Some("abc"));
    assert!(
        f.extra.values().any(
            |v| matches!(v, YamlValue::Raw(l) if l.iter().any(|s| s.contains("# a yaml comment")))
        ),
        "the comment must survive: {:?}",
        f.extra
    );
}

#[test]
fn a_key_with_a_space_is_not_a_key() {
    // `not a key: value` is not valid YAML mapping syntax we model; keep it verbatim.
    let f = fm("not a key: value\n");
    assert!(f.id.is_none());
    assert!(!f.extra.is_empty(), "the line must be preserved somewhere");
}

#[test]
fn blank_lines_inside_frontmatter_are_skipped() {
    let f = fm("id: abc\n\n\ncreated: x\n");
    assert_eq!(f.id.as_deref(), Some("abc"));
    assert_eq!(f.created.as_deref(), Some("x"));
}

#[test]
fn a_yaml_block_scalar_is_preserved_verbatim() {
    // `description: |` does not have the value `|` — the value is the indented block that
    // follows. Reading it as a scalar quoted the indicator and orphaned the body, producing
    // `description: "|"` with dangling lines: not valid YAML, and not what the user wrote.
    for body in [
        "description: |\n  line one\n  line two\n",
        "description: >\n  folded text\n",
        "description: |-\n  stripped\n",
        "description: |+\n  kept\n",
        "description: |2\n   indented\n",
    ] {
        let out = round_trip(body);
        assert_eq!(out, format!("---\n{body}---\n\nbody\n"), "{body:?}");
        assert_eq!(normalize(&out), out, "did not converge for {body:?}");
    }
}

#[test]
fn a_scalar_that_merely_starts_with_a_pipe_is_still_a_scalar() {
    // `a | b` is a value, not a block scalar header, and there is no indented block after it.
    assert_eq!(
        fm("k: |pipe\n").extra.get("k"),
        Some(&YamlValue::Scalar("|pipe".into()))
    );
}

// ---------------------------------------------------------------- rendering

#[test]
fn empty_frontmatter_renders_as_nothing() {
    assert_eq!(render(&Frontmatter::default()), "");
    assert!(Frontmatter::default().is_empty());
}

#[test]
fn keys_render_in_the_canonical_order() {
    // §4.5: id, created, updated, tags, aliases, icon, then user keys alphabetically.
    let body = "zebra: last\nicon: :x:\naliases: [b]\ntags: [a]\nupdated: 3\ncreated: 2\nid: 1\nalpha: first\n";
    assert_eq!(
        round_trip(body),
        "---\nid: 1\ncreated: 2\nupdated: 3\ntags: [a]\naliases: [b]\nicon: \":x:\"\nalpha: first\nzebra: last\n---\n\nbody\n"
    );
}

#[test]
fn frontmatter_with_no_body_still_renders() {
    assert_eq!(normalize("---\nid: abc\n---\n"), "---\nid: abc\n---\n");
}

#[test]
fn an_empty_list_renders_as_empty_brackets() {
    let mut f = Frontmatter::default();
    f.extra.insert("k".into(), YamlValue::List(vec![]));
    assert_eq!(render(&f), "---\nk: []\n---\n");
}

#[test]
fn normalisation_of_frontmatter_converges_in_one_pass() {
    for body in [
        "tags:\n  - a\n  - b\n",
        "obsidian:\n  nested: 1\n",
        "# comment\nid: x\n",
        "description: |\n  block\n",
        "tags: a b c\n",
        "aliases: one\n",
    ] {
        let once = round_trip(body);
        assert_eq!(normalize(&once), once, "did not converge for {body:?}");
    }
}
