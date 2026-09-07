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

/// One note's canonical identity: the file it is, independent of how it was named.
///
/// Produced only by [`Vault::canonical_note`], so holding one is proof the path resolved
/// inside the vault.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CanonicalNote {
    path: PathBuf,
    identity: String,
}

impl CanonicalNote {
    /// The absolute path of the Markdown file.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The vault-relative identity, unique per file and stable across vault moves.
    #[must_use]
    pub fn identity(&self) -> &str {
        &self.identity
    }
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

    /// Resolves a note to the identity every writer for that file must agree on.
    ///
    /// why: two request strings can name one file — a symlink, or a different
    /// capitalization on a case-insensitive filesystem. `mb-server` keeps exactly one
    /// serialized writer per note, and keying that writer on the caller's spelling gives
    /// one file two writers that clobber each other. The vault-relative form of the
    /// canonical path is that identity: stable across a vault being moved, unlike the
    /// absolute path, and unforgeable by a caller, unlike `relative`.
    ///
    /// # Errors
    ///
    /// [`Error::NotFound`] under exactly the conditions [`Vault::resolve`] rejects.
    pub fn canonical_note(&self, relative: &str) -> Result<CanonicalNote, Error> {
        let path = self.resolve(relative)?;
        let base = self
            .notes_root
            .canonicalize()
            .map_err(|_| Error::NotFound)?;
        let identity = path
            .strip_prefix(&base)
            .map_err(|_| Error::NotFound)?
            .to_string_lossy()
            .into_owned();
        Ok(CanonicalNote { path, identity })
    }

    /// Resolves a path for a note that does **not exist yet**, keeping it inside the vault.
    ///
    /// The write-side counterpart to [`Vault::resolve`], which cannot serve here because it
    /// requires the file to be there already. Containment still has to hold, so the rule is
    /// the same one stated differently: canonicalize the **deepest ancestor that exists**
    /// and require it to sit under the canonicalized notes root.
    ///
    /// why the deepest existing ancestor, rather than just the parent: creating
    /// `Away/Deep/Note.md` where `Away` is a symlink out of the vault leaves `Away/Deep`
    /// non-canonicalizable, so a parent-only check silently passes and the subsequent
    /// `create_dir_all` follows the symlink and writes outside the vault. Walking up until
    /// something resolves is what closes that; the loop always terminates, because the notes
    /// root itself exists.
    ///
    /// Shape is **not** checked here — callers validate it first with [`valid_note_path`],
    /// because the order matters for what a refusal reveals (see `rename::note`).
    ///
    /// # Errors
    ///
    /// [`Error::NotFound`] if the path would land outside the vault, matching
    /// [`Vault::resolve`]'s refusal rather than describing the boundary to a caller.
    pub fn reserve(&self, relative: &str) -> Result<PathBuf, Error> {
        let joined = self.notes_root.join(relative);
        let base = self
            .notes_root
            .canonicalize()
            .map_err(|_| Error::NotFound)?;
        let mut ancestor = joined.parent().unwrap_or(&joined).to_path_buf();
        loop {
            if let Ok(real) = ancestor.canonicalize() {
                return if real.starts_with(&base) {
                    Ok(joined)
                } else {
                    Err(Error::NotFound)
                };
            }
            match ancestor.parent() {
                Some(parent) if parent != ancestor => ancestor = parent.to_path_buf(),
                _ => return Err(Error::NotFound),
            }
        }
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
        let base = self
            .notes_root
            .canonicalize()
            .unwrap_or_else(|_| self.notes_root.clone());
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
                // why: the same containment rule [`Vault::resolve`] applies, applied here as
                // well. `resolve` refuses a symlink pointing out of the vault, but this
                // listing did not — and it is what the index is built from, so the *content*
                // of a file the note route will not serve was reaching the index and coming
                // back out through a backlink's context text. The canonicalize is paid only
                // for a symlink, so the ordinary 10 000-note sweep costs nothing extra
                // (§21.2).
                let escapes = entry
                    .file_type()
                    .map(|kind| kind.is_symlink())
                    .unwrap_or(true)
                    && !path
                        .canonicalize()
                        .is_ok_and(|real| real.starts_with(&base));
                if escapes {
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

/// Whether a caller-supplied string is a usable vault-relative path for a **new** note.
///
/// Purely lexical: no filesystem call, so it can be asked before the caller has proved they
/// may write anywhere. That ordering is deliberate and is explained at `rename::note` — a
/// shape refusal reveals nothing, whereas "that already exists" is an answer about a path
/// and must come after authorization.
///
/// Containment is [`Vault::reserve`]'s job, not this function's. Both are required; neither
/// is sufficient. This lives beside `reserve` so the two rules cannot drift apart, which is
/// the failure mode that matters when the same check guards two write paths.
#[must_use]
pub fn valid_note_path(relative: &str) -> bool {
    !relative.is_empty()
        && relative.ends_with(".md")
        && !relative.starts_with('/')
        && !Path::new(relative).is_absolute()
        && !relative
            .split('/')
            .any(|segment| segment.is_empty() || segment.starts_with('.') || segment == "..")
        && mb_core::NotePath::parse(relative).is_ok()
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
