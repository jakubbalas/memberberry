#![allow(
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::panic,
    clippy::indexing_slicing
)] // why: controlled JSON/array fixtures, test-only synchronization and assertions.
use super::*;
#[path = "tests/directories.rs"]
mod directory_cases;
mod faults;
mod policy_layout;
mod running;
mod strict;
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum Phase {
    BeforeFs,
    BeforeMutation,
    AfterStorageCheck,
    BeforePolicy,
    BeforeCommit,
    FinalAuthorization,
    AfterCommit,
    Published,
    Finished,
    Serving,
    Maintenance,
    Stopped,
}
#[derive(Debug, Default)]
pub(super) struct Hooks {
    pub(super) before_fs: std::sync::atomic::AtomicUsize,
    pub(super) staged: Mutex<Option<Arc<WatchSignal>>>,
    pub(super) clock_advance: Mutex<Duration>,
    pub(super) commit_fault: Mutex<storage::test_io::Fault>,
    pub(super) policy_fault: Mutex<storage::test_io::Fault>,
    pub(super) config_fault: Mutex<storage::test_io::Fault>,
    pub(super) disable_sweeps: AtomicBool,
    pub(super) maintenance_completed: Mutex<Option<tokio::sync::mpsc::Sender<Changes>>>,
    pauses: Mutex<
        BTreeMap<
            Phase,
            (
                tokio::sync::oneshot::Sender<()>,
                std::sync::mpsc::Receiver<()>,
            ),
        >,
    >,
}
impl Hooks {
    pub(super) fn pause(&self, phase: Phase) {
        let pause = self.pauses.lock().expect("hooks").remove(&phase);
        if let Some((ready, release)) = pause {
            let _ = ready.send(());
            release.recv().expect("controlled release");
        }
    }
    fn arm(
        &self,
        phase: Phase,
    ) -> (
        tokio::sync::oneshot::Receiver<()>,
        std::sync::mpsc::Sender<()>,
    ) {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        assert!(
            self.pauses
                .lock()
                .expect("hooks")
                .insert(phase, (tx, wait))
                .is_none()
        );
        (rx, release)
    }
}
struct Fixture {
    dir: tempfile::TempDir,
    state: Arc<AppState>,
    headers: HeaderMap,
    spare: HeaderMap,
    admin: mb_auth::UserId,
    session: mb_auth::SessionToken,
    signal: Arc<WatchSignal>,
    _lease: Option<crate::watch::WatchLease>,
}
impl Fixture {
    fn new() -> Self {
        Self::with_audit(false)
    }
    fn with_audit(audit_failure: bool) -> Self {
        Self::with_optional_audit(audit_failure.then_some(true))
    }
    fn with_optional_audit(audit_failure: Option<bool>) -> Self {
        let dir = tempfile::tempdir().expect("fixture");
        let projects = dir.path().join("Projects");
        std::fs::create_dir_all(projects.join("Public")).expect("project");
        std::fs::write(
            projects.join("Public/Readme.md"),
            "# Note\nOriginal bytes\n",
        )
        .expect("note");
        std::fs::write(
            dir.path().join("server.toml"),
            format!(
                "[[vault_locations]]\nid='projects'\nname='Projects'\npath='{}'\n",
                projects.display()
            ),
        )
        .expect("config");
        let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth");
        let user = auth
            .setup_first_user(mb_auth::NewUser {
                username: "alice",
                display_name: "Alice",
                password: "correct horse battery staple",
            })
            .expect("user");
        let spare = auth
            .create_user(mb_auth::NewUser {
                username: "spare",
                display_name: "Spare",
                password: "correct horse battery staple",
            })
            .expect("spare");
        auth.set_admin(spare.id, true).expect("admin");
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("localhost"));
        headers.insert(header::ORIGIN, HeaderValue::from_static("http://localhost"));
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        let session = auth
            .create_session(user.id, 4_102_444_800)
            .expect("session");
        headers.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!(
                "mb_session={}",
                auth.signed_session_cookie(&session).expect("cookie")
            ))
            .expect("header"),
        );
        let mut spare_headers = headers.clone();
        let spare_session = auth
            .create_session(spare.id, 4_102_444_800)
            .expect("session");
        spare_headers.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!(
                "mb_session={}",
                auth.signed_session_cookie(&spare_session).expect("cookie")
            ))
            .expect("header"),
        );
        let audit = audit_failure.map(|failure| {
            if failure {
                std::fs::create_dir(dir.path().join("audit.log")).expect("actual append fault");
            }
            crate::audit::AuditLog::new(dir.path(), 1024 * 1024).expect("audit writer")
        });
        let state = Arc::new(
            AppState::authenticated_with_audit(vec![], auth, audit)
                .expect("state")
                .with_vault_management(dir.path().join("server.toml"), false)
                .expect("management"),
        );
        let signal = Arc::new(WatchSignal::default());
        let (lease, problems) = state.start_watching(signal.clone()).expect("watchers");
        assert!(problems.is_empty());
        Self {
            dir,
            state,
            headers,
            spare: spare_headers,
            admin: user.id,
            session,
            signal,
            _lease: Some(lease),
        }
    }
    fn input(&self, new: bool) -> serde_json::Value {
        if new {
            serde_json::json!({"mode":"new","path":"","directory":"New","slug":"project","name":"Project"})
        } else {
            serde_json::json!({"mode":"existing","path":"Public","slug":"project","name":"Project"})
        }
    }
    fn request(
        headers: HeaderMap,
        body: serde_json::Value,
        confirm: bool,
    ) -> axum::extract::Request {
        let mut request = axum::extract::Request::builder()
            .method("POST")
            .uri(if confirm {
                "/api/v1/vault-locations/projects/register"
            } else {
                "/api/v1/vault-locations/projects/preview"
            })
            .body(axum::body::Body::from(body.to_string()))
            .expect("request");
        *request.headers_mut() = headers;
        request
    }
    async fn call(
        &self,
        input: serde_json::Value,
        confirm: bool,
    ) -> (StatusCode, serde_json::Value) {
        let response = handle(
            self.state.clone(),
            Self::request(self.headers.clone(), input, confirm),
            confirm,
        )
        .await;
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 8192)
            .await
            .expect("body");
        (status, serde_json::from_slice(&bytes).expect("json"))
    }
    async fn confirmed(&self, new: bool) -> serde_json::Value {
        let mut input = self.input(new);
        let (status, body) = self.call(input.clone(), false).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        input["confirmation"] = body["confirmation"].clone();
        input
    }
    fn config_bytes(&self) -> Vec<u8> {
        std::fs::read(self.dir.path().join("server.toml")).expect("config")
    }
    fn assert_unpublished(&self, bytes: &[u8]) {
        assert_eq!(self.state.len(), 0);
        assert_eq!(self.config_bytes(), bytes);
        assert!(
            crate::ServerConfig::load(&self.dir.path().join("server.toml"))
                .expect("fresh config")
                .vaults
                .is_empty()
        );
    }
}
async fn wait(ready: tokio::sync::oneshot::Receiver<()>) {
    tokio::time::timeout(Duration::from_secs(10), ready)
        .await
        .expect("bounded barrier")
        .expect("arrived");
}
fn spawn(
    f: &Fixture,
    input: serde_json::Value,
    confirm: bool,
) -> tokio::task::JoinHandle<Response> {
    let state = f.state.clone();
    let headers = f.headers.clone();
    tokio::spawn(
        async move { handle(state, Fixture::request(headers, input, confirm), confirm).await },
    )
}

#[tokio::test]
async fn commit_holds_current_actor_authorization_until_atomic_registry_and_live_publication_complete()
 {
    for new in [false, true] {
        let f = Fixture::new();
        let input = f.confirmed(new).await;
        let (final_ready, final_release) =
            f.state.registration.hooks.arm(Phase::FinalAuthorization);
        let (commit_ready, commit_release) = f.state.registration.hooks.arm(Phase::AfterCommit);
        let (finished_ready, finished_release) = f.state.registration.hooks.arm(Phase::Finished);
        let task = spawn(&f, input, true);
        wait(final_ready).await;
        let held_before = matches!(
            f.state.security.auth.try_lock(),
            Err(std::sync::TryLockError::WouldBlock)
        );
        let (attempted, attempt) = std::sync::mpsc::channel();
        let state = f.state.clone();
        let admin = f.admin;
        let revocation = std::thread::spawn(move || {
            attempted.send(()).expect("attempt queued");
            state
                .security
                .auth
                .lock()
                .expect("serialized auth")
                .set_admin(admin, false)
                .expect("demotion");
        });
        attempt.recv().expect("revocation starts before rename");
        final_release.send(()).expect("commit");
        wait(commit_ready).await;
        let held_after = matches!(
            f.state.security.auth.try_lock(),
            Err(std::sync::TryLockError::WouldBlock)
        );
        commit_release.send(()).expect("publish");
        wait(finished_ready).await;
        revocation
            .join()
            .expect("queued demotion finishes after publication");
        finished_release.send(()).expect("respond");
        assert_eq!(
            task.await.expect("response").status(),
            StatusCode::NOT_FOUND,
            "now demoted actor receives neutral response even though authorized commit completed"
        );
        assert!(
            held_before && held_after,
            "current authority must remain locked through actual config rename and coherent live publication, not merely checked before I/O"
        );
        assert_eq!(f.state.len(), 1);
        assert_eq!(
            crate::ServerConfig::load(&f.dir.path().join("server.toml"))
                .expect("fresh config")
                .vaults
                .len(),
            1
        );
        let root = f.dir.path().join(if new {
            "Projects/New"
        } else {
            "Projects/Public"
        });
        assert!(root.join("access.toml").is_file());
        assert!(!root.join("notes").exists());
    }
}

#[test]
fn literal_json_paths_are_not_recursively_decoded_and_mode_mixtures_refuse() {
    let uri = "/api/v1/vault-locations/projects/preview"
        .parse()
        .expect("uri");
    let selection = parse(
        &uri,
        br#"{"mode":"existing","path":"%2e%2e","slug":"project","name":"Project"}"#,
        false,
    )
    .expect("literal")
    .0;
    assert_eq!(selection.path.as_str(), "%2e%2e");
    let literal = serde_json::json!({"mode":"existing","path":"e\u{301}","slug":"project","name":"  e\u{301} Project  "});
    let literal = parse(&uri, literal.to_string().as_bytes(), false)
        .expect("literal values")
        .0;
    assert_eq!(literal.path.as_str(), "e\u{301}");
    assert_eq!(literal.name, "  e\u{301} Project  ");
    for extra in [
        "\"directory\":\"child\"",
        "\"directory\":null",
        "\"confirmation\":null",
        "\"name\":\"duplicate\"",
        "\"user\":\"alice\"",
        "\"role\":\"owner\"",
    ] {
        let raw = format!(
            "{{\"mode\":\"existing\",\"path\":\"Public\",\"slug\":\"project\",\"name\":\"Project\",{extra}}}"
        );
        assert!(parse(&uri, raw.as_bytes(), false).is_err(), "{extra}");
    }
    for path in [
        "../secret",
        "/etc",
        "Hidden/.secret",
        "C:drive",
        "Public\\else",
        "Public/",
        "Public//Child",
        "\u{0}",
    ] {
        let raw =
            serde_json::json!({"mode":"existing","path":path,"slug":"project","name":"Project"});
        assert!(parse(&uri, raw.to_string().as_bytes(), false).is_err());
    }
}
#[test]
fn explicit_request_limits_and_query_aliases_refuse_before_fs() {
    let uri = "/api/v1/vault-locations/projects/preview"
        .parse()
        .expect("uri");
    for path in [
        "a".repeat(1025),
        vec!["a".repeat(200); 6].join("/"),
        vec!["a"; 17].join("/"),
    ] {
        let raw =
            serde_json::json!({"mode":"existing","path":path,"slug":"project","name":"Project"});
        assert!(matches!(
            parse(&uri, raw.to_string().as_bytes(), false),
            Err(Refusal::Limit)
        ));
    }
    let raw = serde_json::json!({"mode":"existing","path":"Public","slug":"project","name":"x".repeat(257)});
    assert!(matches!(
        parse(&uri, raw.to_string().as_bytes(), false),
        Err(Refusal::Limit)
    ));
    let raw = serde_json::json!({"mode":"new","path":"","directory":"x".repeat(256),"slug":"project","name":"Project"});
    assert!(matches!(
        parse(&uri, raw.to_string().as_bytes(), false),
        Err(Refusal::Limit)
    ));
    let mut oversized =
        br#"{"mode":"existing","path":"Public","slug":"project","name":"Project"}"#.to_vec();
    oversized.resize(8193, b' ');
    assert!(matches!(
        parse(&uri, &oversized, false),
        Err(Refusal::Limit)
    ));
    let raw = serde_json::json!({"mode":"new","path":vec!["a";16].join("/"),"directory":"Child","slug":"project","name":"Project"});
    assert!(matches!(
        parse(&uri, raw.to_string().as_bytes(), false),
        Err(Refusal::Limit)
    ));
    for uri in [
        "/api/v1/vault-locations/projects/preview?path=Public",
        "/api/v1/vault-locations/%70rojects/preview",
    ] {
        assert!(matches!(
            parse(
                &uri.parse().expect("uri"),
                br#"{"mode":"existing","path":"Public","slug":"project","name":"Project"}"#,
                false
            ),
            Err(Refusal::Invalid)
        ));
    }
}
#[tokio::test]
async fn unauthorized_and_wrong_origin_cannot_reach_config_or_filesystem() {
    let f = Fixture::new();
    for credentials in [None, Some("invalid"), Some("Bearer admin")] {
        let mut headers = f.headers.clone();
        headers.remove(header::COOKIE);
        if let Some(credentials) = credentials {
            headers.insert(
                header::AUTHORIZATION,
                HeaderValue::from_str(credentials).expect("header"),
            );
        }
        let response = handle(
            f.state.clone(),
            Fixture::request(headers, f.input(false), false),
            false,
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
    let mut headers = f.headers.clone();
    headers.remove(header::ORIGIN);
    assert_eq!(
        handle(
            f.state.clone(),
            Fixture::request(headers, f.input(true), false),
            false
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        f.state.registration.hooks.before_fs.load(Ordering::Relaxed),
        0
    );
    assert_eq!(f.call(f.input(false), false).await.0, StatusCode::OK);
    assert_eq!(
        f.state.registration.hooks.before_fs.load(Ordering::Relaxed),
        1,
        "positive observer"
    );
}
#[tokio::test]
async fn demotion_while_waiting_refuses_before_any_fs() {
    let f = Fixture::new();
    let before = f.config_bytes();
    let (ready, release) = f.state.registration.hooks.arm(Phase::BeforeFs);
    let task = spawn(&f, f.input(true), false);
    wait(ready).await;
    f.state
        .security
        .auth
        .lock()
        .expect("auth")
        .set_admin(f.admin, false)
        .expect("demote");
    release.send(()).expect("release");
    assert_eq!(task.await.expect("join").status(), StatusCode::NOT_FOUND);
    assert_eq!(
        f.state.registration.hooks.before_fs.load(Ordering::Relaxed),
        0
    );
    f.assert_unpublished(&before);
}
#[tokio::test]
async fn demotion_before_commit_rolls_back_prepared_policy_and_root() {
    let f = Fixture::new();
    let before = f.config_bytes();
    let input = f.confirmed(true).await;
    let (ready, release) = f.state.registration.hooks.arm(Phase::BeforeCommit);
    let task = spawn(&f, input, true);
    wait(ready).await;
    assert!(
        f.dir.path().join("Projects/New/access.toml").is_file(),
        "actual preparation"
    );
    f.state
        .security
        .auth
        .lock()
        .expect("auth")
        .set_admin(f.admin, false)
        .expect("demote");
    release.send(()).expect("release");
    assert_eq!(task.await.expect("join").status(), StatusCode::NOT_FOUND);
    assert!(!f.dir.path().join("Projects/New").exists());
    f.assert_unpublished(&before);
}
#[tokio::test]
async fn cancellation_before_mutation_aborts_without_new_root() {
    let f = Fixture::new();
    let before = f.config_bytes();
    let input = f.confirmed(true).await;
    let (ready, release) = f.state.registration.hooks.arm(Phase::BeforeMutation);
    let (finished, done) = f.state.registration.hooks.arm(Phase::Finished);
    let task = spawn(&f, input, true);
    wait(ready).await;
    task.abort();
    assert!(task.await.expect_err("cancelled").is_cancelled());
    release.send(()).expect("release");
    wait(finished).await;
    done.send(()).expect("done");
    f.assert_unpublished(&before);
    assert!(!f.dir.path().join("Projects/New").exists());
}
#[tokio::test]
async fn committed_job_finishes_live_publication_after_http_waiter_disappears() {
    let f = Fixture::new();
    let input = f.confirmed(true).await;
    let (ready, release) = f.state.registration.hooks.arm(Phase::AfterCommit);
    let (published, done) = f.state.registration.hooks.arm(Phase::Published);
    let task = spawn(&f, input, true);
    wait(ready).await;
    assert_eq!(
        crate::ServerConfig::load(&f.dir.path().join("server.toml"))
            .expect("fresh disk")
            .vaults
            .len(),
        1
    );
    task.abort();
    assert!(task.await.expect_err("cancelled").is_cancelled());
    release.send(()).expect("release");
    wait(published).await;
    assert_eq!(f.state.len(), 1);
    assert!(f.dir.path().join("Projects/New/access.toml").is_file());
    assert!(
        f.state
            .watchers
            .0
            .lock()
            .expect("watchers")
            .as_ref()
            .expect("running")
            .roots
            .keys()
            .any(|p| p.ends_with("New"))
    );
    done.send(()).expect("done");
}
#[tokio::test]
async fn confirmation_is_session_bound_expiring_and_single_use() {
    let f = Fixture::new();
    let before = f.config_bytes();
    let input = f.confirmed(false).await;
    let response = handle(
        f.state.clone(),
        Fixture::request(f.spare.clone(), input.clone(), true),
        true,
    )
    .await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(
        f.call(input, true).await.0,
        StatusCode::CONFLICT,
        "consumed mismatched receipt"
    );
    let input = f.confirmed(false).await;
    for r in f
        .state
        .registration
        .receipts
        .lock()
        .expect("receipts")
        .values_mut()
    {
        r.expires = Instant::now() - Duration::from_secs(1);
    }
    assert_eq!(f.call(input, true).await.0, StatusCode::CONFLICT);
    f.assert_unpublished(&before);
}
#[tokio::test]
async fn mode_location_parent_path_and_new_child_parameters_are_receipt_bound() {
    for new in [false, true] {
        for field in ["mode", "location", "path", "directory"] {
            if !new && field == "directory" {
                continue;
            }
            let f = Fixture::new();
            let projects = f.dir.path().join("Projects");
            std::fs::create_dir(projects.join("Other")).expect("other safe selection");
            std::fs::write(projects.join("Other/Foreign.md"), b"# Foreign\n")
                .expect("foreign file");
            let mut config = String::from_utf8(f.config_bytes()).expect("fixture UTF-8");
            config.push_str(&format!(
                "\n[[vault_locations]]\nid='other'\nname='Other'\npath='{}'\n",
                projects.display()
            ));
            std::fs::write(f.dir.path().join("server.toml"), config)
                .expect("two aliases before preview");
            let before = f.config_bytes();
            let mut input = f.confirmed(new).await;
            match field {
                "mode" if new => {
                    input["mode"] = "existing".into();
                    input["path"] = "Public".into();
                    input.as_object_mut().expect("object").remove("directory");
                }
                "mode" => {
                    input["mode"] = "new".into();
                    input["directory"] = "Child".into();
                }
                "path" => input["path"] = "Other".into(),
                "directory" => input["directory"] = "Changed".into(),
                _ => {}
            }
            let mut request = Fixture::request(f.headers.clone(), input, true);
            if field == "location" {
                *request.uri_mut() = "/api/v1/vault-locations/other/register"
                    .parse()
                    .expect("exact other location");
            }
            assert_eq!(
                handle(f.state.clone(), request, true).await.status(),
                StatusCode::CONFLICT,
                "{field}, new={new}"
            );
            f.assert_unpublished(&before);
            for root in [&projects, &projects.join("Public"), &projects.join("Other")] {
                assert!(!root.join("access.toml").exists());
                for child in ["New", "Changed", "Child"] {
                    assert!(!root.join(child).exists());
                }
            }
            assert_eq!(
                std::fs::read(projects.join("Other/Foreign.md")).expect("preserved"),
                b"# Foreign\n"
            );
        }
    }
}
#[tokio::test]
async fn replaced_new_parent_and_retargeted_configured_alias_refuse_stale_confirmation() {
    for change in ["parent", "alias-existing", "alias-new"] {
        let f = Fixture::new();
        let projects = f.dir.path().join("Projects");
        let mut input = f.input(change != "alias-existing");
        let alias = f.dir.path().join("Alias");
        let alternate = f.dir.path().join("Alternate");
        if change == "parent" {
            std::fs::create_dir(projects.join("Parent")).expect("parent");
            input["path"] = "Parent".into();
        } else {
            std::fs::create_dir_all(alternate.join("Public")).expect("alternate");
            std::os::unix::fs::symlink(&projects, &alias).expect("trusted configured alias");
            let config = String::from_utf8(f.config_bytes()).expect("UTF-8").replace(
                projects.to_str().expect("root"),
                alias.to_str().expect("alias"),
            );
            std::fs::write(f.dir.path().join("server.toml"), config).expect("alias before preview");
        }
        let before = f.config_bytes();
        let (status, body) = f.call(input.clone(), false).await;
        assert_eq!(status, StatusCode::OK);
        input["confirmation"] = body["confirmation"].clone();
        if change == "parent" {
            std::fs::rename(projects.join("Parent"), projects.join("MovedParent")).expect("move");
            std::fs::create_dir(projects.join("Parent")).expect("replace");
        } else {
            std::fs::remove_file(&alias).expect("retarget");
            std::os::unix::fs::symlink(&alternate, &alias).expect("different target");
        }
        assert_eq!(f.call(input, true).await.0, StatusCode::CONFLICT);
        f.assert_unpublished(&before);
        assert!(!projects.join("Parent/New").exists());
        assert!(!alternate.join("New").exists());
        assert!(!alternate.join("Public/access.toml").exists());
    }
}
#[tokio::test]
async fn changed_config_and_project_settings_bytes_refuse_even_with_same_directory_identity() {
    for change in ["server-config", "project-settings"] {
        let f = Fixture::new();
        let root = f.dir.path().join("Projects/Public");
        std::fs::create_dir(root.join(".memberberry")).expect("existing settings");
        let settings = root.join(".memberberry/config.toml");
        std::fs::write(&settings, b"# Original settings\n").expect("settings before preview");
        let input = f.confirmed(false).await;
        if change == "server-config" {
            let mut bytes = f.config_bytes();
            bytes.extend_from_slice(b"\n# external harmless comment\n");
            std::fs::write(f.dir.path().join("server.toml"), bytes)
                .expect("same parsed values different file");
        } else {
            std::fs::write(&settings, b"# External settings\n").expect("settings edit");
        }
        let before = f.config_bytes();
        let edited = std::fs::read(&settings).expect("current settings");
        assert_eq!(f.call(input, true).await.0, StatusCode::CONFLICT);
        f.assert_unpublished(&before);
        assert_eq!(std::fs::read(settings).expect("retained edit"), edited);
        assert!(!root.join("access.toml").exists());
    }
}
#[tokio::test]
async fn expiry_at_final_authority_boundary_rolls_back_without_atomic_commit() {
    for new in [false, true] {
        let f = Fixture::new();
        let before = f.config_bytes();
        let input = f.confirmed(new).await;
        let (ready, release) = f.state.registration.hooks.arm(Phase::FinalAuthorization);
        let task = spawn(&f, input, true);
        wait(ready).await;
        *f.state
            .registration
            .hooks
            .clock_advance
            .lock()
            .expect("clock") = TTL + Duration::from_secs(1);
        release.send(()).expect("expire before rename");
        assert_eq!(task.await.expect("reply").status(), StatusCode::CONFLICT);
        f.assert_unpublished(&before);
        assert!(!f.dir.path().join("Projects/New").exists());
        assert!(!f.dir.path().join("Projects/Public/access.toml").exists());
    }
}

#[tokio::test]
async fn changing_any_confirmed_parameter_refuses_before_policy_creation() {
    let f = Fixture::new();
    let before = f.config_bytes();
    for field in ["name", "slug"] {
        let mut input = f.confirmed(false).await;
        input[field] = "changed".into();
        assert_eq!(f.call(input, true).await.0, StatusCode::CONFLICT);
        assert!(!f.dir.path().join("Projects/Public/access.toml").exists());
    }
    f.assert_unpublished(&before);
}
#[tokio::test]
async fn changed_selection_notes_layout_or_policy_refuses_stale_preview() {
    for change in ["selection", "notes", "policy"] {
        let f = Fixture::new();
        let before = f.config_bytes();
        let input = f.confirmed(false).await;
        let project = f.dir.path().join("Projects/Public");
        match change {
            "selection" => {
                std::fs::rename(&project, project.with_file_name("Moved")).expect("move");
                std::fs::create_dir(&project).expect("replacement");
            }
            "notes" => std::fs::create_dir(project.join("notes")).expect("new notes"),
            _ => std::fs::write(
                project.join("access.toml"),
                "[[members]]\nuser='spare'\nrole='owner'\n",
            )
            .expect("foreign ACL"),
        }
        assert_eq!(f.call(input, true).await.0, StatusCode::CONFLICT);
        f.assert_unpublished(&before);
    }
}
#[tokio::test]
async fn policy_appearing_after_preparation_is_not_overwritten_or_deleted() {
    let f = Fixture::new();
    let before = f.config_bytes();
    let input = f.confirmed(false).await;
    let (ready, release) = f.state.registration.hooks.arm(Phase::BeforePolicy);
    let task = spawn(&f, input, true);
    wait(ready).await;
    let path = f.dir.path().join("Projects/Public/access.toml");
    let bytes = b"[[members]]\nuser='spare'\nrole='owner'\n";
    std::fs::write(&path, bytes).expect("racing policy");
    release.send(()).expect("release");
    assert_eq!(task.await.expect("join").status(), StatusCode::CONFLICT);
    assert_eq!(std::fs::read(path).expect("foreign retained"), bytes);
    assert_eq!(
        std::fs::read_dir(f.dir.path().join("Projects/Public"))
            .expect("entries")
            .count(),
        2,
        "only original note and foreign policy"
    );
    f.assert_unpublished(&before);
}
#[tokio::test]
async fn rollback_preserves_external_policy_edits_and_foreign_files_in_new_root() {
    let f = Fixture::new();
    let before = f.config_bytes();
    let input = f.confirmed(true).await;
    let (ready, release) = f.state.registration.hooks.arm(Phase::BeforeCommit);
    let task = spawn(&f, input, true);
    wait(ready).await;
    let project = f.dir.path().join("Projects/New");
    let bytes = b"[[members]]\nuser='spare'\nrole='owner'\n";
    std::fs::write(project.join("Foreign.bin"), b"foreign").expect("foreign");
    std::fs::write(project.join("access.toml"), bytes).expect("edit policy");
    release.send(()).expect("release");
    assert_eq!(
        task.await.expect("join").status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        std::fs::read(project.join("Foreign.bin")).expect("retained"),
        b"foreign"
    );
    assert_eq!(
        std::fs::read(project.join("access.toml")).expect("retained"),
        bytes
    );
    f.assert_unpublished(&before);
}
#[test]
fn metadata_only_confirmation_capacity_and_admission_are_bounded() {
    let gate = RegistrationGate::new();
    let first = gate.enter().expect("one");
    let second = gate.enter().expect("two");
    assert!(matches!(gate.enter(), Err(Refusal::Busy)));
    drop(first);
    drop(second);
    assert_eq!(gate.slots.available_permits(), 2);
}

#[tokio::test]
async fn confirmation_capacity_refuses_without_unbounded_metadata_or_descriptors() {
    let f = Fixture::new();
    for _ in 0..RECEIPTS {
        // Controlled window advance, never a sleep or bypass of the capacity guard.
        f.state.registration.budget.lock().expect("budget").window =
            Instant::now() - Duration::from_secs(61);
        assert_eq!(f.call(f.input(false), false).await.0, StatusCode::OK);
    }
    f.state.registration.budget.lock().expect("budget").window =
        Instant::now() - Duration::from_secs(61);
    assert_eq!(
        f.call(f.input(false), false).await.0,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        f.state
            .registration
            .receipts
            .lock()
            .expect("receipts")
            .len(),
        RECEIPTS
    );
}
#[tokio::test]
async fn actual_audit_append_failure_reports_committed_without_rollback() {
    let f = Fixture::with_audit(true);
    let input = f.confirmed(true).await;
    let (status, body) = f.call(input, true).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["committed"], true);
    assert_eq!(body["audit_recorded"], false);
    assert_eq!(f.state.len(), 1);
    assert_eq!(
        crate::ServerConfig::load(&f.dir.path().join("server.toml"))
            .expect("fresh disk")
            .vaults
            .len(),
        1
    );
    assert!(f.dir.path().join("Projects/New/access.toml").is_file());
}
#[tokio::test]
async fn acl_edited_after_commit_is_not_mistaken_for_the_prepared_policy_stamp() {
    let f = Fixture::new();
    let input = f.confirmed(false).await;
    let (ready, release) = f.state.registration.hooks.arm(Phase::AfterCommit);
    let task = spawn(&f, input, true);
    wait(ready).await;
    std::fs::write(
        f.dir.path().join("Projects/Public/access.toml"),
        "[[members]]\nuser='spare'\nrole='owner'\n",
    )
    .expect("postcommit external restriction");
    release.send(()).expect("release");
    assert_eq!(task.await.expect("join").status(), StatusCode::CREATED);
    assert!(f.state.maintain_sync(&Changes::All).is_empty());
    assert_eq!(
        f.state
            .access_for(&Slug::parse("project").expect("slug"))
            .expect("ACL")
            .effective_role(
                &Username::parse("alice").expect("user"),
                &mb_core::NotePath::parse("Readme.md").expect("path")
            ),
        mb_core::Role::None
    );
}
#[tokio::test]
async fn stopped_watcher_lifecycle_refuses_registration_and_rolls_back_only_preparation() {
    let mut f = Fixture::new();
    let before = f.config_bytes();
    let input = f.confirmed(true).await;
    drop(f._lease.take());
    assert_eq!(f.call(input, true).await.0, StatusCode::SERVICE_UNAVAILABLE);
    f.assert_unpublished(&before);
    assert!(!f.dir.path().join("Projects/New").exists());
}

#[tokio::test]
async fn actual_events_during_prepublication_indexing_are_staged_then_delivered() {
    let f = Fixture::new();
    let input = f.confirmed(false).await;
    let (ready, release) = f.state.registration.hooks.arm(Phase::BeforeCommit);
    let task = spawn(&f, input, true);
    wait(ready).await;
    let staged = f
        .state
        .registration
        .hooks
        .staged
        .lock()
        .expect("staged")
        .clone()
        .expect("prepared real watcher");
    let path = f.dir.path().join("Projects/Public/Readme.md");
    std::fs::write(&path, "# StagedChangedTitle\n").expect("external change after initial index");
    // why: a later real callback on the same watcher fences all prior note events, so a
    // broken queue transfer cannot pass by receiving a late duplicate note callback.
    let fence = f.dir.path().join("Projects/Public/.event-fence-staged");
    std::fs::write(&fence, b"callback fence").expect("real staging event fence");
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let generation = staged.generation();
            if staged.pending_path(&path) && staged.pending_path(&fence) {
                break;
            }
            staged.changed_after(generation).await;
        }
    })
    .await
    .expect("actual note event delivered to isolated staging signal");
    assert!(
        f.signal.take().is_empty(),
        "running maintenance must not consume unpublished-vault events"
    );
    release.send(()).expect("release");
    assert_eq!(task.await.expect("join").status(), StatusCode::CREATED);
    let changes = f.signal.take();
    assert!(
        matches!(&changes,Changes::Only(paths) if paths.contains(&path)),
        "queued exact event transferred, not a recovery sweep"
    );
    let state = f.state.clone();
    tokio::task::spawn_blocking(move || {
        assert!(state.maintain_sync(&changes).is_empty());
        assert!(state.maintain_index(&changes).is_empty());
    })
    .await
    .expect("normal maintenance");
    let response = vault_graph(
        State(f.state.clone()),
        AxumPath("project".into()),
        Query(serde_json::from_value(serde_json::json!({"limit":2000})).expect("query")),
        f.headers.clone(),
    )
    .await;
    let body = axum::body::to_bytes(response.into_body(), 65536)
        .await
        .expect("response");
    assert!(
        String::from_utf8(body.to_vec())
            .expect("JSON")
            .contains("StagedChangedTitle")
    );
}
#[test]
fn seeded_json_selection_roundtrip_preserves_exact_literal_unicode_and_percent_names() {
    use proptest::{
        prelude::*,
        test_runner::{Config, RngSeed, TestRunner},
    };
    let seed = 202610092;
    println!("registration literal property seed={seed}");
    let mut runner = TestRunner::new(Config {
        cases: 128,
        rng_seed: RngSeed::Fixed(seed),
        failure_persistence: None,
        ..Config::default()
    });
    runner.run(&(proptest::collection::vec("[a-z%0-9]{1,12}",1..5),"[a-z%0-9]{1,12}"),|(parts,child)| {
        let path=parts.into_iter().map(|p|format!("日本-{p}")).collect::<Vec<_>>().join("/");let child=format!("child-{child}");
        for mode in ["existing","new"] {
            let mut input=serde_json::json!({"mode":mode,"path":path,"slug":"project","name":"日本 100%"});
            if mode=="new" {input["directory"]=child.clone().into();}
            let uri=axum::http::Uri::from_static("/api/v1/vault-locations/projects/preview");
            let (selection,_)=parse(&uri,input.to_string().as_bytes(),false).expect("literal input");
            prop_assert_eq!(selection.path.as_str(),path.as_str());
            prop_assert_eq!(selection.name.as_str(),"日本 100%");
            if mode=="new" {let actual=selection.child.expect("child");prop_assert_eq!(actual.as_str(),child.as_str());}
        }
        Ok(())
    }).expect("seeded literal roundtrip");
}

#[tokio::test]
async fn disabled_or_revoked_actor_while_waiting_cannot_mutate_or_commit_either_mode() {
    for action in ["disable", "revoke"] {
        for phase in [Phase::BeforeMutation, Phase::BeforeCommit] {
            for new in [false, true] {
                let f = Fixture::new();
                let before = f.config_bytes();
                let input = f.confirmed(new).await;
                let (ready, release) = f.state.registration.hooks.arm(phase);
                let task = spawn(&f, input, true);
                wait(ready).await;
                {
                    let auth = f.state.security.auth.lock().expect("auth");
                    if action == "disable" {
                        auth.set_disabled(f.admin, true).expect("disable");
                    } else {
                        auth.revoke_session(&f.session).expect("revoke");
                    }
                }
                release.send(()).expect("release");
                assert_eq!(task.await.expect("join").status(), StatusCode::NOT_FOUND);
                f.assert_unpublished(&before);
                assert!(!f.dir.path().join("Projects/New").exists());
                assert!(!f.dir.path().join("Projects/Public/access.toml").exists());
            }
        }
    }
}
#[tokio::test]
async fn receipt_expiry_while_prepared_rolls_back_without_config_or_live_publication() {
    for new in [false, true] {
        let f = Fixture::new();
        let before = f.config_bytes();
        let input = f.confirmed(new).await;
        let (ready, release) = f.state.registration.hooks.arm(Phase::BeforeCommit);
        let task = spawn(&f, input, true);
        wait(ready).await;
        *f.state
            .registration
            .hooks
            .clock_advance
            .lock()
            .expect("controlled clock") = TTL + Duration::from_secs(1);
        release.send(()).expect("release");
        assert_eq!(task.await.expect("join").status(), StatusCode::CONFLICT);
        f.assert_unpublished(&before);
        assert!(!f.dir.path().join("Projects/New").exists());
        assert!(!f.dir.path().join("Projects/Public/access.toml").exists());
    }
}
#[tokio::test]
async fn new_root_replaced_after_preparation_is_refused_without_adopting_or_deleting_foreign_files()
{
    let f = Fixture::new();
    let before = f.config_bytes();
    let input = f.confirmed(true).await;
    let (ready, release) = f.state.registration.hooks.arm(Phase::BeforeCommit);
    let task = spawn(&f, input, true);
    wait(ready).await;
    let projects = f.dir.path().join("Projects");
    std::fs::rename(projects.join("New"), projects.join("Moved")).expect("external move");
    std::fs::create_dir(projects.join("New")).expect("replacement");
    std::fs::write(projects.join("New/Foreign.md"), "# Foreign bytes\n").expect("foreign");
    release.send(()).expect("release");
    assert_eq!(
        task.await.expect("join").status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    f.assert_unpublished(&before);
    assert_eq!(
        std::fs::read(projects.join("New/Foreign.md")).expect("preserved"),
        b"# Foreign bytes\n"
    );
    assert!(!projects.join("New/access.toml").exists());
    assert!(!projects.join("Moved/access.toml").exists());
}
#[tokio::test]
async fn same_admin_different_current_session_cannot_reuse_confirmation() {
    let f = Fixture::new();
    let before = f.config_bytes();
    let input = f.confirmed(false).await;
    let mut other = f.headers.clone();
    {
        let auth = f.state.security.auth.lock().expect("auth");
        let token = auth
            .create_session(f.admin, 4_102_444_800)
            .expect("new session");
        other.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!(
                "mb_session={}",
                auth.signed_session_cookie(&token).expect("signed")
            ))
            .expect("cookie"),
        );
    }
    assert_eq!(
        handle(f.state.clone(), Fixture::request(other, input, true), true)
            .await
            .status(),
        StatusCode::CONFLICT
    );
    f.assert_unpublished(&before);
}

#[tokio::test]
async fn existing_policy_changed_during_storage_preparation_refuses_without_stale_grant_publication()
 {
    let f = Fixture::new();
    let before = f.config_bytes();
    let path = f.dir.path().join("Projects/Public/access.toml");
    std::fs::write(&path, "[[members]]\nuser='alice'\nrole='owner'\n")
        .expect("initial valid owner policy");
    let input = f.confirmed(false).await;
    let (ready, release) = f.state.registration.hooks.arm(Phase::AfterStorageCheck);
    let task = spawn(&f, input, true);
    wait(ready).await;
    let replacement = b"# restrictive external policy\n[[members]]\nuser='spare'\nrole='owner'\n";
    std::fs::write(&path, replacement).expect("concurrent policy change");
    release.send(()).expect("release");
    assert_eq!(
        task.await.expect("join").status(),
        StatusCode::CONFLICT,
        "changed policy must not publish stale grant with fresh stamp"
    );
    f.assert_unpublished(&before);
    assert_eq!(std::fs::read(&path).expect("preserved"), replacement);
}

#[tokio::test]
async fn actual_postcommit_directory_sync_fault_finishes_live_policy_index_and_watcher_publication()
{
    for new in [false, true] {
        let f = Fixture::new();
        let input = f.confirmed(new).await;
        *f.state
            .registration
            .hooks
            .commit_fault
            .lock()
            .expect("external I/O boundary") = storage::test_io::Fault::DirectorySync;
        let (status, body) = f.call(input, true).await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(body["committed"], true);
        assert_eq!(body["directory_synced"], false);
        assert_eq!(body["watched"], true);
        assert_eq!(body["index_ready"], true);
        let config = crate::ServerConfig::load(&f.dir.path().join("server.toml"))
            .expect("fresh committed registry");
        assert_eq!(config.vaults.len(), 1);
        assert_eq!(f.state.len(), 1);
        let root = f.dir.path().join(if new {
            "Projects/New"
        } else {
            "Projects/Public"
        });
        assert!(root.is_dir());
        let policy = AccessFile::load(&root).expect("fresh committed policy");
        assert_eq!(
            policy.policy().effective_role(
                &Username::parse("alice").expect("creator"),
                &mb_core::NotePath::parse("Readme.md").expect("note")
            ),
            mb_core::Role::Owner
        );
        assert!(
            f.state
                .watchers
                .0
                .lock()
                .expect("watchers")
                .as_ref()
                .expect("running")
                .roots
                .contains_key(&root)
        );
    }
}

#[tokio::test]
async fn config_parent_replaced_during_preparation_refuses_without_disk_live_disagreement() {
    let mut f = Fixture::new();
    let before = f.config_bytes();
    let config = f.dir.path().join("Config");
    let moved = f.dir.path().join("MovedConfig");
    std::fs::create_dir(&config).expect("fixture config parent");
    std::fs::rename(f.dir.path().join("server.toml"), config.join("server.toml"))
        .expect("fixture configuration relocation");
    Arc::get_mut(&mut f.state)
        .expect("exclusive fixture setup")
        .management
        .as_mut()
        .expect("management")
        .config = config.join("server.toml");
    let input = f.confirmed(false).await;
    let (ready, release) = f.state.registration.hooks.arm(Phase::BeforeCommit);
    let task = spawn(&f, input, true);
    wait(ready).await;
    std::fs::rename(&config, &moved).expect("external parent move");
    std::fs::create_dir(&config).expect("replacement parent");
    let foreign = b"# foreign replacement registry\nvaults=[]\n";
    std::fs::write(config.join("server.toml"), foreign).expect("foreign config");
    release.send(()).expect("release");
    assert_eq!(
        task.await.expect("join").status(),
        StatusCode::CONFLICT,
        "commit must still target the current configured namespace"
    );
    assert_eq!(f.state.len(), 0);
    assert_eq!(
        std::fs::read(moved.join("server.toml")).expect("original retained"),
        before
    );
    assert_eq!(
        std::fs::read(config.join("server.toml")).expect("foreign retained"),
        foreign
    );
    assert!(!f.dir.path().join("Projects/Public/access.toml").exists());
    assert_eq!(
        std::fs::read_dir(&moved)
            .expect("no config temp orphan")
            .count(),
        1
    );
}
