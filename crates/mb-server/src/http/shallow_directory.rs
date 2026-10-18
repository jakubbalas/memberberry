//! E30 content-authorized shallow directory HTTP; no recursive catalog/discovery call.
use super::*;
use crate::repository::{DirectoryError, validate_directory_token};
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::Semaphore;

#[derive(Debug)]
pub(super) struct DirectoryGate {
    slots: Arc<Semaphore>,
    #[cfg(test)]
    hooks: tests::Hooks,
}
impl DirectoryGate {
    pub(super) fn new() -> Self {
        Self {
            slots: Arc::new(Semaphore::new(2)),
            #[cfg(test)]
            hooks: tests::Hooks::default(),
        }
    }
}
struct Cancel(Arc<AtomicBool>);
impl Drop for Cancel {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}
fn refusal(error: DirectoryError) -> Response {
    let status = match error {
        DirectoryError::NotFound => StatusCode::NOT_FOUND,
        DirectoryError::Invalid => StatusCode::BAD_REQUEST,
        DirectoryError::Limit => StatusCode::UNPROCESSABLE_ENTITY,
    };
    (
        status,
        [(header::CACHE_CONTROL, "no-store")],
        Json(serde_json::json!({"error":error.to_string()})),
    )
        .into_response()
}
fn actor(state: &AppState, slug: &Slug, headers: &HeaderMap) -> Result<Username, DirectoryError> {
    state
        .vault_user(slug, headers)
        .ok_or(DirectoryError::NotFound)
}
fn policy(vault: &Vault) -> Result<mb_core::Access, DirectoryError> {
    use std::io::Read;
    use std::os::unix::fs::MetadataExt;
    // why: current durable ACL, capped and nofollow/nonblocking, not a stale catalog grant.
    let fd = rustix::fs::openat2(
        rustix::fs::CWD,
        vault.root().join("access.toml"),
        rustix::fs::OFlags::RDONLY
            | rustix::fs::OFlags::NOFOLLOW
            | rustix::fs::OFlags::NONBLOCK
            | rustix::fs::OFlags::CLOEXEC,
        rustix::fs::Mode::empty(),
        rustix::fs::ResolveFlags::NO_SYMLINKS | rustix::fs::ResolveFlags::NO_MAGICLINKS,
    )
    .map_err(|_| DirectoryError::NotFound)?;
    let mut file = std::fs::File::from(fd);
    let before = file.metadata().map_err(|_| DirectoryError::NotFound)?;
    if !before.is_file() || before.len() > 64 * 1024 {
        return Err(DirectoryError::NotFound);
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(64 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| DirectoryError::NotFound)?;
    let after = file.metadata().map_err(|_| DirectoryError::NotFound)?;
    let stamp = |m: &std::fs::Metadata| {
        (
            m.dev(),
            m.ino(),
            m.len(),
            m.mtime(),
            m.mtime_nsec(),
            m.ctime(),
            m.ctime_nsec(),
        )
    };
    if stamp(&before) != stamp(&after) {
        return Err(DirectoryError::NotFound);
    }
    if bytes.len() > 64 * 1024 {
        return Err(DirectoryError::NotFound);
    }
    let source = std::str::from_utf8(&bytes).map_err(|_| DirectoryError::NotFound)?;
    AccessFile::parse(source)
        .map(|file| file.policy().clone())
        .map_err(|_| DirectoryError::NotFound)
}
fn parse(uri: &axum::http::Uri, headers: &HeaderMap) -> Result<String, DirectoryError> {
    if uri.query().is_some_and(|q| q.len() > 4096) {
        return Err(DirectoryError::Limit);
    }
    if headers.contains_key(header::TRANSFER_ENCODING)
        || headers
            .get_all(header::CONTENT_LENGTH)
            .iter()
            .any(|v| v != "0")
    {
        return Err(DirectoryError::Invalid);
    }
    let raw = match uri.query() {
        None | Some("") => "",
        Some(q) => q
            .strip_prefix("path=")
            .filter(|q| !q.contains('&'))
            .ok_or(DirectoryError::Invalid)?,
    };
    let token = super::vault_discovery::decode(raw).map_err(|_| DirectoryError::Invalid)?;
    validate_directory_token(&token)?;
    Ok(token)
}

pub(super) async fn directory(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    uri: axum::http::Uri,
) -> Response {
    let slug = match uri
        .path()
        .strip_prefix("/api/v1/vaults/")
        .and_then(|s| s.strip_suffix("/directory"))
        .and_then(|s| Slug::parse(s).ok())
    {
        Some(slug) => slug,
        None => return refusal(DirectoryError::NotFound),
    };
    // why: permits include authentication waits, so neither auth nor I/O can create an
    // unbounded blocking queue. Unauthenticated admission overflow is neutral.
    let permit = match state.directory.slots.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => return refusal(DirectoryError::NotFound),
    };
    let cancel = Cancel(Arc::new(AtomicBool::new(false)));
    let flag = cancel.0.clone();
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let user = actor(&state, &slug, &headers)?;
        let token = parse(&uri, &headers)?;
        let vault = state.vault(slug.as_str()).ok_or(DirectoryError::NotFound)?;
        if flag.load(Ordering::Relaxed) {
            return Err(DirectoryError::NotFound);
        }
        let access = policy(&vault)?;
        let view = AuthorizedVault::new(&vault, &access, user.clone());
        #[cfg(test)]
        state
            .directory
            .hooks
            .before_fs
            .fetch_add(1, Ordering::Relaxed);
        let snapshot = view.directory(&token)?;
        #[cfg(test)]
        state.directory.hooks.pause();
        if flag.load(Ordering::Relaxed) || user != actor(&state, &slug, &headers)? {
            return Err(DirectoryError::NotFound);
        }
        let current = policy(&vault)?;
        let view = AuthorizedVault::new(&vault, &current, user.clone());
        snapshot.revalidate(&view)?;
        let bytes = snapshot.json()?;
        if user != actor(&state, &slug, &headers)? {
            return Err(DirectoryError::NotFound);
        }
        Ok(bytes)
    })
    .await;
    match result {
        Ok(Ok(bytes)) => (
            [
                (header::CONTENT_TYPE, "application/json"),
                (header::CACHE_CONTROL, "no-store"),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            ],
            bytes,
        )
            .into_response(),
        Ok(Err(error)) => refusal(error),
        Err(_) => refusal(DirectoryError::NotFound),
    }
}
#[cfg(test)]
mod tests;
