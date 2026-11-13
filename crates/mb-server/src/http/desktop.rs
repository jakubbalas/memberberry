//! The desktop app's guard on its embedded server (`SPEC.md` §7.6.2, E34).
//!
//! The desktop app runs this server on loopback for exactly one reader: its own window. A
//! loopback port is reachable by every process on the machine and, through DNS rebinding, by
//! any web page, so being on `127.0.0.1` proves nothing. What the window has that nothing
//! else does is a one-time launch code the host process handed it directly. Exchanging that
//! code sets an `HttpOnly` cookie, and from then on every request must carry it.
//!
//! The same guard signs the window in. A desktop vault belongs to one person, and the only
//! way to reach this server is from the app they launched, so a password prompt would
//! protect nothing E34 does not already. The guard mints an ordinary `mb_session` for the
//! local user whenever the window lacks a valid one, so every route below it authenticates
//! exactly as it does on a shared server: no handler has a desktop branch.

use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use rand_core::{OsRng, RngCore};

use super::AppState;
pub use super::desktop_connect::ConnectOptions;
use super::desktop_connect::{CALLBACK_PATH, Connect};
pub use super::desktop_sync::sync_replicas;

/// The path the host process opens first, carrying the launch code.
pub const LAUNCH_PATH: &str = "/desktop/launch";

const DESKTOP_COOKIE: &str = "mb_desktop";
const SESSION_SECONDS: i64 = 30 * 24 * 60 * 60;

/// Admission state for one run of the desktop app: the loopback origin it is served on, the
/// cookie secret, the not-yet-used launch code and the local user it signs in.
#[derive(Debug)]
pub struct DesktopAccess {
    authority: String,
    origin: String,
    secret: String,
    launch: Mutex<Option<String>>,
    username: String,
    port: u16,
    /// Connecting to the user's server (§6.8.1), when the host enabled it.
    pub(super) connect: Option<Connect>,
}

/// The one-time code that admits the desktop window. Valid for a single exchange.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchCode {
    url: String,
}

impl LaunchCode {
    /// The URL the host opens in its window. It works once.
    #[must_use]
    pub fn url(&self) -> &str {
        &self.url
    }
}

impl DesktopAccess {
    /// Fresh secrets for a server listening on `127.0.0.1:port`, signing in `username`.
    #[must_use]
    pub fn new(port: u16, username: &str) -> (Self, LaunchCode) {
        let authority = format!("127.0.0.1:{port}");
        let origin = format!("http://{authority}");
        let code = random_hex();
        let launch = LaunchCode {
            url: format!("{origin}{LAUNCH_PATH}?code={code}"),
        };
        (
            Self {
                authority,
                origin,
                secret: random_hex(),
                launch: Mutex::new(Some(code)),
                username: username.to_string(),
                port,
                connect: None,
            },
            launch,
        )
    }

    /// Enables connecting to the user's server from this app.
    ///
    /// # Errors
    ///
    /// Fails if the HTTP client for the user's server cannot be built.
    pub fn with_connect(mut self, options: ConnectOptions) -> Result<Self, crate::Error> {
        self.connect = Some(Connect::new(options, self.port)?);
        Ok(self)
    }

    /// Consumes the launch code if `offered` matches it. A second exchange always fails.
    fn redeem(&self, offered: &str) -> bool {
        let Ok(mut launch) = self.launch.lock() else {
            return false;
        };
        let matches = launch
            .as_deref()
            .is_some_and(|code| constant_time_eq(code.as_bytes(), offered.as_bytes()));
        if matches {
            *launch = None;
        }
        matches
    }

    fn admits_host_and_origin(&self, request: &Request) -> bool {
        let headers = request.headers();
        let host_ok = headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|host| host == self.authority);
        // why: absent is allowed because a top-level navigation and most GETs send none; the
        // cookie is what admits those. Present and different is a page from another origin,
        // which is exactly what a DNS-rebinding attack looks like after the Host check.
        let origin_ok = headers
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok())
            .is_none_or(|origin| origin == self.origin);
        host_ok && origin_ok
    }

    fn carries_secret(&self, request: &Request) -> bool {
        cookie_values(request, DESKTOP_COOKIE)
            .any(|value| constant_time_eq(value.as_bytes(), self.secret.as_bytes()))
    }
}

/// E34: refuses everything that is not the desktop window, then signs the window in.
pub async fn guard(
    State(state): State<Arc<AppState>>,
    mut request: Request,
    next: Next,
) -> Response {
    let Some(desktop) = state.desktop.as_ref() else {
        return next.run(request).await;
    };
    if !desktop.admits_host_and_origin(&request) {
        return refused();
    }
    if request.uri().path() == LAUNCH_PATH {
        return launch(desktop, &request);
    }
    // why: the user's browser, not this window, arrives here from their server, so it has no
    // desktop cookie. The pending attempt's `state` admits it instead, and nothing else does.
    if request.uri().path() == CALLBACK_PATH && request.method() == axum::http::Method::GET {
        let query = request.uri().query().unwrap_or("").to_string();
        return match super::desktop_connect::callback(&state, query).await {
            Some(response) => response,
            None => stale_callback(),
        };
    }
    if !desktop.carries_secret(&request) {
        return refused();
    }
    if has_valid_session(&state, desktop, &request) {
        return next.run(request).await;
    }
    let Some(signed) = mint_session(&state, desktop) else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "Could not sign in.").into_response();
    };
    replace_session_cookie(&mut request, &signed);
    let mut response = next.run(request).await;
    if let Ok(value) = HeaderValue::from_str(&format!(
        "mb_session={signed}; HttpOnly; SameSite=Strict; Path=/; Max-Age={SESSION_SECONDS}"
    )) {
        response.headers_mut().append(header::SET_COOKIE, value);
    }
    response
}

fn launch(desktop: &DesktopAccess, request: &Request) -> Response {
    let offered = request
        .uri()
        .query()
        .and_then(|query| query.split('&').find_map(|pair| pair.strip_prefix("code=")))
        .unwrap_or("");
    if request.method() != axum::http::Method::GET || !desktop.redeem(offered) {
        return refused();
    }
    let Ok(cookie) = HeaderValue::from_str(&format!(
        "{DESKTOP_COOKIE}={}; HttpOnly; SameSite=Strict; Path=/",
        desktop.secret
    )) else {
        return refused();
    };
    let mut response = (StatusCode::SEE_OTHER, [(header::LOCATION, "/")]).into_response();
    response.headers_mut().append(header::SET_COOKIE, cookie);
    response
}

fn has_valid_session(state: &AppState, desktop: &DesktopAccess, request: &Request) -> bool {
    let Ok(auth) = state.security.auth.lock() else {
        return false;
    };
    cookie_values(request, "mb_session").any(|cookie| {
        matches!(
            auth.authenticate_signed_session_cookie(cookie),
            Ok(Some(user)) if user.username == desktop.username && !user.disabled
        )
    })
}

fn mint_session(state: &AppState, desktop: &DesktopAccess) -> Option<String> {
    let auth = state.security.auth.lock().ok()?;
    let user = auth.user_by_username(&desktop.username).ok()??;
    if user.disabled {
        return None;
    }
    let token = auth
        .create_session(
            user.id,
            super::unix_seconds().saturating_add(SESSION_SECONDS),
        )
        .ok()?;
    auth.signed_session_cookie(&token).ok()
}

/// Puts the fresh session where every handler looks for it, dropping any stale one first:
/// handlers read the *first* `mb_session`, so appending alone would leave an expired cookie
/// shadowing the new one.
fn replace_session_cookie(request: &mut Request, signed: &str) {
    let kept: Vec<String> = request
        .headers()
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .map(str::trim)
        .filter(|part| !part.is_empty() && !part.starts_with("mb_session="))
        .map(str::to_string)
        .chain(std::iter::once(format!("mb_session={signed}")))
        .collect();
    let headers = request.headers_mut();
    headers.remove(header::COOKIE);
    if let Ok(value) = HeaderValue::from_str(&kept.join("; ")) {
        headers.insert(header::COOKIE, value);
    }
}

fn cookie_values<'a>(request: &'a Request, name: &'a str) -> impl Iterator<Item = &'a str> + 'a {
    request
        .headers()
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(move |part| part.trim().strip_prefix(name)?.strip_prefix('='))
}

/// A callback that matches no attempt this app is waiting for: late, cancelled, or not ours.
///
/// why: this lands in the user's browser after they approved, so it says what to do. It is
/// the same text whether or not an attempt is pending, so it reveals nothing to a probe.
fn stale_callback() -> Response {
    Response::builder()
        .status(StatusCode::FORBIDDEN)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(
            "This approval does not match a connection the Memberberry app is waiting for. \
             It may have expired. Go back to the app and connect again.",
        ))
        .unwrap_or_else(|_| StatusCode::FORBIDDEN.into_response())
}

/// One neutral refusal for every reason, so a probe learns nothing about which check failed.
fn refused() -> Response {
    Response::builder()
        .status(StatusCode::FORBIDDEN)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from("Open Memberberry from the desktop app."))
        .unwrap_or_else(|_| StatusCode::FORBIDDEN.into_response())
}

fn random_hex() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(super) fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}
