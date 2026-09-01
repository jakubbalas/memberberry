//! Pure vault ACL resolution (`SPEC.md` §6.2 and §6.3).
//!
//! Parsing TOML belongs at the server boundary. This module deliberately only accepts
//! validated values so all callers resolve permissions through the same deterministic,
//! I/O-free algorithm.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use unicode_normalization::UnicodeNormalization;

/// A vault role, ordered from most capable to no access.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Role {
    /// May manage access and delete the vault.
    Owner,
    /// May read, create, update, and delete notes.
    Editor,
    /// May read notes only.
    Viewer,
    /// Has no access and must not learn that a note exists.
    None,
}

impl Role {
    /// Parses the stable lowercase role spelling used in `access.toml`.
    pub fn parse(value: &str) -> Result<Self, AclError> {
        match value {
            "owner" => Ok(Self::Owner),
            "editor" => Ok(Self::Editor),
            "viewer" => Ok(Self::Viewer),
            "none" => Ok(Self::None),
            _ => Err(AclError::InvalidRole(value.to_string())),
        }
    }

    /// Returns the stable lowercase role spelling used in `access.toml`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Editor => "editor",
            Self::Viewer => "viewer",
            Self::None => "none",
        }
    }
}

/// A validated user reference used by an ACL.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Username(String);

impl Username {
    /// Parses a username reference.
    ///
    /// Usernames are kept deliberately narrow because they are durable references in
    /// hand-edited `access.toml` files, not display text.
    pub fn parse(value: &str) -> Result<Self, AclError> {
        let valid = !value.is_empty()
            && value.len() <= 64
            && value.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
            });
        if valid {
            Ok(Self(value.to_string()))
        } else {
            Err(AclError::InvalidUsername(value.to_string()))
        }
    }

    /// Returns the durable username reference.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Username {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// A normalized note or folder path relative to a vault's notes root.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct NotePath(String);

impl NotePath {
    /// Parses a relative, slash-separated ACL path.
    pub fn parse(value: &str) -> Result<Self, AclError> {
        let normalized: String = value.nfc().collect();
        let valid = !normalized.is_empty()
            && !normalized.starts_with('/')
            && !normalized.ends_with('/')
            && !normalized.contains('\\')
            && !normalized.contains('\0')
            && normalized
                .split('/')
                .all(|segment| !segment.is_empty() && segment != "." && segment != "..");
        if valid {
            Ok(Self(normalized))
        } else {
            Err(AclError::InvalidPath(value.to_string()))
        }
    }

    /// Returns the normalized path.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn matches(&self, note: &Self) -> bool {
        note.0 == self.0
            || note
                .0
                .strip_prefix(&self.0)
                .is_some_and(|remainder| remainder.starts_with('/'))
    }

    fn specificity(&self) -> usize {
        self.0.split('/').count()
    }
}

impl fmt::Display for NotePath {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// A vault-wide membership assignment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    /// The referenced authenticated user.
    pub user: Username,
    /// The role before path-specific rules are applied.
    pub role: Role,
}

/// One folder or note-specific ACL rule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    /// The folder or note to which the grants apply.
    pub path: NotePath,
    /// Per-user grants at this path.
    pub grants: BTreeMap<Username, Role>,
}

/// A validated vault access policy.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Access {
    members: BTreeMap<Username, Role>,
    rules: Vec<Rule>,
}

impl Access {
    /// Builds an ACL, rejecting duplicate member and rule paths.
    pub fn new(members: Vec<Member>, rules: Vec<Rule>) -> Result<Self, AclError> {
        let mut member_roles = BTreeMap::new();
        for member in members {
            if member_roles
                .insert(member.user.clone(), member.role)
                .is_some()
            {
                return Err(AclError::DuplicateMember(member.user.to_string()));
            }
        }

        let mut paths = BTreeSet::new();
        for rule in &rules {
            if rule.grants.is_empty() {
                return Err(AclError::EmptyRule(rule.path.to_string()));
            }
            if !paths.insert(rule.path.clone()) {
                return Err(AclError::DuplicateRule(rule.path.to_string()));
            }
        }
        Ok(Self {
            members: member_roles,
            rules,
        })
    }

    /// Resolves a user's role for one note path.
    ///
    /// More-specific matching rules override less-specific grants. An explicit `none`
    /// anywhere on the matching path is final, so an inherited denial cannot accidentally
    /// be reopened by a later rule.
    #[must_use]
    pub fn effective_role(&self, user: &Username, note: &NotePath) -> Role {
        let mut role = self.members.get(user).copied().unwrap_or(Role::None);
        let mut most_specific = 0;
        for rule in &self.rules {
            let Some(grant) = rule.grants.get(user).copied() else {
                continue;
            };
            if !rule.path.matches(note) {
                continue;
            }
            if grant == Role::None {
                return Role::None;
            }
            let specificity = rule.path.specificity();
            if specificity > most_specific {
                role = grant;
                most_specific = specificity;
            }
        }
        role
    }

    /// Iterates the vault-wide member assignments in username order.
    pub fn members(&self) -> impl Iterator<Item = (&Username, Role)> {
        self.members.iter().map(|(user, role)| (user, *role))
    }

    /// Iterates validated path rules in their source order.
    pub fn rules(&self) -> impl Iterator<Item = &Rule> {
        self.rules.iter()
    }
}

/// An error constructing a validated ACL value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AclError {
    /// The role spelling is not one of the four supported ACL roles.
    InvalidRole(String),
    /// The user reference is not a valid durable username.
    InvalidUsername(String),
    /// The rule path could escape or ambiguously match a vault path.
    InvalidPath(String),
    /// A user appears in the vault-wide members list more than once.
    DuplicateMember(String),
    /// Two rules target the same normalized path.
    DuplicateRule(String),
    /// A rule without grants is almost certainly a hand-editing mistake.
    EmptyRule(String),
}

impl fmt::Display for AclError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRole(value) => write!(formatter, "invalid role `{value}`"),
            Self::InvalidUsername(value) => write!(formatter, "invalid username `{value}`"),
            Self::InvalidPath(value) => write!(formatter, "invalid ACL path `{value}`"),
            Self::DuplicateMember(value) => write!(formatter, "duplicate member `{value}`"),
            Self::DuplicateRule(value) => write!(formatter, "duplicate ACL rule `{value}`"),
            Self::EmptyRule(value) => write!(formatter, "ACL rule `{value}` has no grants"),
        }
    }
}

impl std::error::Error for AclError {}
