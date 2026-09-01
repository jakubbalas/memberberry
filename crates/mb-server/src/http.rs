//! Routes and rendering.
//!
//! Routes follow `SPEC.md` §6.1: the UI lives under `/v/<slug>/…`. The API surface
//! (`/api/v1/vaults/<slug>/…`) belongs to later milestones and is deliberately absent
//! rather than stubbed.
//!
//! Everything served here is read-only. Nothing in this module writes to a vault.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::extract::{Form, Path as AxumPath, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use serde::Deserialize;

use mb_core::Username;
use mb_core::html::Urls;

use crate::audit::{AuditAction, AuditEvent, AuditLog, AuditResult};
use crate::repository::AuthorizedVault;
use crate::{AccessFile, Error, Slug, Vault};

/// The vaults this server knows about, keyed by slug.
#[derive(Debug)]
pub struct AppState {
    vaults: BTreeMap<Slug, Vault>,
    security: Security,
}

#[derive(Debug)]
struct Security {
    auth: Mutex<mb_auth::AuthDb>,
    access: BTreeMap<Slug, mb_core::Access>,
    audit: Option<AuditLog>,
}

impl AppState {
    /// Builds the production state: authentication plus fail-closed ACLs for every vault.
    pub fn authenticated(vaults: Vec<Vault>, auth: mb_auth::AuthDb) -> Result<Self, Error> {
        Self::authenticated_with_audit(vaults, auth, None)
    }

    /// Builds production state with authentication, ACLs, and an audit writer.
    pub fn authenticated_with_audit(
        vaults: Vec<Vault>,
        auth: mb_auth::AuthDb,
        audit: Option<AuditLog>,
    ) -> Result<Self, Error> {
        let mut registered = BTreeMap::new();
        let mut access = BTreeMap::new();
        for vault in vaults {
            let policy =
                AccessFile::load(vault.root()).map_err(|error| Error::Access(error.to_string()))?;
            access.insert(vault.slug().clone(), policy.policy().clone());
            registered.insert(vault.slug().clone(), vault);
        }
        Ok(Self {
            vaults: registered,
            security: Security {
                auth: Mutex::new(auth),
                access,
                audit,
            },
        })
    }

    #[must_use]
    pub fn vault(&self, slug: &str) -> Option<&Vault> {
        // Parsing first means an unparseable slug can never be used as a map key or reach
        // the filesystem, whatever it contains.
        let slug = Slug::parse(slug).ok()?;
        self.vaults.get(&slug)
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.vaults.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.vaults.is_empty()
    }
}

/// Builds the router.
pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/login", post(login))
        .route("/v/{slug}", get(vault_index))
        .route("/v/{slug}/", get(vault_index))
        .route("/v/{slug}/{*note}", get(note))
        .fallback(not_found)
        .with_state(state)
}

async fn index(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if state.authenticated_user(&headers).is_none() {
        return login_page().into_response();
    }
    let mut body = String::new();
    if state.is_empty() {
        body.push_str(
            "<p class=\"mb-empty\">No vaults registered yet. Add one with \
             <code>memberberry vault create --slug personal --path ~/Notes</code>.</p>",
        );
    } else {
        body.push_str("<ul class=\"mb-vault-list\">\n");
        for (slug, vault) in &state.vaults {
            let Some(view) = state.authorized_vault(vault, &headers) else {
                continue;
            };
            match view.has_any_access() {
                Ok(true) => {}
                Ok(false) => continue,
                Err(error) => return server_error(&error),
            }
            body.push_str("<li><a href=\"/v/");
            push_escaped_attr(&mut body, slug.as_str());
            body.push_str("\">");
            push_escaped_text(&mut body, vault.name());
            body.push_str("</a></li>\n");
        }
        body.push_str("</ul>");
    }
    page("Vaults", &body).into_response()
}

async fn vault_index(
    State(state): State<Arc<AppState>>,
    AxumPath(slug): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    let Some(vault) = state.vault(&slug) else {
        return not_found().await;
    };
    let Some(view) = state.authorized_vault(vault, &headers) else {
        return not_found().await;
    };
    let notes = match view.notes() {
        Ok(notes) => notes,
        Err(error) => return server_error(&error),
    };

    let mut body = String::new();
    body.push_str("<p class=\"mb-count\">");
    body.push_str(&notes.len().to_string());
    body.push_str(" notes</p>\n<ul class=\"mb-note-list\">\n");
    for rel in &notes {
        body.push_str("<li><a href=\"/v/");
        push_escaped_attr(&mut body, vault.slug().as_str());
        body.push('/');
        push_escaped_attr(&mut body, &encode_path(rel));
        body.push_str("\">");
        push_escaped_text(&mut body, rel.trim_end_matches(".md"));
        body.push_str("</a></li>\n");
    }
    body.push_str("</ul>");
    page(vault.name(), &body).into_response()
}

async fn note(
    State(state): State<Arc<AppState>>,
    AxumPath((slug, note)): AxumPath<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let Some(vault) = state.vault(&slug) else {
        return not_found().await;
    };
    let Some(view) = state.authorized_vault(vault, &headers) else {
        return not_found().await;
    };
    let Ok(source) = view.read(&note) else {
        return not_found().await;
    };
    let doc = mb_core::parse(&source);
    let title = mb_core::extract::title(&doc).unwrap_or_else(|| note.clone());
    let prefix = format!("/v/{}/", vault.slug());
    let rendered = mb_core::html::document(
        &doc,
        &Urls {
            note: &prefix,
            media: &prefix,
        },
    );

    let mut body = String::new();
    body.push_str("<p class=\"mb-breadcrumb\"><a href=\"/v/");
    push_escaped_attr(&mut body, vault.slug().as_str());
    body.push_str("\">");
    push_escaped_text(&mut body, vault.name());
    body.push_str("</a></p>\n<article class=\"mb-note\">\n");
    body.push_str(&rendered);
    body.push_str("</article>");
    page(&title, &body).into_response()
}

#[derive(Debug, Deserialize)]
struct LoginForm {
    username: String,
    password: String,
}

async fn login(State(state): State<Arc<AppState>>, Form(form): Form<LoginForm>) -> Response {
    let Ok(auth) = state.security.auth.lock() else {
        return server_error(&Error::Auth("authentication lock poisoned".to_string()));
    };
    let Ok(Some(user)) = auth.authenticate(&form.username, &form.password) else {
        if let Err(error) = state.audit_login(&form.username, AuditResult::Denied) {
            return server_error(&error);
        }
        return (
            StatusCode::UNAUTHORIZED,
            page(
                "Sign in",
                "<p class=\"mb-empty\">Invalid username or password.</p>",
            ),
        )
            .into_response();
    };
    let Ok(token) = auth.create_session(user.id, unix_seconds().saturating_add(30 * 24 * 60 * 60))
    else {
        return server_error(&Error::Auth("creating session failed".to_string()));
    };
    if let Err(error) = state.audit_login(&user.username, AuditResult::Success) {
        drop(auth.revoke_session(&token));
        return server_error(&error);
    }
    let Ok(signed) = auth.signed_session_cookie(&token) else {
        drop(auth.revoke_session(&token));
        return server_error(&Error::Auth("signing session cookie failed".to_string()));
    };
    let cookie = format!(
        "mb_session={signed}; HttpOnly; SameSite=Lax; Path=/; Max-Age={}",
        30 * 24 * 60 * 60
    );
    (
        StatusCode::SEE_OTHER,
        [
            (header::LOCATION, "/"),
            (header::SET_COOKIE, cookie.as_str()),
        ],
    )
        .into_response()
}

impl AppState {
    fn audit_login(&self, actor: &str, result: AuditResult) -> Result<(), Error> {
        let Some(audit) = &self.security.audit else {
            return Ok(());
        };
        let targets: [String; 0] = [];
        audit
            .append(&AuditEvent {
                timestamp: &unix_seconds().to_string(),
                actor: Some(actor),
                source_ip: None,
                vault: None,
                action: AuditAction::Login,
                targets: &targets,
                result,
            })
            .map_err(|error| Error::Auth(format!("writing audit log: {error}")))
    }

    fn authenticated_user(&self, headers: &HeaderMap) -> Option<Username> {
        let token = session_cookie(headers)?;
        let auth = self.security.auth.lock().ok()?;
        let user = auth.authenticate_signed_session_cookie(token).ok()??;
        Username::parse(&user.username).ok()
    }

    fn authorized_vault<'a>(
        &'a self,
        vault: &'a Vault,
        headers: &HeaderMap,
    ) -> Option<AuthorizedVault<'a>> {
        let user = self
            .authenticated_user(headers)
            .or_else(|| self.api_token_user(vault.slug(), headers))?;
        let access = self.security.access.get(vault.slug())?;
        Some(AuthorizedVault::new(vault, access, user))
    }

    fn api_token_user(&self, vault: &Slug, headers: &HeaderMap) -> Option<Username> {
        let token = bearer_token(headers)?;
        let token = mb_auth::ApiToken::from_secret(token)?;
        let auth = self.security.auth.lock().ok()?;
        let scope = auth.authenticate_api_token(&token).ok()??;
        if scope.vault_slug != vault.as_str() {
            return None;
        }
        let user = auth.user_by_id(scope.user_id).ok()??;
        // The repository applies the issuer's current ACL, so this token cannot retain or
        // escalate access after a permission change. Its non-none scoped role is an upper
        // bound for future write routes; these read-only routes need no extra widening.
        Username::parse(&user.username).ok()
    }
}

fn session_cookie(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|part| part.trim().strip_prefix("mb_session="))
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

fn unix_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_secs()).ok())
        .unwrap_or(0)
}

fn login_page() -> Html<String> {
    page(
        "Sign in",
        "<form method=\"post\" action=\"/login\"><label>Username <input name=\"username\" autocomplete=\"username\" /></label><label>Password <input type=\"password\" name=\"password\" autocomplete=\"current-password\" /></label><button type=\"submit\">Sign in</button></form>",
    )
}

async fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        page("Not found", "<p class=\"mb-empty\">No such note.</p>"),
    )
        .into_response()
}

fn server_error(e: &Error) -> Response {
    // why: the message goes to the log, not the page. An I/O error names a filesystem path,
    // and paths leak the shape of someone's private vault to whoever can reach the port.
    eprintln!("memberberry: {e}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        page("Error", "<p class=\"mb-empty\">Something went wrong.</p>"),
    )
        .into_response()
}

/// Wraps a fragment in a minimal document.
///
/// Deliberately one self-contained file with no external assets: M0 has no build step, and
/// a page that renders with no network round trips is also the one that still works when
/// the JavaScript of later milestones fails.
fn page(title: &str, body: &str) -> Html<String> {
    let mut out = String::with_capacity(body.len() + STYLE.len() + 512);
    out.push_str("<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\" />\n");
    out.push_str("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n");
    // why: the notes being rendered are untrusted content. A restrictive CSP is a second
    // line of defence behind the escaping in `mb_core::html` — if an escaping bug ever
    // lands, this stops it becoming script execution.
    out.push_str(
        "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; \
         img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\" />\n",
    );
    out.push_str("<title>");
    push_escaped_text(&mut out, title);
    out.push_str(" · Memberberry</title>\n<style>");
    out.push_str(STYLE);
    out.push_str(
        "</style>\n</head>\n<body>\n<header><a href=\"/\">Memberberry</a></header>\n<main>\n",
    );
    out.push_str("<h1 class=\"mb-page-title\">");
    push_escaped_text(&mut out, title);
    out.push_str("</h1>\n");
    out.push_str(body);
    out.push_str("\n</main>\n</body>\n</html>\n");
    Html(out)
}

fn push_escaped_text(out: &mut String, text: &str) {
    mb_core::html::escape_text(text, out);
}

fn push_escaped_attr(out: &mut String, text: &str) {
    mb_core::html::escape_attr(text, out);
}

/// Percent-encodes a note path for a URL, keeping `/` as a separator.
fn encode_path(rel: &str) -> String {
    let mut out = String::with_capacity(rel.len());
    for byte in rel.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Serves until the process is asked to stop.
///
/// # Errors
///
/// Fails if the address cannot be bound or the server stops unexpectedly.
pub async fn serve(state: Arc<AppState>, addr: std::net::SocketAddr) -> Result<(), Error> {
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|source| Error::Bind { addr, source })?;
    let bound = listener.local_addr().unwrap_or(addr);
    println!("memberberry: listening on http://{bound}");
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown())
        .await
        .map_err(Error::Serve)
}

async fn shutdown() {
    drop(tokio::signal::ctrl_c().await);
    println!("\nmemberberry: shutting down");
}

const STYLE: &str = "\
:root{color-scheme:light dark;--fg:#1a1a1a;--bg:#fdfdfc;--muted:#6b6b6b;--line:#e4e4e1;--accent:#3b5bdb}\
@media(prefers-color-scheme:dark){:root{--fg:#e8e8e6;--bg:#16171a;--muted:#9a9a97;--line:#2c2e33;--accent:#8da2fb}}\
*{box-sizing:border-box}\
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}\
header{border-bottom:1px solid var(--line);padding:.75rem 1.5rem;font-weight:600}\
header a{color:inherit;text-decoration:none}\
main{max-width:46rem;margin:0 auto;padding:2rem 1.5rem 6rem}\
h1,h2,h3,h4,h5,h6{line-height:1.25;margin:2rem 0 .75rem}\
.mb-page-title{margin-top:0;font-size:1.75rem}\
a{color:var(--accent)}\
code{background:color-mix(in srgb,var(--fg) 8%,transparent);padding:.1em .35em;border-radius:3px;font-size:.9em}\
pre{background:color-mix(in srgb,var(--fg) 6%,transparent);padding:1rem;border-radius:6px;overflow-x:auto}\
pre code{background:none;padding:0}\
blockquote{border-left:3px solid var(--line);margin:1rem 0;padding:.25rem 0 .25rem 1rem;color:var(--muted)}\
table{border-collapse:collapse;width:100%;margin:1rem 0}\
th,td{border:1px solid var(--line);padding:.4rem .6rem;text-align:left}\
hr{border:0;border-top:1px solid var(--line);margin:2rem 0}\
img{max-width:100%;height:auto}\
ul,ol{padding-left:1.5rem}\
.mb-task-list{list-style:none;padding-left:.25rem}\
.mb-task-done{color:var(--muted);text-decoration:line-through}\
.mb-task-cancelled{color:var(--muted);text-decoration:line-through;opacity:.7}\
.mb-task p{display:inline}\
.mb-tag{color:var(--accent);font-size:.9em}\
.mb-callout{border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:6px;padding:.75rem 1rem;margin:1rem 0}\
.mb-callout-title{font-weight:600;text-transform:capitalize}\
.mb-math,.mb-math-block{font-family:ui-monospace,monospace}\
.mb-math-block{display:block;margin:1rem 0;text-align:center}\
.mb-note-list,.mb-vault-list{list-style:none;padding:0}\
.mb-note-list li,.mb-vault-list li{border-bottom:1px solid var(--line);padding:.4rem 0}\
.mb-count,.mb-breadcrumb,.mb-empty{color:var(--muted);font-size:.9rem}\
";
