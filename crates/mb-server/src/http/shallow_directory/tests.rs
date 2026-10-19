#![allow(
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::panic,
    clippy::indexing_slicing
)] // why: test-only barriers and wire assertions.
use super::*;
type Pause = (
    tokio::sync::oneshot::Sender<()>,
    std::sync::mpsc::Receiver<()>,
);
#[derive(Debug, Default)]
pub(super) struct Hooks {
    pub(super) before_fs: std::sync::atomic::AtomicUsize,
    pause: Mutex<Option<Pause>>,
}
impl Hooks {
    pub(super) fn pause(&self) {
        if let Some((ready, release)) = self.pause.lock().expect("hooks").take() {
            let _ = ready.send(());
            release.recv().expect("release");
        }
    }
    fn arm(
        &self,
    ) -> (
        tokio::sync::oneshot::Receiver<()>,
        std::sync::mpsc::Sender<()>,
    ) {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        *self.pause.lock().expect("hooks") = Some((tx, wait));
        (rx, release)
    }
}
struct Fixture {
    dir: tempfile::TempDir,
    state: Arc<AppState>,
    headers: HeaderMap,
    session: mb_auth::SessionToken,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("fixture");
        std::fs::write(dir.path().join("A.md"), "PRIVATE_BODY_NEVER_READ").expect("note");
        std::fs::write(
            dir.path().join("access.toml"),
            "[[members]]\nuser='alice'\nrole='viewer'\n",
        )
        .expect("policy");
        let vault =
            Vault::open(Slug::parse("test").expect("slug"), "Test", dir.path()).expect("vault");
        let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth");
        let admin = auth
            .setup_first_user(mb_auth::NewUser {
                username: "alice",
                display_name: "Alice",
                password: "correct horse battery staple",
            })
            .expect("user");
        let session = auth
            .create_session(admin.id, 4_102_444_800)
            .expect("session");
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!(
                "mb_session={}",
                auth.signed_session_cookie(&session).expect("cookie")
            ))
            .expect("header"),
        );
        let state = Arc::new(AppState::authenticated(vec![vault], auth).expect("state"));
        Self {
            dir,
            state,
            headers,
            session,
        }
    }
    fn spawn(&self) -> tokio::task::JoinHandle<Response> {
        let state = self.state.clone();
        let headers = self.headers.clone();
        tokio::spawn(async move {
            directory(
                State(state),
                headers,
                "/api/v1/vaults/test/directory".parse().expect("uri"),
            )
            .await
        })
    }
}
async fn wait(ready: tokio::sync::oneshot::Receiver<()>) {
    tokio::time::timeout(std::time::Duration::from_secs(10), ready)
        .await
        .expect("bounded barrier")
        .expect("ready");
}
#[tokio::test]
async fn stale_acl_after_enumeration_refuses_publication() {
    let f = Fixture::new();
    let (ready, release) = f.state.directory.hooks.arm();
    let job = f.spawn();
    wait(ready).await;
    std::fs::write(
        f.dir.path().join("access.toml"),
        "[[members]]\nuser='alice'\nrole='none'\n",
    )
    .expect("revoke disk ACL without maintenance");
    release.send(()).expect("release");
    assert_eq!(job.await.expect("worker").status(), StatusCode::NOT_FOUND);
}
#[tokio::test]
async fn exhausted_absent_grants_after_revocation_refuse_neutral_publication() {
    let f = Fixture::new();
    let (ready, release) = f.state.directory.hooks.arm();
    let job = f.spawn();
    wait(ready).await;
    let policy = (0..129)
        .map(|i| format!("[[rules]]\npath='Ghost/Absent{i}'\ngrant={{alice='viewer'}}\n"))
        .collect::<String>();
    std::fs::write(f.dir.path().join("access.toml"), policy).expect("revoke to absent grants");
    release.send(()).expect("release");
    assert_eq!(job.await.expect("worker").status(), StatusCode::NOT_FOUND);
}
#[tokio::test]
async fn session_revoked_after_enumeration_refuses_publication() {
    let f = Fixture::new();
    let (ready, release) = f.state.directory.hooks.arm();
    let job = f.spawn();
    wait(ready).await;
    f.state
        .security
        .auth
        .lock()
        .expect("auth")
        .revoke_session(&f.session)
        .expect("revoke");
    release.send(()).expect("release");
    assert_eq!(job.await.expect("worker").status(), StatusCode::NOT_FOUND);
}
#[tokio::test]
async fn pinned_root_replacement_after_enumeration_refuses_publication() {
    let f = Fixture::new();
    let (ready, release) = f.state.directory.hooks.arm();
    let job = f.spawn();
    wait(ready).await;
    let moved = f.dir.path().with_extension("moved");
    std::fs::rename(f.dir.path(), &moved).expect("move root");
    std::fs::create_dir(f.dir.path()).expect("replacement");
    std::fs::write(
        f.dir.path().join("access.toml"),
        "[[members]]\nuser='alice'\nrole='viewer'\n",
    )
    .expect("same ACL");
    release.send(()).expect("release");
    let status = job.await.expect("worker").status();
    std::fs::remove_dir_all(moved).expect("fixture cleanup");
    assert_eq!(status, StatusCode::NOT_FOUND);
}
#[tokio::test]
async fn unauthenticated_request_has_no_filesystem_positive_control() {
    let f = Fixture::new();
    let response = directory(
        State(f.state.clone()),
        HeaderMap::new(),
        "/api/v1/vaults/test/directory".parse().expect("uri"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(f.state.directory.hooks.before_fs.load(Ordering::Relaxed), 0);
    assert_eq!(f.spawn().await.expect("worker").status(), StatusCode::OK);
    assert_eq!(f.state.directory.hooks.before_fs.load(Ordering::Relaxed), 1);
}
#[tokio::test]
async fn bounded_admission_refuses_without_waiting_or_queuing() {
    let f = Fixture::new();
    let _a = f
        .state
        .directory
        .slots
        .clone()
        .try_acquire_owned()
        .expect("slot");
    let _b = f
        .state
        .directory
        .slots
        .clone()
        .try_acquire_owned()
        .expect("slot");
    assert_eq!(
        f.spawn().await.expect("worker").status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(f.state.directory.hooks.before_fs.load(Ordering::Relaxed), 0);
}
