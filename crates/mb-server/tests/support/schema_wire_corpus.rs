// Additional authenticated-wire corpus. Included in websocket.rs to reuse the real
// ephemeral server and strict frame readers; no credentials or raw secrets logged.
#[tokio::test]
async fn complete_raw_fields_scalars_and_code_style_pairs_refuse_without_echo_or_persistence() {
    use yrs::{Any, Text, Xml, XmlFragment};
    use std::collections::HashMap;
    let dir = TempDir::new("schema-raw-wire");
    let full = include_str!("../../../mb-crdt/fixtures/conformance/full.md");
    dir.write("One.md", full);
    dir.write("access.toml", "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n");
    let vault = Vault::open(Slug::parse("personal").unwrap(), "Personal", dir.path()).unwrap();
    let mut auth = mb_auth::AuthDb::open_in_memory().unwrap();
    let user = auth.setup_first_user(mb_auth::NewUser {username:"alice",display_name:"Alice",password:"correct horse battery staple"}).unwrap();
    let token=auth.create_session(user.id,4_102_444_800).unwrap();
    let cookie=auth.signed_session_cookie(&token).unwrap();
    let server=Server::start(AppState::authenticated(vec![vault],auth).unwrap()).await;
    let mut writer=server.connect(&cookie).await;
    let baseline=subscribe(&mut writer,"personal","One.md").await;
    let before=snapshot_files(dir.path());
    let mut observer=server.connect(&cookie).await;
    assert_eq!(subscribe(&mut observer,"personal","One.md").await,baseline);
    let empty=Any::Map(Arc::new(HashMap::new()));
    let mut cases: Vec<(String,Option<String>,yrs::types::Attrs)> = Vec::new();
    for node in mb_core::schema::Node::ALL.iter().filter(|node| !matches!(node, mb_core::schema::Node::Doc|mb_core::schema::Node::Text)) {
        cases.push((format!("unknown-{}",node.name()),Some(node.name().into()),yrs::types::Attrs::new()));
    }
    for mark in ["strong","em","strikethrough","highlight","code"] {
        for payload in [Any::Number(42.0),Any::Bool(true),Any::Bool(false),Any::from("yes"),Any::Array(Vec::new().into()),Any::Map(Arc::new(HashMap::from([("extra".into(),Any::Bool(true))])))] {
            cases.push((format!("scalar-{mark}-{payload:?}"),None,yrs::types::Attrs::from([(mark.into(),payload)])));
        }
    }
    for attrs in [
        HashMap::from([("href".into(),Any::from("https://example.test")),("future".into(),Any::Bool(true))]),
        HashMap::from([("href".into(),Any::Bool(true))]),
        HashMap::from([("href".into(),Any::from("https://example.test")),("title".into(),Any::Bool(true))]),
    ] { cases.push(("invalid-link-field".into(),None,yrs::types::Attrs::from([("link".into(),Any::Map(Arc::new(attrs)))]))); }
    for mark in ["mb_underline","mb_color","mb_background","mb_size"] {
        let value=if mark=="mb_underline" {empty.clone()} else {Any::Map(Arc::new(HashMap::from([("value".into(),Any::from(if mark=="mb_size" {"large"} else {"red"}))])))};
        cases.push((format!("code-pair-{mark}"),None,yrs::types::Attrs::from([("code".into(),empty.clone()),(mark.into(),value)])));
        cases.push((format!("scalar-{mark}"),None,yrs::types::Attrs::from([(mark.into(),Any::Bool(true))])));
    }
    for mark in ["unknown","code--LpaW+ak5","mb_color--forged"] {
        cases.push((mark.into(),None,yrs::types::Attrs::from([(mark.into(),empty.clone())])));
    }
    for (index,(name,node,attrs)) in cases.iter().enumerate() {
        let candidate=document_from_update_v1(&baseline).unwrap();
        let vector=candidate.transact().state_vector();
        if let Some(node)=node {
            let element={let tx=candidate.transact();tx.get_xml_fragment("prosemirror").unwrap().successors(&tx).filter_map(|item|item.into_xml_element()).find(|el|el.tag().as_ref()==node).unwrap()};
            element.insert_attribute(&mut candidate.transact_mut(),"future_attribute","unsupported");
        } else {
            let text={let tx=candidate.transact();tx.get_xml_fragment("prosemirror").unwrap().successors(&tx).find_map(|item|item.into_xml_text()).unwrap()};
            let len=text.len(&candidate.transact());
            text.format(&mut candidate.transact_mut(),0,len,attrs.clone());
        }
        let update=candidate.transact().encode_state_as_update_v1(&vector);
        // Exercise both wire envelopes, not only native/in-process decoder refusal.
        let message=if index%2==0 {update_frame("personal","One.md",&update)} else {Message::Text(serde_json::json!({"type":"update","vault":"personal","note":"One.md","update":update}).to_string().into())};
        writer.send(message).await.unwrap();
        let response=next_json(&mut writer).await;
        assert_eq!(response["code"],"invalid_update","{name}: {response}");
        assert_eq!(snapshot_files(dir.path()),before,"{name}: persisted hostile bytes");
        // Resubscribe is a deterministic publication barrier: an unwanted observer echo
        // would be the next frame and fail the strict ACK reader (no sleeps/no polling).
        assert_eq!(subscribe(&mut observer,"personal","One.md").await,baseline,"{name}: live/bootstrap changed");
        let mut later=server.connect(&cookie).await;
        assert_eq!(subscribe(&mut later,"personal","One.md").await,baseline,"{name}: poisoned later bootstrap");
        later.close(None).await.unwrap();
    }
    println!("AUTHENTICATED_RAW_WIRE_REFUSALS={}",cases.len());
}
