//! E2–E4 wire-level permission regression tests (`SPEC.md` §6.4).

#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::unwrap_used
)]

mod support;

use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use mb_crdt::{apply_external_markdown, document_from_update_v1, document_from_yrs};
use mb_server::Vault;
use mb_server::http::{AppState, router};
use mb_server::vault::Slug;
use support::TempDir;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::Message;
use yrs::updates::decoder::Decode;
use yrs::{ReadTxn, Transact};

struct Server {
    address: std::net::SocketAddr,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
}

impl Server {
    async fn start(state: AppState) -> Self {
        Self::start_shared(Arc::new(state)).await
    }

    /// Starts a server the test also holds a handle to, for driving state directly.
    async fn start_shared(state: Arc<AppState>) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let address = listener.local_addr().expect("address");
        let (shutdown, receive_shutdown) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let served = axum::serve(listener, router(state)).with_graceful_shutdown(async {
                drop(receive_shutdown.await);
            });
            drop(served.await);
        });
        Self {
            address,
            shutdown: Some(shutdown),
        }
    }

    async fn connect(
        &self,
        cookie: &str,
    ) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>
    {
        self.connect_with("Cookie", &format!("mb_session={cookie}"))
            .await
            .expect("websocket")
    }

    /// Connects with one arbitrary credential header, surfacing a rejected upgrade.
    async fn connect_with(
        &self,
        header: &'static str,
        value: &str,
    ) -> Result<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        tokio_tungstenite::tungstenite::Error,
    > {
        let mut request = format!("ws://{}/api/v1/sync", self.address)
            .into_client_request()
            .expect("request");
        request
            .headers_mut()
            .insert(header, value.parse().expect("header value"));
        tokio_tungstenite::connect_async(request)
            .await
            .map(|(socket, _)| socket)
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _sent = self.shutdown.take().map(|sender| sender.send(()));
    }
}

#[tokio::test]
async fn websocket_authorizes_subscription_frame_and_awareness_per_document() {
    let dir = TempDir::new("websocket-permissions");
    dir.write("One.md", "before\n");
    dir.write("access.toml", "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n\n[[members]]\nuser = \"bob\"\nrole = \"viewer\"\n");
    let vault = Vault::open(Slug::parse("personal").unwrap(), "Personal", dir.path()).unwrap();
    let mut auth = mb_auth::AuthDb::open_in_memory().unwrap();
    let alice = auth
        .setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: "correct horse battery staple",
        })
        .unwrap();
    let bob = auth
        .create_user(mb_auth::NewUser {
            username: "bob",
            display_name: "Bob",
            password: "correct horse battery staple",
        })
        .unwrap();
    let charlie = auth
        .create_user(mb_auth::NewUser {
            username: "charlie",
            display_name: "Charlie",
            password: "correct horse battery staple",
        })
        .unwrap();
    let cookie = |id| {
        let token = auth.create_session(id, 4_102_444_800).unwrap();
        auth.signed_session_cookie(&token).unwrap()
    };
    let alice_cookie = cookie(alice.id);
    let bob_cookie = cookie(bob.id);
    let charlie_cookie = cookie(charlie.id);
    let server = Server::start(AppState::authenticated(vec![vault], auth).unwrap()).await;
    let mut alice_socket = server.connect(&alice_cookie).await;
    let mut bob_socket = server.connect(&bob_cookie).await;
    let mut charlie_socket = server.connect(&charlie_cookie).await;

    let subscribe = r#"{"type":"subscribe","vault":"personal","note":"One.md"}"#;
    alice_socket
        .send(Message::Text(subscribe.into()))
        .await
        .unwrap();
    bob_socket
        .send(Message::Text(subscribe.into()))
        .await
        .unwrap();
    charlie_socket
        .send(Message::Text(subscribe.into()))
        .await
        .unwrap();
    let (tag, _, _, baseline) = next_binary(&mut alice_socket).await;
    assert_eq!(tag, 0x01);
    assert_eq!(next_binary(&mut bob_socket).await.0, 0x01);
    assert_eq!(next_json(&mut charlie_socket).await["code"], "not_found");

    bob_socket
        .send(update_frame("personal", "One.md", &[0]))
        .await
        .unwrap();
    assert_eq!(next_json(&mut bob_socket).await["code"], "read_only");

    let edited = document_from_update_v1(&baseline).expect("server state");
    let vector = edited.transact().state_vector();
    apply_external_markdown(&edited, "after\n").expect("local edit");
    let update = edited.transact().encode_state_as_update_v1(&vector);
    alice_socket
        .send(update_frame("personal", "One.md", &update))
        .await
        .unwrap();
    let (tag, _, _, bytes) = next_binary(&mut bob_socket).await;
    assert_eq!(tag, 0x02);
    edited
        .transact_mut()
        .apply_update(yrs::Update::decode_v1(&bytes).expect("update"))
        .expect("apply");
    assert_eq!(
        mb_core::to_markdown(&document_from_yrs(&edited).expect("document")),
        "after\n"
    );
    assert_eq!(next_binary(&mut alice_socket).await.0, 0x02);

    bob_socket.send(Message::Text(r#"{"type":"awareness","vault":"personal","note":"One.md","state":{"name":"spoofed","cursor":4}}"#.into())).await.unwrap();
    let awareness = next_json(&mut alice_socket).await;
    assert_eq!(awareness["type"], "awareness");
    assert_eq!(awareness["user"], "bob");
    assert_eq!(awareness["state"]["name"], "spoofed");
}

#[tokio::test]
async fn sync_frames_never_reveal_whether_an_unreadable_note_exists() {
    // §3.2: a note a user cannot read does not exist for them. An earlier revision replied
    // `not_found` for an existing-but-unreadable note and nothing at all for a path that
    // did not resolve, which let a non-member enumerate the vault by timing out.
    let dir = TempDir::new("websocket-invisibility");
    dir.write("Secret.md", "top secret\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n",
    );
    let vault = Vault::open(Slug::parse("personal").unwrap(), "Personal", dir.path()).unwrap();
    let mut auth = mb_auth::AuthDb::open_in_memory().unwrap();
    auth.setup_first_user(mb_auth::NewUser {
        username: "alice",
        display_name: "Alice",
        password: "correct horse battery staple",
    })
    .unwrap();
    let mallory = auth
        .create_user(mb_auth::NewUser {
            username: "mallory",
            display_name: "Mallory",
            password: "correct horse battery staple",
        })
        .unwrap();
    let token = auth.create_session(mallory.id, 4_102_444_800).unwrap();
    let cookie = auth.signed_session_cookie(&token).unwrap();
    let server = Server::start(AppState::authenticated(vec![vault], auth).unwrap()).await;
    let mut socket = server.connect(&cookie).await;

    let mut replies = Vec::new();
    for note in ["Secret.md", "AbsentFromTheVault.md"] {
        for frame in ["subscribe", "unsubscribe", "awareness"] {
            socket
                .send(Message::Text(
                    serde_json::json!({
                        "type": frame,
                        "vault": "personal",
                        "note": note,
                        "state": {},
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .unwrap();
            replies.push(next_json(&mut socket).await);
        }
        socket
            .send(update_frame("personal", note, &[]))
            .await
            .unwrap();
        replies.push(next_json(&mut socket).await);
    }

    assert_eq!(
        replies,
        vec![serde_json::json!({ "type": "error", "code": "not_found" }); 8],
        "an existing unreadable note and an absent one must be indistinguishable"
    );
}

#[tokio::test]
async fn two_names_for_one_file_share_a_single_writer() {
    // `NoteCoordinator` is a serialized writer and only safe as one instance per file. An
    // earlier revision keyed rooms on the raw client string, so a symlink — or, on a
    // case-insensitive filesystem, a different capitalization — opened a second
    // coordinator over the same `.md`. The two never converged and clobbered each other's
    // atomic writes.
    let dir = TempDir::new("websocket-aliasing");
    dir.write("One.md", "before\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n",
    );
    std::os::unix::fs::symlink(dir.path().join("One.md"), dir.path().join("Alias.md"))
        .expect("symlink");
    let vault = Vault::open(Slug::parse("personal").unwrap(), "Personal", dir.path()).unwrap();
    let mut auth = mb_auth::AuthDb::open_in_memory().unwrap();
    let alice = auth
        .setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: "correct horse battery staple",
        })
        .unwrap();
    let token = auth.create_session(alice.id, 4_102_444_800).unwrap();
    let cookie = auth.signed_session_cookie(&token).unwrap();
    let server = Server::start(AppState::authenticated(vec![vault], auth).unwrap()).await;
    let mut canonical = server.connect(&cookie).await;
    let mut aliased = server.connect(&cookie).await;

    let baseline = subscribe(&mut canonical, "personal", "One.md").await;
    let aliased_sync = subscribe(&mut aliased, "personal", "Alias.md").await;
    assert_eq!(
        baseline, aliased_sync,
        "both names must be admitted to the same document state"
    );

    let update = external_edit(&baseline, "after\n");
    canonical
        .send(update_frame("personal", "One.md", &update))
        .await
        .unwrap();

    let (tag, _, note, _) =
        tokio::time::timeout(std::time::Duration::from_secs(2), next_binary(&mut aliased))
            .await
            .expect("the aliased subscriber shares the room and must receive the edit");
    assert_eq!(tag, 0x02);
    assert_eq!(
        note, "Alias.md",
        "each peer is addressed by the name it subscribed with"
    );
}

async fn subscribe(socket: &mut Socket, vault: &str, note: &str) -> Vec<u8> {
    socket
        .send(Message::Text(
            serde_json::json!({"type":"subscribe","vault":vault,"note":note})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let (tag, _, _, state) = next_binary(socket).await;
    assert_eq!(tag, 0x01, "subscribing answers with a full-state frame");
    state
}

/// Produces the lib0 update an editor would send after rewriting the note's Markdown.
fn external_edit(baseline: &[u8], markdown: &str) -> Vec<u8> {
    let document = document_from_update_v1(baseline).expect("baseline state");
    let vector = document.transact().state_vector();
    apply_external_markdown(&document, markdown).expect("edit");
    document.transact().encode_state_as_update_v1(&vector)
}

#[tokio::test]
async fn the_same_note_path_in_two_vaults_is_two_documents() {
    // A room key must be unique per file across the whole server. A vault-relative path is
    // not: every vault has a `One.md`, and sharing one room across them would cross-serve
    // content between vaults with entirely separate ACLs.
    let first = TempDir::new("websocket-vault-a");
    first.write("One.md", "content of the first vault\n");
    first.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n",
    );
    let second = TempDir::new("websocket-vault-b");
    second.write("One.md", "content of the second vault\n");
    second.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n",
    );
    let vaults = vec![
        Vault::open(Slug::parse("first").unwrap(), "First", first.path()).unwrap(),
        Vault::open(Slug::parse("second").unwrap(), "Second", second.path()).unwrap(),
    ];
    let mut auth = mb_auth::AuthDb::open_in_memory().unwrap();
    let alice = auth
        .setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: "correct horse battery staple",
        })
        .unwrap();
    let token = auth.create_session(alice.id, 4_102_444_800).unwrap();
    let cookie = auth.signed_session_cookie(&token).unwrap();
    let server = Server::start(AppState::authenticated(vaults, auth).unwrap()).await;
    let mut socket = server.connect(&cookie).await;

    let mut markdown = Vec::new();
    for slug in ["first", "second"] {
        socket
            .send(Message::Text(
                serde_json::json!({"type":"subscribe","vault":slug,"note":"One.md"})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let (tag, served, _, bytes) = next_binary(&mut socket).await;
        assert_eq!(tag, 0x01);
        assert_eq!(served, slug, "each frame names the vault it came from");
        let document = document_from_yrs(&document_from_update_v1(&bytes).unwrap()).unwrap();
        markdown.push(mb_core::to_markdown(&document));
    }

    assert_eq!(
        markdown,
        vec![
            "content of the first vault\n".to_string(),
            "content of the second vault\n".to_string(),
        ]
    );
}

#[tokio::test]
async fn closing_a_socket_retracts_its_presence_from_the_room() {
    let dir = TempDir::new("websocket-departure");
    dir.write("One.md", "before\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n",
    );
    let vault = Vault::open(Slug::parse("personal").unwrap(), "Personal", dir.path()).unwrap();
    let mut auth = mb_auth::AuthDb::open_in_memory().unwrap();
    let alice = auth
        .setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: "correct horse battery staple",
        })
        .unwrap();
    let token = auth.create_session(alice.id, 4_102_444_800).unwrap();
    let cookie = auth.signed_session_cookie(&token).unwrap();
    let server = Server::start(AppState::authenticated(vec![vault], auth).unwrap()).await;
    let mut watcher = server.connect(&cookie).await;
    let mut leaver = server.connect(&cookie).await;
    drop(subscribe(&mut watcher, "personal", "One.md").await);
    drop(subscribe(&mut leaver, "personal", "One.md").await);

    leaver
        .send(Message::Text(
            serde_json::json!({
                "type": "awareness",
                "vault": "personal",
                "note": "One.md",
                "clients": [99],
                "state": { "cursor": 3 },
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    assert_eq!(next_json(&mut watcher).await["type"], "awareness");

    leaver.close(None).await.unwrap();
    drop(leaver);

    let departed = tokio::time::timeout(std::time::Duration::from_secs(2), next_json(&mut watcher))
        .await
        .expect("a closed socket retracts its cursor immediately, not after 30s");
    assert_eq!(departed["type"], "departed");
    assert_eq!(departed["clients"], serde_json::json!([99]));
}

#[tokio::test]
async fn revoking_access_on_disk_takes_effect_without_a_restart() {
    // AGENTS.md §3.1's per-frame authorization only means something if the policy can move
    // under an open connection. An earlier revision read `access.toml` once at startup, so
    // a revocation — including one `invites.rs` writes itself — waited for a restart.
    let dir = TempDir::new("websocket-revocation");
    dir.write("One.md", "before\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n\n[[members]]\nuser = \"bob\"\nrole = \"editor\"\n",
    );
    let vault = Vault::open(Slug::parse("personal").unwrap(), "Personal", dir.path()).unwrap();
    let mut auth = mb_auth::AuthDb::open_in_memory().unwrap();
    auth.setup_first_user(mb_auth::NewUser {
        username: "alice",
        display_name: "Alice",
        password: "correct horse battery staple",
    })
    .unwrap();
    let bob = auth
        .create_user(mb_auth::NewUser {
            username: "bob",
            display_name: "Bob",
            password: "correct horse battery staple",
        })
        .unwrap();
    let token = auth.create_session(bob.id, 4_102_444_800).unwrap();
    let cookie = auth.signed_session_cookie(&token).unwrap();
    let state = Arc::new(AppState::authenticated(vec![vault], auth).unwrap());
    let server = Server::start_shared(Arc::clone(&state)).await;
    let mut socket = server.connect(&cookie).await;
    drop(subscribe(&mut socket, "personal", "One.md").await);

    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n",
    );
    assert!(state.reload_access().is_empty());

    socket
        .send(Message::Text(
            r#"{"type":"subscribe","vault":"personal","note":"One.md"}"#.into(),
        ))
        .await
        .unwrap();
    assert_eq!(
        next_json(&mut socket).await["code"],
        "not_found",
        "a revoked reader is denied on the next frame, not at the next restart"
    );
}

#[tokio::test]
async fn a_malformed_access_file_denies_everyone_rather_than_keeping_the_old_policy() {
    let dir = TempDir::new("websocket-malformed-acl");
    dir.write("One.md", "before\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n",
    );
    let vault = Vault::open(Slug::parse("personal").unwrap(), "Personal", dir.path()).unwrap();
    let mut auth = mb_auth::AuthDb::open_in_memory().unwrap();
    let alice = auth
        .setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: "correct horse battery staple",
        })
        .unwrap();
    let token = auth.create_session(alice.id, 4_102_444_800).unwrap();
    let cookie = auth.signed_session_cookie(&token).unwrap();
    let state = Arc::new(AppState::authenticated(vec![vault], auth).unwrap());
    let server = Server::start_shared(Arc::clone(&state)).await;
    let mut socket = server.connect(&cookie).await;
    drop(subscribe(&mut socket, "personal", "One.md").await);

    dir.write("access.toml", "this is not valid toml [[[");
    assert!(
        !state.reload_access().is_empty(),
        "a malformed reload is reported, not swallowed"
    );

    socket
        .send(Message::Text(
            r#"{"type":"subscribe","vault":"personal","note":"One.md"}"#.into(),
        ))
        .await
        .unwrap();
    assert_eq!(
        next_json(&mut socket).await["code"],
        "not_found",
        "malformed input denies everything rather than keeping the last good policy"
    );
}

#[tokio::test]
async fn an_api_token_syncs_only_its_own_vault_and_dies_with_its_revocation() {
    let first = TempDir::new("websocket-token-a");
    first.write("One.md", "in the scoped vault\n");
    first.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"editor\"\n",
    );
    let second = TempDir::new("websocket-token-b");
    second.write("One.md", "in the other vault\n");
    second.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"editor\"\n",
    );
    let vaults = vec![
        Vault::open(Slug::parse("scoped").unwrap(), "Scoped", first.path()).unwrap(),
        Vault::open(Slug::parse("other").unwrap(), "Other", second.path()).unwrap(),
    ];
    let mut auth = mb_auth::AuthDb::open_in_memory().unwrap();
    let alice = auth
        .setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: "correct horse battery staple",
        })
        .unwrap();
    let token = auth
        .create_api_token(mb_auth::ApiTokenScope {
            user_id: alice.id,
            vault_slug: "scoped".to_string(),
            role: mb_core::Role::Editor,
        })
        .unwrap();
    let bearer = format!("Bearer {}", token.expose_secret());
    let state = Arc::new(AppState::authenticated(vaults, auth).unwrap());
    let server = Server::start_shared(Arc::clone(&state)).await;
    let mut socket = server
        .connect_with("Authorization", &bearer)
        .await
        .expect("a lexically valid token may open a socket");

    // In scope: the token syncs its own vault.
    drop(subscribe(&mut socket, "scoped", "One.md").await);

    // Out of scope: the same note path in a vault the token is not scoped to is refused,
    // and refused *neutrally* — nothing distinguishes it from a note that does not exist.
    socket
        .send(Message::Text(
            r#"{"type":"subscribe","vault":"other","note":"One.md"}"#.into(),
        ))
        .await
        .unwrap();
    assert_eq!(next_json(&mut socket).await["code"], "not_found");
    socket
        .send(Message::Text(
            r#"{"type":"subscribe","vault":"other","note":"Absent.md"}"#.into(),
        ))
        .await
        .unwrap();
    assert_eq!(next_json(&mut socket).await["code"], "not_found");

    // Revoked mid-connection: the very next frame is denied, without a reconnect.
    state.revoke_api_token_for_test(&token);
    socket
        .send(Message::Text(
            r#"{"type":"subscribe","vault":"scoped","note":"One.md"}"#.into(),
        ))
        .await
        .unwrap();
    assert_eq!(
        next_json(&mut socket).await["code"],
        "not_found",
        "an API token is re-authenticated per frame, so revocation lands immediately"
    );
}

#[tokio::test]
async fn a_socket_with_no_usable_credential_is_refused_at_the_upgrade() {
    let dir = TempDir::new("websocket-no-credential");
    dir.write("One.md", "before\n");
    let vault = Vault::open(Slug::parse("personal").unwrap(), "Personal", dir.path()).unwrap();
    let mut auth = mb_auth::AuthDb::open_in_memory().unwrap();
    auth.setup_first_user(mb_auth::NewUser {
        username: "alice",
        display_name: "Alice",
        password: "correct horse battery staple",
    })
    .unwrap();
    let server = Server::start(AppState::authenticated(vec![vault], auth).unwrap()).await;

    assert!(
        server
            .connect_with("Authorization", "Bearer not-a-real-token")
            .await
            .is_err()
    );
    assert!(
        server
            .connect_with("Cookie", "mb_session=forged")
            .await
            .is_err()
    );
}

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Reads the next control frame. CRDT payloads travel as binary; see [`next_binary`].
async fn next_json(socket: &mut Socket) -> serde_json::Value {
    match socket.next().await {
        Some(Ok(Message::Text(message))) => {
            serde_json::from_str(&message).expect("a control frame is JSON")
        }
        other => panic!("expected a text control frame, got {other:?}"),
    }
}

/// Reads the next CRDT frame as `(tag, vault, note, payload)`.
///
/// The header is decoded here by hand rather than through the server's own encoder, so a
/// change to the wire format has to be made deliberately on both sides.
async fn next_binary(socket: &mut Socket) -> (u8, String, String, Vec<u8>) {
    let Some(Ok(Message::Binary(bytes))) = socket.next().await else {
        panic!("expected a binary CRDT frame");
    };
    let vault_len = usize::from(u16::from_be_bytes([bytes[1], bytes[2]]));
    let note_len = usize::from(u16::from_be_bytes([bytes[3], bytes[4]]));
    let vault_end = 5 + vault_len;
    let note_end = vault_end + note_len;
    (
        bytes[0],
        String::from_utf8(bytes[5..vault_end].to_vec()).expect("vault slug"),
        String::from_utf8(bytes[vault_end..note_end].to_vec()).expect("note path"),
        bytes[note_end..].to_vec(),
    )
}

/// Builds the binary update frame a client sends.
fn update_frame(vault: &str, note: &str, update: &[u8]) -> Message {
    let mut bytes = vec![0x02];
    bytes.extend_from_slice(
        &u16::try_from(vault.len())
            .expect("slug length")
            .to_be_bytes(),
    );
    bytes.extend_from_slice(
        &u16::try_from(note.len())
            .expect("note length")
            .to_be_bytes(),
    );
    bytes.extend_from_slice(vault.as_bytes());
    bytes.extend_from_slice(note.as_bytes());
    bytes.extend_from_slice(update);
    Message::Binary(bytes.into())
}
