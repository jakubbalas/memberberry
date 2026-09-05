//! Renaming a note or a tag, with inbound links rewritten (`SPEC.md` §6.6, E14).
//!
//! ## Why this is privileged, and what that costs
//!
//! Renaming `Roadmap.md` breaks every `[[Roadmap]]` in the vault, including the ones in
//! notes the actor cannot read and could not write. §6.6 decided that leaving those broken
//! is worse than the alternative, so the rewrite runs as a **system operation** justified by
//! the actor's right to rename the target — not by their right to edit each note it touches.
//!
//! That makes this the one place in the codebase that reads outside a user's readable set,
//! so it is written to be obvious about it:
//!
//! - The privilege is a **named principal** ([`SYSTEM`]) holding a synthetic vault-wide
//!   `owner` ACL, not a bypass flag. `mb-index` still has no unfiltered query and still
//!   exposes no connection (E5); this operation is simply a reader whose ACL grants
//!   everything, and §4.3's resolution rule stays the one in `readable.rs` rather than being
//!   reimplemented here.
//! - **Nothing privileged reaches the actor.** The reply counts only the notes the actor can
//!   read; the full list of files touched goes to the audit log (§6.9), which has no UI. A
//!   count of "47 notes updated" would answer "how many notes link to this one", which §6.5
//!   says is a way of asking how many notes exist.
//! - **The refusals are one refusal.** A note the actor cannot read, a note that is not
//!   there, and a vault they are not in all answer [`RenameError::Denied`].
//!
//! ## Order of operations, and what a failure leaves behind
//!
//! 1. Every rewrite is computed **in memory** first. A note whose rewrite cannot be verified
//!    aborts the whole rename with nothing written (`mb_core::rewrite` explains what it
//!    verifies and why).
//! 2. The note's sync room is flushed and closed, so no coordinator is holding the old path.
//! 3. The file moves, and its CRDT sidecar moves with it.
//! 4. The rewrites are written, each atomically.
//! 5. The index is swept, so backlinks and the tag tree agree with the files again.
//!
//! A failure in step 4 is the one that can leave work half-done: the note has moved and some
//! inbound links still name the old title. That is recorded in the audit log as a failure
//! with every file it had touched, and re-running the rename fixes the rest — the reverse
//! order, rewriting first, would instead point every link at a note that does not exist yet.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use mb_core::rewrite::{self, RewriteError};
use mb_core::{Access, Member, NotePath, Role, Username};
use mb_index::Index;

use crate::Vault;
use crate::audit::{AuditAction, AuditEvent, AuditLog, AuditResult};
use crate::repository::AuthorizedVault;
use crate::sync::SyncRegistry;

/// The principal a privileged rewrite runs as.
///
/// A real name rather than a boolean, so it appears in a stack trace and can be grepped
/// for. It is never authenticated as, never written to an `access.toml`, and never named in
/// a response; it exists only to give [`Index::reader`] an ACL that admits every note.
const SYSTEM: &str = "memberberry-system";

/// What a completed rename is willing to say about itself.
///
/// Deliberately thin. Everything here is derived from what the **actor** can read, so it
/// carries no information about notes that do not exist for them (§6.5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Renamed {
    /// The new note path, or the new tag.
    pub to: String,
    /// How many notes the actor can read had a reference rewritten.
    pub notes: usize,
    /// How many references were rewritten in those notes.
    pub references: usize,
}

/// Why a rename did not happen.
#[derive(Debug, thiserror::Error)]
pub enum RenameError {
    /// The actor may not do this, or the thing being renamed does not exist for them.
    ///
    /// One variant for both on purpose: a separate "forbidden" would confirm the note is
    /// there (§6.5).
    #[error("not found")]
    Denied,
    /// The new name is not usable — as a path, as a tag, or inside a wikilink.
    #[error("`{0}` is not a usable name")]
    InvalidName(String),
    /// Something is already at the new path.
    #[error("`{0}` already exists")]
    Exists(String),
    /// A note could not be rewritten safely, so nothing was written at all.
    ///
    /// The note is **not** named: the actor may not be able to read it. The audit log has
    /// it, and the audit log has no UI (§6.9).
    #[error(
        "the rename was refused because a note could not be rewritten without changing \
         something other than the link; nothing was written"
    )]
    Unverified,
    /// The filesystem, the index or the sync registry refused part of the operation.
    #[error("{0}")]
    Failed(String),
}

/// One vault's rename capability, bound to the actor asking for it.
#[derive(Debug)]
pub struct Rename<'a> {
    vault: &'a Vault,
    access: &'a Access,
    actor: Username,
    index: &'a Mutex<Index>,
    sync: &'a SyncRegistry,
    /// Where the full list of files touched goes. `None` only in a test that is not about
    /// the log; a deployment always has one (`mb-cli`).
    audit: Option<&'a AuditLog>,
}

impl<'a> Rename<'a> {
    /// Binds a rename to one vault, one live ACL and one authenticated actor.
    #[must_use]
    pub fn new(
        vault: &'a Vault,
        access: &'a Access,
        actor: Username,
        index: &'a Mutex<Index>,
        sync: &'a SyncRegistry,
        audit: Option<&'a AuditLog>,
    ) -> Self {
        Self {
            vault,
            access,
            actor,
            index,
            sync,
            audit,
        }
    }

    /// Renames a note and repoints every inbound wikilink at it (§6.6).
    ///
    /// `from` is anything a link can name — a path, a bare name, an alias — resolved
    /// against what the **actor** may read, so a note they cannot see cannot be renamed and
    /// cannot be discovered by trying. `to` is a vault-relative path ending in `.md`.
    ///
    /// # Errors
    ///
    /// See [`RenameError`]. Every variant except `Failed` means nothing was written.
    pub fn note(&self, from: &str, to: &str) -> Result<Renamed, RenameError> {
        let view = AuthorizedVault::new(self.vault, self.access, self.actor.clone());
        let identity = view.identity(from).map_err(|_| RenameError::Denied)?;
        // Shape first, then authorization, then the filesystem. The order is the point:
        // `Exists` is an answer about a path, so asking it before the caller has proved they
        // may write there would let anyone probe for notes by trying to rename onto them.
        validate_shape(to)?;
        // Both ends, because moving a note into a folder is creating one there. Checked
        // against the live ACL rather than against the actor's membership: a per-folder
        // grant is exactly how §6.2 expects write access to be scoped.
        for path in [identity.as_str(), to] {
            if !self.may_write(path) {
                return Err(RenameError::Denied);
            }
        }
        let destination = self.destination(to)?;

        // Anything a client typed in the last second is on disk before the links are read,
        // so a link added moments ago is not missed.
        self.flush_open_notes()?;
        self.sweep()?;

        let link_name = self.link_name_for(&identity, to);
        rewrite::validate_link_name(&link_name)
            .map_err(|_| RenameError::InvalidName(link_name.clone()))?;
        let sources = self.inbound(&identity)?;
        let planned = plan(self.vault, &sources, |source, names| {
            rewrite::rename_link_target(source, names, &link_name)
        })?;

        self.sync
            .close(self.vault, &identity)
            .map_err(|error| RenameError::Failed(error.to_string()))?;
        let origin = self.vault.notes_root().join(&identity);
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| RenameError::Failed(error.to_string()))?;
        }
        std::fs::rename(&origin, &destination)
            .map_err(|error| RenameError::Failed(error.to_string()))?;
        crate::sync::relocate_sidecar(self.vault.root(), &identity, to)
            .map_err(|error| RenameError::Failed(error.to_string()))?;

        // The renamed note may link to itself, and its file is no longer where the plan
        // found it.
        let moved = std::iter::once((identity.clone(), to.to_string())).collect();
        let outcome = self.write(planned, &moved, to)?;
        self.settle();
        Ok(outcome)
    }

    /// Renames a tag and every tag nested under it, across the whole vault (§9.3, §6.6).
    ///
    /// **Requires vault-wide `owner`.** A tag has no owner the way a note does — it is a
    /// name spread across notes with different ACLs — so §6.6's "justified by the actor's
    /// right to rename the target" has nothing to point at. Owner is the narrowest role
    /// that already implies authority over the whole vault, and it is recorded in §6.6.
    ///
    /// # Errors
    ///
    /// See [`RenameError`].
    pub fn tag(&self, from: &str, to: &str) -> Result<Renamed, RenameError> {
        if !self.is_owner() {
            return Err(RenameError::Denied);
        }
        let from = from.trim().trim_start_matches('#').to_string();
        let to = to.trim().trim_start_matches('#').to_string();
        if from.is_empty() {
            return Err(RenameError::Denied);
        }
        rewrite::validate_tag_name(&to).map_err(|_| RenameError::InvalidName(to.clone()))?;

        self.flush_open_notes()?;
        self.sweep()?;

        let carriers = self.tagged(&from)?;
        let planned = plan(self.vault, &carriers, |source, _| {
            rewrite::rename_tag(source, &from, &to)
        })?;
        let outcome = self.write(planned, &BTreeMap::new(), &to)?;
        self.settle();
        Ok(outcome)
    }

    /// Every note holding an inbound reference, with the spellings that resolve to `target`.
    ///
    /// Read through the privileged reader, which is the point of the whole module: a link
    /// in a note the actor cannot read still has to be repointed. The spellings come from
    /// the index's own resolution (§4.3), so a `[[Roadmap]]` that resolves to a *different*
    /// note is not in the list and is not touched.
    fn inbound(&self, target: &str) -> Result<Vec<(String, Vec<String>)>, RenameError> {
        let system = system_user()?;
        let policy = system_access(&system)?;
        let mut index = self.index.lock().map_err(|_| poisoned())?;
        let reader = index
            .reader(&policy, &system)
            .map_err(|error| RenameError::Failed(error.to_string()))?;
        let groups = reader
            .backlinks(target)
            .map_err(|error| RenameError::Failed(error.to_string()))?;
        Ok(groups
            .into_iter()
            .map(|group| {
                let mut names: Vec<String> = group
                    .links
                    .into_iter()
                    .map(|link| link.target_raw)
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect();
                names.sort();
                (group.path, names)
            })
            .collect())
    }

    /// Every note carrying `prefix` or a tag nested under it, privileged.
    fn tagged(&self, prefix: &str) -> Result<Vec<(String, Vec<String>)>, RenameError> {
        let system = system_user()?;
        let policy = system_access(&system)?;
        let mut index = self.index.lock().map_err(|_| poisoned())?;
        let reader = index
            .reader(&policy, &system)
            .map_err(|error| RenameError::Failed(error.to_string()))?;
        Ok(reader
            .tagged(prefix)
            .map_err(|error| RenameError::Failed(error.to_string()))?
            .into_iter()
            .map(|note| (note.path, Vec::new()))
            .collect())
    }

    /// Writes every planned rewrite, and reports only what the actor can see.
    ///
    /// `moved` redirects a note whose file this rename has already relocated — the renamed
    /// note itself, when it links to itself.
    fn write(
        &self,
        planned: Vec<Planned>,
        moved: &BTreeMap<String, String>,
        to: &str,
    ) -> Result<Renamed, RenameError> {
        let mut touched = Vec::new();
        let mut notes = 0usize;
        let mut references = 0usize;
        let mut failure = None;
        for change in planned {
            let path = moved.get(&change.path).unwrap_or(&change.path).clone();
            let full = self.vault.notes_root().join(&path);
            if let Err(error) = crate::sync::atomic_write(&full, change.text.as_bytes()) {
                failure = Some(RenameError::Failed(error.to_string()));
                break;
            }
            touched.push(path.clone());
            if self.may_read(&path) {
                notes += 1;
                references += change.count;
            }
        }
        self.audit(to, &touched, failure.is_none());
        match failure {
            Some(error) => Err(error),
            None => Ok(Renamed {
                to: to.to_string(),
                notes,
                references,
            }),
        }
    }

    /// The name inbound links should spell the renamed note by.
    ///
    /// The bare filename when no other note in the vault shares it, because that is what a
    /// human writes and what the file will still be called after it moves again. When two
    /// notes would share the name, the full path — §4.3 ranks a path match above a name
    /// match, so it is the spelling that cannot resolve to the wrong note.
    fn link_name_for(&self, from: &str, to: &str) -> String {
        let stem = to.trim_end_matches(".md");
        let bare = stem.rsplit('/').next().unwrap_or(stem);
        let key = mb_core::names::fold_name(bare);
        let taken = self.vault.notes().unwrap_or_default().iter().any(|other| {
            other != from
                && mb_core::names::fold_name(other.rsplit('/').next().unwrap_or(other)) == key
        });
        if taken {
            stem.to_string()
        } else {
            bare.to_string()
        }
    }

    /// Validates a destination path and returns where it would live.
    ///
    /// [`Vault::resolve`] cannot do this: it requires the file to exist, and this one must
    /// not. The containment rule is the same one, applied to the parent directory — the
    /// part of the path that does exist.
    fn destination(&self, to: &str) -> Result<PathBuf, RenameError> {
        let joined = self.vault.notes_root().join(to);
        let base = self
            .vault
            .notes_root()
            .canonicalize()
            .map_err(|error| RenameError::Failed(error.to_string()))?;
        // The parent is canonicalized because a symlinked folder inside the vault could
        // otherwise place the renamed note outside it. Only the parent: the file itself is
        // not supposed to exist yet.
        let parent = joined.parent().unwrap_or(&joined);
        if let Ok(real) = parent.canonicalize()
            && !real.starts_with(&base)
        {
            return Err(RenameError::InvalidName(to.to_string()));
        }
        if joined.exists() {
            return Err(RenameError::Exists(to.to_string()));
        }
        Ok(joined)
    }

    fn may_write(&self, path: &str) -> bool {
        NotePath::parse(path).is_ok_and(|note| {
            matches!(
                self.access.effective_role(&self.actor, &note),
                Role::Owner | Role::Editor
            )
        })
    }

    fn may_read(&self, path: &str) -> bool {
        NotePath::parse(path)
            .is_ok_and(|note| self.access.effective_role(&self.actor, &note) != Role::None)
    }

    fn is_owner(&self) -> bool {
        self.access
            .members()
            .any(|(user, role)| user == &self.actor && role == Role::Owner)
    }

    fn flush_open_notes(&self) -> Result<(), RenameError> {
        let errors = self.sync.flush_all();
        if errors.is_empty() {
            Ok(())
        } else {
            Err(RenameError::Failed(errors.join("; ")))
        }
    }

    /// Brings the index back in step *after* a rename that has already happened.
    ///
    /// Deliberately not `?`. The files have moved and the audit log says so, so failing the
    /// call here would tell the caller their rename failed when it did not — and the index
    /// is derived state that the next maintenance tick reconciles anyway (`indexing.rs`).
    /// The sweep *before* the rewrite is the one that has to succeed, because that one
    /// decides which links are found.
    fn settle(&self) {
        if let Err(error) = self.sweep() {
            eprintln!("memberberry: reindexing after a rename failed: {error}");
        }
    }

    fn sweep(&self) -> Result<(), RenameError> {
        let mut index = self.index.lock().map_err(|_| poisoned())?;
        crate::indexing::reconcile(self.vault, &mut index).map_err(RenameError::Failed)
    }

    /// Records the operation with every file it touched (§6.9).
    ///
    /// This is the only place the full list exists, and it is deliberately not the reply.
    fn audit(&self, to: &str, touched: &[String], succeeded: bool) {
        let Some(audit) = self.audit else {
            return;
        };
        let mut targets = Vec::with_capacity(touched.len() + 1);
        targets.push(to.to_string());
        targets.extend(touched.iter().cloned());
        // why: a failure to write the log does not undo a rename that already happened, and
        // there is nowhere better to report it from than the process's own stderr.
        if let Err(error) = audit.append(&AuditEvent {
            timestamp: &crate::audit::unix_seconds().to_string(),
            actor: Some(self.actor.as_str()),
            source_ip: None,
            vault: Some(self.vault.slug().as_str()),
            action: AuditAction::PrivilegedRewrite,
            targets: &targets,
            result: if succeeded {
                AuditResult::Success
            } else {
                AuditResult::Failure
            },
        }) {
            eprintln!("memberberry audit: recording a privileged rewrite failed: {error}");
        }
    }
}

/// Whether `to` is a vault-relative note path at all — no filesystem, no ACL.
///
/// Split out from [`Rename::destination`] so it can run before authorization: the parts of
/// a destination that are about the *string* are safe to answer for anybody, and the parts
/// that are about the *vault* are not.
fn validate_shape(to: &str) -> Result<(), RenameError> {
    let invalid = to.is_empty()
        || !to.ends_with(".md")
        || to.starts_with('/')
        || Path::new(to).is_absolute()
        || to
            .split('/')
            .any(|segment| segment.is_empty() || segment.starts_with('.') || segment == "..")
        || NotePath::parse(to).is_err();
    if invalid {
        return Err(RenameError::InvalidName(to.to_string()));
    }
    Ok(())
}

/// One note's rewritten source, waiting to be written.
struct Planned {
    path: String,
    text: String,
    count: usize,
}

/// Computes every rewrite before any of them is written.
///
/// A note that will not rewrite safely stops the whole rename here, with nothing on disk
/// changed. A note that has vanished since the index last saw it is skipped rather than
/// fatal — the index is derived state and is allowed to be a moment behind the files.
fn plan(
    vault: &Vault,
    sources: &[(String, Vec<String>)],
    rewrite: impl Fn(&str, &[String]) -> Result<rewrite::Rewrite, RewriteError>,
) -> Result<Vec<Planned>, RenameError> {
    let mut planned = Vec::new();
    for (path, names) in sources {
        let Ok(source) = std::fs::read_to_string(vault.notes_root().join(path)) else {
            continue;
        };
        let done = rewrite(&source, names).map_err(|_| RenameError::Unverified)?;
        if !done.changed() {
            continue;
        }
        planned.push(Planned {
            path: path.clone(),
            text: done.text().to_string(),
            count: done.count(),
        });
    }
    Ok(planned)
}

/// The ACL a privileged rewrite reads under: vault-wide owner, no path rules.
///
/// Built fresh per operation rather than cached, so it can never be mistaken for a vault's
/// real policy or handed to something that expects one.
fn system_access(system: &Username) -> Result<Access, RenameError> {
    Access::new(
        vec![Member {
            user: system.clone(),
            role: Role::Owner,
        }],
        Vec::new(),
    )
    .map_err(|error| RenameError::Failed(error.to_string()))
}

fn system_user() -> Result<Username, RenameError> {
    // SYSTEM satisfies `Username`'s rules, and this returns an error rather than unwrapping
    // so that a change which broke that would deny the rename instead of panicking in a
    // library (`AGENTS.md` §4.2).
    Username::parse(SYSTEM).map_err(|error| RenameError::Failed(error.to_string()))
}

fn poisoned() -> RenameError {
    RenameError::Failed("the index lock is poisoned".to_string())
}
