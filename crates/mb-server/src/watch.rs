//! Filesystem change detection for open notes (`SPEC.md` §3.4).
//!
//! The watcher is a *hint*, never the authority. A platform can coalesce events, drop them
//! under load, or report a rescan instead of a path; `git checkout` of a thousand files is
//! exactly the case that overflows a kernel queue. So this module answers one question —
//! "which files might have changed since you last asked?" — and is allowed to answer "I
//! don't know, check everything". The coordinator's content hash decides what actually
//! changed, and a periodic full sweep covers whatever the watcher missed.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use notify::{EventKind, RecursiveMode, Watcher};

/// What to re-inspect on the next maintenance tick.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Changes {
    /// Inspect every open note. Used for the recovery sweep and after an event overflow.
    All,
    /// Inspect only these paths. An open note absent from the set is left untouched.
    Only(BTreeSet<PathBuf>),
}

impl Changes {
    /// Whether a note at `path` needs re-inspecting.
    #[must_use]
    pub fn includes(&self, path: &Path) -> bool {
        match self {
            Self::All => true,
            Self::Only(paths) => paths.contains(path),
        }
    }

    /// Whether nothing at all needs re-inspecting, so a tick can skip the rooms entirely.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        matches!(self, Self::Only(paths) if paths.is_empty())
    }
}

/// Accumulates filesystem events between maintenance ticks.
#[derive(Debug, Default)]
pub struct WatchSignal {
    dirty: Mutex<BTreeSet<PathBuf>>,
    /// Set when the watcher cannot say *which* paths changed, so the next tick sweeps all.
    overflow: AtomicBool,
}

impl WatchSignal {
    /// Records a specific path as possibly changed.
    pub fn touched(&self, path: PathBuf) {
        match self.dirty.lock() {
            Ok(mut dirty) => {
                dirty.insert(path);
            }
            // why: a poisoned set must not silently stop change detection. Degrading to a
            // full sweep is slower and always correct; skipping the note is neither.
            Err(_) => self.overflow.store(true, Ordering::Relaxed),
        }
    }

    /// Records that changes happened but their paths are unknown.
    pub fn overflowed(&self) {
        self.overflow.store(true, Ordering::Relaxed);
    }

    /// Takes everything accumulated since the last call, clearing it.
    #[must_use]
    pub fn take(&self) -> Changes {
        if self.overflow.swap(false, Ordering::Relaxed) {
            if let Ok(mut dirty) = self.dirty.lock() {
                dirty.clear();
            }
            return Changes::All;
        }
        match self.dirty.lock() {
            Ok(mut dirty) => Changes::Only(std::mem::take(&mut *dirty)),
            Err(_) => Changes::All,
        }
    }
}

/// Live filesystem watchers. Dropping this stops delivery.
///
/// Held rather than detached because `notify` stops watching when its watcher is dropped —
/// a `let _ = watcher(..)` here would compile, run, and silently never fire.
pub struct VaultWatcher {
    _watchers: Vec<notify::RecommendedWatcher>,
}

impl std::fmt::Debug for VaultWatcher {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("VaultWatcher")
            .field("watchers", &self._watchers.len())
            .finish()
    }
}

/// Starts watching `roots` recursively, feeding `signal`.
///
/// Roots that cannot be watched are reported rather than fatal: the maintenance sweep still
/// finds their changes, just at sweep cadence instead of immediately.
///
/// # Errors
///
/// Never fails as a whole. Per-root failures are returned as messages alongside the handle.
pub fn watch(
    roots: &[PathBuf],
    signal: std::sync::Arc<WatchSignal>,
) -> (VaultWatcher, Vec<String>) {
    let mut watchers = Vec::new();
    let mut errors = Vec::new();
    for root in roots {
        let signal = std::sync::Arc::clone(&signal);
        let handler = move |event: notify::Result<notify::Event>| match event {
            Ok(event) if is_content_change(&event.kind) => {
                if event.need_rescan() || event.paths.is_empty() {
                    signal.overflowed();
                    return;
                }
                // The watcher observes the vault recursively, including Memberberry's own
                // derived index. Publishing that index must not schedule another maintenance
                // pass or the server continuously indexes its own writes.
                for path in event
                    .paths
                    .into_iter()
                    .filter(|path| !is_derived_state(path))
                {
                    // Canonicalize so a watcher's spelling of a path matches the one the
                    // coordinator resolved. A deleted path cannot canonicalize, and a
                    // deletion still matters, so fall back to a sweep rather than drop it.
                    match path.canonicalize() {
                        Ok(resolved) => signal.touched(resolved),
                        Err(_) => signal.overflowed(),
                    }
                }
            }
            Ok(_) => {}
            Err(_) => signal.overflowed(),
        };
        match notify::recommended_watcher(handler) {
            Ok(mut watcher) => match watcher.watch(root, RecursiveMode::Recursive) {
                Ok(()) => watchers.push(watcher),
                Err(error) => errors.push(format!("watching {}: {error}", root.display())),
            },
            Err(error) => errors.push(format!(
                "starting a watcher for {}: {error}",
                root.display()
            )),
        }
    }
    (
        VaultWatcher {
            _watchers: watchers,
        },
        errors,
    )
}

/// Whether a path belongs to Memberberry's derived state rather than user-authored content.
fn is_derived_state(path: &std::path::Path) -> bool {
    path.components()
        .any(|component| component.as_os_str() == ".memberberry")
}

/// Whether an event can change a file's bytes. Access-time events cannot, and on some
/// platforms arrive constantly.
fn is_content_change(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) | EventKind::Any
    )
}
