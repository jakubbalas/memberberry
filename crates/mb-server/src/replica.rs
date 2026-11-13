//! A desktop replica of a vault on the user's server (`SPEC.md` §7.6.9).
//!
//! The replica is an ordinary vault served by the desktop app's embedded server, kept in
//! step with one upstream vault. Upstream sees one more §7.1 client carrying a device token;
//! locally the replica works through the embedded server's own create, rename, trash and
//! sync code ([`AppState`]'s `replica_*` operations), so the webview, the external-edit path
//! and the replica all meet in one registry.
//!
//! why a module of `mb-server` rather than the separate `mb-replica` crate §5.2 first named:
//! it needs the embedded server's registry in-process, and the server's desktop pages need
//! to start and stop it. Two crates would each depend on the other.

pub mod pins;
pub mod plan;
pub mod recovered;
pub mod upstream;
pub mod wire;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use thiserror::Error;
use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

use crate::http::AppState;
use plan::{Action, Held, RecordEntry, plan, this_device_path};
use upstream::{Created, Pushed, Socket, Upstream};

/// Why a pass, or one note in it, did not complete.
#[derive(Debug, Error)]
pub enum ReplicaError {
    /// The server no longer accepts this device's token: it was revoked.
    #[error("the server no longer accepts this device")]
    Unauthorized,
    /// The upstream vault is no longer readable by the device's user (§7.6.6).
    #[error("this vault is no longer available on the server")]
    Unavailable,
    /// The server could not be reached, or answered something unusable.
    #[error("the server: {0}")]
    Upstream(String),
    /// The server refused a sync frame, with §7.1's uniform code.
    #[error("the server refused: {0}")]
    Refused(String),
    /// This device's copy could not be read or written.
    #[error("this device: {0}")]
    Local(String),
}

/// One replica: which local vault mirrors which upstream vault.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ReplicaConfig {
    /// The local vault's address in the embedded server.
    pub local: String,
    /// The upstream vault's address.
    pub upstream: String,
    /// The upstream vault's display name.
    pub name: String,
    /// The server, `scheme://host[:port]`.
    pub origin: String,
}

/// What one pass did, for the connected page.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PassReport {
    /// Notes written or changed on this device.
    pub downloaded: usize,
    /// Notes written or changed upstream.
    pub uploaded: usize,
    /// Notes held back for the user, by path.
    pub held: Vec<(String, Held)>,
    /// Notes that failed this pass and will be retried, with why.
    pub failed: Vec<(String, String)>,
    /// Notes made online-only this pass: their local copy is gone, upstream's untouched.
    pub released: usize,
    /// Notes that left the readable set unchanged here, and are gone from this device (E35).
    pub purged: usize,
    /// Media objects written here for notes kept offline (§7.6.3).
    pub media_downloaded: usize,
    /// Media objects added here and sent upstream.
    pub media_uploaded: usize,
    /// Notes that left the readable set with changes made here, kept as recovered notes.
    pub recovered: usize,
}

/// The sync record of §7.6.9, in `<replica>/.memberberry/replica/record.json`.
///
/// Inside `.memberberry/` on purpose: removing it (I1) loses only the record, and a pass
/// without one treats nothing as deleted.
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct Record {
    notes: Vec<RecordEntry>,
}

fn record_path(root: &Path) -> PathBuf {
    root.join(".memberberry")
        .join("replica")
        .join("record.json")
}

fn load_record(root: &Path) -> Vec<RecordEntry> {
    std::fs::read_to_string(record_path(root))
        .ok()
        .and_then(|text| serde_json::from_str::<Record>(&text).ok())
        .map(|record| record.notes)
        .unwrap_or_default()
}

fn save_record(root: &Path, notes: Vec<RecordEntry>) -> Result<(), ReplicaError> {
    let path = record_path(root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| ReplicaError::Local(e.to_string()))?;
    }
    let text = serde_json::to_string_pretty(&Record { notes })
        .map_err(|e| ReplicaError::Local(e.to_string()))?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, text).map_err(|e| ReplicaError::Local(e.to_string()))?;
    std::fs::rename(&temporary, &path).map_err(|e| ReplicaError::Local(e.to_string()))
}

fn doc_of(state: &[u8]) -> Result<Doc, ReplicaError> {
    let doc = Doc::new();
    let update = Update::decode_v1(state).map_err(|e| ReplicaError::Local(e.to_string()))?;
    doc.transact_mut()
        .apply_update(update)
        .map_err(|e| ReplicaError::Local(e.to_string()))?;
    Ok(doc)
}

/// Whether two histories descend from a common one: some client wrote to both.
///
/// A note downloaded by a replica starts as upstream's history, so the two always share
/// upstream's clients. Two histories rebuilt independently from Markdown — after
/// `rm -rf .memberberry/` on either side — share none, and merging them would duplicate
/// every block (S14).
fn share_origin(a: &StateVector, b: &StateVector) -> bool {
    a.is_empty() || b.is_empty() || a.iter().any(|(client, _)| b.contains_client(client))
}

fn is_empty_update(update: &[u8]) -> bool {
    Update::decode_v1(update).map_or(true, |update| update.is_empty())
}

/// Creates the empty local vault a replica syncs into, at `root`, which must not exist.
///
/// # Errors
///
/// [`ReplicaError::Local`] when the address is taken or the folder cannot be made.
pub fn create_local(
    state: &AppState,
    config: &ReplicaConfig,
    root: &Path,
) -> Result<(), ReplicaError> {
    state
        .replica_register(&config.local, &config.name, root)
        .map_err(ReplicaError::Local)
}

/// Whether the embedded server already has a vault at `local`.
#[must_use]
pub fn has_local(state: &AppState, local: &str) -> bool {
    state.replica_has_vault(local)
}

/// One note's outcome within a pass.
enum Outcome {
    Done { downloaded: bool, uploaded: bool },
    Held(Held),
}

/// Runs one sync pass of `config` against `upstream` (§7.6.9).
///
/// A failure on one note is recorded and that note retried next pass; the pass goes on.
/// Only a revoked token or an unreachable server ends it early.
///
/// # Errors
///
/// [`ReplicaError::Unauthorized`] when the token was revoked, or a failure listing either
/// side, which leaves the record untouched.
pub async fn pass(
    state: &AppState,
    config: &ReplicaConfig,
    upstream: &Upstream,
) -> Result<PassReport, ReplicaError> {
    let root = state
        .replica_root(&config.local)
        .map_err(ReplicaError::Local)?;
    let (all_upstream, complete) = upstream.notes(&config.upstream).await?;
    save_listing(&root, &all_upstream);
    let local_notes = state
        .replica_notes(&config.local)
        .map_err(ReplicaError::Local)?;
    // Recovered notes await the user's choice and never sync on their own (§7.6.7); one the
    // user has deleted is no longer awaiting anything.
    let record = load_record(&root);
    let known: BTreeSet<&str> = all_upstream
        .iter()
        .map(|n| n.path.as_str())
        .chain(record.iter().map(|r| r.path.as_str()))
        .collect();
    let awaiting = settle_recovered(&root, &local_notes, &known).map_err(ReplicaError::Local)?;
    let local_notes: Vec<plan::LocalNote> = local_notes
        .into_iter()
        .filter(|n| !awaiting.contains(&n.path))
        .collect();
    let mut pins = pins::load(&root, local_notes.iter().map(|n| n.path.as_str()))
        .map_err(ReplicaError::Local)?;
    let on_upstream: BTreeSet<&str> = all_upstream.iter().map(|n| n.path.as_str()).collect();
    let synced = |path: &str| record.iter().any(|r| r.path == path);
    // Fails towards keeping: a file on disk that upstream also has, never synced and not
    // pinned (its record was lost), is pinned rather than uploaded over upstream's note.
    let mut repinned = false;
    for note in &local_notes {
        if !pins.covers(&note.path)
            && on_upstream.contains(note.path.as_str())
            && !synced(&note.path)
        {
            pins.notes.insert(note.path.clone());
            repinned = true;
        }
    }
    if repinned {
        pins::save(&root, &pins).map_err(ReplicaError::Local)?;
    }
    // Online only: on disk, synced before, still upstream, and no longer pinned.
    let releasing: BTreeSet<String> = local_notes
        .iter()
        .filter(|n| {
            !pins.covers(&n.path) && on_upstream.contains(n.path.as_str()) && synced(&n.path)
        })
        .map(|n| n.path.clone())
        .collect();
    // why: a note this device keeps that upstream moved somewhere not kept offline is still
    // readable; matched by its id it is a move, where by its pin alone it would look gone and
    // be purged or recovered (E35).
    let known_ids: BTreeSet<&str> = local_notes
        .iter()
        .filter_map(|n| n.id.as_deref())
        .chain(record.iter().filter_map(|r| r.id.as_deref()))
        .collect();
    let upstream_notes: Vec<plan::UpstreamNote> = all_upstream
        .iter()
        .filter(|n| {
            pins.covers(&n.path) || n.id.as_deref().is_some_and(|id| known_ids.contains(id))
        })
        .cloned()
        .collect();
    let kept: Vec<plan::LocalNote> = local_notes
        .iter()
        .filter(|n| !releasing.contains(&n.path))
        .cloned()
        .collect();
    let actions = plan(&upstream_notes, &kept, &record, complete);
    let editable: BTreeSet<&str> = upstream_notes
        .iter()
        .filter(|n| n.editable)
        .map(|n| n.path.as_str())
        .collect();

    let mut report = PassReport::default();
    let mut socket: Option<Socket> = None;
    let mut unsettled: BTreeSet<String> = BTreeSet::new();
    let mut held: Vec<(String, Held)> = Vec::new();
    let mut gone: BTreeSet<String> = BTreeSet::new();
    let mut known_media = load_known_media(&root);
    for action in &actions {
        let path = action_path(action).to_string();
        // why: a note's new media goes up before the note does, so upstream never holds a
        // note that shows an image it lacks. Only for notes about to be sent: an image in a
        // note that left the readable set must not leave this device on its way out (E35).
        if matches!(
            action,
            Action::Upload { .. }
                | Action::Exchange {
                    local_changed: true,
                    ..
                }
        ) {
            match upload_media_of(state, config, upstream, &path, &mut known_media).await {
                Ok(sent) => report.media_uploaded += sent,
                Err(ReplicaError::Unauthorized) => return Err(ReplicaError::Unauthorized),
                Err(error) => report.failed.push((path.clone(), error.to_string())),
            }
        }
        let outcome = run(state, config, upstream, &mut socket, action, &editable).await;
        match outcome {
            Ok(Outcome::Done {
                downloaded,
                uploaded,
            }) => {
                match action {
                    Action::Purge { .. } => report.purged += 1,
                    Action::Recover { .. } => report.recovered += 1,
                    _ => {
                        report.downloaded += usize::from(downloaded);
                        report.uploaded += usize::from(uploaded);
                    }
                }
                if matches!(action, Action::Purge { .. } | Action::Recover { .. }) {
                    gone.insert(path.clone());
                }
            }
            Ok(Outcome::Held(why)) => held.push((path, why)),
            Err(ReplicaError::Unauthorized) => {
                if let Some(socket) = socket {
                    socket.close().await;
                }
                return Err(ReplicaError::Unauthorized);
            }
            Err(error) => {
                unsettled.insert(path.clone());
                report.failed.push((path, error.to_string()));
            }
        }
    }
    for path in &releasing {
        let Some(local) = local_notes.iter().find(|n| &n.path == path) else {
            continue;
        };
        match release(
            state,
            config,
            upstream,
            &mut socket,
            &record,
            &all_upstream,
            local,
        )
        .await
        {
            Ok(None) => report.released += 1,
            Ok(Some(why)) => held.push((path.clone(), why)),
            Err(ReplicaError::Unauthorized) => return Err(ReplicaError::Unauthorized),
            Err(error) => {
                unsettled.insert(path.clone());
                report.failed.push((path.clone(), error.to_string()));
            }
        }
    }
    if let Some(socket) = socket {
        socket.close().await;
    }
    // §7.6.3: a kept note brings its media; media nothing here shows any more goes, which
    // is how a released or purged note's images leave (E35).
    match download_media(state, config, upstream, &root, &mut known_media).await {
        Ok(fetched) => report.media_downloaded += fetched,
        Err(ReplicaError::Unauthorized) => return Err(ReplicaError::Unauthorized),
        Err(error) => report.failed.push(("media".into(), error.to_string())),
    }
    for removed in state
        .replica_media_prune(&config.local)
        .await
        .map_err(ReplicaError::Local)?
    {
        known_media.remove(&removed);
    }
    save_known_media(&root, &known_media).map_err(ReplicaError::Local)?;

    // The record is what both sides hold now. A note whose step failed keeps its old entry
    // so the next pass plans it again from the same starting point.
    let (upstream_now, _) = upstream.notes(&config.upstream).await?;
    let recovered_now: BTreeSet<String> =
        recovered::load(&root).into_iter().map(|r| r.path).collect();
    let local_now: Vec<plan::LocalNote> = state
        .replica_notes(&config.local)
        .map_err(ReplicaError::Local)?
        .into_iter()
        .filter(|n| !awaiting.contains(&n.path) && !recovered_now.contains(&n.path))
        .collect();
    let mut entries = Vec::new();
    for local in &local_now {
        if unsettled.contains(&local.path) {
            if let Some(old) = record.iter().find(|r| r.path == local.path) {
                entries.push(old.clone());
            }
            continue;
        }
        let up = upstream_now.iter().find(|u| u.path == local.path);
        let why = held.iter().find(|(p, _)| p == &local.path).map(|(_, w)| *w);
        match (up, why) {
            (Some(up), None) => entries.push(RecordEntry {
                path: local.path.clone(),
                id: up.id.clone().or_else(|| local.id.clone()),
                upstream_version: up.version.clone(),
                local_version: local.version.clone(),
                held: None,
            }),
            (up, Some(why)) => entries.push(RecordEntry {
                path: local.path.clone(),
                id: local.id.clone(),
                upstream_version: up.map_or_else(
                    || {
                        record
                            .iter()
                            .find(|r| r.path == local.path)
                            .map(|r| r.upstream_version.clone())
                            .unwrap_or_default()
                    },
                    |up| up.version.clone(),
                ),
                local_version: local.version.clone(),
                held: Some(why),
            }),
            (None, None) => {}
        }
    }
    save_record(&root, entries)?;
    // A note this pass put on disk and upstream — an upload, a kept-both copy — stays
    // available offline; a release that could not complete is not quietly undone.
    let before = pins.clone();
    // A purged note's own pin goes with it (E35); a folder or vault pin stays, since it
    // names a place rather than the note.
    for path in &gone {
        pins.notes.remove(path);
    }
    for local in &local_now {
        if !pins.covers(&local.path)
            && !releasing.contains(&local.path)
            && upstream_now.iter().any(|u| u.path == local.path)
        {
            pins.notes.insert(local.path.clone());
        }
    }
    if pins != before {
        pins::save(&root, &pins).map_err(ReplicaError::Local)?;
    }
    if report.purged + report.recovered > 0 {
        state
            .replica_scrub(&config.local)
            .map_err(ReplicaError::Local)?;
    }
    report.held = held;
    Ok(report)
}

/// Settles a replica whose upstream vault the device's user can no longer read at all —
/// removed from the server, or this user removed from it (§7.6.7's case 4, E35).
///
/// Each note is treated as one that left the readable set: unchanged since the last pass,
/// it is purged; changed here, created here, or held, it becomes a recovered note. Then the
/// replica's own state — the record, the pins and the last upstream listing, which names
/// notes this user can no longer read — is removed, since there is no upstream left to keep
/// in step with. Returns how many notes are left on this device: the recovered ones, which
/// keep the vault as a vault on this device.
///
/// # Errors
///
/// A failure reading or writing this device's copy; what was done before it stays done.
pub async fn vault_gone(state: &AppState, config: &ReplicaConfig) -> Result<usize, ReplicaError> {
    let root = state
        .replica_root(&config.local)
        .map_err(ReplicaError::Local)?;
    let local_notes = state
        .replica_notes(&config.local)
        .map_err(ReplicaError::Local)?;
    let record = load_record(&root);
    let known: BTreeSet<&str> = record.iter().map(|r| r.path.as_str()).collect();
    let awaiting = settle_recovered(&root, &local_notes, &known).map_err(ReplicaError::Local)?;
    for note in local_notes.iter().filter(|n| !awaiting.contains(&n.path)) {
        let entry = record
            .iter()
            .find(|r| r.path == note.path || (r.id.is_some() && r.id == note.id));
        let unchanged = entry.is_some_and(|r| r.local_version == note.version && r.held.is_none());
        if unchanged {
            state
                .replica_release(&config.local, &note.path)
                .map_err(ReplicaError::Local)?;
        } else {
            recover(state, config, &note.path).map_err(ReplicaError::Local)?;
        }
    }
    state
        .replica_scrub(&config.local)
        .map_err(ReplicaError::Local)?;
    // The purged notes' media goes too; a recovered note's stays with it.
    state
        .replica_media_prune(&config.local)
        .await
        .map_err(ReplicaError::Local)?;
    let replica_state = root.join(".memberberry").join("replica");
    match std::fs::remove_dir_all(&replica_state) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(ReplicaError::Local(error.to_string())),
    }
    state
        .replica_notes(&config.local)
        .map(|notes| notes.len())
        .map_err(ReplicaError::Local)
}

/// What became of a recovered note the user chose a place for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placed {
    /// Created upstream at the chosen path; it syncs from now on like any other note.
    Created,
    /// Upstream refused a note there (E17's uniform refusal); the note stays recovered.
    Refused,
}

/// Acts on the user's choice for a recovered note (§7.6.7): **Create the note again** at
/// the path it came from (`to` is `None`), or **Make a new note** at `to`.
///
/// The note moves there and is created upstream from its own history. If upstream refuses,
/// it moves back and stays recovered; a refused "create again" is remembered, so only "make
/// a new note" is offered after.
///
/// # Errors
///
/// [`ReplicaError::Local`] when `path` is not a recovered note or `to` is not a note path;
/// an upstream failure, after which the note is back where it was.
pub async fn place_recovered(
    state: &AppState,
    config: &ReplicaConfig,
    upstream: &Upstream,
    path: &str,
    to: Option<&str>,
) -> Result<Placed, ReplicaError> {
    let root = state
        .replica_root(&config.local)
        .map_err(ReplicaError::Local)?;
    let mut listed = recovered::load(&root);
    let Some(entry) = listed.iter().find(|r| r.path == path).cloned() else {
        return Err(ReplicaError::Local("not a recovered note".into()));
    };
    let target = to.unwrap_or(&entry.original).trim_matches('/').to_string();
    if mb_core::NotePath::parse(&target).is_err() || !target.ends_with(".md") {
        return Err(ReplicaError::Local("not a note path".into()));
    }
    let remember_refusal = |mut listed: Vec<recovered::Recovered>| {
        if to.is_none()
            && let Some(item) = listed.iter_mut().find(|r| r.path == path)
        {
            item.create_again_refused = true;
        }
        recovered::save(&root, listed).map_err(ReplicaError::Local)
    };
    let taken = state
        .replica_notes(&config.local)
        .map_err(ReplicaError::Local)?
        .iter()
        .any(|n| n.path == target);
    if taken {
        remember_refusal(listed)?;
        return Ok(Placed::Refused);
    }
    state
        .replica_move(&config.local, path, &target)
        .map_err(ReplicaError::Local)?;
    // Its media first, so the note never arrives upstream showing images upstream lacks.
    // Uploaded whatever the record says: upstream may have dropped an object nothing it
    // could read referenced any more.
    let mut no_record = BTreeSet::new();
    if let Err(error) = upload_media_of(state, config, upstream, &target, &mut no_record).await {
        state
            .replica_move(&config.local, &target, path)
            .map_err(ReplicaError::Local)?;
        return Err(error);
    }
    let created = match state.replica_state(&config.local, &target) {
        Ok(history) => upstream.create(&config.upstream, &target, &history).await,
        Err(error) => Err(ReplicaError::Local(error)),
    };
    match created {
        Ok(Created::Yes) => {
            listed.retain(|r| r.path != path);
            recovered::save(&root, listed).map_err(ReplicaError::Local)?;
            let on_disk = state
                .replica_notes(&config.local)
                .map_err(ReplicaError::Local)?;
            let mut kept = pins::load(&root, on_disk.iter().map(|n| n.path.as_str()))
                .map_err(ReplicaError::Local)?;
            kept.notes.insert(target);
            pins::save(&root, &kept).map_err(ReplicaError::Local)?;
            Ok(Placed::Created)
        }
        other => {
            state
                .replica_move(&config.local, &target, path)
                .map_err(ReplicaError::Local)?;
            match other {
                Ok(_) => {
                    remember_refusal(listed)?;
                    Ok(Placed::Refused)
                }
                Err(error) => Err(error),
            }
        }
    }
}

/// Makes one note online-only: sends what upstream lacks, then removes the local copy.
///
/// Returns why it was kept instead, when its unsent changes could not be sent.
async fn release(
    state: &AppState,
    config: &ReplicaConfig,
    upstream: &Upstream,
    socket: &mut Option<Socket>,
    record: &[RecordEntry],
    all_upstream: &[plan::UpstreamNote],
    local: &plan::LocalNote,
) -> Result<Option<Held>, ReplicaError> {
    let entry = record.iter().find(|r| r.path == local.path);
    let up = all_upstream.iter().find(|u| u.path == local.path);
    let changed = Changed {
        local: entry.is_none_or(|r| r.local_version != local.version),
        upstream: match (entry, up) {
            (Some(r), Some(u)) => r.upstream_version != u.version,
            _ => true,
        },
    };
    if changed.local {
        let socket = socket_for(socket, upstream).await?;
        let outcome = exchange(
            state,
            config,
            upstream,
            socket,
            &local.path,
            changed,
            up.is_some_and(|u| u.editable),
        )
        .await;
        socket.leave(&config.upstream, &local.path).await?;
        if let Outcome::Held(why) = outcome? {
            return Ok(Some(why));
        }
    }
    state
        .replica_release(&config.local, &local.path)
        .map_err(ReplicaError::Local)?;
    Ok(None)
}

/// One note in the last upstream list, for listing it while offline (§7.6.10).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Listed {
    /// Vault-relative path.
    pub path: String,
    /// Title, when it has one.
    pub title: Option<String>,
}

fn listing_path(root: &Path) -> PathBuf {
    root.join(".memberberry")
        .join("replica")
        .join("listing.json")
}

fn save_listing(root: &Path, notes: &[plan::UpstreamNote]) {
    let listed: Vec<Listed> = notes
        .iter()
        .map(|n| Listed {
            path: n.path.clone(),
            title: n.title.clone(),
        })
        .collect();
    let path = listing_path(root);
    let written = (|| {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temporary = path.with_extension("json.tmp");
        std::fs::write(
            &temporary,
            serde_json::to_string(&listed).unwrap_or_default(),
        )?;
        std::fs::rename(&temporary, &path)
    })();
    if let Err(error) = written {
        eprintln!("memberberry: could not save the offline note list: {error}");
    }
}

/// The last upstream list, or nothing if there has never been one.
#[must_use]
pub fn load_listing(root: &Path) -> Vec<Listed> {
    std::fs::read_to_string(listing_path(root))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn action_path(action: &Action) -> &str {
    match action {
        Action::MoveLocal { to, .. } | Action::MoveUpstream { to, .. } => to,
        Action::Download { path }
        | Action::Upload { path }
        | Action::Exchange { path, .. }
        | Action::Purge { path }
        | Action::Recover { path }
        | Action::DeleteUpstream { path }
        | Action::Hold { path, .. }
        | Action::Forget { path } => path,
    }
}

async fn socket_for<'a>(
    socket: &'a mut Option<Socket>,
    upstream: &Upstream,
) -> Result<&'a mut Socket, ReplicaError> {
    if socket.is_none() {
        *socket = Some(upstream.connect().await?);
    }
    socket
        .as_mut()
        .ok_or_else(|| ReplicaError::Upstream("no socket".into()))
}

async fn run(
    state: &AppState,
    config: &ReplicaConfig,
    upstream: &Upstream,
    socket: &mut Option<Socket>,
    action: &Action,
    editable: &BTreeSet<&str>,
) -> Result<Outcome, ReplicaError> {
    let local = config.local.as_str();
    let remote = config.upstream.as_str();
    let done = |downloaded, uploaded| {
        Ok(Outcome::Done {
            downloaded,
            uploaded,
        })
    };
    match action {
        Action::MoveLocal { from, to } => {
            state
                .replica_move(local, from, to)
                .map_err(ReplicaError::Local)?;
            done(true, false)
        }
        Action::MoveUpstream { from, to } => {
            if upstream.move_note(remote, from, to).await? {
                done(false, true)
            } else {
                // Refused upstream: take upstream's path back rather than diverge.
                state
                    .replica_move(local, to, from)
                    .map_err(ReplicaError::Local)?;
                done(true, false)
            }
        }
        Action::Download { path } => {
            let socket = socket_for(socket, upstream).await?;
            let up_state = socket.state(remote, path).await?;
            socket.leave(remote, path).await?;
            state
                .replica_create(local, path, &up_state)
                .map_err(ReplicaError::Local)?;
            done(true, false)
        }
        Action::Upload { path } => {
            let local_state = state
                .replica_state(local, path)
                .map_err(ReplicaError::Local)?;
            match upstream.create(remote, path, &local_state).await? {
                Created::Yes => done(false, true),
                Created::Refused => Ok(Outcome::Held(Held::Refused)),
            }
        }
        Action::Exchange {
            path,
            local_changed,
            upstream_changed,
        } => {
            let socket = socket_for(socket, upstream).await?;
            let outcome = exchange(
                state,
                config,
                upstream,
                socket,
                path,
                Changed {
                    local: *local_changed,
                    upstream: *upstream_changed,
                },
                editable.contains(path.as_str()),
            )
            .await;
            socket.leave(remote, path).await?;
            outcome
        }
        Action::Purge { path } => {
            state
                .replica_release(local, path)
                .map_err(ReplicaError::Local)?;
            done(true, false)
        }
        Action::Recover { path } => {
            recover(state, config, path).map_err(ReplicaError::Local)?;
            done(true, false)
        }
        Action::DeleteUpstream { path } => {
            if upstream.delete(remote, path).await? {
                done(false, true)
            } else {
                // Refused: the note comes back here on the next pass.
                done(false, false)
            }
        }
        Action::Hold { why, .. } => Ok(Outcome::Held(*why)),
        Action::Forget { .. } => done(false, false),
    }
}

/// The media both sides are known to hold, in `<replica>/.memberberry/replica/media.json`.
///
/// Only an optimisation: without it (I1) a pass uploads this device's media once more, which
/// stores nothing new, since upstream addresses media by content.
fn media_known_path(root: &Path) -> PathBuf {
    root.join(".memberberry").join("replica").join("media.json")
}

fn load_known_media(root: &Path) -> BTreeSet<String> {
    std::fs::read(media_known_path(root))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_known_media(root: &Path, known: &BTreeSet<String>) -> Result<(), String> {
    let path = media_known_path(root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = serde_json::to_vec(known).map_err(|e| e.to_string())?;
    std::fs::write(path, bytes).map_err(|e| e.to_string())
}

/// The media objects a note's Markdown shows.
fn media_of(markdown: &str) -> Vec<String> {
    mb_core::extract(&mb_core::parse(markdown))
        .media
        .into_iter()
        .filter(|path| path.starts_with("media/"))
        .collect()
}

/// Sends upstream the media `note` shows that upstream is not known to hold. Returns how
/// many were sent.
async fn upload_media_of(
    state: &AppState,
    config: &ReplicaConfig,
    upstream: &Upstream,
    note: &str,
    known: &mut BTreeSet<String>,
) -> Result<usize, ReplicaError> {
    let Ok(markdown) = state.replica_markdown(&config.local, note) else {
        return Ok(0);
    };
    let mut sent = 0;
    for object in media_of(&markdown) {
        if known.contains(&object) {
            continue;
        }
        let Some(bytes) = state.replica_media(&config.local, &object) else {
            continue;
        };
        let extension = object.rsplit('.').next().unwrap_or_default();
        if let Some(stored) = upstream
            .upload_media(&config.upstream, &bytes, extension)
            .await?
            && stored == object
        {
            known.insert(object);
            sent += 1;
        }
    }
    Ok(sent)
}

/// Fetches the media that the notes on this device show and that is not here yet.
/// Recovered notes are left out: their media is already here, or was never upstream's.
async fn download_media(
    state: &AppState,
    config: &ReplicaConfig,
    upstream: &Upstream,
    root: &Path,
    known: &mut BTreeSet<String>,
) -> Result<usize, ReplicaError> {
    let recovered: BTreeSet<String> = recovered::load(root).into_iter().map(|r| r.path).collect();
    let mut wanted = BTreeSet::new();
    for note in state
        .replica_notes(&config.local)
        .map_err(ReplicaError::Local)?
    {
        if recovered.contains(&note.path) {
            continue;
        }
        if let Ok(markdown) = state.replica_markdown(&config.local, &note.path) {
            wanted.extend(media_of(&markdown));
        }
    }
    let mut fetched = 0;
    for object in wanted {
        if state.replica_media(&config.local, &object).is_some() {
            continue;
        }
        let Some(bytes) = upstream.media(&config.upstream, &object).await? else {
            continue;
        };
        // A body that is not what its address names is refused here, not written.
        if state
            .replica_media_write(&config.local, &object, &bytes)
            .is_ok()
        {
            known.insert(object);
            fetched += 1;
        }
    }
    Ok(fetched)
}

/// The recovered notes still awaiting a choice, by path, with the list rewritten without
/// any the user has since deleted.
///
/// A note named as a recovered note is counted too when the list lacks it (I1; see
/// [`recovered`]) — but only when neither upstream nor the record knows its path. Such a
/// note that upstream has is an ordinary synced note, and leaving it out of the pass would
/// read as deleted here and delete it upstream.
fn settle_recovered(
    root: &Path,
    local_notes: &[plan::LocalNote],
    known: &BTreeSet<&str>,
) -> Result<BTreeSet<String>, String> {
    let on_disk: BTreeSet<&str> = local_notes.iter().map(|n| n.path.as_str()).collect();
    let listed = recovered::load(root);
    let kept: Vec<recovered::Recovered> = listed
        .iter()
        .filter(|r| on_disk.contains(r.path.as_str()))
        .cloned()
        .collect();
    if kept.len() != listed.len() {
        recovered::save(root, kept.clone())?;
    }
    Ok(kept
        .into_iter()
        .map(|r| r.path)
        .chain(
            local_notes
                .iter()
                .filter(|n| {
                    recovered::is_recovered_name(&n.path) && !known.contains(n.path.as_str())
                })
                .map(|n| n.path.clone()),
        )
        .collect())
}

/// Keeps a note that left the readable set with changes made here (§7.6.7): its whole text
/// becomes a new local note under `Recovered/`, listed as awaiting the user's choice and never
/// synced on its own, and then the original is purged like any other (E35).
fn recover(state: &AppState, config: &ReplicaConfig, path: &str) -> Result<(), String> {
    let root = state.replica_root(&config.local)?;
    let markdown = state.replica_markdown(&config.local, path)?;
    let existing = state.replica_notes(&config.local)?;
    let taken: BTreeSet<&str> = existing.iter().map(|n| n.path.as_str()).collect();
    let to = recovered::path_for(path, &taken);
    state.replica_create_markdown(&config.local, &to, &recovered::without_id(&markdown))?;
    let mut listed = recovered::load(&root);
    listed.push(recovered::Recovered {
        path: to,
        original: path.to_string(),
        create_again_refused: false,
    });
    // why: the bookkeeping is written before the original goes. Were it the other way round,
    // a crash between the two would leave a recovered note nothing knows is recovered.
    recovered::save(&root, listed)?;
    state.replica_release(&config.local, path)
}

/// Which sides changed a note since the last pass.
#[derive(Debug, Clone, Copy)]
struct Changed {
    local: bool,
    upstream: bool,
}

/// Exchanges one note's histories so both sides end with the union (§7.6.9).
async fn exchange(
    state: &AppState,
    config: &ReplicaConfig,
    upstream: &Upstream,
    socket: &mut Socket,
    path: &str,
    changed: Changed,
    editable: bool,
) -> Result<Outcome, ReplicaError> {
    let local = config.local.as_str();
    let remote = config.upstream.as_str();
    let up_state = socket.state(remote, path).await?;
    let local_state = state
        .replica_state(local, path)
        .map_err(ReplicaError::Local)?;
    let up_doc = doc_of(&up_state)?;
    let local_doc = doc_of(&local_state)?;
    let up_vector = up_doc.transact().state_vector();
    let local_vector = local_doc.transact().state_vector();

    if !share_origin(&up_vector, &local_vector) {
        return diverged(
            state, config, upstream, socket, path, changed, &up_state, &up_doc,
        )
        .await;
    }

    let to_local = up_doc.transact().encode_state_as_update_v1(&local_vector);
    let downloaded = !is_empty_update(&to_local);
    if downloaded {
        state
            .replica_apply(local, path, &to_local)
            .map_err(ReplicaError::Local)?;
    }
    let to_upstream = local_doc.transact().encode_state_as_update_v1(&up_vector);
    if is_empty_update(&to_upstream) {
        return Ok(Outcome::Done {
            downloaded,
            uploaded: false,
        });
    }
    if !editable {
        return Ok(Outcome::Held(Held::ViewOnly));
    }
    match socket.push(remote, path, &to_upstream).await? {
        Pushed::Applied => Ok(Outcome::Done {
            downloaded,
            uploaded: true,
        }),
        Pushed::Refused(code) if code == "read_only" => Ok(Outcome::Held(Held::ViewOnly)),
        Pushed::Refused(code) => Err(ReplicaError::Refused(code)),
    }
}

/// The two histories of one note share no origin (S14), so they must not be merged.
///
/// Cases, first match wins:
/// - this device's file reads the same as upstream's note, or has not changed: take
///   upstream's history. Nothing is lost.
/// - only this device changed it: take upstream's history, then re-apply this device's file
///   as an edit and send that. Upstream still holds the last-synced text, so the file is a
///   strict descendant of it and the edit carries exactly this device's change.
/// - both changed: keep both. Upstream's note keeps the path; this device's becomes
///   `<name> (this device).md` and is uploaded.
#[allow(clippy::too_many_arguments)] // why: one call site; a struct would only rename them.
async fn diverged(
    state: &AppState,
    config: &ReplicaConfig,
    upstream: &Upstream,
    socket: &mut Socket,
    path: &str,
    changed: Changed,
    up_state: &[u8],
    up_doc: &Doc,
) -> Result<Outcome, ReplicaError> {
    let local = config.local.as_str();
    let remote = config.upstream.as_str();
    let up_markdown = mb_crdt::document_from_yrs(up_doc)
        .map(|document| mb_core::to_markdown(&document))
        .map_err(|e| ReplicaError::Upstream(e.to_string()))?;
    let local_markdown = state
        .replica_markdown(local, path)
        .map_err(ReplicaError::Local)?;
    if local_markdown == up_markdown || !changed.local {
        state
            .replica_adopt(local, path, up_state)
            .map_err(ReplicaError::Local)?;
        return Ok(Outcome::Done {
            downloaded: true,
            uploaded: false,
        });
    }
    if !changed.upstream {
        state
            .replica_adopt(local, path, up_state)
            .map_err(ReplicaError::Local)?;
        state
            .replica_restore(local, path, &local_markdown)
            .map_err(ReplicaError::Local)?;
        let now = doc_of(
            &state
                .replica_state(local, path)
                .map_err(ReplicaError::Local)?,
        )?;
        let edit = now
            .transact()
            .encode_state_as_update_v1(&up_doc.transact().state_vector());
        if is_empty_update(&edit) {
            return Ok(Outcome::Done {
                downloaded: true,
                uploaded: false,
            });
        }
        return match socket.push(remote, path, &edit).await? {
            Pushed::Applied => Ok(Outcome::Done {
                downloaded: true,
                uploaded: true,
            }),
            Pushed::Refused(code) if code == "read_only" => Ok(Outcome::Held(Held::ViewOnly)),
            Pushed::Refused(code) => Err(ReplicaError::Refused(code)),
        };
    }
    let copy = this_device_path(path);
    state
        .replica_move(local, path, &copy)
        .map_err(ReplicaError::Local)?;
    state
        .replica_create(local, path, up_state)
        .map_err(ReplicaError::Local)?;
    let copy_state = state
        .replica_state(local, &copy)
        .map_err(ReplicaError::Local)?;
    let uploaded = upstream.create(remote, &copy, &copy_state).await? == Created::Yes;
    Ok(Outcome::Done {
        downloaded: true,
        uploaded,
    })
}
