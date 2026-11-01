//! Folder deletion stays inside the permission-filtered repository (E32).
use std::path::PathBuf;

use mb_core::{NotePath, Role};

use super::AuthorizedVault;
use crate::sync::SyncRegistry;
use crate::trash::TrashStore;

/// Neutral refusals and confirmation failures from deleting a folder.
#[derive(Debug, thiserror::Error)]
pub enum FolderDeleteError {
    /// The folder is missing, inaccessible, unsafe or contains unsupported entries.
    #[error("not found")]
    Denied,
    /// A nonempty folder requires its exact basename before any mutation.
    #[error("type the folder name to confirm deletion")]
    ConfirmationRequired,
    /// Storage or synchronization failed; some notes may already be in trash.
    #[error("folder deletion failed: {0}")]
    Unavailable(String),
}

impl AuthorizedVault<'_> {
    /// Deletes a folder after authorizing its entire subtree, retaining Markdown in trash.
    ///
    /// Empty means physically empty, including subfolders. Hidden entries, non-Markdown
    /// files and symlinks refuse the whole operation before mutation. Directory removal
    /// is nonrecursive so files arriving after preflight are never silently discarded.
    /// Returns the deleted note paths for auditing. I/O failures may leave a partial deletion.
    pub fn delete_folder(
        &self,
        path: &str,
        confirmation: Option<&str>,
        sync: &SyncRegistry,
        now: u64,
    ) -> Result<Vec<String>, FolderDeleteError> {
        if path.is_empty() || !crate::vault::valid_note_path(&format!("{path}/folder.md")) {
            return Err(FolderDeleteError::Denied);
        }
        let mut pending = vec![path.to_string()];
        let mut directories = Vec::new();
        let mut notes = Vec::new();
        while let Some(relative) = pending.pop() {
            let full = self.deletable_folder(&relative)?;
            let entries = std::fs::read_dir(&full).map_err(|_| FolderDeleteError::Denied)?;
            directories.push(relative.clone());
            for entry in entries {
                // why: fail closed on excessive work rather than return a partial plan.
                if directories.len() + pending.len() + notes.len() >= 100_000 {
                    return Err(FolderDeleteError::Denied);
                }
                let entry = entry.map_err(|_| FolderDeleteError::Denied)?;
                let name = entry
                    .file_name()
                    .into_string()
                    .map_err(|_| FolderDeleteError::Denied)?;
                let child = format!("{relative}/{name}");
                if name.starts_with('.') || !self.may_delete(&child) {
                    return Err(FolderDeleteError::Denied);
                }
                let kind = entry.file_type().map_err(|_| FolderDeleteError::Denied)?;
                if kind.is_dir() {
                    pending.push(child);
                } else if kind.is_file() && crate::vault::valid_note_path(&child) {
                    self.write_path(&child)
                        .map_err(|_| FolderDeleteError::Denied)?;
                    notes.push(child);
                } else {
                    return Err(FolderDeleteError::Denied);
                }
            }
        }
        let nonempty = directories.len() > 1 || !notes.is_empty();
        if nonempty && confirmation != path.rsplit('/').next() {
            return Err(FolderDeleteError::ConfirmationRequired);
        }
        // why: close every room before moving any file; pending CRDT saves must not
        // recreate a deleted note or attach its state to a newly created replacement.
        for note in &notes {
            sync.close(self.vault, note)
                .map_err(|error| FolderDeleteError::Unavailable(error.to_string()))?;
        }
        let store = TrashStore::new(self.vault);
        for note in &notes {
            let parent = note
                .rsplit_once('/')
                .ok_or_else(|| {
                    FolderDeleteError::Unavailable("invalid planned note path".to_string())
                })?
                .0;
            self.deletable_folder(parent).map_err(|_| {
                FolderDeleteError::Unavailable("folder changed after preflight".to_string())
            })?;
            let metadata = std::fs::symlink_metadata(self.vault.notes_root().join(note))
                .map_err(|error| FolderDeleteError::Unavailable(error.to_string()))?;
            if !metadata.file_type().is_file() {
                return Err(FolderDeleteError::Unavailable(
                    "note changed after preflight".to_string(),
                ));
            }
            store
                .delete(self.vault, note, self.user.as_str(), now)
                .map_err(|error| FolderDeleteError::Unavailable(error.to_string()))?;
        }
        for relative in directories.iter().rev() {
            let full = self.deletable_folder(relative).map_err(|_| {
                FolderDeleteError::Unavailable("folder changed after preflight".to_string())
            })?;
            std::fs::remove_dir(full)
                .map_err(|error| FolderDeleteError::Unavailable(error.to_string()))?;
        }
        Ok(notes)
    }

    fn may_delete(&self, path: &str) -> bool {
        NotePath::parse(path).is_ok_and(|path| {
            matches!(
                self.access.effective_role(&self.user, &path),
                Role::Owner | Role::Editor
            )
        })
    }

    fn deletable_folder(&self, path: &str) -> Result<PathBuf, FolderDeleteError> {
        if !self.may_delete(path) {
            return Err(FolderDeleteError::Denied);
        }
        let mut full = self.vault.notes_root().to_path_buf();
        for segment in path.split('/') {
            full.push(segment);
            let metadata =
                std::fs::symlink_metadata(&full).map_err(|_| FolderDeleteError::Denied)?;
            if !metadata.file_type().is_dir() || !self.vault.directory_included(&full) {
                return Err(FolderDeleteError::Denied);
            }
        }
        Ok(full)
    }
}

#[cfg(test)]
mod tests {
    use super::FolderDeleteError;
    use crate::repository::AuthorizedVault;
    use crate::sync::SyncRegistry;
    use crate::trash::TrashStore;
    use crate::vault::Slug;
    use crate::{AccessFile, Vault};
    use mb_core::Username;

    fn vault(root: &std::path::Path) -> Vault {
        std::fs::write(
            root.join("access.toml"),
            "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n",
        )
        .expect("policy");
        Vault::open(Slug::parse("v").expect("slug"), "V", root).expect("vault")
    }

    #[test]
    fn subfolders_count_as_contents_even_without_notes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let vault = vault(dir.path());
        std::fs::create_dir_all(dir.path().join("Parent/Empty")).expect("folders");
        let access = AccessFile::load(vault.root()).expect("access");
        let view = AuthorizedVault::new(
            &vault,
            access.policy(),
            Username::parse("alice").expect("user"),
        );
        let sync = SyncRegistry::default();
        assert!(matches!(
            view.delete_folder("Parent", None, &sync, 100),
            Err(FolderDeleteError::ConfirmationRequired)
        ));
        assert!(dir.path().join("Parent/Empty").is_dir());
        view.delete_folder("Parent", Some("Parent"), &sync, 100)
            .expect("confirmed delete");
        assert!(!dir.path().join("Parent").exists());
    }

    #[test]
    fn traversal_hidden_entries_and_non_markdown_files_are_refused_without_mutation() {
        let dir = tempfile::tempdir().expect("tempdir");
        let vault = vault(dir.path());
        for folder in ["Hidden", "Attachment"] {
            std::fs::create_dir(dir.path().join(folder)).expect("folder");
            std::fs::write(dir.path().join(folder).join("Note.md"), "# Keep\n").expect("note");
        }
        std::fs::write(dir.path().join("Hidden/.secret.md"), "secret").expect("hidden");
        std::fs::write(dir.path().join("Attachment/image.png"), b"keep").expect("attachment");
        let access = AccessFile::load(vault.root()).expect("access");
        let view = AuthorizedVault::new(
            &vault,
            access.policy(),
            Username::parse("alice").expect("user"),
        );
        for path in [
            "",
            "/absolute",
            "../escape",
            "Hidden/../Attachment",
            "Hidden",
            "Attachment",
            ".memberberry",
            "Missing",
        ] {
            assert!(
                matches!(
                    view.delete_folder(path, Some(path), &SyncRegistry::default(), 100),
                    Err(FolderDeleteError::Denied)
                ),
                "{path}"
            );
        }
        assert!(dir.path().join("Hidden/Note.md").exists());
        assert!(dir.path().join("Attachment/Note.md").exists());
        assert!(TrashStore::new(&vault).inspect().expect("trash").is_empty());
    }

    #[test]
    fn storage_failure_keeps_the_original_note_and_folder() {
        let dir = tempfile::tempdir().expect("tempdir");
        let vault = vault(dir.path());
        std::fs::create_dir(dir.path().join("Folder")).expect("folder");
        std::fs::write(dir.path().join("Folder/Note.md"), "# Keep\n").expect("note");
        std::fs::create_dir_all(dir.path().join(".memberberry")).expect("state");
        std::fs::write(
            dir.path().join(".memberberry/trash"),
            "block directory creation",
        )
        .expect("blocker");
        let access = AccessFile::load(vault.root()).expect("access");
        let view = AuthorizedVault::new(
            &vault,
            access.policy(),
            Username::parse("alice").expect("user"),
        );
        assert!(matches!(
            view.delete_folder("Folder", Some("Folder"), &SyncRegistry::default(), 100),
            Err(FolderDeleteError::Unavailable(_))
        ));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("Folder/Note.md")).expect("untouched"),
            "# Keep\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_children_and_symlink_parents_never_delete_their_targets() {
        let dir = tempfile::tempdir().expect("tempdir");
        let outside = tempfile::tempdir().expect("outside");
        let vault = vault(dir.path());
        std::fs::create_dir_all(dir.path().join("Folder")).expect("folder");
        std::fs::write(outside.path().join("Note.md"), "# Outside\n").expect("outside note");
        std::os::unix::fs::symlink(outside.path(), dir.path().join("Alias")).expect("alias");
        std::os::unix::fs::symlink(
            outside.path().join("Note.md"),
            dir.path().join("Folder/Note.md"),
        )
        .expect("child alias");
        let access = AccessFile::load(vault.root()).expect("access");
        let view = AuthorizedVault::new(
            &vault,
            access.policy(),
            Username::parse("alice").expect("user"),
        );
        for path in ["Alias", "Alias/Missing", "Folder"] {
            assert!(matches!(
                view.delete_folder(path, Some(path), &SyncRegistry::default(), 100),
                Err(FolderDeleteError::Denied)
            ));
        }
        assert_eq!(
            std::fs::read_to_string(outside.path().join("Note.md")).expect("outside unchanged"),
            "# Outside\n"
        );
    }
}
