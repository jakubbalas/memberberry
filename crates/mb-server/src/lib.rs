//! # mb-server
//!
//! HTTP for Memberberry (`SPEC.md` §5.3). M0's slice of it: read `server.toml`, open the
//! registered vaults, and serve their notes read-only.
//!
//! Every content route is authenticated and permission-filtered. A vault boundary and a
//! slug type ensure untrusted route input cannot reach arbitrary filesystem paths.

pub mod access;
pub mod audit;
pub mod bookmarks;
pub mod compress;
pub mod config;
pub mod http;
pub mod indexing;
pub mod invites;
pub mod rename;
pub mod repository;
pub mod sync;
pub mod titles;
pub mod vault;
pub mod watch;
pub mod workspace;

use std::path::PathBuf;

pub use access::AccessFile;
pub use config::ServerConfig;
pub use vault::{Slug, Vault};

/// Everything that can go wrong starting or serving.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("server.toml: {0}")]
    Config(String),

    #[error("reading {path}: {source}")]
    ReadConfig {
        path: PathBuf,
        source: std::io::Error,
    },

    #[error("reading directory {path}: {source}")]
    ReadDir {
        path: PathBuf,
        source: std::io::Error,
    },

    #[error("vault slug `{0}` is not usable in a URL: use lowercase letters, digits and hyphens")]
    InvalidSlug(String),

    #[error("vault slug `{0}` is registered twice")]
    DuplicateSlug(String),

    #[error("vault `{slug}`: cannot open {path}: {source}")]
    VaultRoot {
        slug: String,
        path: PathBuf,
        source: std::io::Error,
    },

    #[error("vault `{slug}`: {path} is not a directory")]
    VaultRootNotADirectory { slug: String, path: PathBuf },

    /// Also returned for a traversal attempt, on purpose: a distinct "forbidden" would
    /// confirm the path exists, and §6.5 says a note you cannot read does not exist for you.
    #[error("not found")]
    NotFound,

    #[error("access control: {0}")]
    Access(String),

    #[error("authentication: {0}")]
    Auth(String),

    #[error("binding {addr}: {source}")]
    Bind {
        addr: std::net::SocketAddr,
        source: std::io::Error,
    },

    #[error("serving: {0}")]
    Serve(std::io::Error),
}
