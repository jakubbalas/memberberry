//! A cache of note titles and conflict counts, for the tree and quick switcher
//! (`SPEC.md` §3.5, §8.4, §21.2).
//!
//! §21.2 budgets quick-switcher results at 80 ms over 10 000 notes, and a note's title is not
//! its filename — `Projects/2024-01-15.md` may be "Sprint planning", and someone typing
//! "sprint" expects to find it. Getting the title means parsing the note, and parsing 10 000
//! notes per keystroke is not a thing that can be made fast enough.
//!
//! So summaries are cached, keyed by a cheap fingerprint of the file. A request re-parses only
//! the notes that actually changed, which on a settled vault is none of them. `stat` is
//! roughly three orders of magnitude cheaper than a parse, and it is the only cost paid for a
//! note whose title is already known.
//!
//! **This is not the index of §9.1 and M8.** That one is SQLite, holds links, tags, tasks and
//! headings, and is incrementally maintained. This holds titles and conflict counts and
//! nothing else, because those are what the catalog needs and a half-built index is worse
//! than an honest cache.
//!
//! The cache is **not** permission-filtered and does not need to be: callers hand it paths
//! that an [`AuthorizedVault`](crate::repository::AuthorizedVault) already filtered, so an
//! unreadable note is never named to it in the first place.

use std::collections::HashMap;
use std::path::Path;
use std::sync::RwLock;

/// Cheap evidence a file has not changed. Same shape and same reasoning as `http::FileStamp`:
/// size alone is far too weak, so the modification time carries it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Fingerprint {
    len: u64,
    modified: Option<std::time::SystemTime>,
}

impl Fingerprint {
    fn of(path: &Path) -> Option<Self> {
        let meta = std::fs::metadata(path).ok()?;
        Some(Self {
            len: meta.len(),
            modified: meta.modified().ok(),
        })
    }
}

#[derive(Debug, Clone)]
struct Cached {
    fingerprint: Fingerprint,
    /// `None` when the note has nothing titleable — a real answer, and worth caching so an
    /// untitled note is not re-parsed on every keystroke.
    title: Option<String>,
    /// Unresolved `[!conflict]` callouts, at any depth (`SPEC.md` §3.5).
    conflicts: usize,
}

/// One note, as the tree and quick switcher need it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct NoteSummary {
    /// Vault-relative path, e.g. `Projects/Roadmap.md`.
    pub path: String,
    /// The note's title, or `None` when it has nothing titleable.
    pub title: Option<String>,
    /// Unresolved conflicts, for §3.5's badge in the note tree. `0` for almost every note.
    pub conflicts: usize,
}

/// Summaries for the notes of one vault, cached across requests.
#[derive(Debug, Default)]
pub struct TitleCache {
    // `RwLock` rather than `Mutex`: the common request reads every entry and writes none, and
    // several connections may be typing into their own quick switcher at once.
    entries: RwLock<HashMap<String, Cached>>,
}

impl TitleCache {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Titles for `paths`, re-parsing only what changed.
    ///
    /// `resolve` turns a vault-relative path into an absolute one — the caller's job, because
    /// it is the caller that knows the path is one this user may read.
    ///
    /// A note that cannot be read right now is returned with no title rather than omitted: it
    /// was in the readable list a moment ago, and dropping it would make the switcher's
    /// results depend on a race with the filesystem.
    pub fn summaries<'a>(
        &self,
        paths: impl IntoIterator<Item = &'a str>,
        resolve: impl Fn(&str) -> Option<std::path::PathBuf>,
    ) -> Vec<NoteSummary> {
        let paths: Vec<&str> = paths.into_iter().collect();

        // Fingerprint first, under no lock: this is the I/O, and holding a write lock across
        // it would serialise every open quick switcher behind one of them.
        let mut fresh: Vec<(usize, Fingerprint, Option<std::path::PathBuf>)> =
            Vec::with_capacity(paths.len());
        for (index, path) in paths.iter().enumerate() {
            let absolute = resolve(path);
            let fingerprint = absolute.as_deref().and_then(Fingerprint::of);
            if let Some(fingerprint) = fingerprint {
                fresh.push((index, fingerprint, absolute));
            }
        }

        let mut summaries: Vec<NoteSummary> = paths
            .iter()
            .map(|path| NoteSummary {
                path: (*path).to_string(),
                title: None,
                conflicts: 0,
            })
            .collect();

        // What is already known, and still current.
        let mut stale: Vec<(usize, Fingerprint, std::path::PathBuf)> = Vec::new();
        {
            let Ok(entries) = self.entries.read() else {
                // A poisoned lock means a panic happened while a title was being cached.
                // Reporting no titles is worse for the user than re-parsing, but this is a
                // read path in a note server: failing closed is the standing rule (§3.1).
                return summaries;
            };
            for (index, fingerprint, absolute) in fresh {
                let path = paths.get(index).copied().unwrap_or_default();
                match entries.get(path) {
                    Some(cached) if cached.fingerprint == fingerprint => {
                        if let Some(summary) = summaries.get_mut(index) {
                            summary.title.clone_from(&cached.title);
                            summary.conflicts = cached.conflicts;
                        }
                    }
                    _ => {
                        if let Some(absolute) = absolute {
                            stale.push((index, fingerprint, absolute));
                        }
                    }
                }
            }
        }

        if stale.is_empty() {
            return summaries;
        }

        // Parse only what changed, still without the lock held. One parse answers both
        // questions, which is the whole reason the conflict count lives here.
        let parsed: Vec<(usize, Fingerprint, Option<String>, usize)> = stale
            .into_iter()
            .map(|(index, fingerprint, absolute)| {
                let (title, conflicts) = match std::fs::read_to_string(&absolute) {
                    Ok(source) => {
                        let document = mb_core::parse(&source);
                        (
                            mb_core::extract::title(&document),
                            mb_core::conflict::count(&document),
                        )
                    }
                    Err(_) => (None, 0),
                };
                (index, fingerprint, title, conflicts)
            })
            .collect();

        if let Ok(mut entries) = self.entries.write() {
            for (index, fingerprint, title, conflicts) in &parsed {
                let Some(path) = paths.get(*index) else {
                    continue;
                };
                entries.insert(
                    (*path).to_string(),
                    Cached {
                        fingerprint: *fingerprint,
                        title: title.clone(),
                        conflicts: *conflicts,
                    },
                );
            }
            // Notes that have gone are dropped, so a long-lived server does not accumulate
            // titles for files nobody has had since the last restart.
            let live: std::collections::HashSet<&str> = paths.iter().copied().collect();
            entries.retain(|path, _| live.contains(path.as_str()));
        }

        for (index, _, title, conflicts) in parsed {
            if let Some(summary) = summaries.get_mut(index) {
                summary.title = title;
                summary.conflicts = conflicts;
            }
        }
        summaries
    }

    /// How many titles are cached. For tests and for a future diagnostics surface.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries
            .read()
            .map(|entries| entries.len())
            .unwrap_or(0)
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}
