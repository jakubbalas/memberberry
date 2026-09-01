//! Structured audit logging (`SPEC.md` §6.9).
//!
//! Audit records deliberately carry only identifiers and outcomes. Note content, password
//! material and opaque tokens must never be passed to this boundary.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// One security-relevant event written to `audit.log`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AuditEvent<'a> {
    /// UTC timestamp supplied by the operation boundary in RFC 3339 form.
    pub timestamp: &'a str,
    /// Authenticated username, when an actor exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor: Option<&'a str>,
    /// Source IP address, when the operation arrived over the network.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_ip: Option<&'a str>,
    /// Vault slug, when the operation is scoped to one vault.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vault: Option<&'a str>,
    /// The fixed action name.
    pub action: AuditAction,
    /// Opaque identifiers affected by the operation, never note bodies or credentials.
    pub targets: &'a [String],
    /// Whether the action succeeded or was denied/failed.
    pub result: AuditResult,
}

/// Audited action kinds from `SPEC.md` §6.9.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditAction {
    /// An authentication attempt completed.
    Login,
    /// An ACL was changed.
    AccessChanged,
    /// A privileged rename rewrote links or tags.
    PrivilegedRewrite,
    /// A vault was registered.
    VaultCreated,
    /// A vault was unregistered.
    VaultRemoved,
    /// A share link was created, revoked, or accessed.
    ShareLink,
    /// An API token was issued or revoked.
    ApiToken,
    /// A password was reset.
    PasswordReset,
}

/// The outcome of an audit event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditResult {
    /// The requested operation completed.
    Success,
    /// Authorization refused the requested operation.
    Denied,
    /// The operation failed for a non-authorization reason.
    Failure,
}

/// Append-only, size-rotated audit log writer.
#[derive(Debug, Clone)]
pub struct AuditLog {
    path: PathBuf,
    max_bytes: u64,
}

impl AuditLog {
    /// Creates a writer for `<data-dir>/audit.log`.
    ///
    /// `max_bytes` must be non-zero so every append has a well-defined rotation boundary.
    pub fn new(data_dir: &Path, max_bytes: u64) -> Result<Self, AuditError> {
        if max_bytes == 0 {
            return Err(AuditError::InvalidMaxBytes);
        }
        Ok(Self {
            path: data_dir.join("audit.log"),
            max_bytes,
        })
    }

    /// Appends one JSON Line, rotating the existing file before it would exceed the limit.
    pub fn append(&self, event: &AuditEvent<'_>) -> Result<(), AuditError> {
        let mut line = serde_json::to_vec(event).map_err(AuditError::Serialize)?;
        line.push(b'\n');
        self.rotate_if_needed(line.len())?;
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|source| AuditError::Write {
                path: self.path.clone(),
                source,
            })?;
        file.write_all(&line).map_err(|source| AuditError::Write {
            path: self.path.clone(),
            source,
        })
    }

    fn rotate_if_needed(&self, next_line_bytes: usize) -> Result<(), AuditError> {
        let size = match fs::metadata(&self.path) {
            Ok(metadata) => metadata.len(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(source) => {
                return Err(AuditError::Read {
                    path: self.path.clone(),
                    source,
                });
            }
        };
        if size == 0 || size.saturating_add(next_line_bytes as u64) <= self.max_bytes {
            return Ok(());
        }
        let rotated = self.path.with_extension("log.1");
        if rotated.exists() {
            fs::remove_file(&rotated).map_err(|source| AuditError::Rotate {
                path: rotated.clone(),
                source,
            })?;
        }
        fs::rename(&self.path, &rotated).map_err(|source| AuditError::Rotate {
            path: self.path.clone(),
            source,
        })
    }
}

/// Audit log I/O or serialization failed.
#[derive(Debug, thiserror::Error)]
pub enum AuditError {
    /// The configured rotation limit was zero.
    #[error("audit log rotation limit must be greater than zero")]
    InvalidMaxBytes,
    /// JSON serialization failed.
    #[error("serializing audit record: {0}")]
    Serialize(serde_json::Error),
    /// Existing log metadata could not be read.
    #[error("reading audit log {path}: {source}")]
    Read {
        path: PathBuf,
        source: std::io::Error,
    },
    /// A record could not be written.
    #[error("writing audit log {path}: {source}")]
    Write {
        path: PathBuf,
        source: std::io::Error,
    },
    /// A previous log could not be rotated.
    #[error("rotating audit log {path}: {source}")]
    Rotate {
        path: PathBuf,
        source: std::io::Error,
    },
}
