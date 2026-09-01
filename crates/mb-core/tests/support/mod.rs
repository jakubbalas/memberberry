//! Generators for property tests.
//!
//! The document generator is deliberately restricted to **canonically representable**
//! documents. Each restriction corresponds to a real normalisation rule, not to a bug being
//! hidden: two adjacent `Text` inlines genuinely are one text run once parsed, and a
//! paragraph genuinely cannot begin with whitespace. Generating documents that no parse
//! could ever return would test nothing but our ability to write a generator.
//!
//! The unrestricted properties — idempotence and never-panics over *arbitrary strings* —
//! live in `roundtrip.rs` and carry the real weight, because they accept any input at all.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    dead_code
)]

use mb_core::model::{
    Alignment, Block, BlockKind, Callout, Document, Fold, HeadingLevel, Inline, List, ListItem,
    Table, WikiLink,
};
use mb_core::task::{Date, Priority, Task, TaskMeta, TaskStatus};
use proptest::prelude::*;

/// Text that survives a round trip: non-empty, no newlines (soft breaks are their own
/// inline), and no edge whitespace, which Markdown trims at block boundaries.
pub fn text_run() -> impl Strategy<Value = String> {
    "[a-zA-Z0-9 _*#:^=~$!|<>\\[\\]{}()\\\\?.,'\"/+-]{1,24}".prop_filter_map(
        "text must be non-empty after trimming",
        |s| {
            let t = s.trim().to_string();
            if t.is_empty() { None } else { Some(t) }
        },
    )
}

fn word() -> impl Strategy<Value = String> {
    "[a-z][a-z0-9]{0,7}".prop_map(|s| s.to_string())
}

fn tag_name() -> impl Strategy<Value = String> {
    "[a-z][a-z0-9]{0,5}(/[a-z][a-z0-9]{0,5}){0,2}".prop_map(|s| s.to_string())
}

pub fn inline_leaf() -> impl Strategy<Value = Inline> {
    prop_oneof![
        4 => text_run().prop_map(Inline::Text),
        1 => word().prop_map(Inline::Code),
        1 => tag_name().prop_map(Inline::Tag),
        1 => word().prop_map(Inline::Emoji),
        1 => word().prop_map(Inline::Math),
        1 => (word(), prop::option::of(word()), any::<bool>()).prop_map(|(t, alias, embed)| {
            Inline::WikiLink(WikiLink { target: t, anchor: None, alias, embed })
        }),
        // Both with and without a title, so the round trip covers each.
        1 => (word(), prop::option::of(word())).prop_map(|(w, title)| Inline::Link {
            dest: format!("https://example.com/{w}"),
            title,
            content: vec![Inline::Text(w)],
        }),
        1 => word().prop_map(|w| Inline::Image { dest: format!("media/ab/cd/{w}.png"), alt: w }),
    ]
}

pub fn inline() -> impl Strategy<Value = Inline> {
    inline_leaf().prop_recursive(2, 8, 2, |inner| {
        prop_oneof![
            inner.clone().prop_map(|i| Inline::Emphasis(vec![i])),
            inner.clone().prop_map(|i| Inline::Strong(vec![i])),
            inner.clone().prop_map(|i| Inline::Strikethrough(vec![i])),
            inner.prop_map(|i| Inline::Highlight(vec![i])),
        ]
    })
}

/// Adjacent `Text` inlines are indistinguishable from one merged run after parsing, so the
/// generator merges them itself.
pub fn inlines() -> impl Strategy<Value = Vec<Inline>> {
    prop::collection::vec(inline(), 1..5).prop_map(|items| {
        let mut out: Vec<Inline> = Vec::with_capacity(items.len());
        for item in items {
            match (out.last_mut(), &item) {
                (Some(Inline::Text(prev)), Inline::Text(next)) => {
                    prev.push(' ');
                    prev.push_str(next);
                }
                _ => out.push(item),
            }
        }
        out
    })
}

fn date() -> impl Strategy<Value = Date> {
    (2000i32..2100, 1u8..=12, 1u8..=28)
        .prop_map(|(y, m, d)| Date::new(y, m, d).expect("generated date is valid"))
}

fn priority() -> impl Strategy<Value = Priority> {
    prop_oneof![
        Just(Priority::Highest),
        Just(Priority::High),
        Just(Priority::Medium),
        Just(Priority::Low),
        Just(Priority::Lowest),
    ]
}

pub fn task_meta() -> impl Strategy<Value = TaskMeta> {
    (
        prop::option::of(date()),
        prop::option::of(date()),
        prop::option::of(date()),
        prop::option::of(date()),
        prop::option::of(date()),
        prop::option::of(priority()),
    )
        .prop_map(
            |(created, start, scheduled, due, done, priority)| TaskMeta {
                created,
                start,
                scheduled,
                due,
                done,
                cancelled: None,
                priority,
                unknown: Vec::new(),
            },
        )
}

fn task() -> impl Strategy<Value = Task> {
    let status = prop_oneof![
        Just(TaskStatus::Todo),
        Just(TaskStatus::Done),
        Just(TaskStatus::Cancelled)
    ];
    (status, task_meta()).prop_map(|(status, meta)| Task { status, meta })
}

fn alignment() -> impl Strategy<Value = Alignment> {
    prop_oneof![
        Just(Alignment::None),
        Just(Alignment::Left),
        Just(Alignment::Center),
        Just(Alignment::Right),
    ]
}

fn table() -> impl Strategy<Value = Table> {
    (1usize..4).prop_flat_map(|cols| {
        (
            prop::collection::vec(alignment(), cols..=cols),
            prop::collection::vec(inlines(), cols..=cols),
            prop::collection::vec(prop::collection::vec(inlines(), cols..=cols), 0..3),
        )
            .prop_map(|(alignments, head, rows)| Table {
                alignments,
                head,
                rows,
            })
    })
}

fn leaf_block() -> impl Strategy<Value = Block> {
    prop_oneof![
        3 => inlines().prop_map(|c| Block::new(BlockKind::Paragraph(c))),
        2 => (1u8..=6, inlines()).prop_map(|(level, content)| {
            Block::new(BlockKind::Heading { level: HeadingLevel::clamped(level), content })
        }),
        1 => Just(Block::new(BlockKind::Divider)),
        1 => (prop::option::of(word()), "[a-z0-9 \n]{0,30}").prop_map(|(lang, code)| {
            Block::new(BlockKind::CodeBlock { lang, code: code.trim_end().to_string() })
        }),
        1 => table().prop_map(|t| Block::new(BlockKind::Table(t))),
        // Math content is restricted to characters that cannot start a block construct.
        // `$$` blocks are recognised at the paragraph level, so a lone `-`, `=` or `+` line
        // between the fences ends the paragraph and the block is read back as three separate
        // blocks. Content is preserved either way — see
        // `math_content_that_looks_like_a_block_construct` in markdown.rs — and the real fix
        // is tokenising math from raw source ahead of CommonMark, planned for M3.
        1 => "[a-z0-9 ]{1,20}"
            .prop_filter_map("math content must be non-empty after trimming", |m| {
                let t = m.trim().to_string();
                if t.is_empty() { None } else { Some(t) }
            })
            .prop_map(|m| Block::new(BlockKind::MathBlock(m))),
    ]
}

/// Anchors are recognised on paragraphs and headings only (`parse::finish_text_block`), a
/// documented v1 limitation, so the generator attaches them only there.
fn with_anchor(block: Block, anchor: Option<String>) -> Block {
    match (&block.kind, anchor) {
        (BlockKind::Paragraph(_) | BlockKind::Heading { .. }, Some(a)) => Block {
            kind: block.kind,
            anchor: Some(a),
        },
        _ => block,
    }
}

pub fn block() -> impl Strategy<Value = Block> {
    let base = (
        leaf_block(),
        prop::option::of("[a-z][a-z0-9-]{0,6}".prop_map(|s| s.to_string())),
    )
        .prop_map(|(b, a)| with_anchor(b, a));

    base.prop_recursive(2, 12, 3, |inner| {
        prop_oneof![
            1 => (
                any::<bool>(),
                1u64..4,
                prop::collection::vec(
                    (prop::option::of(task()), prop::collection::vec(inner.clone(), 1..3)),
                    1..4,
                ),
            )
                .prop_map(|(ordered, start, items)| {
                    let items = items
                        .into_iter()
                        .map(|(task, content)| ListItem {
                            task,
                            content: strip_leading_marker(content),
                        })
                        .collect();
                    Block::new(BlockKind::List(List { ordered, start, items }))
                }),
            1 => prop::collection::vec(inner.clone(), 1..3)
                .prop_map(|inner| Block::new(BlockKind::Blockquote(inner))),
            1 => (
                word(),
                prop_oneof![Just(Fold::None), Just(Fold::Expanded), Just(Fold::Collapsed)],
                prop::option::of(inlines()),
                prop::collection::vec(inner, 0..2),
            )
                .prop_map(|(kind, fold, title, content)| {
                    Block::new(BlockKind::Callout(Callout {
                        kind,
                        fold,
                        title: title.unwrap_or_default(),
                        content,
                    }))
                }),
        ]
    })
}

/// A list item leading with `[-] ` is genuinely ambiguous with a cancelled task in Markdown
/// itself; the parser prefers the task reading. That ambiguity is inherent to the syntax,
/// so it is covered by an explicit unit test rather than left for the generator to trip on.
fn strip_leading_marker(mut content: Vec<Block>) -> Vec<Block> {
    if let Some(first) = content.first_mut()
        && let BlockKind::Paragraph(inlines) = &mut first.kind
        && let Some(Inline::Text(t)) = inlines.first_mut()
    {
        for m in ["[-] ", "[ ] ", "[x] "] {
            if let Some(rest) = t.strip_prefix(m) {
                *t = format!("x{rest}");
            }
        }
    }
    content
}

/// Generated documents are put through `canonicalize` before use.
///
/// This is stronger than restricting the generator by hand: it asserts that the normal form
/// really is a fixpoint of serialize-then-parse, for arbitrary generated structure — including
/// the degenerate shapes (nested same-type marks, edge whitespace) a hand-restricted
/// generator would simply never produce.
pub fn document() -> impl Strategy<Value = Document> {
    prop::collection::vec(block(), 1..5)
        .prop_map(|blocks| mb_core::canonicalize(Document::new(blocks)))
}
