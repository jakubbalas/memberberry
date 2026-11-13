//! Signing in through an identity provider (`SPEC.md` §6.8.2): the page, the flow, linking,
//! and the password switch. The refusals E38 requires are in the leak suite.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

#[path = "support/oidc_provider.rs"]
mod oidc_provider;

use std::sync::Arc;

use mb_server::Vault;
use mb_server::http::{AppState, router};
use mb_server::vault::Slug;
use oidc_provider::{Provider, finish, start};

struct Server {
    _dir: tempfile::TempDir,
    origin: String,
    _state: Arc<AppState>,
    _stop: tokio::sync::oneshot::Sender<()>,
}

/// A server with a vault `home` that alice (email `alice@example.com`) owns.
async fn server(provider: &Provider, password_login: bool) -> Server {
    let dir = tempfile::tempdir().expect("dir");
    let root = dir.path().join("home");
    std::fs::create_dir_all(root.join("notes")).expect("notes");
    std::fs::write(
        root.join("access.toml"),
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n",
    )
    .expect("policy");
    std::fs::write(root.join("notes/Hello.md"), "# Hello\n").expect("note");
    let vault = Vault::open(Slug::parse("home").expect("slug"), "Home", &root).expect("vault");
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth");
    let alice = auth
        .setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: "correct horse battery staple",
        })
        .expect("alice");
    auth.set_email(alice.id, Some("alice@example.com"))
        .expect("email");
    let state = Arc::new(
        AppState::authenticated(vec![vault], auth)
            .expect("state")
            .with_oidc(provider.config(password_login))
            .expect("oidc"),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let origin = format!("http://{}", listener.local_addr().expect("addr"));
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let app = router(Arc::clone(&state));
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .with_graceful_shutdown(async {
            drop(stopped.await);
        })
        .await
    });
    Server {
        _dir: dir,
        origin,
        _state: state,
        _stop: stop,
    }
}

async fn page(origin: &str, path: &str, cookie: Option<&str>) -> String {
    let mut request = reqwest::Client::new().get(format!("{origin}{path}"));
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    request
        .send()
        .await
        .expect("get")
        .text()
        .await
        .expect("body")
}

#[tokio::test]
async fn the_sign_in_page_offers_the_provider() {
    let provider = Provider::start().await;
    let server = server(&provider, true).await;
    let body = page(&server.origin, "/", None).await;
    assert!(
        body.contains("Sign in with Test ID") && body.contains("/oidc/start"),
        "{body}"
    );
}

#[tokio::test]
async fn passwords_stay_beside_the_provider_unless_switched_off() {
    let provider = Provider::start().await;
    let server = server(&provider, true).await;
    let body = page(&server.origin, "/", None).await;
    assert!(body.contains("name=\"password\""), "{body}");
}

#[tokio::test]
async fn switched_off_the_password_form_is_gone() {
    let provider = Provider::start().await;
    let server = server(&provider, false).await;
    let body = page(&server.origin, "/", None).await;
    assert!(
        !body.contains("name=\"password\"") && body.contains("Sign in with Test ID"),
        "{body}"
    );
}

#[tokio::test]
async fn switched_off_a_posted_password_is_refused() {
    let provider = Provider::start().await;
    let server = server(&provider, false).await;
    let response = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
        .post(format!("{}/login", server.origin))
        .form(&[
            ("username", "alice"),
            ("password", "correct horse battery staple"),
        ])
        .send()
        .await
        .expect("login");
    assert_eq!(response.status(), reqwest::StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_verified_email_signs_in_to_the_existing_account_and_its_vaults() {
    let provider = Provider::start().await;
    let server = server(&provider, true).await;
    let attempt = start(&server.origin).await;
    provider.issue(
        "code-1",
        &attempt.challenge,
        provider.claims(&attempt.nonce, "sub-alice", "alice@example.com", true),
    );
    let session = finish(&server.origin, &attempt, "code-1", &attempt.cookie)
        .await
        .expect("a session");
    let home = page(&server.origin, "/", Some(&session)).await;
    assert!(home.contains("Home"), "{home}");
}

#[tokio::test]
async fn a_new_person_gets_an_account_with_no_vaults() {
    let provider = Provider::start().await;
    let server = server(&provider, true).await;
    let attempt = start(&server.origin).await;
    provider.issue(
        "code-1",
        &attempt.challenge,
        provider.claims(&attempt.nonce, "sub-new", "new@example.com", true),
    );
    let session = finish(&server.origin, &attempt, "code-1", &attempt.cookie)
        .await
        .expect("a session");
    let home = page(&server.origin, "/", Some(&session)).await;
    assert!(
        !home.contains("Home") && home.contains("No vaults are shared with you yet"),
        "{home}"
    );
}

#[tokio::test]
async fn a_provider_sign_in_is_audited() {
    let provider = Provider::start().await;
    let dir = tempfile::tempdir().expect("dir");
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth");
    auth.setup_first_user(mb_auth::NewUser {
        username: "alice",
        display_name: "Alice",
        password: "correct horse battery staple",
    })
    .expect("alice");
    let audit = mb_server::audit::AuditLog::new(dir.path(), 1024 * 1024).expect("audit");
    let state = Arc::new(
        AppState::authenticated_with_audit_and_web_root(
            vec![],
            auth,
            Some(audit),
            dir.path().join("web"),
        )
        .expect("state")
        .with_oidc(provider.config(true))
        .expect("oidc"),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let origin = format!("http://{}", listener.local_addr().expect("addr"));
    let app = router(state);
    let served = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
    });
    let attempt = start(&origin).await;
    provider.issue(
        "code-1",
        &attempt.challenge,
        provider.claims(&attempt.nonce, "sub-new", "new@example.com", true),
    );
    finish(&origin, &attempt, "code-1", &attempt.cookie)
        .await
        .expect("a session");
    let log = std::fs::read_to_string(dir.path().join("audit.log")).expect("audit log");
    assert!(log.contains("oidc:created"), "{log}");
    served.abort();
}

#[tokio::test]
async fn the_client_secret_never_appears_in_a_debug_print() {
    let provider = Provider::start().await;
    let printed = format!("{:?}", provider.config(true));
    assert!(!printed.contains(oidc_provider::CLIENT_SECRET), "{printed}");
}

#[tokio::test]
async fn a_misconfigured_redirect_url_is_refused_at_startup() {
    let provider = Provider::start().await;
    let mut config = provider.config(true);
    config.redirect_url = "https://notes.example.com/somewhere".into();
    let auth = mb_auth::AuthDb::open_in_memory().expect("auth");
    let state = AppState::authenticated(vec![], auth).expect("state");
    assert!(state.with_oidc(config).is_err());
}

#[tokio::test]
async fn signing_in_returns_to_a_device_approval() {
    let provider = Provider::start().await;
    let server = server(&provider, true).await;
    let next = "/devices/authorize?redirect_uri=x";
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let started = client
        .get(format!(
            "{}/oidc/start?next={}",
            server.origin, "%2Fdevices%2Fauthorize%3Fredirect_uri%3Dx"
        ))
        .send()
        .await
        .expect("start");
    let location = started.headers()["location"].to_str().unwrap().to_string();
    let cookie = started
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok()?.split(';').next().map(str::to_string))
        .find(|pair| pair.starts_with("mb_oidc="))
        .expect("cookie");
    let url = reqwest::Url::parse(&location).unwrap();
    let param = |name: &str| {
        url.query_pairs()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.into_owned())
            .unwrap()
    };
    provider.issue(
        "code-1",
        &param("code_challenge"),
        provider.claims(&param("nonce"), "sub-alice", "alice@example.com", true),
    );
    let back = client
        .get(format!(
            "{}/oidc/callback?code=code-1&state={}",
            server.origin,
            param("state")
        ))
        .header("cookie", cookie)
        .send()
        .await
        .expect("callback");
    assert_eq!(back.headers()["location"], next);
}
