//! A vault: a slug, a display name, and a root on disk.
//!
//! A vault is the unit of file root, index, permissions and everything else (`SPEC.md`
//! §6.1). M0 needs only the first of those, but the *boundary* is worth getting right now:
//! every path that will ever be served comes through [`Vault::resolve`], and retrofitting
//! containment onto a server that already reads arbitrary paths is how directory-traversal
//! bugs ship.

use std::path::{Component, Path, PathBuf};

use crate::Error;

/// A registered vault.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Vault {
    slug: Slug,
    name: String,
    root: PathBuf,
    /// Where notes actually live — see [`Vault::notes_root`].
    notes_root: PathBuf,
}

impl Vault {
    /// Opens a vault at `root`.
    ///
    /// # Errors
    ///
    /// Fails if the root does not exist or is not a directory. A vault registered against a
    /// missing path is a configuration mistake worth reporting at startup rather than as a
    /// 404 on the first request.
    pub fn open(
        slug: Slug,
        name: impl Into<String>,
        root: impl Into<PathBuf>,
    ) -> Result<Self, Error> {
        let root = root.into();
        let meta = std::fs::metadata(&root).map_err(|source| Error::VaultRoot {
            slug: slug.to_string(),
            path: root.clone(),
            source,
        })?;
        if !meta.is_dir() {
            return Err(Error::VaultRootNotADirectory {
                slug: slug.to_string(),
                path: root,
            });
        }
        // why: `SPEC.md` §4.1 puts notes in `<vault>/notes/`. An existing Obsidian vault has
        // them at its root instead, and refusing to open one would make this server useless
        // against the only real corpus anybody has. So the spec layout wins when it is
        // present, and the root is used when it is not. Recorded in SPEC §4.1.
        let spec_layout = root.join("notes");
        let notes_root = if spec_layout.is_dir() {
            spec_layout
        } else {
            root.clone()
        };
        Ok(Self {
            slug,
            name: name.into(),
            root,
            notes_root,
        })
    }

    #[must_use]
    pub fn slug(&self) -> &Slug {
        &self.slug
    }

    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// `<vault>/notes` when it exists, otherwise the vault root.
    #[must_use]
    pub fn notes_root(&self) -> &Path {
        &self.notes_root
    }

    /// Resolves a request-supplied relative path to a real file inside the vault.
    ///
    /// This is the containment boundary — the only thing between a URL and the rest of the
    /// filesystem. Two checks, and it is worth knowing which one carries the weight:
    ///
    /// 1. **Load-bearing:** the result is canonicalized and required to sit under the
    ///    canonicalized notes root. This catches ordinary `../` traversal *and* the case no
    ///    lexical check can see — a symlink inside the vault pointing out of it, which an
    ///    Obsidian vault may well contain.
    /// 2. **A cheap pre-filter:** an absolute path or one containing `..` is rejected before
    ///    any filesystem call. Deliberately kept even though check 1 subsumes it — deleting
    ///    it changes no test, which is exactly why this note exists, so a future reader does
    ///    not mistake it for the real boundary and delete that instead.
    ///
    /// # Errors
    ///
    /// [`Error::NotFound`] for anything that does not resolve to a readable file inside the
    /// vault — including a traversal attempt. why: a distinct "forbidden" would confirm that
    /// the path exists, and §6.5's invisibility rule says a thing you may not read does not
    /// exist for you.
    pub fn resolve(&self, relative: &str) -> Result<PathBuf, Error> {
        let candidate = Path::new(relative);
        let traversal = candidate.is_absolute()
            || candidate.components().any(|c| {
                matches!(
                    c,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            });
        if traversal {
            return Err(Error::NotFound);
        }
        // The same two rules `notes` lists by. They belong here as well, not only there:
        // when the listing and the serving disagree, the file you cannot see is still the
        // file you can fetch. Found serving `.git/config` — which can hold a remote URL
        // with credentials in it — from a real Obsidian vault.
        let hidden = candidate
            .components()
            .any(|c| c.as_os_str().to_string_lossy().starts_with('.'));
        if hidden {
            return Err(Error::NotFound);
        }
        if candidate.extension().is_none_or(|e| e != "md") {
            return Err(Error::NotFound);
        }

        let joined = self.notes_root.join(candidate);
        let real = joined.canonicalize().map_err(|_| Error::NotFound)?;
        let base = self
            .notes_root
            .canonicalize()
            .map_err(|_| Error::NotFound)?;
        if !real.starts_with(&base) {
            return Err(Error::NotFound);
        }
        if !real.is_file() {
            return Err(Error::NotFound);
        }
        Ok(real)
    }

    /// Finds a note by the human-readable name a wikilink carries (`SPEC.md` §4.3).
    ///
    /// `[[Daily]]` has to reach `todos/Daily.md`, so a literal path lookup is not enough —
    /// in a foldered vault it would make every wikilink a dead link. Accepts the name with
    /// or without its `.md`, and a path prefix if one was written to disambiguate.
    ///
    /// §4.3 resolves collisions by *nearest* path, which needs the index to know which note
    /// is asking. Until M4 this takes the shallowest match, which is deterministic and is
    /// the right answer whenever a vault has one obvious home for a name.
    ///
    /// Linear in the number of notes, and re-listed per call. Fine at M0 scale and
    /// deliberately not cached: a stale cache would serve a note that has been renamed.
    /// This becomes an index lookup when there is an index.
    #[must_use]
    pub fn find_by_name(&self, name: &str) -> Option<String> {
        let wanted = name.trim_end_matches(".md");
        if wanted.is_empty() {
            return None;
        }
        // Compared in NFC because the two sides come from different places: the name from
        // note text, the path from the filesystem. macOS hands back decomposed names, so
        // `Ç` from a wikilink and `Ç` from a directory listing are different byte strings
        // for the same character unless both are normalised first.
        let wanted = nfc(wanted);
        let notes = self.notes().ok()?;
        notes
            .into_iter()
            .filter(|rel| {
                let stem = nfc(rel.trim_end_matches(".md"));
                stem == wanted || stem.rsplit('/').next() == Some(wanted.as_str())
            })
            // Shallowest first, then alphabetical, so the answer never depends on
            // filesystem iteration order.
            .min_by_key(|rel| (rel.matches('/').count(), rel.clone()))
    }

    /// Every note in the vault, as paths relative to the notes root, sorted.
    ///
    /// Skips dotted directories, so `.memberberry/` (derived state, Invariant I1) and
    /// `.obsidian/` (another application's config) never appear as notes.
    ///
    /// # Errors
    ///
    /// Fails if the notes root cannot be read.
    pub fn notes(&self) -> Result<Vec<String>, Error> {
        let mut found = Vec::new();
        let mut stack = vec![self.notes_root.clone()];
        while let Some(dir) = stack.pop() {
            let entries = std::fs::read_dir(&dir).map_err(|source| Error::ReadDir {
                path: dir.clone(),
                source,
            })?;
            for entry in entries {
                let entry = entry.map_err(|source| Error::ReadDir {
                    path: dir.clone(),
                    source,
                })?;
                let path = entry.path();
                if entry.file_name().to_string_lossy().starts_with('.') {
                    continue;
                }
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().is_some_and(|e| e == "md")
                    && let Ok(rel) = path.strip_prefix(&self.notes_root)
                {
                    found.push(rel.to_string_lossy().replace('\\', "/"));
                }
            }
        }
        found.sort();
        Ok(found)
    }
}

/// Normalises to NFC, the form note text is written in.
fn nfc(text: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    text.nfc().collect()
}

/// A vault's URL-safe identifier.
///
/// A newtype because it lands directly in a route (`/v/<slug>/…`, §6.1) and in a filesystem
/// lookup. Parsing once at the boundary means no later code has to wonder whether the
/// string it holds was checked (AGENTS.md §4.1).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Slug(String);

impl Slug {
    /// Accepts lowercase ASCII letters, digits and internal hyphens.
    ///
    /// # Errors
    ///
    /// Returns [`Error::InvalidSlug`] for anything else. Deliberately narrow: a slug with a
    /// dot, a slash or a percent could be read as a path or an escape by something
    /// downstream, and a name that only differs by case would make two vaults collide on a
    /// case-insensitive filesystem.
    pub fn parse(raw: &str) -> Result<Self, Error> {
        let ok = !raw.is_empty()
            && raw.len() <= 64
            && !raw.starts_with('-')
            && !raw.ends_with('-')
            && raw
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        if ok {
            Ok(Self(raw.to_string()))
        } else {
            Err(Error::InvalidSlug(raw.to_string()))
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for Slug {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
