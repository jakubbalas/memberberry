//! Actual syscall failures via test-only descriptor substitution at the I/O boundary.
#![allow(clippy::expect_used, clippy::panic, clippy::unwrap_used)] // why: assertions; this entire module is cfg(test).
use super::*;
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Fault {
    #[default]
    None,
    Write,
    Sync,
    Rename,
    DirectorySync,
}
thread_local! { static FAULT: std::cell::Cell<Fault> = const { std::cell::Cell::new(Fault::None) }; }
pub(super) fn fault() -> Fault {
    FAULT.get()
}
struct FaultScope;
impl FaultScope {
    fn new(f: Fault) -> Self {
        FAULT.set(f);
        Self
    }
}
impl Drop for FaultScope {
    fn drop(&mut self) {
        FAULT.set(Fault::None);
    }
}
pub(crate) fn at_boundary<R>(fault: Fault, action: impl FnOnce() -> R) -> R {
    let _scope = FaultScope::new(fault);
    action()
}
pub(super) fn rename_failure(
    parent: &OwnedFd,
    source: &str,
    destination: &str,
    noreplace: bool,
) -> Result<(), rustix::io::Errno> {
    // why: fault only the actual rename source at the syscall boundary after genuine
    // temp preparation. The original owned temp remains available for scoped rollback.
    let absent = format!("{source}.absent");
    let result = if noreplace {
        rustix::fs::renameat_with(
            parent,
            absent.as_str(),
            parent,
            destination,
            rustix::fs::RenameFlags::NOREPLACE,
        )
    } else {
        rustix::fs::renameat(parent, absent.as_str(), parent, destination)
    };
    let error = result.expect_err("actual missing-source rename must fail");
    assert_eq!(error, rustix::io::Errno::NOENT);
    println!("actual prepared rename failure noreplace={noreplace}: {error}");
    Err(error)
}
pub(super) fn directory_sync(parent: &OwnedFd) -> Result<(), rustix::io::Errno> {
    let fd = rustix::fs::openat(parent, ".", OFlags::PATH | OFlags::DIRECTORY, Mode::empty())?;
    let error = rustix::fs::fsync(fd).expect_err("actual O_PATH directory fsync failure");
    assert_eq!(error, rustix::io::Errno::BADF);
    println!("actual postrename directory fsync failure: {error}");
    Err(error)
}
pub(super) fn write_handle(
    parent: &OwnedFd,
    name: &str,
    normal: OwnedFd,
) -> Result<OwnedFd, Refusal> {
    if fault() == Fault::Write {
        open(parent, name, OFlags::RDONLY)
    } else {
        Ok(normal)
    }
}
pub(super) fn observe_write(result: &std::io::Result<usize>) {
    if fault() == Fault::Write {
        let error = result
            .as_ref()
            .expect_err("actual write on read-only descriptor must fail");
        assert_eq!(
            error.raw_os_error(),
            Some(rustix::io::Errno::BADF.raw_os_error())
        );
        println!("actual preparation write failure: {error}");
    }
}
pub(super) fn sync_file(parent: &OwnedFd, name: &str) -> Result<(), Refusal> {
    if fault() != Fault::Sync {
        return Ok(());
    }
    let fd = rustix::fs::openat(
        parent,
        name,
        OFlags::PATH | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|_| Refusal::Unavailable)?;
    let error = rustix::fs::fsync(fd).expect_err("actual fsync on O_PATH must fail");
    assert_eq!(error, rustix::io::Errno::BADF);
    println!("actual preparation fsync failure: {error}");
    Err(Refusal::Unavailable)
}
fn root() -> (tempfile::TempDir, OwnedFd) {
    let dir = tempfile::tempdir().expect("fixture");
    let fd = rustix::fs::open(
        dir.path(),
        OFlags::RDONLY | OFlags::DIRECTORY,
        Mode::empty(),
    )
    .expect("root");
    (dir, fd)
}
#[test]
fn actual_write_and_fsync_failures_remove_only_owned_temps_and_retry() {
    for fault in [Fault::Write, Fault::Sync] {
        let (dir, fd) = root();
        std::fs::write(dir.path().join("Keep.bin"), b"preexisting\0\xff").expect("foreign");
        let scope = FaultScope::new(fault);
        assert!(matches!(
            OwnedFile::create(&fd, b"prepared bytes"),
            Err(Refusal::Unavailable)
        ));
        drop(scope);
        assert_eq!(
            std::fs::read_dir(dir.path()).expect("entries").count(),
            1,
            "owned temp cleanup even after actual write/sync failure"
        );
        assert_eq!(
            std::fs::read(dir.path().join("Keep.bin")).expect("preserved"),
            b"preexisting\0\xff"
        );
        let mut retry = OwnedFile::create(&fd, b"retry").expect("retry");
        retry.cleanup().expect("cleanup");
    }
}
#[test]
fn actual_noreplace_policy_rename_collision_preserves_foreign_bytes() {
    let (dir, fd) = root();
    let bytes = b"members = []\n";
    let mut file = OwnedFile::create(&fd, b"creator policy").expect("prepare");
    std::fs::write(dir.path().join("access.toml"), bytes).expect("racing policy");
    assert!(matches!(
        file.rename_missing("access.toml"),
        Err(Refusal::Conflict)
    ));
    file.cleanup().expect("cleanup");
    assert_eq!(
        std::fs::read(dir.path().join("access.toml")).expect("preserved"),
        bytes
    );
    assert_eq!(std::fs::read_dir(dir.path()).expect("entries").count(), 1);
}
#[test]
fn actual_config_rename_failure_preserves_prior_config_and_removes_temp() {
    let (dir, fd) = root();
    std::fs::write(dir.path().join("server.toml"), b"prior config bytes").expect("config");
    std::fs::create_dir(dir.path().join("Blocked")).expect("rename fault");
    let mut file = OwnedFile::create(&fd, b"prepared config bytes").expect("prepared and fsynced");
    assert!(matches!(
        file.commit_config("Blocked"),
        Err(Refusal::Unavailable)
    ));
    file.cleanup().expect("owned temp removed");
    assert_eq!(
        std::fs::read(dir.path().join("server.toml")).expect("preserved"),
        b"prior config bytes"
    );
    assert_eq!(std::fs::read_dir(dir.path()).expect("entries").count(), 2);
    let mut retry = OwnedFile::create(&fd, b"replacement config").expect("retry");
    assert!(retry.commit_config("server.toml").expect("commit"));
    drop(retry);
    assert_eq!(
        std::fs::read(dir.path().join("server.toml")).expect("fresh"),
        b"replacement config"
    );
}
#[test]
fn actual_postrename_directory_fsync_failure_is_committed_and_never_rolled_back() {
    let (dir, fd) = root();
    std::fs::write(dir.path().join("server.toml"), b"old").expect("prior");
    let mut file = OwnedFile::create(&fd, b"committed").expect("prepare");
    let scope = FaultScope::new(Fault::DirectorySync);
    assert!(
        !file
            .commit_config("server.toml")
            .expect("postcommit reporting")
    );
    drop(scope);
    drop(file);
    assert_eq!(
        std::fs::read(dir.path().join("server.toml")).expect("committed survives drop"),
        b"committed"
    );
    assert_eq!(std::fs::read_dir(dir.path()).expect("entries").count(), 1);
}
#[test]
fn replaced_or_edited_owned_file_is_retained_not_deleted() {
    for replacement in [false, true] {
        let (dir, fd) = root();
        let mut file = OwnedFile::create(&fd, b"owned").expect("owned");
        let path = dir.path().join(&file.name);
        if replacement {
            std::fs::remove_file(&path).expect("foreign remove");
        }
        std::fs::write(&path, b"foreign edit").expect("foreign bytes");
        assert!(matches!(file.cleanup(), Err(Refusal::Residual)));
        drop(file);
        assert_eq!(std::fs::read(&path).expect("retained"), b"foreign edit");
    }
}
#[test]
fn new_directory_rollback_is_empty_only_and_refuses_replacement_identity() {
    for replacement in [false, true] {
        let (dir, fd) = root();
        let mut root = OwnedDirectory::create(&fd, "New").expect("new");
        if replacement {
            std::fs::rename(dir.path().join("New"), dir.path().join("Moved")).expect("move");
            std::fs::create_dir(dir.path().join("New")).expect("replacement");
        }
        std::fs::write(dir.path().join("New/Foreign.bin"), b"foreign").expect("external tool");
        assert!(matches!(root.cleanup(), Err(Refusal::Residual)));
        drop(root);
        assert_eq!(
            std::fs::read(dir.path().join("New/Foreign.bin")).expect("preserved"),
            b"foreign"
        );
        if replacement {
            assert!(dir.path().join("Moved").is_dir());
        }
    }
}
