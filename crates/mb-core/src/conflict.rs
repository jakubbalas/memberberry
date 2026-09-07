//! Making a divergent merge visible instead of silent (`SPEC.md` §3.5).
//!
//! A device that was offline with local edits reconnects, and the note it holds and the note
//! the server holds have both moved. A CRDT merges them without asking, at block
//! granularity, and the loser of a block-level race disappears — silently. §3.5's answer is
//! not to prevent that (a text file has no operation history, and A24 says so) but to make it
//! **visible**: the local version stays where it is, and the divergent one is inserted
//! immediately after it as a `[!conflict]` callout.
//!
//! A callout rather than git-style markers because it is already Markdown. It round-trips
//! through the canonical serializer with no new block type, renders as a distinct block in
//! the editor, and degrades in a text editor to an obviously-labelled quote.
//!
//! # The base, and why detection needs one
//!
//! Two versions cannot say who changed what. `mine` has a block `theirs` does not: did I add
//! it, or did they delete it? Answering "I added it" resurrects deletions; answering "they
//! deleted it" throws away writing. So [`merge`] takes the version the two sides last
//! agreed on — the **base** — and compares each side against it. A region only one side
//! touched is taken from that side, deletions included; a region *both* touched, differently,
//! is the conflict §3.5 exists for.
//!
//! The base is a cache, not truth: the client keeps the Markdown a note had when it was last
//! in sync (§7.2), and it can be missing — a first sync, a cleared browser, a note whose body
//! was dropped. `base: None` degrades to the two-way comparison, which is honest about what it
//! cannot know: it keeps content, so a deletion made elsewhere can come back.
//!
//! **What no base can fix.** Both sides rewrote the same paragraph, and there is no operation
//! history to interleave the words with. That is §3.5's stated limit and it is unchanged; the
//! base narrows *which* changes are conflicts, not what a conflict can be merged into.
//!
//! # One callout per local block
//!
//! Resolution has to survive a reload, so a callout's association with the local version it
//! diverges from has to be readable from the Markdown alone. The only structure Markdown
//! offers is adjacency, so a divergent region is emitted **pairwise**: each of my blocks,
//! each followed by its counterpart's callout. `Keep theirs` then replaces exactly the block
//! before the callout, which is recoverable from the file at any later time by anyone.

use crate::model::{Block, BlockKind, Callout, Document, Fold, Inline, List, ListItem};

/// The callout marker §3.5 gives a divergent version: `> [!conflict]`.
pub const CONFLICT_KIND: &str = "conflict";

/// The fixed part of a conflict callout's title, before the timestamp.
const TITLE_PREFIX: &str = "Conflicting version — external edit, ";

/// Which side of a conflict to keep (`SPEC.md` §3.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resolution {
    /// Drop the callout. The local version, already in place, is all that remains.
    Mine,
    /// Replace the local version with the callout's content.
    Theirs,
    /// Unwrap the callout, leaving both versions as ordinary blocks.
    Both,
}

/// Merges `theirs` into `mine`, marking every divergence as a conflict callout.
///
/// `base` is the version the two sides last agreed on, and `None` when this device has none
/// — see the module docs for what each costs. `stamp` is written into the callout's title and
/// is the caller's to produce: `mb-core` has no clock, deliberately (§5.2), and a merge that
/// reached for one would stop compiling to wasm.
///
/// With a base, four shapes come out of each aligned region, and only the last is a conflict:
///
/// - **Only they changed it**: their version is taken, *including* a deletion.
/// - **Only I changed it**: mine is kept.
/// - **Both made the same change**: it appears once.
/// - **Both changed it differently**: mine stay, each followed by its counterpart's callout.
///
/// # Examples
///
/// ```
/// let base = mb_core::parse("# Note\n\nThree levels.\n");
/// let mine = mb_core::parse("# Note\n\nFive levels.\n");
/// let theirs = mb_core::parse("# Note\n\nFour levels.\n");
/// let merged = mb_core::conflict::merge(Some(&base), &mine, &theirs, "2026-08-28T22:41:07Z");
/// let markdown = mb_core::to_markdown(&merged);
/// assert!(markdown.contains("Five levels."), "the local version stays in place");
/// assert!(markdown.contains("> [!conflict]"), "the divergent one is marked");
/// ```
///
/// A change only the other side made is not a conflict, and a base is what can tell:
///
/// ```
/// let base = mb_core::parse("Three levels.\n");
/// let theirs = mb_core::parse("Four levels.\n");
/// let merged = mb_core::conflict::merge(Some(&base), &base, &theirs, "2026-08-28T22:41:07Z");
/// assert_eq!(mb_core::to_markdown(&merged), "Four levels.\n");
/// ```
#[must_use]
pub fn merge(base: Option<&Document>, mine: &Document, theirs: &Document, stamp: &str) -> Document {
    let mut merged = mine.clone();
    merged.blocks = match base {
        Some(base) => merge_three_way(&base.blocks, &mine.blocks, &theirs.blocks, stamp),
        None => merge_two_way(&mine.blocks, &theirs.blocks, stamp),
    };
    // Frontmatter is not block content and has no position to attach a callout to. A25 gives
    // it per-key convergence in the CRDT (§3.4), which is a better answer than a callout
    // could be, so the merge leaves `mine`'s alone rather than inventing one here.
    merged
}

/// Whether a block is an unresolved conflict callout.
#[must_use]
pub fn is_conflict(block: &Block) -> bool {
    matches!(&block.kind, BlockKind::Callout(callout) if callout.kind.eq_ignore_ascii_case(CONFLICT_KIND))
}

/// How many unresolved conflicts a document carries, at any depth.
///
/// Counted at depth because §3.5 forbids *nesting* conflict callouts, not putting one inside
/// a blockquote or a list item — and the badge in the note tree has to agree with what a
/// reader can see.
#[must_use]
pub fn count(document: &Document) -> usize {
    count_blocks(&document.blocks)
}

/// Where the `ordinal`-th unresolved conflict callout sits among a note's top-level blocks.
///
/// Callers outside this crate count conflicts, not blocks. The editor's document can hold
/// blocks the canonical Markdown does not — an empty trailing paragraph is the ordinary case
/// (`schema.json`, `doc`) — so a block index taken from what is on screen can address a
/// different block once the note has been serialized. An ordinal cannot drift that way:
/// nothing canonicalization adds or removes is a conflict callout.
#[must_use]
pub fn nth(blocks: &[Block], ordinal: usize) -> Option<usize> {
    blocks
        .iter()
        .enumerate()
        .filter(|(_, block)| is_conflict(block))
        .nth(ordinal)
        .map(|(index, _)| index)
}

/// Applies a resolution to the conflict callout at `index` in `blocks`.
///
/// `index` addresses the callout itself, which is what a reader clicked. Returns the blocks
/// unchanged when that index is not a conflict callout — a stale index from a document that
/// has since moved on must not rewrite an unrelated block.
#[must_use]
pub fn resolve(blocks: &[Block], index: usize, resolution: Resolution) -> Vec<Block> {
    let Some(block) = blocks.get(index) else {
        return blocks.to_vec();
    };
    let BlockKind::Callout(callout) = &block.kind else {
        return blocks.to_vec();
    };
    if !callout.kind.eq_ignore_ascii_case(CONFLICT_KIND) {
        return blocks.to_vec();
    }

    let mut out = blocks.to_vec();
    match resolution {
        Resolution::Mine => {
            out.remove(index);
        }
        Resolution::Theirs => {
            // The local version is the single block before the callout, which `merge`
            // guarantees by emitting divergent regions pairwise. That guarantee is the whole
            // reason for the pairwise shape: it is readable from the Markdown, so a reader
            // who resolves a conflict a week after a reload gets the same answer.
            out.splice(
                local_version(blocks, index)..=index,
                callout.content.clone(),
            );
        }
        Resolution::Both => {
            out.splice(index..=index, callout.content.clone());
        }
    }
    out
}

/// Where the local version attached to the callout at `index` starts.
///
/// The block immediately before, unless that is another conflict callout or there is no block
/// before at all — a callout whose local side was deleted on this device has nothing in front
/// of it, and `Keep theirs` on one is the same as `Keep both`.
fn local_version(blocks: &[Block], index: usize) -> usize {
    match index.checked_sub(1) {
        Some(previous)
            if blocks
                .get(previous)
                .is_some_and(|block| !is_conflict(block)) =>
        {
            previous
        }
        _ => index,
    }
}

/// Wraps a divergent run in the callout §3.5 specifies.
#[must_use]
pub fn callout(content: Vec<Block>, stamp: &str) -> Block {
    Block::new(BlockKind::Callout(Callout {
        kind: CONFLICT_KIND.to_string(),
        fold: Fold::None,
        title: vec![Inline::Text(format!("{TITLE_PREFIX}{stamp}"))],
        // §3.5: conflict callouts never nest. A second conflict on an already-conflicted
        // block appends a sibling, so anything already marked is unwrapped on the way in —
        // at any depth, or a callout reached through a quote would still be a nested one.
        content: flatten_conflicts(content),
    }))
}

/// Replaces every conflict callout in a subtree with the blocks it wraps.
fn flatten_conflicts(blocks: Vec<Block>) -> Vec<Block> {
    blocks
        .into_iter()
        .flat_map(|block| match block.kind {
            BlockKind::Callout(callout) if callout.kind.eq_ignore_ascii_case(CONFLICT_KIND) => {
                flatten_conflicts(callout.content)
            }
            BlockKind::Callout(callout) => vec![Block {
                kind: BlockKind::Callout(Callout {
                    content: flatten_conflicts(callout.content),
                    ..callout
                }),
                anchor: block.anchor,
            }],
            BlockKind::Blockquote(children) => vec![Block {
                kind: BlockKind::Blockquote(flatten_conflicts(children)),
                anchor: block.anchor,
            }],
            BlockKind::List(list) => vec![Block {
                kind: BlockKind::List(List {
                    items: list
                        .items
                        .into_iter()
                        .map(|item| ListItem {
                            content: flatten_conflicts(item.content),
                            ..item
                        })
                        .collect(),
                    ..list
                }),
                anchor: block.anchor,
            }],
            _ => vec![block],
        })
        .collect()
}

fn count_blocks(blocks: &[Block]) -> usize {
    blocks
        .iter()
        .map(|block| {
            if is_conflict(block) {
                return 1;
            }
            match &block.kind {
                BlockKind::Blockquote(children) => count_blocks(children),
                BlockKind::Callout(callout) => count_blocks(&callout.content),
                BlockKind::List(list) => list
                    .items
                    .iter()
                    .map(|item| count_blocks(&item.content))
                    .sum(),
                _ => 0,
            }
        })
        .sum()
}

/// The merge that has a base: each side is compared against what they last agreed on.
fn merge_three_way(base: &[Block], mine: &[Block], theirs: &[Block], stamp: &str) -> Vec<Block> {
    let mut out = Vec::new();
    let mut cursor = Cursor::default();
    for anchor in anchors(base, mine, theirs) {
        push_region(
            &mut out,
            Region {
                base: base.get(cursor.base..anchor.base).unwrap_or_default(),
                mine: mine.get(cursor.mine..anchor.mine).unwrap_or_default(),
                theirs: theirs.get(cursor.theirs..anchor.theirs).unwrap_or_default(),
            },
            stamp,
        );
        // The anchor block itself survived unchanged on both sides, so it appears once.
        if let Some(block) = mine.get(anchor.mine) {
            out.push(block.clone());
        }
        cursor = Cursor {
            base: anchor.base + 1,
            mine: anchor.mine + 1,
            theirs: anchor.theirs + 1,
        };
    }
    push_region(
        &mut out,
        Region {
            base: base.get(cursor.base..).unwrap_or_default(),
            mine: mine.get(cursor.mine..).unwrap_or_default(),
            theirs: theirs.get(cursor.theirs..).unwrap_or_default(),
        },
        stamp,
    );
    out
}

/// The merge that has no base, and so cannot tell an addition from a deletion.
fn merge_two_way(mine: &[Block], theirs: &[Block], stamp: &str) -> Vec<Block> {
    let mut out = Vec::new();
    let (mut left, mut right) = (0usize, 0usize);
    for (my_index, their_index) in matches(mine, theirs) {
        push_region(
            &mut out,
            Region {
                // No base means every region reads as changed on whichever side it is
                // non-empty, which is what makes an unmatched block ambiguous.
                base: &[],
                mine: mine.get(left..my_index).unwrap_or_default(),
                theirs: theirs.get(right..their_index).unwrap_or_default(),
            },
            stamp,
        );
        if let Some(block) = mine.get(my_index) {
            out.push(block.clone());
        }
        left = my_index + 1;
        right = their_index + 1;
    }
    push_region(
        &mut out,
        Region {
            base: &[],
            mine: mine.get(left..).unwrap_or_default(),
            theirs: theirs.get(right..).unwrap_or_default(),
        },
        stamp,
    );
    out
}

/// One aligned gap between two agreed-on blocks.
struct Region<'a> {
    base: &'a [Block],
    mine: &'a [Block],
    theirs: &'a [Block],
}

#[derive(Default, Clone, Copy)]
struct Cursor {
    base: usize,
    mine: usize,
    theirs: usize,
}

/// Emits one aligned region: whichever side changed it, or both with callouts.
fn push_region(out: &mut Vec<Block>, region: Region<'_>, stamp: &str) {
    let mine_changed = region.mine != region.base;
    let theirs_changed = region.theirs != region.base;
    if !theirs_changed || region.mine == region.theirs {
        // Nobody disagrees: either they left this region alone, or we both arrived at it.
        out.extend(region.mine.iter().cloned());
        return;
    }
    if !mine_changed {
        // Only they changed it. Taking their version wholesale is what honours a deletion:
        // an empty `theirs` here means they removed these blocks and I never touched them.
        out.extend(region.theirs.iter().cloned());
        return;
    }
    if region.theirs.is_empty() {
        // They deleted what I changed. Mine stays and is not marked: there is no divergent
        // *version* to show, and an empty callout would be content nobody wrote. The cost is
        // that this one collision is invisible, which is the same content-keeping bias the
        // module docs state for a merge without a base.
        out.extend(region.mine.iter().cloned());
        return;
    }
    if region.mine.is_empty() {
        // I deleted what they changed, so there is no local block for a callout to sit after.
        // It stands alone, where `Keep theirs` reads as `Keep both` — see `local_version`.
        out.push(callout(region.theirs.to_vec(), stamp));
        return;
    }
    push_pairwise(out, region.mine, region.theirs, stamp);
}

/// Emits a divergent region as §3.5's shape: each local block, then its counterpart's callout.
///
/// The counterparts are matched by position, and the last of my blocks takes whatever is left
/// of theirs — so every callout has exactly one local block in front of it whatever the two
/// lengths are, which is the association `resolve` depends on.
fn push_pairwise(out: &mut Vec<Block>, mine: &[Block], theirs: &[Block], stamp: &str) {
    for (index, block) in mine.iter().enumerate() {
        out.push(block.clone());
        let last = index + 1 == mine.len();
        let end = if last {
            theirs.len()
        } else {
            (index + 1).min(theirs.len())
        };
        if let Some(counterpart) = theirs.get(index..end)
            && !counterpart.is_empty()
        {
            out.push(callout(counterpart.to_vec(), stamp));
        }
    }
}

/// A base block both sides kept unchanged, and where it sits in each of the three versions.
#[derive(Clone, Copy)]
struct Anchor {
    base: usize,
    mine: usize,
    theirs: usize,
}

/// The base blocks that survived, in order, on both sides at once.
///
/// Each side is aligned to the base separately, and a base block matched in both alignments
/// is a point all three versions agree on. Anything between two of them is a region only the
/// two sides' own edits can explain.
fn anchors(base: &[Block], mine: &[Block], theirs: &[Block]) -> Vec<Anchor> {
    let mut theirs_by_base = vec![None; base.len()];
    for (base_index, their_index) in matches(base, theirs) {
        if let Some(slot) = theirs_by_base.get_mut(base_index) {
            *slot = Some(their_index);
        }
    }
    matches(base, mine)
        .into_iter()
        .filter_map(|(base_index, mine_index)| {
            let their_index = (*theirs_by_base.get(base_index)?)?;
            Some(Anchor {
                base: base_index,
                mine: mine_index,
                theirs: their_index,
            })
        })
        .collect()
}

/// The longest common subsequence of two block runs, as index pairs.
///
/// Blocks compare by value, which is what the CRDT's own external diff does (`mb-crdt`): a
/// block whose text changed is a different block, and that is exactly the granularity §3.5
/// describes. Quadratic in the number of top-level blocks, which is the same bound the
/// external diff already accepts for the same reason — a note is tens of blocks, not
/// thousands, and the alternative is a heuristic that can align the wrong pair.
fn matches(mine: &[Block], theirs: &[Block]) -> Vec<(usize, usize)> {
    let rows = mine.len();
    let columns = theirs.len();
    // `lengths[i][j]` is the LCS length of `mine[i..]` and `theirs[j..]`.
    let mut lengths = vec![vec![0usize; columns + 1]; rows + 1];
    for i in (0..rows).rev() {
        for j in (0..columns).rev() {
            let next = if mine.get(i) == theirs.get(j) {
                lengths
                    .get(i + 1)
                    .and_then(|row| row.get(j + 1))
                    .copied()
                    .unwrap_or(0)
                    + 1
            } else {
                let down = lengths
                    .get(i + 1)
                    .and_then(|row| row.get(j))
                    .copied()
                    .unwrap_or(0);
                let across = lengths
                    .get(i)
                    .and_then(|row| row.get(j + 1))
                    .copied()
                    .unwrap_or(0);
                down.max(across)
            };
            if let Some(cell) = lengths.get_mut(i).and_then(|row| row.get_mut(j)) {
                *cell = next;
            }
        }
    }

    let mut pairs = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < rows && j < columns {
        if mine.get(i) == theirs.get(j) {
            pairs.push((i, j));
            i += 1;
            j += 1;
            continue;
        }
        let down = lengths
            .get(i + 1)
            .and_then(|row| row.get(j))
            .copied()
            .unwrap_or(0);
        let across = lengths
            .get(i)
            .and_then(|row| row.get(j + 1))
            .copied()
            .unwrap_or(0);
        if down >= across {
            i += 1;
        } else {
            j += 1;
        }
    }
    pairs
}
