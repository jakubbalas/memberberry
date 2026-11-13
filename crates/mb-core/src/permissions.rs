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

/// A group from the user's identity provider, named in `access.toml` as `group:<name>`
/// (`SPEC.md` §6.8.2, M20b). Compared exactly, case included: it is the provider's name.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct GroupName(String);

impl GroupName {
    /// Validates a provider group name: 1–128 characters, no control characters, no
    /// surrounding whitespace.
    pub fn parse(value: &str) -> Result<Self, AclError> {
        let valid = !value.is_empty()
            && value.chars().count() <= 128
            && value.trim() == value
            && !value.chars().any(char::is_control);
        if valid {
            Ok(Self(value.to_string()))
        } else {
            Err(AclError::InvalidGroup(value.to_string()))
        }
    }

    /// The provider's spelling.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for GroupName {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Combines grants that apply at one level: an explicit `none` among them is final, and
/// otherwise the most capable wins. `None` when nothing applies at this level.
fn combine(grants: impl IntoIterator<Item = Role>) -> Option<Role> {
    let mut combined: Option<Role> = None;
    for grant in grants {
        if grant == Role::None {
            return Some(Role::None);
        }
        combined = Some(combined.map_or(grant, |current| current.min(grant)));
    }
    combined
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
    /// Vault-wide grants to provider groups (M20b).
    group_members: BTreeMap<GroupName, Role>,
    /// Path grants to provider groups, beside `rules`' grants to users.
    group_rules: BTreeMap<NotePath, BTreeMap<GroupName, Role>>,
    /// Each user's groups from their latest provider sign-in. Supplied by the server, never
    /// by `access.toml`; empty means groups grant nobody anything.
    user_groups: BTreeMap<Username, BTreeSet<GroupName>>,
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
            ..Self::default()
        })
    }

    /// Adds grants to provider groups, vault-wide and per path (M20b).
    ///
    /// # Errors
    ///
    /// A group listed twice as a member, a path given two group rules, or an empty one.
    pub fn with_group_grants(
        mut self,
        members: Vec<(GroupName, Role)>,
        rules: Vec<(NotePath, BTreeMap<GroupName, Role>)>,
    ) -> Result<Self, AclError> {
        for (group, role) in members {
            if self.group_members.insert(group.clone(), role).is_some() {
                return Err(AclError::DuplicateMember(format!("group:{group}")));
            }
        }
        for (path, grants) in rules {
            if grants.is_empty() {
                return Err(AclError::EmptyRule(path.to_string()));
            }
            if self.group_rules.insert(path.clone(), grants).is_some() {
                return Err(AclError::DuplicateRule(path.to_string()));
            }
        }
        Ok(self)
    }

    /// This policy with each user's current provider groups attached.
    #[must_use]
    pub fn with_user_groups(&self, groups: &BTreeMap<Username, BTreeSet<GroupName>>) -> Self {
        let mut access = self.clone();
        access.user_groups.clone_from(groups);
        access
    }

    /// Whether any grant names a group, so groups can change what someone may do.
    #[must_use]
    pub fn has_group_grants(&self) -> bool {
        !self.group_members.is_empty() || !self.group_rules.is_empty()
    }

    /// Iterates the vault-wide group grants in name order.
    pub fn group_members(&self) -> impl Iterator<Item = (&GroupName, Role)> {
        self.group_members
            .iter()
            .map(|(group, role)| (group, *role))
    }

    /// Iterates the per-path group grants in path order.
    pub fn group_rules(&self) -> impl Iterator<Item = (&NotePath, &BTreeMap<GroupName, Role>)> {
        self.group_rules.iter()
    }

    fn groups_of(&self, user: &Username) -> impl Iterator<Item = &GroupName> {
        self.user_groups.get(user).into_iter().flatten()
    }

    /// The user's vault-wide role: their own membership and their groups', before any path
    /// rule (`SPEC.md` §6.3, §6.8.2).
    #[must_use]
    pub fn vault_role(&self, user: &Username) -> Role {
        let own = self.members.get(user).copied();
        let groups = self
            .groups_of(user)
            .filter_map(|group| self.group_members.get(group).copied());
        combine(own.into_iter().chain(groups)).unwrap_or(Role::None)
    }

    /// Every path a rule names, for users or for groups.
    #[must_use]
    pub fn rule_paths(&self) -> BTreeSet<NotePath> {
        self.rules
            .iter()
            .map(|rule| rule.path.clone())
            .chain(self.group_rules.keys().cloned())
            .collect()
    }

    /// Everyone this policy can grant anything to: members, users named in rules, and users
    /// whose groups are named anywhere.
    #[must_use]
    pub fn principals(&self) -> BTreeSet<Username> {
        let named: BTreeSet<&GroupName> = self
            .group_members
            .keys()
            .chain(self.group_rules.values().flat_map(BTreeMap::keys))
            .collect();
        self.members
            .keys()
            .cloned()
            .chain(
                self.rules
                    .iter()
                    .flat_map(|rule| rule.grants.keys().cloned()),
            )
            .chain(
                self.user_groups
                    .iter()
                    .filter(|(_, groups)| groups.iter().any(|group| named.contains(group)))
                    .map(|(user, _)| user.clone()),
            )
            .collect()
    }

    /// Resolves a user's role for one note path.
    ///
    /// More-specific matching rules override less-specific grants. An explicit `none`
    /// anywhere on the matching path is final, so an inherited denial cannot accidentally
    /// be reopened by a later rule.
    ///
    /// A grant to one of the user's provider groups counts exactly like a grant to the user
    /// (§6.8.2): at one level the most capable applies, and an explicit `none` is final.
    #[must_use]
    pub fn effective_role(&self, user: &Username, note: &NotePath) -> Role {
        let mut role = self.vault_role(user);
        let mut most_specific = 0;
        let group_grant = |path: &NotePath| {
            let grants = self.group_rules.get(path);
            self.groups_of(user)
                .filter_map(move |group| grants.and_then(|grants| grants.get(group)).copied())
        };
        let user_rules = self
            .rules
            .iter()
            .map(|rule| (&rule.path, rule.grants.get(user).copied()));
        let group_only = self
            .group_rules
            .keys()
            .filter(|path| !self.rules.iter().any(|rule| &rule.path == *path))
            .map(|path| (path, None));
        for (path, own) in user_rules.chain(group_only) {
            let Some(grant) = combine(own.into_iter().chain(group_grant(path))) else {
                continue;
            };
            if !path.matches(note) {
                continue;
            }
            if grant == Role::None {
                return Role::None;
            }
            let specificity = path.specificity();
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
    /// The group reference is not a valid provider group name.
    InvalidGroup(String),
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
            Self::InvalidGroup(value) => write!(formatter, "invalid group name `{value}`"),
            Self::InvalidPath(value) => write!(formatter, "invalid ACL path `{value}`"),
            Self::DuplicateMember(value) => write!(formatter, "duplicate member `{value}`"),
            Self::DuplicateRule(value) => write!(formatter, "duplicate ACL rule `{value}`"),
            Self::EmptyRule(value) => write!(formatter, "ACL rule `{value}` has no grants"),
        }
    }
}

impl std::error::Error for AclError {}
