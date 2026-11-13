//! Connecting the desktop app to the user's server (`SPEC.md` §6.8.1, §7.6.8).
//!
//! The device half of device sign-in. The Connect screen takes a server address and starts
//! a loopback authorization with PKCE; the user approves in their own browser; the server
//! redirects that browser to [`CALLBACK_PATH`] on this embedded server, which E34's guard
//! admits only with the `state` this attempt created. The callback exchanges the code for a
//! device token and keeps it in the [`SecretStore`], never in a file.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Form, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use rand_core::{OsRng, RngCore};
use serde::Deserialize;

use super::{
    AppState, PagePolicy, onboarding, page, page_with, push_escaped_attr, push_escaped_text,
};
use crate::desktop::{Browser, ConnectedServer, SecretStore, load_settings, save_settings};

/// Where the user's server sends their browser back to.
pub const CALLBACK_PATH: &str = "/desktop/connect/callback";

/// How long an unanswered connection attempt stays valid.
const PENDING_FOR: Duration = Duration::from_secs(10 * 60);

/// What the desktop host supplies for connecting.
#[derive(Debug)]
pub struct ConnectOptions {
    /// `<app data>/desktop.toml`, where the connected server is remembered.
    pub settings_path: PathBuf,
    /// Where the device token is kept.
    pub secrets: Arc<dyn SecretStore>,
    /// Opens the approval page in the user's browser.
    pub browser: Arc<dyn Browser>,
    /// The name shown on the server's approval page.
    pub device_name: String,
    /// Where downloaded vaults are put, under `<server-host>/<vault>/` (§7.6.9).
    pub notes_home: PathBuf,
}

/// Connection state for one run of the app.
#[derive(Debug)]
pub(super) struct Connect {
    pub(super) options: ConnectOptions,
    callback: String,
    pending: Mutex<Option<Pending>>,
    client: reqwest::Client,
    /// What each replica's last pass did, and the signal that starts one early.
    pub(super) sync: super::desktop_sync::SyncStatus,
}

#[derive(Debug)]
struct Pending {
    origin: String,
    state: String,
    verifier: String,
    started: Instant,
}

impl Connect {
    pub(super) fn new(options: ConnectOptions, port: u16) -> Result<Self, crate::Error> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| crate::Error::Config(format!("HTTP client: {error}")))?;
        Ok(Self {
            options,
            callback: format!("http://127.0.0.1:{port}{CALLBACK_PATH}"),
            pending: Mutex::new(None),
            client,
            sync: super::desktop_sync::SyncStatus::default(),
        })
    }

    /// The HTTP client for this app's requests to its servers.
    pub(super) fn client(&self) -> &reqwest::Client {
        &self.client
    }

    /// Every server this app knows, signed in or kept (§7.6.11).
    pub(super) fn servers(&self) -> Vec<ConnectedServer> {
        load_settings(&self.options.settings_path)
            .map(|settings| settings.servers)
            .unwrap_or_default()
    }

    /// The servers this device is signed in to.
    pub(super) fn signed_in(&self) -> Vec<ConnectedServer> {
        self.servers()
            .into_iter()
            .filter(|server| !server.signed_out)
            .collect()
    }

    /// The server at `origin`, if this app knows it.
    pub(super) fn server(&self, origin: &str) -> Option<ConnectedServer> {
        self.servers()
            .into_iter()
            .find(|server| server.origin == origin)
    }

    /// The server at `origin` if this device is signed in there.
    pub(super) fn signed_in_at(&self, origin: &str) -> Option<ConnectedServer> {
        self.server(origin).filter(|server| !server.signed_out)
    }

    /// Changes `desktop.toml` under the same lock as every other writer of it.
    fn update_settings(
        &self,
        change: impl FnOnce(&mut crate::desktop::DesktopSettings),
    ) -> Result<(), crate::Error> {
        let _writer = self
            .sync
            .settings_writer()
            .ok_or_else(|| crate::Error::Config("desktop settings are locked".into()))?;
        let mut settings = load_settings(&self.options.settings_path)?;
        change(&mut settings);
        save_settings(&self.options.settings_path, &settings)
    }

    /// Records `server` as signed in, replacing any entry for its origin.
    fn remember(&self, server: ConnectedServer) -> Result<(), crate::Error> {
        self.update_settings(|settings| {
            settings.servers.retain(|s| s.origin != server.origin);
            settings.servers.push(server);
        })
    }

    fn live_pending(&self) -> Option<(String, String, String)> {
        let pending = self.pending.lock().ok()?;
        pending
            .as_ref()
            .filter(|p| p.started.elapsed() < PENDING_FOR)
            .map(|p| {
                (
                    p.origin.clone(),
                    p.state.clone(),
                    mb_auth::pkce_challenge(&p.verifier),
                )
            })
    }

    /// The approval page on the user's server for the pending attempt.
    fn authorize_url(&self, origin: &str, state: &str, challenge: &str) -> Option<String> {
        let mut url = reqwest::Url::parse(origin)
            .ok()?
            .join("/devices/authorize")
            .ok()?;
        url.query_pairs_mut()
            .append_pair("redirect_uri", &self.callback)
            .append_pair("state", state)
            .append_pair("code_challenge", challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("name", &self.options.device_name);
        Some(url.to_string())
    }
}

/// `GET /desktop/connect`: connected, waiting for approval, or the address form.
pub(super) async fn page_handler(State(state): State<Arc<AppState>>) -> Response {
    let Some(connect) = connect_of(&state) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if let Some((origin, _, _)) = connect.live_pending() {
        return waiting_page(&origin);
    }
    if connect.servers().is_empty() {
        return address_form(None, "", false);
    }
    // why: the vault picker lists every server with its account, state and Disconnect
    // (§7.6.11), so there is no second page that says the same thing.
    (StatusCode::SEE_OTHER, [(header::LOCATION, "/")]).into_response()
}

/// `GET /desktop/connect/new`: the address form, to add another server.
pub(super) async fn new_server(State(state): State<Arc<AppState>>) -> Response {
    let Some(connect) = connect_of(&state) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    address_form(None, "", !connect.servers().is_empty())
}

#[derive(Debug, Deserialize)]
pub(super) struct AddressForm {
    #[serde(default)]
    server: String,
}

/// `POST /desktop/connect`: start an attempt against the given server.
pub(super) async fn start(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Form(form): Form<AddressForm>,
) -> Response {
    let Some(connect) = connect_of(&state) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !onboarding::same_origin(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let has_servers = !connect.servers().is_empty();
    let origin = match server_origin(&form.server) {
        Ok(origin) => origin,
        Err(message) => return address_form(Some(message), &form.server, has_servers),
    };
    if connect.signed_in_at(&origin).is_some() {
        return address_form(
            Some("This app is already signed in to that server."),
            &form.server,
            has_servers,
        );
    }
    let Ok(mut pending) = connect.pending.lock() else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    *pending = Some(Pending {
        origin,
        state: random_urlsafe(),
        verifier: random_urlsafe(),
        started: Instant::now(),
    });
    (
        StatusCode::SEE_OTHER,
        [(header::LOCATION, "/desktop/connect")],
    )
        .into_response()
}

/// `POST /desktop/connect/cancel`: abandon the waiting attempt, so another can start.
pub(super) async fn cancel(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let Some(connect) = connect_of(&state) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !onboarding::same_origin(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if let Ok(mut pending) = connect.pending.lock() {
        *pending = None;
    }
    (
        StatusCode::SEE_OTHER,
        [(header::LOCATION, "/desktop/connect")],
    )
        .into_response()
}

/// `POST /desktop/connect/open`: open the pending attempt's approval page in the user's
/// browser, then back to the waiting page, which keeps refreshing.
pub(super) async fn open(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let Some(connect) = connect_of(&state) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !onboarding::same_origin(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    // An expired or cancelled attempt opens nothing; the Connect screen shows the form again.
    if let Some((origin, attempt, challenge)) = connect.live_pending()
        && let Some(url) = connect.authorize_url(&origin, &attempt, &challenge)
        && let Err(error) = connect.options.browser.open(&url)
    {
        let mut body = String::from("<p>Memberberry could not open your browser (");
        push_escaped_text(&mut body, &error);
        body.push_str("). Open this address in it yourself:</p><p><code>");
        push_escaped_text(&mut body, &url);
        body.push_str(
            "</code></p><p><a class=\"mb-button mb-action\" href=\"/desktop/connect\">\
             Back</a></p>",
        );
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            page_with(PagePolicy::SignIn, "Open your browser", &body),
        )
            .into_response();
    }
    (
        StatusCode::SEE_OTHER,
        [(header::LOCATION, "/desktop/connect")],
    )
        .into_response()
}

/// The browser's return from the user's server. Called by E34's guard, which admits this
/// path without the desktop cookie; the `state` check here is what admits it instead.
pub(super) async fn callback(state: &AppState, query: String) -> Option<Response> {
    let connect = connect_of(state)?;
    let param = |name: &str| {
        reqwest::Url::parse(&format!("http://x/?{query}"))
            .ok()
            .and_then(|url| {
                url.query_pairs()
                    .find(|(key, _)| key == name)
                    .map(|(_, value)| value.into_owned())
            })
    };
    let offered = param("state")?;
    let attempt = {
        let mut pending = connect.pending.lock().ok()?;
        let matches = pending.as_ref().is_some_and(|p| {
            p.started.elapsed() < PENDING_FOR
                && super::desktop::constant_time_eq(p.state.as_bytes(), offered.as_bytes())
        });
        if !matches {
            return None;
        }
        pending.take()?
    };
    if param("error").is_some() {
        return Some(message_page(
            StatusCode::OK,
            "Not connected",
            "The connection was denied. You can close this tab and try again from the app.",
        ));
    }
    let code = param("code")?;
    Some(finish(connect, &attempt, &code).await)
}

#[derive(Debug, Deserialize)]
struct Grant {
    token: String,
    device_id: i64,
    username: String,
    display_name: String,
}

async fn finish(connect: &Connect, attempt: &Pending, code: &str) -> Response {
    let body = serde_json::json!({
        "code": code,
        "code_verifier": attempt.verifier,
        "redirect_uri": connect.callback,
    });
    let response = connect
        .client
        .post(format!("{}/api/v1/devices/token", attempt.origin))
        .header(header::CONTENT_TYPE, "application/json")
        .body(body.to_string())
        .send()
        .await;
    let grant = match response {
        Ok(response) if response.status().is_success() => response
            .text()
            .await
            .ok()
            .and_then(|text| serde_json::from_str::<Grant>(&text).ok()),
        _ => None,
    };
    let Some(grant) = grant.filter(|g| mb_auth::DeviceToken::from_secret(&g.token).is_some())
    else {
        return message_page(
            StatusCode::BAD_GATEWAY,
            "Not connected",
            "The server did not accept this connection. Close this tab and try again from the app.",
        );
    };
    // why: a kept copy holds one account's notes. Syncing it with another account's token
    // would upload the first person's offline notes as the second (§7.6.11).
    if let Some(known) = connect.server(&attempt.origin)
        && known.username != grant.username
    {
        let revoked = connect
            .client
            .delete(format!("{}/api/v1/devices/self", attempt.origin))
            .bearer_auth(&grant.token)
            .send()
            .await;
        if revoked.is_err() {
            eprintln!("memberberry: revoking a refused device token failed");
        }
        let mut message = String::from("This computer keeps notes from this server for ");
        message.push_str(&known.username);
        message.push_str(
            ". Remove them in the app's Servers page before signing in as someone else. \
             You can close this tab.",
        );
        return message_page(StatusCode::CONFLICT, "Not connected", &message);
    }
    if let Err(message) = connect.options.secrets.set(&attempt.origin, &grant.token) {
        eprintln!("memberberry: storing the device token failed: {message}");
        return message_page(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Not connected",
            "Memberberry could not save this connection in the system keychain.",
        );
    }
    let server = ConnectedServer {
        origin: attempt.origin.clone(),
        username: grant.username,
        display_name: grant.display_name,
        device_id: grant.device_id,
        signed_out: false,
    };
    if connect.remember(server.clone()).is_err() {
        return message_page(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Not connected",
            "Memberberry could not save this connection.",
        );
    }
    let mut body = String::from("<p>Memberberry is connected to ");
    push_escaped_text(&mut body, &server.origin);
    body.push_str(" as <strong>");
    push_escaped_text(&mut body, &server.display_name);
    body.push_str("</strong>. You can close this tab and go back to the app.</p>");
    (StatusCode::OK, page("Connected", &body)).into_response()
}

/// The origin of a server address the user typed, or why it cannot be used.
///
/// `https` anywhere, or `http` only to this computer: a device token never crosses a
/// network unencrypted (§6.8.1).
pub(super) fn server_origin(input: &str) -> Result<String, &'static str> {
    let input = input.trim();
    let with_scheme = if input.contains("://") {
        input.to_string()
    } else {
        format!("https://{input}")
    };
    let url = reqwest::Url::parse(&with_scheme)
        .map_err(|_| "That is not a server address. Try something like notes.example.com.")?;
    let host = url
        .host_str()
        .ok_or("That is not a server address. Try something like notes.example.com.")?;
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "[::1]");
    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
        "http" => return Err("Use an https address. A device's key must not travel unencrypted."),
        _ => return Err("That is not a server address. Try something like notes.example.com."),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Leave your username and password out of the address.");
    }
    Ok(url.origin().ascii_serialization())
}

pub(super) fn connect_of(state: &AppState) -> Option<&Connect> {
    state.desktop.as_ref()?.connect.as_ref()
}

fn random_urlsafe() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn address_form(error: Option<&str>, value: &str, has_servers: bool) -> Response {
    let mut body = String::from(
        "<form class=\"mb-form\" method=\"post\" action=\"/desktop/connect\">\
         <p>Connect this app to your Memberberry server. Your browser will open so you can \
         sign in there and approve this device. This app never sees your password.</p>",
    );
    if let Some(error) = error {
        body.push_str("<p class=\"mb-form-error\" role=\"alert\">");
        push_escaped_text(&mut body, error);
        body.push_str("</p>");
    }
    body.push_str(
        "<div class=\"mb-field\"><label for=\"mb-server\">Server address</label>\
         <input id=\"mb-server\" name=\"server\" inputmode=\"url\" autocomplete=\"url\" \
         placeholder=\"notes.example.com\" required autofocus value=\"",
    );
    push_escaped_attr(&mut body, value);
    body.push_str(
        "\" /></div><div class=\"mb-actions\"><button class=\"mb-button mb-action\" \
         type=\"submit\">Continue</button><a class=\"mb-button mb-quiet mb-action\" href=\"",
    );
    body.push_str("/\">Cancel</a></div></form>");
    let status = if error.is_some() {
        StatusCode::BAD_REQUEST
    } else {
        StatusCode::OK
    };
    (
        status,
        page_with(
            PagePolicy::SignIn,
            if has_servers {
                "Connect another server"
            } else {
                "Connect to a server"
            },
            &body,
        ),
    )
        .into_response()
}

fn waiting_page(origin: &str) -> Response {
    let mut body = String::from("<p>Sign in to ");
    push_escaped_text(&mut body, origin);
    // why: both buttons post to this app; nothing here navigates the window off its origin
    // (see `Browser`), so the refresh below keeps running while the browser is open.
    body.push_str(
        " in your browser and approve this device. This page moves on by itself once you \
         have.</p><div class=\"mb-actions\"><form method=\"post\" \
         action=\"/desktop/connect/open\"><button class=\"mb-button mb-action\" \
         type=\"submit\">Open the sign-in page</button></form>\
         <form method=\"post\" action=\"/desktop/connect/cancel\">\
         <button class=\"mb-button mb-quiet mb-action\" type=\"submit\">Cancel</button>\
         </form></div>",
    );
    // why: a `Refresh` header rather than script, which the page's CSP forbids, so the
    // window notices the approval that happens in another application.
    (
        StatusCode::OK,
        [(header::REFRESH, "3")],
        page_with(PagePolicy::SignIn, "Waiting for approval", &body),
    )
        .into_response()
}

pub(super) fn message_page(status: StatusCode, title: &str, message: &str) -> Response {
    let mut body = String::from("<p>");
    push_escaped_text(&mut body, message);
    body.push_str("</p>");
    (status, page(title, &body)).into_response()
}
