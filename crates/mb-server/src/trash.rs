//! Deleted-note storage and restoration (`SPEC.md` §4.3 and §18.2).
//!
//! Trash is server-owned derived state. The Markdown body is moved rather than copied, so a
//! delete cannot leave two writable copies of one note. Metadata keeps the original identity
//! and actor; history remains keyed by that identity and is therefore retained for the full
//! trash window.

use std::fs;
use std::path::{Path, PathBuf};

use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};

use crate::Vault;
use crate::history::HistoryStore;
use crate::sync;
use crate::vault::valid_note_path;

/// Deleted-note retention period required by the specification.
pub const RETENTION_SECONDS: u64 = 30 * 24 * 60 * 60;

/// Metadata exposed to an authorized trash caller.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TrashEntry {
    /// Opaque identifier used by restore requests.
    pub id: String,
    /// The note's original vault-relative path.
    pub path: String,
    /// Unix seconds when the note was deleted.
    pub deleted_at: u64,
    /// The authenticated actor who deleted it.
    pub actor: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct StoredEntry {
    path: String,
    deleted_at: u64,
    actor: String,
}

/// Errors from moving, listing, or restoring deleted notes.
#[derive(Debug, thiserror::Error)]
pub enum TrashError {
    /// The requested item does not exist or is no longer retained.
    #[error("not found")]
    NotFound,
    /// The original path is occupied, so restoration would overwrite a live note.
    #[error("the original note path is occupied")]
    Occupied,
    /// The filesystem or derived state refused the operation.
    #[error("trash I/O: {0}")]
    Io(String),
}

/// Server-owned trash for one vault.
#[derive(Debug, Clone)]
pub struct TrashStore {
    metadata_root: PathBuf,
    body_root: PathBuf,
    vault_root: PathBuf,
    retention_seconds: u64,
}

impl TrashStore {
    /// Creates a store rooted below `<vault>/.memberberry/trash`.
    #[must_use]
    pub fn new(vault: &Vault) -> Self {
        Self {
            metadata_root: vault.root().join(".memberberry").join("trash"),
            body_root: vault.notes_root().join(".trash"),
            vault_root: vault.root().to_path_buf(),
            retention_seconds: vault.trash_retention_seconds(),
        }
    }

    /// Moves an existing Markdown file into trash and returns its opaque entry.
    pub fn delete(
        &self,
        vault: &Vault,
        path: &str,
        actor: &str,
        now: u64,
    ) -> Result<TrashEntry, TrashError> {
        self.purge(now)?;
        if !valid_note_path(path) {
            return Err(TrashError::NotFound);
        }
        let source = vault.resolve(path).map_err(|_| TrashError::NotFound)?;
        if !source.is_file() {
            return Err(TrashError::NotFound);
        }
        fs::create_dir_all(&self.metadata_root).map_err(io_error)?;
        fs::create_dir_all(&self.body_root).map_err(io_error)?;
        let id = self.issue_id();
        let markdown = self.body_path(&id);
        let metadata = self.metadata_path(&id);
        fs::rename(&source, &markdown).map_err(io_error)?;
        let stored = StoredEntry {
            path: path.to_string(),
            deleted_at: now,
            actor: actor.to_string(),
        };
        if let Err(error) = write_json(&metadata, &stored) {
            drop(fs::rename(&markdown, &source));
            return Err(error);
        }
        // The sidecar follows the deleted copy. Keeping it under the opaque trash identity
        // prevents a newly-created note at the old path from inheriting the deleted note's
        // CRDT state.
        sync::relocate_sidecar(vault.root(), path, &self.sidecar_identity(&id))
            .map_err(|error| TrashError::Io(error.to_string()))?;
        Ok(TrashEntry {
            id,
            path: stored.path,
            deleted_at: stored.deleted_at,
            actor: stored.actor,
        })
    }

    /// Lists retained entries in stable deletion order and purges expired entries first.
    pub fn list(&self, now: u64) -> Result<Vec<TrashEntry>, TrashError> {
        self.purge(now)?;
        let Ok(entries) = fs::read_dir(&self.metadata_root) else {
            return Ok(Vec::new());
        };
        let mut found = Vec::new();
        for entry in entries {
            let entry = entry.map_err(io_error)?;
            let file_name = entry.file_name();
            let Some(id) = file_name
                .to_str()
                .and_then(|name| name.strip_suffix(".json"))
            else {
                continue;
            };
            let stored: StoredEntry = read_json(&entry.path())?;
            found.push(TrashEntry {
                id: id.to_string(),
                path: stored.path,
                deleted_at: stored.deleted_at,
                actor: stored.actor,
            });
        }
        found.sort_by_key(|entry| (entry.deleted_at, entry.id.clone()));
        Ok(found)
    }

    /// Purges entries whose configured retention window has elapsed.
    pub fn purge_expired(&self, now: u64) -> Result<(), TrashError> {
        self.purge(now)
    }

    /// Restores one entry to its original path without overwriting a live note.
    pub fn restore(&self, vault: &Vault, id: &str, now: u64) -> Result<TrashEntry, TrashError> {
        self.purge(now)?;
        if !valid_id(id) {
            return Err(TrashError::NotFound);
        }
        let metadata = self.metadata_path(id);
        let body = self.body_path(id);
        let stored: StoredEntry = read_json(&metadata)?;
        let destination = vault
            .reserve(&stored.path)
            .map_err(|_| TrashError::NotFound)?;
        if destination.exists() {
            return Err(TrashError::Occupied);
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(io_error)?;
        }
        fs::rename(&body, &destination).map_err(io_error)?;
        sync::relocate_sidecar(vault.root(), &self.sidecar_identity(id), &stored.path)
            .map_err(|error| TrashError::Io(error.to_string()))?;
        fs::remove_file(metadata).map_err(io_error)?;
        Ok(TrashEntry {
            id: id.to_string(),
            path: stored.path,
            deleted_at: stored.deleted_at,
            actor: stored.actor,
        })
    }

    fn purge(&self, now: u64) -> Result<(), TrashError> {
        let Ok(entries) = fs::read_dir(&self.metadata_root) else {
            return Ok(());
        };
        for entry in entries {
            let entry = entry.map_err(io_error)?;
            let file_name = entry.file_name();
            let Some(id) = file_name
                .to_str()
                .and_then(|name| name.strip_suffix(".json"))
            else {
                continue;
            };
            let stored: StoredEntry = read_json(&entry.path())?;
            if now.saturating_sub(stored.deleted_at) < self.retention_seconds {
                continue;
            }
            remove_file_if_present(&self.body_path(id))?;
            sync::remove_sidecar(&self.vault_root, &self.sidecar_identity(id))
                .map_err(|error| TrashError::Io(error.to_string()))?;
            HistoryStore::new(&self.vault_root, &stored.path)
                .remove_all()
                .map_err(|error| TrashError::Io(error.to_string()))?;
            fs::remove_file(entry.path()).map_err(io_error)?;
        }
        Ok(())
    }

    fn issue_id(&self) -> String {
        let mut bytes = [0_u8; 16];
        OsRng.fill_bytes(&mut bytes);
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    fn sidecar_identity(&self, id: &str) -> String {
        format!(".trash/{id}")
    }

    fn metadata_path(&self, id: &str) -> PathBuf {
        self.metadata_root.join(format!("{id}.json"))
    }

    fn body_path(&self, id: &str) -> PathBuf {
        self.body_root.join(format!("{id}.md"))
    }
}

fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), TrashError> {
    let bytes = serde_json::to_vec(value).map_err(|error| TrashError::Io(error.to_string()))?;
    sync::atomic_write(path, &bytes).map_err(|error| TrashError::Io(error.to_string()))
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, TrashError> {
    let bytes = fs::read(path).map_err(io_error)?;
    serde_json::from_slice(&bytes).map_err(|error| TrashError::Io(error.to_string()))
}

fn io_error(error: std::io::Error) -> TrashError {
    TrashError::Io(error.to_string())
}

fn remove_file_if_present(path: &Path) -> Result<(), TrashError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::{RETENTION_SECONDS, TrashError, TrashStore};
    use crate::Vault;
    use crate::history::HistoryStore;
    use crate::vault::Slug;

    #[test]
    fn delete_moves_markdown_and_restore_returns_it_to_original_path()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempfile::tempdir()?;
        std::fs::write(directory.path().join("Note.md"), "# Note\n")?;
        let vault = Vault::open(Slug::parse("v")?, "V", directory.path())?;
        let store = TrashStore::new(&vault);

        let deleted = store.delete(&vault, "Note.md", "alice", 100)?;
        assert!(!directory.path().join("Note.md").exists());
        assert_eq!(store.list(100)?, vec![deleted.clone()]);
        assert!(
            directory
                .path()
                .join(".trash")
                .join(format!("{}.md", deleted.id))
                .is_file()
        );

        let restored = store.restore(&vault, &deleted.id, 101)?;
        assert_eq!(restored.path, "Note.md");
        assert_eq!(
            std::fs::read_to_string(directory.path().join("Note.md"))?,
            "# Note\n"
        );
        assert!(store.list(101)?.is_empty());
        Ok(())
    }

    #[test]
    fn restore_refuses_to_overwrite_a_new_note() -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempfile::tempdir()?;
        std::fs::write(directory.path().join("Note.md"), "old")?;
        let vault = Vault::open(Slug::parse("v")?, "V", directory.path())?;
        let store = TrashStore::new(&vault);
        let deleted = store.delete(&vault, "Note.md", "alice", 100)?;
        std::fs::write(directory.path().join("Note.md"), "new")?;

        assert!(matches!(
            store.restore(&vault, &deleted.id, 101),
            Err(TrashError::Occupied)
        ));
        assert_eq!(
            std::fs::read_to_string(directory.path().join("Note.md"))?,
            "new"
        );
        Ok(())
    }

    #[test]
    fn expired_entries_are_purged_after_thirty_days() -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempfile::tempdir()?;
        std::fs::write(directory.path().join("Note.md"), "old")?;
        let vault = Vault::open(Slug::parse("v")?, "V", directory.path())?;
        let store = TrashStore::new(&vault);
        let history = HistoryStore::new(vault.root(), "Note.md");
        history.record("old", "alice", std::time::SystemTime::now())?;
        store.delete(&vault, "Note.md", "alice", 100)?;

        assert!(store.list(100 + RETENTION_SECONDS)?.is_empty());
        assert!(
            !directory.path().join(".trash").exists()
                || std::fs::read_dir(directory.path().join(".trash"))?
                    .next()
                    .is_none()
        );
        assert!(history.list()?.is_empty());
        Ok(())
    }

    #[test]
    fn traversal_is_rejected_before_any_file_moves() -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempfile::tempdir()?;
        std::fs::create_dir(directory.path().join("notes"))?;
        std::fs::write(directory.path().join("outside.md"), "outside")?;
        let vault = Vault::open(Slug::parse("v")?, "V", directory.path())?;
        let store = TrashStore::new(&vault);

        assert!(matches!(
            store.delete(&vault, "../outside.md", "alice", 100),
            Err(TrashError::NotFound)
        ));
        assert_eq!(
            std::fs::read_to_string(directory.path().join("outside.md"))?,
            "outside"
        );
        Ok(())
    }
}
