//! E29 signed-session administrator preview/confirmation. No content ACL bypass.
use super::*;
use crate::vault_locations::{
    DirectoryName, RelativeDirectoryPath, VaultLocationId, discovery, limits,
};
use rand_core::RngCore;
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
mod directories;
mod storage;
pub(super) use directories::create as create_directory;

const RECEIPTS: usize = 16;
const TTL: Duration = Duration::from_secs(120);
#[derive(Debug)]
pub(super) struct RegistrationGate {
    slots: Arc<Semaphore>,
    budget: Mutex<ClipBudget>,
    receipts: Mutex<BTreeMap<[u8; 32], Receipt>>,
    #[cfg(test)]
    hooks: tests::Hooks,
}
impl RegistrationGate {
    pub(super) fn new() -> Self {
        Self {
            slots: Arc::new(Semaphore::new(2)),
            budget: Mutex::new(ClipBudget::new()),
            receipts: Mutex::new(BTreeMap::new()),
            #[cfg(test)]
            hooks: tests::Hooks::default(),
        }
    }
    #[cfg(test)]
    fn enter(&self) -> Result<OwnedSemaphorePermit, Refusal> {
        let slot = self.reserve()?;
        self.charge()?;
        Ok(slot)
    }
    fn reserve(&self) -> Result<OwnedSemaphorePermit, Refusal> {
        self.slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Refusal::Busy)
    }
    fn charge(&self) -> Result<(), Refusal> {
        if !self.budget.lock().map_err(|_| Refusal::Busy)?.allow() {
            return Err(Refusal::Busy);
        }
        Ok(())
    }
    #[cfg(test)]
    pub(super) fn sweeps_enabled(&self) -> bool {
        !self.hooks.disable_sweeps.load(Ordering::Relaxed)
    }
    #[cfg(test)]
    pub(super) fn maintenance_completed(&self, changes: &Changes) {
        if !changes.is_empty()
            && let Ok(channel) = self.hooks.maintenance_completed.lock()
            && let Some(channel) = channel.as_ref()
        {
            let _ = channel.try_send(changes.clone());
        }
    }
    #[cfg(test)]
    pub(super) fn serving(&self) {
        self.hooks.pause(tests::Phase::Serving);
    }
    #[cfg(test)]
    pub(super) fn maintenance(&self) {
        self.hooks.pause(tests::Phase::Maintenance);
    }
    #[cfg(test)]
    pub(super) fn stopped(&self) {
        self.hooks.pause(tests::Phase::Stopped);
    }
    fn now(&self) -> Result<Instant, Refusal> {
        let now = Instant::now();
        #[cfg(test)]
        {
            return now
                .checked_add(
                    *self
                        .hooks
                        .clock_advance
                        .lock()
                        .map_err(|_| Refusal::Unavailable)?,
                )
                .ok_or(Refusal::Unavailable);
        }
        #[cfg(not(test))]
        Ok(now)
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
struct Actor {
    username: Username,
    session: [u8; 32],
}
impl Actor {
    fn same(&self, other: &Self) -> bool {
        let difference = self
            .session
            .iter()
            .zip(other.session.iter())
            .fold(0_u8, |d, (a, b)| d | (a ^ b));
        difference == 0 && self.username == other.username
    }
}
fn registration_cookie(headers: &HeaderMap) -> Result<&str, Refusal> {
    if headers.contains_key(header::AUTHORIZATION) {
        return Err(Refusal::NotFound);
    }
    // why: Cookie is legitimately multi-valued, but management authority is not.
    // Inspect every field and preserve credential bytes rather than selecting/repairing one.
    let mut session = None;
    for field in headers.get_all(header::COOKIE) {
        let field = field.to_str().map_err(|_| Refusal::NotFound)?;
        for cookie in field.split(';') {
            if let Some(token) = cookie
                .trim_start_matches([' ', '\t'])
                .strip_prefix("mb_session=")
                && (token.is_empty() || session.replace(token).is_some())
            {
                return Err(Refusal::NotFound);
            }
        }
    }
    session.ok_or(Refusal::NotFound)
}
pub(super) fn administrator(state: &AppState, headers: &HeaderMap) -> bool {
    // why: HTML/visibility must not wait on the commit auth lock on an async executor.
    // The same strict cookie/current-actor predicate applies; contention fails closed.
    let Ok(cookie) = registration_cookie(headers) else {
        return false;
    };
    let Ok(auth) = state.security.auth.try_lock() else {
        return false;
    };
    signed_actor(&auth, cookie).is_ok()
}
fn actor(state: &AppState, headers: &HeaderMap) -> Result<Actor, Refusal> {
    let cookie = registration_cookie(headers)?;
    let auth = state.security.auth.lock().map_err(|_| Refusal::NotFound)?;
    signed_actor(&auth, cookie)
}
fn signed_actor(auth: &mb_auth::AuthDb, cookie: &str) -> Result<Actor, Refusal> {
    let user = auth
        .authenticate_signed_session_cookie(cookie)
        .ok()
        .flatten()
        .filter(|u| u.is_admin && !u.disabled)
        .ok_or(Refusal::NotFound)?;
    Ok(Actor {
        username: Username::parse(&user.username).map_err(|_| Refusal::NotFound)?,
        session: digest(cookie.as_bytes()),
    })
}
fn digest(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}
fn random() -> Result<String, Refusal> {
    let mut bytes = [0; 32];
    rand_core::OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|_| Refusal::Unavailable)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
#[derive(Debug, Clone, Copy)]
enum Refusal {
    NotFound,
    Invalid,
    Limit,
    Busy,
    Conflict,
    PolicyLayout,
    Unavailable,
    Residual,
}
impl Refusal {
    fn response(self) -> Response {
        let (status, error) = match self {
            Self::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            Self::Invalid => (StatusCode::BAD_REQUEST, "invalid_request"),
            Self::Limit => (StatusCode::UNPROCESSABLE_ENTITY, "limit_exceeded"),
            Self::Busy => (StatusCode::TOO_MANY_REQUESTS, "busy"),
            Self::Conflict => (StatusCode::CONFLICT, "confirmation_conflict"),
            Self::PolicyLayout => {
                return reply(
                    StatusCode::CONFLICT,
                    serde_json::json!({"error":"permission_layout_conflict","guidance":"Select the intended note root or resolve the policy layout outside Memberberry before adopting this folder."}),
                );
            }
            Self::Unavailable => (StatusCode::SERVICE_UNAVAILABLE, "storage_unavailable"),
            Self::Residual => (StatusCode::SERVICE_UNAVAILABLE, "cleanup_incomplete"),
        };
        reply(status, serde_json::json!({"error":error}))
    }
}
fn reply(status: StatusCode, value: serde_json::Value) -> Response {
    (
        status,
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        Json(value),
    )
        .into_response()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    mode: String,
    path: String,
    #[serde(default, deserialize_with = "present_string")]
    directory: Option<String>,
    slug: String,
    name: String,
    #[serde(default, deserialize_with = "present_string")]
    confirmation: Option<String>,
    #[serde(default)]
    ignore_non_writable_folders: bool,
}
fn present_string<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}
#[derive(Debug, Clone, PartialEq, Eq)]
struct Selection {
    id: VaultLocationId,
    path: RelativeDirectoryPath,
    child: Option<DirectoryName>,
    slug: Slug,
    name: String,
    ignore_non_writable_folders: bool,
}
fn parse(
    uri: &axum::http::Uri,
    bytes: &[u8],
    confirm: bool,
) -> Result<(Selection, Option<String>), Refusal> {
    if uri.path().len() > 256 || bytes.len() > 8192 {
        return Err(Refusal::Limit);
    }
    if uri.query().is_some() {
        return Err(Refusal::Invalid);
    }
    let raw = uri
        .path()
        .strip_prefix("/api/v1/vault-locations/")
        .and_then(|s| s.split_once('/'))
        .map(|(id, _)| id)
        .ok_or(Refusal::Invalid)?;
    let id = VaultLocationId::parse(raw).map_err(|_| Refusal::Invalid)?;
    let input: Input = serde_json::from_slice(bytes).map_err(|_| Refusal::Invalid)?;
    if !limits::token(&input.path)
        || input.name.len() > 256
        || input.directory.as_ref().is_some_and(|s| s.len() > 255)
    {
        return Err(Refusal::Limit);
    }
    if input.name.trim().is_empty() || input.name.chars().any(char::is_control) {
        return Err(Refusal::Invalid);
    }
    if confirm != input.confirmation.is_some() {
        return Err(Refusal::Invalid);
    }
    if input.confirmation.as_ref().is_some_and(|s| {
        s.len() != 64
            || !s
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }) {
        return Err(Refusal::Invalid);
    }
    let (path, child) = match (input.mode.as_str(), input.directory) {
        ("existing", None) => (
            RelativeDirectoryPath::for_selection(&input.path).map_err(|_| Refusal::Invalid)?,
            None,
        ),
        ("new", Some(name)) => {
            let path =
                RelativeDirectoryPath::for_browse(&input.path).map_err(|_| Refusal::Invalid)?;
            let child = DirectoryName::parse(&name).map_err(|_| Refusal::Invalid)?;
            if !limits::token(path.child(&child).as_str()) {
                return Err(Refusal::Limit);
            }
            (path, Some(child))
        }
        _ => return Err(Refusal::Invalid),
    };
    Ok((
        Selection {
            id,
            path,
            child,
            slug: Slug::parse(&input.slug).map_err(|_| Refusal::Invalid)?,
            name: input.name,
            ignore_non_writable_folders: input.ignore_non_writable_folders,
        },
        input.confirmation,
    ))
}
#[derive(Debug)]
struct Receipt {
    actor: Actor,
    selection: Selection,
    expires: Instant,
    config: storage::FileState,
    pin: discovery::RegistrationPin,
    layout: Option<storage::Layout>,
}
struct Cancel(Arc<AtomicBool>);
impl Drop for Cancel {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

pub(super) async fn preview(
    State(state): State<Arc<AppState>>,
    request: axum::extract::Request,
) -> Response {
    handle(state, request, false).await
}
pub(super) async fn register(
    State(state): State<Arc<AppState>>,
    request: axum::extract::Request,
) -> Response {
    handle(state, request, true).await
}
async fn handle(state: Arc<AppState>, request: axum::extract::Request, confirm: bool) -> Response {
    let (parts, body) = request.into_parts();
    if registration_cookie(&parts.headers).is_err() || !origin(&parts.headers) {
        return Refusal::NotFound.response();
    }
    // why: authentication can wait for the short final commit auth lock, but never on
    // the async executor or in an unbounded blocking queue. Unverified overflow is neutral.
    let slot = match state.registration.reserve() {
        Ok(slot) => slot,
        Err(_) => return Refusal::NotFound.response(),
    };
    let auth_state = state.clone();
    let auth_headers = parts.headers.clone();
    let (authorized, slot) = match tokio::task::spawn_blocking(move || {
        (actor(&auth_state, &auth_headers), slot)
    })
    .await
    {
        Ok((Ok(actor), slot)) => (actor, slot),
        _ => return Refusal::NotFound.response(),
    };
    if single_header(&parts.headers, header::CONTENT_TYPE) != Some("application/json")
        || parts.headers.contains_key(header::TRANSFER_ENCODING)
    {
        return Refusal::Invalid.response();
    }
    if let Err(error) = state.registration.charge() {
        return error.response();
    }
    let bytes = match axum::body::to_bytes(body, 8192).await {
        Ok(b) => b,
        Err(_) => return Refusal::Limit.response(),
    };
    let (selection, token) = match parse(&parts.uri, &bytes, confirm) {
        Ok(i) => i,
        Err(e) => return e.response(),
    };
    let cancel = Cancel(Arc::new(AtomicBool::new(false)));
    let flag = cancel.0.clone();
    let worker = state.clone();
    let headers = parts.headers.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let _slot = slot;
        if !authorized.same(&actor(&worker, &headers)?) || flag.load(Ordering::Relaxed) {
            return Err(Refusal::NotFound);
        }
        let result = execute(&worker, &headers, authorized, selection, token, flag);
        #[cfg(test)]
        worker.registration.hooks.pause(tests::Phase::Finished);
        if actor(&worker, &headers).is_err() {
            return Err(Refusal::NotFound);
        }
        result
    })
    .await;

    match outcome {
        Ok(Ok(value)) => reply(
            if confirm {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            },
            value,
        ),
        Ok(Err(e)) => e.response(),
        Err(_) => Refusal::Unavailable.response(),
    }
}

fn discovery_error(error: discovery::DiscoveryError) -> Refusal {
    match error {
        discovery::DiscoveryError::UnknownLocation => Refusal::NotFound,
        discovery::DiscoveryError::LimitExceeded => Refusal::Limit,
        discovery::DiscoveryError::RegisteredBoundary(_)
        | discovery::DiscoveryError::IdentityChanged => Refusal::Conflict,
        _ => Refusal::Unavailable,
    }
}
fn single_header(headers: &HeaderMap, name: header::HeaderName) -> Option<&str> {
    let mut fields = headers.get_all(name).iter();
    let value = fields.next()?.to_str().ok()?;
    fields.next().is_none().then_some(value)
}
fn authority(scheme: &str, raw: &str) -> Option<reqwest::Url> {
    // why: URL origin equality discards userinfo/path and repairs wire spellings.
    // Validate the literal authority before using the parser for tuple comparison.
    if raw.is_empty()
        || !raw.is_ascii()
        || raw.bytes().any(|b| {
            b.is_ascii_control()
                || b.is_ascii_whitespace()
                || matches!(b, b'/' | b'\\' | b'?' | b'#' | b'@' | b'%')
        })
    {
        return None;
    }
    let (host, port, ipv6) = if let Some(rest) = raw.strip_prefix('[') {
        let (host, suffix) = rest.split_once(']')?;
        host.parse::<std::net::Ipv6Addr>().ok()?;
        let port = if suffix.is_empty() {
            None
        } else {
            Some(suffix.strip_prefix(':')?)
        };
        (host, port, true)
    } else {
        let (host, port) = raw
            .split_once(':')
            .map_or((raw, None), |(h, p)| (h, Some(p)));
        (host, port, false)
    };
    if host.is_empty() {
        return None;
    }
    if let Some(port) = port
        && (port.is_empty()
            || !port.bytes().all(|b| b.is_ascii_digit())
            || port.parse::<u16>().is_err())
    {
        return None;
    }
    let parsed = reqwest::Url::parse(&format!("{scheme}://{raw}")).ok()?;
    // why: noncanonical numeric IPv4, percent/IDNA repair and delimiter insertion
    // must not acquire authority; valid IPv6 compression/case is parsed strictly above.
    if !ipv6 && !parsed.host_str()?.eq_ignore_ascii_case(host) {
        return None;
    }
    Some(parsed)
}
fn origin(headers: &HeaderMap) -> bool {
    let Some(host) = single_header(headers, header::HOST) else {
        return false;
    };
    let Some(raw) = single_header(headers, header::ORIGIN) else {
        return false;
    };
    if headers.get_all("sec-fetch-site").iter().count() > 1
        || (headers.contains_key("sec-fetch-site")
            && single_header(headers, header::HeaderName::from_static("sec-fetch-site"))
                .is_none_or(|value| value == "cross-site"))
    {
        return false;
    }
    let Some((scheme, rest)) = raw.split_once("://") else {
        return false;
    };
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return false;
    }
    // An ordinary single trailing slash is historically accepted. No other raw path,
    // including dot/encoded-dot/backslash paths a URL parser reduces to '/', is permitted.
    let Some(origin) = authority(scheme, rest.strip_suffix('/').unwrap_or(rest)) else {
        return false;
    };
    authority(origin.scheme(), host).is_some_and(|expected| origin.origin() == expected.origin())
}
fn config_parent(path: &std::path::Path) -> Result<(std::os::fd::OwnedFd, String), Refusal> {
    if !limits::server_path(path) {
        return Err(Refusal::Limit);
    }
    let name = path
        .file_name()
        .and_then(|p| p.to_str())
        .ok_or(Refusal::Unavailable)?
        .to_string();
    let parent = path
        .parent()
        .ok_or(Refusal::Unavailable)?
        .canonicalize()
        .map_err(|_| Refusal::Unavailable)?;
    let fd = rustix::fs::openat2(
        rustix::fs::CWD,
        parent,
        rustix::fs::OFlags::RDONLY
            | rustix::fs::OFlags::DIRECTORY
            | rustix::fs::OFlags::NOFOLLOW
            | rustix::fs::OFlags::CLOEXEC,
        rustix::fs::Mode::empty(),
        rustix::fs::ResolveFlags::NO_SYMLINKS | rustix::fs::ResolveFlags::NO_MAGICLINKS,
    )
    .map_err(|_| Refusal::Unavailable)?;
    Ok((fd, name))
}
fn checked_config(
    state: &AppState,
    fd: &std::os::fd::OwnedFd,
    name: &str,
) -> Result<(crate::ServerConfig, storage::FileState, Vec<Arc<Vault>>), Refusal> {
    let (stamp, bytes) =
        storage::read_optional(fd, name, storage::MAX_FILE)?.ok_or(Refusal::Unavailable)?;
    let config =
        crate::ServerConfig::parse(std::str::from_utf8(&bytes).map_err(|_| Refusal::Unavailable)?)
            .map_err(|_| Refusal::Unavailable)?;
    if config.vaults.len() > limits::MAX_REGISTERED
        || config.vault_locations.len() > limits::MAX_LOCATIONS
    {
        return Err(Refusal::Limit);
    }
    let registered = state.vaults.try_read().map_err(|_| Refusal::Busy)?;
    if config.vaults.len() != registered.len() {
        return Err(Refusal::Conflict);
    }
    let home = std::env::var_os("HOME");
    let mut seen = std::collections::HashSet::new();
    for entry in &config.vaults {
        let slug = Slug::parse(&entry.slug).map_err(|_| Refusal::Unavailable)?;
        if !seen.insert(slug.clone()) {
            return Err(Refusal::Conflict);
        }
        let vault = registered.get(&slug).ok_or(Refusal::Conflict)?;
        if crate::config::expand_home(&entry.path, home.as_deref()) != vault.root()
            || entry.notes_layout != vault.notes_layout()
            || entry.ignore_non_writable_folders != vault.ignore_non_writable_folders()
        {
            return Err(Refusal::Conflict);
        }
    }
    Ok((config, stamp, registered.values().cloned().collect()))
}
fn pin(
    config: &crate::ServerConfig,
    selection: &Selection,
    vaults: &[Arc<Vault>],
) -> Result<discovery::RegistrationPin, Refusal> {
    discovery::registration_pin(
        config,
        &selection.id,
        &selection.path,
        selection.child.as_ref(),
        &vaults.iter().map(Arc::as_ref).collect::<Vec<_>>(),
    )
    .map_err(discovery_error)
}
fn execute(
    state: &AppState,
    headers: &HeaderMap,
    authorized: Actor,
    selection: Selection,
    token: Option<String>,
    cancel: Arc<AtomicBool>,
) -> Result<serde_json::Value, Refusal> {
    let management = state.management.as_ref().ok_or(Refusal::NotFound)?;
    let _writer = management.writer.try_lock().map_err(|_| Refusal::Busy)?;
    let ensure = || {
        if !authorized.same(&actor(state, headers)?) {
            return Err(Refusal::NotFound);
        }
        Ok(())
    };
    let active = || {
        ensure()?;
        if cancel.load(Ordering::Relaxed) {
            return Err(Refusal::Busy);
        }
        Ok(())
    };
    // why: reauthenticate after management admission, before any config or filesystem work.
    #[cfg(test)]
    state.registration.hooks.pause(tests::Phase::BeforeFs);
    active()?;
    #[cfg(test)]
    state
        .registration
        .hooks
        .before_fs
        .fetch_add(1, Ordering::Relaxed);
    let (parent, config_name) = config_parent(&management.config)?;
    let (mut config, config_stamp, vaults) = checked_config(state, &parent, &config_name)?;
    if config.vaults.len() >= limits::MAX_REGISTERED {
        return Err(Refusal::Limit);
    }
    if config
        .vaults
        .iter()
        .any(|v| v.slug == selection.slug.as_str())
    {
        return Err(Refusal::Conflict);
    }
    let current = pin(&config, &selection, &vaults)?;
    let existing_layout = if selection.child.is_none() {
        Some(storage::layout(current.fd())?.0)
    } else {
        None
    };
    let now = state.registration.now()?;
    let deadline;
    if let Some(token) = token {
        let receipt = {
            let mut receipts = state
                .registration
                .receipts
                .lock()
                .map_err(|_| Refusal::Busy)?;
            receipts.retain(|_, r| r.expires > now);
            receipts
                .remove(&digest(token.as_bytes()))
                .ok_or(Refusal::Conflict)?
        };
        if !receipt.actor.same(&authorized)
            || receipt.selection != selection
            || receipt.config != config_stamp
            || receipt.layout != existing_layout
            || !receipt
                .pin
                .same_identity(&current)
                .map_err(discovery_error)?
        {
            return Err(Refusal::Conflict);
        }
        deadline = receipt.expires;
    } else {
        if let Some(layout) = &existing_layout {
            storage::usable(
                current.fd(),
                layout,
                selection.ignore_non_writable_folders,
                active,
            )?;
        } else {
            active()?;
            storage::probe(current.fd())?;
        }
        let after = pin(&config, &selection, &vaults)?;
        if !current.same_identity(&after).map_err(discovery_error)?
            || (selection.child.is_none()
                && storage::layout(current.fd())?.0
                    != existing_layout.clone().ok_or(Refusal::Conflict)?)
        {
            return Err(Refusal::Conflict);
        }
        active()?;
        let token = random()?;
        let notes_root = "root";
        let now = state.registration.now()?;
        let mut receipts = state
            .registration
            .receipts
            .lock()
            .map_err(|_| Refusal::Busy)?;
        receipts.retain(|_, r| r.expires > now);
        if receipts.len() >= RECEIPTS {
            return Err(Refusal::Busy);
        }
        let existing = selection.child.is_none();
        let mode = if existing { "existing" } else { "new" };
        let scope = if existing {
            "existing-project"
        } else {
            "existing-parent"
        };
        receipts.insert(
            digest(token.as_bytes()),
            Receipt {
                actor: authorized,
                selection,
                expires: now + TTL,
                config: config_stamp,
                pin: current,
                layout: existing_layout,
            },
        );
        return Ok(
            serde_json::json!({"confirmation":token,"expires_in_seconds":120,"mode":mode,"notes_root":notes_root,"read_only":false,"storage_check":"bounded_service_identity_probes","scope":scope,"recursive_markdown":existing}),
        );
    }
    #[cfg(test)]
    state.registration.hooks.pause(tests::Phase::BeforeMutation);
    active()?;
    let mut new_root = selection
        .child
        .as_ref()
        .map(|child| storage::OwnedDirectory::create(current.fd(), child.as_str()))
        .transpose()?;
    let root_path = selection.child.as_ref().map_or_else(
        || current.path().to_path_buf(),
        |child| current.path().join(child.as_str()),
    );
    let root = new_root.as_ref().map_or(current.fd(), |r| &r.fd);
    // Persistent preparation has started. Cancellation no longer interrupts coherent commit;
    // failures/revocations still clean only artifacts this operation owns.
    let mut policy_file: Option<storage::OwnedFile> = None;
    let prepared = (|| {
        ensure()?;
        let (before_layout, policy) = storage::layout(root)?;
        if selection.child.is_some() && before_layout.notes.is_some() {
            return Err(Refusal::Conflict);
        }
        if selection.child.is_none() && Some(&before_layout) != existing_layout.as_ref() {
            return Err(Refusal::Conflict);
        }
        storage::usable(
            root,
            &before_layout,
            selection.ignore_non_writable_folders,
            ensure,
        )?;
        let signal = Arc::new(WatchSignal::default());
        let (watcher, problems) = crate::watch::watch_for_vault(
            &root_path,
            signal.clone(),
            selection.ignore_non_writable_folders,
        );
        if !problems.is_empty() {
            return Err(Refusal::Unavailable);
        }
        #[cfg(test)]
        {
            *state
                .registration
                .hooks
                .staged
                .lock()
                .map_err(|_| Refusal::Unavailable)? = Some(signal);
        }
        // why: enumerate again after enrollment. Maintenance cannot consume staged
        // events before the new vault exists in the live registry.
        let notes = storage::usable(
            root,
            &before_layout,
            selection.ignore_non_writable_folders,
            ensure,
        )?;
        #[cfg(test)]
        state
            .registration
            .hooks
            .pause(tests::Phase::AfterStorageCheck);
        let policy = match policy {
            Some(policy) => policy,
            None => {
                ensure()?;
                let policy = mb_core::Access::new(
                    vec![mb_core::Member {
                        user: authorized.username.clone(),
                        role: mb_core::Role::Owner,
                    }],
                    vec![],
                )
                .map_err(|_| Refusal::Unavailable)?;
                let bytes = AccessFile::from_access(policy.clone())
                    .to_toml()
                    .map_err(|_| Refusal::Unavailable)?;
                #[cfg(test)]
                let policy_fault = *state
                    .registration
                    .hooks
                    .policy_fault
                    .lock()
                    .map_err(|_| Refusal::Unavailable)?;
                #[cfg(test)]
                let prepared_policy = storage::test_io::at_boundary(policy_fault, || {
                    storage::OwnedFile::create(root, bytes.as_bytes())
                })?;
                #[cfg(not(test))]
                let prepared_policy = storage::OwnedFile::create(root, bytes.as_bytes())?;
                policy_file = Some(prepared_policy);
                // why: NOREPLACE never overwrites a policy another tool installed meanwhile.
                #[cfg(test)]
                state.registration.hooks.pause(tests::Phase::BeforePolicy);
                ensure()?;
                let prepared_policy = policy_file.as_mut().ok_or(Refusal::Unavailable)?;
                #[cfg(test)]
                storage::test_io::at_boundary(policy_fault, || {
                    prepared_policy.rename_missing("access.toml")
                })?;
                #[cfg(not(test))]
                prepared_policy.rename_missing("access.toml")?;
                policy
            }
        };
        if let Some(file) = &policy_file
            && !file.matches_owned_bytes()?
        {
            return Err(Refusal::Conflict);
        }
        let prepared_layout = storage::layout(root)?.0;
        // why: the parsed policy and the stamp published with it must describe the same
        // bytes. An external edit during probes must not be blessed as our prepared ACL.
        let same_policy = match &policy_file {
            Some(file) => prepared_layout
                .policy
                .as_ref()
                .map(|state| file.matches_state(state))
                .transpose()?
                .unwrap_or(false),
            None => before_layout.policy == prepared_layout.policy,
        };
        if !before_layout.same_storage(&prepared_layout) || !same_policy {
            return Err(Refusal::Conflict);
        }
        let mut index = storage::initial_index(root, &prepared_layout, &notes)?;
        index
            .replace_zones(&policy)
            .map_err(|_| Refusal::Unavailable)?;
        let vault = Arc::new(
            Vault::open_with_layout(
                selection.slug.clone(),
                &selection.name,
                &root_path,
                crate::config::NotesLayout::Root,
            )
            .map_err(|_| Refusal::Unavailable)?
            .with_non_writable_folders_ignored(selection.ignore_non_writable_folders),
        );

        ensure()?;
        let final_selection = if let Some(child) = &selection.child {
            Selection {
                path: selection.path.child(child),
                child: None,
                ..selection.clone()
            }
        } else {
            selection.clone()
        };
        let final_pin = pin(&config, &final_selection, &vaults)?;
        current
            .revalidate(&selection.path)
            .map_err(discovery_error)?;
        if storage::identity(root)? != storage::identity(final_pin.fd())?
            || storage::layout(root)?.0 != prepared_layout
        {
            return Err(Refusal::Conflict);
        }
        config.vaults.push(crate::config::VaultEntry {
            notes_layout: crate::config::NotesLayout::Root,
            ignore_non_writable_folders: selection.ignore_non_writable_folders,
            slug: selection.slug.to_string(),
            name: Some(selection.name.clone()),
            path: root_path.to_str().ok_or(Refusal::Unavailable)?.into(),
            media: crate::MediaBackendConfig::Local,
        });
        let bytes = config.to_toml().map_err(|_| Refusal::Unavailable)?;
        if bytes.len() > storage::MAX_FILE {
            return Err(Refusal::Limit);
        }
        ensure()?;
        #[cfg(test)]
        let mut config_file = storage::test_io::at_boundary(
            *state
                .registration
                .hooks
                .config_fault
                .lock()
                .map_err(|_| Refusal::Unavailable)?,
            || storage::OwnedFile::create(&parent, bytes.as_bytes()),
        )?;
        #[cfg(not(test))]
        let mut config_file = storage::OwnedFile::create(&parent, bytes.as_bytes())?;
        #[cfg(test)]
        state.registration.hooks.pause(tests::Phase::BeforeCommit);
        // All publication locks are acquired before rename, only after expensive preparation.
        let mut relay = watcher.signal.lock().map_err(|_| Refusal::Unavailable)?;
        let mut registered = state.vaults.write().map_err(|_| Refusal::Unavailable)?;
        let mut policies = state
            .security
            .access
            .write()
            .map_err(|_| Refusal::Unavailable)?;
        let mut indexes = state
            .indexes
            .indexes
            .write()
            .map_err(|_| Refusal::Unavailable)?;
        let mut watching = state.watchers.0.lock().map_err(|_| Refusal::Unavailable)?;
        let live = watching.as_mut().ok_or(Refusal::Unavailable)?;
        if live.roots.len() > limits::MAX_REGISTERED || registered.contains_key(&selection.slug) {
            return Err(Refusal::Conflict);
        }
        // why: revoke/demote/disable cannot linearize between the final authority check,
        // atomic rename and coherent publication. No recursive work runs under this lock.
        let auth = state.security.auth.lock().map_err(|_| Refusal::NotFound)?;
        if !authorized.same(&signed_actor(&auth, registration_cookie(headers)?)?) {
            return Err(Refusal::NotFound);
        }
        let unchanged = storage::read_optional(&parent, &config_name, storage::MAX_FILE)?
            .is_some_and(|(s, _)| s == config_stamp);
        if !unchanged
            || storage::layout(root)?.0 != prepared_layout
            || state.registration.now()? >= deadline
        {
            return Err(Refusal::Conflict);
        }
        current
            .revalidate(&selection.path)
            .map_err(discovery_error)?;
        final_pin
            .revalidate(&final_selection.path)
            .map_err(discovery_error)?;
        let (current_parent, current_name) = config_parent(&management.config)?;
        if current_name != config_name
            || storage::identity(&current_parent)? != storage::identity(&parent)?
        {
            return Err(Refusal::Conflict);
        }
        if !config_file.matches_owned_bytes()? {
            return Err(Refusal::Conflict);
        }
        #[cfg(test)]
        state
            .registration
            .hooks
            .pause(tests::Phase::FinalAuthorization);
        // why: namespace/policy edits can occur during the final authority boundary too.
        // Revalidate only bounded selected-root layout here, never recursive work under
        // publication locks. Pinned descriptors do not freeze a malicious filesystem owner.
        if storage::layout(root)?.0 != prepared_layout || state.registration.now()? >= deadline {
            return Err(Refusal::Conflict);
        }
        #[cfg(test)]
        let directory_synced = storage::test_io::at_boundary(
            *state
                .registration
                .hooks
                .commit_fault
                .lock()
                .map_err(|_| Refusal::Unavailable)?,
            || config_file.commit_config(&config_name),
        )?;
        #[cfg(not(test))]
        let directory_synced = config_file.commit_config(&config_name)?;
        #[cfg(test)]
        state.registration.hooks.pause(tests::Phase::AfterCommit);
        // COMMITTED: no fallible rollback from here. A disappearing HTTP waiter cannot
        // strand persistent registry without the prepared policy/index/watcher live state.
        if let Some(file) = &mut policy_file {
            file.retain();
        }
        policies.insert(
            selection.slug.clone(),
            VaultAccess {
                policy: Arc::new(policy),
                source: prepared_layout.policy.as_ref().map(|file| file.stamp),
            },
        );
        indexes.insert(selection.slug.clone(), Arc::new(Mutex::new(index)));
        registered.insert(selection.slug.clone(), vault.clone());
        let queued = relay.take();
        *relay = live.signal.clone();
        live.signal.merge(queued);
        drop(relay);
        if !live.roots.contains_key(&root_path) {
            live.roots.insert(root_path.clone(), watcher);
        }
        drop(watching);
        drop(indexes);
        drop(policies);
        drop(registered);
        drop(auth);
        #[cfg(test)]
        state.registration.hooks.pause(tests::Phase::Published);
        // why: audit_note's inherited optional-writer no-op is not an appended event.
        // Absence or actual append failure changes only this postcommit receipt flag.
        let audited = state.security.audit.is_some()
            && state
                .audit_note(
                    AuditAction::VaultCreated,
                    &authorized.username,
                    &vault,
                    selection.slug.as_str(),
                )
                .is_ok();
        Ok(
            serde_json::json!({"slug":selection.slug.as_str(),"committed":true,"index_ready":true,"index_storage":"memory_until_restart","watched":true,"directory_synced":directory_synced,"audit_recorded":audited}),
        )
    })();
    match prepared {
        Ok(value) => {
            if let Some(root) = &mut new_root {
                root.retain();
            }
            Ok(value)
        }
        Err(error) => {
            let policy_clean = policy_file.as_mut().is_none_or(|f| f.cleanup().is_ok());
            let root_clean = new_root.as_mut().is_none_or(|r| r.cleanup().is_ok());
            if policy_clean && root_clean {
                Err(error)
            } else {
                Err(Refusal::Residual)
            }
        }
    }
}

#[cfg(test)]
mod tests;
