#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use mb_core::frontmatter::YamlValue;
use mb_core::model::{Block, BlockKind, Document, Inline};
use proptest::prelude::*;
use yrs::types::Attrs;
use yrs::updates::decoder::Decode;
use yrs::{
    Any, Doc, Map, ReadTxn, StateVector, Text, Transact, Update, WriteTxn, Xml, XmlElementPrelim,
    XmlFragment, XmlTextPrelim,
};

use mb_crdt::{
    CrdtError, FRONTMATTER_ROOT, PROSEMIRROR_ROOT, document_from_update_v1, document_from_yrs,
    document_to_yrs, encode_update_v1,
};

const FULL_FIXTURE: &str = include_str!("../fixtures/conformance/full.md");

#[test]
fn full_schema_fixture_round_trips_through_y_prosemirror_shape() {
    let expected = mb_core::parse(FULL_FIXTURE);
    let ydoc = document_to_yrs(&expected).expect("fixture must encode");
    let actual = document_from_yrs(&ydoc).expect("fixture must decode");

    assert_eq!(actual, expected);
    assert_eq!(
        mb_core::to_markdown(&actual),
        mb_core::normalize(FULL_FIXTURE)
    );
}

#[test]
fn fixture_reaches_every_xml_schema_node() {
    let ydoc = document_to_yrs(&mb_core::parse(FULL_FIXTURE)).expect("fixture must encode");
    let txn = ydoc.transact();
    let fragment = txn
        .get_xml_fragment(PROSEMIRROR_ROOT)
        .expect("encoder creates root");
    let reached = fragment
        .successors(&txn)
        .filter_map(|node| node.into_xml_element())
        .map(|element| element.tag().to_string())
        .collect::<BTreeSet<_>>();
    let expected = mb_core::schema::Node::ALL
        .iter()
        .filter_map(|node| {
            let name = node.name();
            (!matches!(name, "doc" | "text")).then(|| name.to_string())
        })
        .collect::<BTreeSet<_>>();

    assert_eq!(reached, expected);
}

#[test]
fn lib0_v1_update_is_a_complete_portable_sidecar_state() {
    let expected = mb_core::parse(FULL_FIXTURE);
    let source = document_to_yrs(&expected).expect("fixture must encode");
    let bytes = encode_update_v1(&source);
    let restored = document_from_update_v1(&bytes).expect("state update must decode");

    assert_eq!(document_from_yrs(&restored).unwrap(), expected);
}

#[test]
fn malformed_remote_node_is_rejected_without_partial_document() {
    let ydoc = Doc::new();
    let mut txn = ydoc.transact_mut();
    let fragment = txn.get_or_insert_xml_fragment(PROSEMIRROR_ROOT);
    txn.get_or_insert_map(FRONTMATTER_ROOT);
    fragment.push_back(&mut txn, XmlElementPrelim::empty("database_view"));
    drop(txn);

    let error = document_from_yrs(&ydoc).expect_err("unknown nodes must fail closed");
    assert!(matches!(error, CrdtError::Malformed { .. }));
    assert!(
        error
            .to_string()
            .contains("unknown block node `database_view`")
    );
}

#[test]
fn invalid_remote_structure_is_rejected_before_canonicalization_can_drop_it() {
    let ydoc = node_doc("bullet_list");

    let error = document_from_yrs(&ydoc).expect_err("empty remote list must fail closed");
    assert!(matches!(error, CrdtError::InvalidBlockDocument(_)));
    assert!(error.to_string().contains("list has no items"));
}

#[test]
fn malformed_wire_update_is_rejected() {
    let error = document_from_update_v1(&[0xff, 0x01]).expect_err("wire garbage must fail");
    assert!(matches!(error, CrdtError::InvalidUpdate(_)));
}

#[test]
fn schema_invalid_source_document_is_rejected_before_creating_merge_state() {
    let document = Document::new(vec![Block::new(BlockKind::List(mb_core::model::List {
        ordered: false,
        start: 1,
        items: Vec::new(),
    }))]);

    let error = document_to_yrs(&document).expect_err("empty lists are not schema-valid");
    assert!(matches!(error, CrdtError::InvalidBlockDocument(_)));
    assert!(error.to_string().contains("list has no items"));
}

#[test]
fn missing_shared_roots_are_rejected() {
    let empty = Doc::new();
    let error = document_from_yrs(&empty).expect_err("both roots are required");
    assert!(error.to_string().contains("missing Y.XmlFragment root"));

    let content_only = Doc::new();
    content_only.get_or_insert_xml_fragment(PROSEMIRROR_ROOT);
    let error = document_from_yrs(&content_only).expect_err("frontmatter root is required");
    assert!(error.to_string().contains("missing Y.Map root"));
}

#[test]
fn malformed_frontmatter_values_are_rejected() {
    for (key, value, reason) in [
        ("tags", Any::Bool(true), "expected string[]"),
        ("custom", Any::Bool(true), "frontmatter value must be"),
        (
            "custom",
            Any::Map(Arc::new(HashMap::from([(
                "$memberberry".to_string(),
                Any::from("future"),
            )]))),
            "unknown frontmatter envelope",
        ),
        (
            "custom",
            Any::Map(Arc::new(HashMap::from([(
                "$memberberry".to_string(),
                Any::from("raw"),
            )]))),
            "needs lines[]",
        ),
    ] {
        let doc = paragraph_doc();
        let mut txn = doc.transact_mut();
        txn.get_or_insert_map(FRONTMATTER_ROOT)
            .insert(&mut txn, key, value);
        drop(txn);
        let error = document_from_yrs(&doc).expect_err("bad frontmatter must fail closed");
        assert!(error.to_string().contains(reason));
    }
}

#[test]
fn malformed_structural_attributes_are_rejected() {
    let heading = node_doc("heading");
    {
        let mut txn = heading.transact_mut();
        let root = txn.get_or_insert_xml_fragment(PROSEMIRROR_ROOT);
        let element = root.get(&txn, 0).unwrap().into_xml_element().unwrap();
        element.insert_attribute(&mut txn, "level", Any::Number(9.0));
    }
    assert!(
        document_from_yrs(&heading)
            .expect_err("level 9 must fail")
            .to_string()
            .contains("expected integer 1..=6")
    );

    let ordered = node_doc("ordered_list");
    assert!(
        document_from_yrs(&ordered)
            .expect_err("ordered list needs start")
            .to_string()
            .contains("missing attribute")
    );

    let callout = node_doc("callout");
    {
        let mut txn = callout.transact_mut();
        let root = txn.get_or_insert_xml_fragment(PROSEMIRROR_ROOT);
        let element = root.get(&txn, 0).unwrap().into_xml_element().unwrap();
        element.insert_attribute(&mut txn, "kind", "warning");
        element.insert_attribute(&mut txn, "fold", "sideways");
    }
    assert!(
        document_from_yrs(&callout)
            .expect_err("unknown fold must fail")
            .to_string()
            .contains("unknown fold")
    );
}

#[test]
fn malformed_task_metadata_is_rejected() {
    for (status, priority, due, reason) in [
        ("waiting", Any::Null, Any::Null, "unknown status"),
        ("todo", Any::from("urgent"), Any::Null, "unknown priority"),
        (
            "todo",
            Any::Null,
            Any::from("2026-02-30"),
            "expected YYYY-MM-DD",
        ),
    ] {
        let doc = node_doc("bullet_list");
        let mut txn = doc.transact_mut();
        let root = txn.get_or_insert_xml_fragment(PROSEMIRROR_ROOT);
        let list = root.get(&txn, 0).unwrap().into_xml_element().unwrap();
        let task = list.push_back(&mut txn, XmlElementPrelim::empty("task_item"));
        task.insert_attribute(&mut txn, "status", status);
        task.insert_attribute(&mut txn, "priority", priority);
        task.insert_attribute(&mut txn, "due", due);
        task.insert_attribute(&mut txn, "unknown", Any::Array(Vec::new().into()));
        drop(txn);
        let error = document_from_yrs(&doc).expect_err("bad task metadata must fail");
        assert!(error.to_string().contains(reason));
    }
}

#[test]
fn malformed_inline_content_is_rejected() {
    let unknown_atom = paragraph_doc();
    {
        let mut txn = unknown_atom.transact_mut();
        let root = txn.get_or_insert_xml_fragment(PROSEMIRROR_ROOT);
        let paragraph = root.get(&txn, 0).unwrap().into_xml_element().unwrap();
        paragraph.push_back(&mut txn, XmlElementPrelim::empty("mention"));
    }
    assert!(
        document_from_yrs(&unknown_atom)
            .expect_err("unknown atom must fail")
            .to_string()
            .contains("unknown inline node")
    );

    let unknown_mark = paragraph_doc();
    {
        let mut txn = unknown_mark.transact_mut();
        let root = txn.get_or_insert_xml_fragment(PROSEMIRROR_ROOT);
        let paragraph = root.get(&txn, 0).unwrap().into_xml_element().unwrap();
        let text = paragraph.push_back(&mut txn, XmlTextPrelim::new(""));
        text.insert_with_attributes(
            &mut txn,
            0,
            "secret",
            Attrs::from([("spoiler".into(), Any::Map(Arc::new(HashMap::new())))]),
        );
    }
    assert!(
        document_from_yrs(&unknown_mark)
            .expect_err("unknown mark must fail")
            .to_string()
            .contains("unknown mark")
    );
}

#[test]
fn inconsistent_wikilink_and_table_shapes_are_rejected() {
    let wikilink = paragraph_doc();
    {
        let mut txn = wikilink.transact_mut();
        let root = txn.get_or_insert_xml_fragment(PROSEMIRROR_ROOT);
        let paragraph = root.get(&txn, 0).unwrap().into_xml_element().unwrap();
        let link = paragraph.push_back(&mut txn, XmlElementPrelim::empty("wikilink"));
        link.insert_attribute(&mut txn, "target", "Target");
        link.insert_attribute(&mut txn, "anchor_kind", "none");
        link.insert_attribute(&mut txn, "anchor_text", "Heading");
        link.insert_attribute(&mut txn, "alias", Any::Null);
        link.insert_attribute(&mut txn, "embed", Any::Bool(false));
    }
    assert!(
        document_from_yrs(&wikilink)
            .expect_err("inconsistent anchor must fail")
            .to_string()
            .contains("must not have text")
    );

    let table = node_doc("table");
    {
        let mut txn = table.transact_mut();
        let root = txn.get_or_insert_xml_fragment(PROSEMIRROR_ROOT);
        let element = root.get(&txn, 0).unwrap().into_xml_element().unwrap();
        element.insert_attribute(
            &mut txn,
            "alignments",
            Any::Array(vec![Any::from("diagonal")].into()),
        );
    }
    assert!(
        document_from_yrs(&table)
            .expect_err("unknown alignment must fail")
            .to_string()
            .contains("unknown alignment")
    );
}

#[test]
fn concurrent_xml_and_frontmatter_edits_converge() {
    let base = document_to_yrs(&mb_core::parse("base\n")).expect("base must encode");
    let base_update = encode_update_v1(&base);
    let left = document_from_update_v1(&base_update).unwrap();
    let right = document_from_update_v1(&base_update).unwrap();

    append_paragraph_and_metadata(&left, "left", "left-key");
    append_paragraph_and_metadata(&right, "right", "right-key");

    let left_update = left
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let right_update = right
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    left.transact_mut()
        .apply_update(Update::decode_v1(&right_update).unwrap())
        .unwrap();
    right
        .transact_mut()
        .apply_update(Update::decode_v1(&left_update).unwrap())
        .unwrap();

    let left_document = document_from_yrs(&left).unwrap();
    let right_document = document_from_yrs(&right).unwrap();
    assert_eq!(left_document, right_document);
    assert_eq!(
        mb_core::to_markdown(&left_document),
        mb_core::to_markdown(&right_document)
    );
    assert_eq!(
        left_document.frontmatter.extra.get("left-key"),
        Some(&YamlValue::Scalar("left".to_string()))
    );
    assert_eq!(
        left_document.frontmatter.extra.get("right-key"),
        Some(&YamlValue::Scalar("right".to_string()))
    );
}

fn append_paragraph_and_metadata(doc: &Doc, value: &str, key: &str) {
    let mut txn = doc.transact_mut();
    let fragment = txn.get_or_insert_xml_fragment(PROSEMIRROR_ROOT);
    let paragraph = fragment.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
    paragraph.push_back(&mut txn, yrs::XmlTextPrelim::new(value));
    let frontmatter = txn.get_or_insert_map(FRONTMATTER_ROOT);
    frontmatter.insert(&mut txn, key, value);
}

fn paragraph_doc() -> Doc {
    node_doc("paragraph")
}

fn node_doc(tag: &str) -> Doc {
    let doc = Doc::new();
    let mut txn = doc.transact_mut();
    txn.get_or_insert_xml_fragment(PROSEMIRROR_ROOT)
        .push_back(&mut txn, XmlElementPrelim::empty(tag));
    txn.get_or_insert_map(FRONTMATTER_ROOT);
    drop(txn);
    doc
}

proptest! {
    #[test]
    fn plain_text_materialization_is_total_and_round_trips(
        value in proptest::collection::vec(any::<char>().prop_filter(
            "ProseMirror text nodes cannot contain line breaks",
            |value| !matches!(value, '\r' | '\n'),
        ), 0..128).prop_map(|chars| chars.into_iter().collect::<String>()),
    ) {
        let document = mb_core::canonicalize(Document::new(vec![Block::new(
            BlockKind::Paragraph(vec![Inline::Text(value)]),
        )]));
        let ydoc = document_to_yrs(&document).expect("generated document is schema-valid");
        let decoded = document_from_yrs(&ydoc).expect("generated Y document must decode");
        prop_assert_eq!(decoded, document);
    }
}
