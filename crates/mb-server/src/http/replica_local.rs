//! What a desktop replica (§7.6.9) may do to the embedded server's copy of a vault.
//!
//! Narrow on purpose. Every operation acts as the app's local user, on a vault that user
//! owns, through the same create, rename, trash and sync code a person's actions take; none
//! of it is reachable over HTTP. The replica module calls these instead of reaching into
//! [`AppState`]'s fields.

use super::*;
use std::path::Path;

use crate::replica::plan::LocalNote;

impl AppState {
    fn replica_actor() -> Result<Username, String> {
        Username::parse(crate::desktop::LOCAL_USERNAME).map_err(|error| error.to_string())
    }

    fn replica_vault(&self, slug: &str) -> Result<(Arc<Vault>, Arc<mb_core::Access>), String> {
        let vault = self
            .vault(slug)
            .ok_or_else(|| format!("no local vault `{slug}`"))?;
        let access = self
            .access_for(vault.slug())
            .ok_or_else(|| format!("no access policy for `{slug}`"))?;
        Ok((vault, access))
    }

    fn replica_check(&self) -> impl Fn(&str, &str, &Username) -> bool + '_ {
        |slug, note, user| self.may_read_note(slug, note, user)
    }

    /// Creates the replica's vault at `root`, owned by the local user.
    pub(crate) fn replica_register(
        &self,
        slug: &str,
        name: &str,
        root: &Path,
    ) -> Result<(), String> {
        let actor = Self::replica_actor()?;
        onboarding::register_vault_at(self, &actor, name, slug, root).map_err(|e| e.to_string())
    }

    /// Whether a local vault with this address exists.
    pub(crate) fn replica_has_vault(&self, slug: &str) -> bool {
        self.vault(slug).is_some()
    }

    /// Every note in the local replica, with its identity and change token.
    pub(crate) fn replica_notes(&self, slug: &str) -> Result<Vec<LocalNote>, String> {
        let (vault, _) = self.replica_vault(slug)?;
        let paths = vault.notes().map_err(|e| e.to_string())?;
        let cache = self.title_cache(vault.slug());
        let summaries = cache.summaries(paths.iter().map(String::as_str), |relative| {
            vault.resolve(relative).ok()
        });
        Ok(summaries
            .into_iter()
            .filter(|summary| !summary.version.is_empty())
            .map(|summary| LocalNote {
                path: summary.path,
                id: summary.id,
                version: summary.version,
            })
            .collect())
    }

    /// A local note's complete history, after importing any edit made to its file.
    pub(crate) fn replica_state(&self, slug: &str, path: &str) -> Result<Vec<u8>, String> {
        let (vault, _) = self.replica_vault(slug)?;
        let canonical = vault.canonical_note(path).map_err(|e| e.to_string())?;
        let check = self.replica_check();
        self.security
            .sync
            .current_state(&vault, &canonical, &check)
            .map_err(|e| e.to_string())
    }

    /// Applies upstream's changes to a local note.
    pub(crate) fn replica_apply(
        &self,
        slug: &str,
        path: &str,
        update: &[u8],
    ) -> Result<(), String> {
        let (vault, _) = self.replica_vault(slug)?;
        let canonical = vault.canonical_note(path).map_err(|e| e.to_string())?;
        let check = self.replica_check();
        self.security
            .sync
            .apply_detached(&vault, &canonical, update, "upstream", &check)
            .map_err(|e| e.to_string())
    }

    /// Replaces a local note's history with upstream's (S14).
    pub(crate) fn replica_adopt(&self, slug: &str, path: &str, state: &[u8]) -> Result<(), String> {
        let (vault, _) = self.replica_vault(slug)?;
        let canonical = vault.canonical_note(path).map_err(|e| e.to_string())?;
        self.security
            .sync
            .adopt(&vault, &canonical, state)
            .map_err(|e| e.to_string())?;
        let _ = self.maintain_index(&Changes::All);
        Ok(())
    }

    /// Writes a note upstream has and this device does not, from upstream's history.
    pub(crate) fn replica_create(
        &self,
        slug: &str,
        path: &str,
        state: &[u8],
    ) -> Result<(), String> {
        let (vault, access) = self.replica_vault(slug)?;
        let index = self
            .indexes
            .get(&vault)
            .ok_or_else(|| "no index for the local vault".to_string())?;
        CreateNote::new(&vault, &access, Self::replica_actor()?, &index)
            .note_with_state(path, state)
            .map(drop)
            .map_err(|e| e.to_string())
    }

    /// Writes a new local note holding `markdown`, with a history of its own (§7.6.7).
    pub(crate) fn replica_create_markdown(
        &self,
        slug: &str,
        path: &str,
        markdown: &str,
    ) -> Result<(), String> {
        let doc = mb_crdt::document_to_yrs(&mb_core::parse(markdown)).map_err(|e| e.to_string())?;
        self.replica_create(slug, path, &mb_crdt::encode_update_v1(&doc))
    }

    /// Moves a local note, changing no text (upstream renamed it).
    pub(crate) fn replica_move(&self, slug: &str, from: &str, to: &str) -> Result<(), String> {
        let (vault, access) = self.replica_vault(slug)?;
        let index = self
            .indexes
            .get(&vault)
            .ok_or_else(|| "no index for the local vault".to_string())?;
        Rename::new(
            &vault,
            &access,
            Self::replica_actor()?,
            &index,
            self.sync_registry(),
            self.audit_log(),
        )
        .move_only(from, to)
        .map(drop)
        .map_err(|e| e.to_string())
    }

    /// Removes what purged notes left in the local vault's index (E35); see
    /// [`mb_index::Index::scrub`].
    pub(crate) fn replica_scrub(&self, slug: &str) -> Result<(), String> {
        let (vault, _) = self.replica_vault(slug)?;
        let index = self
            .indexes
            .get(&vault)
            .ok_or_else(|| "no index for the local vault".to_string())?;
        let mut index = index
            .lock()
            .map_err(|_| "the local vault's index is unavailable".to_string())?;
        index.scrub().map_err(|e| e.to_string())
    }

    /// A media object on this device, if it is here.
    pub(crate) fn replica_media(&self, slug: &str, path: &str) -> Option<Vec<u8>> {
        let (vault, _) = self.replica_vault(slug).ok()?;
        crate::media::LocalStore::new(&vault)
            .get(path)
            .ok()
            .map(|(_, bytes)| bytes)
    }

    /// Writes a media object downloaded from upstream; refused unless `bytes` are what
    /// `path`'s content address names.
    pub(crate) fn replica_media_write(
        &self,
        slug: &str,
        path: &str,
        bytes: &[u8],
    ) -> Result<(), String> {
        let (vault, _) = self.replica_vault(slug)?;
        crate::media::LocalStore::new(&vault)
            .write_exact(path, bytes)
            .map(drop)
            .map_err(|e| e.to_string())
    }

    /// Removes media no note on this device references, sparing objects uploaded in the
    /// last few minutes that a note may not have saved a reference to yet.
    pub(crate) async fn replica_media_prune(&self, slug: &str) -> Result<Vec<String>, String> {
        let (vault, _) = self.replica_vault(slug)?;
        let protected = self.active_media_grants(vault.slug());
        crate::media::prune_orphaned(&vault, &protected)
            .await
            .map_err(|e| e.to_string())
    }

    /// A local note's Markdown, as its file holds it.
    pub(crate) fn replica_markdown(&self, slug: &str, path: &str) -> Result<String, String> {
        let (vault, _) = self.replica_vault(slug)?;
        let file = vault.resolve(path).map_err(|e| e.to_string())?;
        std::fs::read_to_string(file).map_err(|e| e.to_string())
    }

    /// Applies `markdown` to a local note as an ordinary edit (§3.4's external-edit path).
    pub(crate) fn replica_restore(
        &self,
        slug: &str,
        path: &str,
        markdown: &str,
    ) -> Result<(), String> {
        let (vault, _) = self.replica_vault(slug)?;
        let canonical = vault.canonical_note(path).map_err(|e| e.to_string())?;
        let check = self.replica_check();
        self.security
            .sync
            .restore(
                &vault,
                &canonical,
                markdown,
                crate::desktop::LOCAL_USERNAME,
                &check,
            )
            .map_err(|e| e.to_string())
    }

    /// Removes a local note's copy for "Online only": file, sidecar and index row. Not a
    /// deletion — nothing goes to trash, and upstream is not told.
    pub(crate) fn replica_release(&self, slug: &str, path: &str) -> Result<(), String> {
        let (vault, _) = self.replica_vault(slug)?;
        let canonical = vault.canonical_note(path).map_err(|e| e.to_string())?;
        let identity = canonical.identity().to_string();
        self.security
            .sync
            .close(&vault, &identity)
            .map_err(|e| e.to_string())?;
        std::fs::remove_file(canonical.path()).map_err(|e| e.to_string())?;
        crate::sync::remove_sidecar(vault.root(), &identity).map_err(|e| e.to_string())?;
        let _ = self.maintain_index(&Changes::All);
        Ok(())
    }

    /// Takes the replica's vault out of the running server (§7.6.11), returning its folder.
    ///
    /// Open notes are closed first, so their last edits reach the files and no room is left
    /// behind for a vault later registered at the same address.
    pub(crate) fn replica_unregister(&self, slug: &str) -> Result<PathBuf, String> {
        let (vault, _) = self.replica_vault(slug)?;
        for path in vault.notes().map_err(|e| e.to_string())? {
            let canonical = vault.canonical_note(&path).map_err(|e| e.to_string())?;
            self.security
                .sync
                .close(&vault, canonical.identity())
                .map_err(|e| e.to_string())?;
        }
        onboarding::unregister_vault(self, slug).map_err(|e| e.to_string())
    }

    /// The local replica's folder.
    pub(crate) fn replica_root(&self, slug: &str) -> Result<PathBuf, String> {
        Ok(self.replica_vault(slug)?.0.root().to_path_buf())
    }
}
