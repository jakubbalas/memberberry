//! The ProseMirror schema, as Rust sees it.
//!
//! `schema.json` beside this crate's `Cargo.toml` is the cross-language contract required
//! by `SPEC.md` §5.6: M3's Tiptap schema is generated from it and M2's `yrs` walker is
//! validated against it. This module is the Rust half of that contract, and it exists in
//! three parts, each doing a job the others cannot:
//!
//! 1. [`Node`] and [`Mark`] name the schema's vocabulary as types rather than strings, so
//!    the walker cannot invent a node that the editor has never heard of.
//! 2. [`block_node`], [`inline_shape`] and [`list_item_node`] map the block model onto that
//!    vocabulary with **exhaustive** matches. Adding a `BlockKind` or `Inline` variant
//!    stops compiling here until it is given a schema node, which is what stops the two
//!    sides drifting silently.
//! 3. [`validate`] checks the constraints that neither the type system nor a ProseMirror
//!    content expression can state — a table's columns lining up, for instance.
//!
//! `tests/schema.rs` asserts that parts 1 and 2 agree with `schema.json` field by field.
//!
//! # What is *not* here
//!
//! Constraints the model already makes unrepresentable are absent on purpose, and their
//! absence is the point: a heading level outside `1..=6` needs no check because
//! [`HeadingLevel`](crate::model::HeadingLevel) cannot hold one, and a wikilink cannot have
//! an anchor kind without matching anchor text because `Option<Anchor>` carries both or
//! neither. Every rule that migrates from [`validate`] into the type system is a win.

use crate::model::{Block, BlockKind, Document, Inline, List, ListItem, Table};

/// A node type in the ProseMirror schema.
///
/// The names are `snake_case` to match `schema.json` and ProseMirror's own basic schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Node {
    Doc,
    Paragraph,
    Heading,
    BulletList,
    OrderedList,
    ListItem,
    TaskItem,
    Blockquote,
    Callout,
    CalloutTitle,
    CodeBlock,
    MathBlock,
    Divider,
    Table,
    TableRow,
    TableCell,
    Text,
    SoftBreak,
    HardBreak,
    Image,
    Wikilink,
    Tag,
    Emoji,
    InlineMath,
    FootnoteRef,
}

/// A mark type in the ProseMirror schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Mark {
    Strong,
    Em,
    Strikethrough,
    Highlight,
    Code,
    Link,
}

/// The schema group a node belongs to, if any.
///
/// `block` and `inline` are the two groups content expressions refer to. Structural nodes
/// that only ever appear under one specific parent — `list_item`, `table_row` — are in no
/// group, which is what keeps them out of `block+` positions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Group {
    Block,
    Inline,
}

impl Group {
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Block => "block",
            Self::Inline => "inline",
        }
    }
}

/// The shape of a node as the schema declares it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NodeSpec {
    pub node: Node,
    pub name: &'static str,
    pub group: Option<Group>,
    /// The ProseMirror content expression, or `None` for a leaf such as `text`.
    pub content: Option<&'static str>,
    /// Attribute names. JSON objects are unordered, so conformance compares these as a
    /// set; the order here is only for readability.
    pub attrs: &'static [&'static str],
}

/// The shape of a mark as the schema declares it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MarkSpec {
    pub mark: Mark,
    pub name: &'static str,
    pub attrs: &'static [&'static str],
}

/// Every block-level node carries the `^block-id` anchor, so that any block can be the
/// target of `![[Note#^anchor]]`.
const ANCHOR: &[&str] = &["anchor"];

impl Node {
    /// Every node in the schema, in reading order: top node, blocks, then inlines.
    pub const ALL: &'static [Self] = &[
        Self::Doc,
        Self::Paragraph,
        Self::Heading,
        Self::BulletList,
        Self::OrderedList,
        Self::ListItem,
        Self::TaskItem,
        Self::Blockquote,
        Self::Callout,
        Self::CalloutTitle,
        Self::CodeBlock,
        Self::MathBlock,
        Self::Divider,
        Self::Table,
        Self::TableRow,
        Self::TableCell,
        Self::Text,
        Self::SoftBreak,
        Self::HardBreak,
        Self::Image,
        Self::Wikilink,
        Self::Tag,
        Self::Emoji,
        Self::InlineMath,
        Self::FootnoteRef,
    ];

    #[must_use]
    pub const fn spec(self) -> NodeSpec {
        let (name, group, content, attrs): (_, _, _, &'static [&'static str]) = match self {
            Self::Doc => ("doc", None, Some("block+"), &[]),
            Self::Paragraph => ("paragraph", Some(Group::Block), Some("inline*"), ANCHOR),
            Self::Heading => (
                "heading",
                Some(Group::Block),
                Some("inline*"),
                &["level", "anchor"],
            ),
            Self::BulletList => (
                "bullet_list",
                Some(Group::Block),
                Some("(list_item | task_item)+"),
                ANCHOR,
            ),
            Self::OrderedList => (
                "ordered_list",
                Some(Group::Block),
                Some("(list_item | task_item)+"),
                &["start", "anchor"],
            ),
            Self::ListItem => ("list_item", None, Some("block*"), &[]),
            Self::TaskItem => (
                "task_item",
                None,
                Some("block*"),
                &[
                    "status",
                    "priority",
                    "created",
                    "start",
                    "scheduled",
                    "due",
                    "done",
                    "cancelled",
                    "unknown",
                ],
            ),
            Self::Blockquote => ("blockquote", Some(Group::Block), Some("block*"), ANCHOR),
            Self::Callout => (
                "callout",
                Some(Group::Block),
                Some("callout_title block*"),
                &["kind", "fold", "anchor"],
            ),
            Self::CalloutTitle => ("callout_title", None, Some("inline*"), &[]),
            Self::CodeBlock => (
                "code_block",
                Some(Group::Block),
                Some("text*"),
                &["lang", "anchor"],
            ),
            Self::MathBlock => ("math_block", Some(Group::Block), Some("text*"), ANCHOR),
            Self::Divider => ("divider", Some(Group::Block), None, ANCHOR),
            Self::Table => (
                "table",
                Some(Group::Block),
                Some("table_row+"),
                &["alignments", "anchor"],
            ),
            Self::TableRow => ("table_row", None, Some("table_cell+"), &[]),
            Self::TableCell => ("table_cell", None, Some("inline*"), &[]),
            Self::Text => ("text", Some(Group::Inline), None, &[]),
            Self::SoftBreak => ("soft_break", Some(Group::Inline), None, &[]),
            Self::HardBreak => ("hard_break", Some(Group::Inline), None, &[]),
            Self::Image => ("image", Some(Group::Inline), None, &["dest", "alt"]),
            Self::Wikilink => (
                "wikilink",
                Some(Group::Inline),
                None,
                &["target", "anchor_kind", "anchor_text", "alias", "embed"],
            ),
            Self::Tag => ("tag", Some(Group::Inline), None, &["name"]),
            Self::Emoji => ("emoji", Some(Group::Inline), None, &["shortcode"]),
            Self::InlineMath => ("inline_math", Some(Group::Inline), None, &["value"]),
            Self::FootnoteRef => ("footnote_ref", Some(Group::Inline), None, &["label"]),
        };
        NodeSpec {
            node: self,
            name,
            group,
            content,
            attrs,
        }
    }

    #[must_use]
    pub const fn name(self) -> &'static str {
        self.spec().name
    }
}

impl Mark {
    /// Every mark in the schema.
    pub const ALL: &'static [Self] = &[
        Self::Strong,
        Self::Em,
        Self::Strikethrough,
        Self::Highlight,
        Self::Code,
        Self::Link,
    ];

    #[must_use]
    pub const fn spec(self) -> MarkSpec {
        let (name, attrs): (_, &'static [&'static str]) = match self {
            Self::Strong => ("strong", &[]),
            Self::Em => ("em", &[]),
            Self::Strikethrough => ("strikethrough", &[]),
            Self::Highlight => ("highlight", &[]),
            Self::Code => ("code", &[]),
            Self::Link => ("link", &["href", "title"]),
        };
        MarkSpec {
            mark: self,
            name,
            attrs,
        }
    }

    #[must_use]
    pub const fn name(self) -> &'static str {
        self.spec().name
    }
}

/// How an [`Inline`] is represented in ProseMirror.
///
/// The split is not arbitrary: ProseMirror marks apply to a *range* of text, so anything
/// whose Markdown wraps arbitrary inline content — emphasis, links — is a mark, and
/// anything that is an indivisible unit with its own attributes — a wikilink, a tag — is an
/// atom node.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InlineShape {
    Node(Node),
    Mark(Mark),
}

/// The schema node for a block.
///
/// Exhaustive by construction: a new [`BlockKind`] variant fails to compile until it is
/// given a node here and in `schema.json`.
#[must_use]
pub const fn block_node(kind: &BlockKind) -> Node {
    match kind {
        BlockKind::Paragraph(_) => Node::Paragraph,
        BlockKind::Heading { .. } => Node::Heading,
        // why: orderedness lives on the list node, not the item, so that `1. [ ] x` — a task
        // in an ordered list — has a representation. See `schema.json`'s note on ordered_list.
        BlockKind::List(l) => {
            if l.ordered {
                Node::OrderedList
            } else {
                Node::BulletList
            }
        }
        BlockKind::Blockquote(_) => Node::Blockquote,
        BlockKind::Callout(_) => Node::Callout,
        BlockKind::CodeBlock { .. } => Node::CodeBlock,
        BlockKind::Divider => Node::Divider,
        BlockKind::Table(_) => Node::Table,
        BlockKind::MathBlock(_) => Node::MathBlock,
    }
}

/// The schema node for a list item: `task_item` when it carries task metadata.
#[must_use]
pub const fn list_item_node(item: &ListItem) -> Node {
    match item.task {
        Some(_) => Node::TaskItem,
        None => Node::ListItem,
    }
}

/// The schema node or mark for an inline.
///
/// Exhaustive by construction, as [`block_node`] is.
#[must_use]
pub const fn inline_shape(inline: &Inline) -> InlineShape {
    match inline {
        Inline::Text(_) => InlineShape::Node(Node::Text),
        Inline::Emphasis(_) => InlineShape::Mark(Mark::Em),
        Inline::Strong(_) => InlineShape::Mark(Mark::Strong),
        Inline::Strikethrough(_) => InlineShape::Mark(Mark::Strikethrough),
        Inline::Highlight(_) => InlineShape::Mark(Mark::Highlight),
        // why: a code span is text carrying the `code` mark, not an atom. That is what makes
        // two adjacent code spans merge on a round trip — a documented normalization, not a
        // bug: ProseMirror cannot represent a boundary between two identically marked runs.
        Inline::Code(_) => InlineShape::Mark(Mark::Code),
        Inline::Link { .. } => InlineShape::Mark(Mark::Link),
        Inline::Math(_) => InlineShape::Node(Node::InlineMath),
        Inline::Image { .. } => InlineShape::Node(Node::Image),
        Inline::WikiLink(_) => InlineShape::Node(Node::Wikilink),
        Inline::Tag(_) => InlineShape::Node(Node::Tag),
        Inline::Emoji(_) => InlineShape::Node(Node::Emoji),
        Inline::FootnoteRef(_) => InlineShape::Node(Node::FootnoteRef),
        Inline::SoftBreak => InlineShape::Node(Node::SoftBreak),
        Inline::HardBreak => InlineShape::Node(Node::HardBreak),
    }
}

/// A way in which a document cannot be expressed in the ProseMirror schema.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaError {
    /// Where the violation is, as a reader-friendly path: `blocks[2].items[0]`.
    pub path: String,
    pub violation: Violation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Violation {
    /// `bullet_list` and `ordered_list` are `(list_item | task_item)+`, and an empty list
    /// serializes to nothing, so it would vanish on the next parse.
    EmptyList,
    /// `bullet_list` has no `start` attribute: an unordered list has no number to preserve.
    UnorderedListWithStart { start: u64 },
    /// `ordered_list.start` is `min: 1`; Markdown has no zeroth item.
    OrderedListStartsBelowOne,
    /// JavaScript numbers cannot preserve larger integers across the y-prosemirror boundary.
    OrderedListStartExceedsSafeInteger { start: u64 },
    /// A GFM table needs at least one column; `alignments` is the column count.
    TableWithoutColumns,
    /// Every row must have exactly as many cells as there are columns. The serializer pads
    /// short rows, so a ragged table renders as a rectangular one and cannot round-trip.
    RaggedTableRow { expected: usize, found: usize },
}

impl core::fmt::Display for SchemaError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{}: {}", self.path, self.violation)
    }
}

impl core::fmt::Display for Violation {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::EmptyList => f.write_str("list has no items"),
            Self::UnorderedListWithStart { start } => {
                write!(f, "unordered list carries start = {start}")
            }
            Self::OrderedListStartsBelowOne => f.write_str("ordered list starts below 1"),
            Self::OrderedListStartExceedsSafeInteger { start } => write!(
                f,
                "ordered list start {start} exceeds JavaScript's maximum safe integer"
            ),
            Self::TableWithoutColumns => f.write_str("table has no columns"),
            Self::RaggedTableRow { expected, found } => {
                write!(f, "row has {found} cells, table has {expected} columns")
            }
        }
    }
}

// why: `SchemaError` gets a hand-written `Display` rather than `thiserror` because
// `mb-core` deliberately carries a single dependency — it is the crate compiled to wasm on
// the keystroke path — and this is the only error type in it. If a second one appears,
// reach for `thiserror` as AGENTS.md 4.2 prescribes.

/// Checks that a document can be expressed in the ProseMirror schema.
///
/// The block model is deliberately wider than the schema in places the type system cannot
/// narrow: `Vec` cannot say "non-empty", and nothing ties a table's row lengths to its
/// column count. Those are the gaps this closes.
///
/// Every violation is reported, not just the first, because the caller that matters is the
/// M2 sync boundary rejecting a malformed client document — and a boundary that reports one
/// problem at a time makes for a bad debugging session on the other side of a network.
///
/// [`canonical::document`](crate::canonical::document) always produces a valid document, so
/// anything that has been through the parser or the normalizer passes.
///
/// # Errors
///
/// Returns every [`SchemaError`] found, in document order.
pub fn validate(doc: &Document) -> Result<(), Vec<SchemaError>> {
    let mut errors = Vec::new();
    validate_blocks(&doc.blocks, "blocks", &mut errors);
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

fn validate_blocks(items: &[Block], path: &str, errors: &mut Vec<SchemaError>) {
    for (i, b) in items.iter().enumerate() {
        validate_block(b, &format!("{path}[{i}]"), errors);
    }
}

fn validate_block(b: &Block, path: &str, errors: &mut Vec<SchemaError>) {
    match &b.kind {
        BlockKind::List(l) => validate_list(l, path, errors),
        BlockKind::Table(t) => validate_table(t, path, errors),
        BlockKind::Blockquote(inner) => validate_blocks(inner, &format!("{path}.content"), errors),
        BlockKind::Callout(c) => validate_blocks(&c.content, &format!("{path}.content"), errors),
        BlockKind::Paragraph(_)
        | BlockKind::Heading { .. }
        | BlockKind::CodeBlock { .. }
        | BlockKind::Divider
        | BlockKind::MathBlock(_) => {}
    }
}

fn validate_list(l: &List, path: &str, errors: &mut Vec<SchemaError>) {
    let push = |errors: &mut Vec<SchemaError>, violation| {
        errors.push(SchemaError {
            path: path.to_string(),
            violation,
        });
    };
    if l.items.is_empty() {
        push(errors, Violation::EmptyList);
    }
    if l.ordered {
        if l.start == 0 {
            push(errors, Violation::OrderedListStartsBelowOne);
        } else if l.start > 9_007_199_254_740_991 {
            push(
                errors,
                Violation::OrderedListStartExceedsSafeInteger { start: l.start },
            );
        }
    } else if l.start != 1 {
        push(errors, Violation::UnorderedListWithStart { start: l.start });
    }
    for (i, item) in l.items.iter().enumerate() {
        validate_blocks(&item.content, &format!("{path}.items[{i}]"), errors);
    }
}

fn validate_table(t: &Table, path: &str, errors: &mut Vec<SchemaError>) {
    let cols = t.alignments.len();
    if cols == 0 {
        errors.push(SchemaError {
            path: path.to_string(),
            violation: Violation::TableWithoutColumns,
        });
        return;
    }
    // The header is row 0 of `table_row+`, so it is checked exactly like any other row.
    for (i, row) in core::iter::once(&t.head).chain(t.rows.iter()).enumerate() {
        if row.len() != cols {
            errors.push(SchemaError {
                path: format!("{path}.rows[{i}]"),
                violation: Violation::RaggedTableRow {
                    expected: cols,
                    found: row.len(),
                },
            });
        }
    }
}
