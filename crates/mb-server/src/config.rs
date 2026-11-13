//! `server.toml` — bind address, vault registry and optional folder locations (§4.1, §6.1).
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
use crate::vault_locations::VaultLocation;

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
    /// Existing registered vaults, unchanged by location configuration.
    #[serde(default, rename = "vaults")]
    pub vaults: Vec<VaultEntry>,
    /// Explicit server directories available to the future administrator folder picker.
    /// Empty by default; parsing validates syntax without opening or enumerating roots.
    #[serde(
        default,
        skip_serializing_if = "Vec::is_empty",
        deserialize_with = "deserialize_locations"
    )]
    pub vault_locations: Vec<VaultLocation>,
    /// Directory containing Vite's production build. Relative paths resolve from the server.
    #[serde(default)]
    pub web_root: Option<String>,
    /// Sign-in through an OpenID Connect provider (`SPEC.md` §6.8.2). Absent: passwords only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oidc: Option<OidcConfig>,
}

/// The `[oidc]` table of `server.toml` (§6.8.2, E38).
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OidcConfig {
    /// The provider's issuer, exactly as its discovery document states it.
    pub issuer: String,
    /// This server's client id at the provider.
    pub client_id: String,
    /// This server's client secret. Never logged, never shown (AGENTS.md §3.3).
    pub client_secret: String,
    /// This server's `…/oidc/callback`, exactly as registered at the provider. Configured,
    /// never derived from a request's `Host`, which the client controls.
    pub redirect_url: String,
    /// The sign-in button's provider name: "Sign in with <name>".
    #[serde(default = "default_oidc_name")]
    pub name: String,
    /// Scopes requested.
    #[serde(default = "default_oidc_scopes")]
    pub scopes: String,
    /// The ID-token claim holding the person's groups (M20b).
    #[serde(default = "default_groups_claim")]
    pub groups_claim: String,
    /// Whether the password form stays available beside the provider's button.
    #[serde(default = "default_true")]
    pub password_login: bool,
}

// why: by hand, so `{:?}` of a config — in an error, a log line, a panic — never prints the
// client secret.
impl std::fmt::Debug for OidcConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OidcConfig")
            .field("issuer", &self.issuer)
            .field("client_id", &self.client_id)
            .field("client_secret", &"<redacted>")
            .field("redirect_url", &self.redirect_url)
            .field("name", &self.name)
            .field("scopes", &self.scopes)
            .field("groups_claim", &self.groups_claim)
            .field("password_login", &self.password_login)
            .finish()
    }
}

fn default_oidc_name() -> String {
    "your identity provider".to_string()
}

fn default_oidc_scopes() -> String {
    "openid profile email".to_string()
}

fn default_groups_claim() -> String {
    "groups".to_string()
}

fn default_true() -> bool {
    true
}

fn deserialize_locations<'de, D>(deserializer: D) -> Result<Vec<VaultLocation>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let locations = Vec::<VaultLocation>::deserialize(deserializer)?;
    validate_location_ids(&locations).map_err(serde::de::Error::custom)?;
    Ok(locations)
}

fn validate_location_ids(locations: &[VaultLocation]) -> Result<(), Error> {
    let mut ids = std::collections::HashSet::new();
    for location in locations {
        if !ids.insert(location.id()) {
            return Err(Error::Config(format!(
                "duplicate vault location id `{}`",
                location.id().as_str()
            )));
        }
    }
    Ok(())
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
    /// Where content-addressed media objects live. Local storage is the default.
    #[serde(default, skip_serializing_if = "MediaBackendConfig::is_local")]
    pub media: MediaBackendConfig,
    /// Note-root selection; omitted legacy entries keep automatic `notes/` discovery.
    #[serde(default, skip_serializing_if = "NotesLayout::is_auto")]
    pub notes_layout: NotesLayout,
    /// Opt-in service-identity folder filtering; content ACLs still apply separately.
    #[serde(default, skip_serializing_if = "is_false")]
    pub ignore_non_writable_folders: bool,
}
fn is_false(value: &bool) -> bool {
    !*value
}

/// Persisted note-root selection, independent of later filesystem layout changes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotesLayout {
    /// Legacy behavior: use `notes/` when it exists, otherwise the vault root.
    #[default]
    Auto,
    /// Use the exact registered root, including Markdown in its ordinary children.
    Root,
}

impl NotesLayout {
    fn is_auto(&self) -> bool {
        *self == Self::Auto
    }
}

/// A vault's media backend (`SPEC.md` §12.1).
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "backend", rename_all = "snake_case", deny_unknown_fields)]
pub enum MediaBackendConfig {
    /// Store objects below `<vault>/media`.
    #[default]
    Local,
    /// Store objects in an S3-compatible bucket while Markdown keeps vault-relative paths.
    S3 {
        bucket: String,
        region: String,
        #[serde(default)]
        endpoint: Option<String>,
        access_key_id: String,
        secret_access_key: String,
        #[serde(default)]
        allow_http: bool,
        #[serde(default)]
        virtual_hosted_style: bool,
    },
}

impl std::fmt::Debug for MediaBackendConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Local => formatter.write_str("Local"),
            Self::S3 {
                bucket,
                region,
                endpoint,
                allow_http,
                virtual_hosted_style,
                ..
            } => formatter
                .debug_struct("S3")
                .field("bucket", bucket)
                .field("region", region)
                .field("endpoint", endpoint)
                .field("access_key_id", &"[REDACTED]")
                .field("secret_access_key", &"[REDACTED]")
                .field("allow_http", allow_http)
                .field("virtual_hosted_style", virtual_hosted_style)
                .finish(),
        }
    }
}

impl MediaBackendConfig {
    fn is_local(&self) -> bool {
        matches!(self, Self::Local)
    }
}

impl ServerConfig {
    /// Parses `server.toml`.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Config`] for malformed TOML, an unknown key or invalid/duplicate
    /// location entries. Location validation is structural only, with no filesystem reads.
    /// `deny_unknown_fields`
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
    /// Fails if programmatic edits introduced duplicate location ids or TOML serialization fails.
    pub fn to_toml(&self) -> Result<String, Error> {
        validate_location_ids(&self.vault_locations)?;
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
            opened.push(
                Vault::open_with_layout(slug, name, root, entry.notes_layout)?
                    .with_media_backend(entry.media.clone())
                    .with_non_writable_folders_ignored(entry.ignore_non_writable_folders),
            );
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
