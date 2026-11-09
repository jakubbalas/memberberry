//! Heap held while building a segment (SPEC §21.2).
//!
//! One test in its own binary: the counting allocator is process-global, so a second test
//! running concurrently would allocate into this one's measurement.

#![allow(clippy::expect_used)]

use mb_search::{AclHash, Change, Note, NoteId, Segment, ZoneId};
use peak_alloc::PeakAlloc;

#[global_allocator]
static HEAP: PeakAlloc = PeakAlloc;

/// Notes shaped like a real vault's: hundreds of distinct words each, a shared vocabulary.
fn corpus(notes: u32) -> Vec<Change> {
    (0..notes)
        .map(|number| {
            let mut id = [0_u8; 16];
            id[0..4].copy_from_slice(&number.to_be_bytes());
            let text = (0..300)
                .map(|offset| format!("word{}", (number * 37 + offset) % 5_000))
                .collect::<Vec<_>>()
                .join(" ");
            Change::Upsert(Note {
                id: Some(NoteId::from_bytes(id)),
                title: format!("Note {number}"),
                path: format!("folder-{}/note-{number}.md", number % 20),
                tags: vec![format!("group/{}", number % 50)],
                icon: None,
                text,
            })
        })
        .collect()
}

#[test]
fn building_a_segment_holds_at_most_four_times_the_text_it_indexes() {
    let changes = corpus(1_000);
    let text: usize = changes
        .iter()
        .map(|change| match change {
            Change::Upsert(note) => note.text.len(),
            Change::Delete(_) => 0,
        })
        .sum();
    let zone = ZoneId::from_hex(&"01".repeat(32)).expect("zone");
    let acl = AclHash::from_hex(&"02".repeat(32)).expect("ACL");

    let before = HEAP.current_usage();
    HEAP.reset_peak_usage();
    let segment = Segment::build(zone, acl, changes).expect("segment");
    let overhead = HEAP.peak_usage().saturating_sub(before);
    drop(segment);

    // why: scaled to the input, so the bound means the same thing at any corpus size.
    // Materializing every note's term set before encoding held 15.7x this fixture's text
    // (and 230 MB to build a 10k-note vault's 6 MB segment); accumulating postings note by
    // note holds 2.4x, most of it postings and their growth slack.
    eprintln!("indexed {text} bytes of text; peak extra heap {overhead} bytes");
    assert!(
        overhead <= text * 4,
        "building a segment over {text} bytes of text held {overhead} bytes of extra heap"
    );
}
