//! Sign-in through the operator's OpenID Connect provider (`SPEC.md` §6.8.2, E38).
//!
//! `GET /oidc/start` sends the browser to the provider with a fresh `state`, `nonce` and
//! PKCE challenge; `GET /oidc/callback` takes the code back, exchanges it at the provider's
//! token endpoint over TLS, validates the ID token's claims, and signs the person in to the
//! account [`mb_auth::AuthDb::sign_in_oidc`] finds, links or creates.
//!
//! The ID token's signature is not checked: OIDC Core §3.1.3.7 lets a client rely on TLS
//! validation of the token endpoint instead, for a token received directly from it — the
//! only way this server ever receives one. That keeps a JWT/JWKS implementation out of the
//! authentication path; the cost is that the token endpoint must be `https` (a loopback
//! provider is allowed, for development and tests).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64::Engine as _;
use rand_core::{OsRng, RngCore};
use serde::Deserialize;

use super::*;
use crate::config::OidcConfig;

/// How long a sign-in attempt stays valid at the provider.
const ATTEMPT_FOR: Duration = Duration::from_secs(10 * 60);
/// The cookie binding an attempt's `state` to the browser that started it.
const STATE_COOKIE: &str = "mb_oidc";

/// The configured provider and the attempts in flight.
#[derive(Debug)]
pub(crate) struct Oidc {
    config: OidcConfig,
    client: reqwest::Client,
    attempts: Mutex<HashMap<String, Attempt>>,
}

#[derive(Debug)]
struct Attempt {
    verifier: String,
    nonce: String,
    next: String,
    started: Instant,
}

/// What `<issuer>/.well-known/openid-configuration` says, as far as this server needs.
#[derive(Debug, Deserialize)]
struct Discovery {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
}

impl Oidc {
    /// Validates `config` and prepares the client.
    ///
    /// # Errors
    ///
    /// A configuration error naming the field that is wrong.
    pub(crate) fn new(config: OidcConfig) -> Result<Self, Error> {
        let issuer = reqwest::Url::parse(&config.issuer)
            .map_err(|_| Error::Config("[oidc] issuer is not a URL".into()))?;
        if !secure_or_loopback(&issuer) {
            return Err(Error::Config("[oidc] issuer must be https".into()));
        }
        let redirect = reqwest::Url::parse(&config.redirect_url)
            .map_err(|_| Error::Config("[oidc] redirect_url is not a URL".into()))?;
        if !redirect.path().ends_with("/oidc/callback") {
            return Err(Error::Config(
                "[oidc] redirect_url must end in /oidc/callback".into(),
            ));
        }
        if config.client_id.is_empty() || config.client_secret.is_empty() {
            return Err(Error::Config(
                "[oidc] client_id and client_secret are required".into(),
            ));
        }
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| Error::Config(format!("HTTP client: {e}")))?;
        Ok(Self {
            config,
            client,
            attempts: Mutex::new(HashMap::new()),
        })
    }

    /// The button's provider name.
    pub(crate) fn name(&self) -> &str {
        &self.config.name
    }

    /// Whether the password form stays available.
    pub(crate) fn passwords(&self) -> bool {
        self.config.password_login
    }

    async fn discover(&self) -> Result<Discovery, String> {
        let url = format!(
            "{}/.well-known/openid-configuration",
            self.config.issuer.trim_end_matches('/')
        );
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| format!("the provider could not be reached: {e}"))?;
        if !response.status().is_success() {
            return Err(format!("the provider answered {}", response.status()));
        }
        let text = response.text().await.map_err(|e| e.to_string())?;
        let discovery: Discovery = serde_json::from_str(&text)
            .map_err(|_| "the provider's discovery document is unreadable".to_string())?;
        // E38: the discovery document must describe the configured issuer, not another one.
        if discovery.issuer != self.config.issuer {
            return Err("the provider's issuer does not match the configured one".into());
        }
        let token = reqwest::Url::parse(&discovery.token_endpoint)
            .map_err(|_| "the provider's token endpoint is not a URL".to_string())?;
        if !secure_or_loopback(&token) {
            return Err("the provider's token endpoint must be https".into());
        }
        Ok(discovery)
    }
}

fn secure_or_loopback(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        || (url.scheme() == "http"
            && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")))
}

fn random() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn digest(value: &str) -> String {
    use sha2::Digest as _;
    let hash = sha2::Sha256::digest(value.as_bytes());
    hash.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[derive(Debug, Deserialize)]
pub(super) struct StartQuery {
    #[serde(default)]
    next: String,
}

/// `GET /oidc/start`: off to the provider (E38).
pub(super) async fn start(
    State(state): State<Arc<AppState>>,
    Query(query): Query<StartQuery>,
) -> Response {
    let Some(oidc) = state.oidc.as_ref() else {
        return not_found().await;
    };
    let discovery = match oidc.discover().await {
        Ok(discovery) => discovery,
        Err(message) => return sign_in_refused(&state, &message),
    };
    let token = random();
    let verifier = random();
    let nonce = random();
    let next = if devices::valid_login_next(&query.next) {
        query.next
    } else {
        String::new()
    };
    let Ok(mut attempts) = oidc.attempts.lock() else {
        return server_error(&Error::Auth("sign-in lock poisoned".into()));
    };
    attempts.retain(|_, attempt| attempt.started.elapsed() < ATTEMPT_FOR);
    attempts.insert(
        digest(&token),
        Attempt {
            verifier: verifier.clone(),
            nonce: nonce.clone(),
            next,
            started: Instant::now(),
        },
    );
    drop(attempts);
    let Ok(mut url) = reqwest::Url::parse(&discovery.authorization_endpoint) else {
        return sign_in_refused(&state, "the provider's sign-in address is not a URL");
    };
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &oidc.config.client_id)
        .append_pair("redirect_uri", &oidc.config.redirect_url)
        .append_pair("scope", &oidc.config.scopes)
        .append_pair("state", &token)
        .append_pair("nonce", &nonce)
        .append_pair("code_challenge", &mb_auth::pkce_challenge(&verifier))
        .append_pair("code_challenge_method", "S256");
    let cookie = format!(
        "{STATE_COOKIE}={token}; HttpOnly; SameSite=Lax; Path=/oidc; Max-Age={}",
        ATTEMPT_FOR.as_secs()
    );
    (
        StatusCode::SEE_OTHER,
        [
            (header::LOCATION, url.to_string()),
            (header::SET_COOKIE, cookie),
            (header::CACHE_CONTROL, "no-store".to_string()),
        ],
    )
        .into_response()
}

#[derive(Debug, Deserialize)]
pub(super) struct CallbackQuery {
    #[serde(default)]
    code: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    error: Option<String>,
}

/// The claims this server reads from an ID token.
#[derive(Debug, Deserialize)]
struct Claims {
    iss: String,
    sub: String,
    aud: Audience,
    #[serde(default)]
    azp: Option<String>,
    exp: i64,
    #[serde(default)]
    nonce: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    email_verified: Option<serde_json::Value>,
    #[serde(default)]
    preferred_username: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum Audience {
    One(String),
    Many(Vec<String>),
}

impl Audience {
    fn contains(&self, client: &str) -> bool {
        match self {
            Self::One(aud) => aud == client,
            Self::Many(auds) => auds.iter().any(|aud| aud == client),
        }
    }
}

/// `GET /oidc/callback`: back from the provider (E38).
pub(super) async fn callback(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<CallbackQuery>,
) -> Response {
    let Some(oidc) = state.oidc.as_ref() else {
        return not_found().await;
    };
    // The attempt is spent whatever happens next: a state is never usable twice.
    let bound = cookie_value(&headers, STATE_COOKIE);
    let attempt = match bound {
        Some(cookie) if desktop::constant_time_eq(cookie.as_bytes(), query.state.as_bytes()) => {
            oidc.attempts
                .lock()
                .ok()
                .and_then(|mut attempts| attempts.remove(&digest(&query.state)))
                .filter(|attempt| attempt.started.elapsed() < ATTEMPT_FOR)
        }
        _ => None,
    };
    let Some(attempt) = attempt else {
        return sign_in_refused(&state, "That sign-in link has expired. Try again.");
    };
    if query.error.is_some() || query.code.is_empty() {
        return sign_in_refused(
            &state,
            "The sign-in was cancelled or refused by the provider.",
        );
    }
    let (claims, groups) = match exchange(oidc, &query.code, &attempt).await {
        Ok(found) => found,
        Err(why) => {
            drop(state.audit_login(&format!("oidc:{why}"), AuditResult::Denied));
            return sign_in_refused(
                &state,
                "The provider's answer could not be accepted. Try again.",
            );
        }
    };
    let verified = matches!(claims.email_verified, Some(serde_json::Value::Bool(true)))
        || matches!(&claims.email_verified, Some(serde_json::Value::String(s)) if s == "true");
    let identity = mb_auth::OidcIdentity {
        issuer: &claims.iss,
        subject: &claims.sub,
        email: claims.email.as_deref(),
        email_verified: verified,
        preferred_username: claims.preferred_username.as_deref(),
        name: claims.name.as_deref(),
    };
    let (account, cookie) = {
        let Ok(mut auth) = state.security.auth.lock() else {
            return server_error(&Error::Auth("authentication lock poisoned".into()));
        };
        let account = match auth.sign_in_oidc(&identity) {
            Ok(account) => account,
            Err(error) => return server_error(&Error::Auth(error.to_string())),
        };
        let user = account.user().clone();
        if user.disabled {
            drop(auth);
            drop(state.audit_login(&user.username, AuditResult::Denied));
            return sign_in_refused(&state, "This account is disabled.");
        }
        // M20b: the groups of this sign-in replace the last ones, so leaving a group at the
        // provider takes effect at the next sign-in.
        if let Err(error) = auth.set_groups(user.id, &groups) {
            return server_error(&Error::Auth(error.to_string()));
        }
        let Ok(token) =
            auth.create_session(user.id, unix_seconds().saturating_add(30 * 24 * 60 * 60))
        else {
            return server_error(&Error::Auth("creating session failed".into()));
        };
        let Ok(signed) = auth.signed_session_cookie(&token) else {
            return server_error(&Error::Auth("signing session cookie failed".into()));
        };
        (account, signed)
    };
    state.reload_groups();
    let user = account.user();
    if let Err(error) = state.audit_login(&user.username, AuditResult::Success) {
        return server_error(&error);
    }
    if let mb_auth::OidcAccount::Linked(_) | mb_auth::OidcAccount::Created(_) = &account
        && let Err(error) = state.audit_oidc_account(&account)
    {
        return server_error(&error);
    }
    let session = format!(
        "mb_session={cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age={}",
        30 * 24 * 60 * 60
    );
    let clear = format!("{STATE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/oidc; Max-Age=0");
    let location = if attempt.next.is_empty() {
        "/".to_string()
    } else {
        attempt.next
    };
    let mut response = (StatusCode::SEE_OTHER, [(header::LOCATION, location)]).into_response();
    for value in [session, clear] {
        if let Ok(value) = value.parse() {
            response.headers_mut().append(header::SET_COOKIE, value);
        }
    }
    response
}

/// Exchanges the code and validates the ID token's claims. `Err` names what failed, for the
/// audit log only.
async fn exchange(
    oidc: &Oidc,
    code: &str,
    attempt: &Attempt,
) -> Result<(Claims, Vec<String>), &'static str> {
    let discovery = oidc.discover().await.map_err(|_| "discovery")?;
    let body = form_urlencoded(&[
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", &oidc.config.redirect_url),
        ("client_id", &oidc.config.client_id),
        ("code_verifier", &attempt.verifier),
    ]);
    let response = oidc
        .client
        .post(&discovery.token_endpoint)
        .basic_auth(&oidc.config.client_id, Some(&oidc.config.client_secret))
        .header(
            header::CONTENT_TYPE.as_str(),
            "application/x-www-form-urlencoded",
        )
        .header(header::ACCEPT.as_str(), "application/json")
        .body(body)
        .send()
        .await
        .map_err(|_| "token endpoint unreachable")?;
    if !response.status().is_success() {
        return Err("token endpoint refused");
    }
    let text = response
        .text()
        .await
        .map_err(|_| "token response unreadable")?;
    let tokens: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| "token response unreadable")?;
    let id_token = tokens
        .get("id_token")
        .and_then(|v| v.as_str())
        .ok_or("no id_token")?;
    let payload = id_token.split('.').nth(1).ok_or("malformed id_token")?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .map_err(|_| "malformed id_token")?;
    let claims: Claims = serde_json::from_slice(&bytes).map_err(|_| "malformed claims")?;
    let raw: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "malformed claims")?;
    // M20b: the configured claim, kept only as valid group names. Anything else in it — a
    // number, an object — is ignored rather than refusing the person's sign-in.
    let groups: Vec<String> = raw
        .get(&oidc.config.groups_claim)
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str())
                .filter(|name| mb_core::GroupName::parse(name).is_ok())
                .take(256)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if claims.iss != oidc.config.issuer {
        return Err("issuer");
    }
    if !claims.aud.contains(&oidc.config.client_id) {
        return Err("audience");
    }
    if claims
        .azp
        .as_deref()
        .is_some_and(|azp| azp != oidc.config.client_id)
    {
        return Err("authorized party");
    }
    if claims.exp <= unix_seconds() {
        return Err("expired");
    }
    if claims.nonce.as_deref() != Some(attempt.nonce.as_str()) {
        return Err("nonce");
    }
    if claims.sub.is_empty() {
        return Err("subject");
    }
    Ok((claims, groups))
}

fn form_urlencoded(pairs: &[(&str, &str)]) -> String {
    let mut url = reqwest::Url::parse("http://x/").unwrap_or_else(|_| unreachable_url());
    url.query_pairs_mut().extend_pairs(pairs.iter());
    url.query().unwrap_or_default().to_string()
}

#[allow(clippy::panic)] // why: "http://x/" is a constant, valid URL; this cannot run.
fn unreachable_url() -> reqwest::Url {
    panic!("a constant URL failed to parse")
}

fn cookie_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .find_map(|part| part.trim().strip_prefix(name)?.strip_prefix('='))
}

/// The sign-in page again, with the reason above it.
fn sign_in_refused(state: &AppState, message: &str) -> Response {
    (
        StatusCode::FORBIDDEN,
        page_with(
            PagePolicy::SignIn,
            "Sign in",
            &login_form_returning(&state.sign_in_options(), Some(message), "", ""),
        ),
    )
        .into_response()
}

impl AppState {
    /// Turns provider sign-in on (§6.8.2).
    ///
    /// # Errors
    ///
    /// A configuration error when the `[oidc]` table is not usable.
    pub fn with_oidc(mut self, config: OidcConfig) -> Result<Self, Error> {
        self.oidc = Some(Oidc::new(config)?);
        Ok(self)
    }

    /// What the sign-in page offers.
    pub(super) fn sign_in_options(&self) -> SignInOptions<'_> {
        SignInOptions {
            provider: self.oidc.as_ref().map(Oidc::name),
            passwords: self.oidc.as_ref().is_none_or(Oidc::passwords),
        }
    }

    fn audit_oidc_account(&self, account: &mb_auth::OidcAccount) -> Result<(), Error> {
        let Some(audit) = &self.security.audit else {
            return Ok(());
        };
        let (target, how) = match account {
            mb_auth::OidcAccount::Linked(user) => (user.username.clone(), "linked"),
            mb_auth::OidcAccount::Created(user) => (user.username.clone(), "created"),
            mb_auth::OidcAccount::Returning(user) => (user.username.clone(), "returning"),
        };
        let targets = [format!("oidc:{how}")];
        audit
            .append(&crate::audit::AuditEvent {
                timestamp: &crate::audit::unix_seconds().to_string(),
                actor: Some(&target),
                source_ip: None,
                vault: None,
                action: AuditAction::Login,
                targets: &targets,
                result: AuditResult::Success,
            })
            .map_err(|error| Error::Auth(format!("writing audit log: {error}")))
    }
}

/// What the sign-in page offers: a provider's button, the password form, or both.
#[derive(Debug, Clone, Copy)]
pub(super) struct SignInOptions<'a> {
    pub(super) provider: Option<&'a str>,
    pub(super) passwords: bool,
}
