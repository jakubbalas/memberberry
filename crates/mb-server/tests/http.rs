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
    stopped: std::sync::mpsc::Receiver<()>,
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
        let (stopped_tx, stopped_rx) = std::sync::mpsc::channel();

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
            drop(rt);
            let _sent = stopped_tx.send(());
        });

        let addr = addr_rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("the server should bind within ten seconds");
        Self {
            state,
            addr,
            shutdown: Some(shutdown_tx),
            stopped: stopped_rx,
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

    /// Waits for the runtime to release every connection before a recovery test deletes it.
    fn stop(mut self) {
        self.shutdown
            .take()
            .expect("running server")
            .send(())
            .expect("signal shutdown");
        self.stopped
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("the server runtime must stop before derived state is deleted");
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

    /// Issues a form POST carrying this server's session cookie.
    ///
    /// Separate from `post_form`, which is deliberately unauthenticated because the sign-in
    /// form is posted by somebody who has no session yet.
    fn post_form_signed_in(&self, path: &str, form: &str) -> (String, String) {
        self.request(
            "POST",
            path,
            &format!(
                "{}Content-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\n",
                self.default_headers,
                form.len()
            ),
            form,
        )
    }

    /// The same, returning the whole header block — for a reply whose point is a header.
    fn post_form_head(&self, path: &str, form: &str) -> String {
        let mut stream = TcpStream::connect(self.addr).expect("connecting");
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .expect("setting a read timeout");
        write!(
            stream,
            "POST {path} HTTP/1.1\r\nHost: localhost\r\n{}Content-Type: \
             application/x-www-form-urlencoded\r\nContent-Length: {}\r\nConnection: \
             close\r\n\r\n{form}",
            self.default_headers,
            form.len()
        )
        .expect("writing the request");
        let mut raw = String::new();
        stream
            .read_to_string(&mut raw)
            .expect("reading the response");
        raw.split_once("\r\n\r\n")
            .map_or(raw.clone(), |(head, _)| head.to_string())
            .to_ascii_lowercase()
    }

    /// Issues a POST with a JSON body.
    fn post_json(&self, path: &str, headers: &str, body: &str) -> (String, String) {
        self.request(
            "POST",
            path,
            &format!(
                "{}{headers}Content-Type: application/json\r\nContent-Length: {}\r\n",
                self.default_headers,
                body.len()
            ),
            body,
        )
    }

    fn post_bytes(&self, path: &str, headers: &str, body: &[u8]) -> (String, Vec<u8>) {
        let mut stream = TcpStream::connect(self.addr).expect("connecting");
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .expect("setting a read timeout");
        write!(
            stream,
            "POST {path} HTTP/1.1\r\nHost: localhost\r\n{}{headers}\
             Content-Length: {}\r\nConnection: close\r\n\r\n",
            self.default_headers,
            body.len()
        )
        .expect("writing the request headers");
        stream.write_all(body).expect("writing the request body");
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).expect("reading the response");
        let split = raw
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("a response with a header block");
        (
            String::from_utf8_lossy(&raw[..split]).to_string(),
            raw[split + 4..].to_vec(),
        )
    }

    fn get_bytes(&self, path: &str) -> (String, Vec<u8>) {
        self.get_bytes_with_headers(path, "")
    }

    fn get_bytes_with_headers(&self, path: &str, headers: &str) -> (String, Vec<u8>) {
        let mut stream = TcpStream::connect(self.addr).expect("connecting");
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .expect("setting a read timeout");
        write!(
            stream,
            "GET {path} HTTP/1.1\r\nHost: localhost\r\n{}{headers}Connection: close\r\n\r\n",
            self.default_headers,
        )
        .expect("writing the request");
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).expect("reading the response");
        let split = raw
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("a response with a header block");
        (
            String::from_utf8_lossy(&raw[..split]).to_ascii_lowercase(),
            raw[split + 4..].to_vec(),
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
fn i1_http_restart_rebuilds_readable_content_without_reviving_denied_notes() {
    let dir = TempDir::new("http-i1");
    dir.write("notes/Source.md", "# Before\n");
    dir.write("notes/Target.md", "# Target\n");
    dir.write(
        "notes/Private/Secret.md",
        "# Classified\n\n[[Target]] #hidden\n",
    );
    let policy = "[[members]]\nuser = \"alice\"\nrole = \"viewer\"\n\n[[rules]]\npath = \"Private\"\n[rules.grant]\nalice = \"none\"\n";
    dir.write("access.toml", policy);
    {
        let vault = Vault::open(Slug::parse("v").expect("slug"), "V", dir.path()).expect("vault");
        let canonical = vault.canonical_note("Source.md").expect("note");
        let mut coordinator =
            mb_server::sync::NoteCoordinator::open(&vault, &canonical).expect("coordinator");
        let replica =
            mb_crdt::document_from_update_v1(&coordinator.full_update()).expect("replica");
        mb_crdt::apply_external_markdown(
            &replica,
            "# After\n\n[[Target]] #recovery\n\n- [ ] Recovered task\n",
        )
        .expect("edit");
        coordinator
            .apply_remote_update(
                &mb_crdt::encode_update_v1(&replica),
                std::time::Instant::now(),
            )
            .expect("accept edit");
        coordinator.flush().expect("write Markdown");
    }
    let start = || {
        TestServer::authenticated(vec![
            Vault::open(Slug::parse("v").expect("slug"), "V", dir.path()).expect("reopen vault"),
        ])
    };
    let routes = [
        "/v/v/Source.md",
        "/api/v1/vaults/v/notes",
        "/api/v1/vaults/v/backlinks/Target.md",
        "/api/v1/vaults/v/tags",
        "/api/v1/vaults/v/graph",
        "/api/v1/vaults/v/graph/Target.md",
    ];
    let server = start();
    let before: Vec<_> = routes.iter().map(|path| server.get(path)).collect();
    for (path, (status, body)) in routes.iter().zip(&before) {
        assert!(is_ok(status), "{path}: {status}");
        assert!(
            !body.contains("Classified")
                && !body.contains("Private/Secret")
                && !body.contains("hidden"),
            "{path}: {body}"
        );
    }
    assert!(before[0].1.contains("Recovered task"));
    assert!(before[1].1.contains("After"));
    assert!(before[2].1.contains("Source.md"));
    assert!(before[3].1.contains("recovery"));
    assert!(before[4].1.contains("Source.md"));
    assert!(before[5].1.contains("Source.md"));
    server.stop();
    std::fs::remove_dir_all(dir.path().join(".memberberry"))
        .expect("delete all derived state with the server stopped");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("access.toml")).expect("durable ACL"),
        policy
    );
    let restarted = start();
    for (path, expected) in routes.iter().zip(&before) {
        assert_eq!(
            &restarted.get(path),
            expected,
            "{path} changed after rebuilding"
        );
    }
    for prefix in [
        "/v/v/",
        "/api/v1/vaults/v/backlinks/",
        "/api/v1/vaults/v/graph/",
    ] {
        let denied = restarted.get(&format!("{prefix}Private/Secret.md"));
        let absent = restarted.get(&format!("{prefix}Absent.md"));
        assert!(is_not_found(&denied.0));
        assert_eq!(denied, absent, "recovery leaked existence through {prefix}");
    }
    restarted.stop();
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
    assert!(body.contains("data-media-max-dimension=\"2560\""), "{body}");
    let (head, _) = server.get_raw("/v/personal/One.md", "");
    assert!(head.contains("object-src 'self'"), "{head}");
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

#[test]
fn clip_route_converts_supplied_html_and_writes_markdown_metadata() {
    let dir = TempDir::new("http-clip-vault");
    dir.write("notes/Welcome.md", "# Welcome\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);
    let (status, body) = server.post_json(
        "/api/v1/vaults/v/clip",
        "",
        r#"{"url":"https://example.com/story","path":"Clips/story.md","html":"<h1>Story</h1><p>A <strong>clip</strong>.</p>","tags":["reading"],"template":"Article","title":"Story","author":"Alice"}"#,
    );
    assert!(is_ok(&status), "{status}: {body}");
    assert!(body.contains("Clips/story.md"), "{body}");
    let saved =
        std::fs::read_to_string(dir.path().join("notes/Clips/story.md")).expect("saved clip");
    assert!(saved.contains("# Story"));
    assert!(saved.contains("source: https://example.com/story"));
    assert!(saved.contains("author: Alice"));
    assert!(saved.contains("template: Article"));
    assert!(saved.contains("tags: [reading]"));
    assert!(saved.contains("A **clip**."));
}

#[test]
fn clip_route_generates_markdown_paths_and_retries_name_collisions() {
    let dir = TempDir::new("http-clip-generated-path");
    dir.write("notes/Welcome.md", "# Welcome\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);
    let request = r#"{"url":"https://example.com/story","folder":"Clips","html":"<p>clip</p>"}"#;

    let (first_status, first_body) = server.post_json("/api/v1/vaults/v/clip", "", request);
    let (second_status, second_body) = server.post_json("/api/v1/vaults/v/clip", "", request);

    assert!(is_ok(&first_status), "{first_status}: {first_body}");
    assert!(is_ok(&second_status), "{second_status}: {second_body}");
    assert!(first_body.contains("Clips/story.md"), "{first_body}");
    assert!(second_body.contains("Clips/story-2.md"), "{second_body}");
    assert!(dir.path().join("notes/Clips/story.md").is_file());
    assert!(dir.path().join("notes/Clips/story-2.md").is_file());
}

#[test]
fn clip_route_accepts_text_without_inventing_a_source_url() {
    let dir = TempDir::new("http-clip-shared-text");
    dir.write("notes/Welcome.md", "# Welcome\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);
    let (status, body) = server.post_json(
        "/api/v1/vaults/v/clip",
        "",
        r#"{"title":"Shared thought","folder":"Inbox","text":"A thought from another app."}"#,
    );

    assert!(is_ok(&status), "{status}: {body}");
    let saved = std::fs::read_to_string(dir.path().join("notes/Inbox/Shared thought.md"))
        .expect("shared text note");
    assert!(saved.contains("A thought from another app."), "{saved}");
    assert!(!saved.contains("source:"), "{saved}");
}

#[test]
fn clip_route_accepts_only_staged_media_and_writes_its_markdown_reference() {
    let dir = TempDir::new("http-clip-shared-image");
    dir.write("notes/Welcome.md", "# Welcome\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);
    let mut image = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(1, 1)
        .write_to(&mut image, image::ImageFormat::Png)
        .expect("shared image");
    let bytes = image.into_inner();
    let (upload_status, upload_body) = server.post_bytes(
        "/api/v1/vaults/v/media",
        "Content-Type: image/png\r\nX-Memberberry-Filename: shared.png\r\n",
        &bytes,
    );
    assert!(upload_status.contains("201"), "{upload_status}");
    let upload: serde_json::Value = serde_json::from_slice(&upload_body).expect("upload reply");
    let path = upload["path"].as_str().expect("uploaded path");

    let (status, body) = server.post_json(
        "/api/v1/vaults/v/clip",
        "",
        &format!(r#"{{"title":"Shared image","media":[{{"path":"{path}","alt":"diagram"}}]}}"#),
    );

    assert!(is_ok(&status), "{status}: {body}");
    let saved = std::fs::read_to_string(dir.path().join("notes/Clips/Shared image.md"))
        .expect("image clip");
    assert!(saved.contains(&format!("![diagram]({path})")), "{saved}");
}

#[test]
fn clip_route_rejects_malformed_or_unstaged_inputs_without_writing() {
    let dir = TempDir::new("http-clip-invalid-inputs");
    dir.write("notes/Clips/existing.md", "# Existing\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);
    for payload in [
        r#"{}"#,
        r#"{"url":"file:///etc/passwd"}"#,
        r#"{"path":"../escape.md","text":"no"}"#,
        r#"{"path":"Clips/unstaged.md","media":[{"path":"media/aa/bb/not-staged.png"}]}"#,
        r#"{"path":"Clips/existing.md","text":"replacement"}"#,
    ] {
        let (status, body) = server.post_json("/api/v1/vaults/v/clip", "", payload);
        assert!(status.contains("400"), "{payload}: {status}: {body}");
    }
    assert_eq!(
        std::fs::read_to_string(dir.path().join("notes/Clips/existing.md")).expect("existing"),
        "# Existing\n"
    );
    assert!(!dir.path().join("escape.md").exists());
}

#[test]
fn clip_route_sanitizes_an_empty_title_to_a_root_markdown_filename() {
    let dir = TempDir::new("http-clip-sanitized-name");
    dir.write("notes/Welcome.md", "# Welcome\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, body) = server.post_json(
        "/api/v1/vaults/v/clip",
        "",
        r#"{"folder":"/","title":"***","text":"shared"}"#,
    );

    assert!(is_ok(&status), "{status}: {body}");
    assert!(body.contains("Shared clip.md"), "{body}");
    assert!(dir.path().join("notes/Shared clip.md").is_file());
}

#[test]
fn clip_route_rate_limits_each_actor_and_vault() {
    let dir = TempDir::new("http-clip-rate-limit");
    dir.write("notes/Welcome.md", "# Welcome\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);
    for ordinal in 0..12 {
        let (status, body) = server.post_json(
            "/api/v1/vaults/v/clip",
            "",
            &format!(
                r#"{{"path":"Clips/{ordinal}.md","html":"<p>clip</p>","url":"https://example.com/{ordinal}"}}"#
            ),
        );
        assert!(is_ok(&status), "request {ordinal}: {status}: {body}");
    }
    let (status, body) = server.post_json(
        "/api/v1/vaults/v/clip",
        "",
        r#"{"path":"Clips/refused.md","html":"<p>clip</p>","url":"https://example.com/refused"}"#,
    );
    assert!(status.contains("429"), "{status}: {body}");
    assert!(!dir.path().join("notes/Clips/refused.md").exists());
}

#[test]
fn clip_route_requires_authentication_before_accepting_html() {
    let dir = TempDir::new("http-clip-denied");
    dir.write("notes/Welcome.md", "# Welcome\n");
    let server = TestServer::start({
        let auth = mb_auth::AuthDb::open_in_memory().expect("auth db");
        AppState::authenticated(vec![vault(&dir, "v", "V")], auth).expect("state")
    });
    let (status, _) = server.post_json(
        "/api/v1/vaults/v/clip",
        "",
        r#"{"url":"https://example.com/story","html":"<p>secret</p>"}"#,
    );
    assert!(is_not_found(&status), "{status}");
    assert!(!dir.path().join("Clips").exists());
}

#[test]
fn clip_route_applies_the_scoped_token_role_even_when_the_user_is_an_owner() {
    let dir = TempDir::new("http-clip-token-scope");
    dir.write("notes/Welcome.md", "# Welcome\n");
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth db");
    let alice = auth
        .setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: "correct horse battery staple",
        })
        .expect("setup");
    let viewer = auth
        .create_api_token(mb_auth::ApiTokenScope {
            user_id: alice.id,
            vault_slug: "v".to_string(),
            role: mb_core::Role::Viewer,
        })
        .expect("viewer token");
    let editor = auth
        .create_api_token(mb_auth::ApiTokenScope {
            user_id: alice.id,
            vault_slug: "v".to_string(),
            role: mb_core::Role::Editor,
        })
        .expect("editor token");
    let state = AppState::authenticated(vec![vault(&dir, "v", "V")], auth).expect("state");
    let server = TestServer::start(state);
    let body =
        r#"{"path":"Clips/scoped.md","html":"<p>clip</p>","url":"https://example.com/scoped"}"#;

    let viewer_header = format!("Authorization: Bearer {}\r\n", viewer.expose_secret());
    let (viewer_status, _) = server.post_json("/api/v1/vaults/v/clip", &viewer_header, body);
    assert!(is_not_found(&viewer_status), "{viewer_status}");
    assert!(!dir.path().join("notes/Clips/scoped.md").exists());

    let editor_header = format!("Authorization: Bearer {}\r\n", editor.expose_secret());
    let (editor_status, editor_body) =
        server.post_json("/api/v1/vaults/v/clip", &editor_header, body);
    assert!(is_ok(&editor_status), "{editor_status}: {editor_body}");
}

#[test]
fn custom_emoji_route_resolves_shared_and_vault_local_packs() {
    let dir = TempDir::new("http-emoji-vault");
    let data = TempDir::new("http-emoji-data");
    dir.write("notes/Welcome.md", "# Welcome\n");
    dir.write(
        ".memberberry/emoji/packs/local/pack.json",
        r#"{"name":"local","version":1,"emoji":[{"shortcode":"party","file":"local.png"}]}"#,
    );
    dir.write(".memberberry/emoji/packs/local/local.png", "local-image");
    data.write(
        "emoji/packs/shared/pack.json",
        r#"{"name":"shared","version":1,"emoji":[{"shortcode":"party","file":"shared.png","aliases":["parrot"]}]}"#,
    );
    data.write("emoji/packs/shared/shared.png", "shared-image");
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
    let cookie = auth.signed_session_cookie(&token).expect("cookie");
    let state = AppState::authenticated(vec![vault(&dir, "v", "V")], auth)
        .expect("state")
        .with_data_dir(data.path().to_path_buf());
    let mut server = TestServer::start(state);
    server.default_headers = format!("Cookie: mb_session={cookie}\r\n");

    let (status, _) = server.put_json(
        "/api/v1/emoji/packs/adminpack",
        "",
        r#"{"manifest":{"name":"adminpack","version":1,"emoji":[{"shortcode":"ship","file":"ship.png"}]},"files":[{"name":"ship.png","content_base64":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="}]}"#,
    );
    assert!(status.contains("204"), "{status}");

    let (status, body) = server.get("/api/v1/vaults/v/emoji");
    assert!(is_ok(&status), "{status}");
    assert!(body.contains(r#""pack":"local""#), "{body}");
    assert!(body.contains(r#""aliases":[]"#), "{body}");
    assert!(body.contains(r#""shortcode":"ship""#), "{body}");
    assert!(
        !body.contains(r#""shortcode":"party","file":"shared.png""#),
        "local collision should win: {body}"
    );
    let headers = server.headers("/api/v1/vaults/v/emoji").to_lowercase();
    assert!(headers.contains("cache-control: no-store"), "{headers}");

    let (status, body) = server.get("/api/v1/vaults/v/emoji/local/local.png");
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("local-image"), "{body}");
    let headers = server
        .headers("/api/v1/vaults/v/emoji/local/local.png")
        .to_lowercase();
    assert!(
        headers.contains("cache-control: private, no-store"),
        "{headers}"
    );

    let (status, body) = server.get("/api/v1/vaults/v/emoji/packs");
    assert!(is_ok(&status), "{status}");
    assert!(body.contains(r#""name":"local","emoji_count":1"#), "{body}");
    let headers = server
        .headers("/api/v1/vaults/v/emoji/packs")
        .to_lowercase();
    assert!(headers.contains("cache-control: no-store"), "{headers}");
    let signed_headers = server.default_headers.clone();
    let (status, _) = server.request(
        "DELETE",
        "/api/v1/vaults/v/emoji/packs/local",
        &signed_headers,
        "",
    );
    assert!(status.contains("204"), "{status}");
    let (status, body) = server.get("/api/v1/vaults/v/emoji/packs");
    assert!(is_ok(&status), "{status}");
    assert_eq!(body, "[]");
}

#[test]
fn custom_emoji_route_does_not_disclose_an_unreadable_vault() {
    let dir = TempDir::new("http-emoji-denied");
    dir.write("Secret.md", "# Secret\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"bob\"\nrole = \"owner\"\n",
    );
    let server = TestServer::authenticated(vec![
        Vault::open(Slug::parse("v").expect("slug"), "V", dir.path()).expect("vault"),
    ]);
    let (status, _) = server.get("/api/v1/vaults/v/emoji");
    assert!(is_not_found(&status), "{status}");
    let (status, _) = server.get("/api/v1/vaults/v/emoji/private/secret.png");
    assert!(is_not_found(&status), "{status}");
    let (status, _) = server.put_json(
        "/api/v1/vaults/v/emoji/packs/nope",
        "",
        r#"{"manifest":{"name":"nope","version":1,"emoji":[]},"files":[]}"#,
    );
    assert!(is_not_found(&status), "{status}");
    let (status, _) = server.get("/api/v1/vaults/v/emoji/packs");
    assert!(is_not_found(&status), "{status}");
    let (status, _) = server.request("DELETE", "/api/v1/vaults/v/emoji/packs/nope", "", "");
    assert!(is_not_found(&status), "{status}");
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
fn media_upload_is_content_addressed_but_not_readable_until_referenced() {
    let dir = TempDir::new("http-media");
    let vault = vault(&dir, "v", "V");
    let public_path = mb_server::media::LocalStore::new(&vault)
        .put(b"public", "png")
        .expect("public object");
    let private_path = mb_server::media::LocalStore::new(&vault)
        .put(b"private", "png")
        .expect("private object");
    let mut source_image = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(400, 200)
        .write_to(&mut source_image, image::ImageFormat::Png)
        .expect("source image");
    let thumbnail_path = mb_server::media::LocalStore::new(&vault)
        .put(&source_image.into_inner(), "png")
        .expect("thumbnail source");
    dir.write(
        "Public.md",
        &format!("![public]({public_path})\n![large]({thumbnail_path})\n"),
    );
    dir.write(
        "Private/Secret.md",
        &format!("![private]({private_path})\n"),
    );
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"editor\"\n\n\
         [[rules]]\npath = \"Private\"\ngrant = { alice = \"none\" }\n",
    );
    let server = TestServer::authenticated(vec![vault]);

    let (status, body) = server.get(&format!("/api/v1/vaults/v/media/{public_path}"));
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("public"), "{body}");
    let (head, thumbnail) = server.get_bytes(&format!(
        "/api/v1/vaults/v/media/{thumbnail_path}?thumbnail=100"
    ));
    assert!(head.contains("200"), "{head}");
    assert!(head.contains("content-type: image/webp"), "{head}");
    let decoded = image::load_from_memory_with_format(&thumbnail, image::ImageFormat::WebP)
        .expect("thumbnail webp");
    assert_eq!((decoded.width(), decoded.height()), (100, 50));
    let (status, body) = server.get(&format!("/api/v1/vaults/v/media/{private_path}"));
    assert!(is_not_found(&status), "{status}");
    assert!(body.contains("Not found"), "{body}");

    let mut uploaded_image = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(1, 1)
        .write_to(&mut uploaded_image, image::ImageFormat::Png)
        .expect("uploaded image");
    let uploaded_image = uploaded_image.into_inner();
    let (head, uploaded) = server.post_bytes(
        "/api/v1/vaults/v/media",
        "Content-Type: image/png\r\nX-Memberberry-Filename: screenshot.png\r\n",
        &uploaded_image,
    );
    assert!(head.contains("201"), "{head}");
    let uploaded_path =
        mb_server::media::LocalStore::object_path(&uploaded_image, "png").expect("uploaded path");
    assert!(String::from_utf8_lossy(&uploaded).contains(&uploaded_path));
    let (head, body) = server.get_bytes(&format!("/api/v1/vaults/v/media/{uploaded_path}"));
    assert!(head.contains("200"), "{head}");
    assert_eq!(body, uploaded_image);

    let (head, _) = server.post_bytes(
        "/api/v1/vaults/v/media",
        "Content-Type: image/svg+xml\r\nX-Memberberry-Filename: active.svg\r\n",
        b"<svg><script>alert(1)</script></svg>",
    );
    assert!(head.contains("400"), "{head}");
}

#[test]
fn an_unreferenced_upload_is_visible_only_to_its_uploader() {
    let dir = TempDir::new("http-media-staging");
    dir.write("Public.md", "# Public\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"editor\"\n\n\
         [[members]]\nuser = \"bob\"\nrole = \"editor\"\n",
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
        .expect("bob");
    let alice_token = auth
        .create_session(alice.id, 4_102_444_800)
        .expect("session");
    let bob_token = auth.create_session(bob.id, 4_102_444_800).expect("session");
    let alice_header = format!(
        "Cookie: mb_session={}\r\n",
        auth.signed_session_cookie(&alice_token).expect("cookie")
    );
    let bob_header = format!(
        "Cookie: mb_session={}\r\n",
        auth.signed_session_cookie(&bob_token).expect("cookie")
    );
    let state = AppState::authenticated(vec![vault(&dir, "v", "V")], auth).expect("state");
    let server = TestServer::start(state);
    let mut staged_image = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(1, 1)
        .write_to(&mut staged_image, image::ImageFormat::Png)
        .expect("staged image");
    let staged_image = staged_image.into_inner();
    let (head, body) = server.post_bytes(
        "/api/v1/vaults/v/media",
        &format!("{alice_header}Content-Type: image/png\r\nX-Memberberry-Filename: staged.png\r\n"),
        &staged_image,
    );
    assert!(head.contains("201"), "{head}");
    let path = mb_server::media::LocalStore::object_path(&staged_image, "png").expect("path");
    assert!(String::from_utf8_lossy(&body).contains(&path));
    let (status, body) =
        server.get_with_headers(&format!("/api/v1/vaults/v/media/{path}"), &bob_header);
    assert!(is_not_found(&status), "{status}");
    assert!(body.contains("Not found"), "{body}");
    let (head, body) =
        server.get_bytes_with_headers(&format!("/api/v1/vaults/v/media/{path}"), &alice_header);
    assert!(head.contains("200"), "{head}");
    assert_eq!(body, staged_image);

    let (head, _) = server.post_bytes(
        "/api/v1/vaults/v/media",
        &format!(
            "{bob_header}Content-Type: image/png\r\nX-Memberberry-Filename: display.png\r\nX-Memberberry-Original: {path}\r\n"
        ),
        &staged_image,
    );
    assert!(head.contains("400"), "{head}");
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
fn an_editor_can_save_and_read_an_excalidraw_markdown_scene() {
    let dir = TempDir::new("http-drawing");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);
    let markdown = "---\nexcalidraw-plugin: parsed\n---\n\n# Drawing\n```compressed-json\n{\"type\":\"excalidraw\",\"elements\":[]}\n```\n";
    let request = serde_json::json!({ "markdown": markdown }).to_string();

    let (status, body) =
        server.put_json("/api/v1/vaults/v/drawings/plan.excalidraw.md", "", &request);
    assert!(is_ok(&status), "{status}: {body}");
    assert!(body.contains("\"type\":\"excalidraw\""), "{body}");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("drawings/plan.excalidraw.md"))
            .expect("saved drawing"),
        markdown
    );

    let (status, body) = server.get("/api/v1/vaults/v/drawings/plan.excalidraw.md");
    assert!(is_ok(&status), "{status}: {body}");
    assert!(body.contains("\"elements\":[]"), "{body}");

    let exports = serde_json::json!({
        "svg": "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>",
        "png": "data:image/png;base64,iVBORw0KGgo="
    })
    .to_string();
    let (status, body) = server.put_json(
        "/api/v1/vaults/v/drawing-exports/plan.excalidraw.md",
        "",
        &exports,
    );
    assert!(status.contains("204 No Content"), "{status}: {body}");
    assert!(dir.path().join("drawings/plan.excalidraw.svg").is_file());
    assert!(dir.path().join("drawings/plan.excalidraw.png").is_file());

    let stale = serde_json::json!({ "markdown": markdown, "base": "stale" }).to_string();
    let (status, _) = server.put_json("/api/v1/vaults/v/drawings/plan.excalidraw.md", "", &stale);
    assert!(status.contains("409 Conflict"), "{status}");
}

#[test]
fn an_unreadable_or_unsafe_excalidraw_path_is_not_found() {
    let dir = TempDir::new("http-drawing-denied");
    dir.write(
        "drawings/private.excalidraw.md",
        "# Drawing\n```json\n{\"type\":\"excalidraw\",\"elements\":[]}\n```\n",
    );
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"viewer\"\n\n[[rules]]\npath = \"drawings/private.excalidraw.md\"\ngrant = { alice = \"none\" }\n",
    );
    let server = TestServer::authenticated(vec![
        Vault::open(Slug::parse("v").expect("slug"), "V", dir.path()).expect("vault"),
    ]);

    assert!(is_not_found(
        &server
            .get("/api/v1/vaults/v/drawings/private.excalidraw.md")
            .0
    ));
    assert!(is_not_found(
        &server
            .get("/api/v1/vaults/v/drawings/../private.excalidraw.md")
            .0
    ));
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
    assert!(is_not_found(&server.status("/api/v1/vaults/v/history")));
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
    }

    // `form-action` is the one directive that varies, and it varies with whether the page has
    // a form rather than with who asked. The vault index gained one in §6.10 — it is the only
    // route into an empty vault — so it permits posting to this origin and nothing else. Every
    // page that renders note content still submits nowhere at all, which is the property this
    // test was written for: a CSP that allowed a form on a page displaying untrusted Markdown
    // would be a hole, and one that forbade it on a page whose whole job is a form is the M5
    // outage, where the sign-in page's own policy made it unsubmittable.
    for path in ["/", "/v/v/note.md", "/nonsense"] {
        let (_, body) = server.get(path);
        assert!(
            body.contains("form-action 'none'"),
            "a page rendering note content must not be able to submit anywhere: {path}"
        );
    }
    let (_, index) = server.get("/v/v");
    assert!(index.contains("form-action 'self'"), "{index}");
    assert!(
        !index.contains("form-action 'none'"),
        "the vault index carries the create form and must be able to submit it: {index}"
    );
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
        // Without this the browser refuses to fetch the web app manifest at all, and the
        // application is silently not installable — `default-src 'none'` covers manifests
        // too (§7.4).
        "manifest-src 'self'",
    ] {
        assert!(
            headers.contains(directive),
            "the editor policy is missing `{directive}`: {headers}"
        );
    }
}

/// A build root with everything the offline shell needs in it (§7.4).
fn pwa_web_root() -> TempDir {
    let dir = TempDir::new("http-pwa-web");
    dir.write(
        "index.html",
        "<body><div id=\"app\" data-vault=\"\" data-note=\"\" data-user=\"\"></div></body>",
    );
    dir.write("sw.js", "self.addEventListener('fetch', () => {})");
    dir.write("manifest.webmanifest", "{\"name\":\"Memberberry\"}");
    dir.write("icon.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    dir.write("assets/index-abc123.js", "console.log('editor')");
    dir.write("secret.txt", "not part of the bundle");
    dir
}

#[test]
fn the_offline_shell_is_the_unbootstrapped_page_under_the_editor_policy() {
    // What the service worker precaches and answers a note URL with when the network is gone
    // (§7.4). It has to be the *unbootstrapped* page: a shell carrying one user's vault, note
    // and display name would be a cache entry the next user of that browser profile shares.
    let vault_dir = TempDir::new("http-pwa-vault");
    vault_dir.write("One.md", "# One\n");
    let web_dir = pwa_web_root();
    let server = TestServer::authenticated_with_web_root(
        vec![vault(&vault_dir, "personal", "Personal")],
        web_dir.path().to_path_buf(),
    );

    let (status, body) = server.get("/app.html");
    assert!(is_ok(&status), "{status}");
    assert!(
        body.contains("data-vault=\"\"") && body.contains("data-user=\"\""),
        "the shell must carry no session: {body}"
    );

    let headers = server.headers("/app.html").to_lowercase();
    // The same policy the bootstrapped page gets. This one runs exactly the same script.
    assert!(
        headers.contains("script-src 'self' 'wasm-unsafe-eval'"),
        "the shell runs the application and must carry its policy: {headers}"
    );
    // Not content-addressed, so a cached copy is a page asking for chunks a later build
    // deleted.
    assert!(headers.contains("cache-control: no-cache"), "{headers}");
}

#[test]
fn the_offline_shell_needs_no_session_and_reveals_no_vault() {
    // Deliberately unauthenticated: the service worker fetches it during install, and an
    // expired session would otherwise leave a browser with no offline shell and no way to
    // notice. Safe only because it carries nothing private — which is what this asserts.
    let vault_dir = TempDir::new("http-pwa-anon-vault");
    vault_dir.write("One.md", "# One\n");
    let web_dir = pwa_web_root();
    let server = TestServer::authenticated_with_web_root(
        vec![vault(&vault_dir, "personal", "Personal")],
        web_dir.path().to_path_buf(),
    );

    // No cookie: `request` sends exactly the headers it is given, unlike `get`.
    let (status, body) = server.request("GET", "/app.html", "", "");
    assert!(is_ok(&status), "{status}");
    assert!(
        !body.contains("personal") && !body.contains("Personal") && !body.contains("One.md"),
        "the shell named a vault to an anonymous caller: {body}"
    );
}

#[test]
fn the_service_worker_and_its_manifest_are_served_from_the_root() {
    // All three have to be at the root of the origin: a worker's scope is the directory it
    // is served from, and one under `/assets/` could not control `/v/<vault>/<note>`.
    let vault_dir = TempDir::new("http-pwa-root-vault");
    vault_dir.write("One.md", "# One\n");
    let web_dir = pwa_web_root();
    let server = TestServer::authenticated_with_web_root(
        vec![vault(&vault_dir, "personal", "Personal")],
        web_dir.path().to_path_buf(),
    );

    let (status, body) = server.get("/sw.js");
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("addEventListener"), "{body}");
    let headers = server.headers("/sw.js").to_lowercase();
    assert!(
        headers.contains("text/javascript"),
        "a worker served as the wrong type is refused: {headers}"
    );
    // This file is how a browser learns a new build exists. An HTTP cache answering for it
    // pins that browser to one version's precache list.
    assert!(headers.contains("cache-control: no-cache"), "{headers}");
    assert!(headers.contains("service-worker-allowed: /"), "{headers}");

    // A browser fetches a manifest without credentials, so an authenticated route here would
    // 404 on every page load.
    let (manifest_status, manifest) = server.request("GET", "/manifest.webmanifest", "", "");
    assert!(is_ok(&manifest_status), "{manifest_status}");
    assert!(manifest.contains("Memberberry"), "{manifest}");
    assert!(
        server
            .headers("/manifest.webmanifest")
            .to_lowercase()
            .contains("application/manifest+json"),
        "a manifest served as the wrong type is ignored"
    );

    let (icon_status, _) = server.request("GET", "/icon.svg", "", "");
    assert!(is_ok(&icon_status), "{icon_status}");
}

#[test]
fn the_root_files_are_named_individually_rather_than_served_from_a_directory() {
    // The routes read one literal filename each. Nothing else beside an operator's bundle is
    // reachable through them, and there is no caller-supplied path component to escape with.
    let vault_dir = TempDir::new("http-pwa-scope-vault");
    vault_dir.write("One.md", "# One\n");
    let web_dir = pwa_web_root();
    let server = TestServer::authenticated_with_web_root(
        vec![vault(&vault_dir, "personal", "Personal")],
        web_dir.path().to_path_buf(),
    );

    for path in ["/secret.txt", "/index.html", "/sw.js/../secret.txt"] {
        assert!(is_not_found(&server.status(path)), "{path} was served");
    }
}

#[test]
fn a_server_with_no_frontend_build_serves_no_worker_at_all() {
    // The read-only server (`web_root` unset) is a complete deployment (§3.1). It has no
    // bundle to cache, and a worker registered against a 404 is a browser that keeps asking.
    let dir = TempDir::new("http-pwa-none");
    dir.write("One.md", "# One\n");
    let server = TestServer::authenticated(vec![vault(&dir, "personal", "Personal")]);

    for path in ["/app.html", "/sw.js", "/manifest.webmanifest", "/icon.svg"] {
        assert!(is_not_found(&server.status(path)), "{path} was served");
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
    dir.write(
        "Public.md",
        "---\nicon: 🧠\n---\n\n# The Public One\n\nBody.\n\n- [ ] Shared task\n",
    );
    dir.write("Untitled.md", "");
    dir.write(
        "Conflicted.md",
        "# Conflicted\n\nMine.\n\n> [!conflict] Conflicting version — external edit, now\n>\n> Theirs.\n",
    );
    dir.write(
        "Private/Salary.md",
        "# Salary Review\n\n- [ ] Secret compensation task\n",
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
    let route = "/api/v1/vaults/v/notes";

    // The owner sees everything, with titles taken from the note rather than the filename.
    let (status, body) = server.get_with_headers(route, &alice_header);
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("The Public One"), "{body}");
    assert!(body.contains("Salary Review"), "{body}");
    // A note with nothing titleable is listed with a null title, not omitted.
    assert!(body.contains("Untitled.md"), "{body}");
    // §3.5's badge travels with the summary, so the tree can show it without opening a note.
    assert!(
        body.contains(
            "\"path\":\"Conflicted.md\",\"title\":\"Conflicted\",\"icon\":null,\"conflicts\":1"
        ),
        "the conflict count must reach the tree: {body}"
    );
    assert!(
        body.contains(
            "\"path\":\"Public.md\",\"title\":\"The Public One\",\"icon\":\"🧠\",\"conflicts\":0"
        ),
        "the frontmatter icon should reach the note summary: {body}"
    );
    assert!(
        body.contains("Shared task"),
        "task metadata should be eager: {body}"
    );

    // The viewer denied `Private` sees neither the path nor the title.
    let (status, body) = server.get_with_headers(route, &bob_header);
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("Public.md"), "{body}");
    assert!(
        !body.contains("Salary"),
        "a denied note must not be named: {body}"
    );
    assert!(!body.contains("Private"), "nor its folder: {body}");
    assert!(
        !body.contains("Secret compensation task"),
        "nor its task text: {body}"
    );

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
fn the_json_api_is_compressed_for_a_client_that_asks() {
    // why: this was a documented gap rather than a known answer. The asset and note-page
    // cases pinned the two surfaces that existed when compression landed, so whether a JSON
    // route added a milestone later was compressed came down to whether its content type
    // happened to be on the allowlist — true today, and nothing said so. Both index-backed
    // routes are asserted, because "the one I remembered" is how the gap appeared.
    let dir = TempDir::new("http-compress-api");
    dir.write(
        "Target.md",
        &format!("# Target\n\n{}\n", "berries ".repeat(80)),
    );
    dir.write(
        "Source.md",
        &format!("# Source\n\n{} [[Target]]\n", "prose ".repeat(60)),
    );
    // Enough notes that the list itself clears the minimum-size floor; two notes do not,
    // and a route left uncompressed for being small is not the question this test asks.
    for n in 0..20 {
        dir.write(
            &format!("Filler/Note {n} with a long name.md"),
            "# Filler\n",
        );
    }
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    for route in [
        "/api/v1/vaults/v/backlinks/Target.md",
        "/api/v1/vaults/v/embed/Target?from=Source.md",
        "/api/v1/vaults/v/notes",
    ] {
        let (head, body) = server.get_raw(route, "Accept-Encoding: gzip\r\n");
        assert!(
            head.contains("content-encoding: gzip"),
            "{route} was not compressed: {head}"
        );
        assert!(head.contains("vary: accept-encoding"), "{route}: {head}");
        let decoded = String::from_utf8(gunzip(&body)).expect("json is utf-8");
        assert!(
            decoded.starts_with('{'),
            "{route} decoded to something that is not the JSON body: {decoded}"
        );
    }
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
fn the_backlinks_route_separates_unlinked_mentions_from_links() {
    // §9.5, over real HTTP: the two halves of the panel come from one request, and a note
    // that links here belongs to exactly one of them.
    let dir = TempDir::new("http-mentions");
    dir.write("Projects/Roadmap.md", "# Product Roadmap\n\nBody.\n");
    dir.write("Linked.md", "# Linked\n\nsee [[Projects/Roadmap]]\n");
    dir.write(
        "Mentions.md",
        "# Mentions\n\nThe Product Roadmap is agreed.\n",
    );
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, body) = server.get("/api/v1/vaults/v/backlinks/Projects/Roadmap.md");
    assert!(is_ok(&status), "{status}");
    let response: serde_json::Value = serde_json::from_str(&body).expect("json");
    let sources = response["sources"].as_array().expect("sources");
    let mentions = response["mentions"].as_array().expect("mentions");
    assert_eq!(sources.len(), 1, "{body}");
    assert_eq!(sources[0]["path"], "Linked.md", "{body}");
    assert_eq!(mentions.len(), 1, "{body}");
    assert_eq!(mentions[0]["path"], "Mentions.md", "{body}");
    assert_eq!(mentions[0]["title"], "Mentions", "{body}");
    assert_eq!(
        mentions[0]["contexts"][0], "The Product Roadmap is agreed.",
        "{body}"
    );
}

// ------------------------------------------------------------------------ graph

#[test]
fn the_local_graph_draws_the_neighbourhood_of_a_note() {
    // §9.4. One request, one picture: the origin, what it links to, what links to it, and
    // the edges between those — in the direction each link points.
    let dir = TempDir::new("http-graph");
    dir.write("Projects/Roadmap.md", "# Roadmap\n\nsee [[Q3]]\n");
    dir.write("Q3.md", "# Q3\n\nand ![[Notes]]\n");
    dir.write("Notes.md", "# Notes\n");
    dir.write("Inbound.md", "# Inbound\n\nlinks to [[Roadmap]]\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, body) = server.get("/api/v1/vaults/v/graph/Projects/Roadmap.md?hops=1");
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("\"note\":\"Projects/Roadmap.md\""), "{body}");
    assert!(body.contains("\"hops\":1"), "{body}");
    assert!(body.contains("\"key\":\"n:Q3.md\""), "{body}");
    assert!(body.contains("\"key\":\"n:Inbound.md\""), "{body}");
    assert!(
        !body.contains("n:Notes.md"),
        "a note two hops away is not in a one-hop graph: {body}"
    );
    assert!(
        body.contains("\"source\":\"n:Inbound.md\",\"target\":\"n:Projects/Roadmap.md\""),
        "an inbound edge keeps its direction: {body}"
    );
    assert!(body.contains("\"truncated\":false"), "{body}");
}

#[test]
fn a_second_hop_is_asked_for_by_the_query_string() {
    let dir = TempDir::new("http-graph-hops");
    dir.write("A.md", "# A\n\n[[B]]\n");
    dir.write("B.md", "# B\n\n[[C]]\n");
    dir.write("C.md", "# C\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (_, one) = server.get("/api/v1/vaults/v/graph/A.md?hops=1");
    assert!(!one.contains("n:C.md"), "{one}");
    let (status, two) = server.get("/api/v1/vaults/v/graph/A.md?hops=2");
    assert!(is_ok(&status), "{status}");
    assert!(two.contains("n:C.md"), "{two}");
    assert!(two.contains("\"hops\":2"), "{two}");
}

#[test]
fn an_out_of_range_hop_count_is_clamped_rather_than_refused() {
    // A sidebar control that sends a bad number should draw the nearest picture it can, and
    // the reply says which one it drew — the control shows that, not what it asked for.
    let dir = TempDir::new("http-graph-clamp");
    dir.write("A.md", "# A\n\n[[B]]\n");
    dir.write("B.md", "# B\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    for (asked, drawn) in [("0", 1), ("99", 3)] {
        let (status, body) = server.get(&format!("/api/v1/vaults/v/graph/A.md?hops={asked}"));
        assert!(is_ok(&status), "hops={asked}: {status}");
        assert!(
            body.contains(&format!("\"hops\":{drawn}")),
            "hops={asked}: {body}"
        );
    }
    // A number out of range is a control that needs clamping; a value that is not a number
    // is a caller nothing here sends, and gets told so rather than quietly drawn a picture.
    // `?hops=` is in the second group and not the first: an empty value is not an absent
    // one, and omitting the parameter is what a client does when it has nothing to say.
    for asked in ["lots", ""] {
        let (status, _) = server.get(&format!("/api/v1/vaults/v/graph/A.md?hops={asked}"));
        assert!(!is_ok(&status), "hops={asked}: {status}");
    }
}

#[test]
fn the_graph_defaults_to_one_hop_when_nothing_is_asked() {
    let dir = TempDir::new("http-graph-default");
    dir.write("A.md", "# A\n\n[[B]]\n");
    dir.write("B.md", "# B\n\n[[C]]\n");
    dir.write("C.md", "# C\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, body) = server.get("/api/v1/vaults/v/graph/A.md");
    assert!(is_ok(&status), "{status}");
    assert!(
        body.contains("\"hops\":1") && !body.contains("n:C.md"),
        "{body}"
    );
}

#[test]
fn the_graph_resolves_a_wikilink_name_to_the_note_it_means() {
    let dir = TempDir::new("http-graph-name");
    dir.write("Projects/Roadmap.md", "# Roadmap\n");
    dir.write("Q3.md", "see [[Roadmap]]\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    for route in [
        "/api/v1/vaults/v/graph/Projects/Roadmap.md",
        "/api/v1/vaults/v/graph/Roadmap",
        "/api/v1/vaults/v/graph/Projects%2FRoadmap.md",
    ] {
        let (status, body) = server.get(route);
        assert!(is_ok(&status), "{route}: {status}");
        assert!(
            body.contains("\"note\":\"Projects/Roadmap.md\"") && body.contains("n:Q3.md"),
            "{route}: {body}"
        );
    }
}

#[test]
fn a_link_to_a_note_nobody_wrote_is_a_ghost_node() {
    let dir = TempDir::new("http-graph-ghost");
    dir.write("A.md", "# A\n\n[[Someday]]\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, body) = server.get("/api/v1/vaults/v/graph/A.md");
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("\"key\":\"g:someday\""), "{body}");
    assert!(
        body.contains("\"path\":null"),
        "a ghost has no path: {body}"
    );
    assert!(body.contains("\"label\":\"Someday\""), "{body}");
}

#[test]
fn the_graph_names_only_notes_the_caller_can_read() {
    // E9, at the route. The index suite covers the query against hand-built policies; this
    // is the same point through a real `access.toml` and a real index.
    let dir = TempDir::new("http-graph-acl");
    dir.write("Projects/Roadmap.md", "# The Roadmap\n");
    dir.write("Public.md", "# Public\n\nsee [[Roadmap]]\n");
    dir.write("Private/Salary.md", "# Salary Review\n\nsee [[Roadmap]]\n");
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
    let route = "/api/v1/vaults/v/graph/Projects/Roadmap.md";

    let (status, body) = server.get_with_headers(route, &alice_header);
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("n:Private/Salary.md"), "{body}");

    let (status, body) = server.get_with_headers(route, &bob_header);
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("n:Public.md"), "{body}");
    assert!(!body.contains("Salary"), "a denied note was named: {body}");
    assert!(!body.contains("Private"), "nor its folder: {body}");

    // An origin bob cannot read answers the way a missing note does, and so do a non-member,
    // an anonymous caller and an unknown vault.
    let (status, body) =
        server.get_with_headers("/api/v1/vaults/v/graph/Private/Salary.md", &bob_header);
    assert!(is_not_found(&status), "{status}");
    assert!(!body.contains("Roadmap"), "{body}");
    let (status, _) = server.get_with_headers(route, &charlie_header);
    assert!(is_not_found(&status), "{status}");
    let (status, _) = server.request("GET", route, "", "");
    assert!(is_not_found(&status), "{status}");
    let (status, _) = server.get_with_headers(
        "/api/v1/vaults/nope/graph/Projects/Roadmap.md",
        &alice_header,
    );
    assert!(is_not_found(&status), "{status}");
}

#[test]
fn a_graph_is_never_cached() {
    // Note titles and the shape of somebody's vault. Nothing between here and the browser
    // should keep a copy, and a cached graph would outlive the permission that allowed it.
    let dir = TempDir::new("http-graph-cache");
    dir.write("A.md", "# A\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let headers = server.headers("/api/v1/vaults/v/graph/A.md");
    assert!(
        headers.to_lowercase().contains("cache-control: no-store"),
        "{headers}"
    );
}

#[test]
fn the_whole_vault_graph_draws_every_readable_note() {
    // §9.4's other half. No origin and no hops: every note is a node, including one nothing
    // links to, and the edges are indices into the node list rather than keys.
    let dir = TempDir::new("http-vault-graph");
    dir.write("Projects/Roadmap.md", "# Roadmap\n\nsee [[Q3]]\n");
    dir.write("Q3.md", "# Q3\n\nand ![[Nowhere]]\n");
    dir.write("Alone.md", "# Alone\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, body) = server.get("/api/v1/vaults/v/graph");
    assert!(is_ok(&status), "{status}");
    assert!(
        body.contains("\"total\":4"),
        "three notes and a ghost: {body}"
    );
    assert!(body.contains("\"truncated\":false"), "{body}");
    assert!(body.contains("\"key\":\"n:Alone.md\""), "{body}");
    assert!(body.contains("\"key\":\"g:nowhere\""), "{body}");
    // Sorted by key: g:nowhere, n:Alone.md, n:Projects/Roadmap.md, n:Q3.md. Roadmap links to
    // Q3 as a plain link, and Q3 embeds the ghost.
    assert!(
        body.contains("\"edges\":[2,3,0,3,0,1]"),
        "edges are index triples, embeds flagged: {body}"
    );
}

#[test]
fn a_whole_vault_node_carries_what_the_picture_is_drawn_from() {
    // Degree, word count, creation date and tags — §9.4 sizes, colours, filters and scrubs
    // by these, and all four have to survive the wire.
    let dir = TempDir::new("http-vault-graph-node");
    dir.write(
        "A.md",
        "---\ncreated: 2026-08-28\nicon: 🗺️\n---\n\n# A\n\n#project/mb one two [[B]]\n",
    );
    dir.write("B.md", "# B\n\nback to [[A]]\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, body) = server.get("/api/v1/vaults/v/graph");
    assert!(is_ok(&status), "{status}");
    assert!(
        body.contains(
            "{\"key\":\"n:A.md\",\"path\":\"A.md\",\"label\":\"A\",\"icon\":\"🗺️\",\
             \"degree\":2,\"words\":3,\"created\":\"2026-08-28\",\"tags\":[\"project/mb\"]}"
        ),
        "{body}"
    );
}

#[test]
fn the_whole_vault_graph_is_capped_by_the_query_string_and_says_so() {
    // §9.4's honest mobile cap: the client asks for a number of nodes, and the reply says
    // how many there were so the picture can print "showing 2 of 4".
    let dir = TempDir::new("http-vault-graph-cap");
    dir.write("Hub.md", "# Hub\n\n[[A]] [[B]] [[C]]\n");
    dir.write("A.md", "# A\n");
    dir.write("B.md", "# B\n");
    dir.write("C.md", "# C\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, body) = server.get("/api/v1/vaults/v/graph?limit=2");
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("\"total\":4"), "{body}");
    assert!(body.contains("\"truncated\":true"), "{body}");
    assert!(
        body.contains("\"key\":\"n:Hub.md\""),
        "the hub survives: {body}"
    );
    assert_eq!(
        body.matches("\"key\"").count(),
        2,
        "two nodes were asked for: {body}"
    );
}

#[test]
fn a_limit_that_is_not_a_number_is_refused_rather_than_guessed_at() {
    // The same answer the hop count gives: no client of ours sends this, and a server that
    // silently substituted a default would hide the bug in the one that did.
    let dir = TempDir::new("http-vault-graph-limit");
    dir.write("A.md", "# A\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    for asked in ["all", "-1", "2.5", ""] {
        let (status, _) = server.get(&format!("/api/v1/vaults/v/graph?limit={asked}"));
        assert!(!is_ok(&status), "limit={asked} was accepted: {status}");
    }
    let (status, _) = server.get("/api/v1/vaults/v/graph");
    assert!(is_ok(&status), "an absent limit is not a bad one: {status}");
}

#[test]
fn the_whole_vault_graph_names_only_notes_the_caller_can_read() {
    // E9 at the route, for the query with no origin: a non-member must not learn the vault
    // exists, and a member must not learn about a note they cannot read — including from
    // the count, which is over the readable set.
    let dir = TempDir::new("http-vault-graph-acl");
    dir.write("Public.md", "# Public\n\nsee [[Private/Salary]]\n");
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
    let route = "/api/v1/vaults/v/graph";

    let (status, body) = server.get_with_headers(route, &alice_header);
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("n:Private/Salary.md"), "{body}");
    assert!(body.contains("\"total\":2"), "{body}");

    let (status, body) = server.get_with_headers(route, &bob_header);
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("n:Public.md"), "{body}");
    assert!(!body.contains("Salary Review"), "a denied title: {body}");
    assert!(
        body.contains("\"total\":2"),
        "one note and the ghost its link becomes: {body}"
    );

    // A non-member, an anonymous caller and an unknown vault all answer the same way.
    let (status, _) = server.get_with_headers(route, &charlie_header);
    assert!(is_not_found(&status), "{status}");
    let (status, _) = server.request("GET", route, "", "");
    assert!(is_not_found(&status), "{status}");
    let (status, _) = server.get_with_headers("/api/v1/vaults/nope/graph", &alice_header);
    assert!(is_not_found(&status), "{status}");
}

#[test]
fn a_whole_vault_graph_is_never_cached() {
    let dir = TempDir::new("http-vault-graph-cache");
    dir.write("A.md", "# A\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let headers = server.headers("/api/v1/vaults/v/graph");
    assert!(
        headers.to_lowercase().contains("cache-control: no-store"),
        "{headers}"
    );
}

// ------------------------------------------------------------------------ search

// ------------------------------------------------------------------------- tasks

#[test]
fn task_inbox_filters_sorts_and_is_never_cached() {
    let dir = TempDir::new("http-tasks");
    dir.write(
        "Projects/Plan.md",
        "---\ntags: [work/shipping]\n---\n\n- [ ] Ship 📅 2026-09-10 ➕ 2026-09-01 ⏫ ^ship\n- [x] Done ✅ 2026-09-02\n",
    );
    dir.write(
        "Projects/Other.md",
        "---\ntags: [work]\n---\n\n- [ ] Lower priority 📅 2026-09-09 🔽\n",
    );
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);
    let route = "/api/v1/vaults/v/tasks?folder=Projects&tag=work&priority=high&due_from=2026-09-09&due_to=2026-09-11&sort=created";

    let (status, body) = server.get(route);
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("Projects/Plan.md"), "{body}");
    assert!(body.contains("\"block_id\":\"ship\""), "{body}");
    assert!(body.contains("\"priority\":\"high\""), "{body}");
    assert!(!body.contains("Lower priority"), "{body}");
    assert!(!body.contains("Done"), "{body}");
    assert!(
        server
            .headers(route)
            .to_lowercase()
            .contains("cache-control: no-store")
    );
}

#[test]
fn task_inbox_rejects_invalid_filter_values() {
    let dir = TempDir::new("http-tasks-invalid");
    dir.write("A.md", "- [ ] Task\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    for query in [
        "priority=urgent",
        "due_from=2026-02-30",
        "due_from=2026-09-11&due_to=2026-09-10",
        "sort=rank",
    ] {
        let (status, body) = server.get(&format!("/api/v1/vaults/v/tasks?{query}"));
        assert!(status.contains("400"), "{query}: {status}");
        assert!(body.contains("error"), "{query}: {body}");
    }
}

#[test]
fn search_returns_matched_block_context_and_is_never_cached() {
    let dir = TempDir::new("http-search");
    dir.write(
        "Projects/Roadmap.md",
        "# Product Roadmap\n\nThe orchard release ships Friday.\n",
    );
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, body) = server.get("/api/v1/vaults/v/search?q=orchard");
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("Projects/Roadmap.md"), "{body}");
    assert!(
        body.contains("The orchard release ships Friday."),
        "the matched block is the context: {body}"
    );
    assert!(
        server
            .headers("/api/v1/vaults/v/search?q=orchard")
            .to_lowercase()
            .contains("cache-control: no-store")
    );
}

#[test]
fn client_search_manifest_and_segments_are_acl_filtered_and_never_cached() {
    let dir = TempDir::new("http-client-search-segments");
    dir.write("Shared.md", "# Visible Canary\n\nordinary text\n");
    dir.write(
        "Private/Salary.md",
        "# Forbidden Canary\n\nclassified salary\n",
    );
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, manifest) = server.get("/api/v1/vaults/v/search/segments");
    assert!(is_ok(&status), "{status}");
    let manifest: serde_json::Value = serde_json::from_str(&manifest).expect("manifest JSON");
    let segments = manifest["segments"].as_array().expect("segments array");
    assert_eq!(segments.len(), 1, "the owner has one root zone");
    let zone_id = segments[0]["zoneId"].as_str().expect("zone ID");
    let acl_hash = segments[0]["aclHash"].as_str().expect("ACL hash");

    let route = format!("/api/v1/vaults/v/search/segments/{zone_id}?acl_hash={acl_hash}");
    let (head, bytes) = server.get_raw(&route, "");
    assert!(head.contains("200"), "{head}");
    assert!(head.contains("cache-control: no-store"), "{head}");
    assert!(
        head.contains("application/vnd.memberberry.search-index;version=1"),
        "{head}"
    );
    assert!(
        bytes
            .windows(b"Visible Canary".len())
            .any(|window| window == b"Visible Canary")
    );
    assert!(
        bytes
            .windows(b"Forbidden Canary".len())
            .any(|window| window == b"Forbidden Canary")
    );

    let (status, _) = server.get(&format!(
        "/api/v1/vaults/v/search/segments/{zone_id}?acl_hash=not-the-current-epoch"
    ));
    assert!(
        is_not_found(&status),
        "a stale manifest must not retrieve bytes: {status}"
    );
}

#[test]
fn search_names_only_notes_the_caller_can_read() {
    let dir = TempDir::new("http-search-acl");
    dir.write("Public.md", "ordinary visible words\n");
    dir.write("Private/Salary.md", "The canary salary is private.\n");
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
    let header = |id| {
        let token = auth.create_session(id, 4_102_444_800).expect("session");
        format!(
            "Cookie: mb_session={}\r\n",
            auth.signed_session_cookie(&token).expect("sign cookie")
        )
    };
    let alice_header = header(alice.id);
    let bob_header = header(bob.id);
    let state = AppState::authenticated(vec![vault(&dir, "v", "V")], auth).expect("state");
    let server = TestServer::start(state);
    let route = "/api/v1/vaults/v/search?q=canary";

    let (status, body) = server.get_with_headers(route, &alice_header);
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("Salary.md"), "{body}");

    let (status, body) = server.get_with_headers(route, &bob_header);
    assert!(is_ok(&status), "{status}");
    assert_eq!(body, "{\"hits\":[]}");
}

#[test]
fn malformed_search_syntax_is_a_bounded_client_error() {
    let dir = TempDir::new("http-search-invalid");
    dir.write("A.md", "some words\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, body) = server.get("/api/v1/vaults/v/search?q=title%3A%28");
    assert!(status.contains("400"), "{status}");
    assert!(body.contains("error"), "{body}");
}

#[test]
fn search_follows_an_external_edit_on_the_next_index_tick() {
    let dir = TempDir::new("http-search-edit");
    dir.write("A.md", "beforeword\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);
    assert!(
        server
            .get("/api/v1/vaults/v/search?q=afterword")
            .1
            .contains("\"hits\":[]")
    );

    dir.write("A.md", "afterword with a changed length\n");
    server.tick();
    let (_, body) = server.get("/api/v1/vaults/v/search?q=afterword");
    assert!(body.contains("A.md"), "{body}");
    assert!(
        !body.contains("beforeword"),
        "stale context survived: {body}"
    );
}

// ------------------------------------------------------------------------ tags

#[test]
fn the_tag_tree_counts_every_prefix_of_a_nested_tag() {
    // §9.3: `#project/memberberry/spec` is one tag with three nodes, and a parent counts the
    // notes tagged beneath it.
    let dir = TempDir::new("http-tags-nested");
    dir.write("A.md", "# A\n\n#project/memberberry/spec\n");
    dir.write("B.md", "# B\n\n#project/other\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, body) = server.get("/api/v1/vaults/v/tags");
    assert!(is_ok(&status), "{status}");
    assert!(
        body.contains("{\"tag\":\"project\",\"key\":\"project\",\"notes\":2}"),
        "the parent counts both notes: {body}"
    );
    assert!(
        body.contains("\"key\":\"project/memberberry\",\"notes\":1"),
        "{body}"
    );
    assert!(
        body.contains("\"key\":\"project/memberberry/spec\",\"notes\":1"),
        "{body}"
    );
}

#[test]
fn tags_name_only_what_the_caller_can_read() {
    // E16. A tag row is a claim about how many notes exist — a tag carried only by a note
    // bob cannot read must not appear at all, and one he shares must count only his notes.
    let dir = TempDir::new("http-tags-acl");
    dir.write("Public.md", "# Public\n\n#shared\n");
    dir.write("Private/Salary.md", "# Salary\n\n#shared #compensation\n");
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

    let (status, body) = server.get_with_headers("/api/v1/vaults/v/tags", &alice_header);
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("\"key\":\"shared\",\"notes\":2"), "{body}");
    assert!(body.contains("compensation"), "{body}");

    let (status, body) = server.get_with_headers("/api/v1/vaults/v/tags", &bob_header);
    assert!(is_ok(&status), "{status}");
    assert!(
        body.contains("\"key\":\"shared\",\"notes\":1"),
        "the private note was counted: {body}"
    );
    assert!(
        !body.contains("compensation"),
        "a tag only the private note carries was named: {body}"
    );

    // Nor may the notes route name it, whichever tag is asked for.
    let (status, body) = server.get_with_headers("/api/v1/vaults/v/tags/shared", &bob_header);
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("Public.md"), "{body}");
    assert!(!body.contains("Salary"), "{body}");
    let (status, body) = server.get_with_headers("/api/v1/vaults/v/tags/compensation", &bob_header);
    assert!(is_ok(&status), "{status}");
    assert!(
        !body.contains("Salary") && !body.contains("Private"),
        "an unreadable note answered a tag query: {body}"
    );

    // A non-member, an anonymous caller and an unknown vault are one answer.
    for (route, headers) in [
        ("/api/v1/vaults/v/tags", charlie_header.as_str()),
        ("/api/v1/vaults/v/tags/shared", charlie_header.as_str()),
        ("/api/v1/vaults/nope/tags", alice_header.as_str()),
    ] {
        let (status, body) = server.get_with_headers(route, headers);
        assert!(is_not_found(&status), "{route}: {status}");
        assert!(!body.contains("shared"), "{route}: {body}");
    }
    let (status, _) = server.request("GET", "/api/v1/vaults/v/tags", "", "");
    assert!(is_not_found(&status), "{status}");
}

#[test]
fn selecting_a_tag_lists_the_notes_nested_under_it() {
    let dir = TempDir::new("http-tags-notes");
    dir.write("A.md", "# The A Note\n\n#project/memberberry\n");
    dir.write("B.md", "# B\n\n#unrelated\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, body) = server.get("/api/v1/vaults/v/tags/project");
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("\"path\":\"A.md\""), "{body}");
    assert!(body.contains("The A Note"), "the title travels: {body}");
    assert!(!body.contains("B.md"), "{body}");
}

#[test]
fn a_nested_tag_is_asked_for_with_a_slash_encoded_or_not() {
    // why: asserted rather than assumed, exactly as for a note path. A client reaching for
    // `encodeURIComponent` on the whole tag sends `%2F`, and a wrong guess here is an empty
    // pane rather than an error.
    let dir = TempDir::new("http-tags-encoded");
    dir.write("A.md", "# A\n\n#project/memberberry\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    for route in [
        "/api/v1/vaults/v/tags/project/memberberry",
        "/api/v1/vaults/v/tags/project%2Fmemberberry",
        "/api/v1/vaults/v/tags/Project",
    ] {
        let (status, body) = server.get(route);
        assert!(is_ok(&status), "{route}: {status}");
        assert!(body.contains("A.md"), "{route}: {body}");
    }
}

#[test]
fn tags_follow_an_edit_made_outside_the_application() {
    // C2 and §3.4: a tag added in Obsidian reaches the pane through the maintenance tick.
    let dir = TempDir::new("http-tags-edit");
    dir.write("A.md", "# A\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, body) = server.get("/api/v1/vaults/v/tags");
    assert!(is_ok(&status), "{status}");
    assert!(!body.contains("later"), "{body}");

    dir.write("A.md", "# A\n\n#later\n");
    server.tick();

    let (_, body) = server.get("/api/v1/vaults/v/tags");
    assert!(body.contains("\"key\":\"later\""), "{body}");
}

#[test]
fn tags_are_never_cached() {
    // Counts and note titles, filtered per user. A shared cache would serve one user's
    // filtered view to another.
    let dir = TempDir::new("http-tags-cache");
    dir.write("A.md", "# A\n\n#tag\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);
    for route in ["/api/v1/vaults/v/tags", "/api/v1/vaults/v/tags/tag"] {
        let headers = server.headers(route).to_lowercase();
        assert!(
            headers.contains("cache-control: no-store"),
            "{route}: {headers}"
        );
    }
}

// ---------------------------------------------------------------- transclusion

/// A vault with two same-named notes, a section, and an anchored block.
fn embed_vault(label: &str) -> TempDir {
    let dir = TempDir::new(label);
    dir.write(
        "Projects/Roadmap.md",
        "# The Plan\n\nShip it.\n\n## Risks\n\nTime. ^risk\n\n## Later\n\nMore.\n",
    );
    dir.write("Archive/Roadmap.md", "# The Old Plan\n\nShipped.\n");
    dir.write("Projects/Q3.md", "quarter: ![[Roadmap]]\n");
    dir
}

#[test]
fn an_embed_renders_the_note_the_reference_resolves_to() {
    let dir = embed_vault("http-embed");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, body) = server.get("/api/v1/vaults/v/embed/Roadmap?from=Projects/Q3.md");
    assert!(is_ok(&status), "{status}");
    assert!(
        body.contains("\"note\":\"Projects/Roadmap.md\""),
        "the canonical identity, so the client can compare it against its stack: {body}"
    );
    assert!(body.contains("\"title\":\"The Plan\""), "{body}");
    assert!(body.contains("\"found\":true"), "{body}");
    assert!(body.contains("Ship it."), "{body}");
    assert!(body.contains("<h1>The Plan</h1>"), "{body}");
}

#[test]
fn an_embed_resolves_by_nearest_path_from_the_note_it_is_written_in() {
    // §4.3 through the route: the same reference means a different note read from a
    // different folder, and the *client* does not get to say which — it says where it is.
    let dir = embed_vault("http-embed-nearest");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (_, near) = server.get("/api/v1/vaults/v/embed/Roadmap?from=Projects/Q3.md");
    assert!(near.contains("\"note\":\"Projects/Roadmap.md\""), "{near}");
    let (_, far) = server.get("/api/v1/vaults/v/embed/Roadmap?from=Archive/Roadmap.md");
    assert!(far.contains("\"note\":\"Archive/Roadmap.md\""), "{far}");
}

#[test]
fn an_embed_of_a_heading_carries_only_that_section() {
    let dir = embed_vault("http-embed-heading");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, body) = server
        .get("/api/v1/vaults/v/embed/Roadmap?from=Projects/Q3.md&anchor_kind=heading&anchor=Risks");
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("\"found\":true"), "{body}");
    assert!(body.contains("Risks"), "{body}");
    assert!(body.contains("Time."), "{body}");
    assert!(!body.contains("Ship it."), "the section above it: {body}");
    assert!(!body.contains("More."), "the section below it: {body}");
}

#[test]
fn an_embed_of_a_block_carries_only_that_block() {
    let dir = embed_vault("http-embed-block");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, body) = server
        .get("/api/v1/vaults/v/embed/Roadmap?from=Projects/Q3.md&anchor_kind=block&anchor=risk");
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("Time."), "{body}");
    assert!(!body.contains("Risks"), "not even its own heading: {body}");
    assert!(!body.contains("Ship it."), "{body}");
}

#[test]
fn an_embed_of_an_absent_anchor_says_it_found_nothing() {
    // Not a permission boundary: the note is readable, it simply has no such section. That
    // is a different thing to show than an empty note, and reporting it as one would be a
    // claim nobody checked (§9.5).
    let dir = embed_vault("http-embed-no-anchor");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, body) = server
        .get("/api/v1/vaults/v/embed/Roadmap?from=Projects/Q3.md&anchor_kind=heading&anchor=Nope");
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("\"found\":false"), "{body}");
    assert!(body.contains("\"html\":\"\""), "{body}");
    assert!(
        body.contains("\"note\":\"Projects/Roadmap.md\""),
        "the note still resolved, so the client can still offer to jump to it: {body}"
    );
}

#[test]
fn an_embed_of_a_missing_note_answers_empty_handed() {
    let dir = embed_vault("http-embed-missing");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, body) = server.get("/api/v1/vaults/v/embed/Absent?from=Projects/Q3.md");
    assert!(
        is_not_found(&status),
        "a missing target answers as an unreadable one does (§6.5): {status}"
    );
    assert_eq!(body, "{}");
}

#[test]
fn an_embed_cannot_resolve_from_a_note_the_caller_cannot_read() {
    // `from` steers name resolution, so it is not a free parameter: without this check a
    // caller could ask what `[[Roadmap]]` means *inside a folder they have no access to*,
    // and learn from the answer which notes live there.
    let dir = TempDir::new("http-embed-from");
    dir.write("Public.md", "# Public\n");
    dir.write("Private/Q3.md", "# Q3\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n\n\
         [[rules]]\npath = \"Private\"\ngrant = { alice = \"none\" }\n",
    );
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, _) = server.get("/api/v1/vaults/v/embed/Public?from=Private/Q3.md");
    assert!(is_not_found(&status), "{status}");
    let (status, _) = server.get("/api/v1/vaults/v/embed/Public?from=Public.md");
    assert!(is_ok(&status), "the readable case still works: {status}");
}

#[test]
fn an_embed_needs_a_from_note_at_all() {
    let dir = embed_vault("http-embed-no-from");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, _) = server.get("/api/v1/vaults/v/embed/Roadmap");
    assert!(
        !is_ok(&status),
        "resolution is relative to a note; there is no vault-wide default: {status}"
    );
}

#[test]
fn an_embed_rejects_an_anchor_pair_that_cannot_exist() {
    // `schema.json` requires `none` to carry no anchor text and every other kind to carry
    // some. A request that breaks that is a probe or a client bug, not a state to guess at.
    let dir = embed_vault("http-embed-bad-anchor");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);
    for query in [
        "anchor_kind=heading&anchor=",
        "anchor_kind=block&anchor=",
        "anchor_kind=none&anchor=Risks",
        "anchor_kind=nonsense&anchor=Risks",
    ] {
        let (status, _) = server.get(&format!(
            "/api/v1/vaults/v/embed/Roadmap?from=Projects/Q3.md&{query}"
        ));
        assert!(is_not_found(&status), "{query} was accepted: {status}");
    }
}

#[test]
fn an_embed_marks_a_nested_transclusion_for_the_client_to_mount() {
    // The recursion is the client's: §9.2's resolution stack lives with whatever mounts one
    // embed inside another, and this route answers for one reference only. What makes that
    // possible is that a nested `![[…]]` arrives as a findable element rather than as text.
    let dir = TempDir::new("http-embed-nested");
    dir.write("Outer.md", "# Outer\n\n![[Inner]]\n");
    dir.write("Inner.md", "# Inner\n\ndeep\n");
    dir.write("Host.md", "![[Outer]]\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, body) = server.get("/api/v1/vaults/v/embed/Outer?from=Host.md");
    assert!(is_ok(&status), "{status}");
    assert!(
        body.contains("data-embed=\\\"true\\\""),
        "a nested embed has to be findable in the fragment: {body}"
    );
    assert!(
        !body.contains("deep"),
        "and unexpanded — one request answers for one reference: {body}"
    );
}

#[test]
fn an_embed_escapes_the_note_it_renders() {
    // The fragment goes into a page as markup, and a note is not trusted input: anyone who
    // can write a file into the vault would otherwise be writing script into every note
    // that embeds it.
    let dir = TempDir::new("http-embed-escape");
    dir.write("Nasty.md", "# T\n\n<script>alert(1)</script>\n");
    dir.write("Host.md", "![[Nasty]]\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, body) = server.get("/api/v1/vaults/v/embed/Nasty?from=Host.md");
    assert!(is_ok(&status), "{status}");
    assert!(!body.contains("<script>"), "{body}");
    assert!(body.contains("&lt;script&gt;"), "{body}");
}

#[test]
fn an_embed_of_an_unreadable_note_answers_exactly_as_a_missing_one() {
    // E7 through the route. Two callers, one reference, one name: the owner gets the note,
    // the denied viewer gets the same empty-handed reply a reference to nothing gets — no
    // title, no path, no error text that would confirm the note is there.
    let dir = TempDir::new("http-embed-leak");
    dir.write("Private/Salary.md", "# Salary Review\n\nBudget is set.\n");
    dir.write("Host.md", "![[Salary]]\n");
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
    let header = |id| {
        let token = auth.create_session(id, 4_102_444_800).expect("session");
        format!(
            "Cookie: mb_session={}\r\n",
            auth.signed_session_cookie(&token).expect("sign cookie")
        )
    };
    let alice_header = header(alice.id);
    let bob_header = header(bob.id);
    let state = AppState::authenticated(vec![vault(&dir, "v", "V")], auth).expect("secure state");
    let server = TestServer::start(state);
    let route = "/api/v1/vaults/v/embed/Salary?from=Host.md";

    let (status, body) = server.get_with_headers(route, &alice_header);
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("Budget is set."), "{body}");

    let (denied_status, denied_body) = server.get_with_headers(route, &bob_header);
    assert!(is_not_found(&denied_status), "{denied_status}");
    for leak in ["Salary", "Private", "Budget", "Review"] {
        assert!(
            !denied_body.contains(leak),
            "the denial named `{leak}`: {denied_body}"
        );
    }
    let (missing_status, missing_body) =
        server.get_with_headers("/api/v1/vaults/v/embed/Never?from=Host.md", &bob_header);
    assert_eq!(
        (denied_status, denied_body),
        (missing_status, missing_body),
        "an unreadable target and a missing one must be one answer (§6.5)"
    );
}

#[test]
fn an_embed_of_a_note_deleted_since_the_last_sweep_answers_empty_handed() {
    // Why the read goes back through the repository rather than straight to the filesystem:
    // the index says which note a name means, and it can be a sweep behind the vault. A
    // reference to a note that is no longer there has to answer as any other reference to
    // nothing does, rather than as a server error.
    let dir = TempDir::new("http-embed-deleted");
    dir.write("Target.md", "# T\n\nbody\n");
    dir.write("Host.md", "![[Target]]\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);
    let route = "/api/v1/vaults/v/embed/Target?from=Host.md";
    let (status, _) = server.get(route);
    assert!(is_ok(&status), "{status}");

    std::fs::remove_file(dir.path().join("Target.md")).expect("delete the note");
    let (status, body) = server.get(route);
    assert!(is_not_found(&status), "{status}");
    assert_eq!(body, "{}");
}

#[test]
fn embeds_accept_a_target_with_its_separators_encoded() {
    // The client percent-encodes the whole target rather than segment by segment, because a
    // wikilink target is note text and `../secrets` left as a path segment is normalised by
    // the browser before the request is sent. That only works if `%2F` still routes, so it
    // is pinned here rather than assumed — `web/src/editor/embed.ts` names this test.
    let dir = embed_vault("http-embed-encoded");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, body) =
        server.get("/api/v1/vaults/v/embed/Projects%2FRoadmap?from=Projects%2FQ3.md");
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("\"note\":\"Projects/Roadmap.md\""), "{body}");
}

#[test]
fn an_embed_is_never_cached() {
    // Note content, filtered per user, and an embed outlives nothing: a cached one would
    // still be served after the permission that allowed it was revoked.
    let dir = embed_vault("http-embed-cache");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);
    let headers = server
        .headers("/api/v1/vaults/v/embed/Roadmap?from=Projects/Q3.md")
        .to_lowercase();
    assert!(headers.contains("cache-control: no-store"), "{headers}");
}

#[test]
fn an_embed_follows_an_edit_made_outside_the_application() {
    // Resolved at render time, never at storage time (§9.2): the embed shows what the file
    // says now, including after an edit made in another editor.
    let dir = TempDir::new("http-embed-edit");
    dir.write("Target.md", "# T\n\nbefore\n");
    dir.write("Host.md", "![[Target]]\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);
    let route = "/api/v1/vaults/v/embed/Target?from=Host.md";

    let (_, body) = server.get(route);
    assert!(body.contains("before"), "{body}");
    dir.write("Target.md", "# T\n\nafter\n");
    let (_, body) = server.get(route);
    assert!(
        body.contains("after") && !body.contains("before"),
        "no tick needed: the content comes from the file, not the index: {body}"
    );
}

// ---------------------------------------------------------------- link resolution

#[test]
fn resolving_a_reference_answers_the_note_it_means() {
    // Following a wikilink needs the canonical identity, not the name it was written by: a
    // tab keyed on `Roadmap` and a tab keyed on `Projects/Roadmap.md` are two tabs for one
    // note, and only one of them matches what the sync room is named.
    let dir = embed_vault("http-resolve");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, body) = server.get("/api/v1/vaults/v/resolve/Roadmap?from=Projects/Q3.md");
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("\"note\":\"Projects/Roadmap.md\""), "{body}");
    assert!(body.contains("\"title\":\"The Plan\""), "{body}");
    assert!(
        !body.contains("Ship it."),
        "the content is the embed route's job, not this one's: {body}"
    );
}

#[test]
fn resolving_a_reference_is_relative_to_the_note_it_was_written_in() {
    let dir = embed_vault("http-resolve-nearest");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (_, near) = server.get("/api/v1/vaults/v/resolve/Roadmap?from=Projects/Q3.md");
    assert!(near.contains("Projects/Roadmap.md"), "{near}");
    let (_, far) = server.get("/api/v1/vaults/v/resolve/Roadmap?from=Archive/Roadmap.md");
    assert!(far.contains("Archive/Roadmap.md"), "{far}");
}

#[test]
fn resolving_a_reference_to_nothing_answers_empty_handed() {
    let dir = embed_vault("http-resolve-missing");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    for route in [
        "/api/v1/vaults/v/resolve/Absent?from=Projects/Q3.md",
        "/api/v1/vaults/v/resolve/Roadmap?from=Nowhere.md",
        "/api/v1/vaults/nope/resolve/Roadmap?from=Projects/Q3.md",
    ] {
        let (status, body) = server.get(route);
        assert!(is_not_found(&status), "{route}: {status}");
        assert_eq!(body, "{}", "{route}");
    }
}

#[test]
fn resolving_a_reference_to_an_unreadable_note_answers_as_a_missing_one() {
    // E7/E9 for the navigation path. A link that resolves for one user and not for another
    // is §9.1's per-user resolution, and the denial must not say which of the two it is.
    let dir = TempDir::new("http-resolve-leak");
    dir.write("Private/Salary.md", "# Salary Review\n");
    dir.write("Host.md", "see [[Salary]]\n");
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
    let header = |id| {
        let token = auth.create_session(id, 4_102_444_800).expect("session");
        format!(
            "Cookie: mb_session={}\r\n",
            auth.signed_session_cookie(&token).expect("sign cookie")
        )
    };
    let alice_header = header(alice.id);
    let bob_header = header(bob.id);
    let state = AppState::authenticated(vec![vault(&dir, "v", "V")], auth).expect("secure state");
    let server = TestServer::start(state);
    let route = "/api/v1/vaults/v/resolve/Salary?from=Host.md";

    let (status, body) = server.get_with_headers(route, &alice_header);
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("Private/Salary.md"), "{body}");

    let (denied_status, denied_body) = server.get_with_headers(route, &bob_header);
    assert!(is_not_found(&denied_status), "{denied_status}");
    for leak in ["Salary", "Private", "Review"] {
        assert!(!denied_body.contains(leak), "the denial named `{leak}`");
    }
    let (missing_status, missing_body) =
        server.get_with_headers("/api/v1/vaults/v/resolve/Never?from=Host.md", &bob_header);
    assert_eq!((denied_status, denied_body), (missing_status, missing_body));
}

#[test]
fn resolving_a_reference_is_never_cached() {
    let dir = embed_vault("http-resolve-cache");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);
    let headers = server
        .headers("/api/v1/vaults/v/resolve/Roadmap?from=Projects/Q3.md")
        .to_lowercase();
    assert!(headers.contains("cache-control: no-store"), "{headers}");
}

#[test]
fn backlinks_are_never_cached() {
    // Note titles and note text, filtered per user. A shared cache would serve one user's
    // filtered view to another — and since §9.5's unlinked mentions ride this same response,
    // it would serve whole sentences out of notes the second user cannot read.
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

// ---------------------------------------------------------------------- rename

#[test]
fn renaming_a_note_over_http_moves_it_and_repoints_its_links() {
    let dir = TempDir::new("http-rename");
    dir.write("Roadmap.md", "# Roadmap\n");
    dir.write("One.md", "See [[Roadmap]].\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, body) = server.post_json(
        "/api/v1/vaults/v/rename",
        "",
        r#"{"kind":"note","from":"Roadmap.md","to":"Plan.md"}"#,
    );
    assert!(is_ok(&status), "{status} {body}");
    assert!(body.contains("\"to\":\"Plan.md\""), "{body}");
    assert!(body.contains("\"notes\":1"), "{body}");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("One.md")).expect("One.md"),
        "See [[Plan]].\n"
    );
    // The route sweeps the index itself, so the very next request already agrees.
    let (_, body) = server.get("/api/v1/vaults/v/backlinks/Plan.md");
    assert!(body.contains("One.md"), "{body}");
}

#[test]
fn renaming_a_tag_over_http_rewrites_the_notes_that_carry_it() {
    let dir = TempDir::new("http-rename-tag");
    dir.write("One.md", "A #project/mb note.\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, body) = server.post_json(
        "/api/v1/vaults/v/rename",
        "",
        r#"{"kind":"tag","from":"project","to":"work"}"#,
    );
    assert!(is_ok(&status), "{status} {body}");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("One.md")).expect("One.md"),
        "A #work/mb note.\n"
    );
    let (_, body) = server.get("/api/v1/vaults/v/tags");
    assert!(body.contains("work/mb"), "{body}");
    assert!(!body.contains("project"), "{body}");
}

#[test]
fn a_rename_a_caller_may_not_do_answers_exactly_as_an_unknown_vault_does() {
    // E14 and §6.5. Four probes that differ in every way an attacker cares about — a note
    // that is there but unreadable, one that is not there, a vault this caller is not in,
    // and a vault that does not exist — and one indistinguishable reply.
    let dir = TempDir::new("http-rename-denied");
    dir.write("Private/Salary.md", "# Salary\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n\n\
         [[members]]\nuser = \"bob\"\nrole = \"editor\"\n\n\
         [[rules]]\npath = \"Private\"\ngrant = { bob = \"none\" }\n",
    );
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth db");
    auth.setup_first_user(mb_auth::NewUser {
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
        .expect("editor");
    let token = auth.create_session(bob.id, 4_102_444_800).expect("session");
    let bob_header = format!(
        "Cookie: mb_session={}\r\n",
        auth.signed_session_cookie(&token).expect("sign cookie")
    );
    let state = AppState::authenticated(vec![vault(&dir, "v", "V")], auth).expect("secure state");
    let server = TestServer::start(state);

    let probes = [
        (
            "/api/v1/vaults/v/rename",
            r#"{"kind":"note","from":"Private/Salary.md","to":"Pay.md"}"#,
        ),
        (
            "/api/v1/vaults/v/rename",
            r#"{"kind":"note","from":"Private/Absent.md","to":"Pay.md"}"#,
        ),
        (
            "/api/v1/vaults/nope/rename",
            r#"{"kind":"note","from":"A.md","to":"B.md"}"#,
        ),
        (
            "/api/v1/vaults/v/rename",
            r#"{"kind":"tag","from":"anything","to":"work"}"#,
        ),
    ];
    for (route, payload) in probes {
        let (status, body) = server.post_json(route, &bob_header, payload);
        assert!(status.contains("404"), "{route} answered {status}");
        assert_eq!(body, "{}", "{route} said more than nothing: {body}");
    }
    assert!(
        dir.path().join("Private/Salary.md").exists(),
        "no probe may move a note"
    );
}

#[test]
fn an_unauthenticated_rename_is_refused() {
    let dir = TempDir::new("http-rename-anon");
    dir.write("Roadmap.md", "# Roadmap\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);
    let payload = r#"{"kind":"note","from":"Roadmap.md","to":"P.md"}"#;
    // `request` rather than `post_json`, because this one must carry no session cookie.
    let (status, _) = server.request(
        "POST",
        "/api/v1/vaults/v/rename",
        &format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            payload.len()
        ),
        payload,
    );
    assert!(status.contains("404"), "{status}");
    assert!(dir.path().join("Roadmap.md").exists());
}

#[test]
fn a_rename_onto_an_existing_note_reports_what_the_caller_asked_for() {
    // The only detail a refusal may repeat is the name the caller sent, which they already
    // know. That is what separates this 400 from the 404 above.
    let dir = TempDir::new("http-rename-conflict");
    dir.write("Roadmap.md", "# Roadmap\n");
    dir.write("Plan.md", "# Plan\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, body) = server.post_json(
        "/api/v1/vaults/v/rename",
        "",
        r#"{"kind":"note","from":"Roadmap.md","to":"Plan.md"}"#,
    );
    assert!(status.contains("400"), "{status} {body}");
    assert!(body.contains("Plan.md"), "{body}");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("Plan.md")).expect("Plan.md"),
        "# Plan\n"
    );
}

#[test]
fn a_rename_body_that_is_not_a_rename_is_refused_without_touching_the_vault() {
    let dir = TempDir::new("http-rename-garbage");
    dir.write("Roadmap.md", "# Roadmap\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);
    for payload in [
        "{}",
        r#"{"kind":"folder","from":"a","to":"b"}"#,
        r#"{"kind":"note","from":"Roadmap.md"}"#,
        "not json at all",
    ] {
        let (status, _) = server.post_json("/api/v1/vaults/v/rename", "", payload);
        assert!(
            status.contains("400") || status.contains("422"),
            "{payload} answered {status}"
        );
    }
    assert!(dir.path().join("Roadmap.md").exists());
}

// ---------------------------------------------------------------- note creation (§6.10)

#[test]
fn creating_a_note_over_the_api_writes_markdown_and_reports_where() {
    let dir = TempDir::new("http-create");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, body) = server.post_json(
        "/api/v1/vaults/v/notes",
        "",
        r#"{"path":"Projects/Plan.md"}"#,
    );

    assert!(is_ok(&status), "{status} {body}");
    assert!(body.contains("Projects/Plan.md"), "{body}");
    // C2: the note is a Markdown file, not a row somewhere.
    assert_eq!(
        std::fs::read_to_string(dir.path().join("Projects/Plan.md")).expect("the new note"),
        "# Plan\n"
    );
}

#[test]
fn a_created_note_is_in_the_note_index_on_the_very_next_request() {
    let dir = TempDir::new("http-create-indexed");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, _) = server.post_json("/api/v1/vaults/v/notes", "", r#"{"path":"Fresh.md"}"#);
    assert!(is_ok(&status));

    // No `tick()`: the route sweeps for itself, so a client that creates and then lists does
    // not see a vault that has forgotten what it just did.
    let (_, body) = server.get("/api/v1/vaults/v/notes");
    assert!(body.contains("Fresh.md"), "{body}");
}

#[test]
fn daily_index_reports_configured_readable_dates_only() {
    let dir = TempDir::new("http-daily");
    dir.write(
        ".memberberry/config.toml",
        "daily_folder = \"Journal\"\ndaily_note_format = \"%d-%m-%Y.md\"\n\
         weekly_folder = \"Periods/Weeks\"\nweekly_note_format = \"%G/week-%V.md\"\n\
         monthly_folder = \"Periods/Months\"\nmonthly_note_format = \"%Y/%m.md\"\n",
    );
    dir.write("Journal/08-09-2026.md", "# Public day\n");
    dir.write("Journal/09-09-2026.md", "# Private day\n");
    dir.write("Periods/Weeks/2026/week-37.md", "# Public week\n");
    dir.write("Periods/Weeks/2026/week-38.md", "# Private week\n");
    dir.write("Periods/Months/2026/09.md", "# Public month\n");
    dir.write("Periods/Months/2026/10.md", "# Private month\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n\n\
         [[rules]]\npath = \"Journal/09-09-2026.md\"\n[rules.grant]\nalice = \"none\"\n\n\
         [[rules]]\npath = \"Periods/Weeks/2026/week-38.md\"\n[rules.grant]\nalice = \"none\"\n\n\
         [[rules]]\npath = \"Periods/Months/2026/10.md\"\n[rules.grant]\nalice = \"none\"\n",
    );
    let server = TestServer::authenticated(vec![
        Vault::open(Slug::parse("v").expect("slug"), "V", dir.path()).expect("open"),
    ]);

    let (status, body) = server.get("/api/v1/vaults/v/daily");

    assert!(is_ok(&status), "{status} {body}");
    assert!(body.contains("\"folder\":\"Journal\""), "{body}");
    assert!(body.contains("\"date\":\"2026-09-08\""), "{body}");
    assert!(!body.contains("2026-09-09"), "{body}");
    assert!(body.contains("Periods/Weeks/2026/week-37.md"), "{body}");
    assert!(body.contains("Periods/Months/2026/09.md"), "{body}");
    assert!(!body.contains("week-38"), "{body}");
    assert!(!body.contains("Periods/Months/2026/10.md"), "{body}");
}

#[test]
fn an_unauthenticated_create_is_refused_and_writes_nothing() {
    let dir = TempDir::new("http-create-anon");
    let mut server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);
    server.default_headers = String::new();

    let (status, _) = server.post_json("/api/v1/vaults/v/notes", "", r#"{"path":"Sneaky.md"}"#);

    assert!(is_not_found(&status), "{status}");
    assert!(!dir.path().join("Sneaky.md").exists());
}

/// E17 over the wire: the four probes an attacker would actually send, and one reply.
#[test]
fn a_create_a_caller_may_not_do_answers_exactly_as_an_unknown_vault_does() {
    let dir = TempDir::new("http-create-denied");
    dir.write("Private/Salary.md", "# Salary\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n\n\
         [[members]]\nuser = \"bob\"\nrole = \"viewer\"\n\n\
         [[rules]]\npath = \"Private\"\ngrant = { bob = \"none\" }\n",
    );
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth db");
    auth.setup_first_user(mb_auth::NewUser {
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
    let token = auth.create_session(bob.id, 4_102_444_800).expect("session");
    let bob_header = format!(
        "Cookie: mb_session={}\r\n",
        auth.signed_session_cookie(&token).expect("sign cookie")
    );
    let state = AppState::authenticated(vec![vault(&dir, "v", "V")], auth).expect("secure state");
    let mut server = TestServer::start(state);
    server.default_headers = bob_header;

    let mut replies = Vec::new();
    for (route, body) in [
        // A note that is there but unreadable, and one that is not there.
        ("/api/v1/vaults/v/notes", r#"{"path":"Private/Salary.md"}"#),
        ("/api/v1/vaults/v/notes", r#"{"path":"Private/Nothing.md"}"#),
        // A folder bob has no grant in at all.
        ("/api/v1/vaults/v/notes", r#"{"path":"Root.md"}"#),
        // A vault that does not exist.
        ("/api/v1/vaults/nope/notes", r#"{"path":"Root.md"}"#),
    ] {
        let (status, reply) = server.post_json(route, "", body);
        assert!(is_not_found(&status), "{route} {body}: {status}");
        replies.push(reply);
    }
    assert!(
        replies.windows(2).all(|pair| pair[0] == pair[1]),
        "the four refusals must be one refusal: {replies:?}"
    );
    assert!(!dir.path().join("Private/Nothing.md").exists());
    assert!(!dir.path().join("Root.md").exists());
    assert_eq!(
        std::fs::read_to_string(dir.path().join("Private/Salary.md")).expect("untouched"),
        "# Salary\n"
    );
}

#[test]
fn a_create_body_that_is_not_a_path_is_refused_without_touching_the_vault() {
    let dir = TempDir::new("http-create-shape");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    for body in [
        r#"{"path":"../Escaped.md"}"#,
        r#"{"path":"NoExtension"}"#,
        r#"{"path":""}"#,
    ] {
        let (status, _) = server.post_json("/api/v1/vaults/v/notes", "", body);
        assert!(status.contains("400"), "{body} should be refused: {status}");
    }
    assert!(!dir.path().join("../Escaped.md").exists());
}

// ---------------------------------------------------------------- first run (§6.10)

/// The whole reason this feature exists: a vault with no notes must not be a dead end.
///
/// The workspace shell is only served from a note URL, so an empty vault cannot load it and
/// cannot reach the palette's create command. If the vault index has no way in, a freshly
/// registered vault can only be used by writing a Markdown file by hand.
#[test]
fn an_empty_vault_offers_a_way_to_create_the_first_note() {
    let dir = TempDir::new("http-first-run");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, body) = server.get("/v/v");

    assert!(is_ok(&status), "{status}");
    assert!(body.contains("0 notes"), "{body}");
    assert!(
        body.contains("action=\"/v/v/new\""),
        "an empty vault must offer a create form: {body}"
    );
    assert!(body.contains("no notes yet"), "{body}");
}

/// A form is worthless if the page's own CSP forbids submitting it — the M5 outage exactly.
#[test]
fn the_vault_index_permits_submitting_its_own_form() {
    let dir = TempDir::new("http-first-run-csp");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (_, body) = server.get("/v/v");

    assert!(body.contains("form-action 'self'"), "{body}");
    // And a note page, which renders untrusted content and has no form, keeps the strict rule.
    std::fs::write(dir.path().join("A.md"), "# A\n").expect("a note");
    server.tick();
    let (_, note) = server.get("/v/v/A.md");
    assert!(note.contains("form-action 'none'"), "{note}");
}

#[test]
fn the_first_note_form_creates_it_and_redirects_to_it() {
    let dir = TempDir::new("http-first-run-create");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, _) = server.post_form_signed_in("/v/v/new", "name=Welcome");

    assert!(status.contains("303"), "{status}");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("Welcome.md")).expect("the first note"),
        "# Welcome\n"
    );
    // The vault is no longer empty, and the note it now lists is the one just created.
    let (_, body) = server.get("/v/v");
    assert!(body.contains("1 notes"), "{body}");
    assert!(body.contains("/v/v/Welcome.md"), "{body}");
}

#[test]
fn the_redirect_after_creating_points_at_the_new_note() {
    let dir = TempDir::new("http-first-run-location");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let head = server.post_form_head("/v/v/new", "name=Q3+Plans");

    assert!(head.contains("303"), "{head}");
    assert!(head.contains("location: /v/v/q3%20plans.md"), "{head}");
    assert!(
        std::fs::read_to_string(dir.path().join("Q3 Plans.md")).is_ok(),
        "the redirect must point at a note that is really there"
    );
}

#[test]
fn a_refused_name_comes_back_on_the_page_that_asked_rather_than_a_dead_end() {
    let dir = TempDir::new("http-first-run-refused");
    dir.write("Taken.md", "# Taken\n");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);
    server.tick();

    let (status, body) = server.post_form_signed_in("/v/v/new", "name=Taken");

    // Not a 303, and not a bare error document: the form is there to try again with.
    assert!(is_ok(&status), "{status}");
    assert!(body.contains("already exists"), "{body}");
    assert!(body.contains("action=\"/v/v/new\""), "{body}");
    assert!(body.contains("role=\"alert\""), "{body}");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("Taken.md")).expect("untouched"),
        "# Taken\n"
    );
}

#[test]
fn an_unauthenticated_form_post_creates_nothing() {
    let dir = TempDir::new("http-first-run-anon");
    let server = TestServer::authenticated(vec![vault(&dir, "v", "V")]);

    let (status, _) = server.post_form("/v/v/new", "name=Sneaky");

    assert!(is_not_found(&status), "{status}");
    assert!(!dir.path().join("Sneaky.md").exists());
}
