#![allow(clippy::expect_used, clippy::indexing_slicing)]

use mb_search::{AclHash, Change, Note, NoteId, Query, Segment, ZoneId};

fn zone() -> ZoneId {
    ZoneId::from_hex(&"11".repeat(32)).expect("zone")
}

fn acl() -> AclHash {
    AclHash::from_hex(&"22".repeat(32)).expect("ACL")
}

fn id(value: u8) -> NoteId {
    NoteId::from_bytes([value; 16])
}

fn note(value: u8, path: &str, title: &str, tags: &[&str], text: &str) -> Note {
    Note {
        id: Some(id(value)),
        title: title.into(),
        path: path.into(),
        tags: tags.iter().map(|tag| (*tag).into()).collect(),
        icon: Some(":berry:".into()),
        text: text.into(),
    }
}

fn paths(segment: &Segment, query: &str) -> Vec<String> {
    segment
        .search(&Query::parse(query).expect("query"))
        .expect("search")
        .hits
        .into_iter()
        .map(|hit| hit.note.path)
        .collect()
}

#[test]
fn bytes_round_trip_every_display_field_and_searchable_field() {
    let original = Segment::build(
        zone(),
        acl(),
        [Change::Upsert(note(
            7,
            "Projects/Roadmap.md",
            "Product Roadmap",
            &["project/memberberry", "planning"],
            "Café launch follows customer research.",
        ))],
    )
    .expect("segment");
    let reopened = Segment::from_bytes(original.as_bytes().to_vec()).expect("reopen");

    assert_eq!(reopened.zone_id(), zone());
    assert_eq!(reopened.acl_hash(), acl());
    assert_eq!(paths(&reopened, "customer"), ["Projects/Roadmap.md"]);
    assert_eq!(paths(&reopened, "title:product"), ["Projects/Roadmap.md"]);
    assert_eq!(
        paths(&reopened, "title:\"Product Roadmap\""),
        ["Projects/Roadmap.md"]
    );
    assert_eq!(paths(&reopened, "path:proj"), ["Projects/Roadmap.md"]);
    assert_eq!(paths(&reopened, "tag:member"), ["Projects/Roadmap.md"]);
    let result = reopened
        .search(&Query::parse("café").expect("query"))
        .expect("search");
    assert_eq!(result.hits[0].note.id, Some(id(7)));
    assert_eq!(result.hits[0].note.icon.as_deref(), Some(":berry:"));
    assert_eq!(result.hits[0].note.tags.len(), 2);
}

#[test]
fn plain_terms_are_prefixes_and_unicode_is_normalized() {
    let segment = Segment::build(
        zone(),
        acl(),
        [
            Change::Upsert(note(1, "One.md", "One", &[], "Roadmaps and Café")),
            Change::Upsert(note(2, "Two.md", "Two", &[], "Road and Cafe\u{301}")),
        ],
    )
    .expect("segment");

    assert_eq!(paths(&segment, "road"), ["One.md", "Two.md"]);
    assert_eq!(paths(&segment, "roadm"), ["One.md"]);
    assert_eq!(paths(&segment, "café"), ["One.md", "Two.md"]);
}

#[test]
fn boolean_operators_and_parentheses_use_the_live_note_universe() {
    let segment = Segment::build(
        zone(),
        acl(),
        [
            Change::Upsert(note(1, "A.md", "A", &[], "red green")),
            Change::Upsert(note(2, "B.md", "B", &[], "green blue")),
            Change::Upsert(note(3, "C.md", "C", &[], "blue")),
            Change::Delete(mb_search::NoteIdentity::Uuid(id(4))),
        ],
    )
    .expect("segment");

    assert_eq!(paths(&segment, "green AND NOT red"), ["B.md"]);
    assert_eq!(
        paths(&segment, "red OR (blue AND NOT green)"),
        ["A.md", "C.md"]
    );
    assert_eq!(paths(&segment, "NOT red"), ["B.md", "C.md"]);
}

#[test]
fn quoted_phrases_degrade_to_and_and_report_that_limit() {
    let segment = Segment::build(
        zone(),
        acl(),
        [Change::Upsert(note(
            1,
            "A.md",
            "A",
            &[],
            "step one appears before the word next",
        ))],
    )
    .expect("segment");
    let result = segment
        .search(&Query::parse("\"next step\"").expect("query"))
        .expect("search");

    assert_eq!(result.hits.len(), 1);
    assert!(result.phrase_degraded);
}

#[test]
fn snippet_is_the_first_two_hundred_unicode_characters_not_bytes() {
    let text = "🫐".repeat(250);
    let segment = Segment::build(
        zone(),
        acl(),
        [Change::Upsert(note(1, "A.md", "Berry", &[], &text))],
    )
    .expect("segment");
    let result = segment
        .search(&Query::parse("title:berry").expect("query"))
        .expect("search");

    assert_eq!(result.hits[0].note.snippet.chars().count(), 200);
}

#[test]
fn checksum_rejects_corruption_before_any_query_reads_it() {
    let segment = Segment::build(
        zone(),
        acl(),
        [Change::Upsert(note(1, "A.md", "A", &[], "searchable"))],
    )
    .expect("segment");
    let mut bytes = segment.as_bytes().to_vec();
    let last = bytes.len() - 1;
    bytes[last] ^= 1;

    assert!(matches!(
        Segment::from_bytes(bytes),
        Err(mb_search::Error::Checksum)
    ));
}

#[test]
fn identical_input_has_identical_bytes_regardless_of_change_order() {
    let left = Segment::build(
        zone(),
        acl(),
        [
            Change::Upsert(note(2, "B.md", "B", &[], "second")),
            Change::Upsert(note(1, "A.md", "A", &[], "first")),
        ],
    )
    .expect("segment");
    let right = Segment::build(
        zone(),
        acl(),
        [
            Change::Upsert(note(1, "A.md", "A", &[], "first")),
            Change::Upsert(note(2, "B.md", "B", &[], "second")),
        ],
    )
    .expect("segment");

    assert_eq!(left.as_bytes(), right.as_bytes());
}

#[test]
fn a_note_without_frontmatter_uuid_uses_its_path_identity() {
    let mut imported = note(1, "Imported/Legacy.md", "Legacy", &[], "old imported note");
    imported.id = None;
    let base = Segment::build(zone(), acl(), [Change::Upsert(imported)]).expect("base");
    let delta = Segment::build(
        zone(),
        acl(),
        [Change::Delete(mb_search::NoteIdentity::Path(
            "Imported/Legacy.md".into(),
        ))],
    )
    .expect("delta");
    let merged = Segment::merge(&[base, delta]).expect("merge");

    assert!(paths(&merged, "imported").is_empty());
}
