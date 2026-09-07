//! Divergent merges, made visible (`SPEC.md` §3.5, §22.7).
//!
//! §22.7 requires conflict callouts to round-trip. That is checked here directly, and it is
//! the reason §3.5 chose a callout in the first place: a `[!conflict]` block is an ordinary
//! callout to the parser, the serializer and the editor, so the only thing that had to be
//! invented was the marker.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

mod support;

use mb_core::conflict::{Resolution, count, is_conflict, merge, nth, resolve};
use proptest::prelude::*;

const STAMP: &str = "2026-08-28T22:41:07Z";

/// The merged Markdown of three versions of a note.
fn merged3(base: &str, mine: &str, theirs: &str) -> String {
    mb_core::to_markdown(&merge(
        Some(&mb_core::parse(base)),
        &mb_core::parse(mine),
        &mb_core::parse(theirs),
        STAMP,
    ))
}

/// The merged Markdown of two versions, with no base — the degraded path.
fn merged(mine: &str, theirs: &str) -> String {
    mb_core::to_markdown(&merge(
        None,
        &mb_core::parse(mine),
        &mb_core::parse(theirs),
        STAMP,
    ))
}

fn conflicts(markdown: &str) -> usize {
    count(&mb_core::parse(markdown))
}

#[test]
fn a_block_changed_on_both_sides_keeps_mine_and_marks_theirs() {
    // §3.5's own example. The local version stays where it was; the divergent one follows it
    // as a callout, labelled with what it is and when it arrived.
    let markdown = merged3(
        "The layered truth model has three levels.\n",
        "The layered truth model has five levels.\n",
        "The layered truth model has four levels.\n",
    );

    // The escaped colon is the serializer being correct rather than a defect: `:41:` is a
    // valid `:shortcode:` body (§11.3), so an unescaped timestamp would read back as an
    // emoji reference. §3.5's example carries the same escape for the same reason.
    assert_eq!(
        markdown,
        "The layered truth model has five levels.\n\n\
         > [!conflict] Conflicting version — external edit, 2026-08-28T22\\:41:07Z\n\
         >\n\
         > The layered truth model has four levels.\n",
    );
}

#[test]
fn a_change_only_they_made_is_taken_rather_than_marked() {
    // The single most common reconnection: somebody else edited a note this device merely
    // held. Marking that as a conflict would make the feature unusable in a shared vault,
    // and only the base can tell it apart from a collision.
    let markdown = merged3("Three levels.\n", "Three levels.\n", "Four levels.\n");

    assert_eq!(markdown, "Four levels.\n");
    assert_eq!(conflicts(&markdown), 0);
}

#[test]
fn a_deletion_only_they_made_is_honoured_rather_than_resurrected() {
    // The defect a base exists to fix. Without one, a block present only on my side reads as
    // my addition, and every note somebody tidied up grows its paragraphs back on reconnect.
    let markdown = merged3("One.\n\nTwo.\n", "One.\n\nTwo.\n", "One.\n");

    assert_eq!(markdown, "One.\n");
}

#[test]
fn a_change_only_i_made_is_kept() {
    let markdown = merged3("Three levels.\n", "Five levels.\n", "Three levels.\n");

    assert_eq!(markdown, "Five levels.\n");
    assert_eq!(conflicts(&markdown), 0);
}

#[test]
fn a_block_only_i_added_stays_and_is_not_marked() {
    let markdown = merged3("One.\n", "One.\n\nMine.\n", "One.\n");

    assert_eq!(markdown, "One.\n\nMine.\n");
}

#[test]
fn a_block_only_they_added_is_an_addition_rather_than_a_conflict() {
    let markdown = merged3("One.\n", "One.\n", "One.\n\nTwo.\n");

    assert_eq!(markdown, "One.\n\nTwo.\n");
    assert_eq!(conflicts(&markdown), 0);
}

#[test]
fn the_same_change_made_on_both_sides_appears_once() {
    // Two devices that independently made the identical edit have not disagreed about
    // anything, and a callout repeating a paragraph back at the author is noise.
    let markdown = merged3("Three.\n", "Four.\n", "Four.\n");

    assert_eq!(markdown, "Four.\n");
    assert_eq!(conflicts(&markdown), 0);
}

#[test]
fn a_local_change_colliding_with_their_deletion_keeps_mine_unmarked() {
    // The one collision this cannot show: there is no divergent *version* to put in a
    // callout, and an empty one would be content nobody wrote. Kept rather than deleted,
    // which is the same content-preserving bias §3.5 states, and stated in `conflict.rs`.
    let markdown = merged3("Three.\n\nKeep.\n", "Five.\n\nKeep.\n", "Keep.\n");

    assert_eq!(markdown, "Five.\n\nKeep.\n");
    assert_eq!(conflicts(&markdown), 0);
}

#[test]
fn their_change_colliding_with_my_deletion_is_marked_with_no_block_in_front() {
    let markdown = merged3("Three.\n\nKeep.\n", "Keep.\n", "Four.\n\nKeep.\n");

    assert_eq!(conflicts(&markdown), 1);
    assert!(markdown.starts_with("> [!conflict]"), "{markdown}");
    assert!(markdown.contains("> Four.\n"), "{markdown}");
}

#[test]
fn an_unchanged_note_merges_to_itself() {
    let note = "# Title\n\nBody.\n\n- [ ] A task\n";
    assert_eq!(merged3(note, note, note), note);
    assert_eq!(conflicts(&merged3(note, note, note)), 0);
}

#[test]
fn each_divergent_place_gets_its_own_callout() {
    let markdown = merged3(
        "# Title\n\nFirst base.\n\nShared.\n\nSecond base.\n",
        "# Title\n\nFirst mine.\n\nShared.\n\nSecond mine.\n",
        "# Title\n\nFirst theirs.\n\nShared.\n\nSecond theirs.\n",
    );

    assert_eq!(conflicts(&markdown), 2);
    // The shared block is matched, so it is not swallowed into either callout.
    assert!(markdown.contains("\nShared.\n"), "{markdown}");
}

#[test]
fn a_replaced_run_pairs_each_local_block_with_its_own_callout() {
    // Not one callout for the run: the run's boundary is not representable in Markdown, so a
    // single callout could not say which blocks `Keep theirs` replaces once the note has been
    // reloaded. One local block in front of each callout is an association a reader — and a
    // fresh parse of the file — can both recover. See `conflict.rs`, "One callout per block".
    let markdown = merged3("A.\n\nB.\n", "A1.\n\nB1.\n", "C.\n\nD.\n");

    assert_eq!(conflicts(&markdown), 2, "{markdown}");
    assert_eq!(
        markdown,
        "A1.\n\n\
         > [!conflict] Conflicting version — external edit, 2026-08-28T22\\:41:07Z\n\
         >\n\
         > C.\n\n\
         B1.\n\n\
         > [!conflict] Conflicting version — external edit, 2026-08-28T22\\:41:07Z\n\
         >\n\
         > D.\n",
    );
}

#[test]
fn a_longer_remote_run_hangs_off_the_last_local_block() {
    // Every callout still has exactly one local block in front of it, whatever the two
    // lengths are — that invariant is what `resolve` depends on.
    let markdown = merged3("A.\n", "A1.\n", "C.\n\nD.\n");

    assert_eq!(conflicts(&markdown), 1, "{markdown}");
    assert!(markdown.starts_with("A1.\n\n> [!conflict]"), "{markdown}");
    assert!(markdown.contains("> C.\n>\n> D.\n"), "{markdown}");
}

#[test]
fn conflict_callouts_never_nest() {
    // §3.5: a second conflict on an already-conflicted block appends a sibling rather than
    // wrapping. The sequence is a note that already carries an unresolved conflict, edited
    // again on this device, diverging again — so the earlier callout is in the base.
    let once = merged3("Base.\n", "Mine.\n", "Theirs.\n");
    let mine_again = once.replace("Mine.", "Mine again.");
    let theirs_again = once.replace("Mine.", "Third.");
    let twice = merged3(&once, &mine_again, &theirs_again);

    assert_eq!(conflicts(&twice), 2, "{twice}");
    assert!(!twice.contains("> > [!conflict]"), "{twice}");
    assert!(twice.starts_with("Mine again.\n\n> [!conflict]"), "{twice}");
}

#[test]
fn a_conflict_reached_through_a_quote_is_unwrapped_rather_than_nested() {
    // The no-nesting claim has to hold at depth, or a callout arriving inside somebody's
    // blockquote would produce exactly the nesting §3.5 forbids.
    let theirs =
        "> Quoted:\n>\n> > [!conflict] Conflicting version — external edit, then\n> >\n> > Old.\n";
    let markdown = merged3("Base.\n", "Mine.\n", theirs);

    assert_eq!(conflicts(&markdown), 1, "{markdown}");
    assert!(!markdown.contains("external edit, then"), "{markdown}");
    assert!(markdown.contains("> > Old."), "{markdown}");
}

#[test]
fn a_conflict_callout_round_trips_through_the_serializer() {
    // §22.7. The whole argument for a callout over git markers: nothing had to be added to
    // the parser, so the file a text editor opens is one this parser reads back unchanged.
    let markdown = merged3("Base.\n", "Mine.\n", "Theirs.\n");
    let parsed = mb_core::parse(&markdown);

    assert_eq!(mb_core::to_markdown(&parsed), markdown);
    assert_eq!(count(&parsed), 1);
    assert!(is_conflict(&parsed.blocks[1]));
}

#[test]
fn frontmatter_stays_mine_and_is_never_marked() {
    // A25 gives frontmatter per-key convergence in the CRDT (§3.4); it has no position a
    // callout could attach to, so the merge must leave it alone rather than invent one.
    let markdown = merged3(
        "---\ntitle: Base\n---\n\nBody.\n",
        "---\ntitle: Mine\n---\n\nBody.\n",
        "---\ntitle: Theirs\n---\n\nBody.\n",
    );

    assert_eq!(markdown, "---\ntitle: Mine\n---\n\nBody.\n");
    assert_eq!(conflicts(&markdown), 0);
}

mod counting {
    use super::*;

    const CALLOUT: &str = "> [!conflict] Conflicting version — external edit, now\n>\n> Theirs.";

    #[test]
    fn a_conflict_inside_a_quote_is_counted() {
        // The badge in the note tree has to agree with what a reader can see, and a callout
        // in a blockquote is visible.
        let quoted = format!("> Quoted:\n>\n{}\n", indent(CALLOUT));
        assert_eq!(conflicts(&quoted), 1, "{quoted}");
    }

    #[test]
    fn a_conflict_inside_a_list_item_is_counted() {
        // The gap the draft's counter left: a note whose conflict landed in a list showed a
        // badge of zero while the callout was on screen.
        let listed = format!("- An item:\n\n{}\n", indent_blank("  ", CALLOUT));
        assert_eq!(conflicts(&listed), 1, "{listed}");
    }

    #[test]
    fn an_ordinary_callout_is_not_counted() {
        let note = "> [!note] Just a note\n>\n> Not a conflict.\n";
        assert_eq!(conflicts(note), 0);
    }

    #[test]
    fn the_marker_is_matched_regardless_of_case() {
        let note = "> [!CONFLICT] Conflicting version — external edit, now\n>\n> Theirs.\n";
        assert_eq!(conflicts(note), 1);
    }

    fn indent(block: &str) -> String {
        block
            .lines()
            .map(|line| format!("> {line}"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn indent_blank(prefix: &str, block: &str) -> String {
        block
            .lines()
            .map(|line| format!("{prefix}{line}"))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

mod resolving {
    use super::*;

    /// Resolves the conflict at `nth` in a merged note and returns the Markdown.
    fn resolved_nth(
        base: &str,
        mine: &str,
        theirs: &str,
        nth: usize,
        resolution: Resolution,
    ) -> String {
        let doc = merge(
            Some(&mb_core::parse(base)),
            &mb_core::parse(mine),
            &mb_core::parse(theirs),
            STAMP,
        );
        let index = doc
            .blocks
            .iter()
            .enumerate()
            .filter(|(_, block)| is_conflict(block))
            .nth(nth)
            .expect("a conflict")
            .0;
        let mut out = doc.clone();
        out.blocks = resolve(&doc.blocks, index, resolution);
        mb_core::to_markdown(&out)
    }

    fn resolved(mine: &str, theirs: &str, resolution: Resolution) -> String {
        resolved_nth("Base.\n", mine, theirs, 0, resolution)
    }

    #[test]
    fn keeping_mine_drops_the_callout() {
        assert_eq!(
            resolved("Mine.\n", "Theirs.\n", Resolution::Mine),
            "Mine.\n"
        );
    }

    #[test]
    fn keeping_theirs_replaces_the_local_version() {
        assert_eq!(
            resolved("Mine.\n", "Theirs.\n", Resolution::Theirs),
            "Theirs.\n"
        );
    }

    #[test]
    fn keeping_both_leaves_two_ordinary_blocks() {
        assert_eq!(
            resolved("Mine.\n", "Theirs.\n", Resolution::Both),
            "Mine.\n\nTheirs.\n",
        );
    }

    #[test]
    fn every_resolution_leaves_no_conflict_behind() {
        for resolution in [Resolution::Mine, Resolution::Theirs, Resolution::Both] {
            let markdown = resolved("Mine.\n", "Theirs.\n", resolution);
            assert_eq!(conflicts(&markdown), 0, "{markdown}");
        }
    }

    #[test]
    fn keeping_theirs_in_a_paired_run_replaces_only_its_own_block() {
        // The defect this shape exists to fix: for local `A., B.` against remote `C., D.`,
        // keeping theirs on the first conflict used to leave `A., C., D.` — the run boundary
        // was unrecoverable. Each callout now owns exactly the block in front of it.
        let markdown = resolved_nth(
            "A.\n\nB.\n",
            "A1.\n\nB1.\n",
            "C.\n\nD.\n",
            0,
            Resolution::Theirs,
        );

        assert_eq!(conflicts(&markdown), 1, "{markdown}");
        assert!(
            markdown.starts_with("C.\n\nB1.\n\n> [!conflict]"),
            "{markdown}"
        );
    }

    #[test]
    fn keeping_theirs_on_the_second_conflict_replaces_only_its_own_block() {
        let markdown = resolved_nth(
            "A.\n\nB.\n",
            "A1.\n\nB1.\n",
            "C.\n\nD.\n",
            1,
            Resolution::Theirs,
        );

        assert_eq!(conflicts(&markdown), 1, "{markdown}");
        assert!(markdown.starts_with("A1.\n\n> [!conflict]"), "{markdown}");
        assert!(markdown.ends_with("> C.\n\nD.\n"), "{markdown}");
    }

    #[test]
    fn a_resolution_survives_a_round_trip_through_the_file() {
        // The durability claim. The note is serialized, forgotten, re-parsed from its
        // Markdown alone, and resolved from there — which is what happens after a reload,
        // and what a run-based association could not do.
        let merged = merged3("A.\n\nB.\n", "A1.\n\nB1.\n", "C.\n\nD.\n");
        let reparsed = mb_core::parse(&merged);
        let index = reparsed
            .blocks
            .iter()
            .position(is_conflict)
            .expect("a conflict");
        let mut out = reparsed.clone();
        out.blocks = resolve(&reparsed.blocks, index, Resolution::Theirs);

        assert!(
            mb_core::to_markdown(&out).starts_with("C.\n\nB1.\n"),
            "{}",
            mb_core::to_markdown(&out),
        );
    }

    #[test]
    fn an_ordinal_addresses_conflicts_rather_than_blocks() {
        // What the editor can offer: it knows this is the second conflict on screen, and it
        // cannot know which block index that is once the note has been canonicalized.
        let blocks = merge(
            Some(&mb_core::parse("A.\n\nB.\n")),
            &mb_core::parse("A1.\n\nB1.\n"),
            &mb_core::parse("C.\n\nD.\n"),
            STAMP,
        )
        .blocks;

        assert_eq!(nth(&blocks, 0), Some(1));
        assert_eq!(nth(&blocks, 1), Some(3));
        assert_eq!(nth(&blocks, 2), None);
    }

    #[test]
    fn an_ordinal_skips_blocks_that_are_not_conflicts() {
        let blocks = mb_core::parse(
            "One.\n\nTwo.\n\n> [!note] Not a conflict\n>\n> Body.\n\n\
             > [!conflict] Conflicting version — external edit, now\n>\n> Theirs.\n",
        )
        .blocks;

        assert_eq!(nth(&blocks, 0), Some(3));
        assert_eq!(nth(&blocks, 1), None);
    }

    #[test]
    fn an_index_that_is_not_a_conflict_changes_nothing() {
        // A stale index from a document that has moved on must not rewrite an unrelated
        // block: the editor sends a position, and positions go out of date.
        let blocks = mb_core::parse("One.\n\nTwo.\n").blocks;
        for index in [0, 1, 7] {
            assert_eq!(resolve(&blocks, index, Resolution::Theirs), blocks);
        }
    }

    #[test]
    fn an_ordinary_callout_is_never_resolved() {
        let blocks = mb_core::parse("> [!note] Title\n>\n> Body.\n").blocks;
        for resolution in [Resolution::Mine, Resolution::Theirs, Resolution::Both] {
            assert_eq!(resolve(&blocks, 0, resolution), blocks);
        }
    }

    #[test]
    fn keeping_theirs_at_the_start_of_a_note_replaces_nothing_it_should_not() {
        // A callout with no local block before it — what a divergence whose local side was
        // deleted on this device produces, and what a reader can also make by hand.
        let blocks = mb_core::parse(
            "> [!conflict] Conflicting version — external edit, now\n> Theirs.\n\nAfter.\n",
        )
        .blocks;
        let resolved = resolve(&blocks, 0, Resolution::Theirs);
        let doc = mb_core::model::Document::new(resolved);
        assert_eq!(mb_core::to_markdown(&doc), "Theirs.\n\nAfter.\n");
    }

    #[test]
    fn keeping_theirs_never_swallows_the_conflict_before_it() {
        // Two adjacent callouts: the second's preceding block is the first's callout, which
        // is not a local version of anything. Resolving the second must leave the first
        // standing — it is somebody's unresolved decision, and it belongs to another block.
        let blocks = mb_core::parse(
            "Mine.\n\n\
             > [!conflict] Conflicting version — external edit, now\n>\n> First.\n\n\
             > [!conflict] Conflicting version — external edit, now\n>\n> Second.\n",
        )
        .blocks;
        let doc = mb_core::model::Document::new(resolve(&blocks, 2, Resolution::Theirs));

        assert_eq!(count(&doc), 1, "{}", mb_core::to_markdown(&doc));
        assert!(
            is_conflict(&doc.blocks[1]),
            "{}",
            mb_core::to_markdown(&doc)
        );
        assert!(
            mb_core::to_markdown(&doc).ends_with("> First.\n\nSecond.\n"),
            "{}",
            mb_core::to_markdown(&doc),
        );
    }
}

/// The degraded comparison, for a device that has no base for this note yet (§7.2).
mod without_a_base {
    use super::*;

    #[test]
    fn a_block_changed_on_both_sides_is_still_marked() {
        let markdown = merged("Mine.\n", "Theirs.\n");

        assert_eq!(conflicts(&markdown), 1, "{markdown}");
        assert!(markdown.starts_with("Mine.\n\n> [!conflict]"), "{markdown}");
    }

    #[test]
    fn a_block_only_they_have_is_treated_as_an_addition() {
        assert_eq!(merged("One.\n", "One.\n\nTwo.\n"), "One.\n\nTwo.\n");
    }

    #[test]
    fn a_block_only_i_have_is_kept_which_can_resurrect_their_deletion() {
        // The honest cost of no base, asserted rather than described: this is the case a
        // base fixes, and the reason `merge` takes one.
        assert_eq!(merged("One.\n\nTwo.\n", "One.\n"), "One.\n\nTwo.\n");
    }

    #[test]
    fn an_unchanged_note_merges_to_itself() {
        let note = "# Title\n\nBody.\n";
        assert_eq!(merged(note, note), note);
    }
}

proptest! {
    /// Merging a note with itself is the identity, whatever is in it and whatever the base.
    #[test]
    fn merging_a_note_with_itself_changes_nothing(document in support::document()) {
        let markdown = mb_core::to_markdown(&document);
        let parsed = mb_core::parse(&markdown);
        prop_assert_eq!(
            mb_core::to_markdown(&merge(Some(&parsed), &parsed, &parsed, STAMP)),
            markdown.clone(),
        );
        prop_assert_eq!(
            mb_core::to_markdown(&merge(None, &parsed, &parsed, STAMP)),
            markdown,
        );
    }

    /// A merge takes their version wholesale when this device changed nothing.
    ///
    /// The property a base buys: a device that only *held* a note converges on the server's
    /// version exactly, with no callouts and no resurrected blocks.
    #[test]
    fn a_merge_this_device_did_not_contribute_to_is_exactly_theirs(
        base in support::document(),
        theirs in support::document(),
    ) {
        let base = mb_core::parse(&mb_core::to_markdown(&base));
        let theirs = mb_core::parse(&mb_core::to_markdown(&theirs));
        let merged = merge(Some(&base), &base, &theirs, STAMP);

        prop_assert_eq!(count(&merged), 0);
        prop_assert_eq!(merged.blocks, theirs.blocks);
    }

    /// Every merge keeps every one of my blocks that their side did not delete.
    ///
    /// This is the property that matters: the local version stays in place. A merge that
    /// dropped one of my blocks would be the silent loss §3.5 exists to prevent. The
    /// exception is deliberate — a block I never touched and they removed is a deletion
    /// this merge is meant to honour.
    #[test]
    fn a_merge_never_drops_a_local_block_i_changed(
        base in support::document(),
        theirs in support::document(),
    ) {
        let base = mb_core::parse(&mb_core::to_markdown(&base));
        let theirs = mb_core::parse(&mb_core::to_markdown(&theirs));
        // Every one of my blocks is one the base does not have, so none of them can be read
        // as a block they deleted.
        let mut mine = base.clone();
        mine.blocks.push(mb_core::model::Block::new(
            mb_core::model::BlockKind::Paragraph(vec![mb_core::model::Inline::Text(
                "A sentence only this device has.".to_string(),
            )]),
        ));

        let markdown = mb_core::to_markdown(&merge(Some(&base), &mine, &theirs, STAMP));
        prop_assert!(
            markdown.contains("A sentence only this device has."),
            "a local block was lost in: {}",
            markdown,
        );
    }

    /// A merged document always round-trips, which is what makes the callout choice work.
    #[test]
    fn a_merged_document_round_trips(
        base in support::document(),
        mine in support::document(),
        theirs in support::document(),
    ) {
        for base in [None, Some(&base)] {
            let markdown = mb_core::to_markdown(&merge(base, &mine, &theirs, STAMP));
            let reparsed = mb_core::parse(&markdown);
            prop_assert_eq!(mb_core::to_markdown(&reparsed), markdown);
        }
    }

    /// A conflict callout never contains another one, at any depth (§3.5).
    #[test]
    fn a_merge_never_nests_a_conflict(
        base in support::document(),
        mine in support::document(),
        theirs in support::document(),
    ) {
        let merged = merge(Some(&base), &mine, &theirs, STAMP);
        for block in &merged.blocks {
            if let mb_core::model::BlockKind::Callout(callout) = &block.kind
                && callout.kind == "conflict"
            {
                let inner = mb_core::model::Document::new(callout.content.clone());
                prop_assert_eq!(count(&inner), 0);
            }
        }
    }

    /// Every conflict a merge emits resolves three ways, and none of them leaves it behind.
    ///
    /// Strictly fewer rather than exactly one fewer: `Keep theirs` replaces the local block,
    /// and a local block can itself contain an unresolved conflict from an earlier divergence.
    #[test]
    fn every_emitted_conflict_resolves_cleanly(
        base in support::document(),
        mine in support::document(),
        theirs in support::document(),
    ) {
        let merged = merge(Some(&base), &mine, &theirs, STAMP);
        let before = count(&merged);
        prop_assume!(before > 0);
        let index = merged.blocks.iter().position(is_conflict).expect("a conflict");
        for resolution in [Resolution::Mine, Resolution::Theirs, Resolution::Both] {
            let mut out = merged.clone();
            out.blocks = resolve(&merged.blocks, index, resolution);
            prop_assert!(
                count(&out) < before,
                "{:?} left {} of {} conflicts",
                resolution,
                count(&out),
                before,
            );
            prop_assert!(!out.blocks.get(index).is_some_and(is_conflict));
        }
    }
}
