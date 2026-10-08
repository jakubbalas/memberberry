#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]
use mb_crdt::{
    PROSEMIRROR_ROOT, document_from_update_v1, document_from_yrs, document_to_yrs, encode_update_v1,
};
use std::collections::HashMap;
use std::sync::Arc;
use yrs::types::Attrs;
use yrs::updates::decoder::Decode;
use yrs::{
    Any, Doc, ReadTxn, Text, Transact, Update, WriteTxn, XmlElementPrelim, XmlFragment,
    XmlTextPrelim, XmlTextRef,
};

fn wire_value(value: &str) -> Any {
    Any::Map(Arc::new(HashMap::from([(
        "value".into(),
        Any::from(value),
    )])))
}
fn text(doc: &Doc) -> XmlTextRef {
    let txn = doc.transact();
    txn.get_xml_fragment(PROSEMIRROR_ROOT)
        .expect("root")
        .get(&txn, 0)
        .and_then(|n| n.into_xml_element())
        .expect("paragraph")
        .get(&txn, 0)
        .and_then(|n| n.into_xml_text())
        .expect("text")
}
fn marked_doc(attrs: Attrs) -> Doc {
    let doc = Doc::new();
    let mut txn = doc.transact_mut();
    txn.get_or_insert_map(mb_crdt::FRONTMATTER_ROOT);
    let root = txn.get_or_insert_xml_fragment(PROSEMIRROR_ROOT);
    let p = root.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
    let t = p.push_back(&mut txn, XmlTextPrelim::new(""));
    t.insert_with_attributes(&mut txn, 0, "shared", attrs);
    drop(txn);
    doc
}

#[test]
fn independent_style_dimensions_survive_every_concurrent_pair() {
    let marks = [
        ("mb_underline", Any::Map(Arc::new(HashMap::new()))),
        ("mb_color", wire_value("red")),
        ("mb_background", wire_value("yellow")),
        ("mb_size", wire_value("large")),
    ];
    let base = document_to_yrs(&mb_core::parse("shared")).expect("seed");
    let seed = encode_update_v1(&base);
    for i in 0..marks.len() {
        for j in i + 1..marks.len() {
            let a = document_from_update_v1(&seed).expect("A");
            let b = document_from_update_v1(&seed).expect("B");
            text(&a).format(
                &mut a.transact_mut(),
                0,
                6,
                Attrs::from([(marks[i].0.into(), marks[i].1.clone())]),
            );
            text(&b).format(
                &mut b.transact_mut(),
                0,
                6,
                Attrs::from([(marks[j].0.into(), marks[j].1.clone())]),
            );
            let ua = encode_update_v1(&a);
            let ub = encode_update_v1(&b);
            a.transact_mut()
                .apply_update(Update::decode_v1(&ub).expect("decode B"))
                .expect("merge B");
            b.transact_mut()
                .apply_update(Update::decode_v1(&ua).expect("decode A"))
                .expect("merge A");
            let da = document_from_yrs(&a).expect("materialize A");
            let db = document_from_yrs(&b).expect("materialize B");
            assert_eq!(da, db);
            let canonical = mb_core::to_markdown(&da);
            for name in [marks[i].0, marks[j].0] {
                assert!(canonical.contains(&name[3..]), "{canonical}");
            }
        }
    }
}

#[test]
fn same_dimension_races_converge_without_compound_or_hashed_keys() {
    let seed = encode_update_v1(&document_to_yrs(&mb_core::parse("shared")).expect("seed"));
    let a = document_from_update_v1(&seed).expect("A");
    let b = document_from_update_v1(&seed).expect("B");
    text(&a).format(
        &mut a.transact_mut(),
        0,
        6,
        Attrs::from([("mb_color".into(), wire_value("blue"))]),
    );
    text(&b).format(
        &mut b.transact_mut(),
        0,
        6,
        Attrs::from([("mb_color".into(), wire_value("red"))]),
    );
    let ua = encode_update_v1(&a);
    let ub = encode_update_v1(&b);
    a.transact_mut()
        .apply_update(Update::decode_v1(&ub).expect("B"))
        .expect("merge");
    b.transact_mut()
        .apply_update(Update::decode_v1(&ua).expect("A"))
        .expect("merge");
    assert_eq!(
        document_from_yrs(&a).expect("A materialize"),
        document_from_yrs(&b).expect("B materialize")
    );
    assert_eq!(
        text(&a)
            .diff(&a.transact(), |_| ())
            .first()
            .expect("chunk")
            .attributes
            .as_deref()
            .expect("attrs")
            .len(),
        1
    );
}

#[test]
fn null_mark_is_the_native_y_text_removal_not_a_malformed_value() {
    let doc = marked_doc(Attrs::from([("mb_color".into(), Any::Null)]));
    assert_eq!(
        mb_core::to_markdown(&document_from_yrs(&doc).expect("absence is default")),
        "shared\n"
    );
}

#[test]
fn malformed_constructed_wire_attributes_fail_before_normalization() {
    let empty = Any::Map(Arc::new(HashMap::new()));
    let extra = Any::Map(Arc::new(HashMap::from([
        ("value".into(), Any::from("red")),
        ("style".into(), Any::from("evil")),
    ])));
    for (name, value) in [
        ("mb_underline", Any::Bool(true)),
        ("mb_underline", wire_value("true")),
        ("mb_color", empty.clone()),
        ("mb_color", extra),
        ("mb_color", wire_value("Red")),
        ("mb_color", wire_value("#ff0000")),
        ("mb_background", wire_value("default")),
        ("mb_size", wire_value("normal")),
        (
            "mb_size",
            Any::Map(Arc::new(HashMap::from([(
                "value".into(),
                Any::Number(2.0),
            )]))),
        ),
        (
            "mb_color",
            Any::Map(Arc::new(HashMap::from([("value".into(), Any::Null)]))),
        ),
        ("mb_color--hash", wire_value("red")),
        ("mb_style", empty.clone()),
    ] {
        assert!(
            document_from_yrs(&marked_doc(Attrs::from([(name.into(), value.clone())]))).is_err(),
            "{name}: {value:?}"
        );
    }
    for name in ["mb_underline", "mb_color", "mb_background", "mb_size"] {
        let value = match name {
            "mb_underline" => empty.clone(),
            "mb_size" => wire_value("small"),
            _ => wire_value("gray"),
        };
        let valid = Attrs::from([(name.into(), value), ("code".into(), empty.clone())]);
        assert!(
            document_from_yrs(&marked_doc(valid)).is_err(),
            "code + {name}"
        );
    }
}
