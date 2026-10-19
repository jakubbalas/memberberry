//! E29 conservative policy-layout refusal using real HTTP and disposable files.
#![allow(
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::panic,
    clippy::indexing_slicing
)] // why: test-only wire/disk assertions.
use super::registration_fixture::{Server, json};
use std::io::{Read, Write};
const PREVIEW: &str = "/api/v1/vault-locations/projects/preview";
const REGISTER: &str = "/api/v1/vault-locations/projects/register";
const LEGACY: &[u8] =
    b"[[members]]\nuser='bob'\nrole='viewer'\n[[rules]]\npath='Private.md'\ngrant={bob='none'}\n";
const ROOT: &[u8] = b"[[members]]\nuser='bob'\nrole='viewer'\n[[rules]]\npath='notes/Private.md'\ngrant={bob='none'}\n";
const NOTE: &[u8] = b"# DisposablePrivateMarker\nSYNTHETIC_ONLY_CONTENT\n";
fn setup(root: &std::path::Path, policy: &[u8]) {
    std::fs::create_dir(root.join("notes")).expect("notes");
    std::fs::write(root.join("notes/Private.md"), NOTE).expect("note");
    std::fs::write(root.join("notes/Public.md"), b"# PublicControl\n").expect("control");
    std::fs::write(root.join("access.toml"), policy).expect("ACL");
}
fn input(selected: &str) -> serde_json::Value {
    serde_json::json!({"mode":"existing","path":selected,"slug":"exact","name":"Exact"})
}
fn post(s: &Server, route: &str, headers: &str, body: &serde_json::Value) -> (u16, String, String) {
    let body = body.to_string();
    let mut stream = std::net::TcpStream::connect(s.addr).expect("connect");
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(20)))
        .expect("deadline");
    write!(stream,"POST {route} HTTP/1.1\r\nHost: localhost\r\n{headers}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).expect("send");
    let mut raw = String::new();
    stream.read_to_string(&mut raw).expect("reply");
    let (head, body) = raw.split_once("\r\n\r\n").expect("HTTP");
    assert!(head.to_lowercase().contains("cache-control: no-store"));
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
fn register(s: &Server, selected: &str) {
    let mut request = input(selected);
    let (status, body, _) = post(s, PREVIEW, &admin(s), &request);
    assert_eq!(status, 200, "positive preview: {body}");
    assert_eq!(json(&body)["notes_root"], "root");
    request["confirmation"] = json(&body)["confirmation"].clone();
    assert_eq!(post(s, REGISTER, &admin(s), &request).0, 201);
}
fn content_free(body: &str, root: &std::path::Path) {
    assert!(!body.contains("confirmation"));
    for secret in [
        "Private.md",
        "bob",
        "alice",
        "DisposablePrivateMarker",
        "SYNTHETIC_ONLY_CONTENT",
        "[[rules]]",
        root.to_str().expect("path"),
    ] {
        assert!(!body.contains(secret), "refusal disclosed fixture metadata");
    }
}
pub fn refuses_ambiguous_policy_without_adoption_or_disclosure() {
    // Preserve a real legacy Auto denial plus readable ordinary non-admin control.
    let old = Server::configured(false, |config| {
        let root = config.vault_locations[0].path().join("Public");
        setup(&root, LEGACY);
        config.vaults.push(
            mb_server::ServerConfig::parse(&format!(
                "[[vaults]]\nslug='legacy'\npath='{}'\n",
                root.display()
            ))
            .expect("Auto")
            .vaults
            .remove(0),
        );
    });
    assert!(
        !old.auth()
            .user_by_username("bob")
            .expect("lookup")
            .expect("member")
            .is_admin
    );
    assert_eq!(old.get("/v/legacy/Private.md", &old.user).0, 404);
    assert_eq!(old.get("/v/legacy/Public.md", &old.user).0, 200);
    let catalog = old.get("/api/v1/vaults/legacy/notes", &old.user);
    assert_eq!(catalog.0, 200);
    assert!(!catalog.1.contains("Private.md"));
    // Even intentionally root-relative rules must refuse; never infer the intended base.
    for policy in [LEGACY, ROOT] {
        let s = Server::new(false);
        let root = s.dir.path().join("Projects/Public");
        setup(&root, policy);
        let config = std::fs::read(s.dir.path().join("server.toml")).expect("before");
        let before_names = std::fs::read_dir(&root)
            .expect("names")
            .map(|e| e.expect("entry").file_name())
            .collect::<std::collections::BTreeSet<_>>();
        let (status, body, _) = post(&s, PREVIEW, &admin(&s), &input("Public"));
        assert_eq!(
            status, 409,
            "approved conservative refusal must precede preview receipt"
        );
        content_free(&body, &root);
        assert_eq!(
            std::fs::read(root.join("access.toml")).expect("preserved"),
            policy
        );
        assert_eq!(
            std::fs::read(root.join("notes/Private.md")).expect("preserved"),
            NOTE
        );
        assert_eq!(
            std::fs::read(s.dir.path().join("server.toml")).expect("config"),
            config
        );
        assert_eq!(
            std::fs::read_dir(&root)
                .expect("names")
                .map(|e| e.expect("entry").file_name())
                .collect::<std::collections::BTreeSet<_>>(),
            before_names
        );
        assert_eq!(s.state.len(), 0);
        assert!(s.config().open_vaults(None).expect("reopened").is_empty());
        for route in [
            "/v/exact/notes/Private.md",
            "/api/v1/vaults/exact/notes",
            "/api/v1/vaults/exact/directory?path=notes",
            "/api/v1/vaults/exact/search?q=DisposablePrivateMarker",
        ] {
            let denied = s.get(route, &s.user);
            assert_eq!(denied.0, 404);
            content_free(&denied.1, &root);
        }
        assert!(
            s.state
                .maintain_index(&mb_server::watch::Changes::All)
                .is_empty()
        );
        assert!(s.state.vault("exact").is_none());
    }
}
pub fn strict_authority_and_initial_refusal_have_real_no_io_controls() {
    let s = Server::new(false);
    let root = s.dir.path().join("Projects/Public");
    setup(&root, LEGACY);
    std::fs::create_dir(root.join("notes/Deeper")).expect("readable deeper");
    std::fs::write(root.join("notes/Deeper/Body.md"), NOTE).expect("body");
    use rustix::fs::inotify;
    let observed = inotify::init(inotify::CreateFlags::NONBLOCK).expect("observer");
    for path in [
        root.clone(),
        root.join("notes/Private.md"),
        root.join("notes/Deeper"),
        root.join("notes/Deeper/Body.md"),
    ] {
        inotify::add_watch(
            &observed,
            path,
            inotify::WatchFlags::OPEN | inotify::WatchFlags::ACCESS | inotify::WatchFlags::CREATE,
        )
        .expect("watch");
    }
    let mut buf = [std::mem::MaybeUninit::uninit(); 8192];
    let mut reader = inotify::Reader::new(&observed, &mut buf);
    let invalid = [
        format!("{}Origin: http://localhost\r\n", s.user),
        format!("{}Origin: http://localhost\r\n", s.admin_bearer),
        format!("{}Origin: http://foreign.invalid\r\n", s.admin),
        format!("{}{}Origin: http://localhost\r\n", s.admin, s.admin),
    ];
    for headers in invalid {
        let denied = post(&s, PREVIEW, &headers, &input("Public"));
        assert_eq!(denied.0, 404);
        assert_eq!(json(&denied.1), serde_json::json!({"error":"not_found"}));
    }
    assert!(
        matches!(reader.next(), Err(rustix::io::Errno::AGAIN)),
        "strict authority precedes opens/probes; stat is separately source/counter checked"
    );
    // Watching the root reports permitted root/policy opens, not descendant stat. Watch
    // descendants separately so the bounded notes identity open does not mask traversal.
    let descendants = inotify::init(inotify::CreateFlags::NONBLOCK).expect("descendant observer");
    for path in [
        root.join("notes/Private.md"),
        root.join("notes/Deeper"),
        root.join("notes/Deeper/Body.md"),
    ] {
        inotify::add_watch(
            &descendants,
            path,
            inotify::WatchFlags::OPEN | inotify::WatchFlags::ACCESS | inotify::WatchFlags::CREATE,
        )
        .expect("watch");
    }
    let mut deeper_buf = [std::mem::MaybeUninit::uninit(); 8192];
    let mut deeper_reader = inotify::Reader::new(&descendants, &mut deeper_buf);
    let mutations = inotify::init(inotify::CreateFlags::NONBLOCK).expect("mutation observer");
    for path in [root.clone(), root.join("notes"), root.join("notes/Deeper")] {
        inotify::add_watch(
            &mutations,
            path,
            inotify::WatchFlags::CREATE
                | inotify::WatchFlags::MOVED_TO
                | inotify::WatchFlags::DELETE,
        )
        .expect("mutation watch");
    }
    let mut mutation_buf = [std::mem::MaybeUninit::uninit(); 8192];
    let mut mutation_reader = inotify::Reader::new(&mutations, &mut mutation_buf);
    let denied = post(&s, PREVIEW, &admin(&s), &input("Public"));
    assert_eq!(denied.0, 409);
    content_free(&denied.1, &root);
    assert!(
        matches!(mutation_reader.next(), Err(rustix::io::Errno::AGAIN)),
        "no root or descendant probe/temporary mutation on initial refusal"
    );
    assert!(
        matches!(deeper_reader.next(), Err(rustix::io::Errno::AGAIN)),
        "initial guard must precede usability traversal and body indexing"
    );
    // Real readable observer control, not an inaccessible-only absence assertion.
    std::fs::read(root.join("notes/Deeper/Body.md")).expect("positive body read");
    assert!(deeper_reader.next().is_ok(), "observer sees actual reads");
    // A compatible membership-only policy admits real storage probes and registration.
    std::fs::write(
        root.join("access.toml"),
        b"[[members]]\nuser='bob'\nrole='owner'\n",
    )
    .expect("compatible fixture");
    register(&s, "Public");
    assert!(
        mutation_reader.next().is_ok(),
        "observer sees compatible storage probe mutations"
    );
    assert_eq!(s.get("/v/exact/notes/Private.md", &s.user).0, 200);
}
pub fn selected_root_only_and_no_notes_scoped_policy_controls() {
    let s = Server::new(false);
    let root = s.dir.path().join("Projects/Public");
    setup(&root, ROOT);
    std::fs::write(root.join("notes/access.toml"), LEGACY).expect("selected ACL");
    register(&s, "Public/notes");
    assert_eq!(
        s.state.vault("exact").expect("vault").notes_root(),
        root.join("notes")
    );
    assert_eq!(s.get("/v/exact/Private.md", &s.user).0, 404);
    assert_eq!(s.get("/v/exact/Public.md", &s.user).0, 200);
    assert_eq!(
        std::fs::read(root.join("access.toml")).expect("outer"),
        ROOT
    );
    assert_eq!(
        std::fs::read(root.join("notes/access.toml")).expect("selected"),
        LEGACY
    );
    let s = Server::new(false);
    let root = s.dir.path().join("Projects/Public");
    std::fs::write(root.join("access.toml"), LEGACY).expect("scoped root");
    std::fs::write(root.join("Private.md"), NOTE).expect("denied");
    std::fs::write(root.join("Public.md"), b"# PublicControl\n").expect("control");
    std::fs::create_dir(root.join("Nested")).expect("shadow");
    std::fs::write(
        root.join("Nested/access.toml"),
        b"[[members]]\nuser='alice'\nrole='owner'\n",
    )
    .expect("shadow");
    register(&s, "Public");
    assert_eq!(s.get("/v/exact/Private.md", &s.user).0, 404);
    assert_eq!(s.get("/v/exact/Public.md", &s.user).0, 200);
    assert_eq!(
        s.get("/api/v1/vaults/exact/directory", &s.admin).0,
        404,
        "nested shadow cannot grant admin"
    );
    assert_eq!(
        std::fs::read(root.join("access.toml")).expect("same"),
        LEGACY
    );
    let reopened = s.config().open_vaults(None).expect("reopen");
    assert_eq!(reopened[0].notes_root(), root);
    let access = mb_server::AccessFile::load(&root).expect("ACL");
    let reader = mb_server::repository::AuthorizedVault::new(
        &reopened[0],
        access.policy(),
        mb_core::Username::parse("bob").expect("member"),
    );
    assert!(reader.read("Private.md").is_err());
    assert!(reader.read("Public.md").is_ok());
}
pub fn malformed_selected_policy_is_not_rescued_by_shadow() {
    let s = Server::new(false);
    let root = s.dir.path().join("Projects/Public");
    setup(&root, b"not valid toml");
    std::fs::write(
        root.join("notes/access.toml"),
        b"[[members]]\nuser='alice'\nrole='owner'\n",
    )
    .expect("shadow");
    assert_eq!(post(&s, PREVIEW, &admin(&s), &input("Public")).0, 503);
    assert_eq!(
        std::fs::read(root.join("access.toml")).expect("unchanged"),
        b"not valid toml"
    );
    assert!(s.config().vaults.is_empty());
}
