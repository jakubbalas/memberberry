//! Running this server inside the desktop app (`SPEC.md` §7.6.2).
//!
//! The Tauri host is a thin shim: it finds the platform directories, calls
//! [`DesktopServer::start`], opens a window at [`DesktopServer::launch_url`] and calls
//! [`DesktopServer::stop`] when the window closes. Everything with a decision in it lives
//! here, where the workspace's tests can reach it without a webview.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};

use crate::Error;
use crate::http::desktop::DesktopAccess;

/// The local user every desktop data directory signs in as.
pub const LOCAL_USERNAME: &str = "me";

/// Where one desktop installation keeps its state.
#[derive(Debug, Clone)]
pub struct DesktopPaths {
    /// Private app state: `server.toml`, `auth.db`, `desktop.toml`, the audit log. Never a
    /// vault, so no secret here can end up in one (AGENTS.md §3.3).
    pub app_data: PathBuf,
    /// Where new vaults are created, so their notes are where the user can see them.
    pub notes_home: PathBuf,
    /// The built web bundle the window loads.
    pub web_root: PathBuf,
}

/// Who is running the app, as the host process knows it.
#[derive(Debug, Clone)]
pub struct DesktopIdentity {
    /// The local user's display name: their OS account name.
    pub display_name: String,
    /// What this device calls itself on a server's approval page (§6.8.1), such as
    /// "Memberberry on Jo's MacBook".
    pub device_name: String,
}

/// Where device tokens are kept: the OS keychain in the app, memory in tests.
///
/// Secrets never go in `desktop.toml` or any other file the app writes (AGENTS.md §3.3).
pub trait SecretStore: std::fmt::Debug + Send + Sync {
    /// The secret stored for `account`, if any.
    ///
    /// # Errors
    ///
    /// A message for the user when the store cannot be read.
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    /// Stores `secret` for `account`, replacing any previous one.
    ///
    /// # Errors
    ///
    /// A message for the user when the store cannot be written.
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
    /// Forgets `account`'s secret. Forgetting a missing one succeeds.
    ///
    /// # Errors
    ///
    /// A message for the user when the store cannot be written.
    fn delete(&self, account: &str) -> Result<(), String>;
}

/// A [`SecretStore`] held in memory, for tests and development.
#[derive(Debug, Default)]
pub struct MemorySecrets(Mutex<BTreeMap<String, String>>);

impl SecretStore for MemorySecrets {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        let secrets = self
            .0
            .lock()
            .map_err(|_| "secret store unavailable".to_string())?;
        Ok(secrets.get(account).cloned())
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        let mut secrets = self
            .0
            .lock()
            .map_err(|_| "secret store unavailable".to_string())?;
        secrets.insert(account.to_string(), secret.to_string());
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        let mut secrets = self
            .0
            .lock()
            .map_err(|_| "secret store unavailable".to_string())?;
        secrets.remove(account);
        Ok(())
    }
}

/// A [`SecretStore`] that reads each account from the store behind it once per run.
///
/// why: macOS asks the user to allow every keychain read by an app it cannot verify — every
/// development build, and any unsigned one — and the sync loop needs the device token every
/// few seconds. Read through this, the keychain is asked once per launch. Writes and deletes
/// go to the keychain first and only then to memory, so the cache never claims a token the
/// keychain does not hold.
#[derive(Debug)]
pub struct CachedSecrets {
    inner: Arc<dyn SecretStore>,
    known: Mutex<BTreeMap<String, Option<String>>>,
}

impl CachedSecrets {
    /// Caches reads from `inner`.
    #[must_use]
    pub fn new(inner: Arc<dyn SecretStore>) -> Self {
        Self {
            inner,
            known: Mutex::new(BTreeMap::new()),
        }
    }
}

impl SecretStore for CachedSecrets {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        let mut known = self
            .known
            .lock()
            .map_err(|_| "secret cache unavailable".to_string())?;
        if let Some(secret) = known.get(account) {
            return Ok(secret.clone());
        }
        // A failed read is not cached: the user may have denied this once and allow it next.
        let secret = self.inner.get(account)?;
        known.insert(account.to_string(), secret.clone());
        Ok(secret)
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        self.inner.set(account, secret)?;
        if let Ok(mut known) = self.known.lock() {
            known.insert(account.to_string(), Some(secret.to_string()));
        }
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        self.inner.delete(account)?;
        if let Ok(mut known) = self.known.lock() {
            known.insert(account.to_string(), None);
        }
        Ok(())
    }
}

/// Opens a page in the user's own browser: the system browser in the app, a recorder in
/// tests.
///
/// why: the approval page must not be reached by navigating the app's window. The host
/// cancels any off-origin navigation and opens the browser instead, and a cancelled
/// navigation also cancels the waiting page's refresh, which left the window showing an
/// attempt that had long expired. The window never leaves its own page this way.
pub trait Browser: std::fmt::Debug + Send + Sync {
    /// Opens `url` in the user's browser.
    ///
    /// # Errors
    ///
    /// A message for the user when no browser could be started.
    fn open(&self, url: &str) -> Result<(), String>;
}

/// A [`Browser`] that remembers what it was asked to open, for tests.
#[derive(Debug, Default)]
pub struct RecordingBrowser(Mutex<Vec<String>>);

impl RecordingBrowser {
    /// Every URL opened so far, oldest first.
    #[must_use]
    pub fn opened(&self) -> Vec<String> {
        self.0.lock().map(|urls| urls.clone()).unwrap_or_default()
    }
}

impl Browser for RecordingBrowser {
    fn open(&self, url: &str) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|_| "browser unavailable".to_string())?
            .push(url.to_string());
        Ok(())
    }
}

/// Where the app's window sends a link it is asked to follow or open in a new window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkTarget {
    /// One of the app's own pages: shown in the app's window.
    App,
    /// A web or mail address: handed to the user's browser or mail app.
    Browser,
    /// Anything else (`file:`, `javascript:`, a custom scheme): followed nowhere.
    Refuse,
}

/// Decides where a link goes, given the app's own origin (`http://127.0.0.1:<port>`).
///
/// why: the app has one window and it must stay on its own origin — another site there
/// would have no way back and would run with the app's cookie in reach. Every other web
/// address opens in the user's own browser, whether the note's link navigates the window or
/// asks for a new one (`target="_blank"`).
#[must_use]
pub fn link_target(app_origin: &str, url: &str) -> LinkTarget {
    let same_origin = url.strip_prefix(app_origin).is_some_and(|rest| {
        rest.is_empty() || rest.starts_with('/') || rest.starts_with('?') || rest.starts_with('#')
    });
    if same_origin {
        return LinkTarget::App;
    }
    let scheme = url
        .split_once(':')
        .map(|(scheme, _)| scheme.to_ascii_lowercase());
    match scheme.as_deref() {
        Some("http" | "https" | "mailto") => LinkTarget::Browser,
        _ => LinkTarget::Refuse,
    }
}

/// What the host process provides the server: somewhere to keep secrets and a way to open
/// the user's browser.
#[derive(Debug, Clone)]
pub struct DesktopHost {
    /// Where device tokens are kept.
    pub secrets: Arc<dyn SecretStore>,
    /// How the sign-in page reaches the user's browser.
    pub browser: Arc<dyn Browser>,
}

/// A server this app knows (§6.8.1, §7.6.11). While signed in, its token is in the
/// [`SecretStore`] under `origin`, never here.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConnectedServer {
    /// `scheme://host[:port]` of the user's server.
    pub origin: String,
    /// The account the device acts as there, and whose notes any kept copy holds.
    pub username: String,
    /// That account's display name.
    pub display_name: String,
    /// The device token's identifier on that server.
    pub device_id: i64,
    /// Signed out with its notes kept on this computer (§7.6.11): listed, never synced or
    /// forwarded, and holding no token.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub signed_out: bool,
}

/// Per-installation settings the app remembers between runs, in `<app data>/desktop.toml`.
#[derive(Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct DesktopSettings {
    /// The loopback port this installation serves on.
    pub(crate) port: Option<u16>,
    /// The single server an installation from before §7.6.11 remembered. Read only, and moved
    /// into `servers` on load.
    #[serde(default, skip_serializing)]
    server: Option<ConnectedServer>,
    /// Every server this app knows, signed in or kept (§7.6.11).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) servers: Vec<ConnectedServer>,
    /// The server vaults this device keeps a replica of (§7.6.9).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) replicas: Vec<crate::replica::ReplicaConfig>,
}

/// The embedded server, running on its own thread.
#[derive(Debug)]
pub struct DesktopServer {
    launch_url: String,
    port: u16,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<Result<(), Error>>>,
}

impl DesktopServer {
    /// Prepares `paths` and starts serving. Returns once the port is bound.
    ///
    /// # Errors
    ///
    /// Fails if a directory cannot be created, the data directory was set up by something
    /// other than this app, the configuration is unreadable, or no loopback port is free.
    pub fn start(
        paths: &DesktopPaths,
        identity: &DesktopIdentity,
        host: DesktopHost,
    ) -> Result<Self, Error> {
        std::fs::create_dir_all(&paths.app_data).map_err(|e| io_error(&paths.app_data, &e))?;
        std::fs::create_dir_all(&paths.notes_home).map_err(|e| io_error(&paths.notes_home, &e))?;

        let mut auth = mb_auth::AuthDb::open(&paths.app_data.join("auth.db"))
            .map_err(|error| Error::Auth(error.to_string()))?;
        ensure_local_user(&mut auth, &identity.display_name)?;

        let config_path = paths.app_data.join("server.toml");
        let config = crate::ServerConfig::load(&config_path)?;
        let vaults = config.open_vaults(std::env::var_os("HOME").as_deref())?;

        let listener = bind_remembered_port(&paths.app_data)?;
        let port = listener.local_addr().map_err(Error::Serve)?.port();
        let (access, launch) = DesktopAccess::new(port, LOCAL_USERNAME);
        let access = access.with_connect(crate::http::desktop::ConnectOptions {
            settings_path: paths.app_data.join("desktop.toml"),
            secrets: Arc::new(CachedSecrets::new(host.secrets)),
            browser: host.browser,
            device_name: identity.device_name.clone(),
            notes_home: paths.notes_home.clone(),
        })?;

        let audit = crate::audit::AuditLog::new(&paths.app_data, 10 * 1024 * 1024)
            .map_err(|error| Error::Config(error.to_string()))?;
        let state = crate::http::AppState::authenticated_with_audit_and_web_root(
            vaults,
            auth,
            Some(audit),
            paths.web_root.clone(),
        )?
        .with_data_dir(paths.app_data.clone())
        .with_vault_management_root(config_path, paths.notes_home.clone(), false)?
        .with_desktop(access);

        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let thread = std::thread::Builder::new()
            .name("memberberry-server".into())
            .spawn(move || run(state, listener, stopped))
            .map_err(Error::Serve)?;
        Ok(Self {
            launch_url: launch.url().to_string(),
            port,
            stop: Some(stop),
            thread: Some(thread),
        })
    }

    /// The URL the window opens first. Its launch code works once.
    #[must_use]
    pub fn launch_url(&self) -> &str {
        &self.launch_url
    }

    /// The loopback port being served.
    #[must_use]
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Stops serving and waits for pending note writes to flush.
    ///
    /// # Errors
    ///
    /// Returns the error the server stopped with, if it stopped on its own.
    pub fn stop(mut self) -> Result<(), Error> {
        if let Some(stop) = self.stop.take() {
            // A send fails only when the server already stopped; its result is joined below.
            let _ = stop.send(());
        }
        match self.thread.take().map(std::thread::JoinHandle::join) {
            Some(Ok(result)) => result,
            Some(Err(_)) => Err(Error::Config("the server thread panicked".into())),
            None => Ok(()),
        }
    }
}

fn run(
    state: crate::http::AppState,
    listener: std::net::TcpListener,
    stopped: tokio::sync::oneshot::Receiver<()>,
) -> Result<(), Error> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(Error::Serve)?;
    runtime.block_on(async move {
        let listener = tokio::net::TcpListener::from_std(listener).map_err(Error::Serve)?;
        let stop = async move {
            drop(stopped.await);
        };
        let state = Arc::new(state);
        tokio::spawn(crate::http::desktop::sync_replicas(Arc::clone(&state)));
        crate::http::serve_until(state, listener, stop).await
    })
}

/// Creates the local user on first run, and refuses a data directory set up by a person.
///
/// The password is random and never stored or shown: the desktop window is signed in by
/// E34's guard, so no one ever types it.
///
/// # Errors
///
/// Fails if the database cannot be read or written, or if it already has users and none is
/// the desktop's local user.
pub fn ensure_local_user(auth: &mut mb_auth::AuthDb, display_name: &str) -> Result<(), Error> {
    let auth_error = |error: mb_auth::Error| Error::Auth(error.to_string());
    if !auth.needs_setup().map_err(auth_error)? {
        return match auth.user_by_username(LOCAL_USERNAME).map_err(auth_error)? {
            Some(user) if user.is_admin && !user.disabled => Ok(()),
            _ => Err(Error::Auth(
                "this data directory was not created by the desktop app".into(),
            )),
        };
    }
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let password: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    let display_name = if display_name.trim().is_empty() {
        "Me"
    } else {
        display_name.trim()
    };
    auth.setup_first_user(mb_auth::NewUser {
        username: LOCAL_USERNAME,
        display_name,
        password: &password,
    })
    .map_err(auth_error)?;
    Ok(())
}

/// Binds the port this installation used last time, or a fresh one it then remembers.
///
/// why: the window's origin includes the port, and the browser keys its storage by origin.
/// A new port every launch would forget every per-device layout and cached replica.
fn bind_remembered_port(app_data: &Path) -> Result<std::net::TcpListener, Error> {
    let settings_path = app_data.join("desktop.toml");
    let mut settings = load_settings(&settings_path)?;
    if let Some(port) = settings.port
        && let Ok(listener) = bind(port)
    {
        return Ok(listener);
    }
    let listener = bind(0)?;
    settings.port = Some(listener.local_addr().map_err(Error::Serve)?.port());
    save_settings(&settings_path, &settings)?;
    Ok(listener)
}

pub(crate) fn save_settings(path: &Path, settings: &DesktopSettings) -> Result<(), Error> {
    let text = toml::to_string(settings).map_err(|e| Error::Config(e.to_string()))?;
    std::fs::write(path, text).map_err(|e| io_error(path, &e))
}

fn bind(port: u16) -> Result<std::net::TcpListener, Error> {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let listener =
        std::net::TcpListener::bind(addr).map_err(|source| Error::Bind { addr, source })?;
    listener.set_nonblocking(true).map_err(Error::Serve)?;
    Ok(listener)
}

pub(crate) fn load_settings(path: &Path) -> Result<DesktopSettings, Error> {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            let mut settings: DesktopSettings =
                toml::from_str(&text).map_err(|e| Error::Config(format!("desktop.toml: {e}")))?;
            if let Some(legacy) = settings.server.take()
                && !settings.servers.iter().any(|s| s.origin == legacy.origin)
            {
                settings.servers.push(legacy);
            }
            Ok(settings)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(DesktopSettings::default())
        }
        Err(source) => Err(Error::ReadConfig {
            path: path.to_path_buf(),
            source,
        }),
    }
}

fn io_error(path: &Path, error: &std::io::Error) -> Error {
    Error::Config(format!("{}: {error}", path.display()))
}

#[cfg(test)]
// why: a test that cannot set up its fixture should fail loudly, not return an error.
#[allow(clippy::expect_used)]
mod tests {
    use super::{LinkTarget, link_target, load_settings};

    const APP: &str = "http://127.0.0.1:9010";

    #[test]
    fn the_apps_own_pages_stay_in_the_window() {
        for url in [
            APP,
            "http://127.0.0.1:9010/",
            "http://127.0.0.1:9010/v/work/Hello.md?x#y",
        ] {
            assert_eq!(link_target(APP, url), LinkTarget::App, "{url}");
        }
    }

    #[test]
    fn web_and_mail_addresses_go_to_the_browser() {
        for url in [
            "https://example.com/page",
            "HTTP://example.com",
            "mailto:someone@example.com",
            // Another port on loopback is another site.
            "http://127.0.0.1:90100/",
            "http://127.0.0.1:9011/",
            // A host that merely starts with the app's origin is another site.
            "http://127.0.0.1:9010.evil.example/",
            "http://127.0.0.1:9010@evil.example/",
        ] {
            assert_eq!(link_target(APP, url), LinkTarget::Browser, "{url}");
        }
    }

    #[test]
    fn other_schemes_go_nowhere() {
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "vscode://x",
            "about:blank",
            "",
        ] {
            assert_eq!(link_target(APP, url), LinkTarget::Refuse, "{url:?}");
        }
    }

    #[test]
    fn a_single_server_from_before_several_servers_is_read_as_a_list() {
        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join("desktop.toml");
        std::fs::write(
            &path,
            "[server]\norigin = \"https://notes.example.com\"\nusername = \"alice\"\n\
             display_name = \"Alice\"\ndevice_id = 3\n",
        )
        .expect("settings");
        let settings = load_settings(&path).expect("loaded");
        assert_eq!(
            settings
                .servers
                .iter()
                .map(|s| (s.origin.as_str(), s.signed_out))
                .collect::<Vec<_>>(),
            vec![("https://notes.example.com", false)]
        );
    }

    #[test]
    fn a_saved_list_never_writes_the_old_single_server_table() {
        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join("desktop.toml");
        std::fs::write(
            &path,
            "[server]\norigin = \"https://notes.example.com\"\nusername = \"alice\"\n\
             display_name = \"Alice\"\ndevice_id = 3\n",
        )
        .expect("settings");
        let settings = load_settings(&path).expect("loaded");
        super::save_settings(&path, &settings).expect("saved");
        let text = std::fs::read_to_string(&path).expect("text");
        assert!(
            text.contains("[[servers]]") && !text.contains("[server]"),
            "{text}"
        );
    }
}
