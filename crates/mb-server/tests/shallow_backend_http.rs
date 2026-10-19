//! E30/E31 and exact-root project registration against real disposable HTTP.
#![cfg(target_os = "linux")]
#![allow(
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::panic,
    clippy::indexing_slicing
)] // why: test-only exact wire and disk assertions.
#[path = "support/vault_registration.rs"]
mod fixture;
#[path = "support/http_safety.rs"]
#[allow(dead_code)] // why: reuse the privilege runner, not unrelated fixture helpers.
mod http_safety;
use fixture::{Server, encode, json};
use std::io::{Read, Write};
fn post(s: &Server, route: &str, headers: &str, body: &str) -> (u16, String, String) {
    exchange(s.addr, "POST", route, headers, body)
}
fn exchange(
    addr: std::net::SocketAddr,
    method: &str,
    route: &str,
    headers: &str,
    body: &str,
) -> (u16, String, String) {
    let mut stream = std::net::TcpStream::connect(addr).expect("connect");
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(20)))
        .expect("deadline");
    write!(stream, "{method} {route} HTTP/1.1\r\nHost: localhost\r\n{headers}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).expect("request");
    let mut raw = String::new();
    stream.read_to_string(&mut raw).expect("response");
    let (head, body) = raw.split_once("\r\n\r\n").expect("HTTP");
    (
        head.split_whitespace()
            .nth(1)
            .expect("status")
            .parse()
            .expect("code"),
        body.into(),
        head.into(),
    )
}
fn admin(s: &Server) -> String {
    format!("{}Origin: http://localhost\r\n", s.admin)
}

fn fresh_reopen_child(actor: &str, query: &'static str, indexed_path: &'static str) -> bool {
    let Some(directory) = std::env::var_os("MB_SHALLOW_REOPEN_DIR") else {
        return false;
    };
    let parent: u32 = std::env::var("MB_SHALLOW_PARENT_PID")
        .expect("parent PID")
        .parse()
        .expect("numeric parent PID");
    assert_ne!(
        std::process::id(),
        parent,
        "must be a new process, not just reopening a value"
    );
    let directory = std::path::PathBuf::from(directory);
    let root = directory.join("Projects/Public");
    let vaults = mb_server::ServerConfig::load(&directory.join("server.toml"))
        .expect("persisted config")
        .open_vaults(None)
        .expect("startup loader");
    assert_eq!(vaults[0].notes_root(), root);
    let auth = mb_auth::AuthDb::open(&directory.join("auth.sqlite")).expect("disposable auth");
    let user = auth
        .user_by_username(actor)
        .expect("lookup")
        .expect("fixture owner");
    let session = auth
        .create_session(user.id, 4_102_444_800)
        .expect("fresh session");
    let headers = format!(
        "Cookie: mb_session={}\r\nOrigin: http://localhost\r\n",
        auth.signed_session_cookie(&session).expect("signed cookie")
    );
    let state = std::sync::Arc::new(
        mb_server::http::AppState::authenticated(vaults, auth).expect("fresh state"),
    );
    // why: constructing AppState alone intentionally leaves its in-memory index empty.
    // Exercise the actual serve_listener startup operation in this fresh process.
    let errors = state.maintain_index(&mb_server::watch::Changes::All);
    assert!(errors.is_empty(), "fresh startup index errors: {errors:?}");
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    rt.block_on(async move {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("address");
        let (stop, done) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            axum::serve(listener, mb_server::http::router(state))
                .with_graceful_shutdown(async {
                    let _ = done.await;
                })
                .await
                .expect("serve");
        });
        tokio::task::spawn_blocking(move || {
            let (status, body, _) = exchange(
                addr,
                "GET",
                &format!("/api/v1/vaults/exact/search?q={query}"),
                &headers,
                "",
            );
            assert_eq!(status, 200, "{body}");
            assert!(
                json(&body)["hits"]
                    .as_array()
                    .expect("fresh indexed hits")
                    .iter()
                    .any(|hit| hit["path"] == indexed_path),
                "fresh index missing {indexed_path}: {body}"
            );
            let (status, body, _) = exchange(
                addr,
                "POST",
                "/api/v1/vaults/exact/notes",
                &headers,
                "{\"path\":\"FreshProcess.md\",\"content\":\"# Restarted\\n\"}",
            );
            assert_eq!(status, 200, "{body}");
            assert!(root.join("FreshProcess.md").is_file());
            assert!(!root.join("notes/FreshProcess.md").exists());
        })
        .await
        .expect("fresh HTTP assertions");
        let _ = stop.send(());
        server.await.expect("server cleanup");
    });
    println!(
        "MB_SHALLOW_REOPEN_ASSERTIONS_COMPLETED pid={} parent={parent}",
        std::process::id()
    );
    true
}

fn assert_fresh_reopen(s: &Server, case: &str) {
    let output = std::process::Command::new(std::env::current_exe().expect("test executable"))
        .args([case, "--exact", "--nocapture"])
        .env("MB_SHALLOW_REOPEN_DIR", s.dir.path())
        .env("MB_SHALLOW_PARENT_PID", std::process::id().to_string())
        .output()
        .expect("fresh process");
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "fresh child failed: {text}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        text.contains("MB_SHALLOW_REOPEN_ASSERTIONS_COMPLETED"),
        "fresh assertions did not run: {text}"
    );
    for line in text.lines() {
        println!("reopen child> {line}");
    }
}
#[test]
fn e30_shallow_http_filters_acl_without_descendants_or_body_reads() {
    let s = Server::new(true);
    let root = s.dir.path().join("Projects/Registered");
    std::fs::write(
        root.join("Public.md"),
        "# NEVER_RENDER_TITLE\nNEVER_RENDER_BODY",
    )
    .expect("note");
    std::fs::write(root.join("access.toml"), "[[members]]\nuser='bob'\nrole='viewer'\n[[rules]]\npath='PrivateChildName'\ngrant={bob='none'}\n").expect("ACL");
    s.state.reload_access();
    std::fs::create_dir(root.join("Empty")).expect("empty");
    let (status, body, head) = s.get("/api/v1/vaults/private/directory", &s.user);
    assert_eq!(status, 200, "{body}");
    assert!(head.to_lowercase().contains("cache-control: no-store"));
    assert_eq!(
        json(&body),
        serde_json::json!({"path":"","folders":[{"name":"Empty","path":"Empty"}],"files":[{"name":"Public.md","path":"Public.md"}]})
    );
    let denied = s.get(
        "/api/v1/vaults/private/directory?path=PrivateChildName",
        &s.user,
    );
    let absent = s.get("/api/v1/vaults/private/directory?path=Missing", &s.user);
    assert_eq!((denied.0, denied.1), (absent.0, absent.1));
    assert_eq!(denied.0, 404);
    assert_eq!(
        s.get("/api/v1/vaults/private/directory", &s.admin).0,
        404,
        "admin has no content bypass"
    );
    assert_eq!(
        s.get("/api/v1/vaults/private/directory", &s.user_bearer).0,
        200
    );
}
#[test]
fn e30_exhausted_absent_grants_do_not_discover_private_vault_or_folder() {
    let s = Server::new(true);
    let root = s.dir.path().join("Projects/Registered");
    std::fs::create_dir(root.join("Ghost")).expect("private ancestor");
    let absent = s.get("/api/v1/vaults/missing/directory", &s.user);
    assert_eq!(absent.0, 404);
    for count in [128, 129] {
        let policy = (0..count)
            .map(|i| format!("[[rules]]\npath='Ghost/Absent{i}'\ngrant={{bob='viewer'}}\n"))
            .collect::<String>();
        std::fs::write(root.join("access.toml"), policy).expect("only absent grants");
        for query in ["", "?path=Ghost"] {
            let denied = s.get(&format!("/api/v1/vaults/private/directory{query}"), &s.user);
            assert_eq!(
                (denied.0, denied.1),
                (absent.0, absent.1.clone()),
                "unknown authority must be neutral at {count}"
            );
            assert!(denied.2.to_lowercase().contains("cache-control: no-store"));
        }
    }
}
#[test]
fn e31_immediate_mkdir_has_exact_readback_and_no_registration_or_acl() {
    let s = Server::new(true); // configured root contains a registered child: safe sibling is allowed.
    let before = std::fs::read(s.dir.path().join("server.toml")).expect("config");
    let name = " 日本 100% %2e%2e ";
    let input = serde_json::json!({"path":"","directory":name}).to_string();
    for query in ["?path=", "?unknown=value", "?"] {
        assert_eq!(
            post(
                &s,
                &format!("/api/v1/vault-locations/projects/directories{query}"),
                &admin(&s),
                &input
            )
            .0,
            400,
            "mkdir accepts no query at all"
        );
    }
    let (status, body, head) = post(
        &s,
        "/api/v1/vault-locations/projects/directories",
        &admin(&s),
        &input,
    );
    assert_eq!(status, 201, "{body}");
    assert!(head.to_lowercase().contains("cache-control: no-store"));
    assert_eq!(
        json(&body),
        serde_json::json!({"path":name,"created":true,"directory_synced":true})
    );
    let child = s.dir.path().join("Projects").join(name);
    assert!(child.is_dir());
    assert_eq!(
        std::fs::read_dir(child).expect("exact empty child").count(),
        0
    );
    assert_eq!(
        std::fs::read(s.dir.path().join("server.toml")).expect("unchanged"),
        before
    );
    assert_eq!(s.state.len(), 1);
    assert_eq!(
        post(
            &s,
            "/api/v1/vault-locations/projects/directories",
            &admin(&s),
            &input
        )
        .0,
        409
    );
}
#[test]
fn project_registration_pins_exact_root_even_with_notes_and_on_reopen() {
    project_exact_root_with_notes(
        false,
        "project_registration_pins_exact_root_even_with_notes_and_on_reopen",
    );
}
#[test]
fn project_membership_only_policy_with_notes_keeps_exact_root_and_fresh_process_create() {
    project_exact_root_with_notes(
        true,
        "project_membership_only_policy_with_notes_keeps_exact_root_and_fresh_process_create",
    );
}
fn project_exact_root_with_notes(membership_only: bool, case: &str) {
    if fresh_reopen_child("alice", "RootTitle", "README.md") {
        return;
    }
    let s = Server::new(false);
    let root = s.dir.path().join("Projects/Public");
    std::fs::create_dir(root.join("notes")).expect("legacy-looking child");
    std::fs::write(root.join("README.md"), "# RootTitle\n").expect("root note");
    std::fs::write(root.join("notes/Child.md"), "# ChildTitle\n").expect("child note");
    let policy = b"[[members]]\nuser='alice'\nrole='owner'\n";
    if membership_only {
        std::fs::write(root.join("access.toml"), policy)
            .expect("compatible existing membership-only policy");
    }
    let mut input =
        serde_json::json!({"mode":"existing","path":"Public","slug":"exact","name":"Exact"});
    let (status, body, _) = post(
        &s,
        "/api/v1/vault-locations/projects/preview",
        &admin(&s),
        &input.to_string(),
    );
    assert_eq!(status, 200, "{body}");
    assert_eq!(json(&body)["notes_root"], "root");
    input["confirmation"] = json(&body)["confirmation"].clone();
    assert_eq!(
        post(
            &s,
            "/api/v1/vault-locations/projects/register",
            &admin(&s),
            &input.to_string()
        )
        .0,
        201
    );
    let live = s.state.vault("exact").expect("live");
    if membership_only {
        assert_eq!(
            std::fs::read(root.join("access.toml")).expect("unchanged policy"),
            policy
        );
    }
    assert_eq!(live.notes_root(), root);
    assert_eq!(
        live.notes().expect("notes"),
        vec!["README.md", "notes/Child.md"]
    );
    let config = s.config();
    assert!(
        config
            .to_toml()
            .expect("persisted")
            .contains("notes_layout = \"root\"")
    );
    assert_eq!(
        config.open_vaults(None).expect("reopen")[0].notes_root(),
        root
    );
    let (status, body, _) = s.get("/api/v1/vaults/exact/notes", &s.admin);
    assert_eq!(status, 200);
    assert!(
        body.contains("README.md") && body.contains("notes/Child.md"),
        "{body}"
    );
    // why: catalog reads alone can walk disk; these replies must come from the actual
    // registration-time initial index and agree with the exact live/configured root.
    for (query, expected) in [("RootTitle", "README.md"), ("ChildTitle", "notes/Child.md")] {
        let (status, body, _) = s.get(&format!("/api/v1/vaults/exact/search?q={query}"), &s.admin);
        assert_eq!(status, 200, "{body}");
        assert!(
            json(&body)["hits"]
                .as_array()
                .expect("indexed hits")
                .iter()
                .any(|hit| hit["path"] == expected),
            "missing indexed {expected}: {body}"
        );
    }
    let (status, body, _) = post(
        &s,
        "/api/v1/vaults/exact/notes",
        &s.admin,
        "{\"path\":\"Created.md\",\"content\":\"# Canonical\\n\"}",
    );
    assert_eq!(status, 200, "{body}");
    assert!(root.join("Created.md").is_file());
    assert!(!root.join("notes/Created.md").exists());
    assert_fresh_reopen(&s, case);
}
#[test]
fn e30_query_boundary_decodes_once_preserving_unicode_whitespace_percent_and_plus() {
    let s = Server::new(true);
    let root = s.dir.path().join("Projects/Registered");
    for name in [" 日本 %2e%2e ", "%2f", "%252e%252e", "a+b", "e\u{301}"] {
        std::fs::create_dir(root.join(name)).expect("literal directory");
        let (status, body, _) = s.get(
            &format!("/api/v1/vaults/private/directory?path={}", encode(name)),
            &s.user,
        );
        assert_eq!(status, 200, "{body}");
        assert_eq!(json(&body)["path"], name);
    }
    for query in [
        "path=..",
        "path=A%2f..",
        "path=%2Fetc",
        "path=.hidden",
        "path=%zz",
        "path=%ff",
        "path=A&path=B",
        "p%61th=A",
        "path=A&unknown=B",
    ] {
        assert_eq!(
            s.get(
                &format!("/api/v1/vaults/private/directory?{query}"),
                &s.user
            )
            .0,
            400,
            "{query}"
        );
    }
}
#[test]
fn e31_real_eacces_parent_cannot_create_but_restored_parent_can() {
    const NAME: &str = "e31_real_eacces_parent_cannot_create_but_restored_parent_can";
    if http_safety::run_unprivileged(NAME) {
        return;
    }
    let s = Server::new(false);
    let parent = s.dir.path().join("Projects/Public");
    let mode = http_safety::FixtureMode::set(&parent, 0o500);
    assert_eq!(
        std::fs::create_dir(parent.join("DirectDenied"))
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::PermissionDenied
    );
    let input = "{\"path\":\"Public\",\"directory\":\"Child\"}";
    assert_eq!(
        post(
            &s,
            "/api/v1/vault-locations/projects/directories",
            &admin(&s),
            input
        )
        .0,
        503
    );
    assert!(!parent.join("Child").exists());
    drop(mode);
    assert_eq!(
        post(
            &s,
            "/api/v1/vault-locations/projects/directories",
            &admin(&s),
            input
        )
        .0,
        201
    );
    assert!(parent.join("Child").is_dir());
    assert!(s.config().vaults.is_empty());
    http_safety::mark_completed(NAME);
}
#[test]
fn project_created_before_notes_directory_keeps_disk_root_and_literal_policy_after_restart() {
    if fresh_reopen_child("bob", "Before", "Before.md") {
        return;
    }
    let s = Server::new(false);
    let root = s.dir.path().join("Projects/Public");
    let policy =
        b"[[members]]\nuser='bob'\nrole='owner'\n[[rules]]\npath='Private'\ngrant={bob='none'}\n";
    std::fs::write(root.join("access.toml"), policy).expect("preserved policy excluding admin");
    let mut input =
        serde_json::json!({"mode":"existing","path":"Public","slug":"exact","name":"Exact"});
    let (_, body, _) = post(
        &s,
        "/api/v1/vault-locations/projects/preview",
        &admin(&s),
        &input.to_string(),
    );
    input["confirmation"] = json(&body)["confirmation"].clone();
    assert_eq!(
        post(
            &s,
            "/api/v1/vault-locations/projects/register",
            &admin(&s),
            &input.to_string()
        )
        .0,
        201
    );
    assert_eq!(
        s.get("/api/v1/vaults/exact/directory", &s.admin).0,
        404,
        "admin excluded by unchanged policy"
    );
    assert_eq!(
        post(
            &s,
            "/api/v1/vaults/exact/notes",
            &s.user,
            "{\"path\":\"Before.md\",\"content\":\"# Before\\n\"}"
        )
        .0,
        200
    );
    assert!(root.join("Before.md").is_file());
    std::fs::create_dir(root.join("notes")).expect("later notes dir");
    std::fs::write(root.join("README.md"), "# Root\\n").expect("root note");
    std::fs::write(root.join("notes/Child.md"), "# Child\\n").expect("child note");
    assert_eq!(
        post(
            &s,
            "/api/v1/vaults/exact/notes",
            &s.user,
            "{\"path\":\"After.md\",\"content\":\"# After\\n\"}"
        )
        .0,
        200
    );
    assert!(root.join("After.md").is_file());
    assert!(!root.join("notes/After.md").exists());
    let reopened = s.config().open_vaults(None).expect("fresh process layout");
    assert_eq!(reopened[0].notes_root(), root);
    assert_eq!(
        reopened[0]
            .reserve("Created.md")
            .expect("canonical new disk path"),
        root.join("Created.md")
    );
    assert_eq!(
        std::fs::read(root.join("access.toml")).expect("policy"),
        policy,
        "no ACL translation or new creator grant"
    );
    assert_fresh_reopen(
        &s,
        "project_created_before_notes_directory_keeps_disk_root_and_literal_policy_after_restart",
    );
    assert_eq!(
        std::fs::read(root.join("access.toml")).expect("policy after fresh process"),
        policy
    );
}
