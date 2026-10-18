//! Unprivileged real-HTTP assertions; success alone never proves a child ran.
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const CHILD: &str = "MB_HTTP_SAFETY_CHILD";

/// Run the exact test under a genuinely unprivileged identity in private fixture storage.
/// Returns true only in the parent, after the child's post-assertion proof and cleanup.
pub fn run_unprivileged(test: &str) -> bool {
    if std::env::var(CHILD).as_deref() == Ok(test) {
        #[cfg(target_os = "linux")]
        {
            assert!(
                !rustix::process::getuid().is_root(),
                "real uid must not be root"
            );
            assert!(
                !rustix::process::geteuid().is_root(),
                "effective uid must not be root"
            );
            let status = fs::read_to_string("/proc/self/status").expect("child identity");
            let effective = status
                .lines()
                .find(|line| line.starts_with("CapEff:"))
                .expect("effective capabilities");
            assert_eq!(
                effective.split_whitespace().nth(1),
                Some("0000000000000000")
            );
            for line in status.lines().filter(|line| {
                line.starts_with("Uid:")
                    || line.starts_with("Gid:")
                    || line.starts_with("Groups:")
                    || line.starts_with("CapEff:")
            }) {
                println!("HTTP safety identity: {line}");
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            assert_ne!(unix_uid("-ru"), "0", "real uid must not be root");
            assert_ne!(unix_uid("-u"), "0", "effective uid must not be root");
        }
        return false;
    }
    let scratch = tempfile::Builder::new()
        .prefix("mb-http-safety-")
        .tempdir()
        .expect("isolated child scratch");
    // why: only this disposable parent is writable; the child creates and owns its fixtures.
    fs::set_permissions(scratch.path(), fs::Permissions::from_mode(0o777))
        .expect("child scratch access");
    let binary = std::env::current_exe().expect("test executable");
    let mut command;
    #[cfg(target_os = "linux")]
    {
        if rustix::process::geteuid().is_root() {
            // why: clear supplementary groups and all capabilities, not just the uid label.
            command = Command::new("setpriv");
            command.args([
                "--reuid=65534",
                "--regid=65534",
                "--clear-groups",
                "--bounding-set=-all",
                "--inh-caps=-all",
                "--ambient-caps=-all",
            ]);
            command.arg(&binary);
        } else {
            command = Command::new(&binary);
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        use std::os::unix::process::CommandExt;
        command = Command::new(&binary);
        if unix_uid("-u") == "0" {
            command.uid(65534).gid(65534);
        }
    }
    let output = command
        .args(["--exact", test, "--nocapture", "--test-threads=1"])
        .env(CHILD, test)
        .env("TMPDIR", scratch.path())
        .output()
        .expect("unprivileged HTTP child");
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        println!("child> {line}");
    }
    for line in String::from_utf8_lossy(&output.stderr).lines() {
        println!("child stderr> {line}");
    }
    scratch.close().expect("remove isolated child fixtures");
    assert!(
        completed(&output, test),
        "exact child safety assertions did not complete: {test}"
    );
    true
}

#[cfg(not(target_os = "linux"))]
fn unix_uid(flag: &str) -> String {
    let output = Command::new("id")
        .arg(flag)
        .output()
        .expect("unix identity");
    assert!(output.status.success(), "id must report the real identity");
    String::from_utf8(output.stdout)
        .expect("uid output")
        .trim()
        .to_owned()
}

pub fn mark_completed(test: &str) {
    println!("\nMB_HTTP_SAFETY_ASSERTIONS_COMPLETED {test}");
}

pub fn completed(output: &Output, test: &str) -> bool {
    let marker = format!("MB_HTTP_SAFETY_ASSERTIONS_COMPLETED {test}");
    output.status.success()
        && String::from_utf8_lossy(&output.stdout)
            .lines()
            .any(|line| line == marker)
}

pub fn unmatched_output() -> Output {
    Command::new(std::env::current_exe().expect("test executable"))
        .args(["--exact", "no_such_http_safety_test", "--nocapture"])
        .output()
        .expect("unmatched child")
}

#[cfg(target_os = "linux")]
pub struct CreationTrace(std::os::fd::OwnedFd);
#[cfg(target_os = "linux")]
impl CreationTrace {
    pub fn new(managed_root: &Path) -> Self {
        use rustix::fs::inotify;
        let watch = inotify::init(inotify::CreateFlags::NONBLOCK).expect("creation observer");
        inotify::add_watch(
            &watch,
            managed_root,
            inotify::WatchFlags::CREATE | inotify::WatchFlags::DELETE,
        )
        .expect("watch isolated managed root");
        Self(watch)
    }

    pub fn assert_created_then_removed(&self, slug: &str) {
        use rustix::fs::inotify;
        let mut bytes = [std::mem::MaybeUninit::uninit(); 4096];
        let mut reader = inotify::Reader::new(&self.0, &mut bytes);
        let mut created = false;
        let mut removed = false;
        loop {
            match reader.next() {
                Ok(event) => {
                    if event
                        .file_name()
                        .is_some_and(|name| name.to_bytes() == slug.as_bytes())
                    {
                        if event.events().contains(inotify::ReadFlags::CREATE) {
                            created = true;
                        }
                        if event.events().contains(inotify::ReadFlags::DELETE) {
                            assert!(created, "rollback deletion must follow creation");
                            removed = true;
                        }
                    }
                }
                Err(rustix::io::Errno::AGAIN) => break,
                Err(error) => panic!("creation observer failed: {error}"),
            }
        }
        assert!(
            created && removed,
            "must observe created vault then rollback, not an early refusal"
        );
        println!("HTTP safety: observed managed vault creation then rollback deletion");
    }
}

/// Restore only a fixture's original permissions, including on assertion unwinding.
pub struct FixtureMode {
    path: PathBuf,
    original: fs::Permissions,
}
impl FixtureMode {
    pub fn set(path: &Path, mode: u32) -> Self {
        let original = fs::metadata(path).expect("fixture mode").permissions();
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).expect("fixture fault mode");
        Self {
            path: path.to_owned(),
            original,
        }
    }
}
impl Drop for FixtureMode {
    fn drop(&mut self) {
        fs::set_permissions(&self.path, self.original.clone()).expect("restore fixture mode");
    }
}
