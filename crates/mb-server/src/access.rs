//! `access.toml` loading and saving (`SPEC.md` §6.2).
//!
//! The durable file is intentionally decoded at the I/O boundary and immediately turned
//! into `mb_core::Access`. Invalid or absent input never produces a permissive policy.

use std::collections::BTreeMap;
use std::path::Path;

use mb_core::{Access, Member, NotePath, Role, Rule, Username};
use serde::{Deserialize, Serialize};

/// A parsed `access.toml` plus its canonical in-memory policy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessFile(Access);

impl AccessFile {
    /// Wraps a validated policy for service-layer updates.
    #[must_use]
    pub fn from_access(access: Access) -> Self {
        Self(access)
    }
    /// Parses an ACL file, rejecting unknown keys and ambiguous entries.
    pub fn parse(source: &str) -> Result<Self, AccessError> {
        let raw: RawAccess = toml::from_str(source).map_err(|error| AccessError::Malformed {
            message: error.to_string(),
        })?;
        let members = raw
            .members
            .into_iter()
            .map(|member| {
                Ok(Member {
                    user: username(&member.user)?,
                    role: Role::parse(&member.role).map_err(AccessError::Invalid)?,
                })
            })
            .collect::<Result<Vec<_>, AccessError>>()?;
        let rules = raw
            .rules
            .into_iter()
            .map(|rule| {
                let grants = rule
                    .grant
                    .into_iter()
                    .map(|(user, role)| {
                        Ok((
                            username(&user)?,
                            Role::parse(&role).map_err(AccessError::Invalid)?,
                        ))
                    })
                    .collect::<Result<BTreeMap<_, _>, AccessError>>()?;
                Ok(Rule {
                    path: NotePath::parse(&rule.path).map_err(AccessError::Invalid)?,
                    grants,
                })
            })
            .collect::<Result<Vec<_>, AccessError>>()?;
        Access::new(members, rules)
            .map(Self)
            .map_err(AccessError::Invalid)
    }

    /// Loads `<vault>/access.toml`; an absent file is an empty, deny-all policy.
    ///
    /// # Errors
    ///
    /// A malformed or unreadable existing file returns an error. Callers must retain a
    /// deny-all policy rather than serving notes under a partially understood ACL.
    pub fn load(vault_root: &Path) -> Result<Self, AccessError> {
        let path = vault_root.join("access.toml");
        match std::fs::read_to_string(&path) {
            Ok(source) => Self::parse(&source),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(Self(Access::default()))
            }
            Err(source) => Err(AccessError::Read { path, source }),
        }
    }

    /// Returns the validated policy used for every authorization decision.
    #[must_use]
    pub fn policy(&self) -> &Access {
        &self.0
    }

    /// Returns a stable TOML representation suitable for a durable ACL file.
    pub fn to_toml(&self) -> Result<String, AccessError> {
        let raw = RawAccess::from(&self.0);
        toml::to_string_pretty(&raw).map_err(|error| AccessError::Malformed {
            message: error.to_string(),
        })
    }

    /// Atomically saves the policy to `<vault>/access.toml`.
    ///
    /// The caller is responsible for authorization and audit logging; this is deliberately
    /// only persistence, so it stays usable by both CLI and HTTP administration paths.
    pub fn save(&self, vault_root: &Path) -> Result<(), AccessError> {
        let path = vault_root.join("access.toml");
        let temporary = vault_root.join(".access.toml.memberberry-tmp");
        std::fs::write(&temporary, self.to_toml()?).map_err(|source| AccessError::Write {
            path: temporary.clone(),
            source,
        })?;
        std::fs::rename(&temporary, &path).map_err(|source| AccessError::Write { path, source })
    }
}

fn username(value: &str) -> Result<Username, AccessError> {
    Username::parse(value).map_err(AccessError::Invalid)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawAccess {
    #[serde(default)]
    members: Vec<RawMember>,
    #[serde(default)]
    rules: Vec<RawRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawMember {
    user: String,
    role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRule {
    path: String,
    grant: BTreeMap<String, String>,
}

impl From<&Access> for RawAccess {
    fn from(access: &Access) -> Self {
        Self {
            members: access
                .members()
                .map(|(user, role)| RawMember {
                    user: user.to_string(),
                    role: role.as_str().to_string(),
                })
                .collect(),
            rules: access
                .rules()
                .map(|rule| RawRule {
                    path: rule.path.to_string(),
                    grant: rule
                        .grants
                        .iter()
                        .map(|(user, role)| (user.to_string(), role.as_str().to_string()))
                        .collect(),
                })
                .collect(),
        }
    }
}

/// Failure while loading or saving an ACL.
#[derive(Debug, thiserror::Error)]
pub enum AccessError {
    /// The TOML syntax or shape was invalid.
    #[error("malformed access.toml: {message}")]
    Malformed { message: String },
    /// A validated core ACL invariant was violated.
    #[error("invalid access.toml: {0}")]
    Invalid(mb_core::AclError),
    /// The file could not be read.
    #[error("reading {path}: {source}")]
    Read {
        path: std::path::PathBuf,
        source: std::io::Error,
    },
    /// The file could not be written atomically.
    #[error("writing {path}: {source}")]
    Write {
        path: std::path::PathBuf,
        source: std::io::Error,
    },
}
