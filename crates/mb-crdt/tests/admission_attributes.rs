//! Complete raw-field admission, before lossy model materialization.
#![allow(clippy::expect_used, clippy::unwrap_used)]
use mb_core::schema::Node;
use mb_crdt::{PROSEMIRROR_ROOT, document_from_yrs, document_to_yrs, encode_update_v1};
use yrs::{ReadTxn, Transact, Xml, XmlFragment};
const FULL: &str = include_str!("../fixtures/conformance/full.md");

#[test]
fn native_encoder_optional_fields_task_metadata_and_anchored_styles_remain_exact() {
    let expected = mb_core::parse(FULL);
    let doc = document_to_yrs(&expected).expect("full native encoder");
    let before = encode_update_v1(&doc);
    assert_eq!(document_from_yrs(&doc).expect("admitted"), expected);
    assert_eq!(encode_update_v1(&doc), before);
    let reopened = mb_crdt::document_from_update_v1(&before).expect("binary reopen");
    assert_eq!(document_from_yrs(&reopened).expect("reopened"), expected);
}

#[test]
fn native_empty_objects_null_removal_and_link_title_shapes_remain_admitted() {
    use std::{collections::HashMap, sync::Arc};
    use yrs::Any;
    let empty = Any::Map(Arc::new(HashMap::new()));
    for name in ["strong", "em", "strikethrough", "highlight", "code"] {
        assert!(
            document_from_yrs(&native_doc(name, empty.clone())).is_ok(),
            "{name}"
        );
        assert_eq!(
            mb_core::to_markdown(
                &document_from_yrs(&native_doc(name, Any::Null)).expect("native removal")
            ),
            "KEEP\n"
        );
    }
    for title in [
        None,
        Some(Any::Null),
        Some(Any::from("Authored \"quoted\" title")),
    ] {
        let mut fields = HashMap::from([("href".into(), Any::from("https://example.test"))]);
        if let Some(title) = title {
            fields.insert("title".into(), title);
        }
        let doc = native_doc("link", Any::Map(Arc::new(fields)));
        let parsed = document_from_yrs(&doc).expect("valid optional link title");
        let source = mb_core::to_markdown(&parsed);
        assert_eq!(mb_core::parse(&source), parsed);
        assert_eq!(
            document_from_yrs(
                &mb_crdt::document_from_update_v1(&encode_update_v1(&doc)).expect("reopen")
            )
            .expect("decode"),
            parsed
        );
    }
}

proptest::proptest! {
    #![proptest_config(proptest::test_runner::Config::with_cases(32))]
    #[test]
    fn unknown_node_fields_never_materialize_or_mutate(name in "future_[a-z]{1,12}", value in ".{0,40}") {
        let doc = document_to_yrs(&mb_core::parse("KEEP")).expect("seed");
        let p = { let tx = doc.transact(); tx.get_xml_fragment(PROSEMIRROR_ROOT).expect("root").get(&tx, 0).expect("paragraph").into_xml_element().expect("element") };
        p.insert_attribute(&mut doc.transact_mut(), name.as_str(), value);
        let before = encode_update_v1(&doc);
        proptest::prop_assert!(document_from_yrs(&doc).is_err());
        proptest::prop_assert_eq!(encode_update_v1(&doc), before);
    }
}

fn native_doc(name: &str, payload: yrs::Any) -> yrs::Doc {
    use yrs::Text;
    let doc = document_to_yrs(&mb_core::parse("KEEP")).expect("seed");
    let text = {
        let tx = doc.transact();
        tx.get_xml_fragment(PROSEMIRROR_ROOT)
            .expect("root")
            .get(&tx, 0)
            .expect("paragraph")
            .into_xml_element()
            .expect("element")
            .get(&tx, 0)
            .expect("text")
            .into_xml_text()
            .expect("XmlText")
    };
    text.format(
        &mut doc.transact_mut(),
        0,
        4,
        yrs::types::Attrs::from([(name.into(), payload)]),
    );
    doc
}

#[test]
fn every_native_flag_mark_requires_its_declared_empty_object() {
    use std::{collections::HashMap, sync::Arc};
    use yrs::Any;
    for name in ["strong", "em", "strikethrough", "highlight", "code"] {
        for payload in [
            Any::Number(42.0),
            Any::Bool(true),
            Any::Bool(false),
            Any::from("yes"),
            Any::Array(Vec::new().into()),
            Any::Map(Arc::new(HashMap::from([(
                "future_attribute".into(),
                Any::Bool(true),
            )]))),
        ] {
            let doc = native_doc(name, payload.clone());
            let before = encode_update_v1(&doc);
            assert!(
                document_from_yrs(&doc).is_err(),
                "{name} accepted {payload:?}"
            );
            assert_eq!(encode_update_v1(&doc), before);
        }
    }
}

#[test]
fn every_native_element_rejects_undeclared_attributes_without_mutation() {
    for node in Node::ALL
        .iter()
        .filter(|n| !matches!(n, Node::Doc | Node::Text))
    {
        let doc = document_to_yrs(&mb_core::parse(FULL)).expect("native full encoder");
        let element = {
            let tx = doc.transact();
            tx.get_xml_fragment(PROSEMIRROR_ROOT)
                .expect("root")
                .successors(&tx)
                .filter_map(|n| n.into_xml_element())
                .find(|e| e.tag().as_ref() == node.name())
                .expect("fixture covers every XML node")
        };
        element.insert_attribute(
            &mut doc.transact_mut(),
            "future_attribute",
            "unsupported payload",
        );
        let before = encode_update_v1(&doc);
        let result = document_from_yrs(&doc);
        assert!(
            result.is_err(),
            "{} discarded undeclared attribute",
            node.name()
        );
        assert!(result.unwrap_err().to_string().contains("future_attribute"));
        assert_eq!(
            encode_update_v1(&doc),
            before,
            "validation mutated candidate"
        );
    }
}
