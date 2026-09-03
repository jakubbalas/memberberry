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
    addr: SocketAddr,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    default_headers: String,
}

impl TestServer {
    fn start(state: AppState) -> Self {
        let app = router(Arc::new(state));
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

    /// Issues a GET and returns `(status line, body)`.
    fn get(&self, path: &str) -> (String, String) {
        self.get_with_headers(path, "")
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
