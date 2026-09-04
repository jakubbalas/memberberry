//! What a `![[Note#…]]` reference names (`SPEC.md` §9.2).
//!
//! Transclusion is resolved at **render time**, never at storage time: the file keeps the
//! reference and this module says which blocks of the target that reference stands for. It
//! is the pure half of the feature — no I/O, no permissions, no recursion — so the parts
//! that can be reasoned about in isolation are.
//!
//! The impure halves live elsewhere on purpose. *Which* note a reference resolves to is a
//! per-user question answered against the readable set (`mb-index`, E9); whether the caller
//! may read it at all is `mb-server`'s (E7); and the resolution stack that stops a cycle
//! belongs with whatever is recursing, which is the client that mounts one embed inside
//! another. Slicing needs none of that, so it asks for none of it.

use unicode_normalization::UnicodeNormalization;

use crate::extract::plain_text;
use crate::model::{Anchor, Block, BlockKind, Document, ListItem};

/// The blocks `anchor` names inside `doc`, or `None` when it names nothing there.
///
/// - No anchor is the whole note.
/// - `#Heading` is that heading plus everything up to the next heading of equal or higher
///   level, which is §9.2's rule and Obsidian's.
/// - `#^block-id` is the one block carrying that id.
///
/// `None` is "this note has no such section", which a caller renders differently from "you
/// may not read this" — an absent anchor in a readable note is not a permission boundary
/// and does not have to be blurred into one.
///
/// # Examples
///
/// ```
/// # use mb_core::model::Anchor;
/// let doc = mb_core::parse("# One\n\ntext\n\n# Two\n");
/// let section = mb_core::transclude::slice(&doc, Some(&Anchor::Heading("One".into())))
///     .unwrap_or_default();
/// assert_eq!(section.len(), 2, "the heading and its paragraph, not the next section");
/// ```
#[must_use]
pub fn slice(doc: &Document, anchor: Option<&Anchor>) -> Option<Vec<Block>> {
    match anchor {
        None => Some(doc.blocks.clone()),
        Some(Anchor::Heading(heading)) => section(&doc.blocks, heading),
        Some(Anchor::Block(id)) => anchored(&doc.blocks, id).map(|block| vec![block.clone()]),
    }
}

/// One heading and everything under it, by §9.2's equal-or-higher rule.
///
/// Only top-level blocks are searched. A heading inside a blockquote or a callout is
/// quoted structure rather than a section of this note, and "everything until the next
/// heading" has no meaning for it — the enclosing block ends first.
fn section(blocks: &[Block], wanted: &str) -> Option<Vec<Block>> {
    let wanted = fold(wanted);
    let start = blocks.iter().position(|block| match &block.kind {
        BlockKind::Heading { content, .. } => fold(&plain_text(content)) == wanted,
        _ => false,
    })?;
    let level = match &blocks.get(start)?.kind {
        BlockKind::Heading { level, .. } => level.get(),
        // Unreachable by construction: `position` matched a heading. Returning rather than
        // asserting keeps the function total, which is what `mb-core` promises.
        _ => return None,
    };
    let rest = blocks.get(start + 1..).unwrap_or_default();
    let length = rest
        .iter()
        .position(|block| match &block.kind {
            BlockKind::Heading { level: next, .. } => next.get() <= level,
            _ => false,
        })
        .unwrap_or(rest.len());
    let end = start + 1 + length;
    blocks.get(start..end).map(<[Block]>::to_vec)
}

/// The first block carrying `^id`, searched depth-first with parents before children.
///
/// Pre-order, and the same order [`crate::extract`] records anchors in, so a duplicated
/// `^block-id` resolves to the same block the index indexed. A duplicate is a malformed
/// note rather than a modelled state; agreeing about which one wins is what matters.
fn anchored<'a>(blocks: &'a [Block], id: &str) -> Option<&'a Block> {
    for block in blocks {
        if block.anchor.as_deref() == Some(id) {
            return Some(block);
        }
        let found = match &block.kind {
            BlockKind::Blockquote(inner) => anchored(inner, id),
            BlockKind::Callout(callout) => anchored(&callout.content, id),
            BlockKind::List(list) => list.items.iter().find_map(|item| item_anchored(item, id)),
            _ => None,
        };
        if found.is_some() {
            return found;
        }
    }
    None
}

fn item_anchored<'a>(item: &'a ListItem, id: &str) -> Option<&'a Block> {
    anchored(&item.content, id)
}

/// Folds a heading for matching: NFC, trimmed, lowercased.
///
/// why: the two sides come from different places. The anchor was typed into a wikilink and
/// the heading was typed into the target note, possibly on a different machine, so `Café`
/// composed and `Café` decomposed are the same section — and `[[Note#overview]]` is
/// expected to find `## Overview`, as it does in Obsidian.
fn fold(value: &str) -> String {
    value.trim().nfc().collect::<String>().to_lowercase()
}
