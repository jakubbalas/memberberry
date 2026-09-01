//! `server.toml` — bind address and the vault registry (`SPEC.md` §4.1, §6.1).
//!
//! Server-owned and never inside a vault, so a vault stays exactly the human-meaningful
//! artifacts plus `access.toml`.
//!
//! ```toml
//! bind = "127.0.0.1:9010"
//!
//! [[vaults]]
//! slug = "personal"
//! name = "Personal"
//! path = "~/Documents/ultrabrain"
//! ```

use std::ffi::OsStr;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::Error;
use crate::vault::{Slug, Vault};

/// Development default (AGENTS.md §5.1). Loopback is the safe development default even
/// with authentication, so a first run never exposes a private vault to the local network.
pub const DEFAULT_BIND: &str = "127.0.0.1:9010";

/// The on-disk shape of `server.toml`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerConfig {
    /// Address to listen on. Defaults to [`DEFAULT_BIND`].
    #[serde(default)]
    pub bind: Option<String>,
    #[serde(default, rename = "vaults")]
    pub vaults: Vec<VaultEntry>,
}

/// One `[[vaults]]` entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VaultEntry {
    pub slug: String,
    /// Human-readable label. Defaults to the slug.
    #[serde(default)]
    pub name: Option<String>,
    pub path: String,
}

impl ServerConfig {
    /// Parses `server.toml`.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Config`] for malformed TOML or an unknown key. `deny_unknown_fields`
    /// is deliberate: a typo in a config key that is silently ignored is a setting the user
    /// believes is applied and is not.
    pub fn parse(toml_text: &str) -> Result<Self, Error> {
        toml::from_str(toml_text).map_err(|e| Error::Config(e.to_string()))
    }

    /// Reads `server.toml`, or returns the default when the file does not exist.
    ///
    /// # Errors
    ///
    /// Fails if the file exists but cannot be read or parsed.
    pub fn load(path: &Path) -> Result<Self, Error> {
        match std::fs::read_to_string(path) {
            Ok(text) => Self::parse(&text),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(source) => Err(Error::ReadConfig {
                path: path.to_path_buf(),
                source,
            }),
        }
    }

    /// Serializes back to TOML, for `memberberry vault create`.
    ///
    /// # Errors
    ///
    /// Fails only if the config cannot be represented, which the types make impossible.
    pub fn to_toml(&self) -> Result<String, Error> {
        toml::to_string_pretty(self).map_err(|e| Error::Config(e.to_string()))
    }

    /// The parsed bind address.
    ///
    /// # Errors
    ///
    /// Fails if `bind` is not a valid `host:port`.
    pub fn bind_addr(&self) -> Result<SocketAddr, Error> {
        let raw = self.bind.as_deref().unwrap_or(DEFAULT_BIND);
        raw.parse()
            .map_err(|_| Error::Config(format!("`bind` is not a valid address: {raw}")))
    }

    /// Opens every registered vault.
    ///
    /// # Errors
    ///
    /// Fails on an invalid or duplicated slug, or a root that is missing or not a directory.
    /// All of those are startup-time mistakes, and failing loudly beats a server that runs
    /// with half a registry.
    pub fn open_vaults(&self, home: Option<&OsStr>) -> Result<Vec<Vault>, Error> {
        let mut opened: Vec<Vault> = Vec::with_capacity(self.vaults.len());
        for entry in &self.vaults {
            let slug = Slug::parse(&entry.slug)?;
            if opened.iter().any(|v| v.slug() == &slug) {
                return Err(Error::DuplicateSlug(slug.to_string()));
            }
            let name = entry.name.clone().unwrap_or_else(|| slug.to_string());
            let root = expand_home(&entry.path, home);
            opened.push(Vault::open(slug, name, root)?);
        }
        Ok(opened)
    }
}

/// Expands a leading `~`, which people write in config files whatever the docs say.
#[must_use]
pub fn expand_home(path: &str, home: Option<&OsStr>) -> PathBuf {
    let remainder = if path == "~" {
        Some("")
    } else {
        path.strip_prefix("~/")
    };
    match (remainder, home) {
        (Some(rest), Some(home)) => Path::new(home).join(rest),
        // No HOME to expand against: leave it alone and let opening the vault report a
        // missing path, which names the literal `~` and is easier to diagnose than a guess.
        _ => PathBuf::from(path),
    }
}
