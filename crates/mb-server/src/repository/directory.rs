//! E30 bounded, permission-filtered, nonrecursive directory repository.
use super::*;
use crate::vault_locations::{DirectoryName, RelativeDirectoryPath};
use rustix::fs::{AtFlags, Dir, FileType, Mode, OFlags, ResolveFlags};
use serde::Serialize;
use std::os::fd::OwnedFd;

const MAX_SCANNED: usize = 4096;
const MAX_RETURNED: usize = 128;
const MAX_JSON: usize = 64 * 1024;
const MAX_GRANT_CHECKS: usize = 128;
const FLAGS: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CLOEXEC);
const RESOLVE: ResolveFlags = ResolveFlags::BENEATH
    .union(ResolveFlags::NO_SYMLINKS)
    .union(ResolveFlags::NO_MAGICLINKS);

/// Neutral repository refusals; missing and denied paths share one value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum DirectoryError {
    /// Missing, denied, unsafe or changed identity, without revealing which.
    #[error("not_found")]
    NotFound,
    /// Literal token has invalid syntax.
    #[error("invalid_request")]
    Invalid,
    /// Whole listing exceeded a fixed work/output bound; no partial list is returned.
    #[error("limit_exceeded")]
    Limit,
}

/// One exact visible name and its literal notes-root-relative path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DirectoryEntry {
    /// Exact UTF-8 filesystem spelling, never a note title.
    pub name: String,
    /// Literal relative identity, without Unicode normalization or percent decoding.
    pub path: String,
}

/// Immediate children of a readable directory, ordered by exact name within each array.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DirectoryListing {
    /// Requested exact directory token; empty denotes the selected notes root.
    pub path: String,
    /// Real visible directories; readable themselves or necessary for an existing grant.
    pub folders: Vec<DirectoryEntry>,
    /// Regular, visible lowercase `.md` files authorized by the content ACL.
    pub files: Vec<DirectoryEntry>,
}

/// Pins the enumerated directory until current ACL/identity publication revalidation.
#[derive(Debug)]
pub struct DirectorySnapshot {
    source: PathBuf,
    root: OwnedFd,
    directory: OwnedFd,
    listing: DirectoryListing,
}

/// Validates the literal directory token and its 1024-byte/16-component work bound.
/// No filesystem operations, trimming, normalization or decoding are performed.
pub fn validate_directory_token(raw: &str) -> Result<RelativeDirectoryPath, DirectoryError> {
    if raw.len() > 1024 || (!raw.is_empty() && raw.split('/').count() > 16) {
        return Err(DirectoryError::Limit);
    }
    RelativeDirectoryPath::for_browse(raw).map_err(|_| DirectoryError::Invalid)
}

fn open(parent: &OwnedFd, raw: &str) -> Result<OwnedFd, DirectoryError> {
    rustix::fs::openat2(
        parent,
        if raw.is_empty() { "." } else { raw },
        FLAGS,
        Mode::empty(),
        RESOLVE,
    )
    .map_err(|_| DirectoryError::NotFound)
}
fn identity(fd: &OwnedFd) -> Result<(u64, u64), DirectoryError> {
    let stat = rustix::fs::fstat(fd).map_err(|_| DirectoryError::NotFound)?;
    Ok((stat.st_dev, stat.st_ino))
}
fn open_root(source: &Path) -> Result<OwnedFd, DirectoryError> {
    rustix::fs::openat2(
        rustix::fs::CWD,
        source,
        FLAGS,
        Mode::empty(),
        ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_MAGICLINKS,
    )
    .map_err(|_| DirectoryError::NotFound)
}
fn child(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.into()
    } else {
        format!("{parent}/{name}")
    }
}

impl AuthorizedVault<'_> {
    fn direct_directory_access(&self, raw: &str) -> bool {
        if raw.is_empty() {
            self.access
                .members()
                .any(|(u, role)| u == &self.user && role != Role::None)
        } else {
            self.can_read(raw)
        }
    }
    fn possible_directory_access(&self, raw: &str) -> bool {
        self.direct_directory_access(raw)
            || self.access.rules().any(|rule| {
                (raw.is_empty()
                    || rule
                        .path
                        .as_str()
                        .strip_prefix(raw)
                        .is_some_and(|s| s.starts_with('/')))
                    && self.access.effective_role(&self.user, &rule.path) != Role::None
            })
    }
    fn existing_directory_access(
        &self,
        root: &OwnedFd,
        raw: &str,
        checked: &mut usize,
    ) -> Result<bool, DirectoryError> {
        if self.direct_directory_access(raw) {
            return Ok(true);
        }
        for rule in self.access.rules() {
            let target = rule.path.as_str();
            if !(raw.is_empty() || target.strip_prefix(raw).is_some_and(|s| s.starts_with('/')))
                || self.access.effective_role(&self.user, &rule.path) == Role::None
            {
                continue;
            }
            if !self.vault.directory_path_included(target) {
                continue;
            }
            *checked += 1;
            if *checked > MAX_GRANT_CHECKS {
                return Err(DirectoryError::Limit);
            }
            if validate_directory_token(target).is_err() {
                continue;
            }
            // why: verify only the exact grant, never enumerate its descendants. Absence
            // must not turn a policy string into authority to disclose a private ancestor.
            let fd = match rustix::fs::openat2(
                root,
                target,
                OFlags::PATH | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
                RESOLVE,
            ) {
                Ok(fd) => fd,
                Err(_) => continue,
            };
            let stat = rustix::fs::fstat(&fd).map_err(|_| DirectoryError::NotFound)?;
            if matches!(FileType::from_raw_mode(stat.st_mode), FileType::Directory)
                || (FileType::from_raw_mode(stat.st_mode) == FileType::RegularFile
                    && target.ends_with(".md"))
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Reads only immediate metadata through this ACL-filtered repository.
    ///
    /// # Errors
    /// Missing/denied/unsafe paths are neutral. Budget exhaustion refuses the entire list.
    /// Linux `openat2` pins the namespace; there is no recursive catalog or body read.
    pub fn directory(&self, raw: &str) -> Result<DirectorySnapshot, DirectoryError> {
        validate_directory_token(raw)?;
        if !self.possible_directory_access(raw) {
            return Err(DirectoryError::NotFound);
        }
        let source = self.vault.notes_root().to_path_buf();
        let root = open_root(&source)?;
        if !self.vault.directory_path_included(raw) {
            return Err(DirectoryError::NotFound);
        }
        let mut checked = 0;
        // why: until an existing grant is verified, even budget exhaustion cannot
        // distinguish a private vault/path from an unknown one. No directory is listed.
        if !self
            .existing_directory_access(&root, raw, &mut checked)
            .map_err(|_| DirectoryError::NotFound)?
        {
            return Err(DirectoryError::NotFound);
        }
        let mut directory = open(&root, "")?;
        let mut prefix = String::new();
        for component in raw.split('/').filter(|s| !s.is_empty()) {
            prefix = child(&prefix, component);
            if !self.possible_directory_access(&prefix) {
                return Err(DirectoryError::NotFound);
            }
            directory = open(&directory, component)?;
        }
        let mut listing = DirectoryListing {
            path: raw.into(),
            folders: Vec::new(),
            files: Vec::new(),
        };
        let mut entries = Dir::read_from(&directory).map_err(|_| DirectoryError::NotFound)?;
        // why: every iterator call, including dot entries, is budgeted. At exhaustion
        // refuse conservatively without an unbudgeted EOF lookahead or partial response.
        let mut complete = false;
        for _ in 0..MAX_SCANNED {
            let Some(entry) = entries.next() else {
                complete = true;
                break;
            };
            let entry = entry.map_err(|_| DirectoryError::NotFound)?;
            let Ok(name) = entry.file_name().to_str() else {
                continue;
            };
            if DirectoryName::parse(name).is_err() {
                continue;
            }
            let path = child(raw, name);
            // why: even a metadata stat of a denied subtree is unnecessary. Check possible
            // content authority before type lookup; no child directories are enumerated.
            if !self.possible_directory_access(&path) {
                continue;
            }
            let stat = rustix::fs::statat(&directory, entry.file_name(), AtFlags::SYMLINK_NOFOLLOW)
                .map_err(|_| DirectoryError::NotFound)?;
            let destination = match FileType::from_raw_mode(stat.st_mode) {
                FileType::Directory
                    if self.vault.directory_path_included(&path)
                        && self.existing_directory_access(&root, &path, &mut checked)? =>
                {
                    &mut listing.folders
                }
                FileType::RegularFile if name.ends_with(".md") && self.can_read(&path) => {
                    &mut listing.files
                }
                _ => continue,
            };
            validate_directory_token(&path)?;
            destination.push(DirectoryEntry {
                name: name.into(),
                path,
            });
            if listing.folders.len() + listing.files.len() > MAX_RETURNED {
                return Err(DirectoryError::Limit);
            }
        }
        if !complete {
            return Err(DirectoryError::Limit);
        }
        listing.folders.sort_by(|a, b| a.name.cmp(&b.name));
        listing.files.sort_by(|a, b| a.name.cmp(&b.name));
        let snapshot = DirectorySnapshot {
            source,
            root,
            directory,
            listing,
        };
        snapshot.revalidate(self)?;
        snapshot.json()?;
        Ok(snapshot)
    }
}

impl DirectorySnapshot {
    /// Checks the current authorized view and every published entry against pinned identity.
    /// Revalidation never repeats enumeration and never reads a note body.
    pub fn revalidate(&self, view: &AuthorizedVault<'_>) -> Result<(), DirectoryError> {
        if self.source != view.vault.notes_root()
            || !view.possible_directory_access(&self.listing.path)
        {
            return Err(DirectoryError::NotFound);
        }
        let root = open_root(&self.source)?;
        if identity(&root)? != identity(&self.root)? {
            return Err(DirectoryError::NotFound);
        }
        let mut checked = 0;
        // why: verify current real authority before reopening a possibly revoked subtree;
        // inability to establish it is neutral, not a private-vault budget side channel.
        if !view
            .existing_directory_access(&root, &self.listing.path, &mut checked)
            .map_err(|_| DirectoryError::NotFound)?
        {
            return Err(DirectoryError::NotFound);
        }
        if identity(&open(&root, &self.listing.path)?)? != identity(&self.directory)? {
            return Err(DirectoryError::NotFound);
        }
        for entry in &self.listing.folders {
            if !view
                .existing_directory_access(&root, &entry.path, &mut checked)
                .map_err(|_| DirectoryError::NotFound)?
            {
                return Err(DirectoryError::NotFound);
            }
        }
        if self
            .listing
            .files
            .iter()
            .any(|entry| !view.can_read(&entry.path))
        {
            return Err(DirectoryError::NotFound);
        }
        Ok(())
    }
    /// The exact immediate listing, never descendant/title/body metadata.
    #[must_use]
    pub fn listing(&self) -> &DirectoryListing {
        &self.listing
    }
    /// Serializes under the 64 KiB wire budget; overflow refuses rather than truncating.
    pub fn json(&self) -> Result<Vec<u8>, DirectoryError> {
        struct Output(Vec<u8>);
        impl std::io::Write for Output {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                if self.0.len().saturating_add(bytes.len()) > MAX_JSON {
                    return Err(std::io::Error::other("response budget"));
                }
                self.0.extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut output = Output(Vec::new());
        serde_json::to_writer(&mut output, &self.listing).map_err(|_| DirectoryError::Limit)?;
        Ok(output.0)
    }
}
