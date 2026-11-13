//! Accounts for people who sign in through an OpenID Connect provider (`SPEC.md` §6.8.2,
//! E38).
//!
//! The identity is the pair (`issuer`, `subject`), stored as a link on an account. The first
//! time a person arrives, they are matched to an existing account only by an email the
//! provider says is verified and that exactly one account carries; otherwise a new account is
//! made for them, with no password anyone knows, no vault access and no administration.

use rand_core::RngCore;
use rusqlite::{OptionalExtension, TransactionBehavior, params};

use super::{AuthDb, Error, NewUser, User, UserId, insert_user, now_seconds, user_by_id_in};

/// What the provider said about the person, after the server validated the ID token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OidcIdentity<'a> {
    /// The provider's `iss`, exactly as configured.
    pub issuer: &'a str,
    /// The provider's stable `sub` for this person.
    pub subject: &'a str,
    /// `email`, if the token carried one.
    pub email: Option<&'a str>,
    /// `email_verified`. An unverified email links nothing (E38).
    pub email_verified: bool,
    /// `preferred_username`, the basis of a new account's username.
    pub preferred_username: Option<&'a str>,
    /// `name`, a new account's display name.
    pub name: Option<&'a str>,
}

/// How a provider sign-in found its account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OidcAccount {
    /// Already linked to this provider identity.
    Returning(User),
    /// An existing account, linked now by a verified email.
    Linked(User),
    /// A new account made for this person.
    Created(User),
}

impl OidcAccount {
    /// The account, however it was found.
    #[must_use]
    pub fn user(&self) -> &User {
        match self {
            Self::Returning(user) | Self::Linked(user) | Self::Created(user) => user,
        }
    }
}

impl AuthDb {
    pub(crate) fn migrate_oidc(&self) -> Result<(), Error> {
        self.connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS oidc_links (
                    issuer TEXT NOT NULL,
                    subject TEXT NOT NULL,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY (issuer, subject)
                 );
                 CREATE TABLE IF NOT EXISTS user_groups (
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    group_name TEXT NOT NULL,
                    PRIMARY KEY (user_id, group_name)
                 );",
            )
            .map_err(Error::Database)?;
        let has_email = self
            .connection
            .prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'email'")
            .and_then(|mut statement| statement.exists([]))
            .map_err(Error::Database)?;
        if !has_email {
            self.connection
                .execute_batch("ALTER TABLE users ADD COLUMN email TEXT;")
                .map_err(Error::Database)?;
        }
        Ok(())
    }

    /// Sets or clears an account's email, the one a provider's verified email links to.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidEmail`] for something that is not plausibly an address.
    pub fn set_email(&self, user_id: UserId, email: Option<&str>) -> Result<(), Error> {
        let email = email.map(str::trim).filter(|email| !email.is_empty());
        if let Some(email) = email
            && !valid_email(email)
        {
            return Err(Error::InvalidEmail);
        }
        self.connection
            .execute(
                "UPDATE users SET email = ?1 WHERE id = ?2",
                params![email, user_id.get()],
            )
            .map_err(Error::Database)?;
        Ok(())
    }

    /// An account's email, if it has one.
    ///
    /// # Errors
    ///
    /// Fails if the database cannot be read.
    pub fn email_of(&self, user_id: UserId) -> Result<Option<String>, Error> {
        self.connection
            .query_row(
                "SELECT email FROM users WHERE id = ?1",
                [user_id.get()],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map(Option::flatten)
            .map_err(Error::Database)
    }

    /// Finds, links or creates the account for a provider sign-in (E38).
    ///
    /// Never makes an administrator. The caller still refuses a disabled account.
    ///
    /// # Errors
    ///
    /// Fails if the database cannot be read or written, or no username could be made.
    pub fn sign_in_oidc(&mut self, identity: &OidcIdentity<'_>) -> Result<OidcAccount, Error> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(Error::Database)?;
        let linked: Option<i64> = transaction
            .query_row(
                "SELECT user_id FROM oidc_links WHERE issuer = ?1 AND subject = ?2",
                params![identity.issuer, identity.subject],
                |row| row.get(0),
            )
            .optional()
            .map_err(Error::Database)?;
        if let Some(id) = linked {
            let user = user_by_id_in(&transaction, UserId(id))?.ok_or(Error::UnknownUser)?;
            transaction.commit().map_err(Error::Database)?;
            return Ok(OidcAccount::Returning(user));
        }
        let by_email = match identity.email.filter(|_| identity.email_verified) {
            Some(email) => {
                let mut statement = transaction
                    .prepare(
                        "SELECT id FROM users WHERE email IS NOT NULL AND lower(email) = lower(?1)",
                    )
                    .map_err(Error::Database)?;
                let ids: Vec<i64> = statement
                    .query_map([email.trim()], |row| row.get(0))
                    .map_err(Error::Database)?
                    .collect::<Result<_, _>>()
                    .map_err(Error::Database)?;
                // Exactly one: two accounts sharing an email say nothing about which is theirs.
                match ids.as_slice() {
                    [id] => Some(*id),
                    _ => None,
                }
            }
            None => None,
        };
        let account = if let Some(id) = by_email {
            let user = user_by_id_in(&transaction, UserId(id))?.ok_or(Error::UnknownUser)?;
            OidcAccount::Linked(user)
        } else {
            let username = free_username(&transaction, &username_base(identity))?;
            let display = identity
                .name
                .map(str::trim)
                .filter(|name| !name.is_empty() && name.len() <= 128 && !name.contains('\0'))
                .unwrap_or(&username)
                .to_string();
            let user = insert_user(
                &transaction,
                NewUser {
                    username: &username,
                    display_name: &display,
                    password: &unknown_password(),
                },
                false,
            )?;
            if identity.email_verified
                && let Some(email) = identity.email.map(str::trim).filter(|e| valid_email(e))
            {
                transaction
                    .execute(
                        "UPDATE users SET email = ?1 WHERE id = ?2",
                        params![email, user.id.get()],
                    )
                    .map_err(Error::Database)?;
            }
            OidcAccount::Created(user)
        };
        transaction
            .execute(
                "INSERT INTO oidc_links (issuer, subject, user_id, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![
                    identity.issuer,
                    identity.subject,
                    account.user().id.get(),
                    now_seconds()?
                ],
            )
            .map_err(Error::Database)?;
        transaction.commit().map_err(Error::Database)?;
        Ok(account)
    }
}

impl AuthDb {
    /// Replaces an account's provider groups with those of its latest sign-in (M20b).
    ///
    /// # Errors
    ///
    /// Fails if the database cannot be written.
    pub fn set_groups(&mut self, user_id: UserId, groups: &[String]) -> Result<(), Error> {
        let transaction = self.connection.transaction().map_err(Error::Database)?;
        transaction
            .execute(
                "DELETE FROM user_groups WHERE user_id = ?1",
                [user_id.get()],
            )
            .map_err(Error::Database)?;
        for group in groups {
            transaction
                .execute(
                    "INSERT OR IGNORE INTO user_groups (user_id, group_name) VALUES (?1, ?2)",
                    params![user_id.get(), group],
                )
                .map_err(Error::Database)?;
        }
        transaction.commit().map_err(Error::Database)
    }

    /// Every enabled account's provider groups, by username.
    ///
    /// # Errors
    ///
    /// Fails if the database cannot be read.
    pub fn all_groups(
        &self,
    ) -> Result<std::collections::BTreeMap<String, std::collections::BTreeSet<String>>, Error> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT u.username, g.group_name FROM user_groups g JOIN users u ON u.id = g.user_id \
                 WHERE u.disabled = 0",
            )
            .map_err(Error::Database)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(Error::Database)?;
        let mut groups: std::collections::BTreeMap<String, std::collections::BTreeSet<String>> =
            std::collections::BTreeMap::new();
        for row in rows {
            let (user, group) = row.map_err(Error::Database)?;
            groups.entry(user).or_default().insert(group);
        }
        Ok(groups)
    }
}

/// A password nobody knows: the account signs in through its provider only.
fn unknown_password() -> String {
    let mut bytes = [0_u8; 32];
    rand_core::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn valid_email(email: &str) -> bool {
    email.len() <= 254
        && !email.chars().any(|c| c.is_control() || c.is_whitespace())
        && email
            .split_once('@')
            .is_some_and(|(local, domain)| !local.is_empty() && domain.contains('.'))
}

/// `Jo.Smith` → `jo-smith`; the email's local part when there is no preferred username.
fn username_base(identity: &OidcIdentity<'_>) -> String {
    let source = identity
        .preferred_username
        .or_else(|| identity.email.and_then(|email| email.split('@').next()))
        .unwrap_or("user");
    let mut out = String::new();
    for c in source.chars().flat_map(char::to_lowercase) {
        match c {
            'a'..='z' | '0'..='9' | '_' | '-' => out.push(c),
            '.' | ' ' => out.push('-'),
            _ => {}
        }
    }
    let trimmed: String = out.trim_matches('-').chars().take(56).collect();
    if trimmed.is_empty() {
        "user".to_string()
    } else {
        trimmed
    }
}

fn free_username(connection: &rusqlite::Connection, base: &str) -> Result<String, Error> {
    for n in 1..1000 {
        let candidate = if n == 1 {
            base.to_string()
        } else {
            format!("{base}-{n}")
        };
        let taken = connection
            .prepare("SELECT 1 FROM users WHERE username = ?1")
            .and_then(|mut statement| statement.exists([&candidate]))
            .map_err(Error::Database)?;
        if !taken {
            return Ok(candidate);
        }
    }
    Err(Error::DuplicateUsername)
}

#[cfg(test)]
mod tests {
    use super::{OidcIdentity, username_base, valid_email};

    fn identity<'a>(preferred: Option<&'a str>, email: Option<&'a str>) -> OidcIdentity<'a> {
        OidcIdentity {
            issuer: "https://id.example",
            subject: "1",
            email,
            email_verified: true,
            preferred_username: preferred,
            name: None,
        }
    }

    #[test]
    fn a_preferred_username_is_reduced_to_what_a_username_allows() {
        assert_eq!(
            username_base(&identity(Some("Jo.Smith (home)"), None)),
            "jo-smith-home"
        );
    }

    #[test]
    fn without_a_preferred_username_the_email_local_part_is_used() {
        assert_eq!(
            username_base(&identity(None, Some("anna@example.com"))),
            "anna"
        );
    }

    #[test]
    fn nothing_usable_becomes_user() {
        assert_eq!(username_base(&identity(Some("日本"), None)), "user");
    }

    #[test]
    fn an_address_needs_a_local_part_and_a_dotted_domain() {
        assert!(valid_email("a@b.co") && !valid_email("a@b") && !valid_email("@b.co"));
    }
}
