#![allow(clippy::expect_used)]

use mb_search::{AclHash, Change, Note, NoteId, NoteIdentity, Query, Segment, ZoneId};
use proptest::prelude::*;

fn zone() -> ZoneId {
    ZoneId::from_hex(&"01".repeat(32)).expect("zone")
}

fn acl() -> AclHash {
    AclHash::from_hex(&"02".repeat(32)).expect("ACL")
}

fn make_note(id: u8, words: &[String]) -> Note {
    Note {
        id: Some(NoteId::from_bytes([id; 16])),
        title: format!("Title {id}"),
        path: format!("Folder/{id}.md"),
        tags: vec![format!("tag/{id}")],
        icon: None,
        text: words.join(" "),
    }
}

proptest! {
    #[test]
    fn serialization_round_trip_preserves_every_query_result(
        notes in prop::collection::btree_map(
            any::<u8>(),
            prop::collection::vec("[a-z]{1,10}", 0..20),
            0..30,
        ),
        query in "[a-z]{1,5}".prop_filter("query must not be a reserved operator", |query| {
            !matches!(query.as_str(), "and" | "or" | "not")
        }),
    ) {
        let changes = notes.iter().map(|(id, words)| Change::Upsert(make_note(*id, words)));
        let segment = Segment::build(zone(), acl(), changes).expect("segment");
        let reopened = Segment::from_bytes(segment.as_bytes().to_vec()).expect("reopen");
        let query = Query::parse(&query).expect("query");

        prop_assert_eq!(segment.search(&query).expect("before"), reopened.search(&query).expect("after"));
    }

    #[test]
    fn merging_deltas_equals_building_their_last_changes(
        base in prop::collection::btree_map(any::<u8>(), "[a-z]{1,10}", 0..20),
        delta in prop::collection::btree_map(any::<u8>(), prop::option::of("[a-z]{1,10}"), 0..20),
    ) {
        let base_changes = base.iter().map(|(id, word)| Change::Upsert(make_note(*id, std::slice::from_ref(word))));
        let delta_changes = delta.iter().map(|(id, word)| match word {
            Some(word) => Change::Upsert(make_note(*id, std::slice::from_ref(word))),
            None => Change::Delete(NoteIdentity::Uuid(NoteId::from_bytes([*id; 16]))),
        });
        let base_segment = Segment::build(zone(), acl(), base_changes).expect("base");
        let delta_segment = Segment::build(zone(), acl(), delta_changes).expect("delta");
        let merged = Segment::merge(&[base_segment, delta_segment]).expect("merged");

        let mut expected = base.into_iter().map(|(id, word)| (id, Some(word))).collect::<std::collections::BTreeMap<_, _>>();
        expected.extend(delta);
        let expected_changes = expected.into_iter().map(|(id, word)| match word {
            Some(word) => Change::Upsert(make_note(id, &[word])),
            None => Change::Delete(NoteIdentity::Uuid(NoteId::from_bytes([id; 16]))),
        });
        let rebuilt = Segment::build(zone(), acl(), expected_changes).expect("rebuilt");

        prop_assert_eq!(merged.as_bytes(), rebuilt.as_bytes());
    }
}
