//! Creating a note (`SPEC.md` §6.10, E17).
//!
//! ## Why this is its own module rather than part of sync
//!
//! Everything else that writes a note writes one that already exists: the sync path opens a
//! file, materializes a CRDT from it and debounces updates back. There was no way to bring
//! the file into being, which meant a vault with no notes could not be used at all — the
//! workspace is only reachable through a note URL, so a fresh vault had no route into the
//! application. This is that missing first step, and nothing more: it makes the file, and
//! the ordinary sync path takes it from there.
//!
//! ## What it refuses, and in what order
//!
//! The order is the same one `rename` documents, for the same reason:
//!
//! 1. **Shape**, purely lexically ([`crate::vault::valid_note_path`]). Reveals nothing —
//!    the caller sent the string.
//! 2. **Authorization**, against the live ACL. `Owner` or `Editor` for the path being
//!    created, so §6.2's per-folder grants scope creation exactly as they scope editing.
//! 3. **The filesystem**, last. "That already exists" is an answer about a path, so asking
//!    it before the caller has proved they may write there would let anyone probe for notes
//!    by trying to create over them. Because `Owner`/`Editor` both imply read, a caller who
//!    gets as far as [`CreateError::Exists`] could already have read that note.
//!
//! Creation is an ordinary editor action, not a privileged one, so it writes no audit entry
//! — no more than typing into a note does. §6.9's log is for administration and for the one
//! operation that reads outside the actor's readable set, which this is not.

use std::io::Write as _;
use std::sync::Mutex;

use mb_core::{Access, NotePath, Role, Username};
use mb_index::Index;

use crate::Vault;

/// A note that now exists.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Created {
    /// The vault-relative path it was created at, ending in `.md`.
    pub path: String,
}

/// Why a note was not created.
#[derive(Debug, thiserror::Error)]
pub enum CreateError {
    /// The actor may not create a note here, or is not in this vault.
    ///
    /// One variant for both, as everywhere else: distinguishing them would confirm the
    /// vault exists to somebody who is not in it (§6.5).
    #[error("that note cannot be created")]
    Denied,
    /// The path is not a usable note path. Carries the caller's own string back.
    #[error("`{0}` is not a usable note name")]
    InvalidName(String),
    /// A note is already there.
    #[error("`{0}` already exists")]
    Exists(String),
    /// The write itself failed.
    #[error("creating the note failed: {0}")]
    Failed(String),
}

/// Creates notes in one vault, as one authenticated user.
#[derive(Debug)]
pub struct CreateNote<'a> {
    vault: &'a Vault,
    access: &'a Access,
    actor: Username,
    index: &'a Mutex<Index>,
}

impl<'a> CreateNote<'a> {
    /// Binds the operation to a vault, an ACL and the user performing it.
    #[must_use]
    pub fn new(
        vault: &'a Vault,
        access: &'a Access,
        actor: Username,
        index: &'a Mutex<Index>,
    ) -> Self {
        Self {
            vault,
            access,
            actor,
            index,
        }
    }

    /// Creates an empty note at `path`, with its name as a heading.
    ///
    /// `path` is vault-relative and ends in `.md`; the client turns a typed name into one.
    /// Intermediate folders are created, because creating `Projects/Plan.md` in a vault with
    /// no `Projects` folder is an ordinary thing to want and failing it would be a puzzle.
    ///
    /// # Errors
    ///
    /// See [`CreateError`]. Every variant means nothing was written.
    pub fn note(&self, path: &str) -> Result<Created, CreateError> {
        self.note_with_body(path, &initial_body(path))
    }

    /// Creates a note with caller-provided Markdown content.
    pub fn note_with_body(&self, path: &str, body: &str) -> Result<Created, CreateError> {
        if !crate::vault::valid_note_path(path) {
            return Err(CreateError::InvalidName(path.to_string()));
        }
        if !self.may_write(path) {
            return Err(CreateError::Denied);
        }
        let destination = self
            .vault
            .reserve(path)
            .map_err(|_| CreateError::InvalidName(path.to_string()))?;

        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| CreateError::Failed(error.to_string()))?;
        }

        // why: `create_new` rather than `exists()` then write. The check-then-write version
        // is a race two clients creating the same name can both win, and the loser silently
        // truncates the winner's note. This asks the kernel to make the name and fail if it
        // is taken, which is one atomic step and cannot be interleaved.
        let mut file = match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(CreateError::Exists(path.to_string()));
            }
            Err(error) => return Err(CreateError::Failed(error.to_string())),
        };
        file.write_all(body.as_bytes())
            .map_err(|error| CreateError::Failed(error.to_string()))?;
        file.sync_all()
            .map_err(|error| CreateError::Failed(error.to_string()))?;
        drop(file);

        // The note exists on disk whatever happens next, which is what C2 asks of us. An
        // index that has not caught up yet only means the note is missing from the tree
        // until the next sweep, so this reports rather than unwinding a good write.
        if let Err(error) = self.sweep() {
            eprintln!("memberberry: reindexing after creating a note failed: {error}");
        }
        Ok(Created {
            path: path.to_string(),
        })
    }

    fn may_write(&self, path: &str) -> bool {
        NotePath::parse(path).is_ok_and(|note| {
            matches!(
                self.access.effective_role(&self.actor, &note),
                Role::Owner | Role::Editor
            )
        })
    }

    fn sweep(&self) -> Result<(), String> {
        let mut index = self
            .index
            .lock()
            .map_err(|_| "the index lock is poisoned".to_string())?;
        crate::indexing::reconcile(self.vault, &mut index)
    }
}

/// What a new note contains: its own name as a level-one heading.
///
/// Not an empty file. The name is the one thing the person creating it has already told us,
/// and a note whose first line is its title is what every other note in a vault looks like —
/// it gives the tree, the catalog and the backlink panel a title to show immediately, all of
/// which read it from the Markdown rather than from a database (C2).
fn initial_body(path: &str) -> String {
    let name = path
        .rsplit('/')
        .next()
        .unwrap_or(path)
        .trim_end_matches(".md");
    format!("# {name}\n")
}

#[cfg(test)]
mod tests {
    use super::initial_body;

    #[test]
    fn a_new_note_opens_with_its_own_name_as_a_heading() {
        assert_eq!(initial_body("Projects/Plan.md"), "# Plan\n");
    }

    #[test]
    fn a_note_at_the_vault_root_is_titled_the_same_way() {
        assert_eq!(initial_body("Welcome.md"), "# Welcome\n");
    }
}
