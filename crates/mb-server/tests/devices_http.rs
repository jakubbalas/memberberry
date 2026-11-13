//! Device sign-in over HTTP on the user's server (`SPEC.md` §6.8.1, E36).

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

use std::net::SocketAddr;
use std::sync::Arc;

use mb_server::http::{AppState, router};
use mb_server::{Slug, Vault};
use reqwest::header::{CONTENT_SECURITY_POLICY, COOKIE, LOCATION, ORIGIN};
use reqwest::{Client, StatusCode};

const PASSWORD: &str = "correct horse battery staple";
const REDIRECT: &str = "http://127.0.0.1:54766/desktop/connect/callback";
const STATE: &str = "state-value-that-is-long-enough-to-be-valid-0123456789";
const VERIFIER: &str = "dBjftJeZ4CVP-mJ92QcmjePbz2ZkJZDV3cZn1qlqVYp1aTNH7k9C";
// Computed independently with Python's hashlib; see mb-auth's device tests.
const CHALLENGE: &str = "SEnN_wAWTxD9j_AMtYKytwUrsRjDJX1jWsQ95vj5xMM";

struct Server {
    _dir: tempfile::TempDir,
    origin: String,
    alice: String,
    bob: String,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
}

impl Drop for Server {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}

fn vault(dir: &std::path::Path, slug: &str, policy: &str) -> Vault {
    let root = dir.join(slug);
    std::fs::create_dir_all(root.join("notes")).expect("notes");
    std::fs::write(root.join("access.toml"), policy).expect("policy");
    std::fs::write(root.join("notes/hello.md"), "# Hello\n").expect("note");
    Vault::open(Slug::parse(slug).expect("slug"), slug, root).expect("vault")
}

async fn server() -> Server {
    let dir = tempfile::tempdir().expect("dir");
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth");
    let alice = auth
        .setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: PASSWORD,
        })
        .expect("alice");
    let bob = auth
        .create_user(mb_auth::NewUser {
            username: "bob",
            display_name: "Bob <b>",
            password: PASSWORD,
        })
        .expect("bob");
    let session = |auth: &mb_auth::AuthDb, id| {
        let token = auth.create_session(id, 4_102_444_800).expect("session");
        format!(
            "mb_session={}",
            auth.signed_session_cookie(&token).expect("cookie")
        )
    };
    let alice_cookie = session(&auth, alice.id);
    let bob_cookie = session(&auth, bob.id);
    let vaults = vec![
        vault(
            dir.path(),
            "private",
            "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n",
        ),
        vault(
            dir.path(),
            "shared",
            "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n[[members]]\nuser = \"bob\"\nrole = \"viewer\"\n",
        ),
    ];
    let state = AppState::authenticated(vaults, auth)
        .expect("state")
        .with_vault_management(dir.path().join("server.toml"), false)
        .expect("management");
    let app = router(Arc::new(state));
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
    Server {
        _dir: dir,
        origin,
        alice: alice_cookie,
        bob: bob_cookie,
        stop: Some(stop),
    }
}

fn client() -> Client {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("client")
}

fn request_form<'a>(name: &'a str, decision: &'a str) -> Vec<(&'a str, &'a str)> {
    vec![
        ("redirect_uri", REDIRECT),
        ("state", STATE),
        ("code_challenge", CHALLENGE),
        ("code_challenge_method", "S256"),
        ("name", name),
        ("decision", decision),
    ]
}

fn authorize_url(server: &Server, redirect: &str) -> String {
    let mut url = reqwest::Url::parse(&format!("{}/devices/authorize", server.origin)).unwrap();
    url.query_pairs_mut()
        .append_pair("redirect_uri", redirect)
        .append_pair("state", STATE)
        .append_pair("code_challenge", CHALLENGE)
        .append_pair("code_challenge_method", "S256")
        .append_pair("name", "Laptop <script>");
    url.to_string()
}

/// Approves as `cookie` and returns the code from the redirect.
async fn approve(server: &Server, cookie: &str) -> String {
    let response = client()
        .post(format!("{}/devices/authorize", server.origin))
        .header(COOKIE, cookie)
        .header(ORIGIN, &server.origin)
        .form(&request_form("Laptop", "approve"))
        .send()
        .await
        .expect("approve");
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    let location = response.headers()[LOCATION].to_str().unwrap().to_string();
    let url = reqwest::Url::parse(&location).expect("redirect url");
    assert!(location.starts_with(REDIRECT));
    assert_eq!(
        url.query_pairs().find(|(k, _)| k == "state").unwrap().1,
        STATE
    );
    url.query_pairs()
        .find(|(k, _)| k == "code")
        .expect("code")
        .1
        .to_string()
}

async fn exchange(server: &Server, code: &str, verifier: &str) -> reqwest::Response {
    client()
        .post(format!("{}/api/v1/devices/token", server.origin))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(
            serde_json::json!({
                "code": code, "code_verifier": verifier, "redirect_uri": REDIRECT
            })
            .to_string(),
        )
        .send()
        .await
        .expect("exchange")
}

async fn device_token(server: &Server, cookie: &str) -> String {
    let code = approve(server, cookie).await;
    let body: serde_json::Value = exchange(server, &code, VERIFIER)
        .await
        .text()
        .await
        .map(|text| serde_json::from_str::<serde_json::Value>(&text).expect("json"))
        .expect("body");
    body["token"].as_str().expect("token").to_string()
}

#[tokio::test]
async fn signing_in_from_the_approval_page_returns_to_it() {
    let server = server().await;
    let page = client()
        .get(authorize_url(&server, REDIRECT))
        .send()
        .await
        .expect("page")
        .text()
        .await
        .expect("body");
    assert!(page.contains("name=\"next\" value=\"/devices/authorize?"));
    let next = format!(
        "/devices/authorize?redirect_uri={}",
        "http%3A%2F%2F127.0.0.1%3A54766%2Fdesktop%2Fconnect%2Fcallback"
    );
    let login = client()
        .post(format!("{}/login", server.origin))
        .form(&[
            ("username", "alice"),
            ("password", PASSWORD),
            ("next", &next),
        ])
        .send()
        .await
        .expect("login");
    assert_eq!(login.headers()[LOCATION], next.as_str());
}

#[tokio::test]
async fn sign_in_never_redirects_anywhere_but_a_device_approval() {
    let server = server().await;
    let login = client()
        .post(format!("{}/login", server.origin))
        .form(&[
            ("username", "alice"),
            ("password", PASSWORD),
            ("next", "https://evil.example/"),
        ])
        .send()
        .await
        .expect("login");
    assert_eq!(login.headers()[LOCATION], "/");
}

#[tokio::test]
async fn the_approval_page_escapes_the_device_name_and_allows_the_loopback_redirect() {
    let server = server().await;
    let response = client()
        .get(authorize_url(&server, REDIRECT))
        .header(COOKIE, &server.alice)
        .send()
        .await
        .expect("page");
    assert_eq!(response.status(), StatusCode::OK);
    let csp = response.headers().get(CONTENT_SECURITY_POLICY).cloned();
    let body = response.text().await.expect("body");
    assert!(body.contains("Laptop &lt;script&gt;") && !body.contains("<script>"));
    let csp_text = csp
        .map(|value| value.to_str().unwrap().to_string())
        .unwrap_or_else(|| body.clone());
    assert!(csp_text.contains("form-action 'self' http://127.0.0.1:*"));
}

#[tokio::test]
async fn a_foreign_redirect_uri_is_refused_before_anything_renders() {
    let server = server().await;
    let response = client()
        .get(authorize_url(&server, "https://evil.example/callback"))
        .header(COOKIE, &server.alice)
        .send()
        .await
        .expect("page");
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn an_approval_without_same_origin_is_refused() {
    let server = server().await;
    let response = client()
        .post(format!("{}/devices/authorize", server.origin))
        .header(COOKIE, &server.alice)
        .form(&request_form("Laptop", "approve"))
        .send()
        .await
        .expect("approve");
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn an_approval_without_a_session_is_refused() {
    let server = server().await;
    let response = client()
        .post(format!("{}/devices/authorize", server.origin))
        .header(ORIGIN, &server.origin)
        .form(&request_form("Laptop", "approve"))
        .send()
        .await
        .expect("approve");
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn deny_returns_to_the_device_without_a_code() {
    let server = server().await;
    let response = client()
        .post(format!("{}/devices/authorize", server.origin))
        .header(COOKIE, &server.alice)
        .header(ORIGIN, &server.origin)
        .form(&request_form("Laptop", "deny"))
        .send()
        .await
        .expect("deny");
    let location = response.headers()[LOCATION].to_str().unwrap();
    assert!(location.contains("error=access_denied") && !location.contains("code="));
}

#[tokio::test]
async fn an_approved_device_learns_who_it_acts_as() {
    let server = server().await;
    let token = device_token(&server, &server.alice).await;
    let me: serde_json::Value = client()
        .get(format!("{}/api/v1/devices/self", server.origin))
        .bearer_auth(&token)
        .send()
        .await
        .expect("self")
        .text()
        .await
        .map(|text| serde_json::from_str::<serde_json::Value>(&text).expect("json"))
        .expect("body");
    assert_eq!(me["username"], "alice");
}

#[tokio::test]
async fn a_replayed_code_is_an_invalid_grant() {
    let server = server().await;
    let code = approve(&server, &server.alice).await;
    assert_eq!(
        exchange(&server, &code, VERIFIER).await.status(),
        StatusCode::OK
    );
    let replay = exchange(&server, &code, VERIFIER).await;
    assert_eq!(replay.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_wrong_verifier_is_an_invalid_grant() {
    let server = server().await;
    let code = approve(&server, &server.alice).await;
    let response = exchange(&server, &code, &"x".repeat(43)).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn code_exchanges_are_rate_limited() {
    let server = server().await;
    let mut last = StatusCode::OK;
    for _ in 0..11 {
        last = exchange(&server, &"a".repeat(64), VERIFIER).await.status();
    }
    assert_eq!(last, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn a_device_sees_exactly_the_vaults_its_user_sees() {
    let server = server().await;
    let token = device_token(&server, &server.bob).await;
    let by_device: serde_json::Value = client()
        .get(format!("{}/api/v1/vaults", server.origin))
        .bearer_auth(&token)
        .send()
        .await
        .expect("list")
        .text()
        .await
        .map(|text| serde_json::from_str::<serde_json::Value>(&text).expect("json"))
        .expect("body");
    let by_session: serde_json::Value = client()
        .get(format!("{}/api/v1/vaults", server.origin))
        .header(COOKIE, &server.bob)
        .send()
        .await
        .expect("list")
        .text()
        .await
        .map(|text| serde_json::from_str::<serde_json::Value>(&text).expect("json"))
        .expect("body");
    assert_eq!(by_device, by_session);
    assert_eq!(by_device.as_array().map(Vec::len), Some(1));
}

#[tokio::test]
async fn an_administrators_device_cannot_administer_the_server() {
    let server = server().await;
    let token = device_token(&server, &server.alice).await;
    let response = client()
        .post(format!("{}/vaults/new", server.origin))
        .bearer_auth(&token)
        .header(ORIGIN, &server.origin)
        .form(&[("name", "Planted"), ("slug", "planted")])
        .send()
        .await
        .expect("create vault");
    assert!(!response.status().is_redirection() && !response.status().is_success());
}

#[tokio::test]
async fn a_device_that_disconnects_stops_working() {
    let server = server().await;
    let token = device_token(&server, &server.alice).await;
    let revoked = client()
        .delete(format!("{}/api/v1/devices/self", server.origin))
        .bearer_auth(&token)
        .send()
        .await
        .expect("revoke");
    assert_eq!(revoked.status(), StatusCode::NO_CONTENT);
    let after = client()
        .get(format!("{}/api/v1/devices/self", server.origin))
        .bearer_auth(&token)
        .send()
        .await
        .expect("self");
    assert_eq!(after.status(), StatusCode::UNAUTHORIZED);
}
