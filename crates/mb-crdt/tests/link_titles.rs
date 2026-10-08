//! Explicit authored link-title presence survives native Markdown reopen.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]
use mb_crdt::{document_from_yrs, document_to_yrs, encode_update_v1};
use std::collections::HashMap;
use std::sync::Arc;
use yrs::{Any, Doc, Text, Transact, WriteTxn, XmlElementPrelim, XmlFragment, XmlTextPrelim};

#[test]
fn explicit_empty_title_native_code_markdown_reopen() {
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
        HashMap::from([
            ("code".into(), Any::Map(Arc::new(HashMap::new()))),
            (
                "link".into(),
                Any::Map(Arc::new(HashMap::from([
                    ("href".into(), Any::from("https://example.org")),
                    ("title".into(), Any::from("")),
                ]))),
            ),
        ]),
    );
    drop(txn);
    let model = document_from_yrs(&doc).expect("accepted authored native shape");
    let markdown = mb_core::to_markdown(&model);
    let reopened = mb_core::parse(&markdown);
    let reopened_native = document_to_yrs(&reopened).expect("valid reopen");
    if let Some(dir) = std::env::var_os("MB_TITLE_EVIDENCE") {
        let dir = std::path::PathBuf::from(dir);
        assert!(dir.is_absolute() && dir.is_dir());
        std::fs::write(dir.join("native-original.json"), serde_json::to_vec_pretty(&serde_json::json!({
            "markdown": markdown, "reopenedMarkdown": mb_core::to_markdown(&reopened),
            "expectedModel": format!("{model:?}"), "actualModel": format!("{reopened:?}"),
            "updateHex": encode_update_v1(&doc).iter().map(|b|format!("{b:02x}")).collect::<String>(),
            "reopenedUpdateHex": encode_update_v1(&reopened_native).iter().map(|b|format!("{b:02x}")).collect::<String>(),
        })).unwrap()).unwrap();
    }
    assert_eq!(
        reopened, model,
        "explicit empty title must not become absent"
    );
}

#[test]
fn native_title_states_and_reference_reopen_have_exact_semantics() {
    let mut receipts = Vec::new();
    for code in [false, true] {
        for (state, title) in [
            ("absent", None),
            ("null", Some(Any::Null)),
            ("empty", Some(Any::from(""))),
            ("nonempty", Some(Any::from("Authored title 🦀"))),
            (
                "escaped",
                Some(Any::from("Authored \"title\" \\ & ' () 🦀")),
            ),
        ] {
            let literal = "a `b` *c* [d](e) ==f== <g> 🦀";
            let expected_title = match &title {
                Some(Any::String(value)) => Some(value.to_string()),
                _ => None,
            };
            let expected = mb_core::model::Document::new(vec![mb_core::model::Block::new(
                mb_core::model::BlockKind::Paragraph(vec![mb_core::model::Inline::Link {
                    dest: "https://example.org/a?x=()&q=\"\"".into(),
                    title: expected_title.clone(),
                    content: vec![if code {
                        mb_core::model::Inline::Code(literal.into())
                    } else {
                        mb_core::model::Inline::Text(literal.into())
                    }],
                }]),
            )]);
            let doc = Doc::new();
            let mut txn = doc.transact_mut();
            let root = txn.get_or_insert_xml_fragment("prosemirror");
            txn.get_or_insert_map("frontmatter");
            let p = root.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
            let text = p.push_back(&mut txn, XmlTextPrelim::new(""));
            let mut link = HashMap::from([(
                "href".into(),
                Any::from("https://example.org/a?x=()&q=\"\""),
            )]);
            if let Some(title) = title {
                link.insert("title".into(), title);
            }
            let mut attrs = HashMap::from([("link".into(), Any::Map(Arc::new(link)))]);
            if code {
                attrs.insert("code".into(), Any::Map(Arc::new(HashMap::new())));
            }
            text.insert_with_attributes(&mut txn, 0, literal, attrs);
            drop(txn);
            let before = encode_update_v1(&doc);
            assert_eq!(
                document_from_yrs(&doc).unwrap(),
                expected,
                "{state} code={code}"
            );
            let binary = mb_crdt::document_from_update_v1(&before).unwrap();
            assert_eq!(document_from_yrs(&binary).unwrap(), expected);
            assert_eq!(encode_update_v1(&doc), before, "read-only native decode");
            let markdown = mb_core::to_markdown(&expected);
            assert_eq!(mb_core::parse(&markdown), expected);
            let reopened = document_to_yrs(&mb_core::parse(&markdown)).unwrap();
            assert_eq!(document_from_yrs(&reopened).unwrap(), expected);
            let label = mb_core::to_markdown(&mb_core::model::Document::new(vec![
                mb_core::model::Block::new(mb_core::model::BlockKind::Paragraph(
                    match &expected.blocks[0].kind {
                        mb_core::model::BlockKind::Paragraph(c) => match &c[0] {
                            mb_core::model::Inline::Link { content, .. } => content.clone(),
                            _ => unreachable!(),
                        },
                        _ => unreachable!(),
                    },
                )),
            ]));
            // Destination/title spelling comes from the real serializer, not a second codec.
            let metadata = markdown
                .strip_prefix(&format!("[{}](", label.trim_end()))
                .unwrap()
                .trim_end()
                .strip_suffix(')')
                .unwrap();
            let reference = format!("[{}][ID]\n\n[id]: {metadata}\n", label.trim_end());
            assert_eq!(
                mb_core::parse(&reference),
                expected,
                "reference {state} code={code}"
            );
            receipts.push(
                serde_json::json!({"id":format!("{state}-code-{code}"),"state":state,"code":code,
                "title":expected_title,"markdown":markdown,"reference":reference,"literal":literal,
                "updateHex":before.iter().map(|b|format!("{b:02x}")).collect::<String>()}),
            );
        }
    }
    if let Some(dir) = std::env::var_os("MB_TITLE_EVIDENCE") {
        let dir = std::path::PathBuf::from(dir);
        assert!(dir.is_absolute() && dir.is_dir());
        std::fs::write(
            dir.join("native-titles.json"),
            serde_json::to_vec_pretty(&receipts).unwrap(),
        )
        .unwrap();
    }
}
