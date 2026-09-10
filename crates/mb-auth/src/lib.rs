//! Authentication storage (`SPEC.md` §6.8).
//!
//! `auth.db` is server-owned state outside every vault. This crate owns its schema so
//! password hashes, user flags and later session/token records cannot accidentally enter a
//! Markdown vault or its git history.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use mb_core::Role;
use rand_core::OsRng;
use rand_core::RngCore;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use sha2::{Digest, Sha256};

/// A durable user identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct UserId(i64);

impl UserId {
    /// Returns the database identifier.
    #[must_use]
    pub const fn get(self) -> i64 {
        self.0
    }
}

/// A user account without credential material.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct User {
    /// Stable database identifier.
    pub id: UserId,
    /// Durable reference used by `access.toml`.
    pub username: String,
    /// User-facing name, not an authorization input.
    pub display_name: String,
    /// Whether the account is disabled.
    pub disabled: bool,
    /// Server-administration capability, never vault-content access.
    pub is_admin: bool,
}

/// Details required to create a user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewUser<'a> {
    /// Durable lower-case username.
    pub username: &'a str,
    /// Human-readable display name.
    pub display_name: &'a str,
    /// Plaintext password at the process boundary only.
    pub password: &'a str,
}

/// An opaque session bearer value. Its plaintext is never written to `auth.db`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionToken(String);

impl SessionToken {
    /// Reconstructs a token received through a cookie. This performs only lexical
    /// validation; authentication still requires a matching unexpired database record.
    pub fn from_secret(value: &str) -> Option<Self> {
        if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            Some(Self(value.to_string()))
        } else {
            None
        }
    }

    /// Returns the cookie-safe bearer value. Callers must keep it secret.
    #[must_use]
    pub fn expose_secret(&self) -> &str {
        &self.0
    }
}

/// An opaque scoped API bearer value. Its plaintext is returned only when issued.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiToken(String);

impl ApiToken {
    /// Reconstructs a token received through an API authorization header.
    pub fn from_secret(value: &str) -> Option<Self> {
        SessionToken::from_secret(value).map(|token| Self(token.expose_secret().to_string()))
    }

    /// Returns the bearer value. Callers must keep it secret.
    #[must_use]
    pub fn expose_secret(&self) -> &str {
        &self.0
    }
}

/// An opaque, single-use invite bearer value. Its plaintext is returned only when issued.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteToken(String);

impl InviteToken {
    /// Reconstructs an invite token received from an acceptance form.
    pub fn from_secret(value: &str) -> Option<Self> {
        SessionToken::from_secret(value).map(|token| Self(token.expose_secret().to_string()))
    }

    /// Returns the bearer value. Callers must keep it secret.
    #[must_use]
    pub fn expose_secret(&self) -> &str {
        &self.0
    }
}

/// The non-secret scope of an invitation issued by a vault owner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteScope {
    /// Owner who issued the invitation; vault ownership is verified by the server layer.
    pub issuer_user_id: UserId,
    /// Vault to which the new account will be added.
    pub vault_slug: String,
    /// Vault-wide role granted when the invite is accepted.
    pub role: Role,
    /// Unix timestamp after which acceptance is refused.
    pub expires_at: i64,
}

/// The persisted, non-secret scope of an API token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiTokenScope {
    /// User that issued the token.
    pub user_id: UserId,
    /// Vault slug the token may address.
    pub vault_slug: String,
    /// Maximum role the integration can request.
    pub role: Role,
}

/// Stable non-secret identifier for managing one API token.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ApiTokenId(i64);

impl ApiTokenId {
    /// Returns the database identifier suitable for a management route or CLI argument.
    #[must_use]
    pub const fn get(self) -> i64 {
        self.0
    }
}

/// A non-secret API-token record suitable for a settings list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiTokenRecord {
    /// Stable identifier used for revocation; bearer material is never returned.
    pub id: ApiTokenId,
    /// Vault to which the token is confined.
    pub vault_slug: String,
    /// Maximum role the token may request.
    pub role: Role,
    /// Creation time as a Unix timestamp.
    pub created_at: i64,
    /// Revocation time, when revoked.
    pub revoked_at: Option<i64>,
    /// Most recent successful use, when any.
    pub last_used_at: Option<i64>,
}

/// The non-secret properties of a public note link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareLinkScope {
    /// Vault containing the shared note.
    pub vault_slug: String,
    /// Vault-relative Markdown path of the shared note.
    pub note_path: String,
    /// Whether readable embeds may be expanded at access time.
    pub include_embeds: bool,
    /// Optional plaintext password on creation and Argon2id hash on stored records.
    pub password: Option<String>,
    /// Unix timestamp after which access is refused, or `None` for no expiry.
    pub expires_at: Option<i64>,
    /// User whose current permissions constrain this link and its embeds.
    pub created_by: UserId,
}

/// An opaque public share bearer. Its plaintext is returned only when a link is created.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareToken(String);

impl ShareToken {
    /// Reconstructs a URL-safe 128-bit token received from `/s/<token>`.
    pub fn from_secret(value: &str) -> Option<Self> {
        let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(value)
            .ok()?;
        (decoded.len() == 16).then(|| Self(value.to_string()))
    }

    /// Returns the URL-safe bearer value. Callers must keep it secret.
    #[must_use]
    pub fn expose_secret(&self) -> &str {
        &self.0
    }

    /// Returns a non-secret stable scope for token-specific media routes and cookies.
    #[must_use]
    pub fn media_scope(&self) -> String {
        digest(&self.0)
    }
}

/// A share link record returned after an access check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareLink {
    /// The link's opaque identifier, never included in rendered page content.
    pub token: ShareToken,
    /// Link scope and creator.
    pub scope: ShareLinkScope,
    /// Number of successful accesses.
    pub access_count: i64,
    /// Last successful access timestamp.
    pub last_accessed_at: Option<i64>,
    /// Revocation timestamp, if revoked.
    pub revoked_at: Option<i64>,
}

/// Stable identifier for managing a share link without retaining its bearer value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ShareLinkId(i64);

impl ShareLinkId {
    /// Reconstructs an identifier received from a management route.
    #[must_use]
    pub const fn from_i64(value: i64) -> Self {
        Self(value)
    }

    /// Returns the database identifier.
    #[must_use]
    pub const fn get(self) -> i64 {
        self.0
    }
}

/// A share link summary safe for an authenticated management view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareLinkRecord {
    /// Stable management identifier.
    pub id: ShareLinkId,
    /// Link scope without the password hash or bearer token.
    pub scope: ShareLinkScope,
    /// Number of successful accesses.
    pub access_count: i64,
    /// Last successful access timestamp.
    pub last_accessed_at: Option<i64>,
    /// Revocation timestamp, if revoked.
    pub revoked_at: Option<i64>,
}

/// A connection to the server-level authentication database.
#[derive(Debug)]
pub struct AuthDb {
    connection: Connection,
}

impl AuthDb {
    /// Opens and migrates `auth.db`.
    ///
    /// # Errors
    ///
    /// Fails if the database cannot be opened or the schema cannot be initialized.
    pub fn open(path: &Path) -> Result<Self, Error> {
        let connection = Connection::open(path).map_err(Error::Database)?;
        let db = Self { connection };
        db.migrate()?;
        Ok(db)
    }

    /// Opens an in-memory database for deterministic tests and embedders.
    ///
    /// # Errors
    ///
    /// Fails if SQLite cannot allocate or initialize the database.
    pub fn open_in_memory() -> Result<Self, Error> {
        let connection = Connection::open_in_memory().map_err(Error::Database)?;
        let db = Self { connection };
        db.migrate()?;
        Ok(db)
    }

    /// Returns whether first-run setup is still required.
    pub fn needs_setup(&self) -> Result<bool, Error> {
        let count: i64 = self
            .connection
            .query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))
            .map_err(Error::Database)?;
        Ok(count == 0)
    }

    /// Creates the first user, which is the server administrator by definition.
    ///
    /// This is intentionally single-use: there are no default credentials and a race to
    /// initialize a fresh server yields one winner rather than two administrators.
    pub fn setup_first_user(&mut self, new_user: NewUser<'_>) -> Result<User, Error> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(Error::Database)?;
        let count: i64 = transaction
            .query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))
            .map_err(Error::Database)?;
        if count != 0 {
            return Err(Error::SetupAlreadyComplete);
        }
        let user = insert_user(&transaction, new_user, true)?;
        transaction.commit().map_err(Error::Database)?;
        Ok(user)
    }

    /// Creates a non-admin user after validating the account details.
    pub fn create_user(&self, new_user: NewUser<'_>) -> Result<User, Error> {
        insert_user(&self.connection, new_user, false)
    }

    /// Verifies a username/password pair.
    ///
    /// Disabled accounts and unknown usernames return the same denial result. The password
    /// hash is still verified against a fixed Argon2id hash for an unknown user, preventing
    /// username enumeration through timing.
    pub fn authenticate(&self, username: &str, password: &str) -> Result<Option<User>, Error> {
        let record = self
            .connection
            .query_row(
                "SELECT id, username, display_name, password_hash, disabled, is_admin \
                 FROM users WHERE username = ?1",
                [username],
                |row| {
                    Ok(UserRecord {
                        user: User {
                            id: UserId(row.get(0)?),
                            username: row.get(1)?,
                            display_name: row.get(2)?,
                            disabled: row.get(4)?,
                            is_admin: row.get(5)?,
                        },
                        password_hash: row.get(3)?,
                    })
                },
            )
            .optional()
            .map_err(Error::Database)?;

        let Some(record) = record else {
            verify_password(password, DUMMY_HASH)?;
            return Ok(None);
        };
        if !verify_password(password, &record.password_hash)? || record.user.disabled {
            return Ok(None);
        }
        Ok(Some(record.user))
    }

    /// Disables or re-enables an account. The first administrator cannot be disabled.
    pub fn set_disabled(&self, user_id: UserId, disabled: bool) -> Result<(), Error> {
        if disabled && self.is_last_enabled_admin(user_id)? {
            return Err(Error::LastAdmin);
        }
        let changed = self
            .connection
            .execute(
                "UPDATE users SET disabled = ?1 WHERE id = ?2",
                params![disabled, user_id.get()],
            )
            .map_err(Error::Database)?;
        if changed == 0 {
            return Err(Error::UnknownUser);
        }
        Ok(())
    }

    /// Grants or removes server-administration capability.
    ///
    /// This flag remains orthogonal to every vault ACL. Removing the final enabled admin is
    /// rejected so local administration cannot be permanently locked out.
    pub fn set_admin(&self, user_id: UserId, is_admin: bool) -> Result<(), Error> {
        if !is_admin && self.is_last_enabled_admin(user_id)? {
            return Err(Error::LastAdmin);
        }
        let changed = self
            .connection
            .execute(
                "UPDATE users SET is_admin = ?1 WHERE id = ?2",
                params![is_admin, user_id.get()],
            )
            .map_err(Error::Database)?;
        if changed == 0 {
            return Err(Error::UnknownUser);
        }
        Ok(())
    }

    /// Replaces a user's password with a newly generated Argon2id hash and revokes sessions.
    ///
    /// A reset is a credential-boundary change, so a browser authenticated with the old
    /// password must not remain usable after it completes.
    pub fn reset_password(&self, user_id: UserId, password: &str) -> Result<(), Error> {
        validate_password(password)?;
        let password_hash = hash_password(password)?;
        let transaction = self
            .connection
            .unchecked_transaction()
            .map_err(Error::Database)?;
        let changed = transaction
            .execute(
                "UPDATE users SET password_hash = ?1 WHERE id = ?2",
                params![password_hash, user_id.get()],
            )
            .map_err(Error::Database)?;
        if changed == 0 {
            return Err(Error::UnknownUser);
        }
        transaction
            .execute("DELETE FROM sessions WHERE user_id = ?1", [user_id.get()])
            .map_err(Error::Database)?;
        transaction.commit().map_err(Error::Database)
    }

    /// Creates a revocable session for an enabled user.
    ///
    /// `expires_at` is a Unix timestamp and must be in the future. The returned opaque
    /// value is signed before it is placed in an HTTP-only cookie; only its SHA-256 digest
    /// is persisted in `auth.db`.
    pub fn create_session(&self, user_id: UserId, expires_at: i64) -> Result<SessionToken, Error> {
        if expires_at <= now_seconds()? {
            return Err(Error::InvalidSessionExpiry);
        }
        let enabled: Option<bool> = self
            .connection
            .query_row(
                "SELECT NOT disabled FROM users WHERE id = ?1",
                [user_id.get()],
                |row| row.get(0),
            )
            .optional()
            .map_err(Error::Database)?;
        match enabled {
            Some(true) => {}
            Some(false) => return Err(Error::DisabledUser),
            None => return Err(Error::UnknownUser),
        }

        let mut raw = [0_u8; 32];
        OsRng.fill_bytes(&mut raw);
        let token = SessionToken(hex(&raw));
        self.connection
            .execute(
                "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) \
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    digest(token.expose_secret()),
                    user_id.get(),
                    now_seconds()?,
                    expires_at
                ],
            )
            .map_err(Error::Database)?;
        Ok(token)
    }

    /// Resolves an unexpired session token to an enabled user.
    pub fn authenticate_session(&self, token: &SessionToken) -> Result<Option<User>, Error> {
        self.connection
            .query_row(
                "SELECT u.id, u.username, u.display_name, u.disabled, u.is_admin \
                 FROM sessions s JOIN users u ON u.id = s.user_id \
                 WHERE s.token_hash = ?1 AND s.expires_at > ?2 AND u.disabled = 0",
                params![digest(token.expose_secret()), now_seconds()?],
                |row| {
                    Ok(User {
                        id: UserId(row.get(0)?),
                        username: row.get(1)?,
                        display_name: row.get(2)?,
                        disabled: row.get(3)?,
                        is_admin: row.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(Error::Database)
    }

    /// Revokes a session. Repeating a revocation is harmless and does not reveal whether a
    /// bearer value was valid.
    pub fn revoke_session(&self, token: &SessionToken) -> Result<(), Error> {
        self.connection
            .execute(
                "DELETE FROM sessions WHERE token_hash = ?1",
                [digest(token.expose_secret())],
            )
            .map(|_| ())
            .map_err(Error::Database)
    }

    /// Creates a single-use invitation for one vault role.
    pub fn create_invite(&self, scope: InviteScope) -> Result<InviteToken, Error> {
        validate_vault_slug(&scope.vault_slug)?;
        if scope.role == Role::None {
            return Err(Error::InvalidInviteRole);
        }
        if scope.expires_at <= now_seconds()? {
            return Err(Error::InvalidInviteExpiry);
        }
        let issuer_enabled: Option<bool> = self
            .connection
            .query_row(
                "SELECT NOT disabled FROM users WHERE id = ?1",
                [scope.issuer_user_id.get()],
                |row| row.get(0),
            )
            .optional()
            .map_err(Error::Database)?;
        match issuer_enabled {
            Some(true) => {}
            Some(false) => return Err(Error::DisabledUser),
            None => return Err(Error::UnknownUser),
        }
        let token = InviteToken(random_secret());
        self.connection
            .execute(
                "INSERT INTO invites (token_hash, issuer_user_id, vault_slug, role, created_at, expires_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    digest(token.expose_secret()),
                    scope.issuer_user_id.get(),
                    scope.vault_slug,
                    scope.role.as_str(),
                    now_seconds()?,
                    scope.expires_at
                ],
            )
            .map_err(Error::Database)?;
        Ok(token)
    }

    /// Accepts an unexpired invitation exactly once and creates its new user account.
    pub fn accept_invite(
        &mut self,
        token: &InviteToken,
        new_user: NewUser<'_>,
    ) -> Result<InviteScope, Error> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(Error::Database)?;
        let invite = transaction
            .query_row(
                "SELECT issuer_user_id, vault_slug, role, expires_at FROM invites \
                 WHERE token_hash = ?1 AND accepted_at IS NULL",
                [digest(token.expose_secret())],
                |row| {
                    Ok((
                        UserId(row.get(0)?),
                        row.get(1)?,
                        row.get::<_, String>(2)?,
                        row.get(3)?,
                    ))
                },
            )
            .optional()
            .map_err(Error::Database)?;
        let Some((issuer_user_id, vault_slug, role, expires_at)) = invite else {
            return Err(Error::InvalidInvite);
        };
        if expires_at <= now_seconds()? {
            return Err(Error::InvalidInvite);
        }
        let role = Role::parse(&role).map_err(|_| Error::InvalidStoredInviteRole)?;
        let _user = insert_user(&transaction, new_user, false)?;
        transaction
            .execute(
                "UPDATE invites SET accepted_at = ?1 WHERE token_hash = ?2 AND accepted_at IS NULL",
                params![now_seconds()?, digest(token.expose_secret())],
            )
            .map_err(Error::Database)?;
        transaction.commit().map_err(Error::Database)?;
        Ok(InviteScope {
            issuer_user_id,
            vault_slug,
            role,
            expires_at,
        })
    }

    /// Returns an active invite's scope without consuming it.
    pub fn invite_scope(&self, token: &InviteToken) -> Result<Option<InviteScope>, Error> {
        let invite = self.connection.query_row(
            "SELECT issuer_user_id, vault_slug, role, expires_at FROM invites WHERE token_hash = ?1 AND accepted_at IS NULL",
            [digest(token.expose_secret())],
            |row| Ok((UserId(row.get(0)?), row.get(1)?, row.get::<_, String>(2)?, row.get(3)?)),
        ).optional().map_err(Error::Database)?;
        let Some((issuer_user_id, vault_slug, role, expires_at)) = invite else {
            return Ok(None);
        };
        if expires_at <= now_seconds()? {
            return Ok(None);
        }
        Ok(Some(InviteScope {
            issuer_user_id,
            vault_slug,
            role: Role::parse(&role).map_err(|_| Error::InvalidStoredInviteRole)?,
            expires_at,
        }))
    }

    /// Signs an opaque session token for transport in an HTTP-only cookie.
    ///
    /// The session token remains revocable server-side; the signature prevents a client
    /// from substituting a different database token into its cookie.
    pub fn signed_session_cookie(&self, token: &SessionToken) -> Result<String, Error> {
        let secret = self.current_cookie_secret()?;
        Ok(format!(
            "{}.{}",
            token.expose_secret(),
            hmac_sha256_hex(secret.as_bytes(), token.expose_secret().as_bytes())
        ))
    }

    /// Resolves a signed session cookie to an enabled user.
    ///
    /// Retired signing keys are accepted so rotating a key does not force every active
    /// session to log in again. Database-backed session expiry and revocation still apply.
    pub fn authenticate_signed_session_cookie(&self, cookie: &str) -> Result<Option<User>, Error> {
        let Some((raw_token, signature)) = cookie.split_once('.') else {
            return Ok(None);
        };
        if raw_token.contains('.') || !is_hex_digest(signature) {
            return Ok(None);
        }
        let Some(token) = SessionToken::from_secret(raw_token) else {
            return Ok(None);
        };
        let mut valid = false;
        let mut statement = self
            .connection
            .prepare("SELECT secret FROM session_cookie_keys")
            .map_err(Error::Database)?;
        let keys = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(Error::Database)?;
        for key in keys {
            let key = key.map_err(Error::Database)?;
            let expected = hmac_sha256_hex(key.as_bytes(), raw_token.as_bytes());
            valid |= constant_time_eq(expected.as_bytes(), signature.as_bytes());
        }
        if !valid {
            return Ok(None);
        }
        self.authenticate_session(&token)
    }

    /// Rotates the cookie signing secret without invalidating existing signed sessions.
    pub fn rotate_session_cookie_secret(&mut self) -> Result<(), Error> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(Error::Database)?;
        transaction
            .execute(
                "UPDATE session_cookie_keys SET is_current = 0 WHERE is_current = 1",
                [],
            )
            .map_err(Error::Database)?;
        transaction
            .execute(
                "INSERT INTO session_cookie_keys (secret, created_at, is_current) VALUES (?1, ?2, 1)",
                params![random_secret(), now_seconds()?],
            )
            .map_err(Error::Database)?;
        transaction.commit().map_err(Error::Database)
    }

    /// Issues a revocable API token for exactly one vault and role scope.
    pub fn create_api_token(&self, scope: ApiTokenScope) -> Result<ApiToken, Error> {
        validate_vault_slug(&scope.vault_slug)?;
        if scope.role == Role::None {
            return Err(Error::InvalidTokenRole);
        }
        let enabled: Option<bool> = self
            .connection
            .query_row(
                "SELECT NOT disabled FROM users WHERE id = ?1",
                [scope.user_id.get()],
                |row| row.get(0),
            )
            .optional()
            .map_err(Error::Database)?;
        match enabled {
            Some(true) => {}
            Some(false) => return Err(Error::DisabledUser),
            None => return Err(Error::UnknownUser),
        }
        let token = ApiToken(random_secret());
        self.connection
            .execute(
                "INSERT INTO api_tokens (token_hash, user_id, vault_slug, role, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![digest(token.expose_secret()), scope.user_id.get(), scope.vault_slug, scope.role.as_str(), now_seconds()?],
            )
            .map_err(Error::Database)?;
        Ok(token)
    }

    /// Authenticates an active API token and records its last use.
    pub fn authenticate_api_token(&self, token: &ApiToken) -> Result<Option<ApiTokenScope>, Error> {
        let scope = self.connection.query_row(
            "SELECT t.user_id, t.vault_slug, t.role FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?1 AND t.revoked_at IS NULL AND u.disabled = 0",
            [digest(token.expose_secret())],
            |row| {
                let role: String = row.get(2)?;
                Ok((UserId(row.get(0)?), row.get(1)?, role))
            },
        ).optional().map_err(Error::Database)?;
        let Some((user_id, vault_slug, role)) = scope else {
            return Ok(None);
        };
        let role = Role::parse(&role).map_err(|_| Error::InvalidStoredTokenRole)?;
        self.connection
            .execute(
                "UPDATE api_tokens SET last_used_at = ?1 WHERE token_hash = ?2",
                params![now_seconds()?, digest(token.expose_secret())],
            )
            .map_err(Error::Database)?;
        Ok(Some(ApiTokenScope {
            user_id,
            vault_slug,
            role,
        }))
    }

    /// Revokes an API token. Repeated revocation is deliberately harmless.
    pub fn revoke_api_token(&self, token: &ApiToken) -> Result<(), Error> {
        self.connection
            .execute(
                "UPDATE api_tokens SET revoked_at = ?1 WHERE token_hash = ?2",
                params![now_seconds()?, digest(token.expose_secret())],
            )
            .map(|_| ())
            .map_err(Error::Database)
    }

    /// Revokes one token owned by `user_id` without requiring its bearer value.
    ///
    /// Missing and foreign identifiers are deliberately indistinguishable from an already
    /// revoked token, so this management path does not disclose another user's tokens.
    pub fn revoke_api_token_by_id(
        &self,
        user_id: UserId,
        token_id: ApiTokenId,
    ) -> Result<(), Error> {
        self.connection
            .execute(
                "UPDATE api_tokens SET revoked_at = ?1 \
                 WHERE rowid = ?2 AND user_id = ?3 AND revoked_at IS NULL",
                params![now_seconds()?, token_id.get(), user_id.get()],
            )
            .map(|_| ())
            .map_err(Error::Database)
    }

    /// Lists a user's tokens without ever returning bearer material.
    pub fn list_api_tokens(&self, user_id: UserId) -> Result<Vec<ApiTokenRecord>, Error> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT rowid, vault_slug, role, created_at, revoked_at, last_used_at \
                 FROM api_tokens WHERE user_id = ?1 ORDER BY created_at DESC",
            )
            .map_err(Error::Database)?;
        let rows = statement
            .query_map([user_id.get()], |row| {
                Ok((
                    ApiTokenId(row.get(0)?),
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                ))
            })
            .map_err(Error::Database)?;
        rows.map(|row| {
            let (id, vault_slug, role, created_at, revoked_at, last_used_at) =
                row.map_err(Error::Database)?;
            Ok(ApiTokenRecord {
                id,
                vault_slug,
                role: Role::parse(&role).map_err(|_| Error::InvalidStoredTokenRole)?,
                created_at,
                revoked_at,
                last_used_at,
            })
        })
        .collect()
    }

    /// Creates a public link for one note.
    ///
    /// The server must authorize the note before calling this method. This crate validates
    /// the durable scope and owns all secret generation and password hashing.
    pub fn create_share_link(&self, scope: ShareLinkScope) -> Result<ShareToken, Error> {
        validate_vault_slug(&scope.vault_slug)?;
        validate_share_path(&scope.note_path)?;
        if let Some(expires_at) = scope.expires_at
            && expires_at <= now_seconds()?
        {
            return Err(Error::InvalidShareExpiry);
        }
        let enabled: Option<bool> = self
            .connection
            .query_row(
                "SELECT NOT disabled FROM users WHERE id = ?1",
                [scope.created_by.get()],
                |row| row.get(0),
            )
            .optional()
            .map_err(Error::Database)?;
        match enabled {
            Some(true) => {}
            Some(false) => return Err(Error::DisabledUser),
            None => return Err(Error::UnknownUser),
        }
        let password_hash = scope
            .password
            .as_deref()
            .map(|password| {
                validate_password(password)?;
                hash_password(password)
            })
            .transpose()?;
        let token = share_token();
        self.connection
            .execute(
                "INSERT INTO share_links
                 (token_hash, vault_slug, note_path, include_embeds, password_hash,
                  expires_at, created_by, created_at, access_count)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0)",
                params![
                    digest(token.expose_secret()),
                    scope.vault_slug,
                    scope.note_path,
                    scope.include_embeds,
                    password_hash,
                    scope.expires_at,
                    scope.created_by.get(),
                    now_seconds()?
                ],
            )
            .map_err(Error::Database)?;
        Ok(token)
    }

    /// Authenticates a public link without recording an access.
    ///
    /// Expired, revoked, malformed-password and unknown links all return `None`; the public
    /// route must not reveal which state caused a link to fail.
    pub fn authenticate_share_link(
        &self,
        token: &ShareToken,
        password: Option<&str>,
    ) -> Result<Option<ShareLink>, Error> {
        let record = self
            .connection
            .query_row(
                "SELECT vault_slug, note_path, include_embeds, password_hash, expires_at,
                        created_by, access_count, last_accessed_at, revoked_at
                 FROM share_links WHERE token_hash = ?1",
                [digest(token.expose_secret())],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, bool>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<i64>>(4)?,
                        UserId(row.get(5)?),
                        row.get::<_, i64>(6)?,
                        row.get::<_, Option<i64>>(7)?,
                        row.get::<_, Option<i64>>(8)?,
                    ))
                },
            )
            .optional()
            .map_err(Error::Database)?;
        let Some((
            vault_slug,
            note_path,
            include_embeds,
            password_hash,
            expires_at,
            created_by,
            access_count,
            _last_accessed_at,
            revoked_at,
        )) = record
        else {
            return Ok(None);
        };
        let now = now_seconds()?;
        if revoked_at.is_some() || expires_at.is_some_and(|expires_at| expires_at <= now) {
            return Ok(None);
        }
        if let Some(hash) = password_hash.as_deref() {
            let Some(password) = password else {
                return Ok(None);
            };
            if !verify_password(password, hash)? {
                return Ok(None);
            }
        }
        Ok(Some(ShareLink {
            token: token.clone(),
            scope: ShareLinkScope {
                vault_slug,
                note_path,
                include_embeds,
                password: password_hash,
                expires_at,
                created_by,
            },
            access_count,
            last_accessed_at: _last_accessed_at,
            revoked_at,
        }))
    }

    /// Records an access only while the link is still active.
    pub fn record_share_link_access(&self, token: &ShareToken) -> Result<bool, Error> {
        let accessed_at = now_seconds()?;
        self.connection
            .execute(
                "UPDATE share_links SET access_count = access_count + 1,
                 last_accessed_at = ?1 WHERE token_hash = ?2 AND revoked_at IS NULL
                 AND (expires_at IS NULL OR expires_at > ?1)",
                params![accessed_at, digest(token.expose_secret())],
            )
            .map(|changed| changed == 1)
            .map_err(Error::Database)
    }

    /// Reports whether an active link needs a password without exposing inactive-link state.
    pub fn share_link_requires_password(&self, token: &ShareToken) -> Result<Option<bool>, Error> {
        let row = self
            .connection
            .query_row(
                "SELECT password_hash, expires_at, revoked_at FROM share_links
                 WHERE token_hash = ?1",
                [digest(token.expose_secret())],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(Error::Database)?;
        let Some((password, expires_at, revoked_at)) = row else {
            return Ok(None);
        };
        let now = now_seconds()?;
        let active = revoked_at.is_none() && expires_at.is_none_or(|expires_at| expires_at > now);
        Ok(active.then_some(password.is_some()))
    }

    /// Signs a short-lived browser cookie proving that a share password was accepted.
    pub fn signed_share_cookie(&self, token: &ShareToken) -> Result<String, Error> {
        let secret = self.current_cookie_secret()?;
        let message = format!("share:{}", token.expose_secret());
        Ok(format!(
            "{}.{}",
            token.expose_secret(),
            hmac_sha256_hex(secret.as_bytes(), message.as_bytes())
        ))
    }

    /// Authenticates a share-session cookie without rechecking the link password.
    pub fn authenticate_share_cookie(&self, cookie: &str) -> Result<Option<ShareLink>, Error> {
        let Some((raw_token, signature)) = cookie.split_once('.') else {
            return Ok(None);
        };
        let Some(token) = ShareToken::from_secret(raw_token) else {
            return Ok(None);
        };
        if !is_hex_digest(signature) {
            return Ok(None);
        }
        let message = format!("share:{raw_token}");
        let mut valid = false;
        let mut statement = self
            .connection
            .prepare("SELECT secret FROM session_cookie_keys")
            .map_err(Error::Database)?;
        let keys = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(Error::Database)?;
        for key in keys {
            let key = key.map_err(Error::Database)?;
            let expected = hmac_sha256_hex(key.as_bytes(), message.as_bytes());
            valid |= constant_time_eq(expected.as_bytes(), signature.as_bytes());
        }
        if !valid {
            return Ok(None);
        }
        let row = self
            .connection
            .query_row(
                "SELECT vault_slug, note_path, include_embeds, password_hash, expires_at,
                        created_by, access_count, last_accessed_at, revoked_at
                 FROM share_links WHERE token_hash = ?1",
                [digest(token.expose_secret())],
                |row| {
                    Ok(ShareLink {
                        token: token.clone(),
                        scope: ShareLinkScope {
                            vault_slug: row.get(0)?,
                            note_path: row.get(1)?,
                            include_embeds: row.get(2)?,
                            password: row.get(3)?,
                            expires_at: row.get(4)?,
                            created_by: UserId(row.get(5)?),
                        },
                        access_count: row.get(6)?,
                        last_accessed_at: row.get(7)?,
                        revoked_at: row.get(8)?,
                    })
                },
            )
            .optional()
            .map_err(Error::Database)?;
        let now = now_seconds()?;
        Ok(row.filter(|link| {
            link.revoked_at.is_none()
                && link
                    .scope
                    .expires_at
                    .is_none_or(|expires_at| expires_at > now)
        }))
    }

    /// Revokes a link owned by `user_id`; foreign and missing links are intentionally opaque.
    pub fn revoke_share_link(&self, user_id: UserId, token: &ShareToken) -> Result<(), Error> {
        self.connection
            .execute(
                "UPDATE share_links SET revoked_at = ?1
                 WHERE token_hash = ?2 AND created_by = ?3 AND revoked_at IS NULL",
                params![now_seconds()?, digest(token.expose_secret()), user_id.get()],
            )
            .map(|_| ())
            .map_err(Error::Database)
    }

    /// Lists links created by one user in one vault, without returning bearer material.
    pub fn list_share_links(
        &self,
        user_id: UserId,
        vault_slug: &str,
    ) -> Result<Vec<ShareLinkRecord>, Error> {
        validate_vault_slug(vault_slug)?;
        let mut statement = self
            .connection
            .prepare(
                "SELECT rowid, note_path, include_embeds, password_hash, expires_at,
                        created_at, access_count, last_accessed_at, revoked_at
                 FROM share_links WHERE created_by = ?1 AND vault_slug = ?2
                 ORDER BY created_at DESC, rowid DESC",
            )
            .map_err(Error::Database)?;
        let rows = statement
            .query_map(params![user_id.get(), vault_slug], |row| {
                Ok(ShareLinkRecord {
                    id: ShareLinkId(row.get(0)?),
                    scope: ShareLinkScope {
                        vault_slug: vault_slug.to_string(),
                        note_path: row.get(1)?,
                        include_embeds: row.get(2)?,
                        password: row.get(3)?,
                        expires_at: row.get(4)?,
                        created_by: user_id,
                    },
                    access_count: row.get(6)?,
                    last_accessed_at: row.get(7)?,
                    revoked_at: row.get(8)?,
                })
            })
            .map_err(Error::Database)?;
        rows.map(|row| row.map_err(Error::Database)).collect()
    }

    /// Revokes one link owned by one user using its stable management identifier.
    pub fn revoke_share_link_by_id(
        &self,
        user_id: UserId,
        link_id: ShareLinkId,
    ) -> Result<(), Error> {
        self.connection
            .execute(
                "UPDATE share_links SET revoked_at = ?1
                 WHERE rowid = ?2 AND created_by = ?3 AND revoked_at IS NULL",
                params![now_seconds()?, link_id.get(), user_id.get()],
            )
            .map(|_| ())
            .map_err(Error::Database)
    }

    /// Looks up a user by stable database identifier.
    pub fn user_by_id(&self, user_id: UserId) -> Result<Option<User>, Error> {
        self.connection
            .query_row(
                "SELECT id, username, display_name, disabled, is_admin FROM users WHERE id = ?1",
                [user_id.get()],
                |row| {
                    Ok(User {
                        id: UserId(row.get(0)?),
                        username: row.get(1)?,
                        display_name: row.get(2)?,
                        disabled: row.get(3)?,
                        is_admin: row.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(Error::Database)
    }

    /// Looks up a user by their durable username.
    pub fn user_by_username(&self, username: &str) -> Result<Option<User>, Error> {
        self.connection
            .query_row(
                "SELECT id, username, display_name, disabled, is_admin FROM users WHERE username = ?1",
                [username],
                |row| {
                    Ok(User {
                        id: UserId(row.get(0)?),
                        username: row.get(1)?,
                        display_name: row.get(2)?,
                        disabled: row.get(3)?,
                        is_admin: row.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(Error::Database)
    }

    fn migrate(&self) -> Result<(), Error> {
        self.connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY,
                    username TEXT NOT NULL UNIQUE COLLATE BINARY,
                    display_name TEXT NOT NULL,
                    password_hash TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
                    is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1))
                 );
                 CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at);
                 CREATE TABLE IF NOT EXISTS invites (
                    token_hash TEXT PRIMARY KEY,
                    issuer_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    vault_slug TEXT NOT NULL,
                    role TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL,
                    accepted_at INTEGER
                 );
                 CREATE INDEX IF NOT EXISTS invites_expiry ON invites (expires_at);
                 CREATE TABLE IF NOT EXISTS session_cookie_keys (
                    id INTEGER PRIMARY KEY,
                    secret TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    is_current INTEGER NOT NULL CHECK (is_current IN (0, 1))
                 );
                 CREATE UNIQUE INDEX IF NOT EXISTS one_current_session_cookie_key
                    ON session_cookie_keys (is_current) WHERE is_current = 1;
                 CREATE TABLE IF NOT EXISTS api_tokens (
                    token_hash TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    vault_slug TEXT NOT NULL,
                    role TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    revoked_at INTEGER,
                    last_used_at INTEGER
                 );
                 CREATE TABLE IF NOT EXISTS share_links (
                    token_hash TEXT PRIMARY KEY,
                    vault_slug TEXT NOT NULL,
                    note_path TEXT NOT NULL,
                    include_embeds INTEGER NOT NULL CHECK (include_embeds IN (0, 1)),
                    password_hash TEXT,
                    expires_at INTEGER,
                    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    created_at INTEGER NOT NULL,
                    revoked_at INTEGER,
                    access_count INTEGER NOT NULL DEFAULT 0,
                    last_accessed_at INTEGER
                 );
                 CREATE INDEX IF NOT EXISTS share_links_creator
                    ON share_links (created_by, vault_slug);",
            )
            .map_err(Error::Database)?;
        self.make_share_expiry_nullable()?;
        self.ensure_cookie_signing_key()
    }

    fn make_share_expiry_nullable(&self) -> Result<(), Error> {
        let expiry_is_required = self
            .connection
            .query_row(
                "SELECT \"notnull\" FROM pragma_table_info('share_links') WHERE name = 'expires_at'",
                [],
                |row| row.get::<_, bool>(0),
            )
            .optional()
            .map_err(Error::Database)?
            .unwrap_or(false);
        if !expiry_is_required {
            return Ok(());
        }
        self.connection
            .execute_batch(
                "BEGIN IMMEDIATE;
                 ALTER TABLE share_links RENAME TO share_links_with_required_expiry;
                 CREATE TABLE share_links (
                    token_hash TEXT PRIMARY KEY,
                    vault_slug TEXT NOT NULL,
                    note_path TEXT NOT NULL,
                    include_embeds INTEGER NOT NULL CHECK (include_embeds IN (0, 1)),
                    password_hash TEXT,
                    expires_at INTEGER,
                    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    created_at INTEGER NOT NULL,
                    revoked_at INTEGER,
                    access_count INTEGER NOT NULL DEFAULT 0,
                    last_accessed_at INTEGER
                 );
                 INSERT INTO share_links
                    (token_hash, vault_slug, note_path, include_embeds, password_hash,
                     expires_at, created_by, created_at, revoked_at, access_count, last_accessed_at)
                 SELECT token_hash, vault_slug, note_path, include_embeds, password_hash,
                        expires_at, created_by, created_at, revoked_at, access_count,
                        last_accessed_at
                 FROM share_links_with_required_expiry;
                 DROP TABLE share_links_with_required_expiry;
                 CREATE INDEX share_links_creator ON share_links (created_by, vault_slug);
                 COMMIT;",
            )
            .map_err(Error::Database)
    }

    fn ensure_cookie_signing_key(&self) -> Result<(), Error> {
        let count: i64 = self
            .connection
            .query_row(
                "SELECT COUNT(*) FROM session_cookie_keys WHERE is_current = 1",
                [],
                |row| row.get(0),
            )
            .map_err(Error::Database)?;
        if count == 0 {
            self.connection
                .execute(
                    "INSERT INTO session_cookie_keys (secret, created_at, is_current) VALUES (?1, ?2, 1)",
                    params![random_secret(), now_seconds()?],
                )
                .map_err(Error::Database)?;
        }
        Ok(())
    }

    fn current_cookie_secret(&self) -> Result<String, Error> {
        self.connection
            .query_row(
                "SELECT secret FROM session_cookie_keys WHERE is_current = 1",
                [],
                |row| row.get(0),
            )
            .map_err(Error::Database)
    }

    fn is_last_enabled_admin(&self, user_id: UserId) -> Result<bool, Error> {
        let account: Option<(bool, bool)> = self
            .connection
            .query_row(
                "SELECT disabled, is_admin FROM users WHERE id = ?1",
                [user_id.get()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(Error::Database)?;
        let Some((disabled, is_admin)) = account else {
            return Err(Error::UnknownUser);
        };
        if disabled || !is_admin {
            return Ok(false);
        }
        let enabled_admins: i64 = self
            .connection
            .query_row(
                "SELECT COUNT(*) FROM users WHERE is_admin = 1 AND disabled = 0",
                [],
                |row| row.get(0),
            )
            .map_err(Error::Database)?;
        Ok(enabled_admins == 1)
    }
}

struct UserRecord {
    user: User,
    password_hash: String,
}

fn insert_user(
    connection: &Connection,
    new_user: NewUser<'_>,
    is_admin: bool,
) -> Result<User, Error> {
    validate_username(new_user.username)?;
    validate_display_name(new_user.display_name)?;
    validate_password(new_user.password)?;
    let password_hash = hash_password(new_user.password)?;
    let created_at = now_seconds()?;
    connection
        .execute(
            "INSERT INTO users (username, display_name, password_hash, created_at, disabled, is_admin) \
             VALUES (?1, ?2, ?3, ?4, 0, ?5)",
            params![
                new_user.username,
                new_user.display_name,
                password_hash,
                created_at,
                is_admin
            ],
        )
        .map_err(|error| match error {
            rusqlite::Error::SqliteFailure(failure, _) if failure.code == rusqlite::ErrorCode::ConstraintViolation => Error::DuplicateUsername,
            other => Error::Database(other),
        })?;
    Ok(User {
        id: UserId(connection.last_insert_rowid()),
        username: new_user.username.to_string(),
        display_name: new_user.display_name.to_string(),
        disabled: false,
        is_admin,
    })
}

fn validate_username(value: &str) -> Result<(), Error> {
    let valid = !value.is_empty()
        && value.len() <= 64
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
        });
    if valid {
        Ok(())
    } else {
        Err(Error::InvalidUsername)
    }
}

fn validate_display_name(value: &str) -> Result<(), Error> {
    if value.trim().is_empty() || value.len() > 128 || value.contains('\0') {
        Err(Error::InvalidDisplayName)
    } else {
        Ok(())
    }
}

fn validate_password(value: &str) -> Result<(), Error> {
    if value.len() < 12 || value.len() > 1024 {
        Err(Error::InvalidPassword)
    } else {
        Ok(())
    }
}

fn hash_password(password: &str) -> Result<String, Error> {
    let salt = SaltString::generate(&mut OsRng);
    let params = Params::new(19 * 1024, 2, 1, None).map_err(|_| Error::PasswordHash)?;
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|_| Error::PasswordHash)
}

fn verify_password(password: &str, hash: &str) -> Result<bool, Error> {
    let parsed = PasswordHash::new(hash).map_err(|_| Error::PasswordHash)?;
    Ok(Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok())
}

fn now_seconds() -> Result<i64, Error> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| Error::Clock)
        .and_then(|duration| i64::try_from(duration.as_secs()).map_err(|_| Error::Clock))
}

fn digest(value: &str) -> String {
    hex(&Sha256::digest(value.as_bytes()))
}

fn random_secret() -> String {
    let mut raw = [0_u8; 32];
    OsRng.fill_bytes(&mut raw);
    hex(&raw)
}

fn share_token() -> ShareToken {
    let mut raw = [0_u8; 16];
    OsRng.fill_bytes(&mut raw);
    ShareToken(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw))
}

fn validate_share_path(value: &str) -> Result<(), Error> {
    let valid = !value.is_empty()
        && !value.starts_with('/')
        && !value.ends_with('/')
        && !value.contains('\0')
        && value
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..");
    if valid {
        Ok(())
    } else {
        Err(Error::InvalidSharePath)
    }
}

fn hmac_sha256_hex(key: &[u8], message: &[u8]) -> String {
    const BLOCK_SIZE: usize = 64;
    let mut key_block = [0_u8; BLOCK_SIZE];
    if key.len() > BLOCK_SIZE {
        key_block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        for (destination, source) in key_block.iter_mut().zip(key) {
            *destination = *source;
        }
    }
    let mut inner = Sha256::new();
    for byte in key_block {
        inner.update([byte ^ 0x36]);
    }
    inner.update(message);
    let inner_digest = inner.finalize();
    let mut outer = Sha256::new();
    for byte in key_block {
        outer.update([byte ^ 0x5c]);
    }
    outer.update(inner_digest);
    hex(&outer.finalize())
}

fn is_hex_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0_u8;
    for (&a, &b) in left.iter().zip(right) {
        difference |= a ^ b;
    }
    difference == 0
}

fn validate_vault_slug(value: &str) -> Result<(), Error> {
    let valid = !value.is_empty()
        && value.len() <= 64
        && !value.starts_with('-')
        && !value.ends_with('-')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    if valid {
        Ok(())
    } else {
        Err(Error::InvalidVaultSlug)
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(hex_nibble(byte >> 4));
        encoded.push(hex_nibble(byte & 0x0f));
    }
    encoded
}

fn hex_nibble(value: u8) -> char {
    match value {
        0..=9 => char::from(b'0' + value),
        10..=15 => char::from(b'a' + (value - 10)),
        // Both callers mask their input to four bits. Keeping this total avoids turning a
        // future caller mistake into a process-wide panic in an authentication path.
        _ => '0',
    }
}

// Generated once with Argon2id and intentionally held constant. It equalizes unknown-user
// login work without retaining a real account credential in the binary.
const DUMMY_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$ZHVtbXktc2FsdC0xNmJ5dGVz$7bKq0ytZuZpV0J2ijXU1sNA5f7pGwkyoOQsd6u9QJxM";

/// Authentication storage or credential validation failed.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// SQLite failed.
    #[error("auth database: {0}")]
    Database(rusqlite::Error),
    /// The first-run setup has already created an administrator.
    #[error("first-run setup has already completed")]
    SetupAlreadyComplete,
    /// A username already exists.
    #[error("username is already in use")]
    DuplicateUsername,
    /// The username is not a durable ACL-compatible identifier.
    #[error("username must be 1-64 lowercase ASCII letters, digits, hyphens, or underscores")]
    InvalidUsername,
    /// The display name is blank, too long, or contains a NUL byte.
    #[error("display name must be 1-128 non-NUL characters")]
    InvalidDisplayName,
    /// The password is outside the accepted length range.
    #[error("password must be between 12 and 1024 bytes")]
    InvalidPassword,
    /// Argon2 could not create or parse a password hash.
    #[error("password hashing failed")]
    PasswordHash,
    /// The requested user does not exist.
    #[error("unknown user")]
    UnknownUser,
    /// Removing the final active server administrator would lock out administration.
    #[error("cannot remove the last enabled server administrator")]
    LastAdmin,
    /// The system clock predates the Unix epoch or exceeds SQLite's supported range.
    #[error("system clock is invalid")]
    Clock,
    /// A session expiry was not in the future.
    #[error("session expiry must be in the future")]
    InvalidSessionExpiry,
    /// A disabled account cannot receive a new session.
    #[error("disabled users cannot create sessions")]
    DisabledUser,
    /// The token scope is not a usable vault slug.
    #[error("API token vault scope must be a valid vault slug")]
    InvalidVaultSlug,
    /// API tokens cannot be issued with a no-access role.
    #[error("API token role must be owner, editor, or viewer")]
    InvalidTokenRole,
    /// Invites cannot grant a no-access role.
    #[error("invite role must be owner, editor, or viewer")]
    InvalidInviteRole,
    /// An invite expiry was not in the future.
    #[error("invite expiry must be in the future")]
    InvalidInviteExpiry,
    /// The invite is missing, expired, or was already accepted.
    #[error("invite is invalid, expired, or already accepted")]
    InvalidInvite,
    /// Existing database data contains an unsupported token role.
    #[error("stored API token has an invalid role")]
    InvalidStoredTokenRole,
    /// Existing database data contains an unsupported invite role.
    #[error("stored invite has an invalid role")]
    InvalidStoredInviteRole,
    /// A public link expiry was not in the future.
    #[error("share link expiry must be in the future")]
    InvalidShareExpiry,
    /// A public link path is not a contained vault-relative note path.
    #[error("share link note path is invalid")]
    InvalidSharePath,
}
