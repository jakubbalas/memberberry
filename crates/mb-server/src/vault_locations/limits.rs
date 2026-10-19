//! Conservative HTTP discovery delivery budgets, not persisted configuration syntax.
//! Exceeding any budget refuses the whole response; no partial listing is published.
pub(crate) const MAX_LOCATIONS: usize = 32;
pub(crate) const MAX_REGISTERED: usize = 128;
pub(crate) const MAX_SERVER_PATH_BYTES: usize = 4096;
pub(crate) const MAX_ANCESTRY: usize = 64;
pub(crate) const MAX_TOKEN_BYTES: usize = 1024;
pub(crate) const MAX_TOKEN_DEPTH: usize = 16;
pub(crate) const MAX_SCANNED: usize = 4096;
pub(crate) const MAX_CHILDREN: usize = 128;
pub(crate) const MAX_RESPONSE_BYTES: usize = 64 * 1024;
pub(crate) const MAX_WORK: usize = 100_000;

pub(crate) fn server_path(path: &std::path::Path) -> bool {
    path.as_os_str().len() <= MAX_SERVER_PATH_BYTES && path.components().count() <= MAX_ANCESTRY
}
pub(crate) fn token(raw: &str) -> bool {
    raw.len() <= MAX_TOKEN_BYTES && (raw.is_empty() || raw.split('/').count() <= MAX_TOKEN_DEPTH)
}
