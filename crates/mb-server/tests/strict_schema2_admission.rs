//! Focused real-wire raw admission and complete refusal receipts.
// why: integration tests, not library code (AGENTS.md 4.2) — a panic is the failure report.
#![allow(
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::panic
)]
mod support;
use futures_util::{SinkExt, StreamExt};
use mb_crdt::{PROSEMIRROR_ROOT, document_from_update_v1};
use mb_server::{
    Vault,
    http::{AppState, router},
    vault::Slug,
};
use std::{collections::BTreeMap, path::Path, sync::Arc};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, protocol::Message};
use yrs::{Any, ReadTxn, Text, Transact, Xml, XmlFragment};

/// A refusal case: its label, an undeclared node name to send, or a native mark and payload.
type WireCase<'a> = (String, Option<&'a str>, Option<(&'a str, Any)>);

fn snapshot(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(root: &Path, p: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for entry in std::fs::read_dir(p).unwrap() {
            let p = entry.unwrap().path();
            if p.is_dir() {
                walk(root, &p, out);
            } else {
                out.insert(
                    p.strip_prefix(root).unwrap().to_string_lossy().into_owned(),
                    std::fs::read(p).unwrap(),
                );
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}
fn payload(b: &[u8]) -> Vec<u8> {
    let vault = usize::from(u16::from_be_bytes([b[1], b[2]]));
    let note = usize::from(u16::from_be_bytes([b[3], b[4]]));
    b[5 + vault + note..].to_vec()
}
fn frame(update: &[u8]) -> Message {
    let vault = "personal";
    let note = "One.md";
    let mut b = vec![2];
    b.extend_from_slice(&(vault.len() as u16).to_be_bytes());
    b.extend_from_slice(&(note.len() as u16).to_be_bytes());
    b.extend_from_slice(vault.as_bytes());
    b.extend_from_slice(note.as_bytes());
    b.extend_from_slice(update);
    Message::Binary(b.into())
}

fn assert_admission_ack(ack: &Message, schema_version: u64) {
    let Message::Text(text) = ack else {
        panic!("admission ACK must be text")
    };
    let ack: serde_json::Value = serde_json::from_str(text).unwrap();
    assert_eq!(ack["type"], "admitted");
    assert_eq!(ack["vault"], "personal");
    assert_eq!(ack["note"], "One.md");
    assert_eq!(ack["schema_version"], schema_version);
}

#[tokio::test]
async fn raw_refusals_preserve_full_bootstrap_sidecar_disk_membership_and_peer_delivery() {
    let source = mb_core::normalize(include_str!("../../mb-crdt/fixtures/conformance/full.md"));
    let dir = support::TempDir::new("strict-schema2-wire");
    dir.write("One.md", &source);
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n",
    );
    let vault = Vault::open(Slug::parse("personal").unwrap(), "Private", dir.path()).unwrap();
    let mut auth = mb_auth::AuthDb::open_in_memory().unwrap();
    let user = auth
        .setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: "private fixture only",
        })
        .unwrap();
    let token = auth.create_session(user.id, 4_102_444_800).unwrap();
    let cookie = auth.signed_session_cookie(&token).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let state = Arc::new(AppState::authenticated(vec![vault], auth).unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, router(state))
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap()
    });
    let request = || {
        let mut r = format!("ws://{address}/api/v1/sync")
            .into_client_request()
            .unwrap();
        r.headers_mut()
            .insert("Cookie", format!("mb_session={cookie}").parse().unwrap());
        r
    };
    let (mut writer, _) = tokio_tungstenite::connect_async(request()).await.unwrap();
    let (mut peer, _) = tokio_tungstenite::connect_async(request()).await.unwrap();
    let schema_version = mb_server::sync::current_schema_version().unwrap();
    let sub=serde_json::json!({"type":"subscribe","vault":"personal","note":"One.md","schema_version":schema_version}).to_string();
    let timeout = std::time::Duration::from_secs(3);
    writer
        .send(Message::Text(sub.clone().into()))
        .await
        .unwrap();
    let ack = tokio::time::timeout(timeout, writer.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(matches!(ack, Message::Text(_)));
    assert_admission_ack(&ack, schema_version);
    let Message::Binary(initial) = tokio::time::timeout(timeout, writer.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
    else {
        panic!("bootstrap")
    };
    let baseline = payload(&initial);
    peer.send(Message::Text(sub.clone().into())).await.unwrap();
    let ack = tokio::time::timeout(timeout, peer.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(matches!(ack, Message::Text(_)));
    assert_admission_ack(&ack, schema_version);
    let Message::Binary(peer_initial) = tokio::time::timeout(timeout, peer.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
    else {
        panic!("peer bootstrap")
    };
    assert_eq!(payload(&peer_initial), baseline);
    let before = snapshot(dir.path());
    let mut observations = Vec::new();
    let nodes = mb_core::schema::Node::ALL
        .iter()
        .filter(|n| !matches!(n, mb_core::schema::Node::Doc | mb_core::schema::Node::Text))
        .map(|n| n.name());
    let mut cases: Vec<WireCase<'_>> = nodes
        .map(|name| (format!("node-{name}"), Some(name), None))
        .collect();
    for name in ["strong", "em", "strikethrough", "highlight", "code"] {
        cases.push((
            format!("scalar-{name}"),
            None,
            Some((name, Any::Number(42.0))),
        ));
        cases.push((
            format!("extra-{name}"),
            None,
            Some((
                name,
                Any::Map(Arc::new(std::collections::HashMap::from([(
                    "future_attribute".into(),
                    Any::from("not declared"),
                )]))),
            )),
        ));
    }
    cases.push((
        "extra-link".into(),
        None,
        Some((
            "link",
            Any::Map(Arc::new(std::collections::HashMap::from([
                ("href".into(), Any::from("https://example.test")),
                ("future_attribute".into(), Any::from("not declared")),
            ]))),
        )),
    ));
    cases.push((
        "bad-link-title".into(),
        None,
        Some((
            "link",
            Any::Map(Arc::new(std::collections::HashMap::from([
                ("href".into(), Any::from("https://example.test")),
                ("title".into(), Any::Number(42.0)),
            ]))),
        )),
    ));
    for (name, node, mark) in cases {
        let candidate = document_from_update_v1(&baseline).unwrap();
        let vector = candidate.transact().state_vector();
        {
            let mut tx = candidate.transact_mut();
            let root = tx.get_xml_fragment(PROSEMIRROR_ROOT).unwrap();
            if let Some(tag) = node {
                let element = root
                    .successors(&tx)
                    .filter_map(|n| n.into_xml_element())
                    .find(|e| e.tag().as_ref() == tag)
                    .unwrap();
                element.insert_attribute(&mut tx, "future_attribute", "unsupported payload");
            } else {
                let paragraph = root
                    .successors(&tx)
                    .filter_map(|n| n.into_xml_element())
                    .find(|e| e.tag().as_ref() == "paragraph")
                    .unwrap();
                let text = paragraph.get(&tx, 0).unwrap().into_xml_text().unwrap();
                let (key, value) = mark.unwrap();
                text.format(
                    &mut tx,
                    0,
                    1,
                    yrs::types::Attrs::from([(key.into(), value)]),
                );
            }
        }
        let update = candidate.transact().encode_state_as_update_v1(&vector);
        writer.send(frame(&update)).await.unwrap();
        let response = tokio::time::timeout(timeout, writer.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(
            matches!(&response,Message::Text(t) if serde_json::from_str::<serde_json::Value>(t).unwrap()["code"]=="invalid_update"),
            "{name}: {response:?}"
        );
        assert_eq!(
            snapshot(dir.path()),
            before,
            "{name}: durable bytes or membership changed"
        );
        writer
            .send(Message::Text(sub.clone().into()))
            .await
            .unwrap();
        let ack = tokio::time::timeout(timeout, writer.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(matches!(ack, Message::Text(_)));
        assert_admission_ack(&ack, schema_version);
        let Message::Binary(full) = tokio::time::timeout(timeout, writer.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
        else {
            panic!("writer resubscribe")
        };
        assert_eq!(payload(&full), baseline, "{name}: live snapshot changed");
        peer.send(Message::Text(sub.clone().into())).await.unwrap();
        let ack = tokio::time::timeout(timeout, peer.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(
            matches!(ack, Message::Text(_)),
            "{name}: unexpected peer echo"
        );
        assert_admission_ack(&ack, schema_version);
        let Message::Binary(full) = tokio::time::timeout(timeout, peer.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
        else {
            panic!("peer resubscribe")
        };
        assert_eq!(payload(&full), baseline);
        assert_eq!(snapshot(dir.path()), before);
        observations.push(serde_json::json!({"case":name,"rejected":true,"live_and_full_bootstrap_equal":true,"durable_bytes_and_membership_equal":true,"peer_ack_bootstrap_without_invalid_echo":true,"candidate_update":update}));
    }
    // A real admitted update is the ordered delivery barrier: a stray invalid peer echo
    // would appear instead of this exact valid frame. Leave persistence and binding real.
    let valid = document_from_update_v1(&baseline).unwrap();
    let vector = valid.transact().state_vector();
    {
        let mut tx = valid.transact_mut();
        let p = tx
            .get_xml_fragment(PROSEMIRROR_ROOT)
            .unwrap()
            .successors(&tx)
            .filter_map(|n| n.into_xml_element())
            .find(|e| e.tag().as_ref() == "paragraph")
            .unwrap();
        p.get(&tx, 0)
            .unwrap()
            .into_xml_text()
            .unwrap()
            .insert(&mut tx, 0, "admitted ");
    }
    let valid_update = valid.transact().encode_state_as_update_v1(&vector);
    writer.send(frame(&valid_update)).await.unwrap();
    for stream in [&mut writer, &mut peer] {
        let Message::Binary(echo) = tokio::time::timeout(timeout, stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
        else {
            panic!("admitted exact echo")
        };
        assert_eq!(echo[0], 2);
        assert_eq!(payload(&echo), valid_update);
    }
    writer.close(None).await.unwrap();
    peer.close(None).await.unwrap();
    drop(writer);
    drop(peer);
    let _ = stop.send(());
    tokio::time::timeout(timeout, task).await.unwrap().unwrap();
    assert!(tokio::net::TcpStream::connect(address).await.is_err());
}
