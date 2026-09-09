//! Routes and rendering.
//!
//! Routes follow `SPEC.md` §6.1: the UI lives under `/v/<slug>/…`, and the API under
//! `/api/v1/…`. The API grows a milestone at a time — sync in M5, the workspace, note index
//! and vault list in M7 — and anything not yet built is **absent rather than stubbed**,
//! because a route that answers is a route someone will build on.
//!
//! Every route that names a note or a vault goes through
//! [`AuthorizedVault`](crate::repository::AuthorizedVault) first. There is no unfiltered
//! listing helper in this module, and adding one would be the bug §6.4 enumerates
//! enforcement points to prevent.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Form, Path as AxumPath, Query, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;

use mb_core::Username;
use mb_core::html::Urls;

use crate::audit::{AuditAction, AuditEvent, AuditLog, AuditResult};
use crate::bookmarks::BookmarkStore;
use crate::create::{CreateError, CreateNote};
use crate::indexing::IndexRegistry;
use crate::rename::{Rename, RenameError};
use crate::repository::AuthorizedVault;
use crate::sync::{Announcement, ClientFrame, ConnectionId, ServerFrame, SyncRegistry, Wire};
use crate::titles::{NoteSummary, NoteTaskSummary, TitleCache};
use crate::watch::{Changes, WatchSignal};
use crate::workspace::{DeviceId, WorkspaceStore};
use crate::{AccessFile, Error, Slug, Vault};

/// The vaults this server knows about, keyed by slug.
#[derive(Debug)]
pub struct AppState {
    vaults: BTreeMap<Slug, Vault>,
    web_root: Option<PathBuf>,
    /// Server-owned storage (§4.1). Bookmarks live here rather than in a vault; see
    /// `bookmarks.rs` for why. `None` leaves the routes that need it answering as denied.
    data_dir: Option<PathBuf>,
    /// Gzipped bundle assets, so a 945 KB WebAssembly module is compressed once rather than
    /// once per visitor. See [`asset`].
    assets: RwLock<BTreeMap<PathBuf, CachedAsset>>,
    /// One graph/link/tag index per vault (§9.1), opened on first use and kept in step with
    /// the files by [`AppState::maintain_index`].
    indexes: IndexRegistry,
    media_manifest: Mutex<()>,
    /// Short-lived, per-uploader grants bridge upload and the note's next indexed save.
    media_uploads: Mutex<HashMap<(Slug, mb_core::Username, String), std::time::Instant>>,
    security: Security,
}

/// One bundle asset, already compressed.
///
/// The stamp is what makes this safe to hold: Vite content-hashes every filename, so a
/// changed asset is a *different* URL and this map can only ever grow. A stamp is carried
/// anyway because `web_root` is a directory an operator controls, and a rebuilt bundle
/// dropped over an old one in place would otherwise be served from a stale entry forever.
#[derive(Debug, Clone)]
struct CachedAsset {
    stamp: FileStamp,
    /// `Bytes` rather than `Vec<u8>`: cloning it for a response is a reference count, so a
    /// cache hit copies nothing. A `Vec` would have meant memcpy-ing 360 KB per request,
    /// which is most of what the cache exists to avoid.
    gzip: axum::body::Bytes,
}

#[derive(Debug)]
struct Security {
    auth: Mutex<mb_auth::AuthDb>,
    /// Live per-vault policy. Re-read when `access.toml` changes on disk, so a revocation
    /// takes effect on the next frame rather than at the next restart.
    access: RwLock<BTreeMap<Slug, VaultAccess>>,
    audit: Option<AuditLog>,
    sync: SyncRegistry,
    /// Note titles for the quick switcher, per vault (§8.4, §21.2).
    titles: RwLock<BTreeMap<Slug, Arc<TitleCache>>>,
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

    /// Brings every vault's index in step with its files (§9.1).
    ///
    /// Separate from [`AppState::maintain_sync`] and on its own cadence: sync maintenance
    /// inspects the notes that are *open*, while a full index reconcile walks the whole
    /// vault, and doing that at sync cadence would spend a directory walk of 10 000 notes
    /// every few hundred milliseconds to notice nothing. `indexing.rs` has the two cadences.
    ///
    /// Blocking: callers must keep it off the async runtime.
    pub fn maintain_index(&self, changed: &Changes) -> Vec<String> {
        let mut errors = self.indexes.maintain(self.vaults.values(), changed);
        for vault in self.vaults.values() {
            let Some(access) = self.access_for(vault.slug()) else {
                errors.push(format!(
                    "vault `{}`: no live policy is available; ACL zones were not updated",
                    vault.slug()
                ));
                continue;
            };
            if let Err(error) = self.indexes.maintain_zones(vault, &access) {
                errors.push(error);
            }
        }
        errors
    }

    /// Materializes every configured remote media backend into its vault.
    pub async fn materialize_media(&self) -> Vec<String> {
        let mut errors = Vec::new();
        for vault in self.vaults.values() {
            if matches!(vault.media_backend(), crate::MediaBackendConfig::Local) {
                continue;
            }
            if let Err(error) = crate::media::materialize(vault).await {
                errors.push(format!("vault `{}`: {error}", vault.slug()));
            }
        }
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

    /// Points the server at its own data directory, for storage that is not a vault's (§4.1).
    #[must_use]
    pub fn with_data_dir(mut self, data_dir: PathBuf) -> Self {
        self.data_dir = Some(data_dir);
        self
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
            data_dir: None,
            assets: RwLock::new(BTreeMap::new()),
            indexes: IndexRegistry::default(),
            media_manifest: Mutex::new(()),
            media_uploads: Mutex::new(HashMap::new()),
            security: Security {
                auth: Mutex::new(auth),
                access: RwLock::new(access),
                audit,
                sync: SyncRegistry::default(),
                titles: RwLock::new(BTreeMap::new()),
            },
        })
    }

    /// This vault's title cache, created on first use.
    fn title_cache(&self, slug: &Slug) -> Arc<TitleCache> {
        if let Ok(caches) = self.security.titles.read()
            && let Some(cache) = caches.get(slug)
        {
            return Arc::clone(cache);
        }
        let Ok(mut caches) = self.security.titles.write() else {
            // A poisoned lock costs the cache, not the request: an uncached instance still
            // returns correct titles, just slowly.
            return Arc::new(TitleCache::new());
        };
        Arc::clone(
            caches
                .entry(slug.clone())
                .or_insert_with(|| Arc::new(TitleCache::new())),
        )
    }

    /// This asset's gzipped bytes, compressing and caching them on first use.
    ///
    /// `None` means "serve it uncompressed" — a read failure, a compression failure or a
    /// poisoned lock all cost the compression, never the response. `path` must already be
    /// the canonicalized, containment-checked path: this is a cache, not a boundary.
    fn compressed_asset(&self, path: &std::path::Path) -> Option<axum::body::Bytes> {
        let stamp = FileStamp::of(path)?;
        if let Ok(cache) = self.assets.read()
            && let Some(hit) = cache.get(path)
            && hit.stamp == stamp
        {
            return Some(hit.gzip.clone());
        }
        let bytes = std::fs::read(path).ok()?;
        let gzip = axum::body::Bytes::from(crate::compress::to_gzip(&bytes).ok()?);
        // Never larger than the file: a bundle asset that does not compress is served as it
        // is rather than grown by an envelope.
        if gzip.len() >= bytes.len() {
            return None;
        }
        if let Ok(mut cache) = self.assets.write() {
            cache.insert(
                path.to_path_buf(),
                CachedAsset {
                    stamp,
                    gzip: gzip.clone(),
                },
            );
        }
        Some(gzip)
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
        .route("/api/v1/vaults", get(vault_index_json))
        .route(
            "/api/v1/vaults/{slug}/notes",
            get(note_index)
                .post(create_note)
                // A create body is one path. Bounded here for the same reason `rename`'s is.
                .layer(DefaultBodyLimit::max(8 * 1024)),
        )
        .route(
            "/api/v1/vaults/{slug}/backlinks/{*note}",
            get(note_backlinks),
        )
        .route("/api/v1/vaults/{slug}/graph", get(vault_graph))
        .route("/api/v1/vaults/{slug}/graph/{*note}", get(note_graph))
        .route("/api/v1/vaults/{slug}/search", get(search_notes))
        .route("/api/v1/vaults/{slug}/templates", get(template_index))
        .route("/api/v1/vaults/{slug}/daily", get(daily_index))
        .route(
            "/api/v1/vaults/{slug}/templates/{*template}",
            get(template_content),
        )
        .route("/api/v1/vaults/{slug}/tasks", get(vault_tasks))
        .route("/api/v1/vaults/{slug}/emoji", get(vault_emoji))
        .route(
            "/api/v1/vaults/{slug}/emoji/packs/{pack}",
            put(vault_emoji_upload).layer(DefaultBodyLimit::max(8 * 1024 * 1024)),
        )
        .route(
            "/api/v1/vaults/{slug}/emoji/{*asset}",
            get(vault_emoji_asset),
        )
        .route(
            "/api/v1/emoji/packs/{pack}",
            put(shared_emoji_upload).layer(DefaultBodyLimit::max(8 * 1024 * 1024)),
        )
        .route(
            "/api/v1/vaults/{slug}/media",
            post(media_upload).layer(DefaultBodyLimit::max(32 * 1024 * 1024)),
        )
        .route("/api/v1/vaults/{slug}/media/{*media}", get(media))
        .route(
            "/api/v1/vaults/{slug}/search/segments",
            get(search_segments),
        )
        .route(
            "/api/v1/vaults/{slug}/search/segments/{zone_id}",
            get(search_segment),
        )
        .route("/api/v1/vaults/{slug}/tags", get(tag_index))
        .route("/api/v1/vaults/{slug}/tags/{*prefix}", get(tagged_notes))
        .route(
            "/api/v1/vaults/{slug}/rename",
            post(rename)
                // A rename body is two names. Bounded before the handler so an
                // authenticated member cannot make the server buffer a megabyte of them.
                .layer(DefaultBodyLimit::max(8 * 1024)),
        )
        .route("/api/v1/vaults/{slug}/embed/{*target}", get(note_embed))
        .route("/api/v1/vaults/{slug}/resolve/{*target}", get(note_resolve))
        .route(
            "/api/v1/vaults/{slug}/bookmarks",
            get(bookmarks_load)
                .put(bookmarks_save)
                .layer(DefaultBodyLimit::max(64 * 1024)),
        )
        .route(
            "/api/v1/vaults/{slug}/workspace/{device}",
            get(workspace_load)
                .put(workspace_save)
                // why: bounded before the handler sees it. `WorkspaceStore::save` also
                // refuses an oversized layout, but axum's 2 MB default would buffer the
                // whole thing first — an authenticated member gets to allocate that per
                // request otherwise.
                .layer(DefaultBodyLimit::max(crate::workspace::MAX_LAYOUT_BYTES)),
        )
        .route("/assets/{*asset}", get(asset))
        // The three files a service worker needs at the root of the origin (§7.4). They are
        // named individually rather than served from a directory: a wildcard over the build
        // root would hand out whatever else an operator keeps beside their bundle, and the
        // whole point of `asset`'s containment check is that it must not.
        .route("/app.html", get(app_shell))
        .route("/sw.js", get(service_worker))
        .route("/manifest.webmanifest", get(web_manifest))
        .route("/icon.svg", get(app_icon))
        .route("/v/{slug}", get(vault_index))
        .route(
            "/v/{slug}/new",
            post(create_note_from_form).layer(DefaultBodyLimit::max(8 * 1024)),
        )
        .route("/v/{slug}/", get(vault_index))
        .route("/v/{slug}/media/{*media}", get(media))
        .route("/v/{slug}/{*note}", get(note))
        .fallback(not_found)
        .with_state(state)
        // Outermost, so it sees every response including the fallback's. §21.2 budgets the
        // critical path in gzip and this is what makes the wire agree with the budget;
        // `compress.rs` documents what it will and will not touch, and why the WebSocket
        // upgrade passes through it untouched.
        .layer(axum::middleware::from_fn(crate::compress::gzip))
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
    vault_index_page(&state, &slug, &headers, None)
}

/// Renders the vault index, optionally reporting why a create just failed.
///
/// Shared by the listing and by the create form's own error path, so a refusal comes back on
/// the page that asked rather than as a bare error document with no way onward.
fn vault_index_page(
    state: &AppState,
    slug: &str,
    headers: &HeaderMap,
    error: Option<&str>,
) -> Response {
    let Some(vault) = state.vault(slug) else {
        return not_found_page();
    };
    let Some(access) = state.access_for(vault.slug()) else {
        return not_found_page();
    };
    let Some(view) = state.authorized_vault(vault, &access, headers) else {
        return not_found_page();
    };
    let notes = match view.notes() {
        Ok(notes) => notes,
        Err(error) => return server_error(&error),
    };

    let mut body = String::new();
    body.push_str("<p class=\"mb-count\">");
    body.push_str(&notes.len().to_string());
    body.push_str(" notes</p>\n");

    // why: the form is on this page rather than only in the workspace, and that is the whole
    // point of it. The editor is served from a note URL, so a vault with no notes has no way
    // to load the shell and therefore no way to reach the palette's create command. Without
    // something here, a freshly registered vault is a dead end that can only be escaped by
    // writing a Markdown file by hand.
    // The sign-in page's form vocabulary, not a second one: same classes, same tokens, so
    // this inherits the touch-target and focus-ring rules already proved on that page.
    body.push_str("<form class=\"mb-form\" method=\"post\" action=\"/v/");
    push_escaped_attr(&mut body, vault.slug().as_str());
    body.push_str("/new\">");
    if let Some(message) = error {
        // role="alert" so the refusal is heard as well as seen (AGENTS.md §4.4).
        body.push_str("<p class=\"mb-form-error\" role=\"alert\">");
        push_escaped_text(&mut body, message);
        body.push_str("</p>");
    }
    body.push_str(
        "<div class=\"mb-field\"><label for=\"mb-new-note\">New note</label>\
         <input id=\"mb-new-note\" name=\"name\" autocomplete=\"off\" spellcheck=\"false\" \
         required ",
    );
    // Autofocus only when the vault is empty: that is the one visit where creating a note is
    // certainly what the reader came to do, and stealing focus from the list otherwise would
    // fight anyone who arrived to open something.
    if notes.is_empty() {
        body.push_str("autofocus ");
    }
    body.push_str("/></div>");
    body.push_str("<button class=\"mb-button\" type=\"submit\">Create</button>");
    body.push_str("</form>");

    if notes.is_empty() {
        body.push_str(
            "<p class=\"mb-empty\">This vault has no notes yet. Create one to get started.</p>",
        );
    } else {
        body.push_str("<ul class=\"mb-note-list\">\n");
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
    }
    // The page carries a form, so it needs `form-action 'self'`; the note pages, which render
    // untrusted content and submit nothing, keep the stricter policy.
    page_with(PagePolicy::VaultIndex, vault.name(), &body).into_response()
}

/// What the vault index form submits: a name, not a path the caller composed.
#[derive(Deserialize)]
struct NewNoteForm {
    name: String,
}

/// `POST /v/{slug}/new` — creates a note from the vault index and opens it (§6.10, E17).
///
/// A form post rather than script, because this is the page that has to work before the
/// application does. A `303` afterwards, so the browser lands on the new note with a `GET`
/// and reloading it does not re-post the form.
async fn create_note_from_form(
    State(state): State<Arc<AppState>>,
    AxumPath(slug): AxumPath<String>,
    headers: HeaderMap,
    Form(form): Form<NewNoteForm>,
) -> Response {
    let path = note_path_for(&form.name);
    match create_in_vault(&state, &slug, &path, None, &headers).await {
        Ok(created) => (
            StatusCode::SEE_OTHER,
            [(
                header::LOCATION,
                format!("/v/{}/{}", slug, encode_path(&created.path)),
            )],
        )
            .into_response(),
        // A denial is the invisibility rule again: the same page an unknown vault gives.
        Err(CreateError::Denied) => not_found_page(),
        Err(error @ (CreateError::InvalidName(_) | CreateError::Exists(_))) => {
            vault_index_page(&state, &slug, &headers, Some(&error.to_string()))
        }
        Err(error) => server_error(&Error::Config(error.to_string())),
    }
}

/// The vault-relative path a name typed on the vault index means.
///
/// Deliberately thin: it appends the extension nobody thinks of as part of a name, and
/// nothing else. Every rule about what is *allowed* stays in `create`, which is the one
/// place that decides — duplicating any of it here would be a second opinion to keep in step.
fn note_path_for(typed: &str) -> String {
    let name = typed.trim();
    if name.ends_with(".md") {
        name.to_string()
    } else {
        format!("{name}.md")
    }
}

/// The JSON denial every workspace route gives, whatever went wrong.
///
/// why: one shape for "no such vault", "you are not a member", "that is not a device id" and
/// "you have saved nothing". Distinguishing them would let an unauthenticated prober map the
/// vaults on a server, which §6.5 says must not be possible.
fn workspace_denied() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(header::CONTENT_TYPE, "application/json")],
        "{}",
    )
        .into_response()
}

/// The user and store for a workspace request, or `None` if it is denied (E15).
///
/// The user comes from the session, never from the URL: there is no route parameter naming
/// whose layout this is, so there is nothing for a caller to substitute.
fn authorize_workspace<'a>(
    state: &'a AppState,
    slug: &str,
    device: &str,
    headers: &HeaderMap,
) -> Option<(Username, DeviceId, WorkspaceStore<'a>)> {
    let vault = state.vault(slug)?;
    let access = state.access_for(vault.slug())?;
    let view = state.authorized_vault(vault, &access, headers)?;
    // Vault membership, not note-level access: a layout is not a note. A user with no access
    // to this vault at all must not be able to tell it exists.
    if !view.has_any_access().unwrap_or(false) {
        return None;
    }
    let user = state
        .authenticated_user(headers)
        .or_else(|| state.api_token_user(vault.slug(), headers))?;
    let device = DeviceId::parse(device).ok()?;
    Some((user, device, WorkspaceStore::new(vault.root())))
}

#[derive(serde::Serialize)]
struct VaultSummary<'a> {
    slug: &'a str,
    name: &'a str,
}

/// `GET /api/v1/vaults` — the vaults this user can open, for the vault switcher (§8.4).
///
/// Enforcement point E1. Discoverability is `AuthorizedVault::has_any_access`, the same rule
/// the HTML index uses: a vault-wide membership makes even an empty vault discoverable, and a
/// path-specific grant makes it discoverable once it applies to a readable note. A vault this
/// user has no access to is not listed, so the switcher cannot be used to enumerate a server.
async fn vault_index_json(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let mut visible: Vec<VaultSummary<'_>> = Vec::new();
    for vault in state.vaults.values() {
        let Some(access) = state.access_for(vault.slug()) else {
            continue;
        };
        let Some(view) = state.authorized_vault(vault, &access, &headers) else {
            continue;
        };
        if view.has_any_access().unwrap_or(false) {
            visible.push(VaultSummary {
                slug: vault.slug().as_str(),
                name: vault.name(),
            });
        }
    }

    let body = match serde_json::to_string(&visible) {
        Ok(body) => body,
        Err(error) => return server_error(&Error::Config(error.to_string())),
    };
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response()
}

/// The most notes one response will name.
///
/// why: a ceiling at all. The quick switcher ranks client-side (§21.2 budgets it at 80 ms over
/// 10 000 notes), so the whole readable list has to travel — but a vault an order of magnitude
/// larger than the design target should degrade into a truncated list rather than a response
/// nobody can hold. `truncated` says so, so the UI can tell the user instead of silently
/// looking like the note does not exist.
const MAX_NOTE_INDEX: usize = 20_000;

#[derive(serde::Serialize)]
struct NoteIndexResponse {
    notes: Vec<NoteSummary>,
    truncated: bool,
}

/// `GET /api/v1/vaults/{slug}/notes` — the readable notes, their titles and their conflicts.
///
/// §8.4 for the titles, §3.5 for the unresolved-conflict count the note tree badges with. The
/// count travels here because this is where the tree's data already comes from, and because a
/// badge that needed a note opened to appear would not be a badge.
///
/// Enforcement point E1/E5: the list comes from [`AuthorizedVault::notes`], which is already
/// filtered, and the title cache is only ever handed paths that survived that filter. A note
/// this user cannot read is not named, not counted, and not distinguishable from one that does
/// not exist (§6.5) — and that applies to the conflict count as much as to the title: a number
/// about a note somebody cannot see is still knowledge of a note that does not exist for them.
async fn note_index(
    State(state): State<Arc<AppState>>,
    AxumPath(slug): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    let Some(vault) = state.vault(&slug) else {
        return workspace_denied();
    };
    let Some(access) = state.access_for(vault.slug()) else {
        return workspace_denied();
    };
    let Some(view) = state.authorized_vault(vault, &access, &headers) else {
        return workspace_denied();
    };
    let Ok(mut readable) = view.notes() else {
        return workspace_denied();
    };
    // A non-member gets the same empty-handed answer as an unknown vault, rather than an
    // empty list that confirms the vault exists.
    if !view.has_any_access().unwrap_or(false) {
        return workspace_denied();
    }

    let truncated = readable.len() > MAX_NOTE_INDEX;
    readable.truncate(MAX_NOTE_INDEX);

    let cache = state.title_cache(vault.slug());
    let notes = cache.summaries(readable.iter().map(String::as_str), |relative| {
        // Through the *authorized* view, so a path that stopped being readable between the
        // listing and the read is refused rather than parsed.
        view.resolve(relative).ok()
    });

    let mut notes = notes;
    if let Some(index) = state.indexes.get(vault)
        && let Some(user) = state.vault_user(vault.slug(), &headers)
        && let Ok(mut index) = index.lock()
        && let Ok(reader) = index.reader(&access, &user)
        && let Ok(tasks) = reader.tasks(&mb_index::TaskQuery::default())
    {
        let mut by_path: HashMap<String, Vec<NoteTaskSummary>> = HashMap::new();
        for task in tasks {
            by_path.entry(task.path).or_default().push(NoteTaskSummary {
                block_id: task.block_id,
                text: task.text,
                due: task.due,
                scheduled: task.scheduled,
                start: task.start,
                created: task.created,
                priority: task.priority.map(priority_label).map(str::to_string),
                ordinal: task.ordinal,
            });
        }
        for note in &mut notes {
            if let Some(tasks) = by_path.remove(&note.path) {
                note.tasks = tasks;
            }
        }
    }

    let body = match serde_json::to_string(&NoteIndexResponse { notes, truncated }) {
        Ok(body) => body,
        Err(error) => return server_error(&Error::Config(error.to_string())),
    };
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json"),
            // The list is a list of note titles. Nothing should keep a copy.
            (header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response()
}

#[derive(serde::Serialize)]
struct TemplateSummary {
    path: String,
    name: String,
}

#[derive(serde::Serialize)]
struct TemplateIndexResponse {
    folder: String,
    templates: Vec<TemplateSummary>,
}

#[derive(serde::Serialize)]
struct DailyIndexResponse {
    folder: String,
    format: String,
    notes: Vec<DailyNoteSummary>,
    template: Option<String>,
    weekly: PeriodicIndexResponse,
    monthly: PeriodicIndexResponse,
}

#[derive(serde::Serialize)]
struct PeriodicIndexResponse {
    folder: String,
    format: String,
    notes: Vec<DailyNoteSummary>,
    template: Option<String>,
}

#[derive(serde::Serialize)]
struct DailyNoteSummary {
    date: String,
    path: String,
}

/// GET /api/v1/vaults/{slug}/daily — readable daily notes for the calendar.
///
/// The note list comes from AuthorizedVault, so the calendar cannot reveal a date whose note
/// is private. A missing daily note is simply absent; creation remains the ordinary note
/// creation operation and therefore uses the same write permission boundary.
async fn daily_index(
    State(state): State<Arc<AppState>>,
    AxumPath(slug): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    let Some(vault) = state.vault(&slug) else {
        return workspace_denied();
    };
    let Some(access) = state.access_for(vault.slug()) else {
        return workspace_denied();
    };
    let Some(view) = state.authorized_vault(vault, &access, &headers) else {
        return workspace_denied();
    };
    if !view.has_any_access().unwrap_or(false) {
        return workspace_denied();
    }
    let readable = match view.notes() {
        Ok(paths) => paths,
        Err(_) => return workspace_denied(),
    };
    let (folder, format) = vault.daily_note_config();
    let daily = periodic_index(
        &readable,
        mb_core::daily::Period::Daily,
        folder,
        format,
        vault,
        vault.daily_note_template(),
    );
    let (weekly_folder, weekly_format) = vault.weekly_note_config();
    let weekly = periodic_index(
        &readable,
        mb_core::daily::Period::Weekly,
        weekly_folder,
        weekly_format,
        vault,
        vault.weekly_note_template(),
    );
    let (monthly_folder, monthly_format) = vault.monthly_note_config();
    let monthly = periodic_index(
        &readable,
        mb_core::daily::Period::Monthly,
        monthly_folder,
        monthly_format,
        vault,
        vault.monthly_note_template(),
    );
    let body = match serde_json::to_string(&DailyIndexResponse {
        folder: daily.folder,
        format: daily.format,
        notes: daily.notes,
        template: daily.template,
        weekly,
        monthly,
    }) {
        Ok(body) => body,
        Err(error) => return server_error(&Error::Config(error.to_string())),
    };
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response()
}

fn periodic_index(
    readable: &[String],
    period: mb_core::daily::Period,
    folder: String,
    format: String,
    vault: &Vault,
    template_name: String,
) -> PeriodicIndexResponse {
    let prefix = format!("{folder}/");
    let notes = readable
        .iter()
        .filter_map(|path| {
            let date = mb_core::daily::periodic_date_from_path(period, &prefix, &format, path)?;
            Some(DailyNoteSummary {
                date: date.to_string(),
                path: path.clone(),
            })
        })
        .collect();
    let template_path = format!("{}/{}", vault.template_folder(), template_name);
    PeriodicIndexResponse {
        folder,
        format,
        notes,
        template: readable.contains(&template_path).then_some(template_path),
    }
}

/// `GET /api/v1/vaults/{slug}/templates` — readable Markdown templates.
///
/// Templates are ordinary notes under the configured folder. Listing through the authorized
/// repository keeps a template from becoming a side channel for an unreadable note.
async fn template_index(
    State(state): State<Arc<AppState>>,
    AxumPath(slug): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    let Some(vault) = state.vault(&slug) else {
        return workspace_denied();
    };
    let Some(access) = state.access_for(vault.slug()) else {
        return workspace_denied();
    };
    let Some(view) = state.authorized_vault(vault, &access, &headers) else {
        return workspace_denied();
    };
    if !view.has_any_access().unwrap_or(false) {
        return workspace_denied();
    }
    let folder = vault.template_folder();
    let prefix = format!("{folder}/");
    let templates = match view.notes() {
        Ok(notes) => notes
            .into_iter()
            .filter(|path| path.starts_with(&prefix) && path.ends_with(".md"))
            .map(|path| TemplateSummary {
                name: path
                    .trim_start_matches(&prefix)
                    .trim_end_matches(".md")
                    .to_string(),
                path,
            })
            .collect(),
        Err(_) => return workspace_denied(),
    };
    let body = match serde_json::to_string(&TemplateIndexResponse { folder, templates }) {
        Ok(body) => body,
        Err(error) => return server_error(&Error::Config(error.to_string())),
    };
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response()
}

/// `GET /api/v1/vaults/{slug}/templates/{template}` — one readable template body.
async fn template_content(
    State(state): State<Arc<AppState>>,
    AxumPath((slug, template)): AxumPath<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let Some(vault) = state.vault(&slug) else {
        return workspace_denied();
    };
    let Some(access) = state.access_for(vault.slug()) else {
        return workspace_denied();
    };
    let Some(view) = state.authorized_vault(vault, &access, &headers) else {
        return workspace_denied();
    };
    let path = format!("{}/{}", vault.template_folder(), template);
    let Ok(resolved) = view.resolve(&path) else {
        return workspace_denied();
    };
    if !path.ends_with(".md") {
        return workspace_denied();
    }
    match std::fs::read_to_string(resolved) {
        Ok(body) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            body,
        )
            .into_response(),
        Err(_) => workspace_denied(),
    }
}

/// Lists the effective custom emoji entries for a readable vault.
async fn vault_emoji(
    State(state): State<Arc<AppState>>,
    AxumPath(slug): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    let Some(vault) = state.vault(&slug) else {
        return workspace_denied();
    };
    let Some(access) = state.access_for(vault.slug()) else {
        return workspace_denied();
    };
    let Some(view) = state.authorized_vault(vault, &access, &headers) else {
        return workspace_denied();
    };
    let shared = shared_emoji_root(&state);
    match view.emoji_entries(shared.as_deref()) {
        Ok(entries) => Json(entries).into_response(),
        Err(_) => workspace_denied(),
    }
}

/// Installs a vault-local pack. Vault-wide emoji administration belongs to owners, not editors.
async fn vault_emoji_upload(
    State(state): State<Arc<AppState>>,
    AxumPath((slug, pack)): AxumPath<(String, String)>,
    headers: HeaderMap,
    body: String,
) -> Response {
    let Some(vault) = state.vault(&slug) else {
        return workspace_denied();
    };
    let Some(access) = state.access_for(vault.slug()) else {
        return workspace_denied();
    };
    let Some(view) = state.authorized_vault(vault, &access, &headers) else {
        return workspace_denied();
    };
    if !view.is_owner() {
        return workspace_denied();
    }
    let Ok(upload) = serde_json::from_str::<crate::emoji::Upload>(&body) else {
        return emoji_upload_error(StatusCode::BAD_REQUEST);
    };
    let root = vault
        .root()
        .join(".memberberry")
        .join("emoji")
        .join("packs");
    emoji_upload_response(crate::emoji::install(&root, &pack, upload))
}

/// Installs a server-shared pack. This is the one emoji operation requiring server admin.
async fn shared_emoji_upload(
    State(state): State<Arc<AppState>>,
    AxumPath(pack): AxumPath<String>,
    headers: HeaderMap,
    body: String,
) -> Response {
    if !state.is_server_admin(&headers) {
        return workspace_denied();
    }
    let Some(data_dir) = state.data_dir.as_ref() else {
        return emoji_upload_error(StatusCode::SERVICE_UNAVAILABLE);
    };
    let Ok(upload) = serde_json::from_str::<crate::emoji::Upload>(&body) else {
        return emoji_upload_error(StatusCode::BAD_REQUEST);
    };
    let root = data_dir.join("emoji").join("packs");
    emoji_upload_response(crate::emoji::install(&root, &pack, upload))
}

fn emoji_upload_response(result: Result<(), crate::emoji::Error>) -> Response {
    match result {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(crate::emoji::Error::Conflict(_)) => emoji_upload_error(StatusCode::CONFLICT),
        Err(crate::emoji::Error::Invalid { .. }) => emoji_upload_error(StatusCode::BAD_REQUEST),
        Err(crate::emoji::Error::Io { .. }) => {
            emoji_upload_error(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

fn emoji_upload_error(status: StatusCode) -> Response {
    status.into_response()
}

/// Serves one custom emoji image only after the caller passes the vault ACL.
async fn vault_emoji_asset(
    State(state): State<Arc<AppState>>,
    AxumPath((slug, asset)): AxumPath<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let Some(vault) = state.vault(&slug) else {
        return workspace_denied();
    };
    let Some(access) = state.access_for(vault.slug()) else {
        return workspace_denied();
    };
    let Some(view) = state.authorized_vault(vault, &access, &headers) else {
        return workspace_denied();
    };
    let mut components = asset.split('/');
    let Some(pack) = components.next() else {
        return workspace_denied();
    };
    let Some(file) = components.next() else {
        return workspace_denied();
    };
    if components.next().is_some() || pack.is_empty() || file.is_empty() {
        return workspace_denied();
    }
    let shared = shared_emoji_root(&state);
    let entries = match view.emoji_entries(shared.as_deref()) {
        Ok(entries) => entries,
        Err(_) => return workspace_denied(),
    };
    let Some(entry) = entries
        .iter()
        .find(|entry| entry.pack == pack && entry.file == file)
    else {
        return workspace_denied();
    };
    let Ok(path) = entry.path.join(&entry.file).canonicalize() else {
        return workspace_denied();
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return workspace_denied();
    };
    let content_type = match path.extension().and_then(|extension| extension.to_str()) {
        Some("gif") => "image/gif",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("png") => "image/png",
        _ => return workspace_denied(),
    };
    ([(header::CONTENT_TYPE, content_type)], bytes).into_response()
}

fn shared_emoji_root(state: &AppState) -> Option<PathBuf> {
    state
        .data_dir
        .as_ref()
        .map(|directory| directory.join("emoji").join("packs"))
}

#[derive(serde::Serialize)]
struct BacklinksResponse {
    /// The canonical identity the backlinks were resolved for, so the client can tell that
    /// its request for `[[Roadmap]]` landed on `Projects/Roadmap.md`.
    note: String,
    sources: Vec<BacklinkSource>,
    /// Notes whose text names this one without linking to it (§9.5). Never overlaps
    /// `sources`: a note that links here is a backlink, and listing it in both would make
    /// the panel report the same relationship twice.
    mentions: Vec<MentionSource>,
}

#[derive(serde::Serialize)]
struct BacklinkSource {
    path: String,
    title: Option<String>,
    links: Vec<BacklinkEntry>,
}

#[derive(serde::Serialize)]
struct MentionSource {
    path: String,
    title: Option<String>,
    contexts: Vec<String>,
}

/// How many mentioning *blocks* one response may carry.
///
/// A cap rather than a page, because the panel is a sidebar and not a result list: a note
/// called `Notes` matches a large fraction of a vault, and the honest answer to that is a
/// bounded list plus §14.3's search pane, not scrolling. §9.5 records the limit.
const MAX_MENTIONS: usize = 50;

#[derive(serde::Serialize)]
struct BacklinkEntry {
    context: Option<String>,
    source_block: Option<String>,
    embed: bool,
    /// `none`, `heading` or `block` — the same vocabulary as `links.anchor_kind` (§9.1).
    anchor_kind: &'static str,
    anchor: Option<String>,
    target_raw: String,
}

/// `GET /api/v1/vaults/{slug}/backlinks/{note}` — inbound links and unlinked mentions (§9.5).
///
/// Enforcement point **E8**. Three filters, and it is worth knowing which one does what:
/// `authorized_vault` establishes that this user may read the *target* at all (E1), the
/// index [`Reader`](mb_index::Reader) is constructed from the live ACL so the *sources* are
/// filtered server-side (E5), and link resolution runs against readable candidates only, so
/// an edge into a note this user cannot read does not exist (E9).
///
/// Mentions come from the same reader and are therefore under the same three filters, with
/// the readable set entering the Tantivy query as a required clause rather than filtering
/// its results (§14.1). They leak more than a backlink would if they were unfiltered: a
/// mention carries a *sentence* from the mentioning note, not just its title.
///
/// A target the user cannot read answers exactly as a missing one does — the empty-handed
/// `workspace_denied`, not an empty list, because an empty list confirms the note exists.
async fn note_backlinks(
    State(state): State<Arc<AppState>>,
    AxumPath((slug, note)): AxumPath<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let Some(vault) = state.vault(&slug) else {
        return workspace_denied();
    };
    let Some(access) = state.access_for(vault.slug()) else {
        return workspace_denied();
    };
    let Some(user) = state.vault_user(vault.slug(), &headers) else {
        return workspace_denied();
    };
    let view = AuthorizedVault::new(vault, &access, user.clone());
    let Ok(identity) = view.identity(&note) else {
        return workspace_denied();
    };
    let Some(index) = state.indexes.get(vault) else {
        return server_error(&Error::Config("no index for this vault".to_string()));
    };
    let Ok(mut index) = index.lock() else {
        return server_error(&Error::Config("the index lock is poisoned".to_string()));
    };
    let found = index.reader(&access, &user).and_then(|reader| {
        let sources = reader.backlinks(&identity)?;
        let mentions = reader.unlinked_mentions(&identity, MAX_MENTIONS)?;
        Ok((sources, mentions))
    });
    let (sources, mentions) = match found {
        Ok(found) => found,
        Err(error) => return server_error(&Error::Config(error.to_string())),
    };

    let body = BacklinksResponse {
        note: identity,
        sources: sources
            .into_iter()
            .map(|group| BacklinkSource {
                path: group.path,
                title: group.title,
                links: group.links.into_iter().map(entry_of).collect(),
            })
            .collect(),
        mentions: mentions
            .into_iter()
            .map(|group| MentionSource {
                path: group.path,
                title: group.title,
                contexts: group.contexts,
            })
            .collect(),
    };
    let body = match serde_json::to_string(&body) {
        Ok(body) => body,
        Err(error) => return server_error(&Error::Config(error.to_string())),
    };
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json"),
            // Note titles and note text. Nothing should keep a copy.
            (header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response()
}

#[derive(serde::Deserialize)]
struct GraphQuery {
    /// How far to walk, 1–3 (§9.4). Clamped by `mb-index` rather than rejected: a bad value
    /// in a sidebar control is a picture the user did not ask for, not an error to show them.
    #[serde(default)]
    hops: Option<u8>,
}

#[derive(serde::Serialize)]
struct GraphResponse {
    /// The canonical identity the graph was drawn for, so the client can tell that its
    /// request for `Roadmap` landed on `Projects/Roadmap.md`.
    note: String,
    /// The walk actually performed, after clamping — the control shows this, not what it
    /// asked for.
    hops: u8,
    /// Whether the node cap cut the neighbourhood short (§9.4's "showing 2,000 of 10,431").
    truncated: bool,
    nodes: Vec<GraphNodeEntry>,
    edges: Vec<GraphEdgeEntry>,
}

#[derive(serde::Serialize)]
struct GraphNodeEntry {
    /// `n:<path>` or `g:<name>` — unique in this graph, and what an edge names.
    key: String,
    /// `None` for a ghost, which has no note behind it (§6.5 makes unreadable and absent
    /// one state, so the client is not told which it is looking at).
    path: Option<String>,
    label: String,
    hop: u8,
}

#[derive(serde::Serialize)]
struct GraphEdgeEntry {
    source: String,
    target: String,
    embed: bool,
}

/// `GET /api/v1/vaults/{slug}/graph/{note}` — the local graph (§9.4).
///
/// Enforcement point **E9**, and the same three filters as [`note_backlinks`]: membership
/// plus a readable origin through `AuthorizedVault` (E1), a `Reader` built from the live
/// ACL so every node comes from the readable set (E5), and resolution against readable
/// candidates only — so an edge into a note this caller cannot see is never formed.
///
/// What that leaves is a **ghost**: a link whose target resolves to nothing. §6.5 requires
/// an unreadable note and one nobody has written to be the same state, so they are the same
/// node, carrying the name the *source* note spells — text the caller can already read,
/// since an unreadable source has no node at all.
///
/// An origin the caller cannot read answers exactly as a missing one does.
async fn note_graph(
    State(state): State<Arc<AppState>>,
    AxumPath((slug, note)): AxumPath<(String, String)>,
    Query(query): Query<GraphQuery>,
    headers: HeaderMap,
) -> Response {
    let Some(vault) = state.vault(&slug) else {
        return workspace_denied();
    };
    let Some(access) = state.access_for(vault.slug()) else {
        return workspace_denied();
    };
    let Some(user) = state.vault_user(vault.slug(), &headers) else {
        return workspace_denied();
    };
    let view = AuthorizedVault::new(vault, &access, user.clone());
    let Ok(identity) = view.identity(&note) else {
        return workspace_denied();
    };
    let Some(index) = state.indexes.get(vault) else {
        return server_error(&Error::Config("no index for this vault".to_string()));
    };
    let Ok(mut index) = index.lock() else {
        return server_error(&Error::Config("the index lock is poisoned".to_string()));
    };
    let hops = query.hops.unwrap_or(1).clamp(1, mb_index::MAX_HOPS);
    let graph = match index
        .reader(&access, &user)
        .and_then(|reader| reader.neighbourhood(&identity, hops))
    {
        Ok(graph) => graph,
        Err(error) => return server_error(&Error::Config(error.to_string())),
    };

    json_no_store(&GraphResponse {
        note: identity,
        hops,
        truncated: graph.truncated,
        nodes: graph
            .nodes
            .into_iter()
            .map(|node| GraphNodeEntry {
                key: node.key,
                path: node.path,
                label: node.label,
                hop: node.hop,
            })
            .collect(),
        edges: graph
            .edges
            .into_iter()
            .map(|edge| GraphEdgeEntry {
                source: edge.source,
                target: edge.target,
                embed: edge.embed,
            })
            .collect(),
    })
}

#[derive(serde::Deserialize)]
struct VaultGraphQuery {
    /// The most nodes to draw, highest degree first — §9.4's "showing 2,000 of 10,431".
    ///
    /// Absent means as many as `mb-index` will give, which is `MAX_VAULT_GRAPH`. The client
    /// chooses it because the cap is a device question: §9.4 caps the *phone* honestly, and
    /// which device is asking is not something the server should be inferring from a header.
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(serde::Serialize)]
struct VaultGraphResponse {
    /// How many nodes the readable vault has, before the cap.
    total: usize,
    truncated: bool,
    nodes: Vec<VaultNodeEntry>,
    /// Edges as flat triples: source index, target index, `1` for an embed and `0` for a
    /// link — indices into `nodes` rather than keys.
    ///
    /// why: this is the one payload in the project written for size rather than for reading.
    /// A vault of ten thousand notes carries tens of thousands of edges, and as objects
    /// naming their endpoints by key that is megabytes of repeated path strings; as triples
    /// it is a few hundred kilobytes that the client reads straight into a `Uint32Array` and
    /// transfers to the layout worker without allocating an object per edge (§21.2's graph
    /// row, and §21.3's rule about the main thread). The cost is a format that has to be
    /// validated rather than trusted, which `web/src/shell/vault-graph.ts` does.
    edges: Vec<u32>,
}

#[derive(serde::Serialize)]
struct VaultNodeEntry {
    /// `n:<path>` or `g:<name>` — unique in this graph, and what an edge's index names.
    key: String,
    /// `None` for a ghost, which has no note behind it (§6.5).
    path: Option<String>,
    label: String,
    /// The note's frontmatter `icon` (§4.2), drawn on the node above §9.4's zoom threshold.
    icon: Option<String>,
    /// Edges touching this node in the whole vault, not in the drawn picture (§9.4).
    degree: u32,
    /// Words in the note, `0` for a ghost — §9.4's other node size.
    words: u32,
    /// `YYYY-MM-DD` for the creation scrubber, or `None` when the note says nothing.
    created: Option<String>,
    /// The note's full tags, folded — a prefix filter is a string prefix on the client.
    tags: Vec<String>,
}

/// `GET /api/v1/vaults/{slug}/graph` — the whole-vault graph (§9.4).
///
/// Enforcement point **E9**, and the same story as [`note_graph`] with one difference worth
/// stating: there is no note in the path, so there is nothing to resolve and nothing whose
/// absence could be informative. Membership is checked by [`vault_query`] and the readable
/// set does the rest — a member who may read nothing gets an empty graph, which is what a
/// vault of notes they cannot read looks like from where they stand (§6.5).
///
/// The cap is honest rather than silent: `total` is the readable node count *before* it, so
/// the picture can say "showing 2,000 of 10,431" — a count over the readable set, never over
/// the vault.
async fn vault_graph(
    State(state): State<Arc<AppState>>,
    AxumPath(slug): AxumPath<String>,
    Query(query): Query<VaultGraphQuery>,
    headers: HeaderMap,
) -> Response {
    let Some((access, user, index)) = vault_query(&state, &slug, &headers) else {
        return workspace_denied();
    };
    let Ok(mut index) = index.lock() else {
        return server_error(&Error::Config("the index lock is poisoned".to_string()));
    };
    let graph = match index
        .reader(&access, &user)
        .and_then(|reader| reader.vault_graph(query.limit))
    {
        Ok(graph) => graph,
        Err(error) => return server_error(&Error::Config(error.to_string())),
    };

    let positions: HashMap<&str, u32> = graph
        .nodes
        .iter()
        .enumerate()
        .filter_map(|(at, node)| u32::try_from(at).ok().map(|at| (node.key.as_str(), at)))
        .collect();
    let mut edges: Vec<u32> = Vec::with_capacity(graph.edges.len() * 3);
    for edge in &graph.edges {
        // why: by construction both ends are nodes — `mb-index` builds an edge's endpoints
        // out of the node set itself and a property test holds it. Dropping rather than
        // asserting because the wire format cannot express a dangling index: an edge naming
        // a node that is not there would be read as an edge to whichever node landed at that
        // position, which is worse than a missing line.
        let (Some(source), Some(target)) = (
            positions.get(edge.source.as_str()),
            positions.get(edge.target.as_str()),
        ) else {
            continue;
        };
        edges.extend_from_slice(&[*source, *target, u32::from(edge.embed)]);
    }

    json_no_store(&VaultGraphResponse {
        total: graph.total,
        truncated: graph.truncated,
        nodes: graph
            .nodes
            .into_iter()
            .map(|node| VaultNodeEntry {
                key: node.key,
                path: node.path,
                label: node.label,
                icon: node.icon,
                degree: node.degree,
                words: node.words,
                created: node.created,
                tags: node.tags,
            })
            .collect(),
        edges,
    })
}

#[derive(serde::Serialize)]
struct TagIndexResponse {
    tags: Vec<TagEntry>,
}

#[derive(serde::Serialize)]
struct TagEntry {
    /// The prefix as somebody wrote it — the spelling most notes use (§9.3).
    tag: String,
    /// Its folded form, which is the tag's identity and what the notes route is asked by.
    key: String,
    /// How many readable notes carry this tag or one nested under it.
    notes: usize,
}

#[derive(serde::Serialize)]
struct TaggedNotesResponse {
    /// The prefix this answers for, echoed exactly as it was asked.
    ///
    /// why: echoed rather than normalized. Matching is case- and composition-insensitive and
    /// `mb-index` owns that rule (§9.3); folding the echo here would be a second copy of it,
    /// and a second copy is a second answer the day one of them changes.
    tag: String,
    notes: Vec<TaggedNote>,
}

#[derive(serde::Serialize)]
struct TaggedNote {
    path: String,
    title: Option<String>,
}

/// What the client asks a rename to do. `kind` decides which of §6.6's two mechanisms runs.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum RenameRequest {
    /// `from` is anything a link can name; `to` is a vault-relative path ending in `.md`.
    Note { from: String, to: String },
    /// `from` is a tag or a tag prefix; every tag nested under it moves with it (§9.3).
    Tag { from: String, to: String },
}

#[derive(Debug, serde::Serialize)]
struct RenameResponse {
    /// The new path, or the new tag.
    to: String,
    /// Readable notes whose references were rewritten — see the note on counts below.
    notes: usize,
    /// References rewritten in those notes.
    references: usize,
}

/// `POST /api/v1/vaults/{slug}/rename` — rename a note or a tag, links included (§6.6).
///
/// Enforcement point **E14**, and the only route whose work reaches outside the caller's
/// readable set. `rename.rs` argues why that is allowed and what keeps it contained; the
/// three things this route is responsible for are:
///
/// - **One denial.** A vault the caller is not in, a note they cannot read, a note that is
///   not there and a note they may read but not write are one `404` with an empty body —
///   the same `workspace_denied` every other content route answers with (§6.5).
/// - **The counts are the caller's own.** `notes` and `references` count only notes this
///   caller can read. The rewrite may well have touched more; how many more is a fact about
///   notes that do not exist for them, so it goes to the audit log and not into this reply.
/// - **The work is blocking.** It walks the vault, reads every linking note and sweeps the
///   index twice, so it runs on a blocking thread rather than stalling the runtime.
async fn rename(
    State(state): State<Arc<AppState>>,
    AxumPath(slug): AxumPath<String>,
    headers: HeaderMap,
    Json(request): Json<RenameRequest>,
) -> Response {
    let Some(vault) = state.vault(&slug) else {
        return workspace_denied();
    };
    let Some(access) = state.access_for(vault.slug()) else {
        return workspace_denied();
    };
    let Some(user) = state.vault_user(vault.slug(), &headers) else {
        return workspace_denied();
    };
    let Some(index) = state.indexes.get(vault) else {
        return server_error(&Error::Config("no index for this vault".to_string()));
    };
    let worker = Arc::clone(&state);
    let slug = vault.slug().clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let Some(vault) = worker.vault(slug.as_str()) else {
            return Err(RenameError::Denied);
        };
        let rename = Rename::new(
            vault,
            &access,
            user,
            &index,
            worker.sync_registry(),
            worker.audit_log(),
        );
        match request {
            RenameRequest::Note { from, to } => rename.note(&from, &to),
            RenameRequest::Tag { from, to } => rename.tag(&from, &to),
        }
    })
    .await;
    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(error) => return server_error(&Error::Config(error.to_string())),
    };
    match outcome {
        Ok(renamed) => json_no_store(&RenameResponse {
            to: renamed.to,
            notes: renamed.notes,
            references: renamed.references,
        }),
        Err(RenameError::Denied) => workspace_denied(),
        // The name in these two came from the caller, so repeating it reveals nothing they
        // did not already send.
        Err(error @ (RenameError::InvalidName(_) | RenameError::Exists(_))) => {
            rename_refused(StatusCode::BAD_REQUEST, &error.to_string())
        }
        Err(error @ RenameError::Unverified) => {
            rename_refused(StatusCode::CONFLICT, &error.to_string())
        }
        Err(error) => server_error(&Error::Config(error.to_string())),
    }
}

/// What `POST /api/v1/vaults/{slug}/notes` is asked for: where to put the new note.
#[derive(Deserialize)]
struct CreateNoteRequest {
    /// Vault-relative and ending in `.md`. The client turns a typed name into one.
    path: String,
    #[serde(default)]
    content: Option<String>,
}

/// `POST /api/v1/vaults/{slug}/notes` — creates a note and says where it landed (§6.10, E17).
///
/// The workspace's half of note creation. Its sibling is the form on the vault index page,
/// which exists because this one cannot be reached from a vault with no notes: the shell is
/// only served from a note URL, so a fresh vault has nothing to load it from. Both call the
/// same [`CreateNote`], so there is one enforcement point and not two.
async fn create_note(
    State(state): State<Arc<AppState>>,
    AxumPath(slug): AxumPath<String>,
    headers: HeaderMap,
    Json(request): Json<CreateNoteRequest>,
) -> Response {
    match create_in_vault(
        &state,
        &slug,
        &request.path,
        request.content.as_deref(),
        &headers,
    )
    .await
    {
        Ok(created) => json_no_store(&CreateNoteResponse { path: created.path }),
        Err(CreateError::Denied) => workspace_denied(),
        // Both of these name a string the caller sent us, so echoing it reveals nothing they
        // did not already know — and `Exists` is only reachable once they have proved they
        // may write there, which for `Owner`/`Editor` also means they may read it.
        Err(error @ (CreateError::InvalidName(_) | CreateError::Exists(_))) => {
            rename_refused(StatusCode::BAD_REQUEST, &error.to_string())
        }
        Err(error) => server_error(&Error::Config(error.to_string())),
    }
}

#[derive(serde::Serialize)]
struct CreateNoteResponse {
    path: String,
}

/// The authorization and blocking-work half both create entry points share.
async fn create_in_vault(
    state: &Arc<AppState>,
    slug: &str,
    path: &str,
    content: Option<&str>,
    headers: &HeaderMap,
) -> Result<crate::create::Created, CreateError> {
    let Some(vault) = state.vault(slug) else {
        return Err(CreateError::Denied);
    };
    let Some(access) = state.access_for(vault.slug()) else {
        return Err(CreateError::Denied);
    };
    let Some(user) = state.vault_user(vault.slug(), headers) else {
        return Err(CreateError::Denied);
    };
    let Some(index) = state.indexes.get(vault) else {
        return Err(CreateError::Failed("no index for this vault".to_string()));
    };
    let worker = Arc::clone(state);
    let slug = vault.slug().clone();
    let path = path.to_string();
    let content = content.map(str::to_owned);
    // why: `spawn_blocking`, as `rename` does. This writes a file and then reconciles the
    // index, and doing either on the async runtime's thread stalls every other request.
    let outcome = tokio::task::spawn_blocking(move || {
        let Some(vault) = worker.vault(slug.as_str()) else {
            return Err(CreateError::Denied);
        };
        match content.as_deref() {
            Some(body) => CreateNote::new(vault, &access, user, &index).note_with_body(&path, body),
            None => CreateNote::new(vault, &access, user, &index).note(&path),
        }
    })
    .await;
    match outcome {
        Ok(outcome) => outcome,
        Err(error) => Err(CreateError::Failed(error.to_string())),
    }
}

/// A refusal the caller can act on, as JSON — this route's client is script, not a browser.
fn rename_refused(status: StatusCode, message: &str) -> Response {
    let body = serde_json::json!({ "error": message }).to_string();
    (
        status,
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response()
}

/// `GET /api/v1/vaults/{slug}/tags` — the tag tree with per-node counts (§9.3).
///
/// Enforcement point **E16**. A tag count is a way of asking how many notes exist, so the
/// counts come from the index [`Reader`](mb_index::Reader), built from the live ACL: a tag
/// carried only by notes this user cannot read has no row, and one carried by a readable
/// note and an unreadable one counts the readable note only (§6.5).
///
/// A non-member gets the same empty-handed answer as an unknown vault, rather than an empty
/// tag list that confirms the vault exists.
async fn tag_index(
    State(state): State<Arc<AppState>>,
    AxumPath(slug): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    let Some((access, user, index)) = vault_query(&state, &slug, &headers) else {
        return workspace_denied();
    };
    let Ok(mut index) = index.lock() else {
        return server_error(&Error::Config("the index lock is poisoned".to_string()));
    };
    let tags = match index
        .reader(&access, &user)
        .and_then(|reader| reader.tags())
    {
        Ok(tags) => tags,
        Err(error) => return server_error(&Error::Config(error.to_string())),
    };
    let body = TagIndexResponse {
        tags: tags
            .into_iter()
            .map(|node| TagEntry {
                tag: node.tag,
                key: node.key,
                notes: node.notes,
            })
            .collect(),
    };
    json_no_store(&body)
}

/// `GET /api/v1/vaults/{slug}/tags/{prefix}` — the readable notes under one tag (§9.3).
///
/// Enforcement point **E16**, and the reason selecting a tag node is a server request rather
/// than a filter over a list the client already has: which notes carry a tag is exactly the
/// kind of question §6.5 answers per user. The prefix names a whole subtree, so `project`
/// answers for `#project/memberberry/spec`.
///
/// **Not a search.** §9.3 says selecting a node searches that prefix, and the search index
/// arrives with M9 (§14.1); until then this lists the notes, which is the part of that
/// promise the index can already keep.
async fn tagged_notes(
    State(state): State<Arc<AppState>>,
    AxumPath((slug, prefix)): AxumPath<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let Some((access, user, index)) = vault_query(&state, &slug, &headers) else {
        return workspace_denied();
    };
    let Ok(mut index) = index.lock() else {
        return server_error(&Error::Config("the index lock is poisoned".to_string()));
    };
    let notes = match index
        .reader(&access, &user)
        .and_then(|reader| reader.tagged(&prefix))
    {
        Ok(notes) => notes,
        Err(error) => return server_error(&Error::Config(error.to_string())),
    };
    let body = TaggedNotesResponse {
        tag: prefix,
        notes: notes
            .into_iter()
            .map(|target| TaggedNote {
                path: target.path,
                title: target.title,
            })
            .collect(),
    };
    json_no_store(&body)
}

/// The ACL, user and index a whole-vault query needs, or `None` if it is denied.
///
/// Membership is checked here rather than per note: a question about a vault's tags (E16)
/// or its shape (E9) has no path to resolve, and without this a non-member would learn the
/// vault exists from an empty answer. The readable set does the rest — a member with access
/// to nothing sees nothing, for the same reason they see no notes.
fn vault_query(
    state: &AppState,
    slug: &str,
    headers: &HeaderMap,
) -> Option<(Arc<mb_core::Access>, Username, Arc<Mutex<mb_index::Index>>)> {
    let vault = state.vault(slug)?;
    let access = state.access_for(vault.slug())?;
    let user = state.vault_user(vault.slug(), headers)?;
    let view = AuthorizedVault::new(vault, &access, user.clone());
    if !view.has_any_access().unwrap_or(false) {
        return None;
    }
    let index = state.indexes.get(vault)?;
    Some((access, user, index))
}

/// A JSON body nothing should keep a copy of.
fn json_no_store<T: serde::Serialize>(body: &T) -> Response {
    let body = match serde_json::to_string(body) {
        Ok(body) => body,
        Err(error) => return server_error(&Error::Config(error.to_string())),
    };
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response()
}

const MAX_SEARCH_RESULTS: usize = 100;

#[derive(Deserialize)]
struct TasksQuery {
    folder: Option<String>,
    tag: Option<String>,
    priority: Option<String>,
    due_from: Option<String>,
    due_to: Option<String>,
    note: Option<String>,
    sort: Option<String>,
}

#[derive(serde::Serialize)]
struct TasksResponse {
    tasks: Vec<TaskEntry>,
}

#[derive(serde::Serialize)]
struct TaskEntry {
    path: String,
    title: Option<String>,
    block_id: Option<String>,
    text: String,
    due: Option<String>,
    scheduled: Option<String>,
    start: Option<String>,
    created: Option<String>,
    priority: Option<&'static str>,
    ordinal: usize,
}

/// `GET /api/v1/vaults/{slug}/tasks` — open, readable task rows (§10.3).
///
/// Enforcement point **E18**. Membership is established before opening the index, and the
/// task query is a [`mb_index::Reader`] query over `v_tasks`: the source note, its title and
/// every task field are filtered together rather than returning rows to filter afterward.
async fn vault_tasks(
    State(state): State<Arc<AppState>>,
    AxumPath(slug): AxumPath<String>,
    Query(query): Query<TasksQuery>,
    headers: HeaderMap,
) -> Response {
    let query = match task_query(query) {
        Ok(query) => query,
        Err(message) => return rename_refused(StatusCode::BAD_REQUEST, &message),
    };
    let Some((access, user, index)) = vault_query(&state, &slug, &headers) else {
        return workspace_denied();
    };
    let Ok(mut index) = index.lock() else {
        return server_error(&Error::Config("the index lock is poisoned".to_string()));
    };
    let tasks = match index
        .reader(&access, &user)
        .and_then(|reader| reader.tasks(&query))
    {
        Ok(tasks) => tasks,
        Err(error) => return server_error(&Error::Config(error.to_string())),
    };
    json_no_store(&TasksResponse {
        tasks: tasks
            .into_iter()
            .map(|task| TaskEntry {
                path: task.path,
                title: task.title,
                block_id: task.block_id,
                text: task.text,
                due: task.due,
                scheduled: task.scheduled,
                start: task.start,
                created: task.created,
                priority: task.priority.map(priority_label),
                ordinal: task.ordinal,
            })
            .collect(),
    })
}

fn task_query(query: TasksQuery) -> Result<mb_index::TaskQuery, String> {
    let priority = match query.priority.as_deref() {
        None => None,
        Some("highest") => Some(mb_core::task::Priority::Highest),
        Some("high") => Some(mb_core::task::Priority::High),
        Some("medium") => Some(mb_core::task::Priority::Medium),
        Some("low") => Some(mb_core::task::Priority::Low),
        Some("lowest") => Some(mb_core::task::Priority::Lowest),
        Some(_) => return Err("priority must be highest, high, medium, low or lowest".to_string()),
    };
    let due_from = parse_task_date(query.due_from.as_deref(), "due_from")?;
    let due_to = parse_task_date(query.due_to.as_deref(), "due_to")?;
    if due_from.zip(due_to).is_some_and(|(from, to)| from > to) {
        return Err("due_from must not be after due_to".to_string());
    }
    let sort = match query.sort.as_deref().unwrap_or("due") {
        "due" => mb_index::TaskSort::Due,
        "priority" => mb_index::TaskSort::Priority,
        "created" => mb_index::TaskSort::Created,
        "path" => mb_index::TaskSort::Path,
        _ => return Err("sort must be due, priority, created or path".to_string()),
    };
    Ok(mb_index::TaskQuery {
        folder: query.folder,
        tag: query.tag,
        priority,
        due_from,
        due_to,
        note: query.note,
        sort,
    })
}

fn parse_task_date(
    value: Option<&str>,
    field: &str,
) -> Result<Option<mb_core::task::Date>, String> {
    match value {
        None => Ok(None),
        Some(value) => mb_core::task::Date::parse(value)
            .map(Some)
            .ok_or_else(|| format!("{field} must be a YYYY-MM-DD date")),
    }
}

const fn priority_label(priority: mb_core::task::Priority) -> &'static str {
    match priority {
        mb_core::task::Priority::Highest => "highest",
        mb_core::task::Priority::High => "high",
        mb_core::task::Priority::Medium => "medium",
        mb_core::task::Priority::Low => "low",
        mb_core::task::Priority::Lowest => "lowest",
    }
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    #[serde(default = "default_search_limit")]
    limit: usize,
}

const fn default_search_limit() -> usize {
    20
}

#[derive(serde::Serialize)]
struct SearchResponse {
    hits: Vec<SearchEntry>,
}

#[derive(serde::Serialize)]
struct SearchEntry {
    path: String,
    title: Option<String>,
    context: String,
    score: f32,
}

/// One segment in a reader's current offline-search manifest (§14.2, E6).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchSegmentManifestEntry {
    zone_id: String,
    acl_hash: String,
}

/// The complete permission-filtered offline-search manifest.
#[derive(serde::Serialize)]
struct SearchSegmentManifest {
    segments: Vec<SearchSegmentManifestEntry>,
}

#[derive(Deserialize)]
struct SearchSegmentQuery {
    acl_hash: String,
}

/// `GET /api/v1/vaults/{slug}/search/segments` — current permitted compact zones (E6).
///
/// This is a manifest, deliberately not an archive. The browser must first remove every
/// stored zone absent from this list, then fetch the individual bytes. The bytes endpoint
/// repeats the live authorization and epoch check so a policy change between these requests
/// cannot turn a stale manifest into a disclosure.
async fn search_segments(
    State(state): State<Arc<AppState>>,
    AxumPath(slug): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    let Some((access, user, index)) = vault_query(&state, &slug, &headers) else {
        return workspace_denied();
    };
    let Ok(mut index) = index.lock() else {
        return server_error(&Error::Config("the index lock is poisoned".to_string()));
    };
    let reader = match index.reader(&access, &user) {
        Ok(reader) => reader,
        Err(error) => return server_error(&Error::Config(error.to_string())),
    };
    json_no_store(&SearchSegmentManifest {
        segments: reader
            .client_segments()
            .into_iter()
            .map(|segment| SearchSegmentManifestEntry {
                zone_id: segment.zone_id,
                acl_hash: segment.acl_hash,
            })
            .collect(),
    })
}

/// `GET /api/v1/vaults/{slug}/search/segments/{zone}?acl_hash=…` — one compact zone (E6).
///
/// Enforcement point **E6**. The expected ACL hash is part of the request so a manifest
/// captured before a revocation cannot retrieve a replacement epoch under the old identity.
async fn search_segment(
    State(state): State<Arc<AppState>>,
    AxumPath((slug, zone_id)): AxumPath<(String, String)>,
    Query(query): Query<SearchSegmentQuery>,
    headers: HeaderMap,
) -> Response {
    let Some((access, user, index)) = vault_query(&state, &slug, &headers) else {
        return workspace_denied();
    };
    let Ok(mut index) = index.lock() else {
        return server_error(&Error::Config("the index lock is poisoned".to_string()));
    };
    let segment = match index.reader(&access, &user) {
        Ok(reader) => reader
            .client_segments()
            .into_iter()
            .find(|segment| segment.zone_id == zone_id && segment.acl_hash == query.acl_hash),
        Err(error) => return server_error(&Error::Config(error.to_string())),
    };
    let Some(segment) = segment else {
        return workspace_denied();
    };
    (
        StatusCode::OK,
        [
            (
                header::CONTENT_TYPE,
                "application/vnd.memberberry.search-index;version=1",
            ),
            (header::CACHE_CONTROL, "no-store"),
        ],
        segment.bytes,
    )
        .into_response()
}

/// `GET /api/v1/vaults/{slug}/search?q=…` — server-side Tantivy search (§14.1).
///
/// Enforcement point **E5**. Membership is established before the index is opened, then
/// [`mb_index::Reader::search`] intersects the Tantivy query with the live readable set as
/// a required term query. No result is fetched and filtered after authorization.
async fn search_notes(
    State(state): State<Arc<AppState>>,
    AxumPath(slug): AxumPath<String>,
    Query(query): Query<SearchQuery>,
    headers: HeaderMap,
) -> Response {
    let Some((access, user, index)) = vault_query(&state, &slug, &headers) else {
        return workspace_denied();
    };
    let Ok(mut index) = index.lock() else {
        return server_error(&Error::Config("the index lock is poisoned".to_string()));
    };
    let hits = match index
        .reader(&access, &user)
        .and_then(|reader| reader.search(&query.q, query.limit.min(MAX_SEARCH_RESULTS)))
    {
        Ok(hits) => hits,
        Err(mb_index::Error::Query(error)) => {
            return rename_refused(StatusCode::BAD_REQUEST, &error.to_string());
        }
        Err(error) => return server_error(&Error::Config(error.to_string())),
    };
    json_no_store(&SearchResponse {
        hits: hits
            .into_iter()
            .map(|hit| SearchEntry {
                path: hit.path,
                title: hit.title,
                context: hit.context,
                score: hit.score,
            })
            .collect(),
    })
}

fn entry_of(link: mb_index::Backlink) -> BacklinkEntry {
    let (anchor_kind, anchor) = match link.anchor {
        None => ("none", None),
        Some(mb_core::model::Anchor::Heading(heading)) => ("heading", Some(heading)),
        Some(mb_core::model::Anchor::Block(block)) => ("block", Some(block)),
    };
    BacklinkEntry {
        context: link.context,
        source_block: link.source_block,
        embed: link.embed,
        anchor_kind,
        anchor,
        target_raw: link.target_raw,
    }
}

/// `GET /api/v1/vaults/{slug}/bookmarks` — this user's bookmarked notes (§8.2).
///
/// Enforcement point E15, with a filter the workspace layout does not have: the stored list is
/// read through the authorized vault, so a note whose access was revoked since it was
/// bookmarked leaves the sidebar rather than sitting there as a name the user may no longer
/// see (§6.5). A bookmark list survives for months across ACL changes, which is why it is
/// worth filtering where a short-lived pane layout is not.
async fn bookmarks_load(
    State(state): State<Arc<AppState>>,
    AxumPath(slug): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    let Some(allowed) = authorize_bookmarks(&state, &slug, &headers) else {
        return workspace_denied();
    };
    let Some(view) = state.authorized_vault(allowed.vault, &allowed.access, &headers) else {
        return workspace_denied();
    };
    let readable: Vec<String> = allowed
        .store
        .load(&allowed.user, allowed.vault.slug())
        .into_iter()
        .filter(|path| view.resolve(path).is_ok())
        .collect();

    match serde_json::to_string(&readable) {
        Ok(body) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "application/json"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            body,
        )
            .into_response(),
        Err(error) => server_error(&Error::Config(error.to_string())),
    }
}

/// `PUT /api/v1/vaults/{slug}/bookmarks` — replace this user's bookmarks.
///
/// A path the caller cannot read is refused rather than stored. Otherwise the list becomes a
/// way to record that a note exists, which is the thing §6.5 forbids — and one that would be
/// handed back the moment access was granted.
async fn bookmarks_save(
    State(state): State<Arc<AppState>>,
    AxumPath(slug): AxumPath<String>,
    headers: HeaderMap,
    body: String,
) -> Response {
    let Some(allowed) = authorize_bookmarks(&state, &slug, &headers) else {
        return workspace_denied();
    };
    let Some(view) = state.authorized_vault(allowed.vault, &allowed.access, &headers) else {
        return workspace_denied();
    };
    let Ok(paths) = serde_json::from_str::<Vec<String>>(&body) else {
        return workspace_denied();
    };
    if paths.iter().any(|path| view.resolve(path).is_err()) {
        return workspace_denied();
    }
    match allowed
        .store
        .save(&allowed.user, allowed.vault.slug(), &paths)
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => workspace_denied(),
    }
}

/// What a bookmark request is allowed to touch.
///
/// The ACL is handed back as the `Arc` rather than as an [`AuthorizedVault`]: the view borrows
/// the policy, so building it here would mean returning a reference to a local. The caller
/// constructs the view from `access`, which keeps the borrow where its owner is.
struct BookmarkAccess<'a> {
    user: Username,
    vault: &'a Vault,
    access: Arc<mb_core::Access>,
    store: BookmarkStore<'a>,
}

/// Resolves a bookmark request, or `None` if it is denied (E15).
fn authorize_bookmarks<'a>(
    state: &'a AppState,
    slug: &str,
    headers: &HeaderMap,
) -> Option<BookmarkAccess<'a>> {
    let data_dir = state.data_dir.as_deref()?;
    let vault = state.vault(slug)?;
    let access = state.access_for(vault.slug())?;
    let view = state.authorized_vault(vault, &access, headers)?;
    if !view.has_any_access().unwrap_or(false) {
        return None;
    }
    let user = state
        .authenticated_user(headers)
        .or_else(|| state.api_token_user(vault.slug(), headers))?;
    Some(BookmarkAccess {
        user,
        vault,
        access,
        store: BookmarkStore::new(data_dir),
    })
}

/// `GET /api/v1/vaults/{slug}/workspace/{device}` — this user's saved layout (§8.1).
async fn workspace_load(
    State(state): State<Arc<AppState>>,
    AxumPath((slug, device)): AxumPath<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let Some((user, device, store)) = authorize_workspace(&state, &slug, &device, &headers) else {
        return workspace_denied();
    };
    match store.load(&user, &device) {
        // why: `204`, not `404`. A device that has never saved a layout is the *normal* first
        // visit, and answering it with an error made every fresh page load log a 404 in the
        // console — noise that trains everyone to ignore the one that matters.
        //
        // This does distinguish "member with nothing saved" from "not a member", and that is
        // fine: a caller already knows which vaults they are a member of, because `/` lists
        // them. §6.5 protects what someone cannot see, and this tells them nothing new.
        Ok(None) => StatusCode::NO_CONTENT.into_response(),
        // A layout that cannot be read is treated as absent for the same reason: the client's
        // answer to both is to open a fresh workspace.
        Err(_) => StatusCode::NO_CONTENT.into_response(),
        Ok(Some(layout)) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "application/json"),
                // A layout names notes. Nothing should keep a copy of it.
                (header::CACHE_CONTROL, "no-store"),
            ],
            layout,
        )
            .into_response(),
    }
}

/// `PUT /api/v1/vaults/{slug}/workspace/{device}` — replace this user's saved layout.
async fn workspace_save(
    State(state): State<Arc<AppState>>,
    AxumPath((slug, device)): AxumPath<(String, String)>,
    headers: HeaderMap,
    layout: String,
) -> Response {
    let Some((user, device, store)) = authorize_workspace(&state, &slug, &device, &headers) else {
        return workspace_denied();
    };
    match store.save(&user, &device, &layout) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        // Oversized or unparseable. Neutral, like every other refusal on this route.
        Err(_) => workspace_denied(),
    }
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
        let Some(page) = inject_bootstrap(
            &index,
            vault.slug().as_str(),
            &note,
            user.as_str(),
            vault.media_max_dimension(),
        ) else {
            // why: loud rather than degraded. `str::replace` on an absent marker is a no-op,
            // so a bundle this server does not recognise would ship a page with an empty
            // bootstrap — and the editor would quietly run against a local-only replica
            // instead of syncing, which looks like working software. That is precisely the
            // shape of the M5 asset bug, and an operator with a stale `web_root` deserves to
            // be told rather than to discover it from a user's lost edits.
            return server_error(&Error::Config(format!(
                "{}/index.html does not contain the bootstrap element; the frontend build \
                 does not match this server",
                root.display()
            )));
        };
        return ([(header::CONTENT_SECURITY_POLICY, EDITOR_CSP)], Html(page)).into_response();
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

/// Serves a media object only when a readable note references its exact path (E11).
///
/// The local store validates containment independently of this permission check. The order is
/// intentional: a missing index or unreadable reference is the same neutral 404 as a missing
/// object, so hashes and object existence cannot be used to probe private notes.
async fn media(
    State(state): State<Arc<AppState>>,
    AxumPath((slug, media)): AxumPath<(String, String)>,
    Query(query): Query<MediaQuery>,
    headers: HeaderMap,
) -> Response {
    let Some(vault) = state.vault(&slug) else {
        return not_found().await;
    };
    let Some(access) = state.access_for(vault.slug()) else {
        return not_found().await;
    };
    let Some(user) = state.vault_user(vault.slug(), &headers) else {
        return not_found().await;
    };
    let Some(index) = state.indexes.get(vault) else {
        return not_found().await;
    };
    let referenced = match index.lock() {
        Ok(mut index) => index
            .reader(&access, &user)
            .and_then(|reader| reader.references_media(&media))
            .unwrap_or(false),
        Err(_) => false,
    };
    let staged = state.media_uploads.lock().is_ok_and(|mut uploads| {
        let now = std::time::Instant::now();
        uploads.retain(|_, expires| *expires > now);
        uploads.contains_key(&(vault.slug().clone(), user.clone(), media.clone()))
    });
    let permitted = referenced || staged;
    if !permitted {
        return not_found().await;
    }
    let Ok(store) = crate::media::Store::new(vault) else {
        return not_found().await;
    };
    let Ok(bytes) = store.get(&media).await else {
        return not_found().await;
    };
    let (bytes, content_type) = match query.thumbnail {
        Some(maximum) => match crate::media::thumbnail(&bytes, maximum) {
            Ok(thumbnail) => (thumbnail, "image/webp"),
            Err(_) => return not_found().await,
        },
        None => (bytes, media_content_type(&media)),
    };
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, "private, no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        bytes,
    )
        .into_response()
}

#[derive(Debug, Deserialize)]
struct MediaQuery {
    thumbnail: Option<u32>,
}

/// Uploads one local media object and returns its content-addressed path.
///
/// Uploading does not grant read access: until a readable note references the returned path,
/// the GET route still answers with the neutral 404 required by E11. The filename is metadata
/// only; its extension chooses the display type and the bytes choose the identity.
async fn media_upload(
    State(state): State<Arc<AppState>>,
    AxumPath(slug): AxumPath<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(vault) = state.vault(&slug) else {
        return workspace_denied();
    };
    let Some(access) = state.access_for(vault.slug()) else {
        return workspace_denied();
    };
    let Some(user) = state.vault_user(vault.slug(), &headers) else {
        return workspace_denied();
    };
    let Some(view) = state.authorized_vault(vault, &access, &headers) else {
        return workspace_denied();
    };
    if !view.has_any_write_access().unwrap_or(false) {
        return workspace_denied();
    }
    if body.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            [(header::CONTENT_TYPE, "application/json")],
            r#"{"error":"empty media"}"#,
        )
            .into_response();
    }
    let Some(filename) = headers
        .get("x-memberberry-filename")
        .and_then(|value| value.to_str().ok())
    else {
        return (
            StatusCode::BAD_REQUEST,
            [(header::CONTENT_TYPE, "application/json")],
            r#"{"error":"filename required"}"#,
        )
            .into_response();
    };
    let Some(extension) = filename
        .rsplit('/')
        .next()
        .and_then(|name| name.rsplit_once('.'))
        .map(|(_, extension)| extension)
    else {
        return (
            StatusCode::BAD_REQUEST,
            [(header::CONTENT_TYPE, "application/json")],
            r#"{"error":"filename extension required"}"#,
        )
            .into_response();
    };
    let Some(extension) = crate::media::upload_extension(&body, extension) else {
        return (
            StatusCode::BAD_REQUEST,
            [(header::CONTENT_TYPE, "application/json")],
            r#"{"error":"media bytes and extension must be PNG, JPEG, GIF, WebP, or PDF"}"#,
        )
            .into_response();
    };
    let store = match crate::media::Store::new(vault) {
        Ok(store) => store,
        Err(error) => return server_error(&error),
    };
    let path = match store.put(&body, extension).await {
        Ok(path) => path,
        Err(Error::NotFound) => {
            return (
                StatusCode::BAD_REQUEST,
                [(header::CONTENT_TYPE, "application/json")],
                r#"{"error":"invalid filename extension"}"#,
            )
                .into_response();
        }
        Err(error) => return server_error(&error),
    };
    if let Some(original) = headers
        .get("x-memberberry-original")
        .and_then(|value| value.to_str().ok())
    {
        let staged = state.media_uploads.lock().is_ok_and(|mut uploads| {
            let now = std::time::Instant::now();
            uploads.retain(|_, expires| *expires > now);
            uploads.contains_key(&(vault.slug().clone(), user.clone(), original.to_string()))
        });
        if !staged {
            return (
                StatusCode::BAD_REQUEST,
                [(header::CONTENT_TYPE, "application/json")],
                r#"{"error":"invalid original media"}"#,
            )
                .into_response();
        }
        let Ok(_guard) = state.media_manifest.lock() else {
            return server_error(&Error::MediaStore(
                "media manifest lock poisoned".to_string(),
            ));
        };
        if let Err(error) = crate::media::retain_original(vault, &path, original) {
            return server_error(&error);
        }
    }
    let Ok(mut uploads) = state.media_uploads.lock() else {
        return server_error(&Error::MediaStore(
            "media upload grant lock poisoned".to_string(),
        ));
    };
    uploads.insert(
        (vault.slug().clone(), user, path.clone()),
        std::time::Instant::now() + MEDIA_UPLOAD_GRANT,
    );
    let body = match serde_json::to_string(&serde_json::json!({ "path": path })) {
        Ok(body) => body,
        Err(error) => return server_error(&Error::Config(error.to_string())),
    };
    (
        StatusCode::CREATED,
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response()
}

fn media_content_type(path: &str) -> &'static str {
    match path
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "avif" => "image/avif",
        "gif" => "image/gif",
        "jpeg" | "jpg" => "image/jpeg",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

#[derive(Deserialize)]
struct EmbedQuery {
    /// The note the reference was written in. Only breaks a name collision (§4.3), and is
    /// itself permission-checked: a caller cannot resolve *from* a note they cannot read.
    from: String,
    /// `none`, `heading` or `block` — the `anchor_kind` of the wikilink node (§9.1).
    #[serde(default)]
    anchor_kind: String,
    /// The heading text or `^block-id`, with no leading caret.
    #[serde(default)]
    anchor: String,
}

#[derive(serde::Serialize)]
struct EmbedResponse {
    /// The canonical identity the reference resolved to, so the client can compare it
    /// against the notes already on its resolution stack and stop a cycle (§9.2).
    note: String,
    title: Option<String>,
    /// The slice, as an HTML fragment. Empty when `found` is false.
    html: String,
    /// Whether the anchor named anything. A readable note with no such heading is **not**
    /// a permission boundary, so it does not have to be blurred into one — but it is also
    /// not an empty note, and reporting it as one would be a claim nobody checked (§9.5).
    found: bool,
}

/// `GET /api/v1/vaults/{slug}/embed/{target}` — the content one `![[…]]` stands for (§9.2).
///
/// Enforcement point **E7**, and the same three filters as [`note_backlinks`] with one
/// addition. `authorized_vault` establishes membership (E1); the index
/// [`Reader`](mb_index::Reader) resolves the reference against this user's readable set, so
/// an unreadable target is not a candidate (E9); and the *read* goes back through
/// `AuthorizedVault`, which re-checks the resolved path before touching the file — the
/// index says which note, never that it may be read.
///
/// **Absent and unreadable are one answer.** A target that resolves to nothing and one the
/// caller may not read both get the empty-handed `workspace_denied`, because "no such note"
/// and "not for you" are distinguishable states and §6.5 does not allow them to be. That is
/// also why the client cannot offer to create a missing embed target: it is not told which
/// of the two it is looking at.
///
/// The recursion is deliberately *not* here. This route answers for one reference, and the
/// client mounts one embed inside another — so §9.2's resolution stack lives with the thing
/// that recurses, and this route cannot be made to loop by a crafted note.
async fn note_embed(
    State(state): State<Arc<AppState>>,
    AxumPath((slug, target)): AxumPath<(String, String)>,
    Query(query): Query<EmbedQuery>,
    headers: HeaderMap,
) -> Response {
    let anchor = match anchor_from(&query.anchor_kind, &query.anchor) {
        Ok(anchor) => anchor,
        Err(()) => return workspace_denied(),
    };
    let (vault, resolved, source) =
        match resolve_reference(&state, &slug, &target, &query.from, &headers) {
            Ok(resolution) => resolution,
            Err(response) => return *response,
        };
    let prefix = format!("/v/{}/", vault.slug());
    let urls = Urls {
        note: &prefix,
        media: &prefix,
    };
    let doc = mb_core::parse(&source);
    let slice = mb_core::transclude::slice(&doc, anchor.as_ref());
    let found = slice.is_some();
    let html = slice
        .map(|blocks| mb_core::html::document(&mb_core::model::Document::new(blocks), &urls))
        .unwrap_or_default();

    let body = EmbedResponse {
        note: resolved.path,
        title: resolved.title,
        html,
        found,
    };
    let body = match serde_json::to_string(&body) {
        Ok(body) => body,
        Err(error) => return server_error(&Error::Config(error.to_string())),
    };
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json"),
            // Note content. Nothing between here and the browser should keep a copy, and a
            // cached embed would outlive the permission that allowed it.
            (header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response()
}

/// Resolves one wikilink reference for one caller, or the response to send instead.
///
/// The shared half of **E7** and of wikilink navigation (§8.2): three filters, and the
/// order matters. `AuthorizedVault` establishes membership and that the *source* note is
/// readable (E1) — `from` steers §4.3's nearest-path tie-break, so a caller who could name
/// any folder as their vantage point could learn from the answer which notes live in one
/// they have no access to. The index [`Reader`](mb_index::Reader) then resolves against that
/// caller's readable set, so an unreadable target is not a candidate (E9). And the read goes
/// back through the repository, which re-checks the resolved path before touching the file:
/// the index says *which* note, never that it may be read.
///
/// The source is read even by callers that only want the name, because a resolution nobody
/// can read is not a resolution — and reading it is the only proof of that which does not
/// trust the index.
///
/// Every failure is the empty-handed [`workspace_denied`]: an unknown vault, a non-member, a
/// reference to nothing and a reference to something unreadable are one answer, because
/// §6.5 does not allow them to be distinguishable.
fn resolve_reference<'a>(
    state: &'a Arc<AppState>,
    slug: &str,
    target: &str,
    from: &str,
    headers: &HeaderMap,
) -> Result<(&'a Vault, mb_index::Target, String), Box<Response>> {
    let Some(vault) = state.vault(slug) else {
        return Err(Box::new(workspace_denied()));
    };
    let Some(access) = state.access_for(vault.slug()) else {
        return Err(Box::new(workspace_denied()));
    };
    let Some(user) = state.vault_user(vault.slug(), headers) else {
        return Err(Box::new(workspace_denied()));
    };
    let view = AuthorizedVault::new(vault, &access, user.clone());
    let Ok(from) = view.identity(from) else {
        return Err(Box::new(workspace_denied()));
    };
    let Some(index) = state.indexes.get(vault) else {
        return Err(Box::new(server_error(&Error::Config(
            "no index for this vault".to_string(),
        ))));
    };
    let Ok(mut index) = index.lock() else {
        return Err(Box::new(server_error(&Error::Config(
            "the index lock is poisoned".to_string(),
        ))));
    };
    let resolved = match index
        .reader(&access, &user)
        .and_then(|reader| reader.resolve(&from, target))
    {
        Ok(Some(resolved)) => resolved,
        Ok(None) => return Err(Box::new(workspace_denied())),
        Err(error) => {
            return Err(Box::new(server_error(&Error::Config(error.to_string()))));
        }
    };
    drop(index);
    let Ok(source) = view.read(&resolved.path) else {
        return Err(Box::new(workspace_denied()));
    };
    Ok((vault, resolved, source))
}

#[derive(Deserialize)]
struct ResolveQuery {
    /// The note the reference was written in — see [`resolve_reference`].
    from: String,
}

#[derive(serde::Serialize)]
struct ResolveResponse {
    /// The canonical identity, which is what a tab is keyed by and what a sync room is
    /// named by. Opening a tab on the *name* instead would give one note two tabs.
    note: String,
    title: Option<String>,
}

/// `GET /api/v1/vaults/{slug}/resolve/{target}` — which note a wikilink means (§4.3, §8.2).
///
/// Enforcement point **E7/E9**, through [`resolve_reference`]. Separate from the embed route
/// because following a link needs the *name* and not the content: the answer is two strings,
/// and a client that had to fetch a rendered note to find out where a link goes would fetch
/// one on every click.
///
/// Resolution cannot happen on the client. §4.3 resolves a name collision by nearest path
/// among the notes the asking user may read, so the answer differs per user — which is E9,
/// and is the reason there is a route here at all rather than a lookup in the note index the
/// quick switcher already holds.
async fn note_resolve(
    State(state): State<Arc<AppState>>,
    AxumPath((slug, target)): AxumPath<(String, String)>,
    Query(query): Query<ResolveQuery>,
    headers: HeaderMap,
) -> Response {
    let (_, resolved, _) = match resolve_reference(&state, &slug, &target, &query.from, &headers) {
        Ok(resolution) => resolution,
        Err(response) => return *response,
    };
    let body = ResolveResponse {
        note: resolved.path,
        title: resolved.title,
    };
    let body = match serde_json::to_string(&body) {
        Ok(body) => body,
        Err(error) => return server_error(&Error::Config(error.to_string())),
    };
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json"),
            // A note title, filtered per user. Nothing should keep a copy.
            (header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response()
}

/// The `anchor_kind`/`anchor` pair as the model's `Option<Anchor>`.
///
/// `Err` for a pair that cannot exist: `schema.json` requires `none` to carry no text and
/// every other kind to carry some, and a request that breaks that is a client bug or a
/// probe rather than a state to guess at.
fn anchor_from(kind: &str, anchor: &str) -> Result<Option<mb_core::model::Anchor>, ()> {
    match (kind, anchor) {
        ("" | "none", "") => Ok(None),
        ("heading", text) if !text.is_empty() => {
            Ok(Some(mb_core::model::Anchor::Heading(text.to_string())))
        }
        ("block", text) if !text.is_empty() => {
            Ok(Some(mb_core::model::Anchor::Block(text.to_string())))
        }
        _ => Err(()),
    }
}

/// The element Vite's `index.html` carries for this server to fill in.
///
/// An exact string rather than a parse: the file is generated by our own build, the marker is
/// commented in `web/index.html` as belonging to the server, and a missing one is an error
/// rather than something to recover from. Pulling in an HTML parser to find one known element
/// would be a dependency on the critical path for no gain (§21.2).
const BOOTSTRAP_MARKER: &str =
    "<div id=\"app\" data-vault=\"\" data-note=\"\" data-user=\"\"></div>";

/// Fills the bootstrap element in, or `None` if this bundle has no such element.
///
/// The note's body is deliberately absent (`SPEC.md` §3.3): content reaches the browser over
/// the CRDT and nowhere else, so this page is never a second source of truth for it.
fn inject_bootstrap(
    index: &str,
    vault: &str,
    note: &str,
    user: &str,
    media_max_dimension: u32,
) -> Option<String> {
    if !index.contains(BOOTSTRAP_MARKER) {
        return None;
    }
    // why: a note path is a filename, and a filename may legally contain a double quote.
    // Interpolated raw, `data-note` closes its own attribute and the rest of the name becomes
    // markup — stored XSS authored by anyone who can write a file into the vault. Every
    // attribute goes through the same escape the server-rendered path uses.
    let mut element = String::from("<div id=\"app\" data-vault=\"");
    push_escaped_attr(&mut element, vault);
    element.push_str("\" data-note=\"");
    push_escaped_attr(&mut element, note);
    element.push_str("\" data-user=\"");
    push_escaped_attr(&mut element, user);
    element.push_str("\" data-media-max-dimension=\"");
    element.push_str(&media_max_dimension.to_string());
    element.push_str("\"></div>");
    Some(index.replace(BOOTSTRAP_MARKER, &element))
}

/// The policy for the one page that runs JavaScript.
///
/// The server-rendered pages get `default-src 'none'` and nothing else because they need
/// nothing else. This page needs a real policy, and it went out through M5 with none at all
/// — the one page with a script, a WebSocket and untrusted note content in it.
///
/// Each allowance is here because something breaks without it, and the E2E suite is what
/// says so: `'wasm-unsafe-eval'` for instantiating `mb-wasm` (§5.2), `'unsafe-inline'` under
/// `style-src` because ProseMirror and the presence decorations set `style` attributes on
/// elements, `blob:` for images the editor creates locally and for the workers §21.3 puts
/// long work on. `object-src 'self'` permits only the inline PDF viewer's authenticated
/// same-origin object; user-authored HTML never reaches the editor DOM. `connect-src 'self'`
/// covers the sync socket: a same-origin `ws://` is
/// `'self'` under CSP3. **`form-action 'none'`** is safe here and only here — this page has
/// no form; putting it on the sign-in page is what broke logging in during M5.
const EDITOR_CSP: &str = "default-src 'none'; \
     script-src 'self' 'wasm-unsafe-eval'; \
     manifest-src 'self'; \
     style-src 'self' 'unsafe-inline'; \
     img-src 'self' data: blob:; \
     object-src 'self'; \
     font-src 'self'; \
     connect-src 'self'; \
     worker-src 'self' blob:; \
     base-uri 'none'; \
     form-action 'none'; \
     frame-ancestors 'none'";

/// The unbootstrapped application shell, for a navigation the network cannot answer (§7.4).
///
/// The Vite `index.html` verbatim: the same bytes served for a note page, with the bootstrap
/// element still empty. The service worker precaches it and answers `/v/<vault>/<note>` with
/// it while offline, and the client works out which note it is from the URL.
///
/// **Served without authentication, deliberately.** It carries no vault data — it is the
/// public bundle's HTML, whose script and stylesheet are already public under `/assets/`.
/// Gating it would add a failure mode without closing anything: the service worker fetches
/// it during install, so an expired session would leave a browser with no offline shell and
/// no way to notice.
async fn app_shell(State(state): State<Arc<AppState>>) -> Response {
    let Some(body) = web_root_file(&state, "index.html") else {
        return not_found().await;
    };
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            // `no-cache` rather than a max-age: the shell is not content-addressed, and a
            // browser holding an old one holds a page that asks for chunks a later build
            // deleted. Revalidation is one conditional request per navigation, and the
            // service worker is what makes those rare.
            (header::CACHE_CONTROL, "no-cache"),
            (header::CONTENT_SECURITY_POLICY, EDITOR_CSP),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        Html(body),
    )
        .into_response()
}

/// The service worker (§7.4), which `web/scripts/build-sw.ts` emits into the build root.
///
/// `no-cache` matters more here than anywhere else: this file is how a browser learns that
/// a new build exists, so an HTTP cache answering for it pins that browser to one version's
/// precache list. The client asks for the same thing from its side with
/// `updateViaCache: "none"`; both, because either alone is one configuration away from a
/// user stuck on last month's bundle.
async fn service_worker(State(state): State<Arc<AppState>>) -> Response {
    let Some(body) = web_root_file(&state, "sw.js") else {
        return not_found().await;
    };
    (
        [
            (header::CONTENT_TYPE, "text/javascript; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
            // Scope is `/` by default for a worker served from the root; the header is what
            // keeps that true if the file ever moves.
            (HeaderName::from_static("service-worker-allowed"), "/"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        body,
    )
        .into_response()
}

/// The installable-application manifest (§7.4).
///
/// Unauthenticated because a browser fetches a manifest anonymously — the request omits
/// credentials — so an authenticated route here would 404 on every page load. It contains
/// the application's name and icon and nothing about any vault.
async fn web_manifest(State(state): State<Arc<AppState>>) -> Response {
    let Some(body) = web_root_file(&state, "manifest.webmanifest") else {
        return not_found().await;
    };
    (
        [
            (header::CONTENT_TYPE, "application/manifest+json"),
            (header::CACHE_CONTROL, "public, max-age=3600"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        body,
    )
        .into_response()
}

/// The application icon, referenced by both the page and the manifest.
async fn app_icon(State(state): State<Arc<AppState>>) -> Response {
    let Some(body) = web_root_file(&state, "icon.svg") else {
        return not_found().await;
    };
    (
        [
            (header::CONTENT_TYPE, "image/svg+xml"),
            (header::CACHE_CONTROL, "public, max-age=3600"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        body,
    )
        .into_response()
}

/// Reads one named file from the build root, or `None` if there is no build root.
///
/// `name` is a literal at every call site, which is what makes this safe without a
/// containment check: there is no caller-supplied path component to escape with. Anything
/// user-named goes through `asset`, which canonicalizes and checks containment.
fn web_root_file(state: &AppState, name: &str) -> Option<String> {
    let root = state.web_root.as_ref()?;
    std::fs::read_to_string(root.join(name)).ok()
}

async fn asset(
    State(state): State<Arc<AppState>>,
    AxumPath(asset): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
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
    // why: compressed here rather than by the `compress` layer, which would otherwise gzip
    // the same immutable 945 KB WebAssembly module for every visitor. Measured: 31.5 ms at
    // level 9 against 0.6 ms to serve it from cache, and level 9 is only 783 bytes better
    // than the default level 6 — so a cache is what makes the smallest available body worth
    // asking for at all (§21.7). The layer then passes this response through untouched,
    // because it already carries a `Content-Encoding`.
    let content_type = content_type(&asset);
    let compressible = crate::compress::is_compressible_type(content_type);
    let gzip =
        if compressible && crate::compress::accepts_gzip(headers.get(header::ACCEPT_ENCODING)) {
            state.compressed_asset(&path)
        } else {
            None
        };
    let body = match gzip {
        Some(ref bytes) => bytes.clone(),
        None => match std::fs::read(&path) {
            Ok(bytes) => axum::body::Bytes::from(bytes),
            Err(_) => return not_found().await,
        },
    };

    let mut response = (
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
            // Content types here are inferred from a file extension, so tell the browser not
            // to second-guess them: a sniffed type is a script-execution decision.
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        body,
    )
        .into_response();
    if compressible {
        // On the uncompressed answer too: without it a cache that stored this is free to
        // hand it to a client that asked for gzip, and the gzipped one to a client that did
        // not. An incompressible type has one representation, so it says nothing there.
        response
            .headers_mut()
            .insert(header::VARY, HeaderValue::from_static("accept-encoding"));
    }
    if gzip.is_some() {
        response
            .headers_mut()
            .insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
    }
    response
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
            page_with(
                PagePolicy::SignIn,
                "Sign in",
                &login_form(Some("Invalid username or password."), &form.username),
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
                timestamp: &crate::audit::unix_seconds().to_string(),
                actor: Some(actor),
                source_ip: None,
                vault: None,
                action: AuditAction::Login,
                targets: &targets,
                result,
            })
            .map_err(|error| Error::Auth(format!("writing audit log: {error}")))
    }

    /// The process's document rooms, for an operation that has to close one (§6.6).
    fn sync_registry(&self) -> &SyncRegistry {
        &self.security.sync
    }

    /// The audit writer, when this deployment has one.
    fn audit_log(&self) -> Option<&AuditLog> {
        self.security.audit.as_ref()
    }

    fn authenticated_user(&self, headers: &HeaderMap) -> Option<Username> {
        let token = session_cookie(headers)?;
        let auth = self.security.auth.lock().ok()?;
        let user = auth.authenticate_signed_session_cookie(token).ok()??;
        Username::parse(&user.username).ok()
    }

    fn is_server_admin(&self, headers: &HeaderMap) -> bool {
        let Some(username) = self.authenticated_user(headers) else {
            return false;
        };
        self.security
            .auth
            .lock()
            .ok()
            .and_then(|auth| auth.user_by_username(username.as_str()).ok().flatten())
            .is_some_and(|user| user.is_admin && !user.disabled)
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
        let user = self.vault_user(vault.slug(), headers)?;
        Some(AuthorizedVault::new(vault, access, user))
    }

    /// The authenticated caller, by session cookie or by this vault's API token.
    ///
    /// Separate from [`AppState::authorized_vault`] for callers that need the name as well
    /// as the view — the index reader is constructed from a user, not from a vault.
    fn vault_user(&self, slug: &Slug, headers: &HeaderMap) -> Option<Username> {
        self.authenticated_user(headers)
            .or_else(|| self.api_token_user(slug, headers))
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
    page_with(PagePolicy::SignIn, "Sign in", &login_form(None, ""))
}

/// The sign-in form, optionally above the reason a previous attempt failed.
///
/// why: the failed attempt renders the *form* again rather than a dead-end message. An
/// earlier revision returned only "Invalid username or password.", which left the browser on
/// a page with nothing to submit — the user's only route back was editing the address bar.
/// Carrying `username` forward means a mistyped password does not also cost the username.
/// Both the initial page and this one are `PagePolicy::SignIn`, because a page that carries
/// a form and forbids submitting it is the M5 outage all over again.
fn login_form(error: Option<&str>, username: &str) -> String {
    let mut out = String::with_capacity(768);
    out.push_str("<form class=\"mb-form\" method=\"post\" action=\"/login\">");
    if let Some(message) = error {
        // role="alert" so a screen reader hears the refusal rather than only sighted users
        // seeing it (AGENTS.md §4.4: no mouse-only, and no eyes-only, feature ships).
        out.push_str("<p class=\"mb-form-error\" role=\"alert\">");
        push_escaped_text(&mut out, message);
        out.push_str("</p>");
    }
    out.push_str(
        "<div class=\"mb-field\"><label for=\"mb-username\">Username</label>\
         <input id=\"mb-username\" name=\"username\" autocomplete=\"username\" required ",
    );
    // Focus goes where the work is: the empty form starts at the username, a refused one at
    // the password, which is the field that was almost certainly wrong.
    if error.is_none() {
        out.push_str("autofocus ");
    }
    out.push_str("value=\"");
    push_escaped_attr(&mut out, username);
    out.push_str("\" /></div>");
    out.push_str(
        "<div class=\"mb-field\"><label for=\"mb-password\">Password</label>\
         <input id=\"mb-password\" type=\"password\" name=\"password\" \
         autocomplete=\"current-password\" required ",
    );
    if error.is_some() {
        out.push_str("autofocus ");
    }
    out.push_str("/></div>");
    out.push_str("<button class=\"mb-button\" type=\"submit\">Sign in</button></form>");
    out
}

async fn not_found() -> Response {
    not_found_page()
}

/// The same refusal, callable from a handler that is not itself the fallback.
fn not_found_page() -> Response {
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
    /// The vault index. Carries the create-a-note form, so it posts to this origin too.
    VaultIndex,
}

impl PagePolicy {
    /// The `form-action` source list this policy permits.
    fn form_action(self) -> &'static str {
        match self {
            // why: `'none'` on every page made the sign-in form unsubmittable, so nobody
            // could log in with a browser at all. Only this page has a form, and it posts
            // to its own origin; the note pages keep the stricter rule they need.
            Self::SignIn | Self::VaultIndex => "'self'",
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

/// How often the index reconciles the *whole* vault when the watcher has said nothing.
///
/// why: not the sync sweep's five seconds. A full reconcile lists and stamps every note, so
/// at the design target of 10 000 notes (A8) it is 10 000 syscalls; at five seconds that is
/// a directory walk every five seconds to discover nothing changed. The watcher covers every
/// change it can see within a tick, and this covers what it cannot — a dropped event, an
/// unwatchable root, a note deleted while the process was down.
const INDEX_SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

/// How often S3-backed vaults are made self-contained on local disk (§12.3).
const MEDIA_MATERIALIZE_INTERVAL: std::time::Duration =
    std::time::Duration::from_secs(24 * 60 * 60);

/// Time for the note write and index tick to replace an uploader-only preview grant (E11).
const MEDIA_UPLOAD_GRANT: std::time::Duration = std::time::Duration::from_secs(5 * 60);

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
    // why: the index is built before the first request rather than on the first tick. An
    // index that is still filling makes an empty backlinks panel mean two different things,
    // and "no backlinks yet" is indistinguishable from "no backlinks" to a reader and to a
    // test. Paying for it at startup is a cost an operator can see; the alternative is a
    // window nobody can see.
    let built = std::time::Instant::now();
    let index_state = Arc::clone(&state);
    let errors = tokio::task::spawn_blocking(move || index_state.maintain_index(&Changes::All))
        .await
        .unwrap_or_default();
    for error in &errors {
        eprintln!("memberberry index: {error}");
    }
    println!(
        "memberberry: index ready in {} ms",
        built.elapsed().as_millis()
    );

    let maintenance_state = Arc::clone(&state);
    let maintenance = tokio::spawn(async move {
        let mut interval = tokio::time::interval(MAINTENANCE_INTERVAL);
        let mut since_sweep = std::time::Duration::ZERO;
        let mut since_index_sweep = std::time::Duration::ZERO;
        let mut since_media_materialize = std::time::Duration::ZERO;
        loop {
            interval.tick().await;
            since_sweep += MAINTENANCE_INTERVAL;
            since_index_sweep += MAINTENANCE_INTERVAL;
            since_media_materialize += MAINTENANCE_INTERVAL;
            let mut changed = signal.take();
            if since_sweep >= RECOVERY_SWEEP_INTERVAL {
                since_sweep = std::time::Duration::ZERO;
                changed = Changes::All;
            }
            let indexed = if since_index_sweep >= INDEX_SWEEP_INTERVAL {
                since_index_sweep = std::time::Duration::ZERO;
                Changes::All
            } else {
                // The watcher's own report, not the sync sweep's `All`: this is the fast
                // path, and it is empty on a tick where nothing was touched.
                changed.clone()
            };
            let tick = Arc::clone(&maintenance_state);
            let errors = tokio::task::spawn_blocking(move || {
                let mut errors = tick.maintain_sync(&changed);
                if !indexed.is_empty() {
                    errors.extend(tick.maintain_index(&indexed));
                }
                errors
            })
            .await;
            for error in errors.unwrap_or_default() {
                eprintln!("memberberry maintenance: {error}");
            }
            if since_media_materialize >= MEDIA_MATERIALIZE_INTERVAL {
                since_media_materialize = std::time::Duration::ZERO;
                for error in maintenance_state.materialize_media().await {
                    eprintln!("memberberry media maintenance: {error}");
                }
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

/// Waits for the operator to ask the server to stop (`SPEC.md` §6.11).
///
/// Both signals, because the flush that follows is the durability contract and not a
/// courtesy: `SIGTERM` is what `systemctl stop`, `docker stop` and every process supervisor
/// send, and leaving it on the default disposition would kill the process outright — skipping
/// the flush, and stranding accepted edits in a sidecar until the next start recovered them.
/// `SIGINT` is the one a person sends.
async fn shutdown() {
    let interrupt = async {
        drop(tokio::signal::ctrl_c().await);
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signals) => {
                signals.recv().await;
            }
            // why: a handler that cannot be installed must not become a shutdown that fires
            // immediately. Never resolving leaves `SIGTERM` on its default disposition, which
            // is the behaviour this had before — degraded, but not a server that exits at
            // startup.
            Err(error) => {
                eprintln!("memberberry: cannot handle SIGTERM ({error}); it will not flush");
                std::future::pending::<()>().await;
            }
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = interrupt => {}
        () = terminate => {}
    }
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
.mb-form{display:flex;flex-direction:column;gap:var(--space-6);max-width:22rem;margin:var(--space-7) 0;padding:var(--space-7);border:1px solid var(--border-subtle);border-radius:var(--radius-md);background:var(--surface-note);box-shadow:var(--shadow-sm)}\
.mb-field{display:flex;flex-direction:column;gap:var(--space-3)}\
.mb-field label{color:var(--text-muted);font:var(--weight-medium) var(--text-sm)/var(--leading-snug) var(--font-ui)}\
.mb-form input{min-height:var(--touch-target-min);padding:var(--space-4) var(--space-5);border:1px solid var(--border-subtle);border-radius:var(--radius-sm);color:var(--text-primary);background:var(--surface-sunken);font:var(--text-md)/var(--leading-flat) var(--font-ui)}\
.mb-button{min-height:var(--touch-target-min);padding:var(--space-4) var(--space-6);border:1px solid var(--accent-primary);border-radius:var(--radius-sm);color:var(--presence-label);background:var(--accent-primary);font:var(--weight-bold) var(--text-sm)/var(--leading-flat) var(--font-ui);cursor:pointer}\
.mb-form input:focus-visible,.mb-button:focus-visible{outline:var(--focus-ring-width) solid var(--focus-ring);outline-offset:var(--focus-ring-offset)}\
.mb-form-error{margin:0;color:var(--state-danger);font:var(--weight-medium) var(--text-sm)/var(--leading-snug) var(--font-ui)}\
";
