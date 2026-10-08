//! Lossless ordinary wrappers around literal native code.
// why: integration tests, not library code (AGENTS.md 4.2) — a panic is the failure report.
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]
use mb_core::model::{Block, BlockKind, Document, Inline};
use mb_crdt::{document_from_update_v1, document_from_yrs, document_to_yrs, encode_update_v1};
use std::collections::HashMap;
use std::sync::Arc;
use yrs::{Any, Doc, Text, Transact, WriteTxn, XmlElementPrelim, XmlFragment, XmlTextPrelim};

fn raw_mark(name: &str, value: Any) -> Doc {
    let doc = Doc::new();
    let mut txn = doc.transact_mut();
    let root = txn.get_or_insert_xml_fragment("prosemirror");
    txn.get_or_insert_map("frontmatter");
    let p = root.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
    let text = p.push_back(&mut txn, XmlTextPrelim::new(""));
    text.insert_with_attributes(
        &mut txn,
        0,
        "literal",
        HashMap::from([(name.into(), value)]),
    );
    drop(txn);
    doc
}

#[test]
fn invalid_native_code_payload_is_refused_without_mutation() {
    let doc = raw_mark("code", Any::Bool(true));
    let before = encode_update_v1(&doc);
    assert!(document_from_update_v1(&before).is_err());
    assert!(document_from_yrs(&doc).is_err());
    assert_eq!(encode_update_v1(&doc), before);
}

#[test]
fn null_native_code_mark_is_removal_not_literal_code() {
    let doc = raw_mark("code", Any::Null);
    assert_eq!(
        document_from_yrs(&doc).unwrap(),
        mb_core::parse("literal\n")
    );
}

#[test]
fn hostile_native_mark_keys_and_attributes_are_refused_without_mutation() {
    let empty = Any::Map(Arc::new(HashMap::new()));
    for (name, value) in [
        ("unknown", empty.clone()),
        ("code--LpaW+ak5", empty.clone()),
        ("mb_color", empty.clone()),
        ("strong", Any::Bool(true)),
        (
            "code",
            Any::Map(Arc::new(HashMap::from([("extra".into(), Any::Bool(true))]))),
        ),
        (
            "link",
            Any::Map(Arc::new(HashMap::from([
                ("href".into(), Any::from("https://example.org")),
                ("extra".into(), Any::Bool(true)),
            ]))),
        ),
        (
            "link",
            Any::Map(Arc::new(HashMap::from([
                ("href".into(), Any::from("https://example.org")),
                ("title".into(), Any::Bool(true)),
            ]))),
        ),
    ] {
        let doc = raw_mark(name, value);
        let before = encode_update_v1(&doc);
        assert!(document_from_update_v1(&before).is_err(), "{name}");
        assert!(document_from_yrs(&doc).is_err(), "{name}");
        assert_eq!(encode_update_v1(&doc), before);
    }
}

#[test]
fn every_native_wrapper_subset_preserves_literal_code_and_link_title() {
    let mut receipts = Vec::new();
    for mask in 0..32 {
        let mut inline = Inline::Code("a `b` *c* [d](e) ==f== <g> 🦀".into());
        if mask & 16 != 0 {
            inline = Inline::Link {
                dest: "https://example.org/a?b=c".into(),
                title: Some("Authored \"title\" 🦀".into()),
                content: vec![inline],
            };
        }
        if mask & 8 != 0 {
            inline = Inline::Highlight(vec![inline]);
        }
        if mask & 4 != 0 {
            inline = Inline::Strikethrough(vec![inline]);
        }
        if mask & 2 != 0 {
            inline = Inline::Emphasis(vec![inline]);
        }
        if mask & 1 != 0 {
            inline = Inline::Strong(vec![inline]);
        }
        let model = Document::new(vec![Block::new(BlockKind::Paragraph(vec![inline]))]);
        let native = document_to_yrs(&model).expect("valid wrapper model");
        assert_eq!(document_from_yrs(&native).unwrap(), model, "subset {mask}");
        let reopened = document_from_update_v1(&encode_update_v1(&native)).unwrap();
        assert_eq!(
            document_from_yrs(&reopened).unwrap(),
            model,
            "binary {mask}"
        );
        let markdown = mb_core::to_markdown(&model);
        assert_eq!(
            mb_core::parse(&markdown),
            model,
            "canonical subset {mask}: {markdown}"
        );
        receipts.push(serde_json::json!({"mask":mask, "markdown":markdown,
            "model":format!("{model:?}"), "updateHex":encode_update_v1(&native).iter().map(|byte| format!("{byte:02x}")).collect::<String>()}));
    }
    if let Some(path) = std::env::var_os("MB_CODE_EVIDENCE") {
        let path = std::path::PathBuf::from(path);
        assert!(
            path.is_absolute() && path.is_dir(),
            "explicit evidence directory required"
        );
        std::fs::write(
            path.join("native-subsets.json"),
            serde_json::to_vec_pretty(&receipts).unwrap(),
        )
        .unwrap();
    }
}
