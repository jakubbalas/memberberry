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

/// One pass over each of `origin`'s registered vaults, recording what it did.
pub(super) async fn pass_server(
    state: &AppState,
    connect: &Connect,
    origin: &str,
    upstream: &Upstream,
) {
    let vaults = connect.sync.registered();
    for config in vaults.iter().filter(|r| r.origin == origin) {
        let outcome = replica::pass(state, config, upstream).await;
        connect.sync.refresh_recovered(state, config);
        connect.sync.set_online(
            &config.local,
            !matches!(outcome, Err(ReplicaError::Upstream(_))),
        );
        let Ok(mut statuses) = connect.sync.by_vault.lock() else {
            return;
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
                    "The server no longer accepts this device. Sign out, then sign in again."
                        .into(),
                );
            }
            Err(error) => status.error = Some(error.to_string()),
        }
    }
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

/// The sign-out confirmation for `server` (§7.6.11): what is on this computer, what has not
/// reached the server, and the choice between removing and keeping it.
pub(super) fn sign_out_page(
    state: &AppState,
    connect: &Connect,
    server: &ConnectedServer,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let vaults: Vec<ReplicaConfig> = connect
        .sync
        .registered()
        .into_iter()
        .filter(|v| v.origin == server.origin)
        .collect();
    let downloaded: usize = vaults
        .iter()
        .filter_map(|v| state.replica_notes(&v.local).ok())
        .map(|notes| notes.len())
        .sum();
    let held: Vec<(String, Held)> = vaults
        .iter()
        .flat_map(|v| connect.sync.held(&v.local))
        .collect();
    let unreachable =
        !server.signed_out && vaults.iter().any(|v| !connect.sync.is_online(&v.local));
    let host = host_of(&server.origin);
    let mut body = String::from("<p>");
    if server.signed_out {
        body.push_str("Remove the notes this computer keeps from ");
        push_escaped_text(&mut body, host);
        body.push_str("? The copies on the server are not touched.</p>");
    } else {
        body.push_str("This device stops syncing with ");
        push_escaped_text(&mut body, host);
        body.push_str(" and its access there is revoked.</p>");
    }
    if downloaded > 0 {
        body.push_str("<p>");
        body.push_str(&match downloaded {
            1 => "1 note is".to_string(),
            n => format!("{n} notes are"),
        });
        body.push_str(" available offline on this computer.</p>");
    }
    // why: nothing syncs while signed out, so any edit made since has never been sent.
    let edited_while_out = server.signed_out && downloaded > 0;
    if !held.is_empty() || unreachable || edited_while_out {
        body.push_str("<p class=\"mb-form-error\" role=\"alert\">");
        if edited_while_out {
            body.push_str("Changes made to these notes since you signed out were never sent. ");
        }
        if unreachable {
            body.push_str(
                "The server cannot be reached right now, so changes made since it was last \
                 reached have not been sent. ",
            );
        }
        if !held.is_empty() {
            body.push_str("These notes have changes the server has not accepted: ");
            for (i, (path, _)) in held.iter().enumerate() {
                if i > 0 {
                    body.push_str(", ");
                }
                body.push_str("<code>");
                push_escaped_text(&mut body, path);
                body.push_str("</code>");
            }
            body.push_str(". ");
        }
        body.push_str("Removing the notes from this computer loses those changes.</p>");
    }
    body.push_str(
        "<form method=\"post\" action=\"/desktop/disconnect\"><input type=\"hidden\" \
         name=\"server\" value=\"",
    );
    push_escaped_attr(&mut body, &server.origin);
    body.push_str("\"><div class=\"mb-actions\">");
    // why: with nothing on this computer there is nothing to choose between (§7.6.11).
    if downloaded > 0 && !server.signed_out {
        body.push_str(
            "<button class=\"mb-button mb-action\" type=\"submit\" name=\"notes\" \
             value=\"keep\">Sign out, keep notes on this computer</button>\
             <button class=\"mb-button mb-quiet mb-action\" type=\"submit\" name=\"notes\" \
             value=\"remove\">Sign out and remove them</button>",
        );
    } else {
        body.push_str(
            "<button class=\"mb-button mb-action\" type=\"submit\" name=\"notes\" \
             value=\"remove\">",
        );
        body.push_str(if server.signed_out {
            "Remove notes"
        } else {
            "Sign out"
        });
        body.push_str("</button>");
    }
    body.push_str(
        "<a class=\"mb-button mb-quiet mb-action\" href=\"/desktop/connect\">Cancel</a>\
         </div></form>",
    );
    let title = if server.signed_out {
        "Remove kept notes"
    } else {
        "Sign out"
    };
    (
        axum::http::StatusCode::OK,
        super::page_with(super::PagePolicy::SignIn, title, &body),
    )
        .into_response()
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
    std::fs::remove_dir_all(&resolved).map_err(crate::Error::Serve)
}

/// The connected page's list of the server's vaults and their state.
pub(super) fn vaults_section(
    state: &AppState,
    connect: &Connect,
    server: &ConnectedServer,
) -> String {
    let mut out = String::from("<h3>Vaults</h3>");
    let vaults: Vec<ReplicaConfig> = connect
        .sync
        .vaults
        .read()
        .map(|vaults| {
            vaults
                .iter()
                .filter(|v| v.origin == server.origin)
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    if vaults.is_empty() {
        out.push_str("<p class=\"mb-empty\">Looking for your vaults on this server…</p>");
        return out;
    }
    let statuses = connect
        .sync
        .by_vault
        .lock()
        .map(|statuses| statuses.clone())
        .unwrap_or_default();
    out.push_str(if server.signed_out {
        "<p>They stay in your vault list with what was kept on this computer.</p>"
    } else {
        "<p>They are in your vault list and work online. Right-click a note or folder to make \
         it available offline.</p>"
    });
    out.push_str("<ul class=\"mb-list\">");
    for vault in &vaults {
        out.push_str("<li><a href=\"/v/");
        push_escaped_attr(&mut out, &vault.local);
        out.push_str("/\"><strong>");
        push_escaped_text(&mut out, &vault.name);
        out.push_str("</strong></a> ");
        let root = state.replica_root(&vault.local).unwrap_or_default();
        push_status(
            &mut out,
            &root,
            connect.sync.is_online(&vault.local),
            statuses.get(&vault.local),
        );
        out.push_str("</li>");
    }
    out.push_str("</ul>");
    out
}

fn push_status(out: &mut String, root: &Path, online: bool, status: Option<&VaultStatus>) {
    out.push_str("<p>");
    out.push_str(if online {
        "Online."
    } else {
        "Offline: showing what is on this device."
    });
    out.push_str(" Notes available offline are kept in <code>");
    push_escaped_text(out, &root.display().to_string());
    out.push_str("</code>.");
    if let Some(error) = status.and_then(|s| s.error.as_ref()) {
        out.push_str(" <span class=\"mb-form-error\" role=\"alert\">");
        push_escaped_text(out, error);
        out.push_str("</span>");
    }
    out.push_str("</p>");
    let Some(status) = status.filter(|s| !s.held.is_empty()) else {
        return;
    };
    out.push_str("<p>Not synced, kept on this device:</p><ul>");
    for (path, why) in &status.held {
        out.push_str("<li><code>");
        push_escaped_text(out, path);
        out.push_str("</code> — ");
        out.push_str(held_reason(*why));
        out.push_str("</li>");
    }
    out.push_str("</ul>");
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
            &serde_json::json!({ "error": "The server no longer accepts this device. Sign out, then sign in again." }),
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
}

impl ServerVaultSummary {
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
        })
    }

    /// The picker's groups, one per known server (§7.6.11): its origin and the group's
    /// opening HTML, which the caller closes after the vault cards.
    pub(super) fn server_groups(&self) -> Vec<(String, String)> {
        let Some(connect) = connect_of(self) else {
            return Vec::new();
        };
        let vaults = connect.sync.registered();
        connect
            .servers()
            .into_iter()
            .map(|server| {
                let online = vaults
                    .iter()
                    .filter(|v| v.origin == server.origin)
                    .all(|v| connect.sync.is_online(&v.local));
                let mut out = String::from(
                    "<section class=\"mb-vault-group\"><h2 class=\"mb-vault-group-head\">On ",
                );
                push_escaped_text(&mut out, host_of(&server.origin));
                out.push_str(if server.signed_out {
                    " <span class=\"mb-badge\" data-state=\"offline\">Signed out</span>"
                } else if online {
                    " <span class=\"mb-badge\" data-state=\"online\">Online</span>"
                } else {
                    " <span class=\"mb-badge\" data-state=\"offline\">Offline</span>"
                });
                out.push_str("<a href=\"/desktop/connect\">Manage</a></h2>");
                (server.origin, out)
            })
            .collect()
    }
}

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
        }
        .describe()
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
