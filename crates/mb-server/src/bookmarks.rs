//! Bookmarked notes (`SPEC.md` §8.2).
//!
//! One file per `(user, vault)` at `<data-dir>/bookmarks/<user>/<vault>.json`.
//!
//! **Not in the vault, and not in `.memberberry/`.** Both were considered:
//!
//! - `.memberberry/` is where the workspace layout lives, and reusing it would have been the
//!   smaller change. But Invariant I1 (§22.4) says that directory holds nothing irreplaceable
//!   — `rm -rf .memberberry/` and everything still works. A bookmark list accumulated over
//!   months is not reconstructible from anything, so it does not belong there.
//! - The vault itself holds "exactly the human-meaningful artifacts, plus `access.toml`"
//!   (§4.1). One user's private shortlist is neither.
//!
//! So it lives in the server-owned data directory, which §4.1 already establishes. The cost is
//! that bookmarks do not travel with a vault moved to another server, which is the right trade
//! for something personal about a shared thing.
//!
//! **Filtered on read.** Unlike a workspace layout — whose tree shape makes filtering awkward,
//! and which is short-lived enough that a stale entry is a minor annoyance — a bookmark list
//! persists for months across ACL changes. Reading it through an
//! [`AuthorizedVault`](crate::repository::AuthorizedVault) means a revoked note leaves the
//! sidebar rather than sitting there as a name the user is no longer allowed to see (§6.5).

use std::fs;
use std::path::{Path, PathBuf};

use mb_core::Username;

use crate::Error;
use crate::vault::Slug;

/// The most bookmarks one user may keep in one vault.
///
/// why: a ceiling at all. This is a shortlist a person curates by hand, so 512 is already far
/// past useful — and without one, an authenticated member can write unbounded data into the
/// server's own directory.
pub const MAX_BOOKMARKS: usize = 512;

/// Bookmark storage for one server.
#[derive(Debug, Clone)]
pub struct BookmarkStore<'a> {
    data_dir: &'a Path,
}

impl<'a> BookmarkStore<'a> {
    #[must_use]
    pub fn new(data_dir: &'a Path) -> Self {
        Self { data_dir }
    }

    /// This user's bookmarks for this vault, in the order they chose.
    ///
    /// # Errors
    ///
    /// Never for an absent or unreadable file: no bookmarks and an unreadable list are the
    /// same thing to a sidebar, and neither is worth an error page. A malformed file is
    /// likewise an empty list — the alternative is a sidebar that refuses to render.
    pub fn load(&self, user: &Username, vault: &Slug) -> Vec<String> {
        let Ok(text) = fs::read_to_string(self.path_for(user, vault)) else {
            return Vec::new();
        };
        let Ok(paths) = serde_json::from_str::<Vec<String>>(&text) else {
            return Vec::new();
        };
        paths
    }

    /// Replaces this user's bookmarks for this vault.
    ///
    /// # Errors
    ///
    /// [`Error::NotFound`] if there are more than [`MAX_BOOKMARKS`] or any entry is not a
    /// usable note path, and [`Error::ReadDir`] for a filesystem failure.
    ///
    /// Every entry is parsed as a [`mb_core::NotePath`] before it is stored. That is not about
    /// this file — it is about everything downstream that will later join these strings to a
    /// vault root, and a `..` reaching one of them is a traversal.
    pub fn save(&self, user: &Username, vault: &Slug, paths: &[String]) -> Result<(), Error> {
        if paths.len() > MAX_BOOKMARKS {
            return Err(Error::NotFound);
        }
        for path in paths {
            mb_core::NotePath::parse(path).map_err(|_| Error::NotFound)?;
        }

        let path = self.path_for(user, vault);
        let parent = path.parent().ok_or(Error::NotFound)?;
        fs::create_dir_all(parent).map_err(|source| Error::ReadDir {
            path: parent.to_path_buf(),
            source,
        })?;

        let body =
            serde_json::to_string(paths).map_err(|error| Error::Config(error.to_string()))?;
        atomic_write(&path, body.as_bytes())
    }

    /// `<data-dir>/bookmarks/<user>/<vault>.json`.
    ///
    /// Both segments are validated newtypes — `Username` is `[a-z0-9_-]{1,64}` and `Slug` is
    /// URL-safe — so neither can escape this directory. That is why they are types.
    fn path_for(&self, user: &Username, vault: &Slug) -> PathBuf {
        self.data_dir
            .join("bookmarks")
            .join(user.as_str())
            .join(format!("{}.json", vault.as_str()))
    }
}

/// Writes through a temporary file in the same directory, then renames.
///
/// A half-written bookmark list reads back as no bookmarks, which silently discards a list
/// somebody curated. Unlike a workspace layout, there is nothing to rebuild it from.
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), Error> {
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, bytes).map_err(|source| Error::ReadDir {
        path: temp.clone(),
        source,
    })?;
    match fs::rename(&temp, path) {
        Ok(()) => Ok(()),
        Err(source) => {
            drop(fs::remove_file(&temp));
            Err(Error::ReadDir {
                path: path.to_path_buf(),
                source,
            })
        }
    }
}
