//! A dedicated, stateless Streamable HTTP listener for authorized note reads.

use std::collections::{BTreeSet, VecDeque};
use std::net::SocketAddr;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use mb_auth::mcp::{Principal, Token};
use reqwest::Url;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{
    AppState, Arc, AuthorizedVault, Error, Username, Vault, bearer_token, encode_path,
    json_no_store,
};
use crate::config::McpConfig;

const PROTOCOLS: [&str; 3] = ["2025-11-25", "2025-06-18", "2025-03-26"];
const PATH: &str = "/mcp";
const MAX_HITS: usize = 25;
const MAX_NOTE: usize = 64 * 1024;

#[derive(Debug)]
pub(super) struct Listener {
    pub addr: SocketAddr,
    pub endpoint: Url,
    note_origin: Url,
    budget: Arc<tokio::sync::Semaphore>,
}

fn http_url(value: &str, path: &str) -> Result<Url, Error> {
    let valid = |url: &Url| {
        let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        (url.scheme() == "https" || (url.scheme() == "http" && loopback))
            && url.path() == path
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
    };
    Url::parse(value).ok().filter(valid).ok_or_else(|| {
        Error::Config(
            "MCP URLs must use HTTPS or loopback HTTP, with no credentials, query or fragment"
                .into(),
        )
    })
}

impl Listener {
    fn new(config: McpConfig) -> Result<Self, Error> {
        if !config.listen.ip().is_loopback() || config.listen.port() == 0 {
            return Err(Error::Config(
                "MCP requires a loopback listener with an explicit port".into(),
            ));
        }
        let endpoint = config
            .endpoint
            .unwrap_or_else(|| format!("http://{}{PATH}", config.listen));
        Ok(Self {
            addr: config.listen,
            endpoint: http_url(&endpoint, PATH)?,
            note_origin: http_url(&config.note_origin, "/")?,
            budget: Arc::new(tokio::sync::Semaphore::new(8)),
        })
    }

    fn note_url(&self, vault: &Vault, path: &str) -> String {
        format!(
            "{}v/{}/{}",
            self.note_origin,
            vault.slug(),
            encode_path(path)
        )
    }
}

impl AppState {
    /// Provisions an optional loopback-only transport separate from the web application.
    ///
    /// # Errors
    /// Rejects invalid endpoint configuration or an unreadable authentication store.
    pub fn with_mcp(mut self, config: Option<McpConfig>) -> Result<Self, Error> {
        let Some(config) = config else {
            return Ok(self);
        };
        let listener = Listener::new(config)?;
        let current = self
            .vault_snapshot()
            .iter()
            .filter_map(|vault| registration_key(vault))
            .collect();
        self.security
            .auth
            .lock()
            .map_err(|_| Error::Config("MCP auth store unavailable".into()))?
            .retire_mcp_registrations(&current)
            .map_err(|error| Error::Auth(error.to_string()))?;
        self.mcp = Some(listener);
        Ok(self)
    }
}

// why: a slug reassigned to another directory must not inherit an earlier grant. The
// registration key is private and never used as the label or the tool’s vault argument.
pub(super) fn registration_key(vault: &Vault) -> Option<String> {
    let root = vault.root().canonicalize().ok()?;
    let metadata = root.metadata().ok()?;
    if !metadata.is_dir() {
        return None;
    }
    let mut digest = Sha256::new();
    digest.update(vault.slug().as_str().as_bytes());
    digest.update([0]);
    digest.update(root.as_os_str().as_encoded_bytes());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        digest.update(metadata.dev().to_le_bytes());
        digest.update(metadata.ino().to_le_bytes());
    }
    Some(format!("{:x}", digest.finalize()))
}

pub(super) fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route(
            PATH,
            post(receive)
                .get(unsupported_stream)
                .delete(unsupported_stream),
        )
        .layer(DefaultBodyLimit::max(16 * 1024))
        .with_state(state)
}

#[derive(Clone, Copy)]
enum Reject {
    Denied,
    Forbidden,
    Unavailable,
}

impl Reject {
    fn into_response(self) -> Response {
        match self {
            Self::Denied => (
                StatusCode::UNAUTHORIZED,
                [
                    (header::WWW_AUTHENTICATE, "Bearer"),
                    (header::CACHE_CONTROL, "no-store"),
                ],
            )
                .into_response(),
            Self::Forbidden => StatusCode::FORBIDDEN.into_response(),
            Self::Unavailable => (
                StatusCode::SERVICE_UNAVAILABLE,
                [(header::CACHE_CONTROL, "no-store")],
            )
                .into_response(),
        }
    }
}

fn unavailable() -> Response {
    Reject::Unavailable.into_response()
}

struct Grant {
    principal: Principal,
    user: Username,
}

impl Grant {
    fn allows(&self, key: &str) -> bool {
        self.principal.vaults.contains(key)
    }
}

fn grant(state: &AppState, token: &Token) -> Result<Grant, Reject> {
    let auth = state
        .security
        .auth
        .lock()
        .map_err(|_| Reject::Unavailable)?;
    grant_for(&auth, token)
}

fn grant_for(auth: &mb_auth::AuthDb, token: &Token) -> Result<Grant, Reject> {
    let settings = auth.mcp_settings().map_err(|_| Reject::Unavailable)?;
    if !settings.enabled {
        return Err(Reject::Denied);
    }
    let principal = auth
        .authenticate_mcp_token(token)
        .map_err(|_| Reject::Unavailable)?
        .ok_or(Reject::Denied)?;
    let user = Username::parse(&principal.username).map_err(|_| Reject::Denied)?;
    Ok(Grant { principal, user })
}

fn token_for(headers: &HeaderMap, listener: &Listener) -> Result<Token, Reject> {
    let origins = headers.get_all(header::ORIGIN);
    let mut origins = origins.iter();
    if let Some(origin) = origins.next() {
        let valid = origins.next().is_none()
            && origin
                .to_str()
                .is_ok_and(|value| value == listener.endpoint.origin().ascii_serialization());
        if !valid {
            return Err(Reject::Forbidden);
        }
    }
    if headers.get_all(header::AUTHORIZATION).iter().count() != 1 {
        return Err(Reject::Denied);
    }
    bearer_token(headers)
        .and_then(Token::parse)
        .ok_or(Reject::Denied)
}

async fn unsupported_stream(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let Some(listener) = &state.mcp else {
        return unavailable();
    };
    token_for(&headers, listener)
        .and_then(|token| grant(&state, &token))
        .map_or_else(Reject::into_response, |_| {
            (StatusCode::METHOD_NOT_ALLOWED, [(header::ALLOW, "POST")]).into_response()
        })
}

async fn receive(State(state): State<Arc<AppState>>, headers: HeaderMap, body: Bytes) -> Response {
    let Some(listener) = &state.mcp else {
        return unavailable();
    };
    let token = match token_for(&headers, listener) {
        Ok(token) => token,
        Err(reject) => return reject.into_response(),
    };
    if headers.get("mcp-protocol-version").is_some_and(|version| {
        !version
            .to_str()
            .is_ok_and(|version| PROTOCOLS.contains(&version))
    }) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let Ok(permit) = listener.budget.clone().try_acquire_owned() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        dispatch(&state, &token, &body)
    })
    .await
    .unwrap_or_else(|_| unavailable())
}

#[derive(Deserialize)]
struct Request {
    jsonrpc: String,
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

fn error(id: &Value, code: i32, message: &str) -> Response {
    json_no_store(&json!({"jsonrpc":"2.0", "id":id, "error":{"code":code,"message":message}}))
}

fn result(id: &Value, value: Value) -> Response {
    json_no_store(&json!({"jsonrpc":"2.0", "id":id, "result":value}))
}

fn dispatch(state: &AppState, token: &Token, body: &[u8]) -> Response {
    let grant = match grant(state, token) {
        Ok(grant) => grant,
        Err(reject) => return reject.into_response(),
    };
    let raw = match serde_json::from_slice::<Value>(body) {
        Ok(raw) => raw,
        Err(_) => return error(&Value::Null, -32700, "Parse error"),
    };
    if !raw.is_object() {
        return error(&Value::Null, -32600, "Invalid request");
    }
    let is_request = raw.get("id").is_some();
    let Some(request) = serde_json::from_value::<Request>(raw)
        .ok()
        .filter(|request| {
            request.jsonrpc == "2.0"
                && (!is_request
                    || request
                        .id
                        .as_ref()
                        .is_some_and(|id| id.is_string() || id.is_i64() || id.is_u64()))
        })
    else {
        return error(&Value::Null, -32600, "Invalid request");
    };
    let Some(id) = request.id else {
        return StatusCode::ACCEPTED.into_response();
    };
    match request.method.as_str() {
        "initialize" => {
            let Some(protocol) = request
                .params
                .get("protocolVersion")
                .and_then(Value::as_str)
            else {
                return error(&id, -32602, "Invalid parameters");
            };
            let version = if PROTOCOLS.contains(&protocol) {
                protocol
            } else {
                PROTOCOLS[0]
            };
            result(
                &id,
                json!({
                    "protocolVersion":version, "capabilities":{"tools":{}},
                    "serverInfo":{"name":"Memberberry","version":env!("CARGO_PKG_VERSION")},
                }),
            )
        }
        "ping" => result(&id, json!({})),
        "tools/list" => result(&id, tools()),
        "tools/call" => call(state, token, grant, &id, request.params),
        _ => error(&id, -32601, "Method not found"),
    }
}

fn tools() -> Value {
    json!({"tools":[
        {"name":"search_notes", "description":"Search readable Memberberry notes. Results reflect the local full-text index. For current project work, look for project-status.md and its linked open task.",
         "annotations":{"readOnlyHint":true, "openWorldHint":false},
         "inputSchema":{"type":"object", "required":["query"], "additionalProperties":false,
          "properties":{"query":{"type":"string", "maxLength":512},
                        "vault":{"type":"string", "description":"Optional vault name or slug."},
                        "limit":{"type":"integer", "minimum":1, "maximum":MAX_HITS}}}},
        {"name":"fetch_note", "description":"Read the current saved Markdown for a note ID returned by search_notes. GitHub-backed notes reflect the local checkout.",
         "annotations":{"readOnlyHint":true, "openWorldHint":false},
         "inputSchema":{"type":"object", "required":["id"], "additionalProperties":false,
          "properties":{"id":{"type":"string"}}}},
    ]})
}

#[derive(Deserialize)]
struct Call {
    name: String,
    #[serde(default)]
    arguments: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Search {
    query: String,
    vault: Option<String>,
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Fetch {
    id: String,
}

fn call(state: &AppState, token: &Token, initial: Grant, id: &Value, params: Value) -> Response {
    let Some(listener) = &state.mcp else {
        return unavailable();
    };
    let Ok(call) = serde_json::from_value::<Call>(params) else {
        return error(id, -32602, "Invalid parameters");
    };
    let content = match call.name.as_str() {
        "search_notes" => operation(call.arguments, |query: Search| {
            search(state, listener, &initial, query).map(Pending::Search)
        }),
        "fetch_note" => operation(call.arguments, |fetch: Fetch| {
            Ok(Pending::Fetch(fetch_note(
                state, listener, &initial, &fetch.id,
            )))
        }),
        _ => return error(id, -32602, "Unknown tool"),
    };
    let pending = match content {
        Ok(value) => value,
        Err(message) => return error(id, -32602, message),
    };
    // Serialize the final permission decision with Settings updates and revocation. The
    // index query and Markdown read have already finished without holding the auth lock.
    let Ok(auth) = state.security.auth.lock() else {
        return unavailable();
    };
    let current = match grant_for(&auth, token) {
        Ok(current) => current,
        Err(reject) => return reject.into_response(),
    };
    let Some(payload) = pending.authorized(state, &current) else {
        return result(
            id,
            json!({"content":[{"type":"text","text":"Note not found."}],"isError":true}),
        );
    };
    let _ = auth.record_mcp_use(&current.principal);
    let mut response = result(
        id,
        json!({"content":[{"type":"text","text":payload.to_string()}],
        "structuredContent":payload}),
    );
    response
        .headers_mut()
        .insert(header::VARY, HeaderValue::from_static("Authorization"));
    response
}

fn operation<T: DeserializeOwned>(
    arguments: Value,
    run: impl FnOnce(T) -> Result<Pending, &'static str>,
) -> Result<Pending, &'static str> {
    run(serde_json::from_value(arguments).map_err(|_| "Invalid tool arguments")?)
}

struct Note {
    slug: String,
    key: String,
    path: String,
    value: Value,
}

enum Pending {
    Search((Vec<Note>, usize)),
    Fetch(Option<Note>),
}

impl Pending {
    fn authorized(self, state: &AppState, grant: &Grant) -> Option<Value> {
        let visible = |note: &Note| {
            let Some(vault) = state.vault(&note.slug) else {
                return false;
            };
            let Some(access) = state.access_for(vault.slug()) else {
                return false;
            };
            grant.allows(&note.key)
                && registration_key(&vault).as_ref() == Some(&note.key)
                && AuthorizedVault::new(&vault, &access, grant.user.clone())
                    .resolve(&note.path)
                    .is_ok_and(|path| std::fs::File::open(path).is_ok())
        };
        match self {
            Self::Search((notes, limit)) => {
                let hits: Vec<_> = notes
                    .into_iter()
                    .filter(visible)
                    .take(limit)
                    .map(|note| note.value)
                    .collect();
                Some(json!({"hits":hits, "freshness":"local index"}))
            }
            Self::Fetch(note) => note.filter(visible).map(|note| note.value),
        }
    }
}

fn scoped_vault(
    state: &AppState,
    vault: &Vault,
    grant: &Grant,
) -> Option<(String, Arc<mb_core::Access>)> {
    let key = registration_key(vault)?;
    if !grant.allows(&key) {
        return None;
    }
    let access = state.access_for(vault.slug())?;
    AuthorizedVault::new(vault, &access, grant.user.clone())
        .has_any_access()
        .ok()?
        .then_some((key, access))
}

fn search(
    state: &AppState,
    listener: &Listener,
    grant: &Grant,
    input: Search,
) -> Result<(Vec<Note>, usize), &'static str> {
    let limit = input.limit.unwrap_or(10);
    if limit == 0 || limit > MAX_HITS || input.query.len() > 512 || input.query.trim().is_empty() {
        return Err("Enter a query and a valid result limit");
    }
    // Tantivy ranks blocks. Inspect a bounded window so one matching note only takes one
    // result slot and keeps its highest-ranked snippet.
    let block_limit = (limit * 8).max(32);
    let mut ranked = VecDeque::new();
    for vault in state.vault_snapshot() {
        if input
            .vault
            .as_ref()
            .is_some_and(|wanted| wanted != vault.slug().as_str() && wanted != vault.name())
        {
            continue;
        }
        let Some((key, access)) = scoped_vault(state, &vault, grant) else {
            continue;
        };
        let Some(index) = state.indexes.get(&vault) else {
            continue;
        };
        let Ok(mut index) = index.lock() else {
            continue;
        };
        let hits = match index
            .reader(&access, &grant.user)
            .and_then(|reader| reader.search(&input.query, block_limit))
        {
            Ok(hits) => hits,
            Err(mb_index::Error::Query(_)) => return Err("Invalid search query"),
            Err(_) => continue,
        };
        let mut seen = BTreeSet::new();
        let notes = hits
            .into_iter()
            .filter(|hit| seen.insert(hit.path.clone()))
            .take(limit)
            .map(|hit| {
                let value = search_hit(listener, &vault, &hit);
                Note {
                    slug: vault.slug().to_string(),
                    key: key.clone(),
                    path: hit.path,
                    value,
                }
            })
            .collect::<VecDeque<_>>();
        if !notes.is_empty() {
            ranked.push_back(notes);
        }
    }
    let mut notes = Vec::new();
    // Relevance scores belong to each index. Round-robin preserves each vault’s order.
    while let Some(mut vault) = ranked.pop_front() {
        if let Some(note) = vault.pop_front() {
            notes.push(note);
        }
        if !vault.is_empty() {
            ranked.push_back(vault);
        }
    }
    Ok((notes, limit))
}

#[derive(Serialize)]
struct SearchHit<'a> {
    id: String,
    title: String,
    vault: &'a str,
    url: String,
    snippet: String,
}

fn search_hit(listener: &Listener, vault: &Vault, hit: &mb_index::SearchHit) -> Value {
    let entry = SearchHit {
        id: format!("{}/{}", vault.slug(), hit.path),
        title: hit
            .title
            .as_deref()
            .unwrap_or_else(|| note_name(&hit.path))
            .chars()
            .take(512)
            .collect(),
        vault: vault.name(),
        url: listener.note_url(vault, &hit.path),
        snippet: hit.context.chars().take(800).collect(),
    };
    json!(entry)
}

fn fetch_note(state: &AppState, listener: &Listener, grant: &Grant, id: &str) -> Option<Note> {
    let (slug, path) = id.split_once('/')?;
    if !crate::vault::valid_note_path(path) {
        return None;
    }
    let vault = state.vault(slug)?;
    let (key, access) = scoped_vault(state, &vault, grant)?;
    let view = AuthorizedVault::new(&vault, &access, grant.user.clone());
    let (markdown, modified, truncated) = view.read_bounded(path, MAX_NOTE).ok()?;
    let title = mb_core::extract::title(&mb_core::parse(&markdown))
        .unwrap_or_else(|| note_name(path).to_owned());
    let value = json!({"id":id,"title":title.chars().take(512).collect::<String>(),"vault":vault.name(),
        "url":listener.note_url(&vault,path), "markdown":markdown, "truncated":truncated,
        "modified_unix":modified, "freshness":"local saved Markdown"});
    Some(Note {
        slug: slug.to_owned(),
        key,
        path: path.to_owned(),
        value,
    })
}

fn note_name(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.strip_suffix(".md").unwrap_or(name)
}
