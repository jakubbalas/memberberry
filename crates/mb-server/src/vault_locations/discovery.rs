//! Internal bounded directory discovery; HTTP callers authorize before calling this module.
//!
//! Linux `openat2` is required: unsupported kernels fail closed, not through a racy
//! path-based fallback. Registry snapshots must be refreshed under the t-002 management
//! lock before confirmation; these read-only results are never registration authority.
//! Descriptor ancestry and repeated path/identity checks detect persistent namespace changes,
//! but do not freeze arbitrary external rename-and-restore or mount changes between syscalls.

use std::cell::Cell;
use std::os::fd::OwnedFd;
use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use rustix::fs::{AtFlags, Dir, FileType, Mode, OFlags, ResolveFlags, Stat};

use super::limits::*;
use super::{DirectoryName, RelativeDirectoryPath, VaultLocation, VaultLocationId};
use crate::{ServerConfig, Vault};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RegistrationStatus {
    Available,
    AlreadyRegistered,
    InsideRegisteredVault,
    ContainsRegisteredVault,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FolderState {
    pub(crate) location_root: bool,
    pub(crate) registration: RegistrationStatus,
}

impl FolderState {
    pub(crate) fn selectable(self) -> bool {
        !self.location_root && self.registration == RegistrationStatus::Available
    }

    pub(crate) fn browsable(self) -> bool {
        matches!(
            self.registration,
            RegistrationStatus::Available | RegistrationStatus::ContainsRegisteredVault
        )
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ChildDirectory {
    pub(crate) name: DirectoryName,
    pub(crate) path: RelativeDirectoryPath,
    pub(crate) state: FolderState,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct DirectoryListing {
    pub(crate) state: FolderState,
    pub(crate) children: Vec<ChildDirectory>,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum DiscoveryError {
    #[error("discovery budget exceeded")]
    LimitExceeded,
    #[error("unknown configured location")]
    UnknownLocation,
    #[error("duplicate configured location id")]
    DuplicateLocation,
    #[error("registered vault browsing boundary: {0:?}")]
    RegisteredBoundary(RegistrationStatus),
    #[error("directory identity changed during discovery")]
    IdentityChanged,
    #[error("directory discovery {operation}: {source}")]
    Io {
        operation: &'static str,
        source: std::io::Error,
    },
}

fn io(operation: &'static str, source: impl Into<std::io::Error>) -> DiscoveryError {
    DiscoveryError::Io {
        operation,
        source: source.into(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Identity {
    device: u64,
    inode: u64,
}

impl Identity {
    fn from_stat(stat: &Stat) -> Self {
        Self {
            device: stat.st_dev,
            inode: stat.st_ino,
        }
    }
}

#[derive(Debug)]
struct RegisteredRoot {
    source: PathBuf,
    path: PathBuf,
    fd: OwnedFd,
    identity: Identity,
}

#[derive(Debug)]
struct RegisteredRoots(Vec<RegisteredRoot>, Cell<usize>, Option<Arc<AtomicBool>>);

impl RegisteredRoots {
    #[cfg(test)]
    fn from_vaults(vaults: &[Vault]) -> Result<Self, DiscoveryError> {
        Self::from_vault_refs(&vaults.iter().collect::<Vec<_>>())
    }

    fn from_vault_refs(vaults: &[&Vault]) -> Result<Self, DiscoveryError> {
        if vaults.len() > MAX_REGISTERED || vaults.iter().any(|v| !server_path(v.root())) {
            return Err(DiscoveryError::LimitExceeded);
        }
        let mut roots = Vec::with_capacity(vaults.len());
        for vault in vaults {
            let path = std::fs::canonicalize(vault.root())
                .map_err(|e| io("resolve registered root", e))?;
            if !server_path(&path) {
                return Err(DiscoveryError::LimitExceeded);
            }
            let fd = open_canonical(&path, PIN_FLAGS)?;
            let identity = directory_identity(&fd)?;
            roots.push(RegisteredRoot {
                source: vault.root().to_path_buf(),
                path,
                fd,
                identity,
            });
        }
        let snapshot = Self(roots, Cell::new(0), None);
        snapshot.verify()?;
        Ok(snapshot)
    }

    fn charge(&self, cost: usize) -> Result<(), DiscoveryError> {
        let work = self.1.get().saturating_add(cost);
        if work > MAX_WORK || self.2.as_ref().is_some_and(|c| c.load(Ordering::Relaxed)) {
            return Err(DiscoveryError::LimitExceeded);
        }
        self.1.set(work);
        Ok(())
    }

    fn verify(&self) -> Result<(), DiscoveryError> {
        self.charge(1 + self.0.len() * 4)?;
        // why: a stale lexical registry can otherwise make a moved private descendant public.
        // Pinning roots also prevents inode reuse from validating a replacement directory.
        for root in &self.0 {
            verify_path_identity(&root.source, &root.path, &root.fd)?;
        }
        Ok(())
    }

    fn ancestor_relation(
        &self,
        fd: &OwnedFd,
        depth: usize,
    ) -> Result<Option<RegistrationStatus>, DiscoveryError> {
        if depth > MAX_ANCESTRY {
            return Err(DiscoveryError::LimitExceeded);
        }
        self.charge(1 + self.0.len())?;
        let mut current = fd.try_clone().map_err(|e| io("pin ancestry", e))?;
        let mut identity = directory_identity(&current)?;
        if self.0.iter().any(|root| root.identity == identity) {
            return Ok(Some(RegistrationStatus::AlreadyRegistered));
        }
        // why: openat2 BENEATH constrains path resolution, not application-level ancestry.
        // Trusted '..' lookups check actual pinned parents, not stale canonical prefixes.
        // A stable absolute path has at most this many ancestors; a longer walk fails closed.
        for _ in 0..=depth {
            self.charge(2 + self.0.len())?;
            let parent = rustix::fs::openat2(
                &current,
                "..",
                PIN_FLAGS,
                Mode::empty(),
                ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_MAGICLINKS,
            )
            .map_err(|e| io("open directory ancestor", e))?;
            let parent_identity = directory_identity(&parent)?;
            if self.0.iter().any(|root| root.identity == parent_identity) {
                return Ok(Some(RegistrationStatus::InsideRegisteredVault));
            }
            if parent_identity == identity {
                return Ok(None);
            }
            identity = parent_identity;
            current = parent;
        }
        Err(DiscoveryError::IdentityChanged)
    }

    fn directory_relation(
        &self,
        path: &Path,
        fd: &OwnedFd,
    ) -> Result<RegistrationStatus, DiscoveryError> {
        Ok(self
            .ancestor_relation(fd, path.components().count())?
            .unwrap_or_else(|| self.relation(path, None)))
    }

    fn relation(&self, candidate: &Path, identity: Option<Identity>) -> RegistrationStatus {
        // why: inode identity also catches a registered directory renamed between snapshot
        // and traversal, so its new name cannot become an administrative content bypass.
        if self
            .0
            .iter()
            .any(|root| candidate == root.path || identity == Some(root.identity))
        {
            RegistrationStatus::AlreadyRegistered
        } else if self.0.iter().any(|root| candidate.starts_with(&root.path)) {
            RegistrationStatus::InsideRegisteredVault
        } else if self.0.iter().any(|root| root.path.starts_with(candidate)) {
            RegistrationStatus::ContainsRegisteredVault
        } else {
            RegistrationStatus::Available
        }
    }
}

fn location<'a>(
    config: &'a ServerConfig,
    id: &VaultLocationId,
) -> Result<&'a VaultLocation, DiscoveryError> {
    if config.vault_locations.len() > MAX_LOCATIONS {
        return Err(DiscoveryError::LimitExceeded);
    }
    let mut matches = config
        .vault_locations
        .iter()
        .filter(|entry| entry.id() == id);
    let entry = matches.next().ok_or(DiscoveryError::UnknownLocation)?;
    if matches.next().is_some() {
        return Err(DiscoveryError::DuplicateLocation);
    }
    Ok(entry)
}

const DIRECTORY_FLAGS: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::CLOEXEC)
    .union(OFlags::NOFOLLOW);

const PIN_FLAGS: OFlags = OFlags::PATH
    .union(OFlags::DIRECTORY)
    .union(OFlags::CLOEXEC)
    .union(OFlags::NOFOLLOW);

fn directory_identity(fd: &OwnedFd) -> Result<Identity, DiscoveryError> {
    rustix::fs::fstat(fd)
        .map(|stat| Identity::from_stat(&stat))
        .map_err(|e| io("stat pinned directory", e))
}

fn open_canonical(path: &Path, flags: OFlags) -> Result<OwnedFd, DiscoveryError> {
    // why: canonicalize is not a pin. Refuse an intermediate symlink swapped in afterward.
    rustix::fs::openat2(
        rustix::fs::CWD,
        path,
        flags,
        Mode::empty(),
        ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_MAGICLINKS,
    )
    .map_err(|e| io("open canonical directory", e))
}

fn verify_path_identity(
    source: &Path,
    canonical: &Path,
    fd: &OwnedFd,
) -> Result<(), DiscoveryError> {
    if !server_path(source) || !server_path(canonical) {
        return Err(DiscoveryError::LimitExceeded);
    }
    let current = std::fs::canonicalize(source).map_err(|e| io("revalidate directory path", e))?;
    if current != canonical {
        return Err(DiscoveryError::IdentityChanged);
    }
    let reopened = open_canonical(&current, PIN_FLAGS)?;
    if directory_identity(&reopened)? != directory_identity(fd)? {
        return Err(DiscoveryError::IdentityChanged);
    }
    Ok(())
}

#[derive(Debug)]
struct OpenDirectory {
    configured: PathBuf,
    root: PathBuf,
    anchor: OwnedFd,
    fd: OwnedFd,
    path: PathBuf,
    state: FolderState,
}

fn open_directory(
    location: &VaultLocation,
    relative: &RelativeDirectoryPath,
    registered: &RegisteredRoots,
) -> Result<OpenDirectory, DiscoveryError> {
    if !server_path(location.path()) || !token(relative.as_str()) {
        return Err(DiscoveryError::LimitExceeded);
    }
    registered.verify()?;
    // why: an operator may deliberately configure an alias as the trusted root. Pin its
    // canonical target and revalidate the alias, target and actual ancestry throughout.
    let root =
        std::fs::canonicalize(location.path()).map_err(|e| io("resolve configured root", e))?;
    if !server_path(&root) {
        return Err(DiscoveryError::LimitExceeded);
    }
    let anchor = open_canonical(&root, DIRECTORY_FLAGS)?;
    verify_path_identity(location.path(), &root, &anchor)?;
    let mut registration = registered.directory_relation(&root, &anchor)?;
    let mut fd = anchor
        .try_clone()
        .map_err(|e| io("pin configured root", e))?;
    let mut path = root.clone();
    for component in relative.as_str().split('/').filter(|part| !part.is_empty()) {
        registered.verify()?;
        registration = registered.directory_relation(&path, &fd)?;
        if matches!(
            registration,
            RegistrationStatus::AlreadyRegistered | RegistrationStatus::InsideRegisteredVault
        ) {
            // why: stop before even resolving the next private child, not after read_dir.
            return Err(DiscoveryError::RegisteredBoundary(
                RegistrationStatus::InsideRegisteredVault,
            ));
        }
        path.push(component);
        if !server_path(&path) {
            return Err(DiscoveryError::LimitExceeded);
        }
        // why: pin each checked parent. Re-resolving a whole prefix here could swap an
        // already-checked public ancestor for a registered vault between components.
        fd = rustix::fs::openat2(
            &fd,
            component,
            DIRECTORY_FLAGS,
            Mode::empty(),
            ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_MAGICLINKS,
        )
        .map_err(|e| io("open relative directory", e))?;
        registration = registered.directory_relation(&path, &fd)?;
    }
    let directory = OpenDirectory {
        configured: location.path().to_path_buf(),
        root,
        anchor,
        fd,
        path,
        state: FolderState {
            location_root: relative.is_root(),
            registration,
        },
    };
    verify_open_directory(&directory, relative, registered)?;
    Ok(directory)
}

fn verify_open_directory(
    directory: &OpenDirectory,
    relative: &RelativeDirectoryPath,
    registered: &RegisteredRoots,
) -> Result<(), DiscoveryError> {
    registered.verify()?;
    verify_path_identity(&directory.configured, &directory.root, &directory.anchor)?;
    verify_relative_identity(&directory.anchor, relative, &directory.fd)?;
    if registered.directory_relation(&directory.path, &directory.fd)?
        != directory.state.registration
    {
        return Err(DiscoveryError::IdentityChanged);
    }
    // why: ancestry checks perform more syscalls; fence the paths again before returning.
    registered.verify()?;
    verify_path_identity(&directory.configured, &directory.root, &directory.anchor)?;
    verify_relative_identity(&directory.anchor, relative, &directory.fd)?;
    Ok(())
}

fn verify_relative_identity(
    anchor: &OwnedFd,
    relative: &RelativeDirectoryPath,
    fd: &OwnedFd,
) -> Result<(), DiscoveryError> {
    // why: a pinned parent could have been renamed outside the root while walking. The
    // original relative path must still name the same directory under the original anchor.
    let raw = if relative.is_root() {
        "."
    } else {
        relative.as_str()
    };
    let current = rustix::fs::openat2(
        anchor,
        raw,
        DIRECTORY_FLAGS,
        Mode::empty(),
        ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_MAGICLINKS,
    )
    .map_err(|e| io("revalidate relative directory", e))?;
    let expected = rustix::fs::fstat(fd).map_err(|e| io("stat pinned directory", e))?;
    let actual = rustix::fs::fstat(&current).map_err(|e| io("stat current directory", e))?;
    if Identity::from_stat(&expected) != Identity::from_stat(&actual) {
        return Err(DiscoveryError::IdentityChanged);
    }
    Ok(())
}

/// Checks a configured directory's registration state without enumerating children.
/// Relative traversal stops at registered roots; configured anchors cannot list private children.
#[cfg(test)]
pub(crate) fn inspect(
    config: &ServerConfig,
    id: &VaultLocationId,
    relative: &RelativeDirectoryPath,
    vaults: &[Vault],
) -> Result<FolderState, DiscoveryError> {
    inspect_cancellable(
        config,
        id,
        relative,
        &vaults.iter().collect::<Vec<_>>(),
        Arc::new(AtomicBool::new(false)),
    )
}

/// Inspects borrowed registry roots without cloning names or media credentials.
pub(crate) fn inspect_cancellable(
    config: &ServerConfig,
    id: &VaultLocationId,
    relative: &RelativeDirectoryPath,
    vaults: &[&Vault],
    cancel: Arc<AtomicBool>,
) -> Result<FolderState, DiscoveryError> {
    let location = location(config, id)?;
    if cancel.load(Ordering::Relaxed) {
        return Err(DiscoveryError::LimitExceeded);
    }
    let mut registered = RegisteredRoots::from_vault_refs(vaults)?;
    registered.2 = Some(cancel);
    Ok(open_directory(location, relative, &registered)?.state)
}

/// Lists only immediate, visible, token-representable real child directories.
/// There are no absolute paths or note bodies in the result. HTTP callers must authorize first.
#[cfg(test)]
pub(crate) fn list(
    config: &ServerConfig,
    id: &VaultLocationId,
    relative: &RelativeDirectoryPath,
    vaults: &[Vault],
) -> Result<DirectoryListing, DiscoveryError> {
    list_cancellable(
        config,
        id,
        relative,
        &vaults.iter().collect::<Vec<_>>(),
        Arc::new(AtomicBool::new(false)),
    )
}

pub(crate) fn list_cancellable(
    config: &ServerConfig,
    id: &VaultLocationId,
    relative: &RelativeDirectoryPath,
    vaults: &[&Vault],
    cancel: Arc<AtomicBool>,
) -> Result<DirectoryListing, DiscoveryError> {
    let location = location(config, id)?;
    if cancel.load(Ordering::Relaxed) {
        return Err(DiscoveryError::LimitExceeded);
    }
    let mut registered = RegisteredRoots::from_vault_refs(vaults)?;
    registered.2 = Some(cancel);
    let directory = open_directory(location, relative, &registered)?;
    list_open_directory(&directory, relative, &registered)
}

fn list_open_directory(
    directory: &OpenDirectory,
    relative: &RelativeDirectoryPath,
    registered: &RegisteredRoots,
) -> Result<DirectoryListing, DiscoveryError> {
    list_open_directory_after_read(directory, relative, registered, || {})
}

// why: a deterministic after-read seam lets tests mutate real paths before publication.
fn list_open_directory_after_read(
    directory: &OpenDirectory,
    relative: &RelativeDirectoryPath,
    registered: &RegisteredRoots,
    after_read: impl FnOnce(),
) -> Result<DirectoryListing, DiscoveryError> {
    if !directory.state.browsable() {
        return Err(DiscoveryError::RegisteredBoundary(
            directory.state.registration,
        ));
    }
    verify_open_directory(directory, relative, registered)?;
    let entries = Dir::read_from(&directory.fd).map_err(|e| io("read directory", e))?;
    let mut children = Vec::new();
    let mut response_bytes = 2048; // why: reserve the bounded envelope and state fields first.
    for (scanned, entry) in entries.enumerate() {
        // why: refuse on exhaustion without fetching an unbudgeted EOF-lookahead entry.
        if scanned + 1 >= MAX_SCANNED {
            return Err(DiscoveryError::LimitExceeded);
        }
        registered.charge(1 + registered.0.len() * 3)?;
        let entry = entry.map_err(|e| io("read directory entry", e))?;
        let Ok(raw) = entry.file_name().to_str() else {
            continue;
        };
        // why: non-UTF-8 and unsafe names cannot be faithfully addressed by a browser token.
        // Omit rather than lossy-converting a name into a different selectable path.
        let Ok(name) = DirectoryName::parse(raw) else {
            continue;
        };
        let stat = rustix::fs::statat(&directory.fd, entry.file_name(), AtFlags::SYMLINK_NOFOLLOW)
            .map_err(|e| io("stat directory entry", e))?;
        if FileType::from_raw_mode(stat.st_mode) != FileType::Directory {
            continue;
        }
        // why: reserve worst-case JSON escaping before allocating a child token/vector item.
        let path_len =
            relative.as_str().len() + usize::from(!relative.is_root()) + name.as_str().len();
        response_bytes += 6 * (path_len + name.as_str().len()) + 256;
        if children.len() >= MAX_CHILDREN
            || path_len > MAX_TOKEN_BYTES
            || (!relative.is_root() && relative.as_str().split('/').count() >= MAX_TOKEN_DEPTH)
            || response_bytes > MAX_RESPONSE_BYTES
        {
            return Err(DiscoveryError::LimitExceeded);
        }
        let path = relative.child(&name);
        let registration =
            registered.relation(&directory.path.join(raw), Some(Identity::from_stat(&stat)));
        children.push(ChildDirectory {
            name,
            path,
            state: FolderState {
                location_root: false,
                registration,
            },
        });
    }
    after_read();
    children.sort_by(|left, right| left.name.cmp(&right.name));
    verify_open_directory(directory, relative, registered)?;
    Ok(DirectoryListing {
        state: directory.state,
        children,
    })
}

/// Directory descriptors held by a short-lived confirmation, never note content.
#[derive(Debug)]
pub(crate) struct RegistrationPin(OpenDirectory, RegisteredRoots);

impl RegistrationPin {
    pub(crate) fn path(&self) -> &Path {
        &self.0.path
    }
    pub(crate) fn fd(&self) -> &OwnedFd {
        &self.0.fd
    }
    pub(crate) fn revalidate(
        &self,
        relative: &RelativeDirectoryPath,
    ) -> Result<(), DiscoveryError> {
        verify_open_directory(&self.0, relative, &self.1)
    }
    pub(crate) fn same_identity(&self, other: &Self) -> Result<bool, DiscoveryError> {
        self.1.verify()?;
        other.1.verify()?;
        Ok(self.0.configured == other.0.configured
            && self.0.root == other.0.root
            && self.0.path == other.0.path
            && directory_identity(&self.0.anchor)? == directory_identity(&other.0.anchor)?
            && directory_identity(&self.0.fd)? == directory_identity(&other.0.fd)?)
    }
}

/// Resolves an existing selection or a new child's parent under current registry boundaries.
/// A parent containing a registered descendant is permitted only for a nonoverlapping child.
pub(crate) fn registration_pin(
    config: &ServerConfig,
    id: &VaultLocationId,
    relative: &RelativeDirectoryPath,
    child: Option<&DirectoryName>,
    vaults: &[&Vault],
) -> Result<RegistrationPin, DiscoveryError> {
    let registered = RegisteredRoots::from_vault_refs(vaults)?;
    let directory = open_directory(location(config, id)?, relative, &registered)?;
    if let Some(child) = child {
        if !directory.state.browsable() {
            return Err(DiscoveryError::RegisteredBoundary(
                directory.state.registration,
            ));
        }
        let final_path = directory.path.join(child.as_str());
        if !server_path(&final_path) || !token(relative.child(child).as_str()) {
            return Err(DiscoveryError::LimitExceeded);
        }
        if registered.relation(&final_path, None) != RegistrationStatus::Available {
            return Err(DiscoveryError::RegisteredBoundary(
                registered.relation(&final_path, None),
            ));
        }
        match rustix::fs::statat(&directory.fd, child.as_str(), AtFlags::SYMLINK_NOFOLLOW) {
            Err(rustix::io::Errno::NOENT) => {}
            Err(e) => return Err(io("check missing project child", e)),
            Ok(_) => return Err(DiscoveryError::IdentityChanged),
        }
    } else if !directory.state.selectable() {
        return Err(DiscoveryError::RegisteredBoundary(
            directory.state.registration,
        ));
    }
    verify_open_directory(&directory, relative, &registered)?;
    Ok(RegistrationPin(directory, registered))
}

#[cfg(test)]
mod tests;
