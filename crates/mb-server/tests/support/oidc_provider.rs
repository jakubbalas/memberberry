//! A fake OpenID Connect provider for sign-in tests (`SPEC.md` §6.8.2).
//!
//! Real in the parts the server relies on: a discovery document, and a token endpoint that
//! checks the client's credentials and the PKCE verifier before answering with an ID token.
//! The test decides the token's claims, which is what lets each E38 check be broken alone.

#![allow(dead_code, clippy::expect_used, clippy::unwrap_used)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::extract::{Form, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use base64::Engine as _;

pub const CLIENT_ID: &str = "memberberry";
pub const CLIENT_SECRET: &str = "test-client-secret";

#[derive(Default)]
struct Issued {
    /// code → (PKCE challenge, ID-token claims)
    codes: HashMap<String, (String, serde_json::Value)>,
}

pub struct Provider {
    pub issuer: String,
    issued: Arc<Mutex<Issued>>,
    _stop: tokio::sync::oneshot::Sender<()>,
}

impl Provider {
    pub async fn start() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let issuer = format!("http://{}", listener.local_addr().expect("addr"));
        let issued: Arc<Mutex<Issued>> = Arc::default();
        let discovery = serde_json::json!({
            "issuer": issuer,
            "authorization_endpoint": format!("{issuer}/authorize"),
            "token_endpoint": format!("{issuer}/token"),
        })
        .to_string();
        let app = axum::Router::new()
            .route(
                "/.well-known/openid-configuration",
                get(move || async move { discovery }),
            )
            .route("/token", post(token))
            .with_state(Arc::clone(&issued));
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    drop(stopped.await);
                })
                .await
        });
        Self {
            issuer,
            issued,
            _stop: stop,
        }
    }

    /// Makes `code` redeemable once, by the holder of the verifier for `challenge`.
    pub fn issue(&self, code: &str, challenge: &str, claims: serde_json::Value) {
        self.issued
            .lock()
            .expect("issued")
            .codes
            .insert(code.to_string(), (challenge.to_string(), claims));
    }

    /// The `[oidc]` table for this provider.
    pub fn config(&self, password_login: bool) -> mb_server::config::OidcConfig {
        mb_server::config::OidcConfig {
            issuer: self.issuer.clone(),
            client_id: CLIENT_ID.into(),
            client_secret: CLIENT_SECRET.into(),
            redirect_url: "http://127.0.0.1:9999/oidc/callback".into(),
            name: "Test ID".into(),
            scopes: "openid profile email".into(),
            groups_claim: "groups".into(),
            password_login,
        }
    }

    /// Valid claims for a token answering `nonce`, before a test breaks one.
    pub fn claims(&self, nonce: &str, sub: &str, email: &str, verified: bool) -> serde_json::Value {
        serde_json::json!({
            "iss": self.issuer,
            "sub": sub,
            "aud": CLIENT_ID,
            "exp": 4_102_444_800_i64,
            "iat": 1_700_000_000_i64,
            "nonce": nonce,
            "email": email,
            "email_verified": verified,
            "preferred_username": sub,
            "name": "Someone",
        })
    }
}

async fn token(
    State(issued): State<Arc<Mutex<Issued>>>,
    headers: HeaderMap,
    Form(form): Form<HashMap<String, String>>,
) -> axum::response::Response {
    let expected = format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(format!("{CLIENT_ID}:{CLIENT_SECRET}"))
    );
    if headers.get("authorization").and_then(|v| v.to_str().ok()) != Some(expected.as_str()) {
        return (StatusCode::UNAUTHORIZED, "client").into_response();
    }
    let code = form.get("code").cloned().unwrap_or_default();
    let verifier = form.get("code_verifier").cloned().unwrap_or_default();
    let Some((challenge, claims)) = issued.lock().expect("issued").codes.remove(&code) else {
        return (StatusCode::BAD_REQUEST, "invalid_grant").into_response();
    };
    if mb_auth::pkce_challenge(&verifier) != challenge {
        return (StatusCode::BAD_REQUEST, "invalid_grant").into_response();
    }
    let part = |value: &serde_json::Value| {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.to_string())
    };
    let id_token = format!(
        "{}.{}.not-checked",
        part(&serde_json::json!({"alg": "RS256", "typ": "JWT"})),
        part(&claims)
    );
    serde_json::json!({ "id_token": id_token, "access_token": "x", "token_type": "Bearer" })
        .to_string()
        .into_response()
}

/// Drives one sign-in: start, have the provider issue a code, call back.
pub struct Attempt {
    pub state: String,
    pub nonce: String,
    pub challenge: String,
    pub cookie: String,
}

pub async fn start(origin: &str) -> Attempt {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("client");
    let started = client
        .get(format!("{origin}/oidc/start"))
        .send()
        .await
        .expect("start");
    assert_eq!(started.status(), reqwest::StatusCode::SEE_OTHER);
    let location = started.headers()["location"]
        .to_str()
        .expect("location")
        .to_string();
    let cookie = started
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok()?.split(';').next().map(str::to_string))
        .find(|pair| pair.starts_with("mb_oidc="))
        .expect("state cookie");
    let url = reqwest::Url::parse(&location).expect("provider url");
    let param = |name: &str| {
        url.query_pairs()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.into_owned())
            .expect(name)
    };
    Attempt {
        state: param("state"),
        nonce: param("nonce"),
        challenge: param("code_challenge"),
        cookie,
    }
}

/// Calls back with `code`, returning the session cookie if a session was issued.
pub async fn finish(origin: &str, attempt: &Attempt, code: &str, cookie: &str) -> Option<String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("client");
    let response = client
        .get(format!(
            "{origin}/oidc/callback?code={code}&state={}",
            attempt.state
        ))
        .header("cookie", cookie)
        .send()
        .await
        .expect("callback");
    response
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok()?.split(';').next().map(str::to_string))
        .find(|pair| pair.starts_with("mb_session=") && pair.len() > "mb_session=".len())
}
