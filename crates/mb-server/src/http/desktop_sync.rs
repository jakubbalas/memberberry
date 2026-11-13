//! The connected server's vaults in the desktop app (`SPEC.md` §7.6.10).
//!
//! Every vault the device's user can read upstream is registered here as a local vault,
//! with no download step: online it is forwarded to the server ([`super::desktop_forward`]),
//! offline it is answered from its folder. [`sync_replicas`] runs a pass for each every few
//! seconds, which registers vaults that appeared upstream, keeps the notes available offline
//! in step, and tells the forwarding layer whether the server can be reached.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use super::desktop_connect::{Connect, connect_of};
use super::{AppState, push_escaped_attr, push_escaped_text};
use crate::desktop::{ConnectedServer, load_settings, save_settings};
use crate::replica::plan::Held;
use crate::replica::upstream::{Upstream, UpstreamVault};
use crate::replica::{self, ReplicaConfig, ReplicaError};

/// Time between passes when nothing asks for one sooner.
const PASS_INTERVAL: Duration = Duration::from_secs(5);

/// The server vaults, whether each is reachable, and what their last pass did.
#[derive(Debug, Default)]
pub(crate) struct SyncStatus {
    by_vault: Mutex<BTreeMap<String, VaultStatus>>,
    /// Starts a pass now, as after a change of pins.
    wake: tokio::sync::Notify,
    /// Serializes changes to `desktop.toml`'s vault list.
    settings: Mutex<()>,
    /// The registered server vaults, as `desktop.toml` lists them.
    vaults: RwLock<Vec<ReplicaConfig>>,
    /// Local addresses of server vaults whose server could not be reached.
    offline: Mutex<BTreeSet<String>>,
    /// One client per server, with the token it was made for, so forwarded requests reuse
    /// their connections instead of opening one each — a workspace opens a dozen at once.
    upstream: Mutex<BTreeMap<String, (String, Upstream)>>,
    /// Held for a pass, and by anything that moves a replica's notes outside one.
    ///
    /// why: placing a recovered note (§7.6.7) moves it and creates it upstream in two steps.
    /// A pass between them would see an unlisted local note and upload it on its own — a
    /// second create, and the user's choice taken out of their hands.
    passing: tokio::sync::Mutex<()>,
    /// Each server vault's recovered notes (§7.6.7), by local address. In memory because the
    /// window's every sync frame asks; refreshed before each pass and after each choice.
    recovered: Mutex<BTreeMap<String, BTreeSet<String>>>,
}

#[derive(Debug, Clone, Default)]
struct VaultStatus {
    last_pass: Option<Instant>,
    error: Option<String>,
    held: Vec<(String, Held)>,
}

impl SyncStatus {
    /// The server vault registered at local address `slug`.
    pub(super) fn server_vault(&self, slug: &str) -> Option<ReplicaConfig> {
        self.vaults
            .read()
            .ok()?
            .iter()
            .find(|vault| vault.local == slug)
            .cloned()
    }

    /// Whether `slug`'s server was reachable at the last attempt.
    pub(super) fn is_online(&self, slug: &str) -> bool {
        self.offline
            .lock()
            .map(|offline| !offline.contains(slug))
            .unwrap_or(false)
    }

    pub(super) fn set_online(&self, slug: &str, online: bool) {
        if let Ok(mut offline) = self.offline.lock() {
            if online {
                offline.remove(slug);
            } else if offline.insert(slug.to_string()) {
                // A forward just failed: try again soon rather than in a full interval.
                self.wake.notify_one();
            }
        }
    }

    /// The client for `origin` with `token`, reused while both stay the same.
    pub(super) fn upstream_for(&self, origin: &str, token: &str) -> Option<Upstream> {
        let mut cached = self.upstream.lock().ok()?;
        if let Some((t, client)) = cached.get(origin)
            && t == token
        {
            return Some(client.clone());
        }
        let client = Upstream::new(origin, token).ok()?;
        cached.insert(origin.to_string(), (token.to_string(), client.clone()));
        Some(client)
    }

    /// The registered server vaults, as last read from `desktop.toml`.
    pub(super) fn registered(&self) -> Vec<ReplicaConfig> {
        self.vaults
            .read()
            .map(|vaults| vaults.clone())
            .unwrap_or_default()
    }

    /// Re-reads the registered server vaults from `desktop.toml`.
    pub(super) fn reload_vaults(&self, settings_path: &Path) {
        let registered = load_settings(settings_path)
            .map(|settings| settings.replicas)
            .unwrap_or_default();
        if let Ok(mut vaults) = self.vaults.write() {
            *vaults = registered;
        }
    }

    /// Serializes a change to `desktop.toml` with every other writer of it.
    pub(super) fn settings_writer(&self) -> Option<std::sync::MutexGuard<'_, ()>> {
        self.settings.lock().ok()
    }

    /// Forgets everything kept about `origin`: its client and its vaults' states.
    pub(super) fn forget_server(&self, origin: &str, locals: &[String]) {
        if let Ok(mut cached) = self.upstream.lock() {
            cached.remove(origin);
        }
        self.forget_vaults(locals);
    }

    /// Forgets the pass and offline states of `locals`.
    pub(super) fn forget_vaults(&self, locals: &[String]) {
        if let Ok(mut recovered) = self.recovered.lock() {
            for local in locals {
                recovered.remove(local);
            }
        }
        if let Ok(mut statuses) = self.by_vault.lock() {
            for local in locals {
                statuses.remove(local);
            }
        }
        if let Ok(mut offline) = self.offline.lock() {
            for local in locals {
                offline.remove(local);
            }
        }
    }

    /// Asks for a pass now.
    pub(super) fn wake_now(&self) {
        self.wake.notify_one();
    }

    /// Held notes of one vault, from its last pass.
    /// Re-reads `config`'s recovered notes from its folder.
    pub(super) fn refresh_recovered(&self, state: &AppState, config: &ReplicaConfig) {
        let paths: BTreeSet<String> = state
            .replica_root(&config.local)
            .map(|root| {
                replica::recovered::load(&root)
                    .into_iter()
                    .map(|r| r.path)
                    .collect()
            })
            .unwrap_or_default();
        if let Ok(mut recovered) = self.recovered.lock() {
            recovered.insert(config.local.clone(), paths);
        }
    }

    /// Whether `note` is a recovered note of server vault `slug`: it exists only here.
    pub(super) fn is_recovered(&self, slug: &str, note: &str) -> bool {
        self.recovered.lock().is_ok_and(|recovered| {
            recovered
                .get(slug)
                .is_some_and(|paths| paths.contains(note))
        })
    }

    /// The recovered notes of server vault `slug`.
    pub(super) fn recovered_of(&self, slug: &str) -> Vec<String> {
        self.recovered
            .lock()
            .ok()
            .and_then(|recovered| {
                recovered
                    .get(slug)
                    .map(|paths| paths.iter().cloned().collect())
            })
            .unwrap_or_default()
    }

    /// Waits until no pass is running, and keeps one from starting while held.
    pub(super) async fn exclusive(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.passing.lock().await
    }

    pub(super) fn held(&self, slug: &str) -> Vec<(String, Held)> {
        self.by_vault
            .lock()
            .ok()
            .and_then(|statuses| statuses.get(slug).map(|status| status.held.clone()))
            .unwrap_or_default()
    }
}

/// Registers and syncs every signed-in server's vaults until the runtime stops.
///
/// Holds nothing between passes: each reads the settings and the token afresh, so a
/// disconnect, a new pin or a revoked device takes effect on the next pass.
pub async fn sync_replicas(state: Arc<AppState>) {
    let Some(connect) = connect_of(&state) else {
        return;
    };
    loop {
        pass_all(&state, connect).await;
        tokio::select! {
            () = tokio::time::sleep(PASS_INTERVAL) => {}
            () = connect.sync.wake.notified() => {}
        }
    }
}

async fn pass_all(state: &AppState, connect: &Connect) {
    let _passing = connect.sync.exclusive().await;
    connect.sync.reload_vaults(&connect.options.settings_path);
    for config in connect.sync.registered() {
        connect.sync.refresh_recovered(state, &config);
    }
    let signed_in = connect.signed_in();
    // why: a vault whose server is signed out, or forgotten mid-pass, has no token to reach
    // it with; it is served from its folder like any offline vault (§7.6.11).
    let vaults = connect.sync.registered();
    for vault in &vaults {
        if !signed_in.iter().any(|server| server.origin == vault.origin) {
            connect.sync.set_online(&vault.local, false);
        }
    }
    for server in &signed_in {
        let token = match connect.options.secrets.get(&server.origin) {
            Ok(Some(token)) => token,
            _ => continue,
        };
        let Ok(upstream) = Upstream::new(&server.origin, &token) else {
            continue;
        };
        if let Ok(listed) = upstream.vaults().await {
            for vault in &listed {
                if let Err(error) = register(state, connect, server, vault) {
                    eprintln!(
                        "memberberry: could not add the server vault {}: {error}",
                        vault.slug
                    );
                }
            }
            // A vault this user can no longer read at all is settled like a note that left
            // the readable set (§7.6.7 case 4, E35). Only on a list the server gave: an
            // unreachable server says nothing about what was removed.
            let gone: Vec<ReplicaConfig> = connect
                .sync
                .registered()
                .into_iter()
                .filter(|r| {
                    r.origin == server.origin && !listed.iter().any(|v| v.slug == r.upstream)
                })
                .collect();
            for config in &gone {
                if let Err(error) = settle_gone_vault(state, connect, config).await {
                    eprintln!(
                        "memberberry: could not settle the removed vault {}: {error}",
                        config.upstream
                    );
                }
            }
        }
        connect.sync.reload_vaults(&connect.options.settings_path);
        pass_server(state, connect, &server.origin, &upstream).await;
    }
}

/// What a pass over one server's vaults left on this computer that the server does not
/// have (§7.6.11). Empty when everything here has reached the server.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(super) struct Unsent {
    /// Why the pass could not confirm that the server has every change made here. Set only
    /// when this computer holds notes whose changes could be lost.
    pub(super) unconfirmed: Option<&'static str>,
    /// Notes with changes the server does not have: the vault's name, the note's path and
    /// why, in words for the user.
    pub(super) notes: Vec<UnsentNote>,
}

/// One note whose changes exist only on this computer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct UnsentNote {
    pub(super) vault: String,
    pub(super) path: String,
    pub(super) why: String,
}

impl Unsent {
    /// Whether removing this server's notes from this computer loses nothing.
    pub(super) fn is_clean(&self) -> bool {
        self.unconfirmed.is_none() && self.notes.is_empty()
    }
}

/// Why a server vault's changes could not be confirmed as sent, when it is not signed in.
const SIGNED_OUT_UNSENT: &str = "This computer is signed out of the server, so changes made \
    here since then were never sent.";
const UNREACHABLE_UNSENT: &str = "The server cannot be reached, so changes made here since it \
    was last reached may not have been sent.";
const REFUSED_UNSENT: &str = "The server no longer accepts this device, so changes made here \
    could not be sent.";
const FAILED_UNSENT: &str = "Memberberry could not finish checking that every change was sent.";

/// One pass over each of `origin`'s registered vaults, recording what it did and returning
/// what is still only on this computer.
pub(super) async fn pass_server(
    state: &AppState,
    connect: &Connect,
    origin: &str,
    upstream: &Upstream,
) -> Unsent {
    let mut unsent = Unsent::default();
    let vaults = connect.sync.registered();
    for config in vaults.iter().filter(|r| r.origin == origin) {
        let outcome = replica::pass(state, config, upstream).await;
        connect.sync.refresh_recovered(state, config);
        connect.sync.set_online(
            &config.local,
            !matches!(outcome, Err(ReplicaError::Upstream(_))),
        );
        let unconfirmed = match &outcome {
            Ok(_) => None,
            Err(ReplicaError::Upstream(_)) => Some(UNREACHABLE_UNSENT),
            Err(ReplicaError::Unauthorized) => Some(REFUSED_UNSENT),
            Err(_) => Some(FAILED_UNSENT),
        };
        // why: a vault with nothing on this computer has nothing to lose, whatever the
        // server's state; only one holding notes can leave changes behind.
        if unconfirmed.is_some() && holds_notes(state, &config.local) {
            unsent.unconfirmed = unsent.unconfirmed.or(unconfirmed);
        }
        if let Ok(report) = &outcome {
            for (path, why) in &report.held {
                unsent.push(config, path, held_reason(*why));
            }
            for (path, why) in &report.failed {
                unsent.push(config, path, &format!("did not sync: {why}"));
            }
        }
        for path in connect.sync.recovered_of(&config.local) {
            unsent.push(
                config,
                &path,
                "kept here after it left what you can read on the server",
            );
        }
        let Ok(mut statuses) = connect.sync.by_vault.lock() else {
            return unsent;
        };
        let status = statuses.entry(config.local.clone()).or_default();
        match outcome {
            Ok(report) => {
                status.last_pass = Some(Instant::now());
                status.held = report.held;
                status.error = report
                    .failed
                    .first()
                    .map(|(path, why)| format!("{path} did not sync: {why}"));
            }
            Err(ReplicaError::Unauthorized) => {
                status.error = Some(
                    "The server no longer accepts this device. Disconnect it, then connect \
                     again."
                        .into(),
                );
            }
            Err(error) => status.error = Some(error.to_string()),
        }
    }
    unsent
}

impl Unsent {
    fn push(&mut self, config: &ReplicaConfig, path: &str, why: &str) {
        self.notes.push(UnsentNote {
            vault: config.name.clone(),
            path: path.to_string(),
            why: why.to_string(),
        });
    }
}

/// What disconnecting `server` would lose, without a pass: for a server this computer is
/// signed out of, which can no longer be reached with a token (§7.6.11).
pub(super) fn unsent_while_signed_out(
    state: &AppState,
    connect: &Connect,
    server: &ConnectedServer,
) -> Unsent {
    let mut unsent = Unsent::default();
    for config in connect
        .sync
        .registered()
        .iter()
        .filter(|v| v.origin == server.origin)
    {
        if holds_notes(state, &config.local) {
            unsent.unconfirmed = Some(SIGNED_OUT_UNSENT);
        }
        for path in connect.sync.recovered_of(&config.local) {
            unsent.push(
                config,
                &path,
                "kept here after it left what you can read on the server",
            );
        }
    }
    unsent
}

/// Whether server vault `local` has any note on this computer.
fn holds_notes(state: &AppState, local: &str) -> bool {
    // why: a folder that cannot be listed may hold anything, so it counts as holding notes.
    !state
        .replica_notes(local)
        .is_ok_and(|notes| notes.is_empty())
}

/// Adds a server vault as a local one, unless it already is.
fn register(
    state: &AppState,
    connect: &Connect,
    server: &ConnectedServer,
    vault: &UpstreamVault,
) -> Result<(), String> {
    let _writer = connect
        .sync
        .settings_writer()
        .ok_or_else(|| "settings are locked".to_string())?;
    let mut settings = load_settings(&connect.options.settings_path).map_err(|e| e.to_string())?;
    if settings
        .replicas
        .iter()
        .any(|r| r.origin == server.origin && r.upstream == vault.slug)
    {
        return Ok(());
    }
    let local = free_slug(state, &vault.slug).ok_or("no free vault address")?;
    let root = free_folder(
        &connect.options.notes_home.join(host_folder(&server.origin)),
        &vault.slug,
    )
    .ok_or("no free folder")?;
    let config = ReplicaConfig {
        local,
        upstream: vault.slug.clone(),
        name: vault.name.clone(),
        origin: server.origin.clone(),
    };
    replica::create_local(state, &config, &root).map_err(|e| e.to_string())?;
    settings.replicas.push(config);
    save_settings(&connect.options.settings_path, &settings).map_err(|e| e.to_string())
}

/// Takes `origin`'s vaults out of the app, deletes their folders and forgets the server
/// (§7.6.11). Only folders inside the notes home are ever deleted.
pub(super) fn remove_server_notes(
    state: &AppState,
    connect: &Connect,
    origin: &str,
) -> Result<(), crate::Error> {
    let locals: Vec<String> = connect
        .sync
        .registered()
        .into_iter()
        .filter(|v| v.origin == origin)
        .map(|v| v.local)
        .collect();
    let home = connect.options.notes_home.canonicalize().ok();
    for local in &locals {
        let root = match state.replica_unregister(local) {
            Ok(root) => root,
            // Already gone from the running server: only the settings entry is left.
            Err(_) if !replica::has_local(state, local) => continue,
            Err(error) => return Err(crate::Error::Config(error)),
        };
        delete_inside(home.as_deref(), &root)?;
    }
    if let Some(home) = &home {
        // An emptied `<server-host>` folder goes too; one holding anything else stays.
        let host = home.join(host_folder(origin));
        if std::fs::read_dir(&host).is_ok_and(|mut entries| entries.next().is_none()) {
            std::fs::remove_dir(&host).map_err(crate::Error::Serve)?;
        }
    }
    {
        let _writer = connect
            .sync
            .settings_writer()
            .ok_or_else(|| crate::Error::Config("desktop settings are locked".into()))?;
        let mut settings = load_settings(&connect.options.settings_path)?;
        settings.replicas.retain(|r| r.origin != origin);
        settings.servers.retain(|s| s.origin != origin);
        save_settings(&connect.options.settings_path, &settings)?;
    }
    connect.sync.reload_vaults(&connect.options.settings_path);
    connect.sync.forget_server(origin, &locals);
    Ok(())
}

/// Settles a server vault the user can no longer read (§7.6.7 case 4): its notes are purged
/// or recovered, and it stops being a server vault. With recovered notes it stays on this
/// computer as a vault of its own; with none, it and its folder go.
async fn settle_gone_vault(
    state: &AppState,
    connect: &Connect,
    config: &ReplicaConfig,
) -> Result<(), crate::Error> {
    let left = replica::vault_gone(state, config)
        .await
        .map_err(|e| crate::Error::Config(e.to_string()))?;
    if left == 0 {
        let home = connect.options.notes_home.canonicalize().ok();
        let root = state
            .replica_unregister(&config.local)
            .map_err(crate::Error::Config)?;
        delete_inside(home.as_deref(), &root)?;
    }
    {
        let _writer = connect
            .sync
            .settings_writer()
            .ok_or_else(|| crate::Error::Config("desktop settings are locked".into()))?;
        let mut settings = load_settings(&connect.options.settings_path)?;
        settings
            .replicas
            .retain(|r| !(r.origin == config.origin && r.local == config.local));
        save_settings(&connect.options.settings_path, &settings)?;
    }
    connect.sync.reload_vaults(&connect.options.settings_path);
    connect
        .sync
        .forget_vaults(std::slice::from_ref(&config.local));
    Ok(())
}

/// Deletes `root` if, resolved, it lies strictly inside `home`; refuses anything else.
fn delete_inside(home: Option<&Path>, root: &Path) -> Result<(), crate::Error> {
    let resolved = match root.canonicalize() {
        Ok(resolved) => resolved,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(crate::Error::Serve(error)),
    };
    let inside = home.is_some_and(|home| resolved != home && resolved.starts_with(home));
    if !inside {
        return Err(crate::Error::Config(format!(
            "refusing to delete {}: it is not inside the Memberberry folder",
            resolved.display()
        )));
    }
    // why: the vault is already unregistered, so nothing new starts writing here, but a
    // reconcile or index merge that began before may still add a file for a moment. Such a
    // file makes the walk fail as "not empty"; once that writer finishes, it succeeds.
    let mut attempts = 0;
    loop {
        match std::fs::remove_dir_all(&resolved) {
            Ok(()) => return Ok(()),
            Err(error)
                if error.kind() == std::io::ErrorKind::DirectoryNotEmpty && attempts < 20 =>
            {
                attempts += 1;
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(crate::Error::Serve(error)),
        }
    }
}

/// Why a note is held, in words for the user.
pub(super) fn held_reason(why: Held) -> &'static str {
    match why {
        Held::GoneUpstream => "changed here, but no longer on the server",
        Held::ViewOnly => "changed here, but you may only view it on the server",
        Held::Refused => "the server would not accept it",
    }
}

/// `https://notes.example.com:8443` → `notes.example.com-8443`.
fn host_folder(origin: &str) -> String {
    origin
        .split_once("://")
        .map_or(origin, |(_, rest)| rest)
        .replace([':', '/'], "-")
}

fn free_slug(state: &AppState, wanted: &str) -> Option<String> {
    std::iter::once(wanted.to_string())
        .chain((2..100).map(|n| format!("{wanted}-{n}")))
        .find(|slug| !replica::has_local(state, slug))
}

fn free_folder(parent: &Path, wanted: &str) -> Option<PathBuf> {
    std::iter::once(wanted.to_string())
        .chain((2..100).map(|n| format!("{wanted}-{n}")))
        .map(|name| parent.join(name))
        .find(|path| !path.exists())
}

#[cfg(test)]
// why: a test that cannot set up its fixture should fail loudly, not return an error.
#[allow(clippy::expect_used)]
mod tests {
    use super::{delete_inside, host_folder};

    #[test]
    fn a_folder_inside_the_notes_home_is_deleted() {
        let dir = tempfile::tempdir().expect("dir");
        let home = dir.path().canonicalize().expect("home");
        let vault = home.join("host/work");
        std::fs::create_dir_all(vault.join("notes")).expect("vault");
        delete_inside(Some(&home), &vault).expect("deleted");
        assert!(!vault.exists());
    }

    #[test]
    fn a_folder_outside_the_notes_home_is_refused() {
        let dir = tempfile::tempdir().expect("dir");
        let home = dir.path().canonicalize().expect("home").join("home");
        let elsewhere = dir.path().join("elsewhere");
        std::fs::create_dir_all(&home).expect("home");
        std::fs::create_dir_all(&elsewhere).expect("elsewhere");
        assert!(delete_inside(Some(&home), &elsewhere).is_err() && elsewhere.exists());
    }

    #[test]
    fn the_notes_home_itself_is_refused() {
        let dir = tempfile::tempdir().expect("dir");
        let home = dir.path().canonicalize().expect("home");
        assert!(delete_inside(Some(&home), &home).is_err() && home.exists());
    }

    #[test]
    fn a_path_escaping_the_notes_home_through_dot_dot_is_refused() {
        let dir = tempfile::tempdir().expect("dir");
        let home = dir.path().canonicalize().expect("home").join("home");
        let elsewhere = dir.path().join("elsewhere");
        std::fs::create_dir_all(&home).expect("home");
        std::fs::create_dir_all(&elsewhere).expect("elsewhere");
        assert!(
            delete_inside(Some(&home), &home.join("../elsewhere")).is_err() && elsewhere.exists()
        );
    }

    #[test]
    fn without_a_notes_home_nothing_is_deleted() {
        let dir = tempfile::tempdir().expect("dir");
        let vault = dir.path().join("work");
        std::fs::create_dir_all(&vault).expect("vault");
        assert!(delete_inside(None, &vault).is_err() && vault.exists());
    }

    #[test]
    fn a_host_and_port_become_one_folder_name() {
        assert_eq!(
            host_folder("https://notes.example.com:8443"),
            "notes.example.com-8443"
        );
    }

    #[test]
    fn a_plain_host_keeps_its_name() {
        assert_eq!(
            host_folder("https://notes.example.com"),
            "notes.example.com"
        );
    }
}

/// What `GET /api/v1/vaults/{slug}/offline` reports, for the tree and menus.
#[derive(Debug, serde::Serialize)]
struct OfflineState {
    /// A server vault: the offline commands apply. `false` for a vault only on this device.
    server: bool,
    /// The server answered at the last attempt.
    online: bool,
    pins: crate::replica::pins::Pins,
    /// Notes whose copy is on this device.
    downloaded: Vec<String>,
    held: Vec<HeldNote>,
    /// Notes that left the server with edits made here, awaiting the user's choice (§7.6.7).
    recovered: Vec<crate::replica::recovered::Recovered>,
}

#[derive(Debug, serde::Serialize)]
struct HeldNote {
    path: String,
    reason: &'static str,
}

#[derive(Debug, serde::Deserialize)]
pub(super) struct PinRequest {
    kind: crate::replica::pins::PinKind,
    #[serde(default)]
    path: String,
    offline: bool,
}

fn offline_state(state: &AppState, connect: &Connect, slug: &str) -> Option<OfflineState> {
    let config = connect.sync.server_vault(slug)?;
    let root = state.replica_root(&config.local).ok()?;
    let downloaded: Vec<String> = state
        .replica_notes(&config.local)
        .ok()?
        .into_iter()
        .map(|note| note.path)
        .collect();
    let pins = crate::replica::pins::load(&root, downloaded.iter().map(String::as_str)).ok()?;
    let recovered = crate::replica::recovered::load(&root)
        .into_iter()
        .filter(|r| downloaded.contains(&r.path))
        .collect();
    Some(OfflineState {
        server: true,
        recovered,
        online: connect.sync.is_online(slug),
        pins,
        downloaded,
        held: connect
            .sync
            .held(slug)
            .into_iter()
            .map(|(path, why)| HeldNote {
                path,
                reason: held_reason(why),
            })
            .collect(),
    })
}

fn json(status: axum::http::StatusCode, value: &impl serde::Serialize) -> axum::response::Response {
    use axum::response::IntoResponse;
    (
        status,
        [
            (axum::http::header::CONTENT_TYPE, "application/json"),
            (axum::http::header::CACHE_CONTROL, "no-store"),
        ],
        serde_json::to_string(value).unwrap_or_default(),
    )
        .into_response()
}

/// `GET /api/v1/vaults/{slug}/offline`: which notes are available offline (§7.6.10).
pub(super) async fn offline_get(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    axum::extract::Path(slug): axum::extract::Path<String>,
) -> axum::response::Response {
    let Some(connect) = connect_of(&state) else {
        return json(axum::http::StatusCode::NOT_FOUND, &serde_json::json!({}));
    };
    match offline_state(&state, connect, &slug) {
        Some(offline) => json(axum::http::StatusCode::OK, &offline),
        None => json(
            axum::http::StatusCode::OK,
            &serde_json::json!({ "server": false }),
        ),
    }
}

/// `POST /api/v1/vaults/{slug}/offline`: make a note, folder or the vault available
/// offline, or online only (§7.6.10). The next pass downloads or releases.
pub(super) async fn offline_set(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    axum::extract::Path(slug): axum::extract::Path<String>,
    headers: axum::http::HeaderMap,
    axum::Json(request): axum::Json<PinRequest>,
) -> axum::response::Response {
    use crate::replica::pins::{self, PinKind};
    let Some(connect) = connect_of(&state) else {
        return json(axum::http::StatusCode::NOT_FOUND, &serde_json::json!({}));
    };
    if !super::onboarding::same_origin(&headers) {
        return json(axum::http::StatusCode::FORBIDDEN, &serde_json::json!({}));
    }
    let Some(current) = offline_state(&state, connect, &slug) else {
        return json(axum::http::StatusCode::NOT_FOUND, &serde_json::json!({}));
    };
    let mut pins = current.pins;
    if !request.offline
        && request.kind != PinKind::Vault
        && let Some((kind, by)) = pins.held_by(&request.path)
        && !(kind == request.kind && by == request.path.trim_matches('/'))
    {
        let message = match kind {
            PinKind::Vault => {
                "The whole vault is available offline. Make the vault online only first."
                    .to_string()
            }
            _ => {
                format!("The folder {by} is available offline. Make that folder online only first.")
            }
        };
        return json(
            axum::http::StatusCode::CONFLICT,
            &serde_json::json!({ "error": message }),
        );
    }
    pins.set(request.kind, &request.path, request.offline);
    let saved = state
        .replica_root(&slug)
        .and_then(|root| pins::save(&root, &pins));
    if let Err(error) = saved {
        return json(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            &serde_json::json!({ "error": error }),
        );
    }
    connect.sync.wake_now();
    match offline_state(&state, connect, &slug) {
        Some(offline) => json(axum::http::StatusCode::OK, &offline),
        None => json(axum::http::StatusCode::NOT_FOUND, &serde_json::json!({})),
    }
}

#[derive(Debug, serde::Deserialize)]
pub(super) struct PlaceRequest {
    /// The recovered note.
    path: String,
    /// Where to make the new note; absent to create the note again where it was.
    #[serde(default)]
    to: Option<String>,
}

/// `POST /api/v1/vaults/{slug}/recovered`: the user's choice for a recovered note (§7.6.7).
///
/// Answered by this app, never forwarded: a recovered note exists only here.
pub(super) async fn recovered_place(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    axum::extract::Path(slug): axum::extract::Path<String>,
    headers: axum::http::HeaderMap,
    axum::Json(request): axum::Json<PlaceRequest>,
) -> axum::response::Response {
    use axum::http::StatusCode;
    let Some(connect) = connect_of(&state) else {
        return json(StatusCode::NOT_FOUND, &serde_json::json!({}));
    };
    if !super::onboarding::same_origin(&headers) {
        return json(StatusCode::FORBIDDEN, &serde_json::json!({}));
    }
    let Some(config) = connect.sync.server_vault(&slug) else {
        return json(StatusCode::NOT_FOUND, &serde_json::json!({}));
    };
    let offline = || {
        json(
            StatusCode::SERVICE_UNAVAILABLE,
            &serde_json::json!({ "error": "Your server can't be reached. Try again when it can." }),
        )
    };
    let Some(server) = connect.signed_in_at(&config.origin) else {
        return offline();
    };
    let Some(upstream) = connect
        .options
        .secrets
        .get(&server.origin)
        .ok()
        .flatten()
        .and_then(|token| connect.sync.upstream_for(&server.origin, &token))
    else {
        return offline();
    };
    let placed = {
        let _passing = connect.sync.exclusive().await;
        let placed = replica::place_recovered(
            &state,
            &config,
            &upstream,
            &request.path,
            request.to.as_deref(),
        )
        .await;
        connect.sync.refresh_recovered(&state, &config);
        placed
    };
    match placed {
        Ok(replica::Placed::Created) => {
            connect.sync.wake_now();
            match offline_state(&state, connect, &slug) {
                Some(current) => json(StatusCode::OK, &current),
                None => json(StatusCode::OK, &serde_json::json!({ "server": false })),
            }
        }
        // why: E17's one refusal for every reason, so it says nothing about what is there.
        Ok(replica::Placed::Refused) => json(
            StatusCode::CONFLICT,
            &serde_json::json!({ "error": "Memberberry could not create a note there." }),
        ),
        Err(ReplicaError::Local(_)) => json(
            StatusCode::BAD_REQUEST,
            &serde_json::json!({ "error": "Choose a note name ending in .md." }),
        ),
        Err(ReplicaError::Unauthorized) => json(
            StatusCode::FORBIDDEN,
            &serde_json::json!({ "error": "The server no longer accepts this device. Disconnect it, then connect again." }),
        ),
        Err(_) => offline(),
    }
}

/// What the vault picker says about one server vault.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ServerVaultSummary {
    online: bool,
    /// Notes the server listed at the last pass.
    total: usize,
    /// Notes whose copy is on this device.
    downloaded: usize,
    /// The whole vault is available offline.
    whole: bool,
    /// Notes with changes only this computer has (held or recovered).
    unsent: usize,
}

impl ServerVaultSummary {
    /// A warning for the card when changes here have not reached the server.
    pub(super) fn unsent_line(&self) -> Option<String> {
        match self.unsent {
            0 => None,
            1 => Some("1 note not synced".to_string()),
            n => Some(format!("{n} notes not synced")),
        }
    }

    /// One line for the card: how big it is and what of it is on this device.
    pub(super) fn describe(&self) -> String {
        let notes = |n: usize| {
            if n == 1 {
                "1 note".to_string()
            } else {
                format!("{n} notes")
            }
        };
        if !self.online {
            if self.downloaded == 0 {
                return "Offline · nothing kept on this device".to_string();
            }
            return format!("Offline · {} on this device", notes(self.downloaded));
        }
        let total = self.total.max(self.downloaded);
        if self.whole {
            return format!("{} · all available offline", notes(total));
        }
        if self.downloaded == 0 {
            return format!("{} · online only", notes(total));
        }
        format!("{} · {} available offline", notes(total), self.downloaded)
    }
}

impl AppState {
    /// The picker's summary of `slug`, when it is a desktop server vault.
    pub(super) fn server_vault_summary(&self, slug: &str) -> Option<ServerVaultSummary> {
        let connect = connect_of(self)?;
        let config = connect.sync.server_vault(slug)?;
        let root = self.replica_root(&config.local).ok()?;
        let downloaded = self.replica_notes(&config.local).ok()?;
        let pins =
            crate::replica::pins::load(&root, downloaded.iter().map(|n| n.path.as_str())).ok()?;
        Some(ServerVaultSummary {
            online: connect.sync.is_online(slug),
            total: crate::replica::load_listing(&root).len(),
            downloaded: downloaded.len(),
            whole: pins.vault,
            unsent: connect.sync.held(slug).len() + connect.sync.recovered_of(slug).len(),
        })
    }

    /// The picker's groups, one per known server (§7.6.11): its origin and the group's
    /// opening HTML — the server's name, account, state and actions — which the caller
    /// closes after the vault cards.
    pub(super) fn server_groups(&self) -> Vec<(String, String)> {
        let Some(connect) = connect_of(self) else {
            return Vec::new();
        };
        let vaults = connect.sync.registered();
        let statuses = connect
            .sync
            .by_vault
            .lock()
            .map(|statuses| statuses.clone())
            .unwrap_or_default();
        connect
            .servers()
            .into_iter()
            .map(|server| {
                let mine: Vec<&ReplicaConfig> = vaults
                    .iter()
                    .filter(|v| v.origin == server.origin)
                    .collect();
                let online = mine.iter().all(|v| connect.sync.is_online(&v.local));
                let error = mine
                    .iter()
                    .find_map(|v| statuses.get(&v.local).and_then(|s| s.error.clone()));
                (
                    server.origin.clone(),
                    server_group_head(&server, online, error.as_deref()),
                )
            })
            .collect()
    }
}

/// A server group's heading on the picker: who is signed in, whether it can be reached, and
/// the way to sign in again or disconnect.
fn server_group_head(server: &ConnectedServer, online: bool, error: Option<&str>) -> String {
    let mut out = String::from("<section class=\"mb-vault-group\" data-server=\"");
    push_escaped_attr(&mut out, &server.origin);
    out.push_str("\"><div class=\"mb-group-head\">");
    out.push_str(SERVER_MARK);
    out.push_str("<div class=\"mb-group-id\"><h2 class=\"mb-group-title\">");
    push_escaped_text(&mut out, host_of(&server.origin));
    out.push_str(if server.signed_out {
        " <span class=\"mb-badge\" data-state=\"offline\">Signed out</span>"
    } else if online {
        " <span class=\"mb-badge\" data-state=\"online\">Online</span>"
    } else {
        " <span class=\"mb-badge\" data-state=\"offline\">Offline</span>"
    });
    out.push_str("</h2><p class=\"mb-group-sub\">");
    out.push_str(if server.signed_out {
        "Signed out · notes kept for "
    } else {
        "Signed in as "
    });
    push_escaped_text(&mut out, &server.display_name);
    out.push_str(" (");
    push_escaped_text(&mut out, &server.username);
    out.push_str(")</p></div><div class=\"mb-group-actions\">");
    if server.signed_out {
        out.push_str(
            "<form method=\"post\" action=\"/desktop/connect\"><input type=\"hidden\" \
             name=\"server\" value=\"",
        );
        push_escaped_attr(&mut out, &server.origin);
        out.push_str(
            "\"><button class=\"mb-button mb-small\" type=\"submit\">Sign in again\
             </button></form>",
        );
    }
    out.push_str("<a class=\"mb-button mb-quiet mb-small\" href=\"/desktop/disconnect?server=");
    push_escaped_attr(&mut out, &super::encode_query_value(&server.origin));
    out.push_str("\" aria-label=\"Disconnect ");
    push_escaped_attr(&mut out, host_of(&server.origin));
    out.push_str("\">Disconnect</a></div></div>");
    if let Some(error) = error {
        out.push_str("<p class=\"mb-group-alert\" role=\"status\">");
        push_escaped_text(&mut out, error);
        out.push_str("</p>");
    }
    out
}

/// A server, drawn, for a server group's heading.
const SERVER_MARK: &str = "<span class=\"mb-group-mark\" aria-hidden=\"true\"><svg \
    viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" \
    stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"3\" y=\"4\" width=\"18\" \
    height=\"7\" rx=\"2\" /><rect x=\"3\" y=\"13\" width=\"18\" height=\"7\" rx=\"2\" />\
    <path d=\"M7 7.5h.01M7 16.5h.01\" /></svg></span>";

/// `https://notes.example.com:8443` → `notes.example.com:8443`.
pub(super) fn host_of(origin: &str) -> &str {
    origin.split_once("://").map_or(origin, |(_, host)| host)
}

#[cfg(test)]
mod summary_tests {
    use super::ServerVaultSummary;

    fn summary(online: bool, total: usize, downloaded: usize, whole: bool) -> String {
        ServerVaultSummary {
            online,
            total,
            downloaded,
            whole,
            unsent: 0,
        }
        .describe()
    }

    #[test]
    fn nothing_unsent_adds_no_warning() {
        let summary = ServerVaultSummary {
            online: true,
            total: 3,
            downloaded: 1,
            whole: false,
            unsent: 0,
        };
        assert_eq!(summary.unsent_line(), None);
    }

    #[test]
    fn unsent_notes_are_counted_for_the_card() {
        let summary = |unsent| ServerVaultSummary {
            online: true,
            total: 3,
            downloaded: 3,
            whole: false,
            unsent,
        };
        assert_eq!(
            (summary(1).unsent_line(), summary(2).unsent_line()),
            (
                Some("1 note not synced".to_string()),
                Some("2 notes not synced".to_string())
            )
        );
    }

    #[test]
    fn an_online_vault_with_nothing_downloaded_says_online_only() {
        assert_eq!(summary(true, 12, 0, false), "12 notes · online only");
    }

    #[test]
    fn an_online_vault_counts_what_is_kept_offline() {
        assert_eq!(
            summary(true, 12, 3, false),
            "12 notes · 3 available offline"
        );
    }

    #[test]
    fn a_whole_vault_offline_says_so() {
        assert_eq!(
            summary(true, 12, 12, true),
            "12 notes · all available offline"
        );
    }

    #[test]
    fn offline_with_nothing_kept_says_so_in_words() {
        assert_eq!(
            summary(false, 12, 0, false),
            "Offline · nothing kept on this device"
        );
    }

    #[test]
    fn offline_says_what_is_on_this_device() {
        assert_eq!(
            summary(false, 12, 1, false),
            "Offline · 1 note on this device"
        );
    }
}
