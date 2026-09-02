//! Routes and rendering.
//!
//! Routes follow `SPEC.md` §6.1: the UI lives under `/v/<slug>/…`. The API surface
//! (`/api/v1/vaults/<slug>/…`) belongs to later milestones and is deliberately absent
//! rather than stubbed.
//!
//! Everything served here is read-only. Nothing in this module writes to a vault.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

use axum::Router;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Form, Path as AxumPath, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;

use mb_core::Username;
use mb_core::html::Urls;

use crate::audit::{AuditAction, AuditEvent, AuditLog, AuditResult};
use crate::repository::AuthorizedVault;
use crate::sync::{Announcement, ClientFrame, ConnectionId, ServerFrame, SyncRegistry, Wire};
use crate::watch::{Changes, WatchSignal};
use crate::{AccessFile, Error, Slug, Vault};

/// The vaults this server knows about, keyed by slug.
#[derive(Debug)]
pub struct AppState {
    vaults: BTreeMap<Slug, Vault>,
    web_root: Option<PathBuf>,
    security: Security,
}

#[derive(Debug)]
struct Security {
    auth: Mutex<mb_auth::AuthDb>,
    /// Live per-vault policy. Re-read when `access.toml` changes on disk, so a revocation
    /// takes effect on the next frame rather than at the next restart.
    access: RwLock<BTreeMap<Slug, VaultAccess>>,
    audit: Option<AuditLog>,
    sync: SyncRegistry,
}

/// One vault's policy and the file state it was parsed from.
#[derive(Debug, Clone)]
struct VaultAccess {
    policy: Arc<mb_core::Access>,
    source: Option<FileStamp>,
}

/// Cheap evidence that a file has not changed. Size alone is far too weak for an ACL, so
/// the modification time carries it; a rewrite that preserves both is a same-content save.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileStamp {
    len: u64,
    modified: Option<std::time::SystemTime>,
}

impl FileStamp {
    fn of(path: &std::path::Path) -> Option<Self> {
        let meta = std::fs::metadata(path).ok()?;
        Some(Self {
            len: meta.len(),
            modified: meta.modified().ok(),
        })
    }
}

impl AppState {
    /// Runs one maintenance tick. Blocking: callers must keep it off the async runtime.
    ///
    /// Policy is refreshed before documents are, so a broadcast in this tick is filtered by
    /// the ACL as it stands now rather than as it stood when the tick began.
    pub fn maintain_sync(&self, changed: &Changes) -> Vec<String> {
        let mut errors = self.reload_access();
        errors.extend(self.security.sync.maintain(
            std::time::Instant::now(),
            changed,
            &|slug, note, user| self.may_read_note(slug, note, user),
        ));
        errors
    }

    /// Every directory whose contents this server must notice changing.
    #[must_use]
    pub fn watch_roots(&self) -> Vec<PathBuf> {
        self.vaults
            .values()
            .map(|vault| vault.root().to_path_buf())
            .collect()
    }

    /// The E3 re-check every outbound sync frame passes through, per recipient.
    ///
    /// Fails closed on an unparseable slug, an unregistered vault, a missing ACL or an
    /// unparseable note — the same neutral denial [`SYNC_DENIED`] gives on the way in.
    fn may_read_note(&self, slug: &str, note: &str, user: &Username) -> bool {
        let Ok(slug) = Slug::parse(slug) else {
            return false;
        };
        let Some(access) = self.access_for(&slug) else {
            return false;
        };
        let Ok(path) = mb_core::NotePath::parse(note) else {
            return false;
        };
        access.effective_role(user, &path) != mb_core::Role::None
    }

    /// Builds the production state: authentication plus fail-closed ACLs for every vault.
    pub fn authenticated(vaults: Vec<Vault>, auth: mb_auth::AuthDb) -> Result<Self, Error> {
        Self::authenticated_with_audit(vaults, auth, None)
    }

    /// Adds a canonical Vite build root for the interactive editor surface.
    pub fn authenticated_with_web_root(
        vaults: Vec<Vault>,
        auth: mb_auth::AuthDb,
        web_root: PathBuf,
    ) -> Result<Self, Error> {
        let mut state = Self::authenticated(vaults, auth)?;
        state.web_root = web_root.canonicalize().ok();
        Ok(state)
    }

    /// Builds production state with audit logging and an interactive-editor asset root.
    pub fn authenticated_with_audit_and_web_root(
        vaults: Vec<Vault>,
        auth: mb_auth::AuthDb,
        audit: Option<AuditLog>,
        web_root: PathBuf,
    ) -> Result<Self, Error> {
        let mut state = Self::authenticated_with_audit(vaults, auth, audit)?;
        state.web_root = web_root.canonicalize().ok();
        Ok(state)
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
            access.insert(
                vault.slug().clone(),
                VaultAccess {
                    policy: Arc::new(policy.policy().clone()),
                    source: FileStamp::of(&vault.root().join("access.toml")),
                },
            );
            registered.insert(vault.slug().clone(), vault);
        }
        Ok(Self {
            vaults: registered,
            web_root: None,
            security: Security {
                auth: Mutex::new(auth),
                access: RwLock::new(access),
                audit,
                sync: SyncRegistry::default(),
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
        .route("/api/v1/sync", get(websocket))
        .route("/assets/{*asset}", get(asset))
        .route("/v/{slug}", get(vault_index))
        .route("/v/{slug}/", get(vault_index))
        .route("/v/{slug}/{*note}", get(note))
        .fallback(not_found)
        .with_state(state)
}

/// The largest sync frame the server will read.
///
/// why: awareness carries opaque client JSON that is rebroadcast to a whole room. Without a
/// ceiling, one client turns a 10 MB presence payload into 10 MB per room member.
const MAX_SYNC_FRAME_BYTES: usize = 512 * 1024;

/// Frames one connection may send per second before the server stops reading it.
const MAX_SYNC_FRAMES_PER_SECOND: u32 = 240;

/// How a sync connection proves who it is.
///
/// why: a session cookie names a user for the whole server, but an API token is scoped to
/// one vault and can be revoked mid-connection. Keeping the credential rather than the
/// resolved identity means the token is re-checked on every frame, so revoking it takes
/// effect on the next frame instead of when the socket happens to close.
#[derive(Debug)]
enum WebsocketAuth {
    Session(Username),
    ApiToken(mb_auth::ApiToken),
}

async fn websocket(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    websocket: WebSocketUpgrade,
) -> Response {
    // Only lexical validity is checked here. Whether a token still authorizes anything is a
    // per-frame question, because the answer changes while the socket is open.
    let auth = match state.authenticated_user(&headers) {
        Some(user) => WebsocketAuth::Session(user),
        None => match bearer_token(&headers).and_then(mb_auth::ApiToken::from_secret) {
            Some(token) => WebsocketAuth::ApiToken(token),
            None => return StatusCode::UNAUTHORIZED.into_response(),
        },
    };
    websocket
        .max_message_size(MAX_SYNC_FRAME_BYTES)
        .on_upgrade(move |socket| sync_socket(socket, state, auth))
        .into_response()
}

async fn sync_socket(socket: WebSocket, state: Arc<AppState>, auth: WebsocketAuth) {
    let connection = ConnectionId::issue();
    let auth = Arc::new(auth);
    let (mut writer, mut reader) = socket.split();
    let (outbound, mut incoming) = tokio::sync::mpsc::unbounded_channel::<ServerFrame>();
    let write_task = tokio::spawn(async move {
        while let Some(frame) = incoming.recv().await {
            let Some(encoded) = frame.to_wire() else {
                continue;
            };
            let message = match encoded {
                Wire::Text(text) => Message::Text(text.into()),
                Wire::Binary(bytes) => Message::Binary(bytes.into()),
            };
            if writer.send(message).await.is_err() {
                break;
            }
        }
    });
    let mut budget = FrameBudget::new();
    while let Some(Ok(message)) = reader.next().await {
        let parsed = match &message {
            Message::Text(text) => serde_json::from_str::<ClientFrame>(text).ok(),
            Message::Binary(bytes) => ClientFrame::from_binary(bytes),
            _ => continue,
        };
        drop(message);
        if !budget.allow() {
            drop(outbound.send(ServerFrame::Error {
                code: "rate_limited",
            }));
            break;
        }
        let Some(frame) = parsed else {
            drop(outbound.send(ServerFrame::Error {
                code: "malformed_frame",
            }));
            continue;
        };
        // why: every sync frame touches the filesystem — opening a sidecar, appending an
        // update, materializing Markdown — under a registry-wide lock. Run inline, one slow
        // note stalls the whole runtime. Awaited one at a time so a connection's updates
        // still apply in the order it sent them.
        let worker = (Arc::clone(&state), Arc::clone(&auth), outbound.clone());
        let response = tokio::task::spawn_blocking(move || {
            let (state, auth, outbound) = worker;
            handle_sync_frame(&state, &auth, connection, frame, outbound)
        })
        .await;
        match response {
            Ok(Some(frame)) => drop(outbound.send(frame)),
            Ok(None) => {}
            Err(_) => break,
        }
    }
    let leaving = Arc::clone(&state);
    let closed = tokio::task::spawn_blocking(move || leaving.security.sync.disconnect(connection));
    for error in closed.await.unwrap_or_default() {
        eprintln!("memberberry sync disconnect: {error}");
    }
    write_task.abort();
}

/// A fixed-window frame allowance for one connection.
#[derive(Debug)]
struct FrameBudget {
    window: std::time::Instant,
    used: u32,
}

impl FrameBudget {
    fn new() -> Self {
        Self {
            window: std::time::Instant::now(),
            used: 0,
        }
    }

    fn allow(&mut self) -> bool {
        let now = std::time::Instant::now();
        if now.duration_since(self.window) >= std::time::Duration::from_secs(1) {
            self.window = now;
            self.used = 0;
        }
        self.used += 1;
        self.used <= MAX_SYNC_FRAMES_PER_SECOND
    }
}

/// The one reply every sync-frame denial collapses to.
///
/// why: an unknown vault, an unresolvable path, a missing ACL and a denied role must be
/// indistinguishable. Silence is distinguishable too — an earlier revision returned no
/// frame for a path that did not resolve and `not_found` for one the caller merely could
/// not read, which let a non-member enumerate a vault's notes (§3.2).
const SYNC_DENIED: ServerFrame = ServerFrame::Error { code: "not_found" };

fn handle_sync_frame(
    state: &AppState,
    auth: &WebsocketAuth,
    connection: ConnectionId,
    frame: ClientFrame,
    outbound: tokio::sync::mpsc::UnboundedSender<ServerFrame>,
) -> Option<ServerFrame> {
    match frame {
        ClientFrame::Subscribe { vault, note } => {
            let Some(user) = state.websocket_user(auth, &vault) else {
                return Some(SYNC_DENIED);
            };
            let (vault, canonical, _) = match state.sync_target(&user, &vault, &note) {
                Ok(target) => target,
                Err(denial) => return Some(denial),
            };
            Some(
                state
                    .security
                    .sync
                    .subscribe(vault, &canonical, &note, &user, connection, outbound)
                    .unwrap_or(SYNC_DENIED),
            )
        }
        ClientFrame::Update {
            vault,
            note,
            update,
        } => {
            let Some(user) = state.websocket_user(auth, &vault) else {
                return Some(SYNC_DENIED);
            };
            let (vault, canonical, role) = match state.sync_target(&user, &vault, &note) {
                Ok(target) => target,
                Err(denial) => return Some(denial),
            };
            if !matches!(role, mb_core::Role::Owner | mb_core::Role::Editor) {
                return Some(ServerFrame::Error { code: "read_only" });
            }
            state
                .security
                .sync
                .apply_update(vault, &canonical, &update, &|slug, note, reader| {
                    state.may_read_note(slug, note, reader)
                })
                .err()
                .map(|_| ServerFrame::Error {
                    code: "invalid_update",
                })
        }
        ClientFrame::Unsubscribe { vault, note } => {
            let Some(user) = state.websocket_user(auth, &vault) else {
                return Some(SYNC_DENIED);
            };
            let (vault, canonical, _) = match state.sync_target(&user, &vault, &note) {
                Ok(target) => target,
                Err(denial) => return Some(denial),
            };
            state
                .security
                .sync
                .unsubscribe(vault, &canonical, connection)
                .err()
                .map(|_| SYNC_DENIED)
        }
        ClientFrame::Awareness {
            vault,
            note,
            clients,
            state: awareness,
        } => {
            let Some(user) = state.websocket_user(auth, &vault) else {
                return Some(SYNC_DENIED);
            };
            let (vault, canonical, _) = match state.sync_target(&user, &vault, &note) {
                Ok(target) => target,
                Err(denial) => return Some(denial),
            };
            state.security.sync.broadcast_awareness(
                vault,
                &canonical,
                Announcement {
                    user: user.as_str(),
                    connection,
                    clients: &clients,
                    state: awareness,
                },
                &|slug, note, reader| state.may_read_note(slug, note, reader),
            );
            None
        }
    }
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
            let Some(access) = state.access_for(vault.slug()) else {
                continue;
            };
            let Some(view) = state.authorized_vault(vault, &access, &headers) else {
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
    let Some(access) = state.access_for(vault.slug()) else {
        return not_found().await;
    };
    let Some(view) = state.authorized_vault(vault, &access, &headers) else {
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
    let Some(access) = state.access_for(vault.slug()) else {
        return not_found().await;
    };
    let Some(view) = state.authorized_vault(vault, &access, &headers) else {
        return not_found().await;
    };
    let Ok(source) = view.read(&note) else {
        return not_found().await;
    };
    if let (Some(root), Some(user)) = (&state.web_root, state.authenticated_user(&headers))
        && let Ok(index) = std::fs::read_to_string(root.join("index.html"))
    {
        let marker = "<div id=\"editor\" class=\"editor-surface\"></div>";
        // why: a note path is a filename, and a filename may legally contain a double
        // quote. Interpolated raw, `data-note` closes its own attribute and the rest of
        // the name becomes markup — stored XSS authored by anyone who can write a file
        // into the vault. Every attribute here goes through the same escape the
        // server-rendered path uses.
        let mut editor = String::from("<div id=\"editor\" class=\"editor-surface\" data-vault=\"");
        push_escaped_attr(&mut editor, vault.slug().as_str());
        editor.push_str("\" data-note=\"");
        push_escaped_attr(&mut editor, &note);
        editor.push_str("\" data-user=\"");
        push_escaped_attr(&mut editor, user.as_str());
        editor.push_str("\"></div>");
        return Html(index.replace(marker, &editor)).into_response();
    }
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

async fn asset(State(state): State<Arc<AppState>>, AxumPath(asset): AxumPath<String>) -> Response {
    let Some(root) = &state.web_root else {
        return not_found().await;
    };
    // why: Vite emits `dist/index.html` plus `dist/assets/*`, and the HTML it generates asks
    // for `/assets/<file>`. Resolving that against the build root rather than its `assets`
    // directory made every real bundle 404 and the page load blank — while the test passed,
    // because it asked for `/assets/assets/app.js` and so encoded the bug it should have
    // caught.
    //
    // Containment is checked against that same `assets` directory, not the build root: they
    // are no longer the same directory, and a check against the wider one lets `..` walk back
    // out into whatever else the operator happens to keep beside their bundle.
    let Ok(base) = root.join("assets").canonicalize() else {
        return not_found().await;
    };
    let Ok(path) = base.join(&asset).canonicalize() else {
        return not_found().await;
    };
    if !path.starts_with(&base) || !path.is_file() {
        return not_found().await;
    }
    let Ok(bytes) = std::fs::read(path) else {
        return not_found().await;
    };
    (
        [
            (header::CONTENT_TYPE, content_type(&asset)),
            (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
            // Content types here are inferred from a file extension, so tell the browser not
            // to second-guess them: a sniffed type is a script-execution decision.
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        bytes,
    )
        .into_response()
}

fn content_type(path: &str) -> &'static str {
    if path.ends_with(".js") {
        "text/javascript; charset=utf-8"
    } else if path.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if path.ends_with(".wasm") {
        "application/wasm"
    } else {
        "application/octet-stream"
    }
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

    /// The vault's current policy. Cloned out of the lock so no caller pins a stale one.
    fn access_for(&self, slug: &Slug) -> Option<Arc<mb_core::Access>> {
        let access = self.security.access.read().ok()?;
        access.get(slug).map(|vault| Arc::clone(&vault.policy))
    }

    fn authorized_vault<'a>(
        &self,
        vault: &'a Vault,
        access: &'a mb_core::Access,
        headers: &HeaderMap,
    ) -> Option<AuthorizedVault<'a>> {
        let user = self
            .authenticated_user(headers)
            .or_else(|| self.api_token_user(vault.slug(), headers))?;
        Some(AuthorizedVault::new(vault, access, user))
    }

    /// Re-reads any `access.toml` that changed on disk, failing closed on a bad one.
    ///
    /// why: `AGENTS.md` §3.1 requires per-frame authorization, which is only meaningful if
    /// the policy can actually change under an open connection. Without this, a revocation
    /// written to disk — including one `invites.rs` writes itself — took effect at the next
    /// restart, so E3 and E4's re-checks consulted a map that could never move.
    ///
    /// A malformed file installs a deny-all policy rather than keeping the last good one:
    /// §3.1 says malformed input denies everything, and silently serving a superseded ACL
    /// is exactly the "permission check you forgot" this project treats as a breach.
    pub fn reload_access(&self) -> Vec<String> {
        let Ok(mut access) = self.security.access.write() else {
            return vec!["access policy lock poisoned".to_string()];
        };
        let mut errors = Vec::new();
        for (slug, vault) in &self.vaults {
            let path = vault.root().join("access.toml");
            let stamp = FileStamp::of(&path);
            let Some(current) = access.get(slug) else {
                continue;
            };
            if current.source == stamp {
                continue;
            }
            let policy = match AccessFile::load(vault.root()) {
                Ok(file) => Arc::new(file.policy().clone()),
                Err(error) => {
                    errors.push(format!("{slug}: {error}; denying all access to this vault"));
                    Arc::new(mb_core::Access::default())
                }
            };
            access.insert(
                slug.clone(),
                VaultAccess {
                    policy,
                    source: stamp,
                },
            );
        }
        errors
    }

    /// Revokes an API token. Test-only seam for driving revocation against a live server.
    #[doc(hidden)]
    pub fn revoke_api_token_for_test(&self, token: &mb_auth::ApiToken) {
        if let Ok(auth) = self.security.auth.lock() {
            drop(auth.revoke_api_token(token));
        }
    }

    /// Resolves the identity a sync frame acts as, for the vault that frame names.
    ///
    /// An API token is re-authenticated here on every frame, and must be scoped to exactly
    /// the vault being addressed. A revoked, unknown or wrong-vault token resolves to no
    /// user at all, which the caller turns into the same neutral denial an unreadable note
    /// gets — it never reveals that the vault or note exists.
    ///
    /// A token grants no access by itself: the resolved username is then run through the
    /// vault's ACL like any other, so a token cannot outrank the person who issued it.
    fn websocket_user(&self, auth: &WebsocketAuth, vault_slug: &str) -> Option<Username> {
        match auth {
            WebsocketAuth::Session(user) => Some(user.clone()),
            WebsocketAuth::ApiToken(token) => {
                let auth = self.security.auth.lock().ok()?;
                let scope = auth.authenticate_api_token(token).ok()??;
                if scope.vault_slug != vault_slug {
                    return None;
                }
                let user = auth.user_by_id(scope.user_id).ok()??;
                Username::parse(&user.username).ok()
            }
        }
    }

    /// Resolves and authorizes one sync frame's target, or denies it neutrally.
    ///
    /// Returns only readable targets, so a caller can never act on a role of
    /// [`mb_core::Role::None`]. Every failure yields the same [`SYNC_DENIED`] frame.
    fn sync_target<'a>(
        &'a self,
        user: &Username,
        slug: &str,
        note: &str,
    ) -> Result<(&'a Vault, crate::vault::CanonicalNote, mb_core::Role), ServerFrame> {
        self.vault(slug)
            .and_then(|vault| {
                // Resolve first: clients must not create arbitrary documents by naming them,
                // and the resolved identity — not `note` — is what keys the document's room.
                let canonical = vault.canonical_note(note).ok()?;
                let path = mb_core::NotePath::parse(note).ok()?;
                let access = self.access_for(vault.slug())?;
                let role = access.effective_role(user, &path);
                (role != mb_core::Role::None).then_some((vault, canonical, role))
            })
            .ok_or(SYNC_DENIED)
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
    page_with(
        PagePolicy::SignIn,
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

/// What a page is allowed to do, beyond the shared deny-everything baseline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PagePolicy {
    /// Renders untrusted note content. Submits nothing, loads nothing, executes nothing.
    Content,
    /// The sign-in page. Identical, except it may post its own form back to this origin.
    SignIn,
}

impl PagePolicy {
    /// The `form-action` source list this policy permits.
    fn form_action(self) -> &'static str {
        match self {
            // why: `'none'` on every page made the sign-in form unsubmittable, so nobody
            // could log in with a browser at all. Only this page has a form, and it posts
            // to its own origin; the note pages keep the stricter rule they need.
            Self::SignIn => "'self'",
            Self::Content => "'none'",
        }
    }
}

/// Wraps a fragment in a minimal document.
///
/// Deliberately one self-contained file with no external assets: M0 has no build step, and
/// a page that renders with no network round trips is also the one that still works when
/// the JavaScript of later milestones fails.
fn page(title: &str, body: &str) -> Html<String> {
    page_with(PagePolicy::Content, title, body)
}

fn page_with(policy: PagePolicy, title: &str, body: &str) -> Html<String> {
    let mut out = String::with_capacity(body.len() + TOKENS.len() + STYLE.len() + 512);
    out.push_str("<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\" />\n");
    out.push_str("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n");
    // why: the notes being rendered are untrusted content. A restrictive CSP is a second
    // line of defence behind the escaping in `mb_core::html` — if an escaping bug ever
    // lands, this stops it becoming script execution.
    out.push_str(
        "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; \
         img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action ",
    );
    out.push_str(policy.form_action());
    out.push_str("\" />\n");
    out.push_str("<title>");
    push_escaped_text(&mut out, title);
    out.push_str(" · Memberberry</title>\n<style>");
    out.push_str(TOKENS);
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

/// How often due Markdown writes and pending filesystem events are applied.
const MAINTENANCE_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);

/// How often every open note is re-read regardless of what the watcher reported.
///
/// why: `SPEC.md` §3.4 names `notify` as the trigger, but a watcher is not a guarantee —
/// kernel queues overflow, network filesystems report nothing, and a large `git checkout`
/// is exactly the case that drops events. This sweep is the floor on how stale an open note
/// can get, and is the reason a lost event is a delay rather than a permanently wrong note.
const RECOVERY_SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);

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
    let signal = Arc::new(WatchSignal::default());
    let (watcher, problems) = crate::watch::watch(&state.watch_roots(), Arc::clone(&signal));
    for problem in problems {
        eprintln!("memberberry watcher: {problem}; falling back to the recovery sweep");
    }
    let maintenance_state = Arc::clone(&state);
    let maintenance = tokio::spawn(async move {
        let mut interval = tokio::time::interval(MAINTENANCE_INTERVAL);
        let mut since_sweep = std::time::Duration::ZERO;
        loop {
            interval.tick().await;
            since_sweep += MAINTENANCE_INTERVAL;
            let mut changed = signal.take();
            if since_sweep >= RECOVERY_SWEEP_INTERVAL {
                since_sweep = std::time::Duration::ZERO;
                changed = Changes::All;
            }
            let tick = Arc::clone(&maintenance_state);
            let errors = tokio::task::spawn_blocking(move || tick.maintain_sync(&changed)).await;
            for error in errors.unwrap_or_default() {
                eprintln!("memberberry sync maintenance: {error}");
            }
        }
    });
    let served = axum::serve(listener, router(Arc::clone(&state)))
        .with_graceful_shutdown(shutdown())
        .await;
    // Stop the timer before flushing so the two are never in a note's writer at once.
    maintenance.abort();
    drop(watcher);
    for error in state.security.sync.flush_all() {
        eprintln!("memberberry sync shutdown flush: {error}");
    }
    served.map_err(Error::Serve)
}

async fn shutdown() {
    drop(tokio::signal::ctrl_c().await);
    println!("\nmemberberry: shutting down");
}

/// The design-token contract (SPEC §20.1), compiled into the binary.
///
/// why: `include_str!` rather than a second copy of the values. These pages are a separate
/// *render* path from the app (§17.2) and carry no external assets on purpose, but they are
/// not a separate *design system* — one file declares the tokens and both sides reference
/// them, so the two cannot drift apart. The cost is a few KB of inline CSS per page, which
/// is the right trade for a read-only fallback that must render with no network round trips.
const TOKENS: &str = include_str!("../../../web/src/shell/tokens.css");

/// Rules for the server-rendered pages. Colour, type, spacing and radii come from `TOKENS`;
/// `scripts/token-check.py` fails the build on a literal colour or an undeclared token.
const STYLE: &str = "\
*{box-sizing:border-box}\
body{margin:0;background:var(--surface-canvas);color:var(--text-primary);font:var(--text-md)/var(--leading-body) var(--font-body)}\
header{border-bottom:1px solid var(--border-subtle);padding:var(--space-5) var(--space-7);font:var(--weight-bold) var(--text-xs)/var(--leading-flat) var(--font-ui);letter-spacing:var(--tracking-wide);text-transform:uppercase}\
header a{color:var(--accent-primary);text-decoration:none}\
main{max-width:var(--editor-measure);margin:0 auto;padding:var(--space-8) var(--space-7) var(--space-9)}\
h1,h2,h3,h4,h5,h6{line-height:var(--leading-snug);margin:var(--space-8) 0 var(--space-5);letter-spacing:var(--tracking-display)}\
.mb-page-title{margin-top:0;font-size:var(--text-2xl)}\
a{color:var(--accent-primary)}\
code{background:var(--surface-sunken);padding:.1em .35em;border-radius:var(--radius-sm);font-family:var(--font-mono);font-size:.9em}\
pre{background:var(--surface-sunken);padding:var(--space-6);border-radius:var(--radius-md);overflow-x:auto;font:var(--text-sm)/var(--leading-body) var(--font-mono)}\
pre code{background:none;padding:0;font-size:inherit}\
blockquote{border-left:3px solid var(--border-subtle);margin:var(--space-6) 0;padding:var(--space-2) 0 var(--space-2) var(--space-6);color:var(--text-muted)}\
table{border-collapse:collapse;width:100%;margin:var(--space-6) 0}\
th,td{border:1px solid var(--border-subtle);padding:var(--space-3) var(--space-4);text-align:left}\
hr{border:0;border-top:1px solid var(--border-subtle);margin:var(--space-8) 0}\
img{max-width:100%;height:auto}\
ul,ol{padding-left:var(--space-7)}\
.mb-task-list{list-style:none;padding-left:var(--space-2)}\
.mb-task-done{color:var(--text-muted);text-decoration:line-through}\
.mb-task-cancelled{color:var(--text-muted);text-decoration:line-through;opacity:.7}\
.mb-task p{display:inline}\
.mb-tag{color:var(--accent-primary);font-size:.9em}\
.mb-callout{border:1px solid var(--border-subtle);border-left:3px solid var(--accent-primary);border-radius:var(--radius-md);padding:var(--space-5) var(--space-6);margin:var(--space-6) 0;background:var(--surface-note)}\
.mb-callout-title{font-weight:var(--weight-bold);text-transform:capitalize}\
.mb-math,.mb-math-block{font-family:var(--font-mono)}\
.mb-math-block{display:block;margin:var(--space-6) 0;text-align:center}\
.mb-note-list,.mb-vault-list{list-style:none;padding:0}\
.mb-note-list li,.mb-vault-list li{border-bottom:1px solid var(--border-subtle);padding:var(--space-3) 0}\
.mb-count,.mb-breadcrumb,.mb-empty{color:var(--text-muted);font:var(--text-xs)/var(--leading-snug) var(--font-ui)}\
";
