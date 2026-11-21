//! Stored settings and credentials for Memberberry’s dedicated MCP listener.

use std::collections::BTreeSet;

use rusqlite::{OptionalExtension, TransactionBehavior, params};

use super::{AuthDb, Error, UserId, digest, now_seconds, random_secret};

const PREFIX: &str = "mbm_";

/// A bearer credential used exclusively by the MCP listener.
pub struct Token(String);

impl Token {
    #[must_use]
    pub fn parse(secret: &str) -> Option<Self> {
        let body = secret.strip_prefix(PREFIX)?;
        (body.len() == 64 && body.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .then(|| Self(secret.to_owned()))
    }

    /// The only plaintext copy issued by the server.
    #[must_use]
    pub fn expose_secret(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Token {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Token(<redacted>)")
    }
}

/// Committed service toggle and concurrency revision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Settings {
    pub enabled: bool,
    pub revision: i64,
}

/// Outcome of replacing a token’s assigned vaults.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenUpdate {
    Updated,
    NotFound,
    Conflict,
}

/// Metadata safe to show to the issuing account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
    pub revoked_at: Option<i64>,
    pub vaults: BTreeSet<String>,
}

/// Live token identity and assigned vault registration keys.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Principal {
    pub id: String,
    pub username: String,
    pub vaults: BTreeSet<String>,
    pub last_used_at: Option<i64>,
}

impl AuthDb {
    pub(super) fn migrate_mcp(&self) -> Result<(), Error> {
        self.connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS mcp_settings (
                     singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                     enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
                     revision INTEGER NOT NULL
                 );
                 INSERT OR IGNORE INTO mcp_settings VALUES (1, 0, 0);
                 DROP TABLE IF EXISTS mcp_vaults;
                 CREATE TABLE IF NOT EXISTS mcp_tokens (
                     id TEXT PRIMARY KEY,
                     token_hash TEXT NOT NULL UNIQUE,
                     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                     name TEXT NOT NULL,
                     follows INTEGER NOT NULL DEFAULT 0 CHECK (follows IN (0, 1)),
                     created_at INTEGER NOT NULL,
                     last_used_at INTEGER,
                     revoked_at INTEGER
                 );
                 CREATE TABLE IF NOT EXISTS mcp_token_vaults (
                     token_id TEXT NOT NULL REFERENCES mcp_tokens(id) ON DELETE CASCADE,
                     registration TEXT NOT NULL,
                     PRIMARY KEY (token_id, registration)
                 );",
            )
            .map_err(Error::Database)
    }

    /// Reads the committed service toggle and revision together.
    ///
    /// # Errors
    /// Returns a database read error.
    pub fn mcp_settings(&self) -> Result<Settings, Error> {
        self.connection
            .query_row(
                "SELECT enabled, revision FROM mcp_settings WHERE singleton = 1",
                [],
                |row| {
                    Ok(Settings {
                        enabled: row.get(0)?,
                        revision: row.get(1)?,
                    })
                },
            )
            .map_err(Error::Database)
    }

    /// Commits the MCP service toggle. Returns `false` if the browser used a stale revision.
    ///
    /// # Errors
    /// Returns a database write error. The toggle and revision roll back together.
    pub fn set_mcp_enabled(&mut self, revision: i64, enabled: bool) -> Result<bool, Error> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(Error::Database)?;
        let updated = transaction
            .execute(
                "UPDATE mcp_settings SET enabled = ?1, revision = revision + 1
                 WHERE singleton = 1 AND revision = ?2",
                params![enabled, revision],
            )
            .map_err(Error::Database)?;
        if updated == 0 {
            return Ok(false);
        }
        transaction.commit().map_err(Error::Database)?;
        Ok(true)
    }

    /// Removes stale vault grants before a new MCP listener accepts calls.
    ///
    /// # Errors
    /// Returns a database write error.
    pub fn retire_mcp_registrations(&mut self, current: &BTreeSet<String>) -> Result<(), Error> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(Error::Database)?;
        let stored = {
            let mut statement = transaction
                .prepare("SELECT DISTINCT registration FROM mcp_token_vaults")
                .map_err(Error::Database)?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(Error::Database)?;
            rows.collect::<Result<BTreeSet<_>, _>>()
                .map_err(Error::Database)?
        };
        let mut retired = stored.difference(current).peekable();
        if retired.peek().is_some() {
            transaction
                .execute(
                    "UPDATE mcp_settings SET revision = revision + 1 WHERE singleton = 1",
                    [],
                )
                .map_err(Error::Database)?;
        }
        for key in retired {
            transaction
                .execute(
                    "DELETE FROM mcp_token_vaults WHERE registration = ?1",
                    [key],
                )
                .map_err(Error::Database)?;
        }
        transaction.commit().map_err(Error::Database)
    }

    /// Creates a token assigned to one or more vaults, returning a secret shown only once.
    ///
    /// # Errors
    /// Returns [`Error::EmptyMcpVaults`] if no vaults were supplied, or a clock/database error.
    pub fn create_mcp_token(
        &mut self,
        user: UserId,
        name: &str,
        vaults: &BTreeSet<String>,
    ) -> Result<(String, Token), Error> {
        if vaults.is_empty() {
            return Err(Error::EmptyMcpVaults);
        }
        let id = random_secret();
        let token = Token(format!("{PREFIX}{}", random_secret()));
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(Error::Database)?;
        transaction
            .execute(
                "INSERT INTO mcp_tokens (id, token_hash, user_id, name, follows, created_at)
                 VALUES (?1, ?2, ?3, ?4, 0, ?5)",
                params![
                    id,
                    digest(token.expose_secret()),
                    user.get(),
                    name,
                    now_seconds()?
                ],
            )
            .map_err(Error::Database)?;
        for registration in vaults {
            transaction
                .execute(
                    "INSERT INTO mcp_token_vaults (token_id, registration) VALUES (?1, ?2)",
                    params![id, registration],
                )
                .map_err(Error::Database)?;
        }
        transaction.commit().map_err(Error::Database)?;
        Ok((id, token))
    }

    /// Replaces the vaults assigned to an active token owned by `user`.
    ///
    /// Returns [`TokenUpdate::NotFound`] if the token does not exist for `user`, and
    /// [`TokenUpdate::Conflict`] if the token was revoked or the expected revision is stale.
    ///
    /// # Errors
    /// Returns [`Error::EmptyMcpVaults`] if no vaults were supplied, or a database error.
    pub fn update_mcp_token_vaults(
        &mut self,
        user: UserId,
        id: &str,
        revision: i64,
        vaults: &BTreeSet<String>,
    ) -> Result<TokenUpdate, Error> {
        if vaults.is_empty() {
            return Err(Error::EmptyMcpVaults);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(Error::Database)?;
        let revoked: Option<Option<i64>> = transaction
            .query_row(
                "SELECT revoked_at FROM mcp_tokens WHERE id = ?1 AND user_id = ?2",
                params![id, user.get()],
                |row| row.get(0),
            )
            .optional()
            .map_err(Error::Database)?;
        match revoked {
            None => return Ok(TokenUpdate::NotFound),
            Some(Some(_)) => return Ok(TokenUpdate::Conflict),
            Some(None) => {}
        }
        let updated = transaction
            .execute(
                "UPDATE mcp_settings SET revision = revision + 1
                 WHERE singleton = 1 AND revision = ?1",
                [revision],
            )
            .map_err(Error::Database)?;
        if updated == 0 {
            return Ok(TokenUpdate::Conflict);
        }
        transaction
            .execute(
                "UPDATE mcp_tokens SET follows = 0 WHERE id = ?1 AND user_id = ?2",
                params![id, user.get()],
            )
            .map_err(Error::Database)?;
        transaction
            .execute("DELETE FROM mcp_token_vaults WHERE token_id = ?1", [id])
            .map_err(Error::Database)?;
        for registration in vaults {
            transaction
                .execute(
                    "INSERT INTO mcp_token_vaults (token_id, registration) VALUES (?1, ?2)",
                    params![id, registration],
                )
                .map_err(Error::Database)?;
        }
        transaction.commit().map_err(Error::Database)?;
        Ok(TokenUpdate::Updated)
    }

    fn mcp_token_vaults(&self, id: &str) -> Result<BTreeSet<String>, Error> {
        let mut statement = self
            .connection
            .prepare("SELECT registration FROM mcp_token_vaults WHERE token_id = ?1")
            .map_err(Error::Database)?;
        let rows = statement
            .query_map([id], |row| row.get(0))
            .map_err(Error::Database)?;
        rows.collect::<Result<_, _>>().map_err(Error::Database)
    }

    /// Lists metadata for the issuing user.
    ///
    /// # Errors
    /// Returns a database read error.
    pub fn list_mcp_tokens(&self, user: UserId) -> Result<Vec<Record>, Error> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT id, name, created_at, last_used_at, revoked_at
                 FROM mcp_tokens
                 WHERE user_id = ?1
                 ORDER BY revoked_at IS NULL DESC, created_at DESC, id",
            )
            .map_err(Error::Database)?;
        let rows = statement
            .query_map([user.get()], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })
            .map_err(Error::Database)?;
        rows.map(|row| {
            let (id, name, created_at, last_used_at, revoked_at) = row.map_err(Error::Database)?;
            let vaults = self.mcp_token_vaults(&id)?;
            Ok(Record {
                id,
                name,
                created_at,
                last_used_at,
                revoked_at,
                vaults,
            })
        })
        .collect()
    }

    /// Revokes a token owned by the authenticated user. Repeated calls are harmless.
    ///
    /// # Errors
    /// Returns a clock or database write error.
    pub fn revoke_mcp_token(&mut self, user: UserId, id: &str) -> Result<(), Error> {
        let now = now_seconds()?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(Error::Database)?;
        let updated = transaction
            .execute(
                "UPDATE mcp_tokens SET revoked_at = ?1
                 WHERE id = ?2 AND user_id = ?3 AND revoked_at IS NULL",
                params![now, id, user.get()],
            )
            .map_err(Error::Database)?;
        if updated > 0 {
            transaction
                .execute(
                    "UPDATE mcp_settings SET revision = revision + 1 WHERE singleton = 1",
                    [],
                )
                .map_err(Error::Database)?;
        }
        transaction.commit().map_err(Error::Database)
    }

    /// Checks the digest, revocation and current issuing account.
    ///
    /// # Errors
    /// Returns a database read error.
    pub fn authenticate_mcp_token(&self, token: &Token) -> Result<Option<Principal>, Error> {
        let row = self
            .connection
            .query_row(
                "SELECT t.id, u.username, t.last_used_at
                 FROM mcp_tokens t JOIN users u ON u.id = t.user_id
                 WHERE t.token_hash = ?1 AND t.revoked_at IS NULL AND u.disabled = 0",
                [digest(token.expose_secret())],
                |row| Ok((row.get::<_, String>(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(Error::Database)?;
        let Some((id, username, last_used_at)) = row else {
            return Ok(None);
        };
        let vaults = self.mcp_token_vaults(&id)?;
        Ok(Some(Principal {
            id,
            username,
            vaults,
            last_used_at,
        }))
    }

    /// Records successful use no more than once per minute.
    ///
    /// # Errors
    /// Returns a clock or database write error.
    pub fn record_mcp_use(&self, principal: &Principal) -> Result<(), Error> {
        let now = now_seconds()?;
        if principal
            .last_used_at
            .is_some_and(|last| now.saturating_sub(last) < 60)
        {
            return Ok(());
        }
        self.connection
            .execute(
                "UPDATE mcp_tokens SET last_used_at = ?1 WHERE id = ?2 AND revoked_at IS NULL",
                params![now, principal.id],
            )
            .map(|_| ())
            .map_err(Error::Database)
    }
}

#[cfg(test)]
// why: unit test assertions use expect/indexing directly.
#[allow(clippy::expect_used, clippy::indexing_slicing)]
mod tests {
    use std::collections::BTreeSet;

    use crate::{AuthDb, Error, NewUser};

    use super::{Token, TokenUpdate};

    fn keys(values: &[&str]) -> BTreeSet<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    fn fixture() -> (AuthDb, crate::User, crate::User) {
        let mut db = AuthDb::open_in_memory().expect("open");
        let alice = db
            .setup_first_user(NewUser {
                username: "alice",
                display_name: "Alice",
                password: "password-one-long",
            })
            .expect("alice");
        let bob = db
            .create_user(NewUser {
                username: "bob",
                display_name: "Bob",
                password: "password-two-long",
            })
            .expect("bob");
        (db, alice, bob)
    }

    #[test]
    fn token_parsing_and_redacted_debug() {
        let valid = format!("mbm_{}", "a".repeat(64));
        let parsed = Token::parse(&valid).expect("valid token");
        assert_eq!(parsed.expose_secret(), valid);
        assert_eq!(format!("{parsed:?}"), "Token(<redacted>)");
        assert!(Token::parse("mbd_").is_none());
        assert!(Token::parse(&format!("mbm_{}", "a".repeat(63))).is_none());
        assert!(Token::parse(&format!("mbm_{}", "z".repeat(64))).is_none());
    }

    #[test]
    fn settings_toggle_checks_revision_and_persists() {
        let (mut db, _, _) = fixture();
        let initial = db.mcp_settings().expect("settings");
        assert!(!initial.enabled);
        assert_eq!(initial.revision, 0);

        assert!(db.set_mcp_enabled(0, true).expect("enable"));
        assert!(!db.set_mcp_enabled(0, false).expect("stale revision"));
        let enabled = db.mcp_settings().expect("enabled settings");
        assert!(enabled.enabled);
        assert_eq!(enabled.revision, 1);

        assert!(db.set_mcp_enabled(1, false).expect("disable"));
        let disabled = db.mcp_settings().expect("disabled settings");
        assert!(!disabled.enabled);
        assert_eq!(disabled.revision, 2);
    }

    #[test]
    fn token_lifecycle_requires_vaults_and_supports_editing() {
        let (mut db, alice, bob) = fixture();

        assert!(matches!(
            db.create_mcp_token(alice.id, "Empty", &BTreeSet::new()),
            Err(Error::EmptyMcpVaults)
        ));

        let (id, secret) = db
            .create_mcp_token(alice.id, "Nod", &keys(&["vault-a"]))
            .expect("create token");
        let principal = db
            .authenticate_mcp_token(&secret)
            .expect("auth")
            .expect("active principal");
        assert_eq!(principal.id, id);
        assert_eq!(principal.username, "alice");
        assert_eq!(principal.vaults, keys(&["vault-a"]));

        db.record_mcp_use(&principal).expect("record use");
        let after_use = db
            .authenticate_mcp_token(&secret)
            .expect("auth")
            .expect("used principal");
        assert!(after_use.last_used_at.is_some());
        db.record_mcp_use(&after_use).expect("throttled use");

        // Editing rejects empty sets, wrong owners and stale revisions.
        assert!(matches!(
            db.update_mcp_token_vaults(alice.id, &id, 0, &BTreeSet::new()),
            Err(Error::EmptyMcpVaults)
        ));
        assert_eq!(
            db.update_mcp_token_vaults(bob.id, &id, 0, &keys(&["vault-b"]))
                .expect("wrong owner"),
            TokenUpdate::NotFound
        );
        assert_eq!(
            db.update_mcp_token_vaults(alice.id, "missing", 0, &keys(&["vault-b"]))
                .expect("missing token"),
            TokenUpdate::NotFound
        );
        assert_eq!(
            db.update_mcp_token_vaults(alice.id, &id, 99, &keys(&["vault-b"]))
                .expect("stale revision"),
            TokenUpdate::Conflict
        );

        // Editing with the current revision replaces vaults atomically and bumps revision.
        assert_eq!(
            db.update_mcp_token_vaults(alice.id, &id, 0, &keys(&["vault-b", "vault-c"]))
                .expect("update"),
            TokenUpdate::Updated
        );
        assert_eq!(db.mcp_settings().expect("settings").revision, 1);
        let updated = db
            .authenticate_mcp_token(&secret)
            .expect("auth")
            .expect("updated principal");
        assert_eq!(updated.vaults, keys(&["vault-b", "vault-c"]));

        // Retiring absent registrations prunes token vaults and bumps revision.
        db.retire_mcp_registrations(&keys(&["vault-b"]))
            .expect("retire");
        assert_eq!(db.mcp_settings().expect("settings").revision, 2);
        let listed = db.list_mcp_tokens(alice.id).expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].vaults, keys(&["vault-b"]));
        // Repeating retire with nothing to prune does not bump revision.
        db.retire_mcp_registrations(&keys(&["vault-b"]))
            .expect("noop retire");
        assert_eq!(db.mcp_settings().expect("settings").revision, 2);

        // Revoking prevents authentication and further edits, and is idempotent.
        db.revoke_mcp_token(alice.id, &id).expect("revoke");
        assert_eq!(db.mcp_settings().expect("settings").revision, 3);
        db.revoke_mcp_token(alice.id, &id).expect("repeat revoke");
        assert_eq!(db.mcp_settings().expect("settings").revision, 3);
        assert!(
            db.authenticate_mcp_token(&secret)
                .expect("auth revoked")
                .is_none()
        );
        assert_eq!(
            db.update_mcp_token_vaults(alice.id, &id, 3, &keys(&["vault-b"]))
                .expect("edit revoked"),
            TokenUpdate::Conflict
        );

        // Disabling the issuer stops active tokens from authenticating.
        let (_, second_secret) = db
            .create_mcp_token(bob.id, "Bob", &keys(&["vault-b"]))
            .expect("bob token");
        db.set_disabled(bob.id, true).expect("disable bob");
        assert!(
            db.authenticate_mcp_token(&second_secret)
                .expect("auth disabled")
                .is_none()
        );
    }
}
