//! `access.toml` loading and saving (`SPEC.md` §6.2).
//!
//! The durable file is intentionally decoded at the I/O boundary and immediately turned
//! into `mb_core::Access`. Invalid or absent input never produces a permissive policy.

use std::collections::BTreeMap;
use std::path::Path;

use mb_core::{Access, GroupName, Member, NotePath, Role, Rule, Username};
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
        let mut members = Vec::new();
        let mut group_members = Vec::new();
        for member in raw.members {
            let role = Role::parse(&member.role).map_err(AccessError::Invalid)?;
            match principal(&member.user)? {
                Principal::User(user) => members.push(Member { user, role }),
                Principal::Group(group) => group_members.push((group, role)),
            }
        }
        let mut rules = Vec::new();
        let mut group_rules = Vec::new();
        for rule in raw.rules {
            let path = NotePath::parse(&rule.path).map_err(AccessError::Invalid)?;
            let mut grants = BTreeMap::new();
            let mut group_grants = BTreeMap::new();
            for (name, role) in rule.grant {
                let role = Role::parse(&role).map_err(AccessError::Invalid)?;
                match principal(&name)? {
                    Principal::User(user) => {
                        grants.insert(user, role);
                    }
                    Principal::Group(group) => {
                        group_grants.insert(group, role);
                    }
                }
            }
            // A rule may grant to users, groups or both; an empty one is still refused.
            if !grants.is_empty() || group_grants.is_empty() {
                rules.push(Rule {
                    path: path.clone(),
                    grants,
                });
            }
            if !group_grants.is_empty() {
                group_rules.push((path, group_grants));
            }
        }
        Access::new(members, rules)
            .and_then(|access| access.with_group_grants(group_members, group_rules))
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

/// Who an `access.toml` entry names: a user, or a provider group as `group:<name>` (§6.8.2).
enum Principal {
    User(Username),
    Group(GroupName),
}

const GROUP_PREFIX: &str = "group:";

fn principal(value: &str) -> Result<Principal, AccessError> {
    match value.strip_prefix(GROUP_PREFIX) {
        Some(group) => GroupName::parse(group)
            .map(Principal::Group)
            .map_err(AccessError::Invalid),
        None => Username::parse(value)
            .map(Principal::User)
            .map_err(AccessError::Invalid),
    }
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
        let members = access
            .members()
            .map(|(user, role)| RawMember {
                user: user.to_string(),
                role: role.as_str().to_string(),
            })
            .chain(access.group_members().map(|(group, role)| RawMember {
                user: format!("{GROUP_PREFIX}{group}"),
                role: role.as_str().to_string(),
            }))
            .collect();
        // why: group grants must survive a save — an invite accepted, a member added — or
        // writing the file back would silently revoke every group's access.
        let mut by_path: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
        let mut order: Vec<String> = Vec::new();
        for rule in access.rules() {
            let path = rule.path.to_string();
            if !by_path.contains_key(&path) {
                order.push(path.clone());
            }
            let grants = by_path.entry(path).or_default();
            for (user, role) in &rule.grants {
                grants.insert(user.to_string(), role.as_str().to_string());
            }
        }
        for (path, grants) in access.group_rules() {
            let path = path.to_string();
            if !by_path.contains_key(&path) {
                order.push(path.clone());
            }
            let entry = by_path.entry(path).or_default();
            for (group, role) in grants {
                entry.insert(format!("{GROUP_PREFIX}{group}"), role.as_str().to_string());
            }
        }
        let rules = order
            .into_iter()
            .map(|path| RawRule {
                grant: by_path.remove(&path).unwrap_or_default(),
                path,
            })
            .collect();
        Self { members, rules }
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
