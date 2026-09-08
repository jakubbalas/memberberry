#![allow(clippy::expect_used)]

use mb_search::{AclHash, Change, Note, NoteId, NoteIdentity, Query, Segment, ZoneId};

fn digest(byte: &str) -> (ZoneId, AclHash) {
    (
        ZoneId::from_hex(&byte.repeat(32)).expect("zone"),
        AclHash::from_hex(&byte.repeat(32)).expect("ACL"),
    )
}

fn note(id: u8, text: &str) -> Note {
    Note {
        id: Some(NoteId::from_bytes([id; 16])),
        title: format!("Note {id}"),
        path: format!("{id}.md"),
        tags: vec![],
        icon: None,
        text: text.into(),
    }
}

fn count(segment: &Segment, term: &str) -> usize {
    segment
        .search(&Query::parse(term).expect("query"))
        .expect("search")
        .hits
        .len()
}

#[test]
fn newer_upserts_and_tombstones_replace_older_records() {
    let (zone, acl) = digest("ab");
    let base = Segment::build(
        zone,
        acl,
        [
            Change::Upsert(note(1, "old word")),
            Change::Upsert(note(2, "remove me")),
        ],
    )
    .expect("base");
    let delta = Segment::build(
        zone,
        acl,
        [
            Change::Upsert(note(1, "new word")),
            Change::Delete(NoteIdentity::Uuid(NoteId::from_bytes([2; 16]))),
            Change::Upsert(note(3, "added word")),
        ],
    )
    .expect("delta");
    let merged = Segment::merge(&[base, delta]).expect("merge");

    assert_eq!(count(&merged, "old"), 0);
    assert_eq!(count(&merged, "remove"), 0);
    assert_eq!(count(&merged, "new"), 1);
    assert_eq!(count(&merged, "added"), 1);
}

#[test]
fn merge_refuses_a_different_zone_or_acl_revision() {
    let (zone_a, acl_a) = digest("11");
    let (zone_b, acl_b) = digest("22");
    let first = Segment::build(zone_a, acl_a, []).expect("first");
    let other_zone = Segment::build(zone_b, acl_a, []).expect("other zone");
    let other_acl = Segment::build(zone_a, acl_b, []).expect("other ACL");

    assert!(matches!(
        Segment::merge(&[first, other_zone]),
        Err(mb_search::Error::MetadataMismatch)
    ));
    let first = Segment::build(zone_a, acl_a, []).expect("first");
    assert!(matches!(
        Segment::merge(&[first, other_acl]),
        Err(mb_search::Error::MetadataMismatch)
    ));
}
