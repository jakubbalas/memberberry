// why: test setup must stop immediately when a fixture cannot be constructed or inspected.
#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use mb_core::frontmatter::YamlValue;
use mb_core::model::{Block, BlockKind, Document, Inline, List, ListItem};
use proptest::prelude::*;
use yrs::updates::decoder::Decode;
use yrs::{Doc, Map, ReadTxn, Transact, Update, WriteTxn, XmlElementRef, XmlFragment, XmlOut};

use mb_crdt::{
    EXTERNAL_ORIGIN, FRONTMATTER_ROOT, PROSEMIRROR_ROOT, apply_external_document,
    apply_external_markdown, document_from_yrs, document_to_yrs, encode_update_v1,
};

#[test]
fn insertion_preserves_every_unchanged_top_level_yjs_identity() {
    let doc = document_to_yrs(&paragraphs(&["alpha", "beta", "gamma"])).unwrap();
    let before = top_level_nodes(&doc);

    let change =
        apply_external_document(&doc, &paragraphs(&["alpha", "inserted", "beta", "gamma"]))
            .unwrap();
    let after = top_level_nodes(&doc);

    assert_eq!(change.inserted_blocks, 1);
    assert_eq!(change.deleted_blocks, 0);
    assert_eq!(after.first(), before.first());
    assert_eq!(after.get(2), before.get(1));
    assert_eq!(after.get(3), before.get(2));
}

#[test]
fn separated_replacements_patch_only_the_changed_spans() {
    let doc = document_to_yrs(&paragraphs(&["a", "b", "c", "d", "e"])).unwrap();
    let before = top_level_nodes(&doc);

    let change = apply_external_document(&doc, &paragraphs(&["a", "x", "c", "y", "e"])).unwrap();
    let after = top_level_nodes(&doc);

    assert_eq!(change.inserted_blocks, 2);
    assert_eq!(change.deleted_blocks, 2);
    assert_eq!(after.first(), before.first());
    assert_eq!(after.get(2), before.get(2));
    assert_eq!(after.get(4), before.get(4));
    assert_eq!(
        document_from_yrs(&doc).unwrap(),
        paragraphs(&["a", "x", "c", "y", "e"])
    );
}

#[test]
fn semantic_noop_emits_no_yjs_update() {
    let doc = document_to_yrs(&paragraphs(&["unchanged"])).unwrap();
    let updates = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&updates);
    let _subscription = doc
        .observe_update_v1(move |_, _| {
            observed.fetch_add(1, Ordering::Relaxed);
        })
        .unwrap();

    let change = apply_external_markdown(&doc, "unchanged\n").unwrap();

    assert!(!change.changed());
    assert_eq!(updates.load(Ordering::Relaxed), 0);
}

#[test]
fn a_change_is_one_transaction_with_the_external_origin() {
    let doc = document_to_yrs(&paragraphs(&["before"])).unwrap();
    let updates = Arc::new(AtomicUsize::new(0));
    let has_external_origin = Arc::new(AtomicBool::new(false));
    let observed_updates = Arc::clone(&updates);
    let observed_origin = Arc::clone(&has_external_origin);
    let _subscription = doc
        .observe_update_v1(move |txn, _| {
            observed_updates.fetch_add(1, Ordering::Relaxed);
            observed_origin.store(
                txn.origin()
                    .is_some_and(|origin| origin.as_ref() == EXTERNAL_ORIGIN.as_bytes()),
                Ordering::Relaxed,
            );
        })
        .unwrap();

    apply_external_markdown(&doc, "after\n").unwrap();

    assert_eq!(updates.load(Ordering::Relaxed), 1);
    assert!(has_external_origin.load(Ordering::Relaxed));
}

#[test]
fn frontmatter_changes_are_per_key_and_converge_with_an_unrelated_edit() {
    let mut base = mb_core::parse("---\nstatus: draft\n---\n\nbody\n");
    base.frontmatter.id = Some("note-id".to_string());
    let server = document_to_yrs(&base).unwrap();
    let client = clone_doc(&server);

    let mut external = base.clone();
    external.frontmatter.extra.insert(
        "status".to_string(),
        YamlValue::Scalar("published".to_string()),
    );
    let change = apply_external_document(&server, &external).unwrap();
    let mut client_txn = client.transact_mut();
    let client_frontmatter = client_txn.get_or_insert_map(FRONTMATTER_ROOT);
    client_frontmatter.insert(&mut client_txn, "icon", ":berry:");
    drop(client_txn);

    exchange_complete_states(&server, &client);
    let server_doc = document_from_yrs(&server).unwrap();
    let client_doc = document_from_yrs(&client).unwrap();

    assert_eq!(change.frontmatter_keys, 1);
    assert_eq!(server_doc, client_doc);
    assert_eq!(server_doc.frontmatter.icon.as_deref(), Some(":berry:"));
    assert_eq!(
        server_doc.frontmatter.extra.get("status"),
        Some(&YamlValue::Scalar("published".to_string()))
    );
}

#[test]
fn removing_every_block_leaves_the_required_empty_editor_paragraph() {
    let doc = document_to_yrs(&paragraphs(&["remove me"])).unwrap();

    let change = apply_external_markdown(&doc, "").unwrap();

    assert_eq!(change.inserted_blocks, 1);
    assert_eq!(change.deleted_blocks, 1);
    assert_eq!(document_from_yrs(&doc).unwrap(), Document::default());
    assert_eq!(top_level_nodes(&doc).len(), 1);
}

#[test]
fn invalid_external_documents_are_rejected_before_mutation() {
    let doc = document_to_yrs(&paragraphs(&["safe"])).unwrap();
    let before = encode_update_v1(&doc);
    let invalid = Document::new(vec![Block::new(BlockKind::List(List {
        ordered: true,
        start: 9_007_199_254_740_992,
        items: vec![ListItem {
            task: None,
            content: vec![paragraph("item")],
        }],
    }))]);

    assert!(apply_external_document(&doc, &invalid).is_err());
    assert_eq!(encode_update_v1(&doc), before);
}

#[test]
fn malformed_current_crdt_state_is_rejected_before_mutation() {
    let doc = Doc::new();
    let before = encode_update_v1(&doc);

    assert!(apply_external_markdown(&doc, "safe target\n").is_err());
    assert_eq!(encode_update_v1(&doc), before);
}

#[test]
fn deleting_a_frontmatter_key_does_not_rewrite_the_others() {
    let doc = document_to_yrs(&mb_core::parse(
        "---\nid: note-id\nstatus: draft\n---\n\nbody\n",
    ))
    .unwrap();

    let change = apply_external_markdown(&doc, "---\nid: note-id\n---\n\nbody\n").unwrap();
    let materialized = document_from_yrs(&doc).unwrap();

    assert_eq!(change.frontmatter_keys, 1);
    assert_eq!(materialized.frontmatter.id.as_deref(), Some("note-id"));
    assert!(!materialized.frontmatter.extra.contains_key("status"));
}

#[test]
fn a_single_edit_in_a_large_note_keeps_the_other_nodes() {
    let old = (0..2_000)
        .map(|index| format!("block {index}"))
        .collect::<Vec<_>>();
    let mut new = old.clone();
    if let Some(block) = new.get_mut(1_000) {
        *block = "externally edited".to_string();
    }
    let old_refs = old.iter().map(String::as_str).collect::<Vec<_>>();
    let new_refs = new.iter().map(String::as_str).collect::<Vec<_>>();
    let doc = document_to_yrs(&paragraphs(&old_refs)).unwrap();
    let before = top_level_nodes(&doc);

    let change = apply_external_document(&doc, &paragraphs(&new_refs)).unwrap();
    let after = top_level_nodes(&doc);

    assert_eq!(change.inserted_blocks, 1);
    assert_eq!(change.deleted_blocks, 1);
    assert_eq!(after.first(), before.first());
    assert_eq!(after.last(), before.last());
}

proptest! {
    #[test]
    fn applying_external_paragraph_sequences_materializes_the_target(
        old in prop::collection::vec("[a-z]{0,12}", 0..18),
        new in prop::collection::vec("[a-z]{0,12}", 0..18),
    ) {
        let old_refs = old.iter().map(String::as_str).collect::<Vec<_>>();
        let new_refs = new.iter().map(String::as_str).collect::<Vec<_>>();
        let doc = document_to_yrs(&paragraphs(&old_refs)).unwrap();
        let target = paragraphs(&new_refs);

        apply_external_document(&doc, &target).unwrap();

        prop_assert_eq!(document_from_yrs(&doc).unwrap(), mb_core::canonicalize(target));
    }
}

fn paragraphs(values: &[&str]) -> Document {
    Document::new(values.iter().map(|value| paragraph(value)).collect())
}

fn paragraph(value: &str) -> Block {
    Block::new(BlockKind::Paragraph(vec![Inline::Text(value.to_string())]))
}

fn top_level_nodes(doc: &Doc) -> Vec<XmlElementRef> {
    let txn = doc.transact();
    txn.get_xml_fragment(PROSEMIRROR_ROOT)
        .expect("test document has the ProseMirror root")
        .children(&txn)
        .filter_map(|node| match node {
            XmlOut::Element(element) => Some(element),
            XmlOut::Fragment(_) | XmlOut::Text(_) => None,
        })
        .collect()
}

fn clone_doc(source: &Doc) -> Doc {
    let clone = Doc::new();
    clone.get_or_insert_xml_fragment(PROSEMIRROR_ROOT);
    clone.get_or_insert_map(FRONTMATTER_ROOT);
    clone
        .transact_mut()
        .apply_update(Update::decode_v1(&encode_update_v1(source)).unwrap())
        .unwrap();
    clone
}

fn exchange_complete_states(left: &Doc, right: &Doc) {
    let left_update = encode_update_v1(left);
    let right_update = encode_update_v1(right);
    left.transact_mut()
        .apply_update(Update::decode_v1(&right_update).unwrap())
        .unwrap();
    right
        .transact_mut()
        .apply_update(Update::decode_v1(&left_update).unwrap())
        .unwrap();
}
