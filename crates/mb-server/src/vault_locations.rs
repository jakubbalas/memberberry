//! Syntax-only configuration and folder tokens for project-folder vaults (SPEC §6.1).
//!
//! Filesystem discovery is crate-private. Its HTTP callers require a live enabled
//! signed-session administrator and enforce bounded work before accessing storage.
//!
//! ```
//! use mb_server::vault_locations::{DirectoryName, RelativeDirectoryPath};
//! let root = RelativeDirectoryPath::for_browse("")?;
//! let project = root.child(&DirectoryName::parse("日本 📚")?);
//! assert_eq!(project.as_str(), "日本 📚");
//! assert!(RelativeDirectoryPath::for_selection("").is_err());
//! # Ok::<(), mb_server::vault_locations::DirectoryPathError>(())
//! ```

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::{Error, Slug};

#[cfg(target_os = "linux")]
pub(crate) mod limits;

#[cfg(target_os = "linux")]
pub(crate) mod discovery;

/// Stable location identifier, with the same lexical rules as a vault slug.
/// Lowercase ASCII letters, digits and internal hyphens; 1–64 bytes, no normalization.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct VaultLocationId(String);

impl VaultLocationId {
    /// Validates an exact identifier without repairing it.
    ///
    /// # Errors
    /// Returns a configuration error for invalid identifiers.
    pub fn parse(raw: &str) -> Result<Self, Error> {
        Slug::parse(raw).map_err(|_| Error::Config("invalid vault location id".into()))?;
        Ok(Self(raw.into()))
    }

    /// The exact configured identifier.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for VaultLocationId {
    type Error = Error;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

impl From<VaultLocationId> for String {
    fn from(value: VaultLocationId) -> Self {
        value.0
    }
}

/// One validated `[[vault_locations]]` entry. Construction and deserialization do no I/O.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "RawLocation")]
pub struct VaultLocation {
    id: VaultLocationId,
    name: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawLocation {
    id: VaultLocationId,
    name: String,
    path: String,
}

impl TryFrom<RawLocation> for VaultLocation {
    type Error = Error;

    fn try_from(raw: RawLocation) -> Result<Self, Self::Error> {
        Self::new(raw.id, &raw.name, &raw.path)
    }
}

impl VaultLocation {
    /// Validates a display label and an explicit slash-separated absolute server path.
    ///
    /// Labels cannot be blank or contain control characters. Paths cannot contain `~`
    /// expansion, backslashes, controls, dot/traversal components, repeated separators or
    /// trailing separators (except `/` itself). No filesystem lookup or Unicode folding occurs.
    ///
    /// # Errors
    /// Returns a configuration error for an invalid label or path shape.
    pub fn new(id: VaultLocationId, name: &str, path: &str) -> Result<Self, Error> {
        if name.trim().is_empty() || name.chars().any(char::is_control) {
            return Err(Error::Config("invalid vault location name".into()));
        }
        if !Path::new(path).is_absolute()
            || path.contains('\\')
            || path.chars().any(char::is_control)
            || (path != "/"
                && path.strip_prefix('/').is_none_or(|rest| {
                    rest.split('/')
                        .any(|part| part.is_empty() || part == "." || part == "..")
                }))
        {
            return Err(Error::Config(
                "vault location path must be an explicit absolute directory path".into(),
            ));
        }
        Ok(Self {
            id,
            name: name.into(),
            path: path.into(),
        })
    }

    /// Stable configured identifier.
    #[must_use]
    pub fn id(&self) -> &VaultLocationId {
        &self.id
    }

    /// Human-readable label, preserved exactly.
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Absolute server path, preserved exactly. This is not a browser response field.
    #[must_use]
    pub fn path(&self) -> &Path {
        Path::new(&self.path)
    }
}

/// Invalid directory-token syntax. Error messages intentionally do not repeat untrusted input.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum DirectoryPathError {
    /// An empty token is only valid for browsing the configured root.
    #[error("the configured root is browse-only")]
    EmptySelection,
    /// A token contains a hidden, traversal, empty or otherwise unsafe component.
    #[error("invalid relative directory path")]
    InvalidComponent,
}

/// One visible directory component. Unicode, spaces, ordinary colons and literal percent
/// sequences are preserved byte-for-byte; no decoding or normalization occurs.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct DirectoryName(String);

impl DirectoryName {
    /// Validates a single directory name without trimming, decoding or Unicode normalization.
    ///
    /// # Errors
    /// Rejects blank, over-255-byte, dot/hidden, separator, control and ASCII drive-prefixed names.
    /// Ordinary colons and percent-looking text are literal data, never decoded.
    pub fn parse(raw: &str) -> Result<Self, DirectoryPathError> {
        let drive_prefix = raw.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
            && raw.as_bytes().get(1) == Some(&b':');
        if raw.trim().is_empty()
            || raw.len() > 255
            || raw.starts_with('.')
            || drive_prefix
            || raw
                .chars()
                .any(|c| c.is_control() || matches!(c, '/' | '\\'))
        {
            return Err(DirectoryPathError::InvalidComponent);
        }
        Ok(Self(raw.into()))
    }

    /// The exact directory name.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Slash-separated visible directory path relative to one configured location.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelativeDirectoryPath(String);

impl RelativeDirectoryPath {
    /// Validates a browsing token; the empty token denotes the browse-only location root.
    ///
    /// # Errors
    /// Rejects unsafe components and absolute paths without normalizing them.
    pub fn for_browse(raw: &str) -> Result<Self, DirectoryPathError> {
        if !raw.is_empty() {
            for part in raw.split('/') {
                DirectoryName::parse(part)?;
            }
        }
        Ok(Self(raw.into()))
    }

    /// Validates a non-root selection token.
    ///
    /// # Errors
    /// Returns [`DirectoryPathError::EmptySelection`] for the root; otherwise validates
    /// the same syntax as [`Self::for_browse`]. Registration overlap still requires I/O.
    pub fn for_selection(raw: &str) -> Result<Self, DirectoryPathError> {
        if raw.is_empty() {
            return Err(DirectoryPathError::EmptySelection);
        }
        Self::for_browse(raw)
    }

    /// The exact relative token, empty only for the location root.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Whether the token denotes the configured root.
    #[must_use]
    pub fn is_root(&self) -> bool {
        self.0.is_empty()
    }

    /// Appends an already-validated name, preserving the original token.
    #[must_use]
    pub fn child(&self, name: &DirectoryName) -> Self {
        if self.is_root() {
            Self(name.0.clone())
        } else {
            Self(format!("{}/{}", self.0, name.0))
        }
    }
}
