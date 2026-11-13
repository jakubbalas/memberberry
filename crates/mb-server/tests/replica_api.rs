//! What a desktop replica needs from a user's server (`SPEC.md` §7.6.9): note versions and
//! identities in the note list, a create that starts from the uploader's CRDT history, and a
//! rename that moves a file without rewriting any text.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

use std::sync::Arc;

use base64::Engine as _;
use mb_server::Vault;
use mb_server::http::{AppState, router};
use mb_server::vault::Slug;
use reqwest::StatusCode;
use reqwest::header::COOKIE;

const PASSWORD: &str = "correct horse battery staple";

struct Server {
    _dir: tempfile::TempDir,
    root: std::path::PathBuf,
    origin: String,
    alice: String,
    bob: String,
    _stop: tokio::sync::oneshot::Sender<()>,
}

/// A vault where alice owns everything and bob may only view, except `Shared/` he edits.
async fn server() -> Server {
    let dir = tempfile::tempdir().expect("dir");
    let root = dir.path().join("v");
    std::fs::create_dir_all(root.join("notes/Shared")).expect("notes");
    std::fs::write(
        root.join("access.toml"),
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n[[members]]\nuser = \"bob\"\nrole = \"viewer\"\n\
         [[rules]]\npath = \"Shared\"\ngrant = { bob = \"editor\" }\n",
    )
    .expect("policy");
    std::fs::write(
        root.join("notes/Plain.md"),
        "---\nid: 0190a1b2-0000-7000-8000-000000000001\n---\n# Plain\n\nSee [[Linked]].\n",
    )
    .expect("note");
    std::fs::write(root.join("notes/Linked.md"), "# Linked\n\nbody\n").expect("note");
    std::fs::write(root.join("notes/Shared/Doc.md"), "# Doc\n").expect("note");
    let vault = Vault::open(Slug::parse("v").expect("slug"), "V", &root).expect("vault");
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth");
    let alice = auth
        .setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: PASSWORD,
        })
        .expect("alice");
    let bob = auth
        .create_user(mb_auth::NewUser {
            username: "bob",
            display_name: "Bob",
            password: PASSWORD,
        })
        .expect("bob");
    let cookie = |auth: &mut mb_auth::AuthDb, id| {
        let token = auth.create_session(id, 4_102_444_800).expect("session");
        format!(
            "mb_session={}",
            auth.signed_session_cookie(&token).expect("cookie")
        )
    };
    let alice = cookie(&mut auth, alice.id);
    let bob = cookie(&mut auth, bob.id);
    let state = Arc::new(AppState::authenticated(vec![vault], auth).expect("state"));
    let errors = state.maintain_index(&mb_server::watch::Changes::All);
    assert!(errors.is_empty(), "{errors:?}");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let origin = format!("http://{}", listener.local_addr().expect("addr"));
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        axum::serve(
            listener,
            router(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .with_graceful_shutdown(async {
            drop(stopped.await);
        })
        .await
    });
    Server {
        _dir: dir,
        root,
        origin,
        alice,
        bob,
        _stop: stop,
    }
}

impl Server {
    async fn notes(&self, cookie: &str) -> Vec<serde_json::Value> {
        let text = reqwest::Client::new()
            .get(format!("{}/api/v1/vaults/v/notes", self.origin))
            .header(COOKIE, cookie)
            .send()
            .await
            .expect("notes")
            .text()
            .await
            .expect("body");
        let body: serde_json::Value = serde_json::from_str(&text).expect("json");
        body["notes"].as_array().expect("notes array").clone()
    }

    async fn note(&self, cookie: &str, path: &str) -> serde_json::Value {
        self.notes(cookie)
            .await
            .into_iter()
            .find(|note| note["path"] == path)
            .expect("the note is listed")
    }

    async fn post(&self, cookie: &str, route: &str, body: serde_json::Value) -> reqwest::Response {
        reqwest::Client::new()
            .post(format!("{}{route}", self.origin))
            .header(COOKIE, cookie)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body.to_string())
            .send()
            .await
            .expect("post")
    }
}

fn history_of(markdown: &str) -> Vec<u8> {
    let doc = mb_crdt::document_to_yrs(&mb_core::parse(markdown)).expect("doc");
    mb_crdt::encode_update_v1(&doc)
}

#[tokio::test]
async fn the_note_list_carries_each_notes_frontmatter_id() {
    let server = server().await;
    let note = server.note(&server.alice, "Plain.md").await;
    assert_eq!(note["id"], "0190a1b2-0000-7000-8000-000000000001");
}

#[tokio::test]
async fn a_note_without_an_id_lists_a_null_id() {
    let server = server().await;
    assert!(server.note(&server.alice, "Linked.md").await["id"].is_null());
}

#[tokio::test]
async fn a_notes_version_changes_when_its_file_changes() {
    let server = server().await;
    let before = server.note(&server.alice, "Linked.md").await["version"].clone();
    std::fs::write(
        server.root.join("notes/Linked.md"),
        "# Linked\n\nchanged text\n",
    )
    .expect("edit");
    let after = server.note(&server.alice, "Linked.md").await["version"].clone();
    assert!(before.is_string() && before != after, "{before} -> {after}");
}

#[tokio::test]
async fn the_note_list_says_which_notes_the_caller_may_edit() {
    let server = server().await;
    let plain = server.note(&server.bob, "Plain.md").await;
    let shared = server.note(&server.bob, "Shared/Doc.md").await;
    assert!(plain["editable"] == false && shared["editable"] == true);
}

#[tokio::test]
async fn a_note_created_from_a_history_is_that_history() {
    let server = server().await;
    let history = history_of("# Uploaded\n\nfrom the desktop\n");
    let created = server
        .post(
            &server.alice,
            "/api/v1/vaults/v/notes",
            serde_json::json!({
                "path": "Uploaded.md",
                "state": base64::engine::general_purpose::STANDARD.encode(&history),
            }),
        )
        .await;
    assert_eq!(created.status(), StatusCode::OK);
    let markdown = std::fs::read_to_string(server.root.join("notes/Uploaded.md")).expect("file");
    assert_eq!(markdown, "# Uploaded\n\nfrom the desktop\n");
}

#[tokio::test]
async fn merging_the_uploaders_history_into_a_created_note_duplicates_nothing() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::protocol::Message;

    let server = server().await;
    let history = history_of("# Uploaded\n\nonce\n");
    server
        .post(
            &server.alice,
            "/api/v1/vaults/v/notes",
            serde_json::json!({
                "path": "Uploaded.md",
                "state": base64::engine::general_purpose::STANDARD.encode(&history),
            }),
        )
        .await;
    // What the replica does next: subscribe and send its whole state. A server that had
    // built its own history from the Markdown would now hold every block twice.
    let mut request = format!("{}/api/v1/sync", server.origin.replace("http", "ws"))
        .into_client_request()
        .expect("request");
    request
        .headers_mut()
        .insert("Cookie", server.alice.parse().expect("cookie"));
    let (mut socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .expect("socket");
    let schema = mb_server::sync::current_schema_version().expect("schema");
    socket
        .send(Message::Text(
            serde_json::json!({"type":"subscribe","vault":"v","note":"Uploaded.md","schema_version":schema})
                .to_string()
                .into(),
        ))
        .await
        .expect("subscribe");
    drop(socket.next().await);
    drop(socket.next().await);
    let mut frame = vec![0x02];
    frame.extend_from_slice(&1u16.to_be_bytes());
    frame.extend_from_slice(&11u16.to_be_bytes());
    frame.extend_from_slice(b"vUploaded.md");
    frame.extend_from_slice(&history);
    socket
        .send(Message::Binary(frame.into()))
        .await
        .expect("update");
    drop(socket.next().await);
    socket.close(None).await.expect("close");
    let path = server.root.join("notes/Uploaded.md");
    let mut markdown = String::new();
    for _ in 0..50 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        markdown = std::fs::read_to_string(&path).unwrap_or_default();
        if markdown != "# Uploaded\n\nonce\n" {
            break;
        }
    }
    assert_eq!(markdown, "# Uploaded\n\nonce\n");
}

#[tokio::test]
async fn creating_from_a_history_needs_write_access_there() {
    let server = server().await;
    let created = server
        .post(
            &server.bob,
            "/api/v1/vaults/v/notes",
            serde_json::json!({
                "path": "Nope.md",
                "state": base64::engine::general_purpose::STANDARD.encode(history_of("# Nope\n")),
            }),
        )
        .await;
    assert!(
        created.status() == StatusCode::NOT_FOUND && !server.root.join("notes/Nope.md").exists()
    );
}

#[tokio::test]
async fn a_history_that_is_not_a_valid_note_is_refused() {
    let server = server().await;
    let created = server
        .post(
            &server.alice,
            "/api/v1/vaults/v/notes",
            serde_json::json!({ "path": "Bad.md", "state": "AQID" }),
        )
        .await;
    assert!(
        created.status() == StatusCode::BAD_REQUEST && !server.root.join("notes/Bad.md").exists()
    );
}

#[tokio::test]
async fn a_move_only_rename_leaves_every_linking_note_untouched() {
    let server = server().await;
    let renamed = server
        .post(
            &server.alice,
            "/api/v1/vaults/v/rename",
            serde_json::json!({ "kind": "note", "from": "Linked.md", "to": "Moved.md", "links": false }),
        )
        .await;
    assert_eq!(renamed.status(), StatusCode::OK);
    let linking = std::fs::read_to_string(server.root.join("notes/Plain.md")).expect("file");
    assert!(linking.contains("[[Linked]]"), "{linking}");
}

#[tokio::test]
async fn a_move_only_rename_moves_the_file_and_keeps_its_text() {
    let server = server().await;
    server
        .post(
            &server.alice,
            "/api/v1/vaults/v/rename",
            serde_json::json!({ "kind": "note", "from": "Linked.md", "to": "Moved.md", "links": false }),
        )
        .await;
    let moved = std::fs::read_to_string(server.root.join("notes/Moved.md")).expect("moved");
    assert!(moved == "# Linked\n\nbody\n" && !server.root.join("notes/Linked.md").exists());
}

#[tokio::test]
async fn a_move_only_rename_needs_write_access_at_both_ends() {
    let server = server().await;
    let renamed = server
        .post(
            &server.bob,
            "/api/v1/vaults/v/rename",
            serde_json::json!({ "kind": "note", "from": "Shared/Doc.md", "to": "Doc.md", "links": false }),
        )
        .await;
    assert!(
        renamed.status() == StatusCode::NOT_FOUND
            && server.root.join("notes/Shared/Doc.md").exists()
    );
}
