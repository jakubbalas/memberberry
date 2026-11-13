//! The desktop app's embedded server (`SPEC.md` §7.6.2, E34): only the window holding the
//! launch code is admitted, it is signed in as the local user, and vaults it creates land
//! where the user can see them.

// why: a test's `expect` is its assertion that setup worked; AGENTS.md §4.2 permits it.
#![allow(clippy::expect_used)]

use std::sync::Arc;

use mb_server::desktop::{
    DesktopHost, DesktopIdentity, DesktopPaths, DesktopServer, LOCAL_USERNAME, MemorySecrets,
    RecordingBrowser, ensure_local_user,
};
use reqwest::header::{COOKIE, HOST, ORIGIN, SET_COOKIE};
use reqwest::{Client, StatusCode};

struct Fixture {
    _dir: tempfile::TempDir,
    paths: DesktopPaths,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().expect("temporary directory");
    let paths = DesktopPaths {
        app_data: dir.path().join("app-data"),
        notes_home: dir.path().join("Memberberry"),
        web_root: dir.path().join("web"),
    };
    Fixture { _dir: dir, paths }
}

fn identity() -> DesktopIdentity {
    DesktopIdentity {
        display_name: "Jo".into(),
        device_name: "Jo's laptop".into(),
    }
}

fn secrets() -> DesktopHost {
    DesktopHost {
        secrets: Arc::new(MemorySecrets::default()),
        browser: Arc::new(RecordingBrowser::default()),
    }
}

fn client() -> Client {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("http client")
}

fn origin(server: &DesktopServer) -> String {
    format!("http://127.0.0.1:{}", server.port())
}

/// The `name=value` part of a `Set-Cookie` header named `name`.
fn set_cookie(response: &reqwest::Response, name: &str) -> Option<String> {
    response
        .headers()
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .filter_map(|value| value.split(';').next())
        .find(|pair| pair.starts_with(&format!("{name}=")))
        .map(str::to_string)
}

/// Redeems the launch code and returns the desktop cookie it set.
async fn launch(server: &DesktopServer) -> String {
    let response = client()
        .get(server.launch_url())
        .send()
        .await
        .expect("launch request");
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    set_cookie(&response, "mb_desktop").expect("launch sets the desktop cookie")
}

#[tokio::test]
async fn a_request_without_the_desktop_cookie_is_refused() {
    let fx = fixture();
    let server = DesktopServer::start(&fx.paths, &identity(), secrets()).expect("server starts");
    let response = client()
        .get(format!("{}/api/v1/vaults", origin(&server)))
        .send()
        .await
        .expect("request");
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    server.stop().expect("server stops");
}

#[tokio::test]
async fn the_launch_code_works_exactly_once() {
    let fx = fixture();
    let server = DesktopServer::start(&fx.paths, &identity(), secrets()).expect("server starts");
    launch(&server).await;
    let again = client()
        .get(server.launch_url())
        .send()
        .await
        .expect("second launch");
    assert_eq!(again.status(), StatusCode::FORBIDDEN);
    server.stop().expect("server stops");
}

#[tokio::test]
async fn a_wrong_launch_code_is_refused_and_does_not_burn_the_real_one() {
    let fx = fixture();
    let server = DesktopServer::start(&fx.paths, &identity(), secrets()).expect("server starts");
    let wrong = client()
        .get(format!(
            "{}/desktop/launch?code={}",
            origin(&server),
            "0".repeat(64)
        ))
        .send()
        .await
        .expect("wrong launch");
    assert_eq!(wrong.status(), StatusCode::FORBIDDEN);
    launch(&server).await;
    server.stop().expect("server stops");
}

#[tokio::test]
async fn the_launched_window_is_signed_in_as_the_local_user() {
    let fx = fixture();
    let server = DesktopServer::start(&fx.paths, &identity(), secrets()).expect("server starts");
    let desktop = launch(&server).await;
    let response = client()
        .get(format!("{}/api/v1/vaults", origin(&server)))
        .header(COOKIE, &desktop)
        .send()
        .await
        .expect("vault list");
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        set_cookie(&response, "mb_session").is_some(),
        "the guard issues a session so the window stays signed in"
    );
    server.stop().expect("server stops");
}

#[tokio::test]
async fn a_stale_session_cookie_is_replaced_rather_than_shadowing_the_new_one() {
    let fx = fixture();
    let server = DesktopServer::start(&fx.paths, &identity(), secrets()).expect("server starts");
    let desktop = launch(&server).await;
    let response = client()
        .get(format!("{}/api/v1/vaults", origin(&server)))
        .header(COOKIE, format!("mb_session=stale.value; {desktop}"))
        .send()
        .await
        .expect("vault list");
    assert_eq!(response.status(), StatusCode::OK);
    server.stop().expect("server stops");
}

#[tokio::test]
async fn a_foreign_host_header_is_refused_even_with_the_cookie() {
    let fx = fixture();
    let server = DesktopServer::start(&fx.paths, &identity(), secrets()).expect("server starts");
    let desktop = launch(&server).await;
    let response = client()
        .get(format!("{}/api/v1/vaults", origin(&server)))
        .header(COOKIE, &desktop)
        .header(HOST, format!("attacker.example:{}", server.port()))
        .send()
        .await
        .expect("rebound request");
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    server.stop().expect("server stops");
}

#[tokio::test]
async fn a_foreign_origin_is_refused_even_with_the_cookie() {
    let fx = fixture();
    let server = DesktopServer::start(&fx.paths, &identity(), secrets()).expect("server starts");
    let desktop = launch(&server).await;
    let response = client()
        .get(format!("{}/api/v1/vaults", origin(&server)))
        .header(COOKIE, &desktop)
        .header(ORIGIN, "https://attacker.example")
        .send()
        .await
        .expect("cross-origin request");
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    server.stop().expect("server stops");
}

#[tokio::test]
async fn the_launch_code_is_refused_from_a_foreign_origin() {
    let fx = fixture();
    let server = DesktopServer::start(&fx.paths, &identity(), secrets()).expect("server starts");
    let response = client()
        .get(server.launch_url())
        .header(ORIGIN, "https://attacker.example")
        .send()
        .await
        .expect("cross-origin launch");
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    server.stop().expect("server stops");
}

#[tokio::test]
async fn a_new_vault_is_created_under_the_notes_home() {
    let fx = fixture();
    let server = DesktopServer::start(&fx.paths, &identity(), secrets()).expect("server starts");
    let desktop = launch(&server).await;
    let response = client()
        .post(format!("{}/vaults/new", origin(&server)))
        .header(COOKIE, &desktop)
        .header(ORIGIN, origin(&server))
        .form(&[("name", "Journal"), ("slug", "journal")])
        .send()
        .await
        .expect("create vault");
    assert!(
        response.status().is_redirection(),
        "vault creation answered {}",
        response.status()
    );
    assert!(fx.paths.notes_home.join("journal").join("notes").is_dir());
    server.stop().expect("server stops");
}

#[test]
fn the_port_is_remembered_between_runs() {
    let fx = fixture();
    let first = DesktopServer::start(&fx.paths, &identity(), secrets()).expect("first run");
    let port = first.port();
    first.stop().expect("first run stops");
    let second = DesktopServer::start(&fx.paths, &identity(), secrets()).expect("second run");
    assert_eq!(second.port(), port);
    second.stop().expect("second run stops");
}

#[test]
fn a_taken_port_falls_back_to_a_fresh_one() {
    let fx = fixture();
    let first = DesktopServer::start(&fx.paths, &identity(), secrets()).expect("first run");
    let blocker = std::net::TcpListener::bind(("127.0.0.1", first.port()));
    let port = first.port();
    first.stop().expect("first run stops");
    let blocker = blocker.or_else(|_| std::net::TcpListener::bind(("127.0.0.1", port)));
    let blocker = blocker.expect("hold the remembered port");
    let second = DesktopServer::start(&fx.paths, &identity(), secrets()).expect("second run");
    assert_ne!(second.port(), port);
    second.stop().expect("second run stops");
    drop(blocker);
}

#[test]
fn first_run_creates_the_local_administrator() {
    let dir = tempfile::tempdir().expect("temporary directory");
    let mut auth = mb_auth::AuthDb::open(&dir.path().join("auth.db")).expect("auth db");
    ensure_local_user(&mut auth, "Jo").expect("local user");
    let user = auth
        .user_by_username(LOCAL_USERNAME)
        .expect("lookup")
        .expect("local user exists");
    assert!(user.is_admin && user.display_name == "Jo");
}

#[test]
fn a_second_run_keeps_the_existing_local_user() {
    let dir = tempfile::tempdir().expect("temporary directory");
    let mut auth = mb_auth::AuthDb::open(&dir.path().join("auth.db")).expect("auth db");
    ensure_local_user(&mut auth, "Jo").expect("first run");
    ensure_local_user(&mut auth, "Someone else").expect("second run");
    let user = auth
        .user_by_username(LOCAL_USERNAME)
        .expect("lookup")
        .expect("local user exists");
    assert_eq!(user.display_name, "Jo");
}

#[test]
fn a_data_directory_set_up_by_a_person_is_refused() {
    let dir = tempfile::tempdir().expect("temporary directory");
    let mut auth = mb_auth::AuthDb::open(&dir.path().join("auth.db")).expect("auth db");
    auth.setup_first_user(mb_auth::NewUser {
        username: "alice",
        display_name: "Alice",
        password: "correct horse battery staple",
    })
    .expect("a person's server");
    assert!(ensure_local_user(&mut auth, "Jo").is_err());
}

/// A store that counts how often it is read, standing in for a keychain that prompts.
#[derive(Debug, Default)]
struct CountingSecrets {
    inner: MemorySecrets,
    reads: std::sync::atomic::AtomicUsize,
}

impl mb_server::desktop::SecretStore for CountingSecrets {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.inner.get(account)
    }
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        self.inner.set(account, secret)
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        self.inner.delete(account)
    }
}

#[test]
fn the_keychain_is_read_once_however_often_the_token_is_needed() {
    use mb_server::desktop::{CachedSecrets, SecretStore};
    let keychain = Arc::new(CountingSecrets::default());
    keychain
        .inner
        .set("https://notes.example", "mbd_token")
        .expect("seed");
    let cached = CachedSecrets::new(keychain.clone());
    for _ in 0..5 {
        assert_eq!(
            cached.get("https://notes.example").expect("get").as_deref(),
            Some("mbd_token")
        );
    }
    assert_eq!(keychain.reads.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[test]
fn a_missing_token_is_remembered_as_missing() {
    use mb_server::desktop::{CachedSecrets, SecretStore};
    let keychain = Arc::new(CountingSecrets::default());
    let cached = CachedSecrets::new(keychain.clone());
    assert!(cached.get("https://notes.example").expect("get").is_none());
    assert!(cached.get("https://notes.example").expect("get").is_none());
    assert_eq!(keychain.reads.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[test]
fn a_stored_token_is_what_the_cache_returns_next() {
    use mb_server::desktop::{CachedSecrets, SecretStore};
    let keychain = Arc::new(CountingSecrets::default());
    let cached = CachedSecrets::new(keychain.clone());
    assert!(cached.get("https://notes.example").expect("get").is_none());
    cached.set("https://notes.example", "mbd_new").expect("set");
    assert_eq!(
        cached.get("https://notes.example").expect("get").as_deref(),
        Some("mbd_new")
    );
    assert_eq!(
        keychain
            .inner
            .get("https://notes.example")
            .expect("inner")
            .as_deref(),
        Some("mbd_new")
    );
}

#[test]
fn a_deleted_token_is_gone_from_the_cache_and_the_keychain() {
    use mb_server::desktop::{CachedSecrets, SecretStore};
    let keychain = Arc::new(CountingSecrets::default());
    keychain
        .inner
        .set("https://notes.example", "mbd_token")
        .expect("seed");
    let cached = CachedSecrets::new(keychain.clone());
    assert!(cached.get("https://notes.example").expect("get").is_some());
    cached.delete("https://notes.example").expect("delete");
    assert!(cached.get("https://notes.example").expect("get").is_none());
    assert!(
        keychain
            .inner
            .get("https://notes.example")
            .expect("inner")
            .is_none()
    );
}

#[tokio::test]
async fn the_apps_pages_say_they_are_the_app_so_the_workspace_offers_no_log_out() {
    let fx = fixture();
    std::fs::create_dir_all(&fx.paths.web_root).expect("web root");
    std::fs::write(
        fx.paths.web_root.join("index.html"),
        "<!doctype html><div id=\"app\" data-vault=\"\" data-note=\"\" data-user=\"\" data-vault-theme=\"\"></div>",
    )
    .expect("index");
    let server = DesktopServer::start(&fx.paths, &identity(), secrets()).expect("server starts");
    let desktop = launch(&server).await;
    let created = client()
        .post(format!("{}/vaults/new", origin(&server)))
        .header(COOKIE, &desktop)
        .header(ORIGIN, origin(&server))
        .form(&[("name", "Journal"), ("slug", "journal")])
        .send()
        .await
        .expect("create vault");
    assert!(created.status().is_redirection());
    let page = client()
        .get(format!("{}/v/journal/", origin(&server)))
        .header(COOKIE, &desktop)
        .send()
        .await
        .expect("vault home")
        .text()
        .await
        .expect("body");
    assert!(page.contains("data-desktop=\"true\""), "{page}");
    server.stop().expect("server stops");
}
