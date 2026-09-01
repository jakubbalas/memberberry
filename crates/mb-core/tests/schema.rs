//! Cross-language schema conformance, Rust half (`SPEC.md` §22.2).
//!
//! `schema.json` is the contract between the `yrs` walker in Rust (M2) and the Tiptap
//! schema in TypeScript (M3). Nothing at runtime reads the file, so nothing at runtime
//! would notice the two drifting apart — which is exactly why the drift is caught here
//! instead, at the only moment both halves are visible at once.
//!
//! These tests are cheap to satisfy and expensive to skip. A node added to `schema.json`
//! and forgotten in `mb_core::schema` is a block the editor can create and the server
//! cannot serialize: a note that silently loses content on save, which is a C2 violation.
//!
//! The TypeScript half — asserting the generated Tiptap schema matches the same file — is
//! M3's, and the shared `(document, Y binary, Markdown)` fixtures are M2's.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

mod support;

use std::collections::{BTreeMap, BTreeSet};

use mb_core::model::{Block, BlockKind, Document, Inline, ListItem};
use mb_core::schema::{self, InlineShape, Mark, Node};
use serde_json::Value;

/// The `schema.json` that ships with the crate.
///
/// `include_str!` rather than a path read: the contract is compiled in, so the test cannot
/// pass against a stale copy left in a working directory.
const SCHEMA_JSON: &str = include_str!("../schema.json");

fn schema() -> Value {
    serde_json::from_str(SCHEMA_JSON).expect("schema.json must be valid JSON")
}

/// Node and mark bodies may carry these alongside the fields Rust models. They are for the
/// TypeScript generator or for human readers; listing them here means a *new* key cannot be
/// introduced without someone deciding which side owns it.
const NON_RUST_KEYS: &[&str] = &[
    "$comment", "markdown", "atom", "inline", "code", "defining", "marks", "excludes",
];

fn object<'a>(v: &'a Value, key: &str) -> &'a serde_json::Map<String, Value> {
    v.get(key)
        .and_then(Value::as_object)
        .unwrap_or_else(|| panic!("schema.json must have an object at `{key}`"))
}

#[test]
fn top_node_is_doc() {
    assert_eq!(schema()["topNode"], Value::from(Node::Doc.name()));
}

#[test]
fn node_names_match_schema_json_exactly() {
    let doc = schema();
    let declared: BTreeSet<&str> = object(&doc, "nodes").keys().map(String::as_str).collect();
    let in_rust: BTreeSet<&str> = Node::ALL.iter().map(|n| n.name()).collect();
    assert_eq!(
        declared, in_rust,
        "`schema.json` nodes and `schema::Node::ALL` disagree"
    );
}

#[test]
fn mark_names_match_schema_json_exactly() {
    let doc = schema();
    let declared: BTreeSet<&str> = object(&doc, "marks").keys().map(String::as_str).collect();
    let in_rust: BTreeSet<&str> = Mark::ALL.iter().map(|m| m.name()).collect();
    assert_eq!(
        declared, in_rust,
        "`schema.json` marks and `schema::Mark::ALL` disagree"
    );
}

#[test]
fn every_node_group_matches_schema_json() {
    let doc = schema();
    let nodes = object(&doc, "nodes");
    for node in Node::ALL {
        let declared = nodes[node.name()].get("group").and_then(Value::as_str);
        let in_rust = node.spec().group.map(schema::Group::name);
        assert_eq!(declared, in_rust, "group mismatch for `{}`", node.name());
    }
}

#[test]
fn every_node_content_expression_matches_schema_json() {
    let doc = schema();
    let nodes = object(&doc, "nodes");
    for node in Node::ALL {
        let declared = nodes[node.name()].get("content").and_then(Value::as_str);
        assert_eq!(
            declared,
            node.spec().content,
            "content expression mismatch for `{}`",
            node.name()
        );
    }
}

#[test]
fn every_node_attribute_matches_schema_json_by_name() {
    let doc = schema();
    let nodes = object(&doc, "nodes");
    for node in Node::ALL {
        let declared: BTreeSet<&str> = nodes[node.name()]
            .get("attrs")
            .and_then(Value::as_object)
            .map(|a| a.keys().map(String::as_str).collect())
            .unwrap_or_default();
        assert_eq!(
            declared,
            node.spec().attrs.iter().copied().collect::<BTreeSet<_>>(),
            "attribute mismatch for node `{}`",
            node.name()
        );
    }
}

#[test]
fn every_mark_attribute_matches_schema_json_by_name() {
    let doc = schema();
    let marks = object(&doc, "marks");
    for mark in Mark::ALL {
        let declared: BTreeSet<&str> = marks[mark.name()]
            .get("attrs")
            .and_then(Value::as_object)
            .map(|a| a.keys().map(String::as_str).collect())
            .unwrap_or_default();
        assert_eq!(
            declared,
            mark.spec().attrs.iter().copied().collect::<BTreeSet<_>>(),
            "attribute mismatch for mark `{}`",
            mark.name()
        );
    }
}

#[test]
fn schema_json_carries_no_key_that_rust_silently_ignores() {
    let doc = schema();
    let known: BTreeSet<&str> = ["group", "content", "attrs"]
        .into_iter()
        .chain(NON_RUST_KEYS.iter().copied())
        .collect();
    for (kind, entries) in [
        ("node", object(&doc, "nodes")),
        ("mark", object(&doc, "marks")),
    ] {
        for (name, body) in entries {
            for key in body.as_object().expect("entry must be an object").keys() {
                assert!(
                    known.contains(key.as_str()),
                    "unrecognised key `{key}` on {kind} `{name}`: decide whether \
                     `mb_core::schema` should model it, then add it here"
                );
            }
        }
    }
}

#[test]
fn every_content_expression_names_a_node_or_group_that_exists() {
    let known: BTreeSet<&str> = Node::ALL
        .iter()
        .map(|n| n.name())
        .chain(["block", "inline"])
        .collect();
    for node in Node::ALL {
        let Some(content) = node.spec().content else {
            continue;
        };
        for token in content.split([' ', '|', '(', ')']) {
            let name = token.trim_end_matches(['+', '*', '?']);
            if name.is_empty() {
                continue;
            }
            assert!(
                known.contains(name),
                "content expression of `{}` refers to unknown `{name}`",
                node.name()
            );
        }
    }
}

#[test]
fn an_atom_node_declares_no_content() {
    let doc = schema();
    for (name, body) in object(&doc, "nodes") {
        if body.get("atom") == Some(&Value::Bool(true)) {
            assert!(
                body.get("content").is_none(),
                "`{name}` is an atom but declares content"
            );
        }
    }
}

#[test]
fn an_inline_node_is_in_the_inline_group() {
    let doc = schema();
    for (name, body) in object(&doc, "nodes") {
        if body.get("inline") == Some(&Value::Bool(true)) {
            assert_eq!(
                body.get("group").and_then(Value::as_str),
                Some("inline"),
                "`{name}` is inline but is not in the inline group"
            );
        }
    }
}

#[test]
fn every_block_level_node_can_carry_an_anchor() {
    // why: SPEC 4.4 makes any block the target of `![[Note#^anchor]]`, and the model puts
    // `anchor` on `Block` rather than on each variant. A block node without the attribute
    // would be one the editor cannot anchor — an inconsistency users would hit at random.
    for node in Node::ALL {
        let spec = node.spec();
        if spec.group == Some(schema::Group::Block) {
            assert!(
                spec.attrs.contains(&"anchor"),
                "block node `{}` has no `anchor` attribute",
                spec.name
            );
        }
    }
}

// ---------------------------------------------------------------- model coverage

/// Every node and mark the block model can produce, found by walking a document.
fn reachable(doc: &Document) -> (BTreeSet<Node>, BTreeSet<Mark>) {
    let mut nodes = BTreeSet::from([Node::Doc]);
    let mut marks = BTreeSet::new();
    walk_blocks(&doc.blocks, &mut nodes, &mut marks);
    (nodes, marks)
}

fn walk_blocks(blocks: &[Block], nodes: &mut BTreeSet<Node>, marks: &mut BTreeSet<Mark>) {
    for b in blocks {
        nodes.insert(schema::block_node(&b.kind));
        match &b.kind {
            BlockKind::Paragraph(c) | BlockKind::Heading { content: c, .. } => {
                walk_inlines(c, nodes, marks);
            }
            BlockKind::List(l) => {
                for item in &l.items {
                    nodes.insert(schema::list_item_node(item));
                    walk_blocks(&item.content, nodes, marks);
                }
            }
            BlockKind::Blockquote(inner) => walk_blocks(inner, nodes, marks),
            BlockKind::Callout(c) => {
                nodes.insert(Node::CalloutTitle);
                walk_inlines(&c.title, nodes, marks);
                walk_blocks(&c.content, nodes, marks);
            }
            BlockKind::Table(t) => {
                for row in std::iter::once(&t.head).chain(t.rows.iter()) {
                    nodes.insert(Node::TableRow);
                    for cell in row {
                        nodes.insert(Node::TableCell);
                        walk_inlines(cell, nodes, marks);
                    }
                }
            }
            BlockKind::CodeBlock { .. } | BlockKind::MathBlock(_) => {
                // `text*`, and the text is not modelled as inlines.
                nodes.insert(Node::Text);
            }
            BlockKind::Divider => {}
        }
    }
}

fn walk_inlines(inlines: &[Inline], nodes: &mut BTreeSet<Node>, marks: &mut BTreeSet<Mark>) {
    for i in inlines {
        match schema::inline_shape(i) {
            InlineShape::Node(n) => {
                nodes.insert(n);
            }
            InlineShape::Mark(m) => {
                marks.insert(m);
                // A mark applies to text, so any marked inline puts a text node in the doc.
                nodes.insert(Node::Text);
            }
        }
        match i {
            Inline::Emphasis(c)
            | Inline::Strong(c)
            | Inline::Strikethrough(c)
            | Inline::Highlight(c)
            | Inline::Link { content: c, .. } => walk_inlines(c, nodes, marks),
            _ => {}
        }
    }
}

/// Markdown exercising every block kind, every inline, and every mark.
///
/// Written as source rather than as a constructed `Document` so that it also proves the
/// parser can *reach* each node — a node no parse can produce would be a node no note can
/// contain.
const EVERY_CONSTRUCT: &str = r"# Heading

paragraph with **strong**, *em*, ~~strike~~, ==highlight==, `code`, $x^2$,
[link](https://example.com), [[Wiki|alias]], ![[Embed#^id]], #tag/nested, :shortcode:,
![alt](media/x.png), a footnote[^1] and a hard break\
after it.

- bullet
- [ ] task 📅 2026-09-05 ⏫

1. ordered

> quoted

> [!note] Callout **title**
> body

```rust
fn main() {}
```

$$
x = 1
$$

| a | b |
| :-- | --: |
| 1 | 2 |

***

[^1]: note text
";

#[test]
fn the_model_can_reach_every_node_and_mark_in_the_schema() {
    let doc = mb_core::parse(EVERY_CONSTRUCT);
    let (nodes, marks) = reachable(&doc);

    let missing_nodes: Vec<&str> = Node::ALL
        .iter()
        .filter(|n| !nodes.contains(n))
        .map(|n| n.name())
        .collect();
    assert!(
        missing_nodes.is_empty(),
        "schema nodes no document reached: {missing_nodes:?}. Either extend \
         EVERY_CONSTRUCT to produce them, or remove them from `schema.json` — an \
         unreachable node is one M2's fixtures will never cover."
    );

    let missing_marks: Vec<&str> = Mark::ALL
        .iter()
        .filter(|m| !marks.contains(m))
        .map(|m| m.name())
        .collect();
    assert!(
        missing_marks.is_empty(),
        "schema marks no document reached: {missing_marks:?}"
    );
}

#[test]
fn every_construct_survives_a_round_trip() {
    // why: the coverage test above only proves each node is *reachable*. This proves the
    // same document also round-trips, so coverage cannot be satisfied by a construct that
    // parses into something the serializer then mangles.
    let once = mb_core::normalize(EVERY_CONSTRUCT);
    assert_eq!(once, mb_core::normalize(&once));
    assert_eq!(
        mb_core::parse(&once).blocks,
        mb_core::parse(EVERY_CONSTRUCT).blocks
    );
}

#[test]
fn schema_node_names_are_snake_case_and_unique() {
    let mut seen: BTreeMap<&str, ()> = BTreeMap::new();
    for name in Node::ALL
        .iter()
        .map(|n| n.name())
        .chain(Mark::ALL.iter().map(|m| m.name()))
    {
        assert!(
            name.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
            "`{name}` is not snake_case"
        );
        assert!(
            seen.insert(name, ()).is_none(),
            "`{name}` is declared twice"
        );
    }
}

// ---------------------------------------------------------------- validation

#[test]
fn a_canonical_document_is_valid() {
    assert_eq!(
        mb_core::schema::validate(&mb_core::parse(EVERY_CONSTRUCT)),
        Ok(())
    );
}

#[test]
fn an_empty_list_is_rejected() {
    let doc = Document::new(vec![Block::new(BlockKind::List(mb_core::model::List {
        ordered: false,
        start: 1,
        items: vec![],
    }))]);
    let errors = schema::validate(&doc).unwrap_err();
    assert_eq!(errors[0].violation, schema::Violation::EmptyList);
    assert_eq!(errors[0].path, "blocks[0]");
}

#[test]
fn an_unordered_list_carrying_a_start_number_is_rejected() {
    let doc = Document::new(vec![Block::new(BlockKind::List(mb_core::model::List {
        ordered: false,
        start: 7,
        items: vec![ListItem {
            task: None,
            content: vec![],
        }],
    }))]);
    let errors = schema::validate(&doc).unwrap_err();
    assert_eq!(
        errors[0].violation,
        schema::Violation::UnorderedListWithStart { start: 7 }
    );
}

#[test]
fn an_ordered_list_starting_at_zero_is_rejected() {
    let doc = Document::new(vec![Block::new(BlockKind::List(mb_core::model::List {
        ordered: true,
        start: 0,
        items: vec![ListItem {
            task: None,
            content: vec![],
        }],
    }))]);
    let errors = schema::validate(&doc).unwrap_err();
    assert_eq!(
        errors[0].violation,
        schema::Violation::OrderedListStartsBelowOne
    );
}

#[test]
fn an_ordered_list_start_above_javascript_safe_integer_is_rejected() {
    let start = 9_007_199_254_740_992;
    let doc = Document::new(vec![Block::new(BlockKind::List(mb_core::model::List {
        ordered: true,
        start,
        items: vec![ListItem {
            task: None,
            content: vec![],
        }],
    }))]);
    let errors = schema::validate(&doc).unwrap_err();
    assert_eq!(
        errors[0].violation,
        schema::Violation::OrderedListStartExceedsSafeInteger { start }
    );
    assert!(errors[0].to_string().contains("maximum safe integer"));
}

#[test]
fn a_table_without_columns_is_rejected() {
    let doc = Document::new(vec![Block::new(BlockKind::Table(mb_core::model::Table {
        alignments: vec![],
        head: vec![],
        rows: vec![],
    }))]);
    let errors = schema::validate(&doc).unwrap_err();
    assert_eq!(errors[0].violation, schema::Violation::TableWithoutColumns);
}

#[test]
fn a_ragged_table_row_is_rejected_and_names_the_row() {
    let doc = Document::new(vec![Block::new(BlockKind::Table(mb_core::model::Table {
        alignments: vec![mb_core::model::Alignment::None; 2],
        head: vec![
            vec![Inline::Text("a".into())],
            vec![Inline::Text("b".into())],
        ],
        rows: vec![vec![vec![Inline::Text("1".into())]]],
    }))]);
    let errors = schema::validate(&doc).unwrap_err();
    assert_eq!(
        errors[0].violation,
        schema::Violation::RaggedTableRow {
            expected: 2,
            found: 1
        }
    );
    // Row 0 is the header, so the short data row is row 1.
    assert_eq!(errors[0].path, "blocks[0].rows[1]");
}

#[test]
fn validation_reports_every_violation_rather_than_only_the_first() {
    // why: the caller that matters is M2 rejecting a malformed client document across a
    // network. One error per round trip makes that debugging session miserable.
    let empty_list = || {
        Block::new(BlockKind::List(mb_core::model::List {
            ordered: false,
            start: 1,
            items: vec![],
        }))
    };
    let doc = Document::new(vec![empty_list(), empty_list(), empty_list()]);
    let errors = schema::validate(&doc).unwrap_err();
    assert_eq!(errors.len(), 3);
    assert_eq!(errors[2].path, "blocks[2]");
}

#[test]
fn violations_nested_in_a_blockquote_are_found_and_pathed() {
    let doc = Document::new(vec![Block::new(BlockKind::Blockquote(vec![Block::new(
        BlockKind::List(mb_core::model::List {
            ordered: false,
            start: 1,
            items: vec![],
        }),
    )]))]);
    let errors = schema::validate(&doc).unwrap_err();
    assert_eq!(errors[0].path, "blocks[0].content[0]");
}

#[test]
fn a_violation_renders_a_message_naming_the_place_and_the_problem() {
    let doc = Document::new(vec![Block::new(BlockKind::List(mb_core::model::List {
        ordered: false,
        start: 1,
        items: vec![],
    }))]);
    let errors = schema::validate(&doc).unwrap_err();
    assert_eq!(errors[0].to_string(), "blocks[0]: list has no items");
}
