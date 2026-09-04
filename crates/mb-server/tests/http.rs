//! The HTTP surface, driven over a real socket.
//!
//! Bound to an ephemeral port rather than 9010: AGENTS.md §5.1 reserves that range for a
//! developer's own server, and a test that steals it fails for whoever has one running.
//!
//! Requests are made with a hand-written client rather than a dependency. This crate is a
//! server; adding an HTTP client to test it would be a dependency carried forever for the
//! sake of four lines.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

mod support;

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::Arc;

use mb_server::Vault;
use mb_server::http::{AppState, router};
use mb_server::vault::Slug;
use support::TempDir;

/// A server on an ephemeral port.
///
/// The runtime lives entirely inside the spawned thread and nothing is joined on drop —
/// an earlier version joined the server thread in `Drop` and could wedge the whole test
/// binary if shutdown raced. Signalling and walking away costs one short-lived thread per
/// test and cannot hang.
struct TestServer {
    /// Kept so a test can drive a maintenance tick, which is how an edit made outside the
    /// application reaches the index without waiting on a timer.
    state: Arc<AppState>,
    addr: SocketAddr,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    default_headers: String,
}

impl TestServer {
    fn start(state: AppState) -> Self {
        // why: here rather than per test. `serve` builds the index before it serves its
        // first request (`http.rs`), so a test server that did not would answer every
        // index-backed route with an empty list — a test that cannot fail.
        let state = Arc::new(state);
        let errors = state.maintain_index(&mb_server::watch::Changes::All);
        assert!(
            errors.is_empty(),
            "building the test vault's index: {errors:?}"
        );
        let app = router(Arc::clone(&state));
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        let (addr_tx, addr_rx) = std::sync::mpsc::channel();

        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("building the server runtime");
            rt.block_on(async move {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                    .await
                    .expect("binding an ephemeral port");
                let addr = listener.local_addr().expect("local addr");
                addr_tx.send(addr).expect("reporting the address");
                let served = axum::serve(listener, app).with_graceful_shutdown(async {
                    drop(shutdown_rx.await);
                });
                drop(served.await);
            });
        });

        let addr = addr_rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("the server should bind within ten seconds");
        Self {
            state,
            addr,
            shutdown: Some(shutdown_tx),
            default_headers: String::new(),
        }
    }

    fn authenticated(vaults: Vec<Vault>) -> Self {
        let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth db");
        let alice = auth
            .setup_first_user(mb_auth::NewUser {
                username: "alice",
                display_name: "Alice",
                password: "correct horse battery staple",
            })
            .expect("setup");
        let token = auth
            .create_session(alice.id, 4_102_444_800)
            .expect("session");
        let cookie = auth.signed_session_cookie(&token).expect("sign cookie");
        let state = AppState::authenticated(vaults, auth).expect("secure state");
        let mut server = Self::start(state);
        server.default_headers = format!("Cookie: mb_session={cookie}\r\n");
        server
    }

    fn authenticated_with_web_root(vaults: Vec<Vault>, web_root: std::path::PathBuf) -> Self {
        let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth db");
        let alice = auth
            .setup_first_user(mb_auth::NewUser {
                username: "alice",
                display_name: "Alice",
                password: "correct horse battery staple",
            })
            .expect("setup");
        let token = auth
            .create_session(alice.id, 4_102_444_800)
            .expect("session");
        let cookie = auth.signed_session_cookie(&token).expect("sign cookie");
        let state =
            AppState::authenticated_with_web_root(vaults, auth, web_root).expect("secure state");
        let mut server = Self::start(state);
        server.default_headers = format!("Cookie: mb_session={cookie}\r\n");
        server
    }

    /// Runs one index maintenance tick, as the server's own timer does.
    fn tick(&self) {
        let errors = self.state.maintain_index(&mb_server::watch::Changes::All);
        assert!(errors.is_empty(), "index maintenance: {errors:?}");
    }

    /// Issues a GET and returns `(status line, body)`.
    fn get(&self, path: &str) -> (String, String) {
        self.get_with_headers(path, "")
    }

    /// Issues a GET and returns `(head, body bytes)`.
    ///
    /// why: every other helper here reads the response as a `String`, which a gzipped body
    /// is not. Anything asserting on what compression did needs the head and the raw bytes
    /// together — the head to see `Content-Encoding`, the bytes to prove they decode back to
    /// what was on disk.
    fn get_raw(&self, path: &str, headers: &str) -> (String, Vec<u8>) {
        let mut stream = TcpStream::connect(self.addr).expect("connecting");
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .expect("setting a read timeout");
        write!(
            stream,
            "GET {path} HTTP/1.1\r\nHost: localhost\r\n{}{headers}Connection: close\r\n\r\n",
            self.default_headers
        )
        .expect("writing the request");
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).expect("reading the response");
        let split = raw
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("a response with a header block");
        let head = String::from_utf8_lossy(&raw[..split]).to_ascii_lowercase();
        (head, raw[split + 4..].to_vec())
    }

    fn get_with_headers(&self, path: &str, headers: &str) -> (String, String) {
        self.request(
            "GET",
            path,
            &format!("{}{}", self.default_headers, headers),
            "",
        )
    }

    fn post_form(&self, path: &str, form: &str) -> (String, String) {
        self.request(
            "POST",
            path,
            &format!(
                "Content-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\n",
                form.len()
            ),
            form,
        )
    }

    /// Issues a PUT with a JSON body and the given extra headers.
    fn put_json(&self, path: &str, headers: &str, body: &str) -> (String, String) {
        self.request(
            "PUT",
            path,
            &format!(
                "{}{headers}Content-Type: application/json\r\nContent-Length: {}\r\n",
                self.default_headers,
                body.len()
            ),
            body,
        )
    }

    fn request(&self, method: &str, path: &str, headers: &str, body: &str) -> (String, String) {
        let mut stream = TcpStream::connect(self.addr).expect("connecting");
        // A read timeout means a server bug shows up as a failing test rather than a hang.
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .expect("setting a read timeout");
        write!(
            stream,
            "{method} {path} HTTP/1.1\r\nHost: localhost\r\n{headers}Connection: close\r\n\r\n{body}"
        )
        .expect("writing the request");
        let mut raw = String::new();
        stream
            .read_to_string(&mut raw)
            .expect("reading the response");
        let (head, body) = raw.split_once("\r\n\r\n").unwrap_or((raw.as_str(), ""));
        let status = head.lines().next().unwrap_or_default().to_string();
        (status, body.to_string())
    }

    fn status(&self, path: &str) -> String {
        self.get(path).0
    }

    /// The response headers, for the policies that travel as headers rather than markup.
    fn headers(&self, path: &str) -> String {
        self.headers_with(path, "")
    }

    /// The same, with extra request headers — for a caller who is not the default user.
    fn headers_with(&self, path: &str, extra: &str) -> String {
        let mut stream = TcpStream::connect(self.addr).expect("connecting");
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .expect("setting a read timeout");
        write!(
            stream,
            "GET {path} HTTP/1.1\r\nHost: localhost\r\n{}{extra}Connection: close\r\n\r\n",
            self.default_headers
        )
        .expect("writing the request");
        let mut raw = String::new();
        stream
            .read_to_string(&mut raw)
            .expect("reading the response");
        raw.split_once("\r\n\r\n")
            .map_or(raw.clone(), |(head, _)| head.to_string())
    }
}

#[test]
fn editor_route_injects_trusted_bootstrap_and_assets_stay_contained() {
    let vault_dir = TempDir::new("http-editor-vault");
    vault_dir.write("One.md", "# One\n");
    // The layout Vite actually produces: `index.html` beside an `assets/` directory, with
    // the HTML referencing `/assets/<file>`. An earlier revision resolved that URL against
    // the build root instead, so every real bundle 404'd and the editor loaded blank — and
    // the test missed it by asking for the doubled path the bug required.
    let web_dir = TempDir::new("http-editor-web");
    web_dir.write("index.html", "<body><div id=\"app\" data-vault=\"\" data-note=\"\" data-user=\"\"></div><script type=\"module\" src=\"/assets/index-abc123.js\"></script></body>");
    web_dir.write("assets/index-abc123.js", "console.log('editor')");
    web_dir.write("assets/mb_bg-abc123.wasm", "\0asm");
    web_dir.write("secret.txt", "not part of the bundle");
    let server = TestServer::authenticated_with_web_root(
        vec![vault(&vault_dir, "personal", "Personal")],
        web_dir.path().to_path_buf(),
    );

    let (status, body) = server.get("/v/personal/One.md");
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("data-vault=\"personal\""), "{body}");
    assert!(body.contains("data-note=\"One.md\""), "{body}");
    assert!(body.contains("data-user=\"alice\""), "{body}");
    assert!(
        !body.contains("# One"),
        "note content must stay in CRDT, not bootstrap HTML"
    );

    // Every URL the served HTML references must resolve, or the page loads blank.
    for reference in body
        .split("src=\"")
        .skip(1)
        .filter_map(|tail| tail.split('"').next())
    {
        let (asset_status, asset) = server.get(reference);
        assert!(is_ok(&asset_status), "{reference} -> {asset_status}");
        assert!(
            asset.contains("editor"),
            "{reference} served the wrong bytes"
        );
    }

    let (wasm_status, _) = server.get("/assets/mb_bg-abc123.wasm");
    assert!(is_ok(&wasm_status), "{wasm_status}");

    // Containment: nothing outside `assets/` is reachable, traversal included.
    assert!(is_not_found(&server.get("/assets/../secret.txt").0));
    assert!(is_not_found(&server.get("/assets/../index.html").0));
    assert!(is_not_found(&server.get("/assets/secret.txt").0));
}

#[test]
fn editor_bootstrap_escapes_a_note_name_that_could_close_its_attribute() {
    // A filename may legally contain a double quote. Unescaped, `data-note` closes early
    // and the remainder of the name becomes attacker-authored markup in the authenticated
    // origin — stored XSS writable by anyone who can put a file in the vault.
    let vault_dir = TempDir::new("http-editor-quote");
    vault_dir.write("a\" autofocus onfocus=\"alert(1).md", "# Pwn\n");
    let web_dir = TempDir::new("http-editor-quote-web");
    web_dir.write(
        "index.html",
        "<body><div id=\"app\" data-vault=\"\" data-note=\"\" data-user=\"\"></div></body>",
    );
    let server = TestServer::authenticated_with_web_root(
        vec![vault(&vault_dir, "personal", "Personal")],
        web_dir.path().to_path_buf(),
    );

    let (status, body) = server.get("/v/personal/a%22%20autofocus%20onfocus=%22alert(1).md");

    assert!(is_ok(&status), "{status}");
    assert!(
        body.contains("data-note=\"a&quot; autofocus onfocus=&quot;alert(1).md\""),
        "the note name must survive only as an escaped attribute value: {body}"
    );
    assert!(
        !body.contains("onfocus=\"alert(1)"),
        "an unescaped event handler escaped into the document: {body}"
    );
}

impl Drop for TestServer {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            // `Result<(), ()>` is Copy, so `drop` is a no-op — ignore it explicitly.
            let _sent = tx.send(());
        }
    }
}

fn vault(dir: &TempDir, slug: &str, name: &str) -> Vault {
    if !dir.path().join("access.toml").exists() {
        dir.write(
            "access.toml",
            "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n",
        );
    }
    Vault::open(Slug::parse(slug).expect("slug"), name, dir.path()).expect("open")
}

fn is_ok(status: &str) -> bool {
    status.contains("200")
}

fn is_not_found(status: &str) -> bool {
    status.contains("404")
}

// ---------------------------------------------------------------- index

#[test]
fn the_index_lists_registered_vaults() {
    let a = TempDir::new("http-a");
    let b = TempDir::new("http-b");
    let server = TestServer::authenticated(vec![
        vault(&a, "personal", "Personal"),
        vault(&b, "work", "Work Notes"),
    ]);

    let (status, body) = server.get("/");
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("href=\"/v/personal\""), "{body}");
    assert!(body.contains("Work Notes"), "{body}");
}

#[test]
fn an_empty_server_says_so_rather_than_showing_a_blank_page() {
    let server = TestServer::authenticated(vec![]);
    let (status, body) = server.get("/");
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("No vaults registered"), "{body}");
    assert!(
        body.contains("vault create"),
        "it should say how to fix it: {body}"
    );
}

// ---------------------------------------------------------------- vault index

#[test]
fn a_vault_lists_its_notes() {
    let dir = TempDir::new("http-list");
    dir.write("alpha.md", "# Alpha\n");
    dir.write("folder/beta.md", "# Beta\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, body) = server.get("/v/v");
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("2 notes"), "{body}");
    assert!(body.contains("href=\"/v/v/alpha.md\""), "{body}");
    assert!(body.contains("href=\"/v/v/folder/beta.md\""), "{body}");
}

#[test]
fn an_authenticated_viewer_does_not_receive_notes_denied_by_access_toml() {
    let dir = TempDir::new("http-acl");
    dir.write("Public.md", "# Public\n");
    dir.write("Private/Salary.md", "# Salary Review\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"viewer\"\n\n\
         [[rules]]\npath = \"Private\"\ngrant = { alice = \"none\" }\n",
    );
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth db");
    let alice = auth
        .setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: "correct horse battery staple",
        })
        .expect("setup");
    let token = auth
        .create_session(alice.id, 4_102_444_800)
        .expect("session");
    let header = format!(
        "Cookie: mb_session={}\r\n",
        auth.signed_session_cookie(&token).expect("sign cookie")
    );
    let state = AppState::authenticated(vec![vault(&dir, "v", "V")], auth).expect("secure state");
    let server = TestServer::start(state);

    let (status, body) = server.get_with_headers("/v/v", &header);
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("Public"), "{body}");
    assert!(!body.contains("Salary"), "{body}");
    let (status, body) = server.get_with_headers("/v/v/Private/Salary.md", &header);
    assert!(is_not_found(&status), "{status}");
    assert!(!body.contains("Salary"), "{body}");
}

#[test]
fn http_read_matrix_denies_anonymous_and_non_members_without_leaking_titles() {
    let dir = TempDir::new("http-read-matrix");
    dir.write("Public.md", "# Public\n");
    dir.write("Private/Salary.md", "# Salary Review\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n\n\
         [[members]]\nuser = \"bob\"\nrole = \"viewer\"\n\n\
         [[rules]]\npath = \"Private\"\ngrant = { bob = \"none\" }\n",
    );
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth db");
    let alice = auth
        .setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: "correct horse battery staple",
        })
        .expect("setup");
    let bob = auth
        .create_user(mb_auth::NewUser {
            username: "bob",
            display_name: "Bob",
            password: "correct horse battery staple",
        })
        .expect("viewer");
    let charlie = auth
        .create_user(mb_auth::NewUser {
            username: "charlie",
            display_name: "Charlie",
            password: "correct horse battery staple",
        })
        .expect("non-member");
    let alice_token = auth
        .create_session(alice.id, 4_102_444_800)
        .expect("session");
    let bob_token = auth.create_session(bob.id, 4_102_444_800).expect("session");
    let charlie_token = auth
        .create_session(charlie.id, 4_102_444_800)
        .expect("session");
    let alice_header = format!(
        "Cookie: mb_session={}\r\n",
        auth.signed_session_cookie(&alice_token)
            .expect("sign cookie")
    );
    let bob_header = format!(
        "Cookie: mb_session={}\r\n",
        auth.signed_session_cookie(&bob_token).expect("sign cookie")
    );
    let charlie_header = format!(
        "Cookie: mb_session={}\r\n",
        auth.signed_session_cookie(&charlie_token)
            .expect("sign cookie")
    );
    let state = AppState::authenticated(vec![vault(&dir, "v", "V")], auth).expect("secure state");
    let server = TestServer::start(state);

    let (status, body) = server.get("/");
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("Sign in"), "{body}");
    assert!(!body.contains("Salary"), "{body}");
    let (status, body) = server.get("/v/v/Private/Salary.md");
    assert!(is_not_found(&status), "{status}");
    assert!(!body.contains("Salary"), "{body}");

    let (status, body) = server.get_with_headers("/", &charlie_header);
    assert!(is_ok(&status), "{status}");
    assert!(!body.contains("href=\"/v/v\""), "{body}");
    let (status, body) = server.get_with_headers("/v/v/Private/Salary.md", &charlie_header);
    assert!(is_not_found(&status), "{status}");
    assert!(!body.contains("Salary"), "{body}");

    let (status, body) = server.get_with_headers("/v/v", &bob_header);
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("Public"), "{body}");
    assert!(!body.contains("Salary"), "{body}");
    let (status, body) = server.get_with_headers("/v/v/Private/Salary.md", &bob_header);
    assert!(is_not_found(&status), "{status}");
    assert!(!body.contains("Salary"), "{body}");

    let (status, body) = server.get_with_headers("/v/v/Private/Salary.md", &alice_header);
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("Salary Review"), "{body}");
}

#[test]
fn a_successful_login_is_recorded_in_the_audit_log() {
    let dir = TempDir::new("http-login-audit");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"viewer\"\n",
    );
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth db");
    auth.setup_first_user(mb_auth::NewUser {
        username: "alice",
        display_name: "Alice",
        password: "correct horse battery staple",
    })
    .expect("setup");
    let audit = mb_server::audit::AuditLog::new(dir.path(), 4_096).expect("audit log");
    let state = AppState::authenticated_with_audit(vec![vault(&dir, "v", "V")], auth, Some(audit))
        .expect("secure state");
    let server = TestServer::start(state);

    let (status, _) = server.post_form(
        "/login",
        "username=alice&password=correct+horse+battery+staple",
    );
    assert!(status.contains("303"), "{status}");
    let log = std::fs::read_to_string(dir.path().join("audit.log")).expect("read audit log");
    assert!(log.contains("\"action\":\"login\""), "{log}");
    assert!(log.contains("\"result\":\"success\""), "{log}");
}

#[test]
fn an_unsigned_session_token_cannot_authenticate_an_http_request() {
    let dir = TempDir::new("http-unsigned-session");
    dir.write("Note.md", "# Visible\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"viewer\"\n",
    );
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth db");
    let alice = auth
        .setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: "correct horse battery staple",
        })
        .expect("setup");
    let token = auth
        .create_session(alice.id, 4_102_444_800)
        .expect("session");
    let state = AppState::authenticated(vec![vault(&dir, "v", "V")], auth).expect("secure state");
    let server = TestServer::start(state);
    let unsigned = format!("Cookie: mb_session={}\r\n", token.expose_secret());

    let (status, body) = server.get_with_headers("/v/v/Note.md", &unsigned);
    assert!(is_not_found(&status), "{status}");
    assert!(!body.contains("Visible"), "{body}");
}

#[test]
fn scoped_api_token_is_limited_to_its_vault_and_current_acl() {
    let dir = TempDir::new("http-api-token");
    dir.write("Note.md", "# Visible\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"viewer\"\n",
    );
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth db");
    let alice = auth
        .setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: "correct horse battery staple",
        })
        .expect("setup");
    let token = auth
        .create_api_token(mb_auth::ApiTokenScope {
            user_id: alice.id,
            vault_slug: "v".to_string(),
            role: mb_core::Role::Viewer,
        })
        .expect("token");
    let state = AppState::authenticated(vec![vault(&dir, "v", "V")], auth).expect("secure state");
    let server = TestServer::start(state);
    let header = format!("Authorization: Bearer {}\r\n", token.expose_secret());

    assert!(is_ok(&server.get_with_headers("/v/v", &header).0));
    assert!(is_not_found(
        &server.get_with_headers("/v/other", &header).0
    ));
}

#[test]
fn a_vault_index_works_with_and_without_a_trailing_slash() {
    let dir = TempDir::new("http-slash");
    dir.write("a.md", "# A\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);
    assert!(is_ok(&server.status("/v/v")));
    assert!(is_ok(&server.status("/v/v/")));
}

#[test]
fn an_unknown_vault_is_not_found() {
    let server = TestServer::authenticated(vec![]);
    assert!(is_not_found(&server.status("/v/nope")));
}

#[test]
fn a_slug_that_is_not_even_a_valid_slug_is_not_found() {
    // It must be refused before it can be used as a key or a path, not after.
    let server = TestServer::authenticated(vec![]);
    for bad in ["/v/UPPER", "/v/with%20space", "/v/..", "/v/a.b"] {
        assert!(is_not_found(&server.status(bad)), "{bad}");
    }
}

// ---------------------------------------------------------------- notes

#[test]
fn a_note_renders_as_html() {
    let dir = TempDir::new("http-note");
    dir.write("note.md", "# Title\n\nSome **bold** text.\n\n- [x] done\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, body) = server.get("/v/v/note.md");
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("<h1>Title</h1>"), "{body}");
    assert!(body.contains("<strong>bold</strong>"), "{body}");
    assert!(
        body.contains("type=\"checkbox\" disabled checked"),
        "{body}"
    );
    assert!(
        body.contains("<title>Title · Memberberry</title>"),
        "{body}"
    );
}

#[test]
fn a_note_resolves_without_its_extension() {
    // That is the shape a wikilink produces, so the links on the page have to work.
    let dir = TempDir::new("http-ext");
    dir.write("note.md", "# Title\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);
    assert!(
        is_ok(&server.status("/v/v/note")),
        "extensionless link should resolve"
    );
}

#[test]
fn a_wikilink_points_at_a_url_that_resolves() {
    let dir = TempDir::new("http-wikilink");
    dir.write("source.md", "See [[target]].\n");
    dir.write("target.md", "# Target\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (_, body) = server.get("/v/v/source.md");
    assert!(body.contains("href=\"/v/v/target\""), "{body}");
    assert!(
        is_ok(&server.status("/v/v/target")),
        "the link must actually work"
    );
}

#[test]
fn a_missing_note_is_not_found() {
    let dir = TempDir::new("http-missing");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);
    assert!(is_not_found(&server.status("/v/v/nope.md")));
}

#[test]
fn an_unknown_route_is_not_found() {
    let server = TestServer::authenticated(vec![]);
    assert!(is_not_found(&server.status("/nonsense")));
    // The API surface is added milestone by milestone; anything not yet built is absent
    // rather than stubbed, because a route that answers is a route someone will use.
    assert!(is_not_found(&server.status("/api/v1/vaults/v/search")));
    assert!(is_not_found(&server.status("/api/v1/vaults/v/clip")));
}

#[test]
fn a_server_with_no_vaults_lists_none_rather_than_failing() {
    // `/api/v1/vaults` exists as of M7's vault switcher (§8.4). An empty server is a normal
    // state — first run, before anything is registered — not an error.
    let server = TestServer::authenticated(vec![]);
    let (status, body) = server.get("/api/v1/vaults");
    assert!(is_ok(&status), "{status}");
    assert_eq!(body, "[]", "{body}");
}

// ---------------------------------------------------------------- security

#[test]
fn a_traversal_request_cannot_read_outside_the_vault() {
    // The end-to-end version of the unit test in `vault.rs`: a real request over a real
    // socket, against a secret that exists and is readable.
    let outer = TempDir::new("http-outer");
    outer.write("secret.md", "# TOP SECRET\n");
    let dir = TempDir::new("http-inner");
    dir.write("ok.md", "# Fine\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    for attempt in [
        "/v/v/../secret.md",
        "/v/v/..%2Fsecret.md",
        "/v/v/%2e%2e/secret.md",
        "/v/v/folder/../../secret.md",
        "/v/v/../../etc/passwd",
        "/v/v//etc/passwd",
    ] {
        let (status, body) = server.get(attempt);
        assert!(
            !body.contains("TOP SECRET"),
            "{attempt} leaked the file: {status}"
        );
    }
}

#[test]
fn note_content_cannot_inject_script_into_the_page() {
    // Stored cross-site scripting is the failure mode that matters for a server rendering
    // someone's notes. `mb_core::html` escapes; this proves it survives the whole pipeline.
    let dir = TempDir::new("http-xss");
    dir.write(
        "evil.md",
        "# <script>alert('title')</script>\n\n<img src=x onerror=alert(1)>\n\n\
         [click](javascript:alert(2))\n",
    );
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (_, body) = server.get("/v/v/evil.md");
    // The payload text is *expected* on the page — as escaped text. What must not appear is
    // a real element, so these look for unescaped `<` openers rather than substrings.
    assert!(
        !body.contains("<script"),
        "a script element survived: {body}"
    );
    assert!(
        !body.contains("<img src=x"),
        "an img element survived: {body}"
    );
    assert!(
        !body.contains("href=\"javascript:"),
        "a js url survived: {body}"
    );

    // ...and it must still be readable, because escaping is not deleting.
    assert!(body.contains("&lt;script&gt;"), "{body}");
    assert!(
        body.contains("&lt;img src=x onerror=alert(1)&gt;"),
        "{body}"
    );
    assert!(body.contains("href=\"#blocked\""), "{body}");
}

#[test]
fn every_page_carries_a_content_security_policy() {
    // Defence in depth behind the escaping: if an escaping bug ever lands, this is what
    // stops it becoming script execution.
    let dir = TempDir::new("http-csp");
    dir.write("note.md", "# A\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    for path in ["/", "/v/v", "/v/v/note.md", "/nonsense"] {
        let (_, body) = server.get(path);
        assert!(
            body.contains("Content-Security-Policy") && body.contains("default-src 'none'"),
            "{path} has no CSP: {body}"
        );
        assert!(
            body.contains("form-action 'none'"),
            "a page rendering note content must not be able to submit anywhere: {path}"
        );
    }
}

#[test]
fn a_frontend_build_without_the_bootstrap_element_is_reported_rather_than_served() {
    // `str::replace` on an absent marker is a no-op, so a mismatched `web_root` would ship a
    // page whose bootstrap is empty — and the editor would run against a local-only replica
    // instead of syncing, silently, while looking like working software. An operator with a
    // stale bundle has to be told, not left to hear it from a user's lost edits.
    let vault_dir = TempDir::new("http-editor-stale-vault");
    vault_dir.write("One.md", "# One\n");
    let web_dir = TempDir::new("http-editor-stale-web");
    web_dir.write("index.html", "<body><div id=\"root\"></div></body>");
    let server = TestServer::authenticated_with_web_root(
        vec![vault(&vault_dir, "personal", "Personal")],
        web_dir.path().to_path_buf(),
    );

    let (status, body) = server.get("/v/personal/One.md");
    assert!(
        status.contains("500"),
        "expected a server error, got {status}"
    );
    assert!(
        !body.contains("data-vault"),
        "a page with an unfilled bootstrap must not be served at all: {body}"
    );
}

#[test]
fn the_editor_page_carries_a_policy_scoped_to_what_it_actually_does() {
    // Through M5 this page had no CSP at all — the one page in the application that runs
    // JavaScript, opens a WebSocket and renders untrusted note content. The read-only pages
    // were covered and this was not, because it is served from a file rather than rendered.
    let vault_dir = TempDir::new("http-editor-csp-vault");
    vault_dir.write("One.md", "# One\n");
    let web_dir = TempDir::new("http-editor-csp-web");
    web_dir.write(
        "index.html",
        "<body><div id=\"app\" data-vault=\"\" data-note=\"\" data-user=\"\"></div></body>",
    );
    web_dir.write("assets/index-abc123.js", "console.log('editor')");
    let server = TestServer::authenticated_with_web_root(
        vec![vault(&vault_dir, "personal", "Personal")],
        web_dir.path().to_path_buf(),
    );

    let headers = server.headers("/v/personal/One.md").to_lowercase();
    assert!(
        headers.contains("content-security-policy:"),
        "the editor page must carry a policy: {headers}"
    );
    // Each of these is load-bearing, and removing one is a silent outage rather than an
    // error: without `wasm-unsafe-eval` mb-wasm never instantiates, and without `connect-src`
    // the sync socket is refused. The E2E suite proves they are *sufficient*; this proves
    // they are still *present*, which a unit test can do and a browser run should not have to.
    for directive in [
        "default-src 'none'",
        "script-src 'self' 'wasm-unsafe-eval'",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
    ] {
        assert!(
            headers.contains(directive),
            "the editor policy is missing `{directive}`: {headers}"
        );
    }
}

#[test]
fn every_page_declares_the_design_token_contract_it_styles_itself_with() {
    // SPEC.md §20.1: these pages reference contract tokens and nothing else, and they carry
    // no external assets on purpose (§17.2, and so they still render when JavaScript fails).
    // Those two facts only coexist if the contract is inlined — a page that references
    // `--surface-canvas` without declaring it renders as unstyled black-on-white, which is
    // exactly the failure mode a 200 from `curl` cannot see (AGENTS.md §2.3).
    let dir = TempDir::new("http-tokens");
    dir.write("note.md", "# A\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    for path in ["/", "/v/v", "/v/v/note.md", "/nonsense"] {
        let (_, body) = server.get(path);
        for token in [
            "--surface-canvas",
            "--text-primary",
            "--font-body",
            "--space-6",
        ] {
            assert!(
                body.contains(&format!("{token}:")),
                "{path} styles itself with {token} but never declares it: {body}"
            );
        }
    }
}

#[test]
fn every_page_that_has_a_form_is_allowed_to_submit_it() {
    // A CSP that forbids what the page itself does is not defence, it is an outage. An
    // earlier revision stamped `form-action 'none'` on every page including sign-in, so the
    // login form was blocked by the browser and nobody could authenticate at all. The
    // previous CSP test asserted the header was *present*, which this failure satisfied.
    let dir = TempDir::new("http-form-csp");
    dir.write("note.md", "# A\n");
    let server = TestServer::start(
        AppState::authenticated(
            vec![vault(&dir, "v", "V")],
            mb_auth::AuthDb::open_in_memory().expect("auth db"),
        )
        .expect("state"),
    );

    // Unauthenticated, so this is the sign-in page.
    let (status, body) = server.get("/");

    assert!(is_ok(&status), "{status}");
    assert!(body.contains("<form"), "expected the sign-in form: {body}");
    assert!(
        body.contains("form-action 'self'"),
        "the sign-in page must permit its own form: {body}"
    );
    assert!(
        !body.contains("form-action 'none'"),
        "a page carrying a form must not also forbid submitting it: {body}"
    );
}

#[test]
fn a_refused_sign_in_offers_the_form_again_and_keeps_the_username() {
    // The refusal page used to be a dead end: "Invalid username or password." and nothing to
    // submit, so the only route back was editing the address bar. It renders the form again,
    // and it must carry the sign-in CSP rather than the note pages' `form-action 'none'` —
    // otherwise the retry is blocked by the browser and looks like a broken password.
    let dir = TempDir::new("http-login-retry");
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth db");
    auth.setup_first_user(mb_auth::NewUser {
        username: "alice",
        display_name: "Alice",
        password: "correct horse battery staple",
    })
    .expect("setup");
    let state = AppState::authenticated(vec![vault(&dir, "v", "V")], auth).expect("state");
    let server = TestServer::start(state);

    let (status, body) = server.post_form("/login", "username=alice&password=wrong");

    assert!(status.contains("401"), "{status}");
    assert!(
        body.contains("Invalid username or password."),
        "expected the refusal: {body}"
    );
    assert!(body.contains("<form"), "expected the form again: {body}");
    assert!(
        body.contains("form-action 'self'"),
        "the retry must be submittable: {body}"
    );
    assert!(
        body.contains("value=\"alice\""),
        "the username should survive a wrong password: {body}"
    );
    // The password never does. Reflecting it would put the secret in the page source, in
    // the browser's cache and in any proxy log between the two.
    assert!(
        !body.contains("wrong"),
        "the password was reflected: {body}"
    );
}

#[test]
fn a_username_from_a_refused_sign_in_cannot_inject_markup() {
    // The refusal page is the one place a server-rendered page reflects unauthenticated
    // input, so it is the one place an escaping slip becomes stored-free XSS.
    let dir = TempDir::new("http-login-escape");
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth db");
    auth.setup_first_user(mb_auth::NewUser {
        username: "alice",
        display_name: "Alice",
        password: "correct horse battery staple",
    })
    .expect("setup");
    let state = AppState::authenticated(vec![vault(&dir, "v", "V")], auth).expect("state");
    let server = TestServer::start(state);

    // `"><script>alert(1)</script>` percent-encoded as a form field.
    let (status, body) = server.post_form(
        "/login",
        "username=%22%3E%3Cscript%3Ealert%281%29%3C%2Fscript%3E&password=wrong",
    );

    assert!(status.contains("401"), "{status}");
    assert!(!body.contains("<script>"), "markup escaped out: {body}");
    assert!(
        body.contains("&lt;script&gt;") || body.contains("&#60;script"),
        "expected the username escaped into the value attribute: {body}"
    );
}

#[test]
fn every_sign_in_field_is_labelled_and_styled_as_a_stacked_field() {
    // The user reported the form as "no padding between fields and labels". The fix is CSS,
    // so this asserts the two halves a browser needs for it: each input is associated with
    // its label by id, and the page ships the rule that stacks and spaces them. Whether the
    // gap is actually painted is not something a string can say — `signin.spec.ts` measures
    // it in a real browser (AGENTS.md §2.3).
    let dir = TempDir::new("http-login-fields");
    let state = AppState::authenticated(
        vec![vault(&dir, "v", "V")],
        mb_auth::AuthDb::open_in_memory().expect("auth db"),
    )
    .expect("state");
    let server = TestServer::start(state);

    let (status, body) = server.get("/");

    assert!(is_ok(&status), "{status}");
    for field in ["username", "password"] {
        assert!(
            body.contains(&format!("for=\"mb-{field}\"")),
            "{field} has no label association: {body}"
        );
        assert!(
            body.contains(&format!("id=\"mb-{field}\"")),
            "{field} has no id to associate with: {body}"
        );
    }
    assert!(
        body.contains(".mb-field{display:flex;flex-direction:column;gap:"),
        "the page carries no rule spacing a label from its input: {body}"
    );
}

#[test]
fn a_filesystem_error_does_not_leak_a_path_to_the_page() {
    // An I/O error names a path, and a path describes the shape of someone's private vault.
    let dir = TempDir::new("http-error");
    let vault = vault(&dir, "v", "V");
    drop(std::fs::remove_dir_all(dir.path()));
    let server = TestServer::authenticated(vec![vault]);

    let (status, body) = server.get("/v/v");
    assert!(status.contains("500") || status.contains("200"), "{status}");
    assert!(
        !body.contains("mb-server-http-error"),
        "path leaked: {body}"
    );
    assert!(!body.contains("/tmp/"), "path leaked: {body}");
}

// ---------------------------------------------------------------- rendering detail

#[test]
fn a_note_without_a_heading_is_titled_by_its_path() {
    let dir = TempDir::new("http-untitled");
    dir.write("untitled.md", "***\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);
    let (_, body) = server.get("/v/v/untitled.md");
    assert!(body.contains("untitled.md"), "{body}");
}

#[test]
fn a_note_name_with_spaces_is_linked_and_served() {
    let dir = TempDir::new("http-spaces");
    dir.write("My Note.md", "# My Note\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (_, index) = server.get("/v/v");
    assert!(index.contains("My%20Note.md"), "{index}");
    assert!(is_ok(&server.status("/v/v/My%20Note.md")));
}

#[test]
fn a_note_page_links_back_to_its_vault() {
    let dir = TempDir::new("http-crumb");
    dir.write("a.md", "# A\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "Vault Name")]);
    let (_, body) = server.get("/v/v/a.md");
    assert!(body.contains("href=\"/v/v\""), "{body}");
    assert!(body.contains("Vault Name"), "{body}");
}

#[test]
fn a_wikilink_into_a_folder_resolves_by_name() {
    // Found against a real vault: `[[Daily]]` rendered as `/v/x/Daily` and 404'd, because
    // the note lives at `todos/Daily.md`. Every wikilink in a foldered vault was dead.
    let dir = TempDir::new("http-by-name");
    dir.write("index.md", "See [[Daily]] and [[Nested Note]].\n");
    dir.write("todos/Daily.md", "# Daily\n");
    dir.write("a/b/Nested Note.md", "# Nested\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (_, body) = server.get("/v/v/index.md");
    assert!(body.contains("href=\"/v/v/Daily\""), "{body}");

    let (status, note) = server.get("/v/v/Daily");
    assert!(is_ok(&status), "the wikilink must resolve: {status}");
    assert!(note.contains("<h1>Daily</h1>"), "{note}");
    assert!(
        is_ok(&server.status("/v/v/Nested%20Note")),
        "spaces in a name"
    );
}

#[test]
fn a_dotted_path_is_not_served_over_http() {
    // The end-to-end form of the leak found against a real vault: `.git/config` can hold a
    // remote URL with credentials, and it was being served on request.
    let dir = TempDir::new("http-dotfiles");
    dir.write(
        ".git/config",
        "[core]\n\turl = https://user:SECRET@example.com\n",
    );
    dir.write(".obsidian/graph.json", "{}\n");
    dir.write("visible.md", "# Visible\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    for hidden in ["/v/v/.git/config", "/v/v/.obsidian/graph.json"] {
        let (status, body) = server.get(hidden);
        assert!(is_not_found(&status), "{hidden} was served: {status}");
        assert!(!body.contains("SECRET"), "{hidden} leaked: {body}");
    }
    assert!(is_ok(&server.status("/v/v/visible.md")));
}

#[test]
fn a_non_markdown_file_is_not_served_as_a_note() {
    let dir = TempDir::new("http-ext-guard");
    dir.write("data.json", "{\"secret\": true}\n");
    dir.write("note.md", "# A\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);
    assert!(is_not_found(&server.status("/v/v/data.json")));
}

/// The layout for a note pane, in the shape `workspace-storage.ts` writes.
const LAYOUT: &str = r#"{"format":1,"vault":"v","focusedGroup":"g","root":{"kind":"group","id":"g","tabs":[],"activeTab":null}}"#;

#[test]
fn the_workspace_route_stores_a_layout_per_user_and_denies_everyone_else_identically() {
    // E15. A layout is one user's list of open notes, so the route has to answer four
    // questions the same way — no such vault, not a member, not a device id, nothing saved —
    // or a prober learns which vaults exist and who belongs to them (§6.5).
    let dir = TempDir::new("http-workspace");
    dir.write("Public.md", "# Public\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n\n\
         [[members]]\nuser = \"bob\"\nrole = \"viewer\"\n",
    );
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth db");
    let alice = auth
        .setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: "correct horse battery staple",
        })
        .expect("setup");
    let bob = auth
        .create_user(mb_auth::NewUser {
            username: "bob",
            display_name: "Bob",
            password: "correct horse battery staple",
        })
        .expect("member");
    let charlie = auth
        .create_user(mb_auth::NewUser {
            username: "charlie",
            display_name: "Charlie",
            password: "correct horse battery staple",
        })
        .expect("non-member");
    let header = |id| {
        let token = auth.create_session(id, 4_102_444_800).expect("session");
        format!(
            "Cookie: mb_session={}\r\n",
            auth.signed_session_cookie(&token).expect("sign cookie")
        )
    };
    let alice_header = header(alice.id);
    let bob_header = header(bob.id);
    let charlie_header = header(charlie.id);
    let state = AppState::authenticated(vec![vault(&dir, "v", "V")], auth).expect("secure state");
    let server = TestServer::start(state);

    let route = "/api/v1/vaults/v/workspace/laptop";

    // Nothing saved yet. `204`, not `404`: this is the normal first visit, and answering it
    // with an error makes every fresh page load log one.
    let (status, _) = server.get_with_headers(route, &alice_header);
    assert!(status.contains("204"), "{status}");

    // Alice saves and reads back exactly what she stored.
    let (status, _) = server.put_json(route, &alice_header, LAYOUT);
    assert!(status.contains("204"), "{status}");
    let (status, body) = server.get_with_headers(route, &alice_header);
    assert!(is_ok(&status), "{status}");
    assert_eq!(body, LAYOUT);

    // Bob is a member of the same vault on the same device id, and sees nothing of hers.
    let (status, body) = server.get_with_headers(route, &bob_header);
    assert!(status.contains("204"), "{status}");
    assert!(!body.contains("focusedGroup"), "{body}");

    // Charlie is not a member: the vault must not appear to exist.
    let (status, _) = server.get_with_headers(route, &charlie_header);
    assert!(is_not_found(&status), "{status}");
    let (status, _) = server.put_json(route, &charlie_header, LAYOUT);
    assert!(is_not_found(&status), "{status}");

    // Anonymous, an unregistered vault, and a device id that is really a path all get the
    // same answer as "you have nothing saved".
    let (anonymous, _) = server.request("GET", route, "", "");
    assert!(is_not_found(&anonymous), "{anonymous}");
    let (unknown_vault, _) =
        server.get_with_headers("/api/v1/vaults/nope/workspace/laptop", &alice_header);
    assert!(is_not_found(&unknown_vault), "{unknown_vault}");
    let (traversal, _) = server.get_with_headers(
        "/api/v1/vaults/v/workspace/..%2F..%2Fetc%2Fpasswd",
        &alice_header,
    );
    assert!(is_not_found(&traversal), "{traversal}");

    // Charlie's refused write left nothing behind for anyone.
    let (status, body) = server.get_with_headers(route, &alice_header);
    assert!(is_ok(&status), "{status}");
    assert_eq!(
        body, LAYOUT,
        "a denied write must not disturb a stored layout"
    );
}

#[test]
fn a_workspace_layout_is_never_cached() {
    // A layout names the notes someone has open. An intermediary keeping a copy of it is the
    // same disclosure the per-user path exists to prevent.
    let dir = TempDir::new("http-workspace-cache");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n",
    );
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);
    let route = "/api/v1/vaults/v/workspace/laptop";

    let (status, _) = server.put_json(route, "", LAYOUT);
    assert!(status.contains("204"), "{status}");

    let headers = server.headers(route).to_lowercase();
    assert!(
        headers.contains("cache-control: no-store"),
        "a layout must not be cached: {headers}"
    );
}

#[test]
fn a_workspace_layout_that_is_not_json_is_refused() {
    let dir = TempDir::new("http-workspace-bad");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n",
    );
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);
    let route = "/api/v1/vaults/v/workspace/laptop";

    let (status, _) = server.put_json(route, "", "{ not json");
    assert!(is_not_found(&status), "{status}");
    // And nothing was stored, so the next load still reports nothing saved.
    let (status, _) = server.get_with_headers(route, "");
    assert!(status.contains("204"), "{status}");
}

#[test]
fn the_note_index_lists_only_readable_notes_with_their_titles() {
    // E1/E5. The quick switcher ranks client-side (§21.2), so the whole readable list travels
    // — which makes this the largest single disclosure surface in the application, and the
    // one where a missing filter is least likely to be noticed by looking at the screen.
    let dir = TempDir::new("http-note-index");
    dir.write("Public.md", "# The Public One\n\nBody.\n");
    dir.write("Untitled.md", "");
    dir.write("Private/Salary.md", "# Salary Review\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n\n\
         [[members]]\nuser = \"bob\"\nrole = \"viewer\"\n\n\
         [[rules]]\npath = \"Private\"\ngrant = { bob = \"none\" }\n",
    );
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth db");
    let alice = auth
        .setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: "correct horse battery staple",
        })
        .expect("setup");
    let bob = auth
        .create_user(mb_auth::NewUser {
            username: "bob",
            display_name: "Bob",
            password: "correct horse battery staple",
        })
        .expect("viewer");
    let charlie = auth
        .create_user(mb_auth::NewUser {
            username: "charlie",
            display_name: "Charlie",
            password: "correct horse battery staple",
        })
        .expect("non-member");
    let header = |id| {
        let token = auth.create_session(id, 4_102_444_800).expect("session");
        format!(
            "Cookie: mb_session={}\r\n",
            auth.signed_session_cookie(&token).expect("sign cookie")
        )
    };
    let alice_header = header(alice.id);
    let bob_header = header(bob.id);
    let charlie_header = header(charlie.id);
    let state = AppState::authenticated(vec![vault(&dir, "v", "V")], auth).expect("secure state");
    let server = TestServer::start(state);
    let route = "/api/v1/vaults/v/notes";

    // The owner sees everything, with titles taken from the note rather than the filename.
    let (status, body) = server.get_with_headers(route, &alice_header);
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("The Public One"), "{body}");
    assert!(body.contains("Salary Review"), "{body}");
    // A note with nothing titleable is listed with a null title, not omitted.
    assert!(body.contains("Untitled.md"), "{body}");

    // The viewer denied `Private` sees neither the path nor the title.
    let (status, body) = server.get_with_headers(route, &bob_header);
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("Public.md"), "{body}");
    assert!(
        !body.contains("Salary"),
        "a denied note must not be named: {body}"
    );
    assert!(!body.contains("Private"), "nor its folder: {body}");

    // A non-member gets the same answer as an unknown vault — not an empty list, which would
    // confirm the vault exists (§6.5).
    let (status, body) = server.get_with_headers(route, &charlie_header);
    assert!(is_not_found(&status), "{status}");
    assert!(!body.contains("Public"), "{body}");
    let (status, _) = server.get_with_headers("/api/v1/vaults/nope/notes", &alice_header);
    assert!(is_not_found(&status), "{status}");

    // Anonymous likewise.
    let (status, body) = server.request("GET", route, "", "");
    assert!(is_not_found(&status), "{status}");
    assert!(!body.contains("Public"), "{body}");
}

#[test]
fn the_note_index_is_never_cached() {
    // It is a list of note titles — the thing §6.5 exists to protect. An intermediary holding
    // a copy would outlive the session that was allowed to see it.
    let dir = TempDir::new("http-note-index-cache");
    dir.write("One.md", "# One\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n",
    );
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let headers = server.headers("/api/v1/vaults/v/notes").to_lowercase();
    assert!(
        headers.contains("cache-control: no-store"),
        "the note index must not be cached: {headers}"
    );
}

#[test]
fn the_note_index_reflects_a_note_edited_underneath_it() {
    // The title cache exists so 10 000 notes are not re-parsed per keystroke (§21.2). A cache
    // that serves a stale title is worse than no cache: the switcher shows a name the note no
    // longer has, and no amount of retyping fixes it.
    let dir = TempDir::new("http-note-index-stale");
    dir.write("One.md", "# Before\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n",
    );
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);
    let route = "/api/v1/vaults/v/notes";

    let (_, body) = server.get(route);
    assert!(body.contains("Before"), "{body}");

    // Rewritten with a different length, so the fingerprint changes even where the filesystem
    // has coarse modification times.
    dir.write("One.md", "# After the edit\n");
    let (_, body) = server.get(route);
    assert!(
        body.contains("After the edit"),
        "the cache must notice: {body}"
    );
    assert!(!body.contains("Before"), "{body}");
}

#[test]
fn the_vault_list_shows_only_vaults_the_caller_can_open() {
    // E1. The vault switcher would otherwise be a way to enumerate every vault on a server —
    // names included — from any authenticated account.
    let mine = TempDir::new("http-vaults-mine");
    mine.write("One.md", "# One\n");
    mine.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n",
    );
    let theirs = TempDir::new("http-vaults-theirs");
    theirs.write("Secret.md", "# Secret\n");
    theirs.write(
        "access.toml",
        "[[members]]\nuser = \"bob\"\nrole = \"owner\"\n",
    );

    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth db");
    let alice = auth
        .setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: "correct horse battery staple",
        })
        .expect("setup");
    let token = auth
        .create_session(alice.id, 4_102_444_800)
        .expect("session");
    let alice_header = format!(
        "Cookie: mb_session={}\r\n",
        auth.signed_session_cookie(&token).expect("sign cookie")
    );
    let state = AppState::authenticated(
        vec![
            vault(&mine, "mine", "Mine"),
            vault(&theirs, "theirs", "Theirs"),
        ],
        auth,
    )
    .expect("secure state");
    let server = TestServer::start(state);

    let (status, body) = server.get_with_headers("/api/v1/vaults", &alice_header);
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("mine"), "{body}");
    assert!(
        !body.contains("theirs") && !body.contains("Theirs"),
        "a vault the caller cannot open must not be named: {body}"
    );

    // Anonymous sees none of them, rather than the list without the contents.
    let (status, body) = server.request("GET", "/api/v1/vaults", "", "");
    assert!(is_ok(&status), "{status}");
    assert_eq!(body, "[]", "{body}");
}

#[test]
fn bookmarks_are_per_user_and_filtered_by_what_the_caller_can_still_read() {
    // E15, with the filter a workspace layout does not have. A bookmark list survives for
    // months across ACL changes, so a revoked note must leave the sidebar rather than sitting
    // there as a name the user is no longer allowed to see (§6.5).
    let dir = TempDir::new("http-bookmarks");
    let data = TempDir::new("http-bookmarks-data");
    dir.write("Public.md", "# Public\n");
    dir.write("Private/Salary.md", "# Salary Review\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n\n\
         [[members]]\nuser = \"bob\"\nrole = \"viewer\"\n",
    );
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth db");
    let alice = auth
        .setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: "correct horse battery staple",
        })
        .expect("setup");
    let bob = auth
        .create_user(mb_auth::NewUser {
            username: "bob",
            display_name: "Bob",
            password: "correct horse battery staple",
        })
        .expect("member");
    let header = |id| {
        let token = auth.create_session(id, 4_102_444_800).expect("session");
        format!(
            "Cookie: mb_session={}\r\n",
            auth.signed_session_cookie(&token).expect("sign cookie")
        )
    };
    let alice_header = header(alice.id);
    let bob_header = header(bob.id);
    let state = AppState::authenticated(vec![vault(&dir, "v", "V")], auth)
        .expect("secure state")
        .with_data_dir(data.path().to_path_buf());
    let server = TestServer::start(state);
    let route = "/api/v1/vaults/v/bookmarks";

    // Nothing saved yet is an empty list, not an error: it is the normal first visit.
    let (status, body) = server.get_with_headers(route, &alice_header);
    assert!(is_ok(&status), "{status}");
    assert_eq!(body, "[]", "{body}");

    let (status, _) = server.put_json(route, &alice_header, r#"["Public.md","Private/Salary.md"]"#);
    assert!(status.contains("204"), "{status}");
    let (_, body) = server.get_with_headers(route, &alice_header);
    assert!(body.contains("Salary"), "the owner keeps both: {body}");

    // Bob is a member of the same vault and sees his own empty list, not hers.
    let (status, body) = server.get_with_headers(route, &bob_header);
    assert!(is_ok(&status), "{status}");
    assert_eq!(
        body, "[]",
        "one member must not read another's bookmarks: {body}"
    );

    // The revocation half — a note losing its permission leaves the list on the next read —
    // is asserted at the store level in `leak_suite.rs`. It needs the ACL to change, and a
    // live policy reload happens on the maintenance tick, which this bare router does not run.
}

#[test]
fn a_stored_bookmark_the_caller_cannot_read_is_filtered_out_of_the_reply() {
    // Defence in depth, and the assertion that actually exercises the handler. `PUT` refuses
    // an unreadable path, so the only way one is on disk is that permission changed after it
    // was stored — or that the file arrived some other way, from a restored backup or an
    // administrator's editor. Either way the *read* is what must not name it (§6.5).
    //
    // Written straight to disk on purpose: routing it through `PUT` would test the write
    // guard again and leave the read guard uncovered, which is how removing the read filter
    // passed the whole suite once.
    let dir = TempDir::new("http-bookmarks-stale");
    let data = TempDir::new("http-bookmarks-stale-data");
    dir.write("Public.md", "# Public\n");
    dir.write("Private/Salary.md", "# Salary Review\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n\n\
         [[rules]]\npath = \"Private\"\ngrant = { alice = \"none\" }\n",
    );
    let stored = data.path().join("bookmarks").join("alice");
    std::fs::create_dir_all(&stored).expect("creating the bookmark directory");
    std::fs::write(
        stored.join("v.json"),
        r#"["Public.md","Private/Salary.md"]"#,
    )
    .expect("planting a stale bookmark");

    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth db");
    let alice = auth
        .setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: "correct horse battery staple",
        })
        .expect("setup");
    let token = auth
        .create_session(alice.id, 4_102_444_800)
        .expect("session");
    let cookie = auth.signed_session_cookie(&token).expect("sign cookie");
    let state = AppState::authenticated(vec![vault(&dir, "v", "V")], auth)
        .expect("secure state")
        .with_data_dir(data.path().to_path_buf());
    let mut server = TestServer::start(state);
    server.default_headers = format!("Cookie: mb_session={cookie}\r\n");

    let (status, body) = server.get("/api/v1/vaults/v/bookmarks");
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("Public.md"), "{body}");
    assert!(
        !body.contains("Salary") && !body.contains("Private"),
        "a bookmark the caller cannot read must not be named back at them: {body}"
    );
}

#[test]
fn a_bookmark_the_caller_cannot_read_is_refused_rather_than_stored() {
    // Otherwise the list becomes a way to record that a note exists — the thing §6.5 forbids —
    // and one that would be handed straight back the moment access was granted.
    let dir = TempDir::new("http-bookmarks-deny");
    let data = TempDir::new("http-bookmarks-deny-data");
    dir.write("Public.md", "# Public\n");
    dir.write("Private/Salary.md", "# Salary Review\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n\n\
         [[rules]]\npath = \"Private\"\ngrant = { alice = \"none\" }\n",
    );
    let data_dir = data.path().to_path_buf();
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth db");
    let alice = auth
        .setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: "correct horse battery staple",
        })
        .expect("setup");
    let token = auth
        .create_session(alice.id, 4_102_444_800)
        .expect("session");
    let cookie = auth.signed_session_cookie(&token).expect("sign cookie");
    let state = AppState::authenticated(vec![vault(&dir, "v", "V")], auth)
        .expect("secure state")
        .with_data_dir(data_dir);
    let mut server = TestServer::start(state);
    server.default_headers = format!("Cookie: mb_session={cookie}\r\n");
    let route = "/api/v1/vaults/v/bookmarks";

    let (status, _) = server.put_json(route, "", r#"["Private/Salary.md"]"#);
    assert!(is_not_found(&status), "{status}");

    // A traversal dressed as a bookmark is refused the same way.
    let (status, _) = server.put_json(route, "", r#"["../../etc/passwd"]"#);
    assert!(is_not_found(&status), "{status}");

    let (_, body) = server.get_with_headers(route, "");
    assert_eq!(body, "[]", "nothing may have been stored: {body}");
}

#[test]
fn bookmarks_are_denied_to_a_non_member_and_never_cached() {
    let dir = TempDir::new("http-bookmarks-outsider");
    let data = TempDir::new("http-bookmarks-outsider-data");
    dir.write("One.md", "# One\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n",
    );
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth db");
    let alice = auth
        .setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: "correct horse battery staple",
        })
        .expect("setup");
    let charlie = auth
        .create_user(mb_auth::NewUser {
            username: "charlie",
            display_name: "Charlie",
            password: "correct horse battery staple",
        })
        .expect("non-member");
    let charlie_token = auth
        .create_session(charlie.id, 4_102_444_800)
        .expect("session");
    let charlie_header = format!(
        "Cookie: mb_session={}\r\n",
        auth.signed_session_cookie(&charlie_token)
            .expect("sign cookie")
    );
    let alice_token = auth
        .create_session(alice.id, 4_102_444_800)
        .expect("session");
    let alice_header = format!(
        "Cookie: mb_session={}\r\n",
        auth.signed_session_cookie(&alice_token)
            .expect("sign cookie")
    );
    // No default headers: `get_with_headers` *concatenates* them with what it is given, so a
    // default cookie plus an explicit one sends two, and the server reads the first — which
    // silently turns a "denied" assertion into a test of the wrong user.
    let state = AppState::authenticated(vec![vault(&dir, "v", "V")], auth)
        .expect("secure state")
        .with_data_dir(data.path().to_path_buf());
    let server = TestServer::start(state);
    let route = "/api/v1/vaults/v/bookmarks";

    // A non-member gets the same reply as an unknown vault, not an empty list — which would
    // confirm the vault exists.
    let (status, _) = server.get_with_headers(route, &charlie_header);
    assert!(is_not_found(&status), "{status}");
    let (status, _) = server.request("GET", route, "", "");
    assert!(is_not_found(&status), "{status}");

    // A list of note names should not be kept by anything on the way past.
    let headers = server.headers_with(route, &alice_header).to_lowercase();
    assert!(
        headers.contains("cache-control: no-store"),
        "bookmarks must not be cached: {headers}"
    );
}

// -- Response compression (SPEC §21.1) ---------------------------------------------------
//
// `crates/mb-server/src/compress.rs` exists because §21.2 budgets the critical-path bundle
// in gzip while nothing in the serving path compressed: a cold load transferred 1.39 MB
// against a 515.9 KB budget. These assert the wire, not the middleware — a body is decoded
// back and compared to what was written to disk, because "the header said gzip" and "the
// browser can read it" are different claims.
//
// Note that every other test in this file sends no `Accept-Encoding` at all, which is why
// none of them changed: a response is only compressed for a client that asked. That is
// convenient and also a trap — a `String`-reading assertion here can never see a
// compression bug, so anything about compression belongs in this section using `get_raw`.

/// A build root holding one script big enough to be worth compressing and one file whose
/// type is not on the allowlist.
fn compressible_web_root() -> TempDir {
    let web = TempDir::new("http-compress-web");
    web.write(
        "index.html",
        "<body><div id=\"app\" data-vault=\"\" data-note=\"\" data-user=\"\"></div></body>",
    );
    web.write(
        "assets/index-abc123.js",
        &"console.log('editor');".repeat(60),
    );
    web.write("assets/tiny-abc123.js", "x");
    web.write("assets/blob-abc123.bin", &"binary-ish payload".repeat(60));
    web
}

fn gzip_len(bytes: &[u8]) -> usize {
    use std::io::Write as _;
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(9));
    encoder.write_all(bytes).expect("compressing");
    encoder.finish().expect("finishing").len()
}

fn gunzip(bytes: &[u8]) -> Vec<u8> {
    use std::io::Read as _;
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(bytes)
        .read_to_end(&mut out)
        .expect("the body should be valid gzip");
    out
}

#[test]
fn a_script_is_gzipped_for_a_client_that_asks_and_decodes_back_to_the_file_on_disk() {
    let vault_dir = TempDir::new("http-compress-vault");
    vault_dir.write("One.md", "# One\n");
    let web = compressible_web_root();
    let server = TestServer::authenticated_with_web_root(
        vec![vault(&vault_dir, "personal", "Personal")],
        web.path().to_path_buf(),
    );
    let on_disk = std::fs::read(web.path().join("assets/index-abc123.js")).expect("the script");

    let (head, body) = server.get_raw("/assets/index-abc123.js", "Accept-Encoding: gzip\r\n");

    assert!(head.contains("content-encoding: gzip"), "{head}");
    assert!(head.contains("vary: accept-encoding"), "{head}");
    assert_eq!(gunzip(&body), on_disk, "the decoded body must be the file");
    assert!(
        body.len() < on_disk.len(),
        "compressed {} vs {} on disk",
        body.len(),
        on_disk.len()
    );
    // The whole point of the change: fewer bytes on the wire than the budget's own figure
    // was being compared against.
    assert!(
        head.contains(&format!("content-length: {}", body.len())),
        "{head}"
    );
}

#[test]
fn a_wasm_module_is_gzipped_because_it_is_where_the_bundle_budget_is_lost() {
    // §21.1: `mb_bg.wasm` is 945 KB raw and 355 KB gzipped, and is the single largest item
    // on the critical path. A content-type allowlist that forgot `application/wasm` would
    // leave the budget almost exactly as breached as it was, while every other asset test
    // passed — so this is asserted separately from the script above rather than folded in.
    let vault_dir = TempDir::new("http-compress-wasm-vault");
    vault_dir.write("One.md", "# One\n");
    let web = TempDir::new("http-compress-wasm-web");
    web.write("index.html", "<body></body>");
    web.write("assets/mb_bg-abc123.wasm", &"\0asm\u{1}\0\0\0".repeat(80));
    let server = TestServer::authenticated_with_web_root(
        vec![vault(&vault_dir, "personal", "Personal")],
        web.path().to_path_buf(),
    );
    let on_disk = std::fs::read(web.path().join("assets/mb_bg-abc123.wasm")).expect("the module");

    let (head, body) = server.get_raw("/assets/mb_bg-abc123.wasm", "Accept-Encoding: gzip\r\n");

    assert!(head.contains("content-encoding: gzip"), "{head}");
    assert!(head.contains("content-type: application/wasm"), "{head}");
    assert_eq!(gunzip(&body), on_disk);
}

#[test]
fn a_client_that_offers_no_encoding_gets_the_bytes_uncompressed_but_still_gets_vary() {
    let vault_dir = TempDir::new("http-compress-plain-vault");
    vault_dir.write("One.md", "# One\n");
    let web = compressible_web_root();
    let server = TestServer::authenticated_with_web_root(
        vec![vault(&vault_dir, "personal", "Personal")],
        web.path().to_path_buf(),
    );
    let on_disk = std::fs::read(web.path().join("assets/index-abc123.js")).expect("the script");

    let (head, body) = server.get_raw("/assets/index-abc123.js", "");

    assert!(!head.contains("content-encoding"), "{head}");
    assert_eq!(body, on_disk);
    // why: without `Vary`, a cache that stored this plain response is free to serve it to a
    // client that asked for gzip and — worse — to serve the gzipped variant to one that did
    // not. It belongs on the response that was *not* compressed just as much as on the one
    // that was, which is the case a test is most likely to miss.
    assert!(head.contains("vary: accept-encoding"), "{head}");
}

#[test]
fn gzip_at_quality_zero_is_a_refusal_and_not_an_offer() {
    let vault_dir = TempDir::new("http-compress-q0-vault");
    vault_dir.write("One.md", "# One\n");
    let web = compressible_web_root();
    let server = TestServer::authenticated_with_web_root(
        vec![vault(&vault_dir, "personal", "Personal")],
        web.path().to_path_buf(),
    );

    // `gzip;q=0` contains the substring "gzip", so a header search says yes and RFC 9110
    // says no. The `q=0` form is how a client turns an encoding off.
    let (head, _) = server.get_raw("/assets/index-abc123.js", "Accept-Encoding: gzip;q=0\r\n");
    assert!(!head.contains("content-encoding"), "{head}");

    // And the forms that are offers still work: a q-value, a wildcard, and a list.
    for offer in [
        "gzip",
        "GZIP",
        "gzip;q=1.0",
        "*",
        "br, gzip;q=0.8",
        "deflate, gzip",
    ] {
        let (head, _) = server.get_raw(
            "/assets/index-abc123.js",
            &format!("Accept-Encoding: {offer}\r\n"),
        );
        assert!(
            head.contains("content-encoding: gzip"),
            "`{offer}` offers gzip: {head}"
        );
    }
}

#[test]
fn a_body_too_short_to_be_worth_compressing_is_sent_as_it_is() {
    let vault_dir = TempDir::new("http-compress-tiny-vault");
    vault_dir.write("One.md", "# One\n");
    let web = compressible_web_root();
    let server = TestServer::authenticated_with_web_root(
        vec![vault(&vault_dir, "personal", "Personal")],
        web.path().to_path_buf(),
    );

    let (head, body) = server.get_raw("/assets/tiny-abc123.js", "Accept-Encoding: gzip\r\n");

    assert!(!head.contains("content-encoding"), "{head}");
    assert_eq!(body, b"x", "a one-byte script gzips to 21 bytes");
}

#[test]
fn a_content_type_off_the_allowlist_is_not_compressed() {
    let vault_dir = TempDir::new("http-compress-blob-vault");
    vault_dir.write("One.md", "# One\n");
    let web = compressible_web_root();
    let server = TestServer::authenticated_with_web_root(
        vec![vault(&vault_dir, "personal", "Personal")],
        web.path().to_path_buf(),
    );
    let on_disk = std::fs::read(web.path().join("assets/blob-abc123.bin")).expect("the blob");

    // `application/octet-stream` is deliberately absent from the allowlist: an unknown type
    // is as likely to be an already-compressed format as not, and M11's media path will
    // serve images and video through content addressing.
    let (head, body) = server.get_raw("/assets/blob-abc123.bin", "Accept-Encoding: gzip\r\n");

    assert!(!head.contains("content-encoding"), "{head}");
    assert!(
        !head.contains("vary"),
        "no variants, so nothing to vary on: {head}"
    );
    assert_eq!(body, on_disk);
}

#[test]
fn a_server_rendered_note_page_is_compressed() {
    // The read-only rendering path (§17.2) serves HTML, and a note page is the largest
    // response this server produces that is not an asset.
    let vault_dir = TempDir::new("http-compress-note-vault");
    vault_dir.write(
        "One.md",
        &format!("# One\n\n{}\n", "Some prose about berries. ".repeat(80)),
    );
    let server = TestServer::authenticated(vec![vault(&vault_dir, "personal", "Personal")]);

    let (head, body) = server.get_raw("/v/personal/One.md", "Accept-Encoding: gzip\r\n");

    assert!(head.contains("content-encoding: gzip"), "{head}");
    let decoded = String::from_utf8(gunzip(&body)).expect("html is utf-8");
    assert!(decoded.contains("Some prose about berries."), "{decoded}");
    // This path carries its CSP as a `<meta http-equiv>` inside the document rather than as
    // a header, so the policy is one of the bytes compression has to hand back intact — a
    // truncated body here would be a note page with no content policy at all.
    assert!(
        decoded.contains("Content-Security-Policy"),
        "the policy must survive the round trip: {decoded}"
    );
}

#[test]
fn compression_does_not_soften_a_denial() {
    // A route that denies is still a route, and `not_found` goes through the same layer.
    // What must not happen is a 404 turning into a 200 because the body changed shape.
    let vault_dir = TempDir::new("http-compress-denied-vault");
    vault_dir.write("One.md", "# One\n");
    let server = TestServer::authenticated(vec![vault(&vault_dir, "personal", "Personal")]);

    let (head, _) = server.get_raw("/v/personal/Missing.md", "Accept-Encoding: gzip\r\n");
    assert!(head.starts_with("http/1.1 404"), "{head}");
    let (head, _) = server.get_raw("/v/nope/One.md", "Accept-Encoding: gzip\r\n");
    assert!(head.starts_with("http/1.1 404"), "{head}");
}

#[test]
fn a_cached_gzip_is_reused_and_dropped_when_the_file_underneath_it_changes() {
    // The asset route compresses once and keeps the result, because gzipping a 945 KB
    // WebAssembly module per visitor costs 31.5 ms of server CPU each time (§21.6). Vite
    // content-hashes filenames, so in a real bundle a changed asset is a changed URL and the
    // cache could not go stale — but `web_root` is a directory an operator controls, and a
    // rebuild dropped over it in place is exactly what would serve last week's editor
    // forever. The stamp is what stops that, and this is what says the stamp works.
    let vault_dir = TempDir::new("http-compress-cache-vault");
    vault_dir.write("One.md", "# One\n");
    let web = TempDir::new("http-compress-cache-web");
    web.write("index.html", "<body></body>");
    web.write("assets/app-abc123.js", &"console.log('first');".repeat(60));
    let server = TestServer::authenticated_with_web_root(
        vec![vault(&vault_dir, "personal", "Personal")],
        web.path().to_path_buf(),
    );

    let (_, first) = server.get_raw("/assets/app-abc123.js", "Accept-Encoding: gzip\r\n");
    let (_, again) = server.get_raw("/assets/app-abc123.js", "Accept-Encoding: gzip\r\n");
    assert_eq!(first, again, "the second request is the cached body");
    assert!(String::from_utf8(gunzip(&first)).unwrap().contains("first"));

    // A different length as well as different content: mtime granularity is coarse enough
    // that two writes in the same test can share a timestamp, and the point here is the
    // cache invalidating rather than a demonstration of clock resolution.
    web.write(
        "assets/app-abc123.js",
        &"console.log('second edition');".repeat(60),
    );

    let (head, replaced) = server.get_raw("/assets/app-abc123.js", "Accept-Encoding: gzip\r\n");
    assert!(head.contains("content-encoding: gzip"), "{head}");
    let decoded = String::from_utf8(gunzip(&replaced)).unwrap();
    assert!(decoded.contains("second edition"), "served a stale body");
    assert!(
        !decoded.contains("console.log('first')"),
        "served a stale body"
    );
}

#[test]
fn an_asset_that_gzip_would_not_shrink_is_served_as_it_is() {
    // Incompressible bytes gzip to slightly *more* than they started as. The cache refuses
    // to store a body bigger than the file, so the client gets the original — one fewer
    // decompression on a mid-range phone for no bytes saved (§21.1).
    let vault_dir = TempDir::new("http-compress-noshrink-vault");
    vault_dir.write("One.md", "# One\n");
    let web = TempDir::new("http-compress-noshrink-web");
    web.write("index.html", "<body></body>");
    // A .js extension to stay on the allowlist, holding bytes with no redundancy to find.
    // Written directly rather than through `TempDir::write`, because high-entropy *text* is
    // not high-entropy bytes: a printable alphabet caps at ~6.6 bits a character and gzip
    // still takes a third off it. Random bytes are what actually grows under gzip, and
    // already-compressed media is what this case stands in for.
    let noise: Vec<u8> = (0..4000u64)
        .map(|n| {
            let mut hash = n.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
            hash ^= hash >> 29;
            hash = hash.wrapping_mul(0xbf58_476d_1ce4_e5b9);
            hash ^= hash >> 32;
            u8::try_from(hash & 0xff).unwrap_or(0)
        })
        .collect();
    std::fs::create_dir_all(web.path().join("assets")).expect("assets dir");
    std::fs::write(web.path().join("assets/noise-abc123.js"), &noise).expect("the file");
    let server = TestServer::authenticated_with_web_root(
        vec![vault(&vault_dir, "personal", "Personal")],
        web.path().to_path_buf(),
    );
    let on_disk = std::fs::read(web.path().join("assets/noise-abc123.js")).expect("the file");
    // The premise, asserted rather than assumed: if this ever compresses well the test below
    // is measuring nothing.
    assert!(
        gzip_len(&on_disk) >= on_disk.len(),
        "this input is supposed to be incompressible: {} gzipped vs {} raw",
        gzip_len(&on_disk),
        on_disk.len()
    );

    let (head, body) = server.get_raw("/assets/noise-abc123.js", "Accept-Encoding: gzip\r\n");

    assert!(!head.contains("content-encoding"), "{head}");
    assert_eq!(body, on_disk);
}

#[test]
fn a_compressed_denial_is_byte_identical_whether_or_not_the_note_exists() {
    // §6.5: a note the caller cannot read does not exist for them. Compression is a new way
    // to break that, because it turns a body into a *length* — and two denials that differ
    // by one byte of prose differ by more than that once gzipped. Deterministic compression
    // of identical bodies keeps them identical, and this is what says so.
    //
    // It is a distinct case from `http_read_matrix_...` above rather than a duplicate of it:
    // teaching the note route to answer an existing-but-unreadable note differently from a
    // missing one fails this test and leaves that one green.
    let dir = TempDir::new("http-compress-invisible");
    dir.write(
        "Public.md",
        "# Public
",
    );
    dir.write(
        "Private/Salary.md",
        "# Salary Review
",
    );
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n\n\
         [[members]]\nuser = \"bob\"\nrole = \"viewer\"\n\n\
         [[rules]]\npath = \"Private\"\ngrant = { bob = \"none\" }\n",
    );
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth db");
    drop(
        auth.setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: "correct horse battery staple",
        })
        .expect("setup"),
    );
    let bob = auth
        .create_user(mb_auth::NewUser {
            username: "bob",
            display_name: "Bob",
            password: "correct horse battery staple",
        })
        .expect("viewer");
    let bob_token = auth.create_session(bob.id, 4_102_444_800).expect("session");
    let bob_cookie = format!(
        "Cookie: mb_session={}\r\nAccept-Encoding: gzip\r\n",
        auth.signed_session_cookie(&bob_token).expect("sign cookie")
    );
    let server = TestServer::start(
        AppState::authenticated(vec![vault(&dir, "personal", "Personal")], auth)
            .expect("secure state"),
    );

    // A note that exists and is unreadable, one that does not exist, and one in a folder
    // that does not exist. Bob must not be able to tell them apart by any of head, body or
    // length.
    let unreadable = server.get_raw("/v/personal/Private/Salary.md", &bob_cookie);
    let missing = server.get_raw("/v/personal/Private/Bonus.md", &bob_cookie);
    let nowhere = server.get_raw("/v/personal/Nowhere/Bonus.md", &bob_cookie);

    let date = |head: String| {
        head.lines()
            .filter(|line| !line.starts_with("date:"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    assert_eq!(date(unreadable.0.clone()), date(missing.0.clone()));
    assert_eq!(date(unreadable.0), date(nowhere.0));
    assert_eq!(unreadable.1, missing.1);
    assert_eq!(unreadable.1, nowhere.1);

    // And the readable one is a different answer, or the assertions above are vacuous.
    let (head, _) = server.get_raw("/v/personal/Public.md", &bob_cookie);
    assert!(
        is_ok(&head.to_uppercase()) || head.starts_with("http/1.1 200"),
        "{head}"
    );
}

#[test]
fn backlinks_name_only_notes_the_caller_can_read() {
    // E8. The disclosure here is a *name*: a backlink row from a note bob cannot read tells
    // him it exists, what it is called, and — through the context — what it says.
    let dir = TempDir::new("http-backlinks");
    dir.write("Projects/Roadmap.md", "# The Roadmap\n");
    dir.write(
        "Public.md",
        "# Public\n\nWe should ship [[Roadmap]] this quarter.\n",
    );
    dir.write(
        "Private/Salary.md",
        "# Salary Review\n\nBudget for [[Roadmap]] is set. ^budget\n",
    );
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n\n\
         [[members]]\nuser = \"bob\"\nrole = \"viewer\"\n\n\
         [[rules]]\npath = \"Private\"\ngrant = { bob = \"none\" }\n",
    );
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth db");
    let alice = auth
        .setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: "correct horse battery staple",
        })
        .expect("setup");
    let bob = auth
        .create_user(mb_auth::NewUser {
            username: "bob",
            display_name: "Bob",
            password: "correct horse battery staple",
        })
        .expect("viewer");
    let charlie = auth
        .create_user(mb_auth::NewUser {
            username: "charlie",
            display_name: "Charlie",
            password: "correct horse battery staple",
        })
        .expect("non-member");
    let header = |id| {
        let token = auth.create_session(id, 4_102_444_800).expect("session");
        format!(
            "Cookie: mb_session={}\r\n",
            auth.signed_session_cookie(&token).expect("sign cookie")
        )
    };
    let alice_header = header(alice.id);
    let bob_header = header(bob.id);
    let charlie_header = header(charlie.id);
    let state = AppState::authenticated(vec![vault(&dir, "v", "V")], auth).expect("secure state");
    let server = TestServer::start(state);
    let route = "/api/v1/vaults/v/backlinks/Projects/Roadmap.md";

    // The owner sees both sources, with the block context and the source block id.
    let (status, body) = server.get_with_headers(route, &alice_header);
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("Public.md"), "{body}");
    assert!(body.contains("Private/Salary.md"), "{body}");
    assert!(
        body.contains("We should ship Roadmap this quarter."),
        "the containing block travels as context: {body}"
    );
    assert!(body.contains("\"source_block\":\"budget\""), "{body}");
    assert!(body.contains("\"note\":\"Projects/Roadmap.md\""), "{body}");

    // The viewer denied `Private` sees the public source and nothing about the private one.
    let (status, body) = server.get_with_headers(route, &bob_header);
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("Public.md"), "{body}");
    assert!(!body.contains("Salary"), "a denied note was named: {body}");
    assert!(!body.contains("Private"), "nor its folder: {body}");
    assert!(!body.contains("Budget for"), "nor its text: {body}");

    // A note bob cannot read has no backlinks, and says so the way a missing note does.
    let (status, body) =
        server.get_with_headers("/api/v1/vaults/v/backlinks/Private/Salary.md", &bob_header);
    assert!(is_not_found(&status), "{status}");
    assert!(!body.contains("Roadmap"), "{body}");

    // A non-member and an anonymous caller get the same empty-handed answer as an unknown
    // vault, rather than an empty list that would confirm the note exists.
    let (status, body) = server.get_with_headers(route, &charlie_header);
    assert!(is_not_found(&status), "{status}");
    assert!(!body.contains("Public"), "{body}");
    let (status, _) = server.request("GET", route, "", "");
    assert!(is_not_found(&status), "{status}");
    let (status, _) = server.get_with_headers(
        "/api/v1/vaults/nope/backlinks/Projects/Roadmap.md",
        &alice_header,
    );
    assert!(is_not_found(&status), "{status}");
}

#[test]
fn backlinks_resolve_a_wikilink_name_to_the_note_it_means() {
    // §4.3: links are written by name, so the route has to accept what the editor has — the
    // note's path — and answer for the note that name resolves to.
    let dir = TempDir::new("http-backlinks-name");
    dir.write("Projects/Roadmap.md", "# Roadmap\n");
    dir.write("Q3.md", "see [[Roadmap]]\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    for route in [
        "/api/v1/vaults/v/backlinks/Projects/Roadmap.md",
        "/api/v1/vaults/v/backlinks/Projects/Roadmap",
        "/api/v1/vaults/v/backlinks/Roadmap",
    ] {
        let (status, body) = server.get(route);
        assert!(is_ok(&status), "{route}: {status}");
        assert!(
            body.contains("\"note\":\"Projects/Roadmap.md\"") && body.contains("Q3.md"),
            "{route}: {body}"
        );
    }
}

#[test]
fn backlinks_accept_a_note_path_with_its_separators_encoded() {
    // why: asserted rather than assumed. A client that reaches for `encodeURIComponent` on
    // the whole path sends `%2F` instead of `/`, and whether that still routes is axum's
    // business, not something to guess at — a wrong guess is a 404 the panel renders as
    // silence. It does route: the wildcard matches the raw path and the captured segment is
    // percent-decoded afterwards.
    let dir = TempDir::new("http-backlinks-encoded");
    dir.write("Projects/Roadmap.md", "# Roadmap\n");
    dir.write("Q3.md", "see [[Roadmap]]\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, body) = server.get("/api/v1/vaults/v/backlinks/Projects%2FRoadmap.md");
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("Q3.md"), "{body}");
}

#[test]
fn backlinks_are_never_cached() {
    // Note titles and note text, filtered per user. A shared cache would serve one user's
    // filtered view to another.
    let dir = TempDir::new("http-backlinks-cache");
    dir.write("A.md", "# A\n");
    dir.write("B.md", "[[A]]\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);
    let headers = server
        .headers("/api/v1/vaults/v/backlinks/A.md")
        .to_lowercase();
    assert!(headers.contains("cache-control: no-store"), "{headers}");
}

#[test]
fn backlinks_follow_an_edit_made_outside_the_application() {
    // C2 and §3.4: the files are the truth, and an edit made in Obsidian has to reach the
    // index. The maintenance tick is what does that, so the test drives the tick rather
    // than waiting on a timer — the assertion is about the mechanism, not the clock.
    let dir = TempDir::new("http-backlinks-edit");
    dir.write("A.md", "# A\n");
    dir.write("B.md", "nothing here yet\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);
    let route = "/api/v1/vaults/v/backlinks/A.md";

    let (status, body) = server.get(route);
    assert!(is_ok(&status), "{status}");
    assert!(!body.contains("B.md"), "{body}");

    dir.write("B.md", "now it mentions [[A]]\n");
    server.tick();
    let (status, body) = server.get(route);
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("B.md"), "{body}");
    assert!(body.contains("now it mentions A"), "{body}");

    // And a note deleted outside the application stops being a source.
    std::fs::remove_file(dir.path().join("B.md")).expect("delete the note");
    server.tick();
    let (_, body) = server.get(route);
    assert!(!body.contains("B.md"), "{body}");
}
