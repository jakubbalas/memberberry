// why: fixture failures are unrecoverable test setup errors and should stop at their source.
#![allow(clippy::expect_used, clippy::panic, clippy::unwrap_used)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{Map as JsonMap, Number, Value, json};
use yrs::{
    Any, ClientID, Doc, Map, Options, Out, ReadTxn, Text, Transact, Xml, XmlFragment, XmlOut,
};

use crate::encode::document_to_yrs_in;
use crate::{FRONTMATTER_ROOT, PROSEMIRROR_ROOT, document_from_update_v1, document_from_yrs};

const FIXTURE_CLIENT_ID: u64 = 4_242;
const MARKDOWN: &str = include_str!("../fixtures/conformance/full.md");
const DOCUMENT_JSON: &str = include_str!("../fixtures/conformance/full.json");
const UPDATE: &[u8] = include_bytes!("../fixtures/conformance/full.bin");

#[test]
fn conformance_fixture_is_complete_and_current() {
    let expected = mb_core::parse(MARKDOWN);
    let canonical_markdown = mb_core::to_markdown(&expected);
    let ydoc = deterministic_document(&expected);
    let document_json = fixture_json(&ydoc);
    let pretty_json = format!(
        "{}\n",
        serde_json::to_string_pretty(&document_json).expect("fixture JSON must serialize")
    );
    let update = crate::encode_update_v1(&ydoc);

    if std::env::var_os("UPDATE_CONFORMANCE_FIXTURES").is_some() {
        write_fixture("full.md", canonical_markdown.as_bytes());
        write_fixture("full.json", pretty_json.as_bytes());
        write_fixture("full.bin", &update);
        return;
    }

    assert_eq!(MARKDOWN, canonical_markdown, "fixture Markdown is stale");
    assert_eq!(DOCUMENT_JSON, pretty_json, "fixture JSON is stale");
    let restored = document_from_update_v1(UPDATE).expect("fixture update must decode");
    assert_eq!(fixture_json(&restored), document_json);
    assert_eq!(
        document_from_yrs(&restored).expect("fixture update must materialize"),
        expected
    );
    assert_schema_coverage(&document_json);
}

fn deterministic_document(document: &mb_core::model::Document) -> Doc {
    let options = Options::with_client_id(ClientID::new(FIXTURE_CLIENT_ID));
    document_to_yrs_in(document, Doc::with_options(options))
        .expect("fixture document must satisfy the schema")
}

fn fixture_json(doc: &Doc) -> Value {
    let txn = doc.transact();
    let fragment = txn
        .get_xml_fragment(PROSEMIRROR_ROOT)
        .expect("fixture has a ProseMirror root");
    let frontmatter = txn
        .get_map(FRONTMATTER_ROOT)
        .expect("fixture has a frontmatter root");
    json!({
        "version": 1,
        "prosemirror": {
            "type": "doc",
            "content": xml_children(&fragment, &txn),
        },
        "frontmatter": map_json(&frontmatter, &txn),
    })
}

fn xml_children<P: XmlFragment, T: ReadTxn>(parent: &P, txn: &T) -> Vec<Value> {
    parent
        .children(txn)
        .flat_map(|child| match child {
            XmlOut::Element(element) => vec![element_json(&element, txn)],
            XmlOut::Text(text) => text_json(&text, txn),
            XmlOut::Fragment(fragment) => xml_children(&fragment, txn),
        })
        .collect()
}

fn element_json<T: ReadTxn>(element: &yrs::XmlElementRef, txn: &T) -> Value {
    let mut object = JsonMap::new();
    object.insert("type".to_string(), Value::String(element.tag().to_string()));

    let attrs = element
        .attributes(txn)
        .map(|(key, value)| (key.to_string(), out_json(value)))
        .collect::<BTreeMap<_, _>>();
    if !attrs.is_empty() {
        object.insert(
            "attrs".to_string(),
            Value::Object(attrs.into_iter().collect()),
        );
    }
    let content = xml_children(element, txn);
    if !content.is_empty() {
        object.insert("content".to_string(), Value::Array(content));
    }
    Value::Object(object)
}

fn text_json<T: ReadTxn>(text: &yrs::XmlTextRef, txn: &T) -> Vec<Value> {
    text.diff(txn, |_| ())
        .into_iter()
        .filter_map(|chunk| {
            let Out::Any(Any::String(value)) = chunk.insert else {
                panic!("fixture text must contain strings");
            };
            if value.is_empty() {
                return None;
            }
            let mut object = JsonMap::new();
            object.insert("type".to_string(), Value::String("text".to_string()));
            object.insert("text".to_string(), Value::String(value.to_string()));
            let marks = marks_json(chunk.attributes.as_deref());
            if !marks.is_empty() {
                object.insert("marks".to_string(), Value::Array(marks));
            }
            Some(Value::Object(object))
        })
        .collect()
}

fn marks_json(attrs: Option<&yrs::types::Attrs>) -> Vec<Value> {
    let Some(attrs) = attrs else {
        return Vec::new();
    };
    attrs
        .iter()
        .map(|(name, value)| (name.to_string(), value))
        .collect::<BTreeMap<_, _>>()
        .into_iter()
        .map(|(name, value)| {
            let mut mark = JsonMap::new();
            mark.insert("type".to_string(), Value::String(name));
            if let Any::Map(attrs) = value
                && !attrs.is_empty()
            {
                mark.insert("attrs".to_string(), any_json(Any::Map(Arc::clone(attrs))));
            }
            Value::Object(mark)
        })
        .collect()
}

fn map_json<T: ReadTxn>(map: &yrs::MapRef, txn: &T) -> Value {
    Value::Object(
        map.iter(txn)
            .map(|(key, value)| (key.to_string(), out_json(value)))
            .collect::<BTreeMap<_, _>>()
            .into_iter()
            .collect(),
    )
}

fn out_json(value: Out) -> Value {
    match value {
        Out::Any(value) => any_json(value),
        _ => panic!("fixture attributes and frontmatter must contain JSON values"),
    }
}

fn any_json(value: Any) -> Value {
    match value {
        Any::Null | Any::Undefined => Value::Null,
        Any::Bool(value) => Value::Bool(value),
        Any::Number(value) => Number::from_f64(value).map_or(Value::Null, Value::Number),
        Any::BigInt(value) => Value::Number(Number::from(value)),
        Any::String(value) => Value::String(value.to_string()),
        Any::Buffer(value) => Value::Array(
            value
                .iter()
                .map(|byte| Value::Number(Number::from(*byte)))
                .collect(),
        ),
        Any::Array(values) => Value::Array(values.iter().cloned().map(any_json).collect()),
        Any::Map(values) => Value::Object(
            values
                .iter()
                .map(|(key, value)| (key.clone(), any_json(value.clone())))
                .collect::<BTreeMap<_, _>>()
                .into_iter()
                .collect(),
        ),
    }
}

fn assert_schema_coverage(document: &Value) {
    let mut nodes = BTreeSet::new();
    let mut marks = BTreeSet::new();
    collect_schema_names(
        document
            .get("prosemirror")
            .expect("fixture JSON has prosemirror"),
        &mut nodes,
        &mut marks,
    );
    let expected_nodes = mb_core::schema::Node::ALL
        .iter()
        .map(|node| node.name())
        .collect::<BTreeSet<_>>();
    let expected_marks = mb_core::schema::Mark::ALL
        .iter()
        .map(|mark| mark.name())
        .collect::<BTreeSet<_>>();
    assert_eq!(
        nodes, expected_nodes,
        "fixture does not cover every schema node"
    );
    assert_eq!(
        marks, expected_marks,
        "fixture does not cover every schema mark"
    );
}

fn collect_schema_names<'a>(
    node: &'a Value,
    nodes: &mut BTreeSet<&'a str>,
    marks: &mut BTreeSet<&'a str>,
) {
    if let Some(name) = node.get("type").and_then(Value::as_str) {
        nodes.insert(name);
    }
    if let Some(node_marks) = node.get("marks").and_then(Value::as_array) {
        for mark in node_marks {
            if let Some(name) = mark.get("type").and_then(Value::as_str) {
                marks.insert(name);
            }
        }
    }
    if let Some(content) = node.get("content").and_then(Value::as_array) {
        for child in content {
            collect_schema_names(child, nodes, marks);
        }
    }
}

fn write_fixture(name: &str, content: &[u8]) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures/conformance")
        .join(name);
    fs::write(&path, content)
        .unwrap_or_else(|error| panic!("failed to write {}: {error}", path.display()));
}
