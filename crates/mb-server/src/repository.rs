//! Permission-filtered vault repository (`SPEC.md` §6.4 E1/E5 and §6.5).
//!
//! Feature code receives this view instead of a raw vault. Every list, name lookup, path
//! resolution and source read applies the same ACL before returning note metadata or bytes.

use std::path::PathBuf;

use mb_core::{Access, NotePath, Role, Username};

use crate::{Error, Vault};

/// A vault view constrained to one authenticated user and one validated ACL.
#[derive(Debug, Clone)]
pub struct AuthorizedVault<'a> {
    vault: &'a Vault,
    access: &'a Access,
    user: Username,
}

impl<'a> AuthorizedVault<'a> {
    /// Creates the only repository type available to content-facing code.
    #[must_use]
    pub fn new(vault: &'a Vault, access: &'a Access, user: Username) -> Self {
        Self {
            vault,
            access,
            user,
        }
    }

    /// Lists only notes readable by this user.
    pub fn notes(&self) -> Result<Vec<String>, Error> {
        self.vault.notes().map(|notes| {
            notes
                .into_iter()
                .filter(|path| self.can_read(path))
                .collect()
        })
    }

    /// Returns whether this user may discover this vault in the switcher.
    ///
    /// A vault-wide membership makes even an empty vault discoverable. A path-specific
    /// grant makes it discoverable only once it applies to an existing readable note.
    pub fn has_any_access(&self) -> Result<bool, Error> {
        if self
            .access
            .members()
            .any(|(member, role)| member == &self.user && role != Role::None)
        {
            return Ok(true);
        }
        Ok(!self.notes()?.is_empty())
    }

    /// Resolves a literal relative path only when the user can read it.
    ///
    /// `NotFound` is returned for both absent and unreadable notes, preserving the
    /// invisibility rule rather than revealing a permission boundary.
    pub fn resolve(&self, relative: &str) -> Result<PathBuf, Error> {
        let path = self.vault.resolve(relative)?;
        if self.can_read(relative) {
            Ok(path)
        } else {
            Err(Error::NotFound)
        }
    }

    /// Finds a readable note by its wikilink-style human name.
    #[must_use]
    pub fn find_by_name(&self, name: &str) -> Option<String> {
        let wanted = name.trim_end_matches(".md");
        if wanted.is_empty() {
            return None;
        }
        let wanted = nfc(wanted);
        self.notes()
            .ok()?
            .into_iter()
            .filter(|relative| {
                let stem = nfc(relative.trim_end_matches(".md"));
                stem == wanted || stem.rsplit('/').next() == Some(wanted.as_str())
            })
            .min_by_key(|relative| (relative.matches('/').count(), relative.clone()))
    }

    /// Resolves any supported note reference without revealing unreadable candidates.
    pub fn resolve_reference(&self, reference: &str) -> Result<PathBuf, Error> {
        self.resolve(reference)
            .or_else(|_| self.resolve(&format!("{reference}.md")))
            .or_else(|_| {
                let relative = self.find_by_name(reference).ok_or(Error::NotFound)?;
                self.resolve(&relative)
            })
    }

    /// Resolves a reference to the canonical vault-relative identity of a readable note.
    ///
    /// The identity is what the index keys on and what a sync room is named by: the
    /// vault-relative form of the *canonical* path, so two spellings of one file — a
    /// symlink, a different capitalization on a case-insensitive filesystem — cannot become
    /// two identities. Accepts anything [`AuthorizedVault::resolve_reference`] does.
    ///
    /// # Errors
    ///
    /// [`Error::NotFound`] for an absent, unreadable or uncontainable reference, with no way
    /// to tell those apart (§6.5).
    pub fn identity(&self, reference: &str) -> Result<String, Error> {
        let path = self.resolve_reference(reference)?;
        let relative = path
            .strip_prefix(
                self.vault
                    .notes_root()
                    .canonicalize()
                    .map_err(|_| Error::NotFound)?,
            )
            .map_err(|_| Error::NotFound)?
            .to_string_lossy()
            .replace('\\', "/");
        if self.can_read(&relative) {
            Ok(relative)
        } else {
            Err(Error::NotFound)
        }
    }

    /// Reads note source after the read authorization check has succeeded.
    pub fn read(&self, reference: &str) -> Result<String, Error> {
        let path = self.resolve_reference(reference)?;
        std::fs::read_to_string(path).map_err(|_| Error::NotFound)
    }

    fn can_read(&self, relative: &str) -> bool {
        NotePath::parse(relative)
            .map(|path| self.access.effective_role(&self.user, &path) != Role::None)
            .unwrap_or(false)
    }
}

fn nfc(text: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    text.nfc().collect()
}
