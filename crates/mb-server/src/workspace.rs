//! Workspace layout storage (`SPEC.md` §8.1).
//!
//! One file per `(user, device, vault)` at
//! `<vault>/.memberberry/workspace/<user>/<device>.json`, holding the split/tab tree the
//! browser built. **Never synced** — a phone and a 32" monitor legitimately differ.
//!
//! Two things make this more than a key-value store.
//!
//! **The user segment is derived from the session, never from the request.** A layout is a
//! list of the notes someone has open, which is the same class of data as presence — §6.4 E4
//! already permission-filters awareness precisely because it reveals which note a person is
//! reading. A path keyed only by device, as §8.1 originally specified, is readable by every
//! other member of the vault. There is no route parameter for the user here, so there is
//! nothing to tamper with.
//!
//! **The layout is opaque to this crate.** The server checks that it is JSON and that it is
//! small; the shape belongs to `web/src/shell/workspace-storage.ts`, which validates it
//! against the same invariants the client's operations maintain. Mirroring that recursive
//! model in Rust would be a second definition of well-formed, free to drift from the first.
//!
//! Everything here lives under `.memberberry/`, so Invariant I1 (§22.4) applies: deleting it
//! costs the user their pane arrangement and nothing else.

use std::fs;
use std::path::{Path, PathBuf};

use mb_core::Username;

use crate::Error;

/// The largest layout this server will store.
///
/// why: a layout is a few hundred bytes of tree per open tab, so 256 KB is already absurdly
/// generous. Without a ceiling, an authenticated member can write unbounded data into
/// somebody else's vault directory — a member is trusted to read notes, not to fill a disk.
pub const MAX_LAYOUT_BYTES: usize = 256 * 1024;

/// A client-generated device identifier, validated before it can reach the filesystem.
///
/// Parsed into a type rather than checked at each use (`AGENTS.md` §4.1): this value arrives
/// in a URL and becomes a filename, which is exactly the shape of a traversal bug. A
/// `DeviceId` that exists is one that cannot contain `/`, `\` or `..`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct DeviceId(String);

impl DeviceId {
    /// Parses a device id: 1–64 characters of ASCII alphanumerics, `-` and `_`.
    ///
    /// # Errors
    ///
    /// [`Error::NotFound`] for anything else. Not a distinct "invalid" error, because this
    /// is reached from a URL and a specific complaint tells a prober which of their guesses
    /// was well-formed.
    pub fn parse(raw: &str) -> Result<Self, Error> {
        let valid = !raw.is_empty()
            && raw.len() <= 64
            && raw
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
        if valid {
            Ok(Self(raw.to_string()))
        } else {
            Err(Error::NotFound)
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Layout storage for one vault.
#[derive(Debug, Clone, Copy)]
pub struct WorkspaceStore<'a> {
    vault_root: &'a Path,
}

impl<'a> WorkspaceStore<'a> {
    #[must_use]
    pub fn new(vault_root: &'a Path) -> Self {
        Self { vault_root }
    }

    /// This user's layout for this device, or `None` if they have never saved one.
    ///
    /// # Errors
    ///
    /// [`Error::NotFound`] if the file exists but cannot be read. The caller cannot usefully
    /// distinguish that from "never saved", and the client's answer to both is the same: open
    /// a fresh workspace.
    pub fn load(&self, user: &Username, device: &DeviceId) -> Result<Option<String>, Error> {
        let path = self.path_for(user, device);
        match fs::read_to_string(&path) {
            Ok(layout) => Ok(Some(layout)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(Error::NotFound),
        }
    }

    /// Replaces this user's layout for this device.
    ///
    /// # Errors
    ///
    /// [`Error::NotFound`] if `layout` is not JSON or exceeds [`MAX_LAYOUT_BYTES`], and
    /// [`Error::ReadDir`] if the directory cannot be created or the file cannot be written.
    ///
    /// The JSON check is not schema validation — the shape belongs to the client. It is here
    /// so that whatever is stored is at least parseable, which keeps a bad request from
    /// turning into a file that fails to load for the rest of the vault's life.
    pub fn save(&self, user: &Username, device: &DeviceId, layout: &str) -> Result<(), Error> {
        if layout.len() > MAX_LAYOUT_BYTES {
            return Err(Error::NotFound);
        }
        if serde_json::from_str::<serde_json::Value>(layout).is_err() {
            return Err(Error::NotFound);
        }
        let path = self.path_for(user, device);
        let parent = path.parent().ok_or(Error::NotFound)?;
        fs::create_dir_all(parent).map_err(|source| Error::ReadDir {
            path: parent.to_path_buf(),
            source,
        })?;
        atomic_write(&path, layout.as_bytes())
    }

    /// Forgets this user's layout for this device.
    ///
    /// # Errors
    ///
    /// Never for an absent file — forgetting something that is already gone succeeded.
    pub fn forget(&self, user: &Username, device: &DeviceId) -> Result<(), Error> {
        let path = self.path_for(user, device);
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(source) => Err(Error::ReadDir { path, source }),
        }
    }

    /// The layout file for one user and device.
    ///
    /// Both segments are validated newtypes — `Username` is `[a-z0-9_-]{1,64}` and
    /// `DeviceId` the same with uppercase — so neither can escape this directory. That is
    /// why they are types and not `&str`.
    fn path_for(&self, user: &Username, device: &DeviceId) -> PathBuf {
        self.vault_root
            .join(".memberberry")
            .join("workspace")
            .join(user.as_str())
            .join(format!("{}.json", device.as_str()))
    }
}

/// Writes through a temporary file in the same directory, then renames.
///
/// A layout is cheap to rebuild, so this is not about durability — it is about never leaving
/// a half-written file where the next session will read one. The client treats a malformed
/// layout as "start fresh", which is recoverable but silently loses the arrangement.
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), Error> {
    let temp = path.with_extension("json.tmp");
    let write = |path: &Path| -> Result<(), Error> {
        fs::write(path, bytes).map_err(|source| Error::ReadDir {
            path: path.to_path_buf(),
            source,
        })
    };
    write(&temp)?;
    match fs::rename(&temp, path) {
        Ok(()) => Ok(()),
        Err(source) => {
            // Leaving the temporary file behind would accumulate one per failed save.
            drop(fs::remove_file(&temp));
            Err(Error::ReadDir {
                path: path.to_path_buf(),
                source,
            })
        }
    }
}
