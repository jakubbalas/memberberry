//! E29 read-only administration. No registration authority or content ACL bypass.
use super::*;
#[cfg(target_os = "linux")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "linux")]
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

#[cfg(target_os = "linux")]
#[derive(Debug)]
pub(super) struct DiscoveryGate {
    slots: Arc<Semaphore>,
    rate: Mutex<DiscoveryRate>,
    #[cfg(test)]
    before_fs: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    pause: Mutex<
        Option<(
            tokio::sync::oneshot::Sender<()>,
            std::sync::mpsc::Receiver<()>,
        )>,
    >,
}
#[cfg(target_os = "linux")]
#[derive(Debug)]
struct DiscoveryRate {
    window: std::time::Instant,
    used: u32,
}
#[cfg(target_os = "linux")]
impl DiscoveryRate {
    fn allow_at(&mut self, now: std::time::Instant) -> bool {
        if now.saturating_duration_since(self.window) >= std::time::Duration::from_secs(60) {
            self.window = now;
            self.used = 0;
        }
        if self.used >= 60 {
            return false;
        }
        self.used += 1;
        true
    }
}
#[cfg(target_os = "linux")]
impl DiscoveryGate {
    pub(super) fn new() -> Self {
        Self {
            slots: Arc::new(Semaphore::new(2)),
            rate: Mutex::new(DiscoveryRate {
                window: std::time::Instant::now(),
                used: 0,
            }),
            #[cfg(test)]
            before_fs: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(test)]
            pause: Mutex::new(None),
        }
    }
    fn enter(&self) -> Result<OwnedSemaphorePermit, Refusal> {
        let permit = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Refusal::Busy)?;
        if !self
            .rate
            .lock()
            .map_err(|_| Refusal::Busy)?
            .allow_at(std::time::Instant::now())
        {
            return Err(Refusal::Busy);
        }
        Ok(permit)
    }
}
// why: cancelling the async waiter must not release a running blocking job's slot.
// The job owns its permit; cancellation is cooperative between bounded filesystem steps.
#[cfg(target_os = "linux")]
struct Cancel(Arc<AtomicBool>);
#[cfg(target_os = "linux")]
impl Drop for Cancel {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}
#[derive(Clone, Copy)]
enum Operation {
    Locations,
    Directories,
    Status,
}
#[derive(Clone, Copy, Debug)]
pub(super) enum Refusal {
    NotFound,
    #[cfg(target_os = "linux")]
    Invalid,
    #[cfg(target_os = "linux")]
    Limit,
    #[cfg(target_os = "linux")]
    Busy,
}
impl Refusal {
    fn response(self) -> Response {
        let (code, error) = match self {
            Self::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            #[cfg(target_os = "linux")]
            Self::Invalid => (StatusCode::BAD_REQUEST, "invalid_request"),
            #[cfg(target_os = "linux")]
            Self::Limit => (StatusCode::UNPROCESSABLE_ENTITY, "limit_exceeded"),
            #[cfg(target_os = "linux")]
            Self::Busy => (StatusCode::TOO_MANY_REQUESTS, "busy"),
        };
        let mut response = (code, Json(serde_json::json!({"error":error}))).into_response();
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        response
    }
}
// why: resolve the signed session and current enabled admin together in the real auth
// store, rather than two username/role lookups or trusting a client-supplied identity.
fn administrator(state: &AppState, headers: &HeaderMap) -> bool {
    if headers.contains_key(header::AUTHORIZATION) {
        return false;
    }
    let Some(cookie) = session_cookie(headers) else {
        return false;
    };
    state
        .security
        .auth
        .lock()
        .ok()
        .and_then(|auth| {
            auth.authenticate_signed_session_cookie(cookie)
                .ok()
                .flatten()
        })
        .is_some_and(|user| user.is_admin && !user.disabled)
}
pub(super) async fn locations(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    uri: axum::http::Uri,
) -> Response {
    handle(state, headers, uri, Operation::Locations).await
}
pub(super) async fn directories(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    uri: axum::http::Uri,
) -> Response {
    handle(state, headers, uri, Operation::Directories).await
}
pub(super) async fn status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    uri: axum::http::Uri,
) -> Response {
    handle(state, headers, uri, Operation::Status).await
}
async fn handle(
    state: Arc<AppState>,
    headers: HeaderMap,
    uri: axum::http::Uri,
    operation: Operation,
) -> Response {
    // why: even malformed inputs and unavailable configuration are invisible to non-admins.
    if !administrator(&state, &headers) {
        return Refusal::NotFound.response();
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (uri, operation);
        Refusal::NotFound.response()
    }
    #[cfg(target_os = "linux")]
    {
        let request = match parse_request(&uri, &headers, operation) {
            Ok(r) => r,
            Err(e) => return e.response(),
        };
        if state.management.is_none() {
            return Refusal::NotFound.response();
        }
        let permit = match state.discovery.enter() {
            Ok(p) => p,
            Err(e) => return e.response(),
        };
        let cancel = Cancel(Arc::new(AtomicBool::new(false)));
        let flag = cancel.0.clone();
        let worker_state = state.clone();
        let worker_headers = headers.clone();
        let result = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            if !administrator(&worker_state, &worker_headers) || flag.load(Ordering::Relaxed) {
                return Err(Refusal::NotFound);
            }
            read(&worker_state, request, flag)
        })
        .await;
        // why: an account demoted/revoked during a request must not receive publication.
        if !administrator(&state, &headers) {
            return Refusal::NotFound.response();
        }
        match result {
            Ok(Ok(bytes)) => {
                let mut response = (
                    [
                        (header::CONTENT_TYPE, "application/json"),
                        (header::CACHE_CONTROL, "no-store"),
                    ],
                    bytes,
                )
                    .into_response();
                response.headers_mut().insert(
                    header::X_CONTENT_TYPE_OPTIONS,
                    HeaderValue::from_static("nosniff"),
                );
                response
            }
            Ok(Err(e)) => e.response(),
            Err(_) => Refusal::NotFound.response(),
        }
    }
}

#[cfg(target_os = "linux")]
use crate::vault_locations::{RelativeDirectoryPath, VaultLocationId, discovery, limits::*};
#[cfg(target_os = "linux")]
struct Request {
    operation: Operation,
    id: Option<VaultLocationId>,
    path: RelativeDirectoryPath,
}
#[cfg(target_os = "linux")]
pub(super) fn decode(raw: &str) -> Result<String, Refusal> {
    let mut out = Vec::with_capacity(raw.len());
    let bytes = raw.as_bytes();
    let mut i = 0;
    while let Some(&b) = bytes.get(i) {
        match b {
            b'%' => {
                let a = bytes
                    .get(i + 1)
                    .and_then(|b| char::from(*b).to_digit(16))
                    .ok_or(Refusal::Invalid)?;
                let b = bytes
                    .get(i + 2)
                    .and_then(|b| char::from(*b).to_digit(16))
                    .ok_or(Refusal::Invalid)?;
                out.push((a * 16 + b) as u8);
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1
            }
            _ => {
                out.push(b);
                i += 1
            }
        }
    }
    String::from_utf8(out).map_err(|_| Refusal::Invalid)
}
#[cfg(target_os = "linux")]
fn parse_request(
    uri: &axum::http::Uri,
    headers: &HeaderMap,
    operation: Operation,
) -> Result<Request, Refusal> {
    if uri.path().len() > 256 || uri.query().is_some_and(|q| q.len() > 4096) {
        return Err(Refusal::Limit);
    }
    if headers.contains_key(header::TRANSFER_ENCODING)
        || headers
            .get(header::CONTENT_LENGTH)
            .is_some_and(|v| v != "0")
    {
        return Err(Refusal::Invalid);
    }
    let id = if matches!(operation, Operation::Locations) {
        None
    } else {
        let raw = uri
            .path()
            .strip_prefix("/api/v1/vault-locations/")
            .and_then(|p| p.split_once('/'))
            .map(|(id, _)| id)
            .ok_or(Refusal::Invalid)?;
        Some(VaultLocationId::parse(raw).map_err(|_| Refusal::Invalid)?)
    };
    let raw = match uri.query() {
        None | Some("") => "",
        Some(_) if matches!(operation, Operation::Locations) => return Err(Refusal::Invalid),
        Some(query) => query
            .strip_prefix("path=")
            .filter(|q| !q.contains('&'))
            .ok_or(Refusal::Invalid)?,
    };
    let path = decode(raw)?;
    if !token(&path) {
        return Err(Refusal::Limit);
    }
    Ok(Request {
        operation,
        id,
        path: RelativeDirectoryPath::for_browse(&path).map_err(|_| Refusal::Invalid)?,
    })
}
#[cfg(target_os = "linux")]
fn load_config(path: &std::path::Path) -> Result<crate::ServerConfig, Refusal> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    if !server_path(path) {
        return Err(Refusal::Limit);
    }
    // why: a FIFO/device must not turn a bounded config read into an indefinite workload.
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32)
        .open(path)
        .map_err(|_| Refusal::NotFound)?;
    let meta = file.metadata().map_err(|_| Refusal::NotFound)?;
    if !meta.is_file() {
        return Err(Refusal::NotFound);
    }
    if meta.len() > 1024 * 1024 {
        return Err(Refusal::Limit);
    }
    let mut bytes = Vec::new();
    file.take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Refusal::NotFound)?;
    if bytes.len() > 1024 * 1024 {
        return Err(Refusal::Limit);
    }
    crate::ServerConfig::parse(std::str::from_utf8(&bytes).map_err(|_| Refusal::NotFound)?)
        .map_err(|_| Refusal::NotFound)
}
#[cfg(target_os = "linux")]
fn read(state: &AppState, request: Request, cancel: Arc<AtomicBool>) -> Result<Vec<u8>, Refusal> {
    let management = state.management.as_ref().ok_or(Refusal::NotFound)?;
    let _writer = management.writer.try_lock().map_err(|_| Refusal::Busy)?;
    let registry = state.vaults.try_read().map_err(|_| Refusal::Busy)?;
    if registry.len() > MAX_REGISTERED {
        return Err(Refusal::Limit);
    }
    #[cfg(test)]
    state.discovery.before_fs.fetch_add(1, Ordering::Relaxed);
    #[cfg(test)]
    if let Some((ready, release)) = state
        .discovery
        .pause
        .lock()
        .map_err(|_| Refusal::Busy)?
        .take()
    {
        let _ = ready.send(());
        release.recv().map_err(|_| Refusal::Busy)?;
    }
    if cancel.load(Ordering::Relaxed) {
        return Err(Refusal::Busy);
    }
    let config = load_config(&management.config)?;
    if config.vault_locations.len() > MAX_LOCATIONS || config.vaults.len() > MAX_REGISTERED {
        return Err(Refusal::Limit);
    }
    // why: disk-only or live-only registrations must never silently remove a boundary.
    if config.vaults.len() != registry.len() {
        return Err(Refusal::NotFound);
    }
    let home = std::env::var_os("HOME");
    let mut seen = std::collections::HashSet::new();
    for entry in &config.vaults {
        if !seen.insert(&entry.slug) {
            return Err(Refusal::NotFound);
        }
        let slug = Slug::parse(&entry.slug).map_err(|_| Refusal::NotFound)?;
        let vault = registry.get(&slug).ok_or(Refusal::NotFound)?;
        if crate::config::expand_home(&entry.path, home.as_deref()) != vault.root()
            || entry.notes_layout != vault.notes_layout()
            || entry.ignore_non_writable_folders != vault.ignore_non_writable_folders()
        {
            return Err(Refusal::NotFound);
        }
    }
    let mut metadata_bytes = 64;
    for location in &config.vault_locations {
        if location.name().len() > 256 || !server_path(location.path()) {
            return Err(Refusal::Limit);
        }
        metadata_bytes += 6 * (location.id().as_str().len() + location.name().len()) + 64;
        if metadata_bytes > 32 * 1024 {
            return Err(Refusal::Limit);
        }
    }
    let value = if matches!(request.operation, Operation::Locations) {
        serde_json::json!({"locations":config.vault_locations.iter().map(|l|serde_json::json!({"id":l.id().as_str(),"name":l.name()})).collect::<Vec<_>>()})
    } else {
        let id = request.id.ok_or(Refusal::Invalid)?;
        let vaults = registry.values().map(|v| v.as_ref()).collect::<Vec<_>>();
        if cancel.load(Ordering::Relaxed) {
            return Err(Refusal::Busy);
        }
        let error = |e| match e {
            discovery::DiscoveryError::LimitExceeded => Refusal::Limit,
            _ => Refusal::NotFound,
        };
        match request.operation {
            Operation::Directories => {
                let listing = discovery::list_cancellable(
                    &config,
                    &id,
                    &request.path,
                    &vaults,
                    cancel.clone(),
                )
                .map_err(error)?;
                serde_json::json!({"path":request.path.as_str(),"state":folder_state(listing.state),"children":listing.children.into_iter().map(|c|serde_json::json!({"name":c.name.as_str(),"path":c.path.as_str(),"state":folder_state(c.state)})).collect::<Vec<_>>()})
            }
            Operation::Status => {
                let state = discovery::inspect_cancellable(
                    &config,
                    &id,
                    &request.path,
                    &vaults,
                    cancel.clone(),
                )
                .map_err(error)?;
                serde_json::json!({"path":request.path.as_str(),"state":folder_state(state)})
            }
            Operation::Locations => return Err(Refusal::Invalid),
        }
    };
    if cancel.load(Ordering::Relaxed) {
        return Err(Refusal::Busy);
    }
    bounded_json(&value)
}
#[cfg(target_os = "linux")]
fn folder_state(state: discovery::FolderState) -> serde_json::Value {
    let registration = match state.registration {
        discovery::RegistrationStatus::Available => "available",
        discovery::RegistrationStatus::AlreadyRegistered => "already_registered",
        discovery::RegistrationStatus::InsideRegisteredVault => "inside_registered_vault",
        discovery::RegistrationStatus::ContainsRegisteredVault => "contains_registered_vault",
    };
    serde_json::json!({"location_root":state.location_root,"registration":registration,"selectable":state.selectable(),"browsable":state.browsable()})
}
#[cfg(target_os = "linux")]
fn bounded_json(value: &serde_json::Value) -> Result<Vec<u8>, Refusal> {
    struct Output(Vec<u8>);
    impl std::io::Write for Output {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            if self.0.len().saturating_add(buf.len()) > MAX_RESPONSE_BYTES {
                return Err(std::io::Error::other("response budget"));
            }
            self.0.extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut output = Output(Vec::new());
    serde_json::to_writer(&mut output, value).map_err(|_| Refusal::Limit)?;
    Ok(output.0)
}

#[cfg(all(test, target_os = "linux"))]
mod tests;
