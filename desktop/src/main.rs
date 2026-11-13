//! Memberberry desktop: the web UI in a native window over an embedded server (`SPEC.md`
//! §7.6).
//!
//! A shim, deliberately. Every decision — the local user, the remembered port, E34's guard —
//! lives in `mb_server::desktop`, where the workspace's tests reach it. This file finds the
//! platform directories, opens the window, keeps it on its own origin and stops the server
//! when the app exits so pending note writes flush.

// why: a release build is a GUI app; without this, Windows also opens a console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use mb_server::desktop::{
    Browser, DesktopHost, DesktopIdentity, DesktopPaths, DesktopServer, LinkTarget, SecretStore,
    link_target,
};
use tauri::webview::NewWindowResponse;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// The running server, taken out and stopped when the app exits.
struct Running(Mutex<Option<DesktopServer>>);

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let paths = desktop_paths(app.handle())?;
            let identity = DesktopIdentity {
                display_name: display_name(),
                device_name: device_name(),
            };
            let host = DesktopHost {
                secrets: Arc::new(Keychain),
                browser: Arc::new(SystemBrowser),
            };
            let server = DesktopServer::start(&paths, &identity, host)?;
            let launch = url::Url::parse(server.launch_url())?;
            let origin = launch.origin().ascii_serialization();
            let new_window_origin = origin.clone();
            app.manage(Running(Mutex::new(Some(server))));
            let handle = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(launch))
                .title("Memberberry")
                .inner_size(1280.0, 800.0)
                .min_inner_size(400.0, 500.0)
                // why: a link in a note must not take the app's only window to another site,
                // where it would have no way back and would run with this window's cookies
                // in reach. Anything off this origin opens in the user's browser instead
                // (`link_target`, SPEC §7.6.8).
                .on_navigation(move |target| match link_target(&origin, target.as_str()) {
                    LinkTarget::App => true,
                    LinkTarget::Browser => {
                        hand_to_browser(target.as_str());
                        false
                    }
                    LinkTarget::Refuse => false,
                })
                // why: a `target="_blank"` link or `window.open` asks for a new window instead
                // of navigating, and the app has one window. A web address goes to the
                // browser; one of the app's own pages opens in the app's window.
                .on_new_window(move |target, _features| {
                    match link_target(&new_window_origin, target.as_str()) {
                        LinkTarget::App => {
                            if let Some(window) = handle.get_webview_window("main")
                                && let Err(error) = window.navigate(target)
                            {
                                eprintln!("memberberry: could not open an app page: {error}");
                            }
                        }
                        LinkTarget::Browser => hand_to_browser(target.as_str()),
                        LinkTarget::Refuse => {}
                    }
                    NewWindowResponse::Deny
                })
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the Tauri application could not be built from tauri.conf.json");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            let server = handle
                .state::<Running>()
                .0
                .lock()
                .ok()
                .and_then(|mut running| running.take());
            if let Some(server) = server
                && let Err(error) = server.stop()
            {
                eprintln!("memberberry: the server stopped with an error: {error}");
            }
        }
    });
}

/// The platform's directories, unless `MEMBERBERRY_DESKTOP_DATA` / `MEMBERBERRY_NOTES_HOME`
/// point elsewhere — so a developer or a test can run the app without touching their own
/// notes.
fn desktop_paths(app: &tauri::AppHandle) -> Result<DesktopPaths, tauri::Error> {
    let path = app.path();
    let app_data = match std::env::var_os("MEMBERBERRY_DESKTOP_DATA") {
        Some(dir) => PathBuf::from(dir),
        None => path.app_data_dir()?,
    };
    let notes_home = match std::env::var_os("MEMBERBERRY_NOTES_HOME") {
        Some(dir) => PathBuf::from(dir),
        None => path.home_dir()?.join("Memberberry"),
    };
    Ok(DesktopPaths {
        app_data,
        notes_home,
        web_root: web_root(path.resource_dir().ok()),
    })
}

/// The bundled web build in an installed app, or this checkout's `web/dist` under `cargo run`.
fn web_root(resources: Option<PathBuf>) -> PathBuf {
    let bundled = resources.map(|dir| dir.join("web"));
    match bundled {
        Some(dir) if dir.join("index.html").is_file() => dir,
        _ => PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../web/dist"),
    }
}

/// Device tokens in the OS keychain, one entry per server origin.
#[derive(Debug)]
struct Keychain;

/// The keychain service name entries are filed under.
const KEYCHAIN_SERVICE: &str = "app.memberberry.desktop";

impl SecretStore for Keychain {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        keyring::Entry::new(KEYCHAIN_SERVICE, account)
            .and_then(|entry| entry.set_password(secret))
            .map_err(|e| e.to_string())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

/// What this device is called on a server's approval page: "Memberberry on <computer>".
fn device_name() -> String {
    #[cfg(target_os = "macos")]
    let computer = std::process::Command::new("scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok());
    #[cfg(not(target_os = "macos"))]
    let computer = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok();
    let computer = computer
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty() && !name.chars().any(char::is_control))
        .unwrap_or_else(|| "this computer".to_string());
    // The server accepts 1–64 characters (§6.8.1).
    format!("Memberberry on {computer}")
        .chars()
        .take(64)
        .collect()
}

/// The local user's display name: the account name the OS knows them by.
fn display_name() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default()
}

/// The user's default browser, for the sign-in page (§6.8.1).
#[derive(Debug)]
struct SystemBrowser;

impl Browser for SystemBrowser {
    fn open(&self, url: &str) -> Result<(), String> {
        open_externally(url)
    }
}

fn hand_to_browser(url: &str) {
    if let Err(error) = open_externally(url) {
        eprintln!("memberberry: could not open a link in the browser: {error}");
    }
}

fn open_externally(url: &str) -> Result<(), String> {
    let scheme = url.split(':').next().unwrap_or_default();
    if !matches!(scheme, "http" | "https" | "mailto") {
        return Err(format!("not a web address: {scheme}"));
    }
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let spawned = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", url])
        .spawn();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let spawned = std::process::Command::new("xdg-open").arg(url).spawn();
    spawned.map(drop).map_err(|error| error.to_string())
}
