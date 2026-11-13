//! Connecting the desktop app to a user's server, end to end (`SPEC.md` §6.8.1, §7.6.8).
//!
//! Both halves are real: a desktop server with E34's guard, and a user's server with the
//! approval page. The browser's part — following links, submitting the approval — is done
//! over HTTP here; the real browser is exercised separately.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

use std::net::SocketAddr;
use std::sync::Arc;

use mb_server::desktop::{
    DesktopHost, DesktopIdentity, DesktopPaths, DesktopServer, MemorySecrets, RecordingBrowser,
    SecretStore,
};
use mb_server::http::{AppState, router};
use reqwest::header::{COOKIE, LOCATION, ORIGIN, SET_COOKIE};
use reqwest::{Client, StatusCode};

const PASSWORD: &str = "correct horse battery staple";

struct Upstream {
    origin: String,
    alice: String,
    bob: String,
    root: std::path::PathBuf,
    state: Arc<AppState>,
    _dir: tempfile::TempDir,
    _stop: tokio::sync::oneshot::Sender<()>,
}

async fn upstream() -> Upstream {
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth");
    let alice = auth
        .setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: PASSWORD,
        })
        .expect("alice");
    let token = auth
        .create_session(alice.id, 4_102_444_800)
        .expect("session");
    let cookie = format!(
        "mb_session={}",
        auth.signed_session_cookie(&token).expect("cookie")
    );
    let bob = auth
        .create_user(mb_auth::NewUser {
            username: "bob",
            display_name: "Bob",
            password: PASSWORD,
        })
        .expect("bob");
    let bob_token = auth.create_session(bob.id, 4_102_444_800).expect("session");
    let bob = format!(
        "mb_session={}",
        auth.signed_session_cookie(&bob_token).expect("cookie")
    );
    let dir = tempfile::tempdir().expect("dir");
    let root = dir.path().join("work");
    std::fs::create_dir_all(root.join("notes")).expect("notes");
    std::fs::write(
        root.join("access.toml"),
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n[[members]]\nuser = \"bob\"\nrole = \"viewer\"\n",
    )
    .expect("policy");
    std::fs::write(root.join("notes/Hello.md"), "# Hello\n\nfrom the server\n").expect("note");
    std::fs::write(root.join("notes/Second.md"), "# Second\n").expect("note");
    let vault = mb_server::Vault::open(
        mb_server::vault::Slug::parse("work").expect("slug"),
        "Work",
        &root,
    )
    .expect("vault");
    let state = Arc::new(
        AppState::authenticated(vec![vault], auth)
            .expect("state")
            .with_data_dir(dir.path().join("data")),
    );
    let errors = state.maintain_index(&mb_server::watch::Changes::All);
    assert!(errors.is_empty(), "{errors:?}");
    let app = router(Arc::clone(&state));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let origin = format!("http://{}", listener.local_addr().expect("addr"));
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async {
            drop(stopped.await);
        })
        .await
    });
    Upstream {
        origin,
        alice: cookie,
        bob,
        root,
        state,
        _dir: dir,
        _stop: stop,
    }
}

struct App {
    _dir: tempfile::TempDir,
    paths: DesktopPaths,
    server: Option<DesktopServer>,
    secrets: Arc<MemorySecrets>,
    browser: Arc<RecordingBrowser>,
    origin: String,
    cookie: String,
}

impl Drop for App {
    fn drop(&mut self) {
        if let Some(server) = self.server.take() {
            drop(server.stop());
        }
    }
}

fn client() -> Client {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("client")
}

async fn app() -> App {
    let dir = tempfile::tempdir().expect("dir");
    let paths = DesktopPaths {
        app_data: dir.path().join("app-data"),
        notes_home: dir.path().join("Memberberry"),
        web_root: dir.path().join("web"),
    };
    // why: the server resolves its web root once at start, so the workspace page's shell
    // must exist before it starts.
    std::fs::create_dir_all(&paths.web_root).expect("web root");
    std::fs::write(
        paths.web_root.join("index.html"),
        "<!doctype html><div id=\"app\" data-vault=\"\" data-note=\"\" data-user=\"\" data-vault-theme=\"\"></div>",
    )
    .expect("index");
    let secrets = Arc::new(MemorySecrets::default());
    let browser = Arc::new(RecordingBrowser::default());
    let server = DesktopServer::start(
        &paths,
        &DesktopIdentity {
            display_name: "Jo".into(),
            device_name: "Jo's laptop".into(),
        },
        DesktopHost {
            secrets: secrets.clone(),
            browser: browser.clone(),
        },
    )
    .expect("desktop server");
    let launched = client()
        .get(server.launch_url())
        .send()
        .await
        .expect("launch");
    let cookie = launched
        .headers()
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok()?.split(';').next())
        .find(|pair| pair.starts_with("mb_desktop="))
        .expect("desktop cookie")
        .to_string();
    let origin = format!("http://127.0.0.1:{}", server.port());
    App {
        _dir: dir,
        paths,
        server: Some(server),
        secrets,
        browser,
        origin,
        cookie,
    }
}

impl App {
    async fn get(&self, path: &str) -> reqwest::Response {
        client()
            .get(format!("{}{path}", self.origin))
            .header(COOKIE, &self.cookie)
            .send()
            .await
            .expect("get")
    }

    async fn post(&self, path: &str, form: &[(&str, &str)]) -> reqwest::Response {
        client()
            .post(format!("{}{path}", self.origin))
            .header(COOKIE, &self.cookie)
            .header(ORIGIN, &self.origin)
            .form(form)
            .send()
            .await
            .expect("post")
    }

    /// Starts connecting, presses "Open the sign-in page" and returns the approval URL the
    /// user's browser was sent to.
    async fn start_connecting(&self, server: &str) -> String {
        let started = self.post("/desktop/connect", &[("server", server)]).await;
        assert_eq!(started.status(), StatusCode::SEE_OTHER);
        let opened = self.post("/desktop/connect/open", &[]).await;
        assert_eq!(opened.status(), StatusCode::SEE_OTHER);
        self.browser
            .opened()
            .last()
            .expect("browser opened")
            .clone()
    }
}

/// Plays the user's browser: approve on the server, then follow the redirect to the app.
async fn approve_in_browser(upstream: &Upstream, authorize: &str) -> reqwest::Response {
    approve_as(upstream, &upstream.alice, authorize).await
}

/// As [`approve_in_browser`], signed in to the server with `session`.
async fn approve_as(upstream: &Upstream, session: &str, authorize: &str) -> reqwest::Response {
    let url = reqwest::Url::parse(authorize).expect("authorize url");
    let mut form: Vec<(String, String)> = url.query_pairs().into_owned().collect();
    form.push(("decision".into(), "approve".into()));
    let approved = client()
        .post(format!("{}/devices/authorize", upstream.origin))
        .header(COOKIE, session)
        .header(ORIGIN, &upstream.origin)
        .form(&form)
        .send()
        .await
        .expect("approve");
    assert_eq!(approved.status(), StatusCode::SEE_OTHER);
    let callback = approved.headers()[LOCATION].to_str().unwrap().to_string();
    client().get(callback).send().await.expect("callback")
}

#[tokio::test]
async fn approving_in_the_browser_connects_the_app_and_keeps_the_token_in_the_secret_store() {
    let upstream = upstream().await;
    let app = app().await;
    let authorize = app.start_connecting(&upstream.origin).await;
    let landed = approve_in_browser(&upstream, &authorize).await;
    assert_eq!(landed.status(), StatusCode::OK);
    let token = app
        .secrets
        .get(&upstream.origin)
        .expect("store")
        .expect("token saved");
    let settings =
        std::fs::read_to_string(app.paths.app_data.join("desktop.toml")).expect("settings");
    assert!(settings.contains("username = \"alice\"") && !settings.contains(&token));
    let me = client()
        .get(format!("{}/api/v1/devices/self", upstream.origin))
        .bearer_auth(&token)
        .send()
        .await
        .expect("self");
    assert_eq!(me.status(), StatusCode::OK);
}

#[tokio::test]
async fn the_connected_page_names_the_server_and_account() {
    let upstream = upstream().await;
    let app = app().await;
    let authorize = app.start_connecting(&upstream.origin).await;
    approve_in_browser(&upstream, &authorize).await;
    let page = app
        .get("/desktop/connect")
        .await
        .text()
        .await
        .expect("body");
    let host = upstream.origin.trim_start_matches("http://");
    assert!(page.contains(host) && page.contains("Alice"), "{page}");
}

#[tokio::test]
async fn a_callback_with_the_wrong_state_is_refused() {
    let upstream = upstream().await;
    let app = app().await;
    app.start_connecting(&upstream.origin).await;
    let forged = client()
        .get(format!(
            "{}/desktop/connect/callback?code={}&state={}",
            app.origin,
            "a".repeat(64),
            "b".repeat(43)
        ))
        .send()
        .await
        .expect("forged callback");
    assert_eq!(forged.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_callback_works_only_once() {
    let upstream = upstream().await;
    let app = app().await;
    let authorize = app.start_connecting(&upstream.origin).await;
    let url = reqwest::Url::parse(&authorize).unwrap();
    let mut form: Vec<(String, String)> = url.query_pairs().into_owned().collect();
    form.push(("decision".into(), "approve".into()));
    let approved = client()
        .post(format!("{}/devices/authorize", upstream.origin))
        .header(COOKIE, &upstream.alice)
        .header(ORIGIN, &upstream.origin)
        .form(&form)
        .send()
        .await
        .expect("approve");
    let callback = approved.headers()[LOCATION].to_str().unwrap().to_string();
    assert_eq!(
        client().get(&callback).send().await.unwrap().status(),
        StatusCode::OK
    );
    assert_eq!(
        client().get(&callback).send().await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn denying_in_the_browser_leaves_the_app_unconnected() {
    let upstream = upstream().await;
    let app = app().await;
    let authorize = app.start_connecting(&upstream.origin).await;
    let url = reqwest::Url::parse(&authorize).unwrap();
    let mut form: Vec<(String, String)> = url.query_pairs().into_owned().collect();
    form.push(("decision".into(), "deny".into()));
    let denied = client()
        .post(format!("{}/devices/authorize", upstream.origin))
        .header(COOKIE, &upstream.alice)
        .header(ORIGIN, &upstream.origin)
        .form(&form)
        .send()
        .await
        .expect("deny");
    let callback = denied.headers()[LOCATION].to_str().unwrap().to_string();
    let landed = client().get(callback).send().await.expect("callback");
    assert!(landed.text().await.unwrap().contains("denied"));
    assert!(app.secrets.get(&upstream.origin).unwrap().is_none());
}

#[tokio::test]
async fn disconnecting_revokes_the_token_on_the_server_and_forgets_it_here() {
    let upstream = upstream().await;
    let app = app().await;
    let authorize = app.start_connecting(&upstream.origin).await;
    approve_in_browser(&upstream, &authorize).await;
    let token = app.secrets.get(&upstream.origin).unwrap().expect("token");
    let disconnected = app
        .post(
            "/desktop/disconnect",
            &[("server", upstream.origin.as_str()), ("notes", "remove")],
        )
        .await;
    assert_eq!(disconnected.status(), StatusCode::SEE_OTHER);
    assert!(app.secrets.get(&upstream.origin).unwrap().is_none());
    let me = client()
        .get(format!("{}/api/v1/devices/self", upstream.origin))
        .bearer_auth(&token)
        .send()
        .await
        .expect("self");
    assert_eq!(me.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_plain_http_server_on_the_network_is_refused() {
    let app = app().await;
    let response = app
        .post(
            "/desktop/connect",
            &[("server", "http://notes.example.com")],
        )
        .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(response.text().await.unwrap().contains("https"));
}

#[tokio::test]
async fn starting_to_connect_needs_the_desktop_cookie() {
    let app = app().await;
    let response = client()
        .post(format!("{}/desktop/connect", app.origin))
        .header(ORIGIN, &app.origin)
        .form(&[("server", "https://notes.example.com")])
        .send()
        .await
        .expect("post");
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn the_home_page_offers_the_server_instead_of_log_out() {
    let app = app().await;
    let home = app.get("/").await.text().await.expect("body");
    assert!(home.contains("/desktop/connect") && !home.contains("/logout\""));
}

#[tokio::test]
async fn cancelling_a_waiting_attempt_allows_a_different_server() {
    let app = app().await;
    app.start_connecting("https://first.example").await;
    let cancelled = app.post("/desktop/connect/cancel", &[]).await;
    assert_eq!(cancelled.status(), StatusCode::SEE_OTHER);
    let page = app
        .get("/desktop/connect")
        .await
        .text()
        .await
        .expect("body");
    assert!(page.contains("Server address") && !page.contains("first.example"));
}

#[tokio::test]
async fn the_waiting_page_never_navigates_the_window_off_its_origin() {
    let upstream = upstream().await;
    let app = app().await;
    app.post("/desktop/connect", &[("server", &upstream.origin)])
        .await;
    let page = app
        .get("/desktop/connect")
        .await
        .text()
        .await
        .expect("body");
    assert!(page.contains("Waiting for approval") && !page.contains("/devices/authorize"));
}

#[tokio::test]
async fn opening_the_sign_in_page_sends_the_browser_to_the_server_and_keeps_waiting() {
    let upstream = upstream().await;
    let app = app().await;
    app.post("/desktop/connect", &[("server", &upstream.origin)])
        .await;
    let opened = app.post("/desktop/connect/open", &[]).await;
    let back = opened.headers()[LOCATION].to_str().unwrap().to_string();
    let url = app.browser.opened().pop().expect("browser opened");
    assert!(
        back == "/desktop/connect"
            && url.starts_with(&format!("{}/devices/authorize?", upstream.origin))
    );
}

#[tokio::test]
async fn opening_after_cancelling_opens_nothing() {
    let app = app().await;
    app.post("/desktop/connect", &[("server", "https://first.example")])
        .await;
    app.post("/desktop/connect/cancel", &[]).await;
    app.post("/desktop/connect/open", &[]).await;
    assert!(app.browser.opened().is_empty());
}

#[tokio::test]
async fn opening_the_sign_in_page_needs_the_desktop_cookie() {
    let app = app().await;
    app.post("/desktop/connect", &[("server", "https://first.example")])
        .await;
    let response = client()
        .post(format!("{}/desktop/connect/open", app.origin))
        .header(ORIGIN, &app.origin)
        .send()
        .await
        .expect("post");
    assert!(response.status() == StatusCode::FORBIDDEN && app.browser.opened().is_empty());
}

#[tokio::test]
async fn a_late_approval_tells_the_user_to_connect_again() {
    let upstream = upstream().await;
    let app = app().await;
    let authorize = app.start_connecting(&upstream.origin).await;
    app.post("/desktop/connect/cancel", &[]).await;
    let landed = approve_in_browser(&upstream, &authorize).await;
    assert_eq!(landed.status(), StatusCode::FORBIDDEN);
    assert!(landed.text().await.unwrap().contains("connect again"));
}

/// Connects `app` to `upstream` as alice.
async fn connected(upstream: &Upstream, app: &App) {
    let authorize = app.start_connecting(&upstream.origin).await;
    approve_in_browser(upstream, &authorize).await;
}

fn replica_note(app: &App, upstream: &Upstream, path: &str) -> std::path::PathBuf {
    let host = upstream
        .origin
        .trim_start_matches("http://")
        .replace(':', "-");
    app.paths
        .notes_home
        .join(host)
        .join("work/notes")
        .join(path)
}

/// Polls `check` for up to ten seconds, the time a few passes take.
async fn eventually(mut check: impl FnMut() -> bool) -> bool {
    for _ in 0..100 {
        if check() {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    false
}

/// Connects, then waits for the server's vault to be registered here.
async fn with_server_vault(upstream: &Upstream, app: &App) {
    connected(upstream, app).await;
    assert!(
        eventually_async(app, "/api/v1/vaults", "\"work\"").await,
        "the server vault never appeared"
    );
}

async fn set_offline(app: &App, kind: &str, path: &str, offline: bool) -> reqwest::Response {
    client()
        .post(format!("{}/api/v1/vaults/work/offline", app.origin))
        .header(COOKIE, &app.cookie)
        .header(ORIGIN, &app.origin)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(serde_json::json!({ "kind": kind, "path": path, "offline": offline }).to_string())
        .send()
        .await
        .expect("offline")
}

#[tokio::test]
async fn the_servers_vaults_appear_without_downloading_anything() {
    let upstream = upstream().await;
    let app = app().await;
    with_server_vault(&upstream, &app).await;
    let home = app.get("/").await.text().await.expect("body");
    assert!(home.contains("Work"), "{home}");
}

#[tokio::test]
async fn a_server_vault_works_online_with_nothing_on_this_device() {
    let upstream = upstream().await;
    let app = app().await;
    with_server_vault(&upstream, &app).await;
    let notes = app
        .get("/api/v1/vaults/work/notes")
        .await
        .text()
        .await
        .expect("body");
    assert!(notes.contains("Hello.md"), "{notes}");
    assert!(!replica_note(&app, &upstream, "Hello.md").exists());
}

/// The workspace page's `data-note`, as the bootstrap gives it to the client.
fn bootstrap_note(page: &str) -> Option<&str> {
    let start = page.find("data-note=\"")? + "data-note=\"".len();
    let rest = page.get(start..)?;
    rest.get(..rest.find('"')?)
}

#[tokio::test]
async fn a_server_note_url_without_md_opens_the_note() {
    let upstream = upstream().await;
    let app = app().await;
    with_server_vault(&upstream, &app).await;
    let page = body(app.get("/v/work/Hello").await).await;
    assert_eq!(bootstrap_note(&page), Some("Hello.md"), "{page}");
}

#[tokio::test]
async fn a_server_note_url_with_md_is_left_as_it_is() {
    let upstream = upstream().await;
    let app = app().await;
    with_server_vault(&upstream, &app).await;
    let page = body(app.get("/v/work/Hello.md").await).await;
    assert_eq!(bootstrap_note(&page), Some("Hello.md"), "{page}");
}

async fn send_json(
    app: &App,
    method: reqwest::Method,
    path: &str,
    body: &str,
) -> reqwest::Response {
    client()
        .request(method, format!("{}{path}", app.origin))
        .header(COOKIE, &app.cookie)
        .header(ORIGIN, &app.origin)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body.to_string())
        .send()
        .await
        .expect("request")
}

async fn upstream_get(upstream: &Upstream, path: &str) -> String {
    client()
        .get(format!("{}{path}", upstream.origin))
        .header(COOKIE, &upstream.alice)
        .send()
        .await
        .expect("upstream")
        .text()
        .await
        .expect("body")
}

#[tokio::test]
async fn bookmarks_made_in_the_app_are_kept_on_the_server() {
    let upstream = upstream().await;
    let app = app().await;
    with_server_vault(&upstream, &app).await;
    let route = "/api/v1/vaults/work/bookmarks";
    let saved = send_json(&app, reqwest::Method::PUT, route, "[\"Hello.md\"]").await;
    assert!(saved.status().is_success(), "{}", saved.status());
    assert!(upstream_get(&upstream, route).await.contains("Hello.md"));
}

#[tokio::test]
async fn the_apps_layout_is_kept_on_the_server() {
    let upstream = upstream().await;
    let app = app().await;
    with_server_vault(&upstream, &app).await;
    let route = "/api/v1/vaults/work/workspace/desk";
    let saved = send_json(
        &app,
        reqwest::Method::PUT,
        route,
        "{\"tabs\":[\"Hello.md\"]}",
    )
    .await;
    assert!(saved.status().is_success(), "{}", saved.status());
    assert!(upstream_get(&upstream, route).await.contains("Hello.md"));
}

#[tokio::test]
async fn a_share_link_made_in_the_app_points_at_the_server() {
    let upstream = upstream().await;
    let app = app().await;
    with_server_vault(&upstream, &app).await;
    let created = send_json(
        &app,
        reqwest::Method::POST,
        "/api/v1/vaults/work/shares",
        "{\"note\":\"Hello.md\",\"never_expires\":true}",
    )
    .await;
    assert!(created.status().is_success(), "{}", created.status());
    let created: serde_json::Value = serde_json::from_str(&body(created).await).expect("json");
    let url = created["url"].as_str().expect("url");
    assert!(url.starts_with(&format!("{}/s/", upstream.origin)), "{url}");
    let shared = client()
        .get(url)
        .send()
        .await
        .expect("share")
        .text()
        .await
        .expect("body");
    assert!(shared.contains("from the server"), "{shared}");
}

#[tokio::test]
async fn making_a_note_available_offline_downloads_it() {
    let upstream = upstream().await;
    let app = app().await;
    with_server_vault(&upstream, &app).await;
    assert_eq!(
        set_offline(&app, "note", "Hello.md", true).await.status(),
        StatusCode::OK
    );
    let note = replica_note(&app, &upstream, "Hello.md");
    assert!(eventually(|| note.exists()).await);
    assert_eq!(
        std::fs::read_to_string(&note).expect("note"),
        "# Hello\n\nfrom the server\n"
    );
}

#[tokio::test]
async fn online_only_removes_the_downloaded_copy() {
    let upstream = upstream().await;
    let app = app().await;
    with_server_vault(&upstream, &app).await;
    set_offline(&app, "note", "Hello.md", true).await;
    let note = replica_note(&app, &upstream, "Hello.md");
    assert!(eventually(|| note.exists()).await);
    set_offline(&app, "note", "Hello.md", false).await;
    assert!(eventually(|| !note.exists()).await);
}

#[tokio::test]
async fn a_note_in_an_offline_folder_cannot_be_made_online_only_alone() {
    let upstream = upstream().await;
    let app = app().await;
    with_server_vault(&upstream, &app).await;
    set_offline(&app, "vault", "", true).await;
    let refused = set_offline(&app, "note", "Hello.md", false).await;
    assert_eq!(refused.status(), StatusCode::CONFLICT);
    assert!(refused.text().await.expect("body").contains("whole vault"));
}

#[tokio::test]
async fn the_offline_state_lists_downloaded_notes() {
    let upstream = upstream().await;
    let app = app().await;
    with_server_vault(&upstream, &app).await;
    set_offline(&app, "note", "Hello.md", true).await;
    let note = replica_note(&app, &upstream, "Hello.md");
    assert!(eventually(|| note.exists()).await);
    let state = app
        .get("/api/v1/vaults/work/offline")
        .await
        .text()
        .await
        .expect("body");
    assert!(
        state.contains("\"downloaded\":[\"Hello.md\"]") && state.contains("\"server\":true"),
        "{state}"
    );
}

#[tokio::test]
async fn changing_offline_state_needs_the_windows_origin() {
    let upstream = upstream().await;
    let app = app().await;
    with_server_vault(&upstream, &app).await;
    let refused = client()
        .post(format!("{}/api/v1/vaults/work/offline", app.origin))
        .header(COOKIE, &app.cookie)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(r#"{"kind":"vault","path":"","offline":true}"#)
        .send()
        .await
        .expect("post");
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn offline_the_vault_lists_every_note_and_only_downloaded_ones_are_on_disk() {
    let upstream = upstream().await;
    let app = app().await;
    with_server_vault(&upstream, &app).await;
    set_offline(&app, "note", "Hello.md", true).await;
    let note = replica_note(&app, &upstream, "Hello.md");
    assert!(eventually(|| note.exists()).await);
    // Take the server away.
    drop(upstream);
    let mut offline = String::new();
    for _ in 0..150 {
        offline = app
            .get("/api/v1/vaults/work/offline")
            .await
            .text()
            .await
            .expect("body");
        if offline.contains("\"online\":false") {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(offline.contains("\"online\":false"), "{offline}");
    let notes = app
        .get("/api/v1/vaults/work/notes")
        .await
        .text()
        .await
        .expect("body");
    assert!(
        notes.contains("Hello.md") && notes.contains("Second.md"),
        "{notes}"
    );
    assert!(
        offline.contains("\"downloaded\":[\"Hello.md\"]"),
        "{offline}"
    );
}

// ------------------------------------------------- several servers, signing out (§7.6.11)

async fn sign_out(app: &App, upstream: &Upstream, notes: &str) -> reqwest::Response {
    app.post(
        "/desktop/disconnect",
        &[("server", upstream.origin.as_str()), ("notes", notes)],
    )
    .await
}

async fn body(response: reqwest::Response) -> String {
    response.text().await.expect("body")
}

/// Makes `Hello.md` available offline and waits for its file.
async fn with_downloaded_note(upstream: &Upstream, app: &App) -> std::path::PathBuf {
    with_server_vault(upstream, app).await;
    set_offline(app, "note", "Hello.md", true).await;
    let note = replica_note(app, upstream, "Hello.md");
    assert!(eventually(|| note.exists()).await);
    note
}

#[tokio::test]
async fn the_sign_out_page_offers_keeping_or_removing_downloaded_notes() {
    let upstream = upstream().await;
    let app = app().await;
    with_downloaded_note(&upstream, &app).await;
    let page = body(
        app.get(&format!(
            "/desktop/disconnect?server={}",
            upstream.origin.replace(':', "%3A").replace('/', "%2F")
        ))
        .await,
    )
    .await;
    assert!(
        page.contains("1 note is available offline")
            && page.contains("value=\"keep\"")
            && page.contains("value=\"remove\""),
        "{page}"
    );
}

#[tokio::test]
async fn with_nothing_downloaded_signing_out_asks_nothing() {
    let upstream = upstream().await;
    let app = app().await;
    with_server_vault(&upstream, &app).await;
    let page = body(
        app.get(&format!("/desktop/disconnect?server={}", upstream.origin))
            .await,
    )
    .await;
    assert!(
        !page.contains("value=\"keep\"") && page.contains("value=\"remove\""),
        "{page}"
    );
}

#[tokio::test]
async fn viewing_the_sign_out_page_changes_nothing() {
    let upstream = upstream().await;
    let app = app().await;
    with_server_vault(&upstream, &app).await;
    app.get(&format!("/desktop/disconnect?server={}", upstream.origin))
        .await;
    assert!(app.secrets.get(&upstream.origin).unwrap().is_some());
}

#[tokio::test]
async fn signing_out_and_removing_deletes_the_notes_and_the_vault() {
    let upstream = upstream().await;
    let app = app().await;
    let note = with_downloaded_note(&upstream, &app).await;
    let folder = note
        .parent()
        .and_then(std::path::Path::parent)
        .unwrap()
        .to_path_buf();
    assert_eq!(
        sign_out(&app, &upstream, "remove").await.status(),
        StatusCode::SEE_OTHER
    );
    let vaults = body(app.get("/api/v1/vaults").await).await;
    assert!(!folder.exists() && !vaults.contains("\"work\""), "{vaults}");
}

#[tokio::test]
async fn signing_out_and_removing_forgets_the_server() {
    let upstream = upstream().await;
    let app = app().await;
    with_downloaded_note(&upstream, &app).await;
    sign_out(&app, &upstream, "remove").await;
    let settings =
        std::fs::read_to_string(app.paths.app_data.join("desktop.toml")).expect("settings");
    assert!(!settings.contains(&upstream.origin), "{settings}");
}

#[tokio::test]
async fn signing_out_and_keeping_leaves_the_notes_and_revokes_the_device() {
    let upstream = upstream().await;
    let app = app().await;
    let note = with_downloaded_note(&upstream, &app).await;
    let token = app.secrets.get(&upstream.origin).unwrap().expect("token");
    assert_eq!(
        sign_out(&app, &upstream, "keep").await.status(),
        StatusCode::SEE_OTHER
    );
    let me = client()
        .get(format!("{}/api/v1/devices/self", upstream.origin))
        .bearer_auth(&token)
        .send()
        .await
        .expect("self");
    assert!(
        note.exists() && me.status() == StatusCode::UNAUTHORIZED,
        "{}",
        me.status()
    );
}

#[tokio::test]
async fn a_kept_server_is_listed_as_signed_out_with_sign_in_again() {
    let upstream = upstream().await;
    let app = app().await;
    with_downloaded_note(&upstream, &app).await;
    sign_out(&app, &upstream, "keep").await;
    let page = body(app.get("/desktop/connect").await).await;
    assert!(
        page.contains("Signed out")
            && page.contains("Sign in again")
            && page.contains("Remove notes"),
        "{page}"
    );
}

#[tokio::test]
async fn kept_notes_still_open_while_signed_out() {
    let upstream = upstream().await;
    let app = app().await;
    with_downloaded_note(&upstream, &app).await;
    sign_out(&app, &upstream, "keep").await;
    let notes = body(app.get("/api/v1/vaults/work/notes").await).await;
    assert!(notes.contains("Hello.md"), "{notes}");
}

#[tokio::test]
async fn signing_in_again_as_the_same_person_resumes_the_kept_vault() {
    let upstream = upstream().await;
    let app = app().await;
    with_downloaded_note(&upstream, &app).await;
    sign_out(&app, &upstream, "keep").await;
    let authorize = app.start_connecting(&upstream.origin).await;
    let landed = approve_in_browser(&upstream, &authorize).await;
    assert_eq!(landed.status(), StatusCode::OK);
    let settings =
        std::fs::read_to_string(app.paths.app_data.join("desktop.toml")).expect("settings");
    assert!(
        !settings.contains("signed_out") && !settings.contains("work-2"),
        "{settings}"
    );
}

#[tokio::test]
async fn signing_in_as_someone_else_over_kept_notes_is_refused_and_revoked() {
    let upstream = upstream().await;
    let app = app().await;
    with_downloaded_note(&upstream, &app).await;
    sign_out(&app, &upstream, "keep").await;
    let authorize = app.start_connecting(&upstream.origin).await;
    let landed = approve_as(&upstream, &upstream.bob, &authorize).await;
    assert_eq!(landed.status(), StatusCode::CONFLICT);
    assert!(app.secrets.get(&upstream.origin).unwrap().is_none());
}

#[tokio::test]
async fn connecting_again_to_a_signed_in_server_is_refused() {
    let upstream = upstream().await;
    let app = app().await;
    connected(&upstream, &app).await;
    let refused = app
        .post("/desktop/connect", &[("server", upstream.origin.as_str())])
        .await;
    assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn two_servers_are_listed_and_their_vaults_sit_side_by_side() {
    let first = upstream().await;
    let second = upstream().await;
    let app = app().await;
    with_server_vault(&first, &app).await;
    connected(&second, &app).await;
    assert!(
        eventually_async(&app, "/api/v1/vaults", "\"work-2\"").await,
        "the second server's vault never appeared"
    );
    let servers = body(app.get("/desktop/connect").await).await;
    let host = |u: &Upstream| u.origin.trim_start_matches("http://").to_string();
    assert!(
        servers.contains(&host(&first)) && servers.contains(&host(&second)),
        "{servers}"
    );
}

#[tokio::test]
async fn signing_out_of_one_server_leaves_the_other_signed_in() {
    let first = upstream().await;
    let second = upstream().await;
    let app = app().await;
    with_server_vault(&first, &app).await;
    connected(&second, &app).await;
    assert!(eventually_async(&app, "/api/v1/vaults", "\"work-2\"").await);
    sign_out(&app, &second, "remove").await;
    let vaults = body(app.get("/api/v1/vaults").await).await;
    assert!(
        app.secrets.get(&first.origin).unwrap().is_some()
            && vaults.contains("\"work\"")
            && !vaults.contains("\"work-2\""),
        "{vaults}"
    );
}

/// Polls `path` until its body contains `needle`, for up to ten seconds.
async fn eventually_async(app: &App, path: &str, needle: &str) -> bool {
    for _ in 0..100 {
        if body(app.get(path).await).await.contains(needle) {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    false
}

#[tokio::test]
async fn removing_kept_notes_warns_that_edits_since_signing_out_were_never_sent() {
    let upstream = upstream().await;
    let app = app().await;
    with_downloaded_note(&upstream, &app).await;
    sign_out(&app, &upstream, "keep").await;
    let page = body(
        app.get(&format!("/desktop/disconnect?server={}", upstream.origin))
            .await,
    )
    .await;
    assert!(
        page.contains("since you signed out were never sent"),
        "{page}"
    );
}

impl Upstream {
    /// Rewrites the vault's `access.toml` and makes the server read it.
    fn set_access(&self, policy: &str) {
        std::fs::write(self.root.join("access.toml"), policy).expect("policy");
        assert!(self.state.reload_access().is_empty());
    }
}

#[tokio::test]
async fn a_vault_alice_was_removed_from_leaves_the_app_with_only_her_offline_edits() {
    let upstream = upstream().await;
    let app = app().await;
    let note = with_downloaded_note(&upstream, &app).await;
    let mut edited = std::fs::read_to_string(&note).expect("note");
    edited.push_str("\nalice-offline-line\n");
    std::fs::write(&note, edited).expect("edit");
    upstream.set_access("[[members]]\nuser = \"bob\"\nrole = \"owner\"\n");
    // The vault stays, now on this device alone, holding just the recovered note.
    let recovered = note
        .parent()
        .expect("notes")
        .join("Recovered/Hello (offline edits).md");
    assert!(
        eventually(|| recovered.exists()).await,
        "nothing was recovered"
    );
    assert!(eventually(|| !note.exists()).await);
    let text = std::fs::read_to_string(&recovered).expect("recovered");
    assert!(text.contains("alice-offline-line") && text.contains("from the server"));
    // The vault stops being a server vault after its notes are settled, so this is waited for
    // rather than read the moment the recovered note appears.
    let settings = app.paths.app_data.join("desktop.toml");
    assert!(
        eventually(|| std::fs::read_to_string(&settings).is_ok_and(|s| !s.contains("[[replicas]]")))
            .await,
        "the vault is still a server vault"
    );
}

#[tokio::test]
async fn a_vault_alice_was_removed_from_with_nothing_written_here_goes_entirely() {
    let upstream = upstream().await;
    let app = app().await;
    let note = with_downloaded_note(&upstream, &app).await;
    let folder = note
        .parent()
        .and_then(std::path::Path::parent)
        .expect("vault folder")
        .to_path_buf();
    // Unchanged is only known once a pass has recorded the note; before that, it would be
    // kept as recovered, which is the safe side.
    let record = folder.join(".memberberry/replica/record.json");
    assert!(
        eventually(|| std::fs::read_to_string(&record).is_ok_and(|r| r.contains("Hello.md"))).await
    );
    upstream.set_access("[[members]]\nuser = \"bob\"\nrole = \"owner\"\n");
    assert!(
        eventually(|| !folder.exists()).await,
        "the vault folder is still there"
    );
    let listed = body(app.get("/api/v1/vaults").await).await;
    assert!(!listed.contains("\"work\""), "{listed}");
}

#[tokio::test]
async fn a_recovered_note_is_listed_and_can_be_created_again_from_the_app() {
    let upstream = upstream().await;
    let app = app().await;
    let note = with_downloaded_note(&upstream, &app).await;
    let record = note
        .parent()
        .and_then(std::path::Path::parent)
        .expect("vault folder")
        .join(".memberberry/replica/record.json");
    assert!(
        eventually(|| std::fs::read_to_string(&record).is_ok_and(|r| r.contains("Hello.md"))).await
    );
    let mut edited = std::fs::read_to_string(&note).expect("note");
    edited.push_str("\nalice-offline-line\n");
    std::fs::write(&note, edited).expect("edit");
    std::fs::remove_file(upstream.root.join("notes/Hello.md")).expect("delete upstream");
    let _ = upstream
        .state
        .maintain_index(&mb_server::watch::Changes::All);
    assert!(
        eventually_async(
            &app,
            "/api/v1/vaults/work/offline",
            "Recovered/Hello (offline edits).md"
        )
        .await,
        "the recovered note is not listed"
    );
    let placed = send_json(
        &app,
        reqwest::Method::POST,
        "/api/v1/vaults/work/recovered",
        "{\"path\":\"Recovered/Hello (offline edits).md\"}",
    )
    .await;
    assert!(placed.status().is_success(), "{}", placed.status());
    let back = std::fs::read_to_string(upstream.root.join("notes/Hello.md")).expect("upstream");
    assert!(back.contains("alice-offline-line"), "{back}");
    assert!(!body(placed).await.contains("Recovered/Hello"));
}

#[tokio::test]
async fn placing_a_recovered_note_needs_the_windows_origin() {
    let upstream = upstream().await;
    let app = app().await;
    with_server_vault(&upstream, &app).await;
    let refused = client()
        .post(format!("{}/api/v1/vaults/work/recovered", app.origin))
        .header(COOKIE, &app.cookie)
        .header(ORIGIN, "https://attacker.example")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body("{\"path\":\"Recovered/Hello (offline edits).md\"}")
        .send()
        .await
        .expect("request");
    assert_eq!(refused.status(), reqwest::StatusCode::FORBIDDEN);
}

/// The window's sync socket, opened as the app's own window opens it.
async fn window_socket(
    app: &App,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let mut request = format!("{}/api/v1/sync", app.origin.replace("http", "ws"))
        .into_client_request()
        .expect("request");
    request
        .headers_mut()
        .insert("Cookie", app.cookie.parse().expect("cookie"));
    request
        .headers_mut()
        .insert("Origin", app.origin.parse().expect("origin"));
    tokio_tungstenite::connect_async(request)
        .await
        .expect("socket")
        .0
}

#[tokio::test]
async fn a_recovered_note_opens_from_this_computer_while_the_server_is_online() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let upstream = upstream().await;
    let app = app().await;
    let note = with_downloaded_note(&upstream, &app).await;
    let record = note
        .parent()
        .and_then(std::path::Path::parent)
        .expect("vault folder")
        .join(".memberberry/replica/record.json");
    assert!(
        eventually(|| std::fs::read_to_string(&record).is_ok_and(|r| r.contains("Hello.md"))).await
    );
    let mut edited = std::fs::read_to_string(&note).expect("note");
    edited.push_str("\nalice-offline-line\n");
    std::fs::write(&note, edited).expect("edit");
    std::fs::remove_file(upstream.root.join("notes/Hello.md")).expect("delete upstream");
    let _ = upstream
        .state
        .maintain_index(&mb_server::watch::Changes::All);
    const RECOVERED: &str = "Recovered/Hello (offline edits).md";
    assert!(
        eventually_async(&app, "/api/v1/vaults/work/notes", RECOVERED).await,
        "not listed"
    );
    let mut socket = window_socket(&app).await;
    let schema = mb_server::sync::current_schema_version().expect("schema");
    socket
        .send(Message::Text(
            serde_json::json!({"type":"subscribe","vault":"work","note":RECOVERED,"schema_version":schema})
                .to_string()
                .into(),
        ))
        .await
        .expect("subscribe");
    let first = socket.next().await.expect("a frame").expect("frame");
    let text = first.to_text().unwrap_or_default().to_string();
    assert!(text.contains("admitted"), "{text}");
}
