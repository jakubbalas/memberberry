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
mod filtered;

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
    generation: std::sync::atomic::AtomicU64,
    changed: tokio::sync::Notify,
}

impl WatchSignal {
    fn announce(&self) {
        self.generation.fetch_add(1, Ordering::Release);
        self.changed.notify_waiters();
    }

    /// Monotonic event receipt count, for bounded event-driven maintenance/observation.
    #[must_use]
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    /// Waits for a genuine delivered change after `after`, without a polling sleep.
    pub async fn changed_after(&self, after: u64) {
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.generation() > after {
                return;
            }
            notified.await;
        }
    }

    /// Records a specific path as possibly changed.
    pub fn touched(&self, path: PathBuf) {
        match self.dirty.lock() {
            Ok(mut dirty) => {
                if dirty.len() >= 16_384 {
                    dirty.clear();
                    self.overflow.store(true, Ordering::Relaxed);
                } else {
                    dirty.insert(path);
                }
            }
            // why: a poisoned set must not silently stop change detection. Degrading to a
            // full sweep is slower and always correct; skipping the note is neither.
            Err(_) => self.overflow.store(true, Ordering::Relaxed),
        }
        self.announce();
    }

    /// Records that changes happened but their paths are unknown.
    pub fn overflowed(&self) {
        self.overflow.store(true, Ordering::Relaxed);
        self.announce();
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn merge(&self, changes: Changes) {
        match changes {
            Changes::All => self.overflowed(),
            Changes::Only(paths) => {
                for path in paths {
                    self.touched(path);
                }
            }
        }
    }
    #[cfg(all(test, target_os = "linux"))]
    pub(crate) fn pending_path(&self, path: &Path) -> bool {
        self.dirty.lock().is_ok_and(|dirty| dirty.contains(path))
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
    ignore_non_writable_folders: bool,
    #[cfg(target_os = "linux")]
    pub(crate) signal: std::sync::Arc<Mutex<std::sync::Arc<WatchSignal>>>,
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
    let groups: Vec<_> = roots
        .iter()
        .map(|root| (vec![root.clone()], RecursiveMode::Recursive))
        .collect();
    watch_groups(&groups, signal)
}

pub(crate) fn watch_for_vault(
    root: &Path,
    signal: std::sync::Arc<WatchSignal>,
    ignore_non_writable_folders: bool,
) -> (VaultWatcher, Vec<String>) {
    if !ignore_non_writable_folders {
        return watch(&[root.to_path_buf()], signal);
    }
    let directories = match filtered::directories(root) {
        Ok(paths) if !paths.is_empty() => paths,
        Ok(_) | Err(_) => {
            let (mut watcher, _) = watch_groups(&[], signal);
            watcher.ignore_non_writable_folders = true;
            return (
                watcher,
                vec!["filtered vault watcher preparation unavailable".into()],
            );
        }
    };
    // One native watcher with nonrecursive subscriptions; excluded folders are never opened.
    let (mut watcher, errors) = watch_groups(&[(directories, RecursiveMode::NonRecursive)], signal);
    watcher.ignore_non_writable_folders = true;
    (watcher, errors)
}

fn watch_groups(
    groups: &[(Vec<PathBuf>, RecursiveMode)],
    signal: std::sync::Arc<WatchSignal>,
) -> (VaultWatcher, Vec<String>) {
    let mut watchers = Vec::new();
    let mut errors = Vec::new();
    // why: registration stages real events until registry publication. Retargeting this
    // relay under its lock transfers pending events without an enrollment/index gap.
    let relay = std::sync::Arc::new(Mutex::new(signal.clone()));
    for (paths, recursive_mode) in groups {
        let relay = relay.clone();
        let fallback = signal.clone();
        let handler = move |event: notify::Result<notify::Event>| {
            let Ok(signal) = relay.lock() else {
                fallback.overflowed();
                return;
            };
            match event {
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
                        // why: resolving a link would inspect its target and lose the
                        // alias identity. A sweep drops any formerly indexed real path.
                        if std::fs::symlink_metadata(&path)
                            .is_ok_and(|metadata| metadata.file_type().is_symlink())
                        {
                            signal.overflowed();
                            continue;
                        }
                        if std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.is_dir())
                            || matches!(
                                event.kind,
                                EventKind::Remove(notify::event::RemoveKind::Folder)
                            )
                        {
                            signal.overflowed();
                            continue;
                        }
                        // Canonicalize so a watcher's spelling of a path matches the one the
                        // coordinator resolved. A deleted path cannot canonicalize, and a
                        // deletion still matters: a concrete file removal retains its parent's
                        // canonical spelling; ambiguous removals degrade to a watcher rescan.
                        match path.canonicalize() {
                            Ok(resolved) => signal.touched(resolved),
                            Err(_)
                                if matches!(
                                    event.kind,
                                    EventKind::Remove(notify::event::RemoveKind::File)
                                ) =>
                            {
                                match path
                                    .parent()
                                    .and_then(|parent| parent.canonicalize().ok())
                                    .zip(path.file_name())
                                {
                                    Some((parent, name)) => signal.touched(parent.join(name)),
                                    None => signal.overflowed(),
                                }
                            }
                            Err(_) => signal.overflowed(),
                        }
                    }
                }
                Ok(_) => {}
                Err(_) => signal.overflowed(),
            }
        };
        match notify::RecommendedWatcher::new(
            handler,
            notify::Config::default().with_follow_symlinks(false),
        ) {
            Ok(mut watcher) => {
                for path in paths {
                    if let Err(error) = watcher.watch(path, *recursive_mode) {
                        errors.push(format!("watching {}: {error}", path.display()));
                    }
                }
                watchers.push(watcher);
            }
            Err(error) => errors.push(format!("starting a watcher: {error}")),
        }
    }
    (
        VaultWatcher {
            _watchers: watchers,
            ignore_non_writable_folders: false,
            #[cfg(target_os = "linux")]
            signal: relay,
        },
        errors,
    )
}

/// Server-owned live watcher registry. Short locks only; enrollment is prepared off-lock.
#[derive(Debug, Default)]
pub(crate) struct RuntimeWatchers(pub(crate) std::sync::Arc<Mutex<Option<LiveWatchers>>>);

#[derive(Debug)]
pub(crate) struct LiveWatchers {
    pub(crate) signal: std::sync::Arc<WatchSignal>,
    pub(crate) roots: std::collections::BTreeMap<PathBuf, VaultWatcher>,
}

/// Ownership of a running server's watchers. Dropping it stops all delivery, including
/// roots enrolled after startup. It does not own or recursively delete vault storage.
#[derive(Debug)]
pub struct WatchLease(std::sync::Arc<Mutex<Option<LiveWatchers>>>);
impl Drop for WatchLease {
    fn drop(&mut self) {
        if let Ok(mut live) = self.0.lock() {
            *live = None;
        }
    }
}
impl RuntimeWatchers {
    pub(crate) fn refresh_filtered(&self) -> Vec<String> {
        let snapshot: Vec<_> = match self.0.lock() {
            Ok(live) => live
                .as_ref()
                .map(|running| {
                    running
                        .roots
                        .iter()
                        .filter(|(_, watcher)| watcher.ignore_non_writable_folders)
                        .map(|(path, _)| (path.clone(), running.signal.clone()))
                        .collect()
                })
                .unwrap_or_default(),
            Err(_) => return vec!["watch registry unavailable".into()],
        };
        let mut errors = Vec::new();
        for (path, signal) in snapshot {
            let (watcher, problems) = watch_for_vault(&path, signal, true);
            if !problems.is_empty() {
                errors.extend(problems);
                continue;
            }
            if let Ok(mut live) = self.0.lock()
                && let Some(running) = live.as_mut()
                && running
                    .roots
                    .get(&path)
                    .is_some_and(|old| old.ignore_non_writable_folders)
            {
                running.roots.insert(path, watcher);
            }
        }
        errors
    }

    pub(crate) fn start(
        &self,
        roots: &[PathBuf],
        filtered_roots: &[PathBuf],
        signal: std::sync::Arc<WatchSignal>,
    ) -> Result<(WatchLease, Vec<String>), String> {
        let mut live = self.0.lock().map_err(|_| "watch registry unavailable")?;
        if live.is_some() {
            return Err("watch registry already running".into());
        }
        let mut running = LiveWatchers {
            signal: signal.clone(),
            roots: std::collections::BTreeMap::new(),
        };
        let mut errors = Vec::new();
        let mut paths = Vec::new();
        for root in roots {
            match root.canonicalize() {
                Ok(path) => paths.push(path),
                Err(error) => errors.push(format!("watching {}: {error}", root.display())),
            }
        }
        let filtered: std::collections::BTreeSet<_> = filtered_roots
            .iter()
            .filter_map(|p| p.canonicalize().ok())
            .collect();
        paths.sort_by_key(|p| p.components().count());
        for path in paths {
            if running.roots.keys().any(|root| path.starts_with(root)) {
                continue;
            }
            let (watcher, problems) =
                watch_for_vault(&path, signal.clone(), filtered.contains(&path));
            if problems.is_empty() {
                running.roots.insert(path, watcher);
            }
            errors.extend(problems);
        }
        *live = Some(running);
        Ok((WatchLease(self.0.clone()), errors))
    }
}

/// Whether a path belongs to Memberberry's derived state rather than user-authored content.
fn is_derived_state(path: &std::path::Path) -> bool {
    path.components()
        .any(|component| component.as_os_str() == ".memberberry")
        || path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                let Some(name) = name.strip_prefix(".memberberry-") else {
                    return false;
                };
                let Some(token) = name
                    .strip_suffix(".tmp")
                    .or_else(|| name.strip_suffix(".probe"))
                else {
                    return false;
                };
                token.len() == 64
                    && token
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
}

/// Whether an event can change a file's bytes. Access-time events cannot, and on some
/// platforms arrive constantly.
fn is_content_change(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) | EventKind::Any
    )
}
