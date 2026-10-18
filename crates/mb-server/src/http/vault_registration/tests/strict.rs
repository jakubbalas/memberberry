//! Review F1–F3: real signed actors, full handlers, positive-controlled storage observation.
use super::*;

struct Observer(std::os::fd::OwnedFd);
impl Observer {
    fn new(f: &Fixture) -> Self {
        use rustix::fs::inotify::*;
        let fd = init(CreateFlags::NONBLOCK).expect("observer");
        for path in [
            "server.toml",
            "Projects",
            "Projects/Public",
            "Projects/Public/Readme.md",
        ] {
            add_watch(
                &fd,
                f.dir.path().join(path),
                WatchFlags::OPEN
                    | WatchFlags::ACCESS
                    | WatchFlags::CREATE
                    | WatchFlags::DELETE
                    | WatchFlags::MOVED_FROM
                    | WatchFlags::MOVED_TO,
            )
            .expect("watch fixture");
        }
        Self(fd)
    }
    fn events(&self) -> usize {
        let mut bytes = [std::mem::MaybeUninit::uninit(); 16384];
        let mut reader = rustix::fs::inotify::Reader::new(&self.0, &mut bytes);
        let mut count = 0;
        loop {
            match reader.next() {
                Ok(_) => count += 1,
                Err(rustix::io::Errno::AGAIN) => return count,
                Err(error) => panic!("observer failure: {error}"),
            }
        }
    }
}
async fn response(
    f: &Fixture,
    headers: HeaderMap,
    input: serde_json::Value,
    confirm: bool,
) -> (StatusCode, serde_json::Value, bool) {
    // Exercise the actual endpoint wrapper as well as its complete common handler.
    let request = Fixture::request(headers, input, confirm);
    let r = if confirm {
        register(State(f.state.clone()), request).await
    } else {
        preview(State(f.state.clone()), request).await
    };
    let status = r.status();
    let no_store =
        r.headers().get(header::CACHE_CONTROL) == Some(&HeaderValue::from_static("no-store"));
    let bytes = axum::body::to_bytes(r.into_body(), 8192)
        .await
        .expect("body");
    (
        status,
        serde_json::from_slice(&bytes).expect("JSON"),
        no_store,
    )
}
async fn actionable(
    f: &Fixture,
    observer: &Observer,
    new: bool,
    confirm: bool,
) -> serde_json::Value {
    assert_eq!(observer.events(), 0);
    let count = f.state.registration.hooks.before_fs.load(Ordering::Relaxed);
    let mut input = f.input(new);
    let (status, body, no_store) = response(f, f.headers.clone(), input.clone(), false).await;
    assert_eq!(status, StatusCode::OK, "actual authorized preview");
    assert!(no_store);
    assert!(
        observer.events() > 0,
        "observer must detect actual config/project/probe opens"
    );
    assert!(
        f.state.registration.hooks.before_fs.load(Ordering::Relaxed) > count,
        "positive control crosses actual pre-filesystem boundary"
    );
    if confirm {
        input["confirmation"] = body["confirmation"].clone();
    }
    input
}
async fn refused_matrix(
    f: &Fixture,
    observer: &Observer,
    input: serde_json::Value,
    confirm: bool,
    cases: Vec<(String, HeaderMap, StatusCode)>,
) -> Vec<String> {
    let before = f.config_bytes();
    observer.events(); // drain our snapshot read, not a handler event
    let mut failures = Vec::new();
    for (label, headers, expected) in cases {
        // why: long ambiguity matrices must reach their security branch rather than
        // being masked by a previously charged authorized request's rate window.
        f.state
            .registration
            .budget
            .lock()
            .expect("controlled window")
            .window = Instant::now() - Duration::from_secs(61);
        let boundary = f.state.registration.hooks.before_fs.load(Ordering::Relaxed);
        let (status, body, no_store) = response(f, headers, input.clone(), confirm).await;
        let events = observer.events();
        let entered = f.state.registration.hooks.before_fs.load(Ordering::Relaxed) - boundary;
        let error = if expected == StatusCode::BAD_REQUEST {
            "invalid_request"
        } else {
            "not_found"
        };
        let ok = status == expected
            && body == serde_json::json!({"error":error})
            && no_store
            && events == 0
            && entered == 0;
        println!(
            "STRICT-CASE {label} confirm={confirm} status={status} inotify={events} fs_boundary={entered} ok={ok}"
        );
        if !ok {
            failures.push(format!("{label}: status={status} no_store={no_store} inotify={events} fs_boundary={entered}"));
        }
    }
    if !failures.is_empty() {
        return failures;
    }
    f.assert_unpublished(&before);
    // Denials must not consume a genuine receipt or make valid registration unavailable.
    if confirm {
        assert_eq!(
            response(f, f.headers.clone(), input, true).await.0,
            StatusCode::CREATED
        );
        assert!(
            observer.events() > 0,
            "authorized register positive control"
        );
    }
    failures
}
fn value(text: &str) -> HeaderValue {
    HeaderValue::from_str(text).expect("literal header fixture")
}

#[tokio::test]
async fn f1_duplicate_session_credentials_refuse_both_endpoints_before_storage() {
    let mut failures = Vec::new();
    for new in [false, true] {
        for confirm in [false, true] {
            let f = Fixture::new();
            let observer = Observer::new(&f);
            let input = actionable(&f, &observer, new, confirm).await;
            let valid = f.headers[header::COOKIE].to_str().expect("cookie");
            let other = f.spare[header::COOKIE]
                .to_str()
                .expect("second genuine cookie");
            let mut cases = Vec::new();
            for (label, a, b) in [
                ("valid-invalid", valid, "mb_session=invalid"),
                ("invalid-valid", "mb_session=invalid", valid),
                ("different-genuine", valid, other),
                ("different-genuine-reversed", other, valid),
                ("repeated-genuine", valid, valid),
            ] {
                for across in [false, true] {
                    let mut h = f.headers.clone();
                    if across {
                        h.insert(header::COOKIE, value(a));
                        h.append(header::COOKIE, value(b));
                    } else {
                        h.insert(header::COOKIE, value(&format!("{a}; {b}")));
                    }
                    cases.push((
                        format!("{label}-across={across}-new={new}"),
                        h,
                        StatusCode::NOT_FOUND,
                    ));
                }
            }
            for token in [
                format!("{valid} "),
                valid.replace("mb_session=", "mb_session= "),
            ] {
                let mut h = f.headers.clone();
                h.insert(header::COOKIE, value(&token));
                cases.push((
                    format!("token-not-normalized-new={new}"),
                    h,
                    StatusCode::NOT_FOUND,
                ));
            }
            for authorization in ["", "Bearer invalid"] {
                let mut h = f.headers.clone();
                h.append(header::AUTHORIZATION, value(authorization));
                cases.push((
                    format!("any-authorization-new={new}"),
                    h,
                    StatusCode::NOT_FOUND,
                ));
            }
            failures.extend(refused_matrix(&f, &observer, input, confirm, cases).await);
        }
    }
    assert!(
        failures.is_empty(),
        "strict no-storage refusal matrix failed: {failures:?}"
    );
}
#[tokio::test]
async fn f1_duplicate_single_valued_security_headers_refuse_both_endpoints_before_storage() {
    let mut failures = Vec::new();
    for new in [false, true] {
        for confirm in [false, true] {
            let f = Fixture::new();
            let observer = Observer::new(&f);
            let input = actionable(&f, &observer, new, confirm).await;
            let mut cases = Vec::new();
            for (a, b) in [
                ("application/json", "text/plain"),
                ("text/plain", "application/json"),
                ("application/json", "application/json"),
            ] {
                let mut h = f.headers.clone();
                h.insert(header::CONTENT_TYPE, value(a));
                h.append(header::CONTENT_TYPE, value(b));
                cases.push((
                    format!("content-type-{a}-{b}-new={new}"),
                    h,
                    StatusCode::BAD_REQUEST,
                ));
            }
            let mut h = f.headers.clone();
            h.remove(header::CONTENT_TYPE);
            cases.push((
                format!("missing-content-type-new={new}"),
                h,
                StatusCode::BAD_REQUEST,
            ));
            for (a, b) in [
                ("same-origin", "cross-site"),
                ("cross-site", "same-origin"),
                ("same-origin", "same-origin"),
            ] {
                let mut h = f.headers.clone();
                h.insert("sec-fetch-site", value(a));
                h.append("sec-fetch-site", value(b));
                cases.push((
                    format!("sec-fetch-site-{a}-{b}-new={new}"),
                    h,
                    StatusCode::NOT_FOUND,
                ));
            }
            failures.extend(refused_matrix(&f, &observer, input, confirm, cases).await);
        }
    }
    assert!(
        failures.is_empty(),
        "strict no-storage refusal matrix failed: {failures:?}"
    );
}
#[tokio::test]
async fn f1_unambiguous_session_with_unrelated_multi_cookie_fields_remains_accepted() {
    for new in [false, true] {
        let f = Fixture::new();
        let mut h = f.headers.clone();
        let credential = h[header::COOKIE].to_str().expect("cookie").to_owned();
        h.insert(header::COOKIE, value("theme=dark; other=one"));
        h.append(
            header::COOKIE,
            value(&format!(" unrelated=two; {credential}; locale=en")),
        );
        h.append(header::COOKIE, value("extra=three"));
        h.insert("sec-fetch-site", value("same-origin"));
        let mut input = f.input(new);
        let (status, body, _) = response(&f, h.clone(), input.clone(), false).await;
        assert_eq!(status, StatusCode::OK);
        input["confirmation"] = body["confirmation"].clone();
        assert_eq!(response(&f, h, input, true).await.0, StatusCode::CREATED);
    }
}

#[tokio::test]
async fn f2_literal_host_and_raw_origin_refuse_both_endpoints_before_storage() {
    let mut failures = Vec::new();
    for new in [false, true] {
        for confirm in [false, true] {
            let f = Fixture::new();
            let observer = Observer::new(&f);
            let input = actionable(&f, &observer, new, confirm).await;
            let mut cases = Vec::new();
            for host in [
                "localhost/path",
                "user@localhost",
                "localhost?query",
                "localhost#fragment",
                "localhost\\",
                " localhost",
                "localhost ",
                "localhost\t",
                "%6cocalhost",
                "localhost:",
                "localhost:99999",
                "localhost:+80",
                "[::1",
                "::1",
                "[::1]extra",
            ] {
                let mut h = f.headers.clone();
                h.insert(header::HOST, value(host));
                cases.push((format!("host={host:?}-new={new}"), h, StatusCode::NOT_FOUND));
            }
            for (host, origin) in [
                ("127.1", "http://127.0.0.1"),
                ("0x7f000001", "http://127.0.0.1"),
                ("127.000.000.001", "http://127.0.0.1"),
            ] {
                let mut h = f.headers.clone();
                h.insert(header::HOST, value(host));
                h.insert(header::ORIGIN, value(origin));
                cases.push((
                    format!("repaired-host={host}-new={new}"),
                    h,
                    StatusCode::NOT_FOUND,
                ));
            }
            for origin in [
                "http://localhost/path",
                "http://localhost/.",
                "http://localhost/..",
                "http://localhost/%2e",
                "http://localhost/%2e%2e",
                "http://localhost/a/..",
                "http://localhost\\",
                "http://localhost\\.",
                "http://localhost?query",
                "http://localhost#fragment",
                "http://user@localhost",
                "http:///localhost",
                "http:////localhost",
                "http://%6cocalhost",
                " http://localhost",
                "http://localhost ",
                "http://localhost\t",
            ] {
                let mut h = f.headers.clone();
                h.insert(header::ORIGIN, value(origin));
                cases.push((
                    format!("raw-origin={origin:?}-new={new}"),
                    h,
                    StatusCode::NOT_FOUND,
                ));
            }
            for name in [header::ORIGIN, header::HOST] {
                let mut h = f.headers.clone();
                h.append(name.clone(), h[&name].clone());
                cases.push((
                    format!("repeated-{name}-new={new}"),
                    h,
                    StatusCode::NOT_FOUND,
                ));
            }
            failures.extend(refused_matrix(&f, &observer, input, confirm, cases).await);
        }
    }
    assert!(
        failures.is_empty(),
        "strict no-storage refusal matrix failed: {failures:?}"
    );
}
#[tokio::test]
async fn f2_valid_literal_authorities_and_origin_defaults_remain_accepted() {
    for (host, origin) in [
        ("localhost", "http://localhost"),
        ("localhost:80", "http://localhost/"),
        ("localhost", "http://localhost:80"),
        ("localhost:443", "https://localhost"),
        ("localhost:9010", "http://localhost:9010"),
        ("example.test", "https://example.test/"),
        ("EXAMPLE.test", "HTTPS://example.test"),
        ("127.0.0.1:9010", "http://127.0.0.1:9010"),
        ("[::1]", "http://[::1]"),
        ("[::1]:9010", "http://[::1]:9010/"),
        ("[0:0:0:0:0:0:0:1]:443", "https://[::1]"),
        ("xn--bcher-kva.test", "https://xn--bcher-kva.test"),
    ] {
        let f = Fixture::new();
        let mut h = f.headers.clone();
        h.insert(header::HOST, value(host));
        h.insert(header::ORIGIN, value(origin));
        let mut input = f.input(false);
        let (status, body, _) = response(&f, h.clone(), input.clone(), false).await;
        assert_eq!(status, StatusCode::OK, "{host} / {origin}: {body}");
        input["confirmation"] = body["confirmation"].clone();
        assert_eq!(
            response(&f, h, input, true).await.0,
            StatusCode::CREATED,
            "{host} / {origin}"
        );
        println!("STRICT-VALID host={host} origin={origin} both-endpoints=ok");
    }
}
async fn graph(f: &Fixture, headers: HeaderMap) -> (StatusCode, String) {
    let r = vault_graph(
        State(f.state.clone()),
        AxumPath("project".into()),
        Query(serde_json::from_value(serde_json::json!({"limit":2000})).expect("query")),
        headers,
    )
    .await;
    let status = r.status();
    let body = axum::body::to_bytes(r.into_body(), 65536)
        .await
        .expect("body");
    (status, String::from_utf8(body.to_vec()).expect("JSON"))
}
async fn audit_commit(audit: Option<bool>) {
    let mut truthful = Vec::new();
    for new in [false, true] {
        let f = Fixture::with_optional_audit(audit);
        let public = f.dir.path().join("Projects/Public");
        let policy = b"# restrictive existing bytes\n[[members]]\nuser='spare'\nrole='owner'\n";
        std::fs::write(public.join("access.toml"), policy).expect("existing restrictive ACL");
        let binary = b"code\0\xffbytes";
        std::fs::write(public.join("program.bin"), binary).expect("mixed project file");
        let original = std::fs::read(public.join("Readme.md")).expect("note snapshot");
        let input = f.confirmed(new).await;
        let (status, body) = f.call(input, true).await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(body["committed"], true);
        assert_eq!(body["index_ready"], true);
        assert_eq!(body["watched"], true);
        // Continue all actual-state checks even against the original fictitious receipt.
        let flag = body["audit_recorded"] == serde_json::json!(audit == Some(false));
        assert_eq!(f.state.len(), 1);
        let config = crate::ServerConfig::load(&f.dir.path().join("server.toml"))
            .expect("fresh persistent config");
        assert_eq!(config.vaults.len(), 1);
        assert_eq!(config.vaults[0].slug, "project");
        let root = f.dir.path().join(if new {
            "Projects/New"
        } else {
            "Projects/Public"
        });
        assert_eq!(config.vaults[0].path, root.to_str().expect("path"));
        let slug = Slug::parse("project").expect("slug");
        let path = mb_core::NotePath::parse("Readme.md").expect("path");
        let actor = Username::parse("alice").expect("actor");
        assert_eq!(
            f.state
                .access_for(&slug)
                .expect("live policy")
                .effective_role(&actor, &path),
            if new {
                mb_core::Role::Owner
            } else {
                mb_core::Role::None
            }
        );
        assert_eq!(
            std::fs::read(public.join("access.toml")).expect("preserved ACL"),
            policy
        );
        assert_eq!(
            std::fs::read(public.join("Readme.md")).expect("preserved Markdown"),
            original
        );
        assert_eq!(
            std::fs::read(public.join("program.bin")).expect("preserved binary"),
            binary
        );
        assert!(!root.join("notes").exists());
        let owner_headers = if new {
            f.headers.clone()
        } else {
            f.spare.clone()
        };
        let (code, body) = graph(&f, owner_headers.clone()).await;
        assert_eq!(code, StatusCode::OK);
        if !new {
            assert!(body.contains("Note"));
            assert_eq!(graph(&f, f.headers.clone()).await.0, StatusCode::NOT_FOUND);
        }
        let audit_path = f.dir.path().join("audit.log");
        match audit {
            None => assert!(!audit_path.exists(), "absent writer performed no append"),
            Some(false) => {
                let text = std::fs::read_to_string(&audit_path)
                    .expect("actual successful append readback");
                let events: Vec<serde_json::Value> = text
                    .lines()
                    .map(|line| serde_json::from_str(line).expect("audit JSON line"))
                    .collect();
                assert_eq!(events.len(), 1);
                assert_eq!(events[0]["action"], "vault_created");
                assert_eq!(events[0]["actor"], "alice");
                assert_eq!(events[0]["vault"], "project");
                assert_eq!(events[0]["targets"], serde_json::json!(["project"]));
                assert_eq!(events[0]["result"], "success");
                assert!(
                    events[0]["timestamp"]
                        .as_str()
                        .expect("timestamp")
                        .parse::<u64>()
                        .expect("time")
                        > 0
                );
                println!(
                    "AUDIT-READBACK new={new} action=vault_created actor=alice vault=project targets=project result=success lines=1"
                );
            }
            Some(true) => {
                let vault = f
                    .state
                    .vaults
                    .read()
                    .expect("registry")
                    .get(&slug)
                    .expect("vault")
                    .clone();
                let error = f
                    .state
                    .audit_note(AuditAction::VaultCreated, &actor, &vault, "project")
                    .expect_err("genuinely failing writer");
                assert!(error.to_string().contains("writing audit log"));
                assert!(audit_path.is_dir());
                assert_eq!(
                    std::fs::read_dir(&audit_path).expect("directory").count(),
                    0
                );
                println!("AUDIT-APPEND-FAILURE new={new} actual_error={error}");
            }
        }
        // Actual enrolled watcher event and normal filtered index maintenance, not a vector/flag.
        let _ = f.signal.take();
        let changed = root.join("Event.md");
        std::fs::write(&changed, "# AuditWatcherEvent\n").expect("external event");
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let generation = f.signal.generation();
                if f.signal.pending_path(&changed) {
                    break;
                }
                f.signal.changed_after(generation).await;
            }
        })
        .await
        .expect("real registered watcher callback");
        let changes = f.signal.take();
        assert!(matches!(&changes,Changes::Only(paths) if paths.contains(&changed)));
        let state = f.state.clone();
        tokio::task::spawn_blocking(move || {
            assert!(state.maintain_sync(&changes).is_empty());
            assert!(state.maintain_index(&changes).is_empty());
        })
        .await
        .expect("normal index maintenance");
        assert!(
            graph(&f, owner_headers)
                .await
                .1
                .contains("AuditWatcherEvent")
        );
        println!(
            "AUDIT-STATE new={new} optional={audit:?} committed=fresh live-policy=ok index=ok actual-watch=ok preserved=ok truthful={flag}"
        );
        truthful.push(flag);
    }
    assert!(
        truthful.iter().all(|flag| *flag),
        "audit receipt must distinguish absence from actual successful append"
    );
}
#[tokio::test]
async fn f3_absent_audit_writer_commits_live_and_reports_false() {
    audit_commit(None).await;
}
#[tokio::test]
async fn f3_working_audit_writer_commits_live_and_reports_actual_readback() {
    audit_commit(Some(false)).await;
}
#[tokio::test]
async fn f3_failing_audit_writer_commits_live_and_reports_false() {
    audit_commit(Some(true)).await;
}
