//! Keeping each vault's index in step with its files (`SPEC.md` §9.1).
//!
//! `mb-index` owns the schema, the queries and the permission filter. What lives here is the
//! part that needs a filesystem and a vault boundary: which files exist, which of them a
//! reconcile has to read, and where the database goes.
//!
//! ## Two cadences, for the reason §3.4 gives
//!
//! The watcher is a hint. When it names paths, those notes are re-read immediately and
//! nothing else is touched — that is the fast path, and it is what makes an edit in Obsidian
//! show up in a backlinks panel a moment later. When it cannot say what changed, or on the
//! slower sweep, the whole vault is reconciled: every note is stamped, changed ones are
//! re-read, and notes that left the vault are dropped.
//!
//! The sweep is the one that is *correct*; the watcher only makes it timely. With no watcher
//! at all — an unwatchable root, a platform that dropped the events — the index is still
//! right, just later.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use mb_index::{Index, NoteInput, Stamp};

use crate::watch::Changes;
use crate::{Slug, Vault};

/// Where a vault's index lives, relative to the vault root (§4.1).
const INDEX_PATH: &str = ".memberberry/index/graph.sqlite";

/// One index per vault, created on first use.
///
/// Behind a `Mutex` rather than a pool: writes are serialized anyway, and a reader has to
/// install its readable set on the connection before it queries, so two readers sharing one
/// connection would be a permission bug rather than a performance win.
#[derive(Debug, Default)]
pub struct IndexRegistry {
    indexes: RwLock<BTreeMap<Slug, Arc<Mutex<Index>>>>,
}

impl IndexRegistry {
    /// This vault's index, opening it if this is the first request for it.
    ///
    /// Returns `None` only if neither an on-disk nor an in-memory index could be created,
    /// which means SQLite itself is unusable.
    pub fn get(&self, vault: &Vault) -> Option<Arc<Mutex<Index>>> {
        if let Ok(open) = self.indexes.read()
            && let Some(index) = open.get(vault.slug())
        {
            return Some(Arc::clone(index));
        }
        let index = Self::open(vault)?;
        let Ok(mut open) = self.indexes.write() else {
            // A poisoned map costs the cache, not the request: this index is correct, it
            // just will not be reused. The alternative is a vault with no graph at all.
            return Some(Arc::new(Mutex::new(index)));
        };
        Some(Arc::clone(
            open.entry(vault.slug().clone())
                .or_insert_with(|| Arc::new(Mutex::new(index))),
        ))
    }

    /// why: a vault directory is not guaranteed writable — a read-only mount, a vault owned
    /// by another user, a container with the volume mounted `ro`. The index is derived
    /// state, so the honest degradation is an index that has to be rebuilt on every start
    /// rather than a vault that serves no backlinks. Both are correct; only one is fast.
    fn open(vault: &Vault) -> Option<Index> {
        match Index::open(vault.root().join(INDEX_PATH)) {
            Ok(index) => Some(index),
            Err(error) => {
                eprintln!(
                    "memberberry index: {} is not usable ({error}); keeping this vault's index in memory",
                    vault.root().join(INDEX_PATH).display()
                );
                Index::in_memory().ok()
            }
        }
    }

    /// Brings every vault's index in step with what is on disk.
    ///
    /// Blocking: parses every changed note. Callers keep it off the async runtime.
    pub fn maintain<'a>(
        &self,
        vaults: impl Iterator<Item = &'a Vault>,
        changed: &Changes,
    ) -> Vec<String> {
        let mut errors = Vec::new();
        for vault in vaults {
            let Some(index) = self.get(vault) else {
                errors.push(format!(
                    "vault `{}`: no index could be opened",
                    vault.slug()
                ));
                continue;
            };
            let Ok(mut index) = index.lock() else {
                errors.push(format!(
                    "vault `{}`: the index lock is poisoned; skipping this tick",
                    vault.slug()
                ));
                continue;
            };
            let outcome = match changed {
                Changes::All => sweep(vault, &mut index),
                Changes::Only(paths) => touched(vault, &mut index, paths.iter()),
            };
            if let Err(error) = outcome {
                errors.push(format!("vault `{}`: {error}", vault.slug()));
            }
        }
        errors
    }
}

/// Reconciles the whole vault: stamp everything, re-read what changed, drop what is gone.
fn sweep(vault: &Vault, index: &mut Index) -> Result<(), String> {
    let notes = vault
        .notes()
        .map_err(|error| format!("listing notes: {error}"))?;
    let present: Vec<(String, Stamp)> = notes
        .iter()
        .filter_map(|relative| {
            // Joined rather than resolved: `notes()` listed real files under the notes root,
            // so containment is already established and `resolve` would canonicalize twice
            // per note — 20 000 syscalls on a vault at the design target.
            Stamp::of(&vault.notes_root().join(relative)).map(|stamp| (relative.clone(), stamp))
        })
        .collect();
    let plan = index
        .reconcile(&present)
        .map_err(|error| format!("reconciling: {error}"))?;
    for relative in plan.stale {
        reindex(vault, index, &relative)?;
    }
    Ok(())
}

/// Re-reads exactly the paths the watcher named, and nothing else.
fn touched<'a>(
    vault: &Vault,
    index: &mut Index,
    paths: impl Iterator<Item = &'a PathBuf>,
) -> Result<(), String> {
    // why: canonicalized. Watcher events carry canonical paths (`watch.rs`), and a vault
    // root spelled through a symlink — `/tmp` on macOS is one — would otherwise never match
    // a single event.
    let Ok(base) = vault.notes_root().canonicalize() else {
        return Ok(());
    };
    for path in paths {
        let Some(relative) = relative_note(&base, path) else {
            continue;
        };
        // A deleted file cannot be canonicalized, so the watcher reports a deletion as an
        // overflow and it arrives here as a sweep instead (`watch.rs`). Anything that got
        // this far and is now missing is a race with a delete, and the sweep will catch it.
        if path.is_file() {
            reindex(vault, index, &relative)?;
        }
    }
    Ok(())
}

/// Reads one note and writes its rows.
///
/// A note that cannot be read is skipped rather than fatal: a file being written by another
/// process is ordinary, and the stamp it is left with means the next reconcile tries again.
fn reindex(vault: &Vault, index: &mut Index, relative: &str) -> Result<(), String> {
    let path = vault.notes_root().join(relative);
    let Some(stamp) = Stamp::of(&path) else {
        return Ok(());
    };
    let Ok(markdown) = std::fs::read_to_string(&path) else {
        return Ok(());
    };
    index
        .upsert(&NoteInput {
            path: relative.to_string(),
            markdown,
            stamp,
        })
        .map_err(|error| format!("indexing {relative}: {error}"))?;
    Ok(())
}

/// The vault-relative note path for an absolute path, or `None` if it is not a note.
///
/// Mirrors what `Vault::notes` includes: Markdown files, and nothing inside a dotted
/// directory — so `.memberberry/` cannot be indexed, and neither can `.obsidian/`.
fn relative_note(base: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(base).ok()?;
    if relative
        .extension()
        .is_none_or(|extension| extension != "md")
    {
        return None;
    }
    if relative
        .components()
        .any(|component| component.as_os_str().to_string_lossy().starts_with('.'))
    {
        return None;
    }
    Some(relative.to_string_lossy().replace('\\', "/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_markdown_file_under_the_notes_root_is_a_note() {
        assert_eq!(
            relative_note(
                Path::new("/vault/notes"),
                Path::new("/vault/notes/Projects/Roadmap.md")
            )
            .as_deref(),
            Some("Projects/Roadmap.md")
        );
    }

    #[test]
    fn a_file_outside_the_notes_root_is_not_a_note() {
        assert_eq!(
            relative_note(Path::new("/vault/notes"), Path::new("/etc/passwd.md")),
            None
        );
    }

    #[test]
    fn a_non_markdown_file_is_not_a_note() {
        assert_eq!(
            relative_note(
                Path::new("/vault/notes"),
                Path::new("/vault/notes/media/a.png")
            ),
            None
        );
    }

    #[test]
    fn nothing_under_a_dotted_directory_is_a_note() {
        // The index database itself lives under `.memberberry/`, and a `.md` file in there
        // would make the index index itself.
        assert_eq!(
            relative_note(
                Path::new("/vault/notes"),
                Path::new("/vault/notes/.memberberry/trash/Deleted.md")
            ),
            None
        );
        assert_eq!(
            relative_note(
                Path::new("/vault/notes"),
                Path::new("/vault/notes/.obsidian/notes.md")
            ),
            None
        );
    }
}
