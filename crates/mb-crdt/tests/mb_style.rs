#![allow(clippy::expect_used, clippy::unwrap_used)]
use mb_crdt::{
    PROSEMIRROR_ROOT, document_from_update_v1, document_from_yrs, document_to_yrs, encode_update_v1,
};
use yrs::{ReadTxn, Text, Transact, XmlFragment};

#[test]
fn size_survives_binary_reopen_with_all_dimensions() {
    let source =
        ":mb-style[all]{underline=\"true\" color=\"pink\" background=\"blue\" size=\"large\"}\n";
    let doc = document_to_yrs(&mb_core::parse(source)).expect("encode");
    let reopened = document_from_update_v1(&encode_update_v1(&doc)).expect("reopen");
    assert_eq!(
        mb_core::to_markdown(&document_from_yrs(&reopened).expect("decode")),
        source
    );
}

#[test]
fn background_has_a_separate_wire_key() {
    let expected = mb_core::parse(
        ":mb-style[==highlight==]{underline=\"true\" color=\"blue\" background=\"yellow\"}",
    );
    let doc = document_to_yrs(&expected).expect("encode");
    let txn = doc.transact();
    let root = txn.get_xml_fragment(PROSEMIRROR_ROOT).expect("root");
    assert!(
        root.successors(&txn)
            .filter_map(|n| n.into_xml_text())
            .flat_map(|t| t.diff(&txn, |_| ()))
            .any(|c| c
                .attributes
                .as_deref()
                .is_some_and(|a| a.contains_key("mb_background")
                    && a.contains_key("highlight")
                    && a.contains_key("mb_color")))
    );
    drop(txn);
    assert_eq!(document_from_yrs(&doc).expect("decode"), expected);
}

#[test]
fn color_roundtrips_with_native_marks_and_underline() {
    let source = ":mb-style[hello **bold** and [link](https://example.test)]{underline=\"true\" color=\"red\"}";
    let expected = mb_core::parse(source);
    let doc = document_to_yrs(&expected).expect("encode");
    let txn = doc.transact();
    let root = txn.get_xml_fragment(PROSEMIRROR_ROOT).expect("root");
    assert!(
        root.successors(&txn)
            .filter_map(|n| n.into_xml_text())
            .flat_map(|t| t.diff(&txn, |_| ()))
            .any(|c| c
                .attributes
                .as_deref()
                .is_some_and(|a| a.contains_key("mb_color")))
    );
    drop(txn);
    assert_eq!(document_from_yrs(&doc).expect("decode"), expected);
}

#[test]
fn underline_has_an_independent_empty_object_wire_mark() {
    let expected = mb_core::parse(":mb-style[hello]{underline=\"true\"}");
    let doc = document_to_yrs(&expected).expect("style encodes");
    {
        let txn = doc.transact();
        let root = txn.get_xml_fragment(PROSEMIRROR_ROOT).expect("root");
        let para = root
            .get(&txn, 0)
            .and_then(|n| n.into_xml_element())
            .expect("paragraph");
        let text = para
            .get(&txn, 0)
            .and_then(|n| n.into_xml_text())
            .expect("text");
        let chunks = text.diff(&txn, |_| ());
        let attrs = chunks
            .first()
            .and_then(|c| c.attributes.as_deref())
            .expect("marked");
        assert!(matches!(attrs.get("mb_underline"), Some(yrs::Any::Map(m)) if m.is_empty()));
    }
    assert_eq!(document_from_yrs(&doc).expect("decode"), expected);
    let reopened = document_from_update_v1(&encode_update_v1(&doc)).expect("reopen");
    assert_eq!(document_from_yrs(&reopened).expect("materialize"), expected);
}

#[test]
fn mixed_atoms_code_and_table_breaks_are_preserved_outside_text_styles() {
    for source in [
        r#":mb-style[**bold** *em* ==mark== [link](https://example.test/a]b) [[Wiki#Head|alias]] #tag :berry: $x[y]$ `code]` end]{underline="true" color="red" background="yellow" size="large"}"#,
        "| :mb-style[a\\|b]{underline=\"true\"} | :mb-style[c]{color=\"blue\"} |\n| --- | --- |\n| :mb-style[x<br>y]{size=\"large\"} | end |",
    ] {
        let doc = mb_core::parse(source);
        let wire = document_to_yrs(&doc).expect("mixed source encodes");
        assert_eq!(document_from_yrs(&wire).expect("materialize"), doc);
        let reopened = document_from_update_v1(&encode_update_v1(&wire)).expect("reopen");
        assert_eq!(document_from_yrs(&reopened).expect("reopened"), doc);
    }
}
