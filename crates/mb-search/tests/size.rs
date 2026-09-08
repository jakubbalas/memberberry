#![allow(clippy::expect_used, clippy::indexing_slicing)]

use mb_search::{AclHash, Change, Note, NoteId, Segment, ZoneId};

#[test]
fn ten_thousand_representative_notes_stay_under_the_hard_ceiling() {
    let zone = ZoneId::from_hex(&"01".repeat(32)).expect("zone");
    let acl = AclHash::from_hex(&"02".repeat(32)).expect("ACL");
    let notes = (0_u32..10_000).map(|number| {
        let mut id = [0_u8; 16];
        id[0..4].copy_from_slice(&number.to_be_bytes());
        let words = (0..500)
            .map(|offset| format!("term{}", (number * 149 + offset % 150) % 200_000))
            .collect::<Vec<_>>();
        Change::Upsert(Note {
            id: Some(NoteId::from_bytes(id)),
            title: format!("Generated note {number}"),
            path: format!("Generated/{number}.md"),
            tags: vec![format!("generated/group-{}", number % 100)],
            icon: None,
            text: words.join(" "),
        })
    });

    let segment = Segment::build(zone, acl, notes).expect("segment");
    eprintln!(
        "compact 10k-note segment: {} bytes",
        segment.as_bytes().len()
    );

    assert!(
        segment.as_bytes().len() <= 15 * 1024 * 1024,
        "{} bytes exceeds SPEC §14.2's hard ceiling",
        segment.as_bytes().len()
    );
}
