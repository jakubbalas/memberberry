//! Bounded descriptor-relative storage checks and ownership-aware cleanup.
use super::{Refusal, digest, random};
use rustix::fs::{AtFlags, Dir, FileType, Mode, OFlags, ResolveFlags};
use std::io::{Read, Write};
use std::os::fd::OwnedFd;

pub(super) const MAX_FILE: usize = 1024 * 1024;
const MAX_ENTRIES: usize = 16_384;
const MAX_DIRS: usize = 1_024;
const MAX_NOTE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_TOTAL_NOTE_BYTES: u64 = 64 * 1024 * 1024;
#[cfg(test)]
std::thread_local! {
    // why: inotify cannot observe stat. Count actual walk type lookups separately.
    pub(super) static WALK_STATS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Identity(u64, u64);
pub(super) fn identity(fd: &OwnedFd) -> Result<Identity, Refusal> {
    let s = rustix::fs::fstat(fd).map_err(|_| Refusal::Unavailable)?;
    Ok(Identity(s.st_dev, s.st_ino))
}
pub(super) fn open_dir(parent: &OwnedFd, name: &str) -> Result<OwnedFd, Refusal> {
    open(parent, name, OFlags::RDONLY | OFlags::DIRECTORY)
}
fn open(parent: &OwnedFd, name: &str, flags: OFlags) -> Result<OwnedFd, Refusal> {
    rustix::fs::openat2(
        parent,
        name,
        flags | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
        Mode::empty(),
        ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_MAGICLINKS,
    )
    .map_err(|_| Refusal::Unavailable)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct FileState {
    identity: Identity,
    digest: [u8; 32],
    pub(super) stamp: super::FileStamp,
}
pub(super) fn read_optional(
    parent: &OwnedFd,
    name: &str,
    cap: usize,
) -> Result<Option<(FileState, Vec<u8>)>, Refusal> {
    let fd = match rustix::fs::openat2(
        parent,
        name,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
        Mode::empty(),
        ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_MAGICLINKS,
    ) {
        Err(rustix::io::Errno::NOENT) => return Ok(None),
        Err(_) => return Err(Refusal::Unavailable),
        Ok(fd) => fd,
    };
    let state = identity(&fd)?;
    let stat = rustix::fs::fstat(&fd).map_err(|_| Refusal::Unavailable)?;
    if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile {
        return Err(Refusal::Unavailable);
    }
    if stat.st_size < 0 || stat.st_size as u64 > cap as u64 {
        return Err(Refusal::Limit);
    }
    let mut file = std::fs::File::from(fd);
    let before = file.metadata().map_err(|_| Refusal::Unavailable)?;
    let stamp = super::FileStamp {
        len: before.len(),
        modified: before.modified().ok(),
    };
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(cap as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Refusal::Unavailable)?;
    if bytes.len() > cap {
        return Err(Refusal::Limit);
    }
    let after = file.metadata().map_err(|_| Refusal::Unavailable)?;
    if stamp
        != (super::FileStamp {
            len: after.len(),
            modified: after.modified().ok(),
        })
    {
        return Err(Refusal::Conflict);
    }
    Ok(Some((
        FileState {
            identity: state,
            digest: digest(&bytes),
            stamp,
        },
        bytes,
    )))
}

/// The original file descriptor pins the inode. Cleanup also checks current bytes,
/// so an external edit/replacement is never deleted merely because the name is ours.
#[derive(Debug)]
pub(super) struct OwnedFile {
    parent: OwnedFd,
    name: String,
    fd: OwnedFd,
    bytes: Vec<u8>,
    retained: bool,
}
impl OwnedFile {
    pub(super) fn create(parent: &OwnedFd, bytes: &[u8]) -> Result<Self, Refusal> {
        let parent = parent.try_clone().map_err(|_| Refusal::Unavailable)?;
        let name = format!(".memberberry-{}.tmp", random()?);
        let fd = rustix::fs::openat(
            &parent,
            name.as_str(),
            OFlags::RDWR | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::from_raw_mode(0o600),
        )
        .map_err(|_| Refusal::Unavailable)?;
        let mut owned = Self {
            parent,
            name,
            fd,
            bytes: Vec::new(),
            retained: false,
        };
        let writer = owned.fd.try_clone().map_err(|_| Refusal::Unavailable)?;
        #[cfg(test)]
        let writer = test_io::write_handle(&owned.parent, &owned.name, writer)?;
        let mut file = std::fs::File::from(writer);
        // why: retain the exact successful prefix on a short write for safe rollback.
        while owned.bytes.len() < bytes.len() {
            let written = file.write(bytes.get(owned.bytes.len()..).ok_or(Refusal::Unavailable)?);
            #[cfg(test)]
            test_io::observe_write(&written);
            let n = written.map_err(|_| Refusal::Unavailable)?;
            if n == 0 {
                return Err(Refusal::Unavailable);
            }
            let end = owned.bytes.len() + n;
            owned.bytes.extend_from_slice(
                bytes
                    .get(owned.bytes.len()..end)
                    .ok_or(Refusal::Unavailable)?,
            );
        }
        #[cfg(test)]
        test_io::sync_file(&owned.parent, &owned.name)?;
        file.sync_all().map_err(|_| Refusal::Unavailable)?;
        Ok(owned)
    }
    pub(super) fn rename_missing(&mut self, name: &str) -> Result<(), Refusal> {
        #[cfg(test)]
        if test_io::fault() == test_io::Fault::Rename {
            return test_io::rename_failure(&self.parent, &self.name, name, true)
                .map_err(|_| Refusal::Conflict);
        }
        rustix::fs::renameat_with(
            &self.parent,
            self.name.as_str(),
            &self.parent,
            name,
            rustix::fs::RenameFlags::NOREPLACE,
        )
        .map_err(|_| Refusal::Conflict)?;
        self.name = name.into();
        sync_directory(&self.parent).map_err(|_| Refusal::Unavailable)
    }
    pub(super) fn commit_config(&mut self, name: &str) -> Result<bool, Refusal> {
        #[cfg(test)]
        if test_io::fault() == test_io::Fault::Rename {
            return test_io::rename_failure(&self.parent, &self.name, name, false)
                .map(|_| true)
                .map_err(|_| Refusal::Unavailable);
        }
        rustix::fs::renameat(&self.parent, self.name.as_str(), &self.parent, name)
            .map_err(|_| Refusal::Unavailable)?;
        // why: rename is the commit point. A directory-sync error is postcommit, never
        // authority to roll back the registered project's policy/root or live registry.
        self.retained = true;
        Ok(sync_directory(&self.parent).is_ok())
    }
    pub(super) fn matches_owned_bytes(&self) -> Result<bool, Refusal> {
        let expected = identity(&self.fd)?;
        Ok(
            read_optional(&self.parent, &self.name, MAX_FILE)?.is_some_and(|(state, _)| {
                state.identity == expected && state.digest == digest(&self.bytes)
            }),
        )
    }
    pub(super) fn matches_state(&self, state: &FileState) -> Result<bool, Refusal> {
        Ok(state.identity == identity(&self.fd)? && state.digest == digest(&self.bytes))
    }
    pub(super) fn retain(&mut self) {
        self.retained = true;
    }
    pub(super) fn cleanup(&mut self) -> Result<(), Refusal> {
        if self.retained {
            return Ok(());
        }
        let current = read_optional(&self.parent, &self.name, MAX_FILE)?;
        let Some((state, _)) = current else {
            self.retained = true;
            return Ok(());
        };
        if state.identity != identity(&self.fd)? || state.digest != digest(&self.bytes) {
            return Err(Refusal::Residual);
        }
        rustix::fs::unlinkat(&self.parent, self.name.as_str(), AtFlags::empty())
            .map_err(|_| Refusal::Residual)?;
        self.retained = true;
        Ok(())
    }
}
impl Drop for OwnedFile {
    fn drop(&mut self) {
        if self.cleanup().is_err() {
            eprintln!(
                "memberberry registration: operation-owned file changed or could not be removed; residual artifact retained"
            );
        }
    }
}
fn sync_directory(parent: &OwnedFd) -> Result<(), rustix::io::Errno> {
    #[cfg(test)]
    if test_io::fault() == test_io::Fault::DirectorySync {
        // why: test-only descriptor substitution at the actual fsync boundary produces
        // EBADF after rename, not a fabricated response or early preparation failure.
        return test_io::directory_sync(parent);
    }
    rustix::fs::fsync(parent)
}
#[cfg(test)]
pub(super) mod test_io;

pub(super) fn probe(parent: &OwnedFd) -> Result<(), Refusal> {
    let mut file = OwnedFile::create(parent, b"memberberry storage check\n")?;
    file.rename_missing(&format!(".memberberry-{}.probe", random()?))?;
    file.cleanup()
}

#[derive(Debug)]
pub(super) struct OwnedDirectory {
    parent: OwnedFd,
    name: String,
    pub(super) fd: OwnedFd,
    retained: bool,
}
impl OwnedDirectory {
    pub(super) fn create(parent: &OwnedFd, name: &str) -> Result<Self, Refusal> {
        let parent = parent.try_clone().map_err(|_| Refusal::Unavailable)?;
        rustix::fs::mkdirat(&parent, name, Mode::from_raw_mode(0o700)).map_err(|error| {
            if error == rustix::io::Errno::EXIST {
                Refusal::Conflict
            } else {
                Refusal::Unavailable
            }
        })?;
        // why: never recursive-remove on failure, even a new directory can acquire foreign files.
        let fd = open_dir(&parent, name).map_err(|_| Refusal::Residual)?;
        Ok(Self {
            parent,
            name: name.into(),
            fd,
            retained: false,
        })
    }
    pub(super) fn verify(&self) -> Result<(), Refusal> {
        let current = open_dir(&self.parent, &self.name).map_err(|_| Refusal::Residual)?;
        if identity(&current)? != identity(&self.fd)? {
            return Err(Refusal::Residual);
        }
        Ok(())
    }
    pub(super) fn sync(&self) -> bool {
        // why: fsync refusal follows successful mkdir and cannot imply rollback.
        let child_synced = sync_directory(&self.fd).is_ok();
        let parent_synced = sync_directory(&self.parent).is_ok();
        child_synced && parent_synced
    }
    pub(super) fn retain(&mut self) {
        self.retained = true;
    }
    pub(super) fn cleanup(&mut self) -> Result<(), Refusal> {
        if self.retained {
            return Ok(());
        }
        let fd = open_dir(&self.parent, &self.name).map_err(|_| Refusal::Residual)?;
        if identity(&fd)? != identity(&self.fd)? {
            return Err(Refusal::Residual);
        }
        rustix::fs::unlinkat(&self.parent, self.name.as_str(), AtFlags::REMOVEDIR)
            .map_err(|_| Refusal::Residual)?;
        self.retained = true;
        Ok(())
    }
}
impl Drop for OwnedDirectory {
    fn drop(&mut self) {
        if self.cleanup().is_err() {
            eprintln!(
                "memberberry registration: new directory not empty or changed; residual directory retained"
            );
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Layout {
    notes_layout: crate::config::NotesLayout,
    pub(super) notes: Option<Identity>,
    pub(super) policy: Option<FileState>,
    vault_config: Option<FileState>,
}
impl Layout {
    pub(super) fn same_storage(&self, other: &Self) -> bool {
        self.notes_layout == other.notes_layout
            && self.notes == other.notes
            && self.vault_config == other.vault_config
    }
}
pub(super) fn layout(root: &OwnedFd) -> Result<(Layout, Option<mb_core::Access>), Refusal> {
    let mut linked_notes = false;
    let notes = match rustix::fs::statat(root, "notes", AtFlags::SYMLINK_NOFOLLOW) {
        Err(rustix::io::Errno::NOENT) => None,
        Err(_) => return Err(Refusal::Unavailable),
        Ok(s) if FileType::from_raw_mode(s.st_mode) == FileType::Directory => {
            Some(identity(&open_dir(root, "notes")?)?)
        }
        Ok(s) if FileType::from_raw_mode(s.st_mode) == FileType::RegularFile => None,
        Ok(s) if FileType::from_raw_mode(s.st_mode) == FileType::Symlink => {
            linked_notes = true;
            None
        }
        Ok(_) => return Err(Refusal::Unavailable),
    };
    let policy = read_optional(root, "access.toml", 64 * 1024)?;
    let access = policy
        .as_ref()
        .map(|(_, bytes)| {
            let text = std::str::from_utf8(bytes).map_err(|_| Refusal::Unavailable)?;
            mb_server_access(text)
        })
        .transpose()?;
    // why: changing Auto's notes-relative identity to Root can stop an existing deny
    // matching the same physical note. The approved guard never guesses policy intent.
    if !permission_layout_compatible(notes.is_some() || linked_notes, access.as_ref()) {
        return Err(Refusal::PolicyLayout);
    }
    let vault_config =
        read_optional(root, ".memberberry/config.toml", MAX_FILE)?.map(|(state, _)| state);
    Ok((
        Layout {
            notes_layout: crate::config::NotesLayout::Root,
            notes,
            policy: policy.map(|(state, _)| state),
            vault_config,
        },
        access,
    ))
}
pub(super) fn permission_layout_compatible(notes: bool, access: Option<&mb_core::Access>) -> bool {
    !notes || access.is_none_or(|policy| policy.rules().next().is_none())
}
fn mb_server_access(text: &str) -> Result<mb_core::Access, Refusal> {
    crate::AccessFile::parse(text)
        .map(|acl| acl.policy().clone())
        .map_err(|_| Refusal::Unavailable)
}

struct StorageWalk<'a> {
    layout: &'a Layout,
    authorize: &'a dyn Fn() -> Result<(), Refusal>,
    notes: Vec<String>,
    entries: usize,
    dirs: usize,
    bytes: u64,
    ignore_non_writable_folders: bool,
}
impl StorageWalk<'_> {
    fn walk(
        &mut self,
        fd: &OwnedFd,
        relative: &str,
        visible: bool,
        depth: usize,
    ) -> Result<(), Refusal> {
        if self.dirs > MAX_DIRS || depth > 64 {
            return Err(Refusal::Limit);
        }
        let is_note_dir = visible
            && (self.layout.notes_layout == crate::config::NotesLayout::Root
                || relative == "notes"
                || relative.starts_with("notes/"));
        if is_note_dir {
            (self.authorize)()?;
            probe(fd)?;
        }
        // why: depth-first traversal holds only the active descriptor chain (depth <=64),
        // not one fd per wide sibling. The directory budget must not depend on RLIMIT_NOFILE.
        for entry in Dir::read_from(fd).map_err(|_| Refusal::Unavailable)? {
            let entry = entry.map_err(|_| Refusal::Unavailable)?;
            let name = entry
                .file_name()
                .to_str()
                .map_err(|_| Refusal::Unavailable)?;
            if name == "." || name == ".." {
                continue;
            }
            self.entries += 1;
            if self.entries > MAX_ENTRIES {
                return Err(Refusal::Limit);
            }
            let path = if relative.is_empty() {
                name.into()
            } else {
                format!("{relative}/{name}")
            };
            if path.len() > 4096 {
                return Err(Refusal::Limit);
            }
            #[cfg(test)]
            WALK_STATS.with(|count| count.set(count.get() + 1));
            let stat = rustix::fs::statat(fd, name, AtFlags::SYMLINK_NOFOLLOW)
                .map_err(|_| Refusal::Unavailable)?;
            let child_visible = visible && !name.starts_with('.');
            match FileType::from_raw_mode(stat.st_mode) {
                FileType::Directory => {
                    if self.dirs >= MAX_DIRS || depth >= 64 {
                        return Err(Refusal::Limit);
                    }
                    self.dirs += 1;
                    (self.authorize)()?;
                    // why: check from the pinned parent before opening excluded directories.
                    if self.ignore_non_writable_folders && !writable_directory(fd, name)? {
                        continue;
                    }
                    let child = open_dir(fd, name)?;
                    if self.ignore_non_writable_folders && !writable_directory(&child, ".")? {
                        continue;
                    }
                    self.walk(&child, &path, child_visible, depth + 1)?;
                }
                FileType::RegularFile => {
                    if is_note_dir && child_visible && name.ends_with(".md") {
                        // why: RDWR verifies actual service read/write ability without reading bodies.
                        let note = open(fd, name, OFlags::RDWR)?;
                        let stat = rustix::fs::fstat(&note).map_err(|_| Refusal::Unavailable)?;
                        if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile
                            || stat.st_size < 0
                        {
                            return Err(Refusal::Unavailable);
                        }
                        let size = stat.st_size as u64;
                        self.bytes = self.bytes.saturating_add(size);
                        if size > MAX_NOTE_BYTES || self.bytes > MAX_TOTAL_NOTE_BYTES {
                            return Err(Refusal::Limit);
                        }
                        let path = if self.layout.notes_layout == crate::config::NotesLayout::Auto
                            && self.layout.notes.is_some()
                        {
                            path.strip_prefix("notes/")
                                .ok_or(Refusal::Unavailable)?
                                .into()
                        } else {
                            path
                        };
                        self.notes.push(path);
                    }
                }
                // why: links are unsupported entries, not a reason to reject the real
                // project. Never open their targets, including internal/broken links.
                FileType::Symlink => continue,
                _ => return Err(Refusal::Unavailable),
            }
        }
        Ok(())
    }
}
/// Enumerates all real directories (including hidden/dependency trees) for watcher access;
/// only normal visible Markdown is a note. No note bodies are read by this check.
/// Omits symbolic links without opening targets; other special files still refuse adoption.
pub(super) fn usable(
    root: &OwnedFd,
    layout: &Layout,
    ignore_non_writable_folders: bool,
    authorize: impl Fn() -> Result<(), Refusal>,
) -> Result<Vec<String>, Refusal> {
    authorize()?;
    if ignore_non_writable_folders && !writable_directory(root, ".")? {
        return Err(Refusal::Unavailable);
    }
    probe(root)?;
    let mut walk = StorageWalk {
        layout,
        authorize: &authorize,
        notes: Vec::new(),
        entries: 0,
        dirs: 1,
        bytes: 0,
        ignore_non_writable_folders,
    };
    walk.walk(root, "", true, 0)?;
    // Existing storage subdirectories must themselves be usable; absent ones are checked
    // against their nearest existing ancestor. No speculative mkdir modifies the project.
    for path in [
        "media",
        ".memberberry",
        ".memberberry/index",
        ".memberberry/index/search-v1",
        ".memberberry/index/zones",
    ] {
        let mut parent = root.try_clone().map_err(|_| Refusal::Unavailable)?;
        for part in path.split('/') {
            match rustix::fs::statat(&parent, part, AtFlags::SYMLINK_NOFOLLOW) {
                Err(rustix::io::Errno::NOENT) => break,
                Err(_) => return Err(Refusal::Unavailable),
                Ok(s) if FileType::from_raw_mode(s.st_mode) == FileType::Directory => {
                    parent = open_dir(&parent, part)?
                }
                Ok(_) => return Err(Refusal::Unavailable),
            }
        }
        authorize()?;
        probe(&parent)?;
    }
    walk.notes.sort();
    Ok(walk.notes)
}

/// Registration alone reads bodies as internal indexing, never to render a preview.
pub(super) fn initial_index(
    root: &OwnedFd,
    layout: &Layout,
    notes: &[String],
) -> Result<mb_index::Index, Refusal> {
    let base = if layout.notes_layout == crate::config::NotesLayout::Auto && layout.notes.is_some()
    {
        open_dir(root, "notes")?
    } else {
        root.try_clone().map_err(|_| Refusal::Unavailable)?
    };
    let mut index = mb_index::Index::in_memory().map_err(|_| Refusal::Unavailable)?;
    let mut total = 0usize;
    for path in notes {
        let (_, bytes) =
            read_optional(&base, path, MAX_NOTE_BYTES as usize)?.ok_or(Refusal::Unavailable)?;
        total = total.saturating_add(bytes.len());
        if total > MAX_TOTAL_NOTE_BYTES as usize {
            return Err(Refusal::Limit);
        }
        let markdown = String::from_utf8(bytes).map_err(|_| Refusal::Unavailable)?;
        index
            .upsert(&mb_index::NoteInput {
                path: path.clone(),
                markdown,
                stamp: mb_index::Stamp::from_parts(0, 0),
            })
            .map_err(|_| Refusal::Unavailable)?;
    }
    index.publish().map_err(|_| Refusal::Unavailable)?;
    Ok(index)
}

fn writable_directory(fd: &OwnedFd, name: &str) -> Result<bool, Refusal> {
    match crate::vault::writable_directory_at(fd, std::path::Path::new(name)) {
        Ok(()) => Ok(true),
        Err(rustix::io::Errno::ACCESS | rustix::io::Errno::PERM | rustix::io::Errno::ROFS) => {
            Ok(false)
        }
        Err(_) => Err(Refusal::Unavailable),
    }
}
