use std::collections::BTreeSet;

use mb_core::model::{Block, BlockKind, Document};
use yrs::{Doc, Map, Transact, WriteTxn, XmlFragment};

use crate::decode::{CrdtError, document_from_yrs_raw};
use crate::encode::{frontmatter_entries, insert_block};
use crate::{FRONTMATTER_ROOT, PROSEMIRROR_ROOT};

/// Yjs transaction origin used for changes imported from the Markdown file.
pub const EXTERNAL_ORIGIN: &str = "external";

/// Counts of structural changes made while importing an external edit.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ExternalChange {
    /// New top-level blocks inserted into the Y document.
    pub inserted_blocks: usize,
    /// Previous top-level blocks deleted from the Y document.
    pub deleted_blocks: usize,
    /// Frontmatter keys inserted, changed, or removed.
    pub frontmatter_keys: usize,
}

impl ExternalChange {
    /// Returns whether the import changed the Y document.
    #[must_use]
    pub const fn changed(self) -> bool {
        self.inserted_blocks != 0 || self.deleted_blocks != 0 || self.frontmatter_keys != 0
    }
}

#[derive(Debug)]
struct BlockEdit {
    index: u32,
    delete: u32,
    insert: Vec<Block>,
}

/// Parses Markdown and applies its structural difference to an existing Y document.
///
/// The complete change uses one transaction with origin [`EXTERNAL_ORIGIN`]. Exact unchanged
/// top-level blocks retain their Yjs identities, and frontmatter is changed per key.
///
/// # Errors
///
/// Returns [`CrdtError`] without modifying `doc` when its current state or the parsed target
/// violates the shared schema, or when the document exceeds Yjs' 32-bit sequence limit.
pub fn apply_external_markdown(doc: &Doc, markdown: &str) -> Result<ExternalChange, CrdtError> {
    apply_external_document(doc, &mb_core::parse(markdown))
}

/// Applies a block document as one identity-preserving external Yjs transaction.
///
/// A semantic no-op opens no write transaction, so observers receive no empty update.
///
/// # Errors
///
/// Returns [`CrdtError`] without modifying `doc` when either document violates the shared
/// schema, or when the document exceeds Yjs' 32-bit sequence limit.
pub fn apply_external_document(
    doc: &Doc,
    external: &Document,
) -> Result<ExternalChange, CrdtError> {
    mb_core::schema::validate(external)
        .map_err(|errors| CrdtError::invalid_document(errors.as_slice()))?;
    let current = document_from_yrs_raw(doc)?;
    let target = mb_core::canonicalize(external.clone());
    let old_blocks = current.blocks;
    let target_blocks = storage_blocks(&target);
    let block_edits = block_edits(&old_blocks, &target_blocks)?;

    let current_frontmatter = frontmatter_entries(&current.frontmatter);
    let target_frontmatter = frontmatter_entries(&target.frontmatter);
    let frontmatter_keys = current_frontmatter
        .keys()
        .chain(target_frontmatter.keys())
        .map(String::as_str)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter(|key| current_frontmatter.get(*key) != target_frontmatter.get(*key))
        .map(str::to_string)
        .collect::<Vec<_>>();

    let change = ExternalChange {
        inserted_blocks: block_edits.iter().map(|edit| edit.insert.len()).sum(),
        deleted_blocks: block_edits.iter().map(|edit| edit.delete as usize).sum(),
        frontmatter_keys: frontmatter_keys.len(),
    };
    if !change.changed() {
        return Ok(change);
    }

    let mut txn = doc.transact_mut_with(EXTERNAL_ORIGIN);
    let fragment = txn.get_or_insert_xml_fragment(PROSEMIRROR_ROOT);
    let frontmatter = txn.get_or_insert_map(FRONTMATTER_ROOT);
    for key in frontmatter_keys {
        match target_frontmatter.get(&key) {
            Some(value) => {
                frontmatter.insert(&mut txn, key, value.clone());
            }
            None => {
                frontmatter.remove(&mut txn, &key);
            }
        }
    }
    for edit in block_edits {
        if edit.delete != 0 {
            fragment.remove_range(&mut txn, edit.index, edit.delete);
        }
        for (index, block) in (edit.index..).zip(&edit.insert) {
            insert_block(&fragment, &mut txn, index, block);
        }
    }
    drop(txn);
    Ok(change)
}

fn storage_blocks(document: &Document) -> Vec<Block> {
    if document.blocks.is_empty() {
        vec![Block::new(BlockKind::Paragraph(Vec::new()))]
    } else {
        document.blocks.clone()
    }
}

fn block_edits(old: &[Block], new: &[Block]) -> Result<Vec<BlockEdit>, CrdtError> {
    u32::try_from(old.len()).map_err(|_| too_many_blocks(old.len()))?;
    u32::try_from(new.len()).map_err(|_| too_many_blocks(new.len()))?;

    let mut matches = Vec::new();
    collect_matches(old, new, 0, 0, &mut matches);
    let mut edits = Vec::new();
    let mut old_cursor = 0usize;
    let mut new_cursor = 0usize;
    for (old_index, new_index) in matches {
        let inserted = new.get(new_cursor..new_index).ok_or_else(invalid_diff)?;
        push_edit(
            &mut edits,
            new_cursor,
            old_index.saturating_sub(old_cursor),
            inserted,
        )?;
        old_cursor = old_index + 1;
        new_cursor = new_index + 1;
    }
    let inserted = new.get(new_cursor..).ok_or_else(invalid_diff)?;
    push_edit(
        &mut edits,
        new_cursor,
        old.len().saturating_sub(old_cursor),
        inserted,
    )?;
    Ok(edits)
}

fn push_edit(
    edits: &mut Vec<BlockEdit>,
    index: usize,
    delete: usize,
    insert: &[Block],
) -> Result<(), CrdtError> {
    if delete == 0 && insert.is_empty() {
        return Ok(());
    }
    edits.push(BlockEdit {
        index: u32::try_from(index).map_err(|_| too_many_blocks(index))?,
        delete: u32::try_from(delete).map_err(|_| too_many_blocks(delete))?,
        insert: insert.to_vec(),
    });
    Ok(())
}

fn too_many_blocks(count: usize) -> CrdtError {
    CrdtError::InvalidBlockDocument(format!(
        "document has {count} top-level blocks; Yjs supports at most {}",
        u32::MAX
    ))
}

fn invalid_diff() -> CrdtError {
    CrdtError::InvalidBlockDocument("structural diff produced an invalid range".to_string())
}

fn collect_matches(
    old: &[Block],
    new: &[Block],
    old_offset: usize,
    new_offset: usize,
    matches: &mut Vec<(usize, usize)>,
) {
    if old.is_empty() || new.is_empty() {
        return;
    }

    let prefix = old
        .iter()
        .zip(new)
        .take_while(|(left, right)| left == right)
        .count();
    for index in 0..prefix {
        matches.push((old_offset + index, new_offset + index));
    }
    let (_, old_after_prefix) = old.split_at(prefix);
    let (_, new_after_prefix) = new.split_at(prefix);
    let suffix = old_after_prefix
        .iter()
        .rev()
        .zip(new_after_prefix.iter().rev())
        .take_while(|(left, right)| left == right)
        .count();
    let old_middle_len = old_after_prefix.len().saturating_sub(suffix);
    let new_middle_len = new_after_prefix.len().saturating_sub(suffix);
    let (old_middle, _) = old_after_prefix.split_at(old_middle_len);
    let (new_middle, _) = new_after_prefix.split_at(new_middle_len);

    if old_middle.len() == 1 {
        if let Some(block) = old_middle.first()
            && let Some(index) = new_middle.iter().position(|candidate| candidate == block)
        {
            matches.push((old_offset + prefix, new_offset + prefix + index));
        }
    } else if !old_middle.is_empty() && !new_middle.is_empty() {
        let midpoint = old_middle.len() / 2;
        let (left, right) = old_middle.split_at(midpoint);
        let left_scores = lcs_lengths(left.iter(), new_middle.iter());
        let right_scores = lcs_lengths(right.iter().rev(), new_middle.iter().rev());
        let mut split = 0usize;
        let mut best = 0usize;
        for candidate in 0..=new_middle.len() {
            let left = left_scores.get(candidate).copied().unwrap_or_default();
            let right = right_scores
                .get(new_middle.len().saturating_sub(candidate))
                .copied()
                .unwrap_or_default();
            if left + right > best {
                best = left + right;
                split = candidate;
            }
        }
        let (new_left, new_right) = new_middle.split_at(split);
        collect_matches(
            left,
            new_left,
            old_offset + prefix,
            new_offset + prefix,
            matches,
        );
        collect_matches(
            right,
            new_right,
            old_offset + prefix + midpoint,
            new_offset + prefix + split,
            matches,
        );
    }

    for index in 0..suffix {
        matches.push((
            old_offset + prefix + old_middle.len() + index,
            new_offset + prefix + new_middle.len() + index,
        ));
    }
}

fn lcs_lengths<'a>(
    left: impl Iterator<Item = &'a Block>,
    right: impl Iterator<Item = &'a Block> + Clone,
) -> Vec<usize> {
    let width = right.clone().count();
    let mut previous = vec![0usize; width + 1];
    for left_block in left {
        let mut current = Vec::with_capacity(width + 1);
        current.push(0);
        for (index, right_block) in right.clone().enumerate() {
            let value = if left_block == right_block {
                previous.get(index).copied().unwrap_or_default() + 1
            } else {
                previous
                    .get(index + 1)
                    .copied()
                    .unwrap_or_default()
                    .max(current.last().copied().unwrap_or_default())
            };
            current.push(value);
        }
        previous = current;
    }
    previous
}
