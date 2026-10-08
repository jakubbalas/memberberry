//! New native generations must not fragment text at mark-scope boundaries.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
use mb_core::model::{Block, BlockKind, Document, Inline};
use mb_crdt::{
    PROSEMIRROR_ROOT, document_from_update_v1, document_from_yrs, document_to_yrs, encode_update_v1,
};
use proptest::prelude::*;
use yrs::{ReadTxn, Text, Transact, XmlFragment};

#[test]
fn recursive_marks_share_one_text_region_with_exact_run_attributes() {
    let model = mb_core::parse("**α🙂** _終é_ [`literal`](https://example.org \"\") plain\n");
    let doc = document_to_yrs(&model).unwrap();
    let txn = doc.transact();
    let root = txn.get_xml_fragment(PROSEMIRROR_ROOT).unwrap();
    let paragraph = root.get(&txn, 0).unwrap().into_xml_element().unwrap();
    assert_eq!(paragraph.len(&txn), 1, "mark scopes must not split XmlText");
    let text = paragraph.get(&txn, 0).unwrap().into_xml_text().unwrap();
    let runs = text.diff(&txn, |_| ());
    let values: Vec<_> = runs
        .iter()
        .map(|r| r.insert.clone().to_string(&txn))
        .collect();
    assert_eq!(values, ["α🙂", " ", "終é", " ", "literal", " plain"]);
    let keys: Vec<Vec<_>> = runs
        .iter()
        .map(|r| {
            let mut keys: Vec<_> = r
                .attributes
                .as_deref()
                .map(|a| a.keys().map(|k| k.to_string()).collect())
                .unwrap_or_default();
            keys.sort();
            keys
        })
        .collect();
    assert_eq!(
        keys,
        [
            vec!["strong"],
            vec![],
            vec!["em"],
            vec![],
            vec!["code", "link"],
            vec![]
        ]
    );
    drop(txn);
    assert_eq!(document_from_yrs(&doc).unwrap(), model);
    let fresh = document_from_update_v1(&encode_update_v1(&doc)).unwrap();
    assert_eq!(document_from_yrs(&fresh).unwrap(), model);
}

#[test]
fn atoms_break_regions_and_empty_runs_do_not_create_wrappers() {
    let model = Document::new(vec![
        Block::new(BlockKind::Paragraph(vec![
            Inline::Text(String::new()),
            Inline::Strong(vec![
                Inline::Text("🙂".into()),
                Inline::Math("x".into()),
                Inline::Text("終".into()),
            ]),
            Inline::Text(" plain".into()),
            Inline::Emphasis(vec![]),
        ])),
        Block::new(BlockKind::Paragraph(vec![])),
    ]);
    let doc = document_to_yrs(&model).unwrap();
    let txn = doc.transact();
    let root = txn.get_xml_fragment(PROSEMIRROR_ROOT).unwrap();
    let p = root.get(&txn, 0).unwrap().into_xml_element().unwrap();
    assert_eq!(p.len(&txn), 3);
    let left = p.get(&txn, 0).unwrap().into_xml_text().unwrap();
    let atom = p.get(&txn, 1).unwrap().into_xml_element().unwrap();
    let right = p.get(&txn, 2).unwrap().into_xml_text().unwrap();
    assert_eq!(atom.tag().as_ref(), "inline_math");
    assert_eq!(
        left.diff(&txn, |_| ())[0].insert.clone().to_string(&txn),
        "🙂"
    );
    let runs = right.diff(&txn, |_| ());
    assert_eq!(runs.len(), 2);
    assert_eq!(runs[0].insert.clone().to_string(&txn), "終");
    assert_eq!(runs[1].insert.clone().to_string(&txn), " plain");
    assert!(runs[0].attributes.as_ref().unwrap().contains_key("strong"));
    assert!(runs[1].attributes.as_ref().is_none_or(|a| a.is_empty()));
    assert_eq!(
        root.get(&txn, 1)
            .unwrap()
            .into_xml_element()
            .unwrap()
            .len(&txn),
        0
    );
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 64, rng_seed: proptest::test_runner::RngSeed::Fixed(20261006), ..ProptestConfig::default() })]
    #[test]
    fn unicode_mark_transitions_roundtrip(n in 1usize..40) {
        let a = "🙂終é".repeat(n);
        let b = "🦀α".repeat(n);
        let model = Document::new(vec![Block::new(BlockKind::Paragraph(vec![
            Inline::Strong(vec![Inline::Text(a.clone())]),
            Inline::Text(b.clone()),
            Inline::Emphasis(vec![Inline::Text(a.clone())]),
        ]))]);
        let doc = document_to_yrs(&model).unwrap();
        let txn = doc.transact();
        let root = txn.get_xml_fragment(PROSEMIRROR_ROOT).unwrap();
        let p = root.get(&txn, 0).unwrap().into_xml_element().unwrap();
        prop_assert_eq!(p.len(&txn), 1);
        let t = p.get(&txn, 0).unwrap().into_xml_text().unwrap();
        let runs = t.diff(&txn, |_| ());
        let literal: String = runs.iter().map(|r| r.insert.clone().to_string(&txn)).collect();
        prop_assert_eq!(literal, format!("{a}{b}{a}"));
        prop_assert_eq!(runs.len(), 3);
        prop_assert!(runs[0].attributes.as_ref().unwrap().contains_key("strong"));
        prop_assert!(runs[1].attributes.as_ref().is_none_or(|a| a.is_empty()));
        prop_assert!(runs[2].attributes.as_ref().unwrap().contains_key("em"));
        drop(txn);
        // Hand-built adjacent emphasis can be noncanonical CommonMark. The native
        // runs above remain exact; the public decoder deliberately canonicalizes.
        let expected = mb_core::canonicalize(model);
        prop_assert_eq!(document_from_yrs(&doc).unwrap(), expected.clone());
        let fresh = document_from_update_v1(&encode_update_v1(&doc)).unwrap();
        prop_assert_eq!(document_from_yrs(&fresh).unwrap(), expected);
    }
}
