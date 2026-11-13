//! Device sign-in (`SPEC.md` §6.8.1, E36): one-time approval codes and device tokens.
//!
//! A device — the desktop app — never sees its user's password. The user approves it in
//! their own browser; the server stores a one-time code bound to the device's loopback
//! redirect URI and PKCE challenge, and the device exchanges that code, with the verifier
//! only it knows, for a long-lived device token. Both secrets are stored only as SHA-256.

use base64::Engine;
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use sha2::{Digest, Sha256};

use crate::{AuthDb, Error, User, UserId, digest, now_seconds, random_secret};

/// How long an approval code can be exchanged for, in seconds.
pub const DEVICE_CODE_SECONDS: i64 = 60;

const DEVICE_TOKEN_PREFIX: &str = "mbd_";
const CALLBACK_PATH: &str = "/desktop/connect/callback";

/// A device's bearer credential. Its plaintext is returned only when issued.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceToken(String);

impl DeviceToken {
    /// Reconstructs a token received in an `Authorization: Bearer` header.
    #[must_use]
    pub fn from_secret(value: &str) -> Option<Self> {
        let hex = value.strip_prefix(DEVICE_TOKEN_PREFIX)?;
        is_lower_hex_64(hex).then(|| Self(value.to_string()))
    }

    /// Returns the bearer value. Callers must keep it secret.
    #[must_use]
    pub fn expose_secret(&self) -> &str {
        &self.0
    }
}

/// A one-time approval code, as it arrives at the token endpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceCode(String);

impl DeviceCode {
    /// Reconstructs a code received from a device.
    #[must_use]
    pub fn from_secret(value: &str) -> Option<Self> {
        is_lower_hex_64(value).then(|| Self(value.to_string()))
    }

    /// Returns the code. Callers must keep it secret.
    #[must_use]
    pub fn expose_secret(&self) -> &str {
        &self.0
    }
}

/// Stable non-secret identifier for one device token.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct DeviceId(i64);

impl DeviceId {
    /// Wraps an identifier from a management route or CLI argument.
    #[must_use]
    pub const fn new(id: i64) -> Self {
        Self(id)
    }

    /// Returns the database identifier.
    #[must_use]
    pub const fn get(self) -> i64 {
        self.0
    }
}

/// What a user approved: which device, returning where, proving what.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeviceApproval<'a> {
    /// The approving, signed-in user.
    pub user_id: UserId,
    /// The name the device gave itself, shown on the approval page and in device lists.
    pub device_name: &'a str,
    /// The device's loopback callback; see [`valid_redirect_uri`].
    pub redirect_uri: &'a str,
    /// `BASE64URL(SHA-256(code_verifier))`; see [`valid_pkce_value`].
    pub code_challenge: &'a str,
}

/// A successful exchange: the new token and the account it acts as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceGrant {
    /// The device's bearer credential. Returned once, never stored in plaintext.
    pub token: DeviceToken,
    /// The token's identifier, for revocation.
    pub device_id: DeviceId,
    /// The account the device acts as.
    pub user: User,
}

/// Who an authenticated device token acts as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceIdentity {
    /// The token's identifier.
    pub device_id: DeviceId,
    /// The device's name.
    pub device_name: String,
    /// The account it acts as. Always enabled: a disabled user's devices do not authenticate.
    pub user: User,
}

/// A non-secret device-token record for a device list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceRecord {
    /// Identifier used for revocation.
    pub id: DeviceId,
    /// The device's name.
    pub name: String,
    /// Creation time as a Unix timestamp.
    pub created_at: i64,
    /// Most recent successful use, when any.
    pub last_used_at: Option<i64>,
    /// Revocation time, when revoked.
    pub revoked_at: Option<i64>,
}

/// Whether `uri` is a device callback a code may be sent to.
///
/// Exactly `http://127.0.0.1:<port>/desktop/connect/callback`, port 1–65535 without leading
/// zeros. A code sent anywhere else is a credential handed to whoever runs that address,
/// so there is no allowlist to configure and no other form is accepted.
#[must_use]
pub fn valid_redirect_uri(uri: &str) -> bool {
    let Some(rest) = uri.strip_prefix("http://127.0.0.1:") else {
        return false;
    };
    let Some(port) = rest.strip_suffix(CALLBACK_PATH) else {
        return false;
    };
    !port.is_empty()
        && !port.starts_with('0')
        && port.bytes().all(|b| b.is_ascii_digit())
        && port.parse::<u16>().is_ok_and(|port| port > 0)
}

/// Whether `value` is a usable PKCE verifier, challenge or `state`: 43–128 characters of
/// RFC 7636's unreserved set.
#[must_use]
pub fn valid_pkce_value(value: &str) -> bool {
    (43..=128).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~'))
}

/// Whether `name` is a usable device name: 1–64 characters, none of them control characters.
#[must_use]
pub fn valid_device_name(name: &str) -> bool {
    let count = name.chars().count();
    (1..=64).contains(&count) && !name.chars().any(char::is_control) && !name.trim().is_empty()
}

/// `BASE64URL(SHA-256(verifier))` without padding: RFC 7636's S256 challenge.
#[must_use]
pub fn pkce_challenge(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

impl AuthDb {
    pub(crate) fn migrate_devices(&self) -> Result<(), Error> {
        self.connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS device_authorizations (
                    code_hash TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    device_name TEXT NOT NULL,
                    redirect_uri TEXT NOT NULL,
                    code_challenge TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    used_at INTEGER
                 );
                 CREATE INDEX IF NOT EXISTS device_authorizations_expiry
                    ON device_authorizations (expires_at);
                 CREATE TABLE IF NOT EXISTS device_tokens (
                    id INTEGER PRIMARY KEY,
                    token_hash TEXT NOT NULL UNIQUE,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    last_used_at INTEGER,
                    revoked_at INTEGER
                 );
                 CREATE INDEX IF NOT EXISTS device_tokens_user ON device_tokens (user_id);",
            )
            .map_err(Error::Database)
    }

    /// Records a user's approval and returns the one-time code to send to the device.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidDeviceApproval`] for a malformed name, redirect URI or challenge;
    /// [`Error::DisabledUser`] or [`Error::UnknownUser`] for an account that cannot approve.
    pub fn approve_device(&self, approval: DeviceApproval<'_>) -> Result<DeviceCode, Error> {
        self.approve_device_at(approval, now_seconds()?)
    }

    /// [`AuthDb::approve_device`] at an explicit time, for tests and callers with a clock.
    ///
    /// # Errors
    ///
    /// As [`AuthDb::approve_device`].
    pub fn approve_device_at(
        &self,
        approval: DeviceApproval<'_>,
        now: i64,
    ) -> Result<DeviceCode, Error> {
        if !valid_device_name(approval.device_name)
            || !valid_redirect_uri(approval.redirect_uri)
            || !valid_pkce_value(approval.code_challenge)
        {
            return Err(Error::InvalidDeviceApproval);
        }
        self.require_enabled(approval.user_id)?;
        // Expired, never-exchanged codes are useless; clearing them here keeps the table
        // bounded without a sweep of its own.
        self.connection
            .execute(
                "DELETE FROM device_authorizations WHERE expires_at < ?1",
                [now],
            )
            .map_err(Error::Database)?;
        let code = DeviceCode(random_secret());
        self.connection
            .execute(
                "INSERT INTO device_authorizations \
                 (code_hash, user_id, device_name, redirect_uri, code_challenge, expires_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    digest(code.expose_secret()),
                    approval.user_id.get(),
                    approval.device_name,
                    approval.redirect_uri,
                    approval.code_challenge,
                    now.saturating_add(DEVICE_CODE_SECONDS),
                ],
            )
            .map_err(Error::Database)?;
        Ok(code)
    }

    /// Exchanges a code for a device token, or `None` for every kind of failure.
    ///
    /// The code is spent by this call whatever the outcome, so a guessed or intercepted code
    /// gets exactly one try.
    ///
    /// # Errors
    ///
    /// Only for database or clock failures. An invalid grant is `Ok(None)`.
    pub fn exchange_device_code(
        &mut self,
        code: &DeviceCode,
        code_verifier: &str,
        redirect_uri: &str,
    ) -> Result<Option<DeviceGrant>, Error> {
        self.exchange_device_code_at(code, code_verifier, redirect_uri, now_seconds()?)
    }

    /// [`AuthDb::exchange_device_code`] at an explicit time.
    ///
    /// # Errors
    ///
    /// As [`AuthDb::exchange_device_code`].
    pub fn exchange_device_code_at(
        &mut self,
        code: &DeviceCode,
        code_verifier: &str,
        redirect_uri: &str,
        now: i64,
    ) -> Result<Option<DeviceGrant>, Error> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(Error::Database)?;
        let code_hash = digest(code.expose_secret());
        let stored = transaction
            .query_row(
                "SELECT user_id, device_name, redirect_uri, code_challenge, expires_at \
                 FROM device_authorizations WHERE code_hash = ?1 AND used_at IS NULL",
                [&code_hash],
                |row| {
                    Ok((
                        UserId(row.get(0)?),
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                },
            )
            .optional()
            .map_err(Error::Database)?;
        let Some((user_id, device_name, stored_uri, challenge, expires_at)) = stored else {
            return Ok(None);
        };
        transaction
            .execute(
                "UPDATE device_authorizations SET used_at = ?1 WHERE code_hash = ?2",
                params![now, code_hash],
            )
            .map_err(Error::Database)?;
        let proven = valid_pkce_value(code_verifier)
            && crate::constant_time_eq(
                pkce_challenge(code_verifier).as_bytes(),
                challenge.as_bytes(),
            );
        let user = crate::user_by_id_in(&transaction, user_id)?;
        let Some(user) = user.filter(|user| !user.disabled) else {
            transaction.commit().map_err(Error::Database)?;
            return Ok(None);
        };
        if now > expires_at || stored_uri != redirect_uri || !proven {
            transaction.commit().map_err(Error::Database)?;
            return Ok(None);
        }
        let token = DeviceToken(format!("{DEVICE_TOKEN_PREFIX}{}", random_secret()));
        transaction
            .execute(
                "INSERT INTO device_tokens (token_hash, user_id, name, created_at) \
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    digest(token.expose_secret()),
                    user_id.get(),
                    device_name,
                    now
                ],
            )
            .map_err(Error::Database)?;
        let device_id = DeviceId(transaction.last_insert_rowid());
        transaction.commit().map_err(Error::Database)?;
        Ok(Some(DeviceGrant {
            token,
            device_id,
            user,
        }))
    }

    /// Authenticates a live device token of an enabled user, and records its use.
    ///
    /// # Errors
    ///
    /// Only for database or clock failures.
    pub fn authenticate_device_token(
        &self,
        token: &DeviceToken,
    ) -> Result<Option<DeviceIdentity>, Error> {
        let token_hash = digest(token.expose_secret());
        let found = self
            .connection
            .query_row(
                "SELECT d.id, d.name, d.user_id FROM device_tokens d JOIN users u ON u.id = d.user_id \
                 WHERE d.token_hash = ?1 AND d.revoked_at IS NULL AND u.disabled = 0",
                [&token_hash],
                |row| {
                    Ok((
                        DeviceId(row.get(0)?),
                        row.get::<_, String>(1)?,
                        UserId(row.get(2)?),
                    ))
                },
            )
            .optional()
            .map_err(Error::Database)?;
        let Some((device_id, device_name, user_id)) = found else {
            return Ok(None);
        };
        let Some(user) = self.user_by_id(user_id)? else {
            return Ok(None);
        };
        self.connection
            .execute(
                "UPDATE device_tokens SET last_used_at = ?1 WHERE id = ?2",
                params![now_seconds()?, device_id.get()],
            )
            .map_err(Error::Database)?;
        Ok(Some(DeviceIdentity {
            device_id,
            device_name,
            user,
        }))
    }

    /// Revokes the presenting device's token. Repeating it is harmless.
    ///
    /// # Errors
    ///
    /// Only for database or clock failures.
    pub fn revoke_device_token(&self, token: &DeviceToken) -> Result<(), Error> {
        self.connection
            .execute(
                "UPDATE device_tokens SET revoked_at = ?1 WHERE token_hash = ?2 AND revoked_at IS NULL",
                params![now_seconds()?, digest(token.expose_secret())],
            )
            .map(|_| ())
            .map_err(Error::Database)
    }

    /// Revokes one device by identifier, for an operator. Returns whether a live token was
    /// revoked.
    ///
    /// # Errors
    ///
    /// Only for database or clock failures.
    pub fn revoke_device_by_id(&self, id: DeviceId) -> Result<bool, Error> {
        self.connection
            .execute(
                "UPDATE device_tokens SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL",
                params![now_seconds()?, id.get()],
            )
            .map(|changed| changed > 0)
            .map_err(Error::Database)
    }

    /// Every device token a user has had, newest first, revoked ones included.
    ///
    /// # Errors
    ///
    /// Only for database failures.
    pub fn list_devices(&self, user_id: UserId) -> Result<Vec<DeviceRecord>, Error> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT id, name, created_at, last_used_at, revoked_at FROM device_tokens \
                 WHERE user_id = ?1 ORDER BY id DESC",
            )
            .map_err(Error::Database)?;
        let rows = statement
            .query_map([user_id.get()], |row| {
                Ok(DeviceRecord {
                    id: DeviceId(row.get(0)?),
                    name: row.get(1)?,
                    created_at: row.get(2)?,
                    last_used_at: row.get(3)?,
                    revoked_at: row.get(4)?,
                })
            })
            .map_err(Error::Database)?;
        rows.collect::<Result<_, _>>().map_err(Error::Database)
    }

    fn require_enabled(&self, user_id: UserId) -> Result<(), Error> {
        match self.user_by_id(user_id)? {
            Some(user) if !user.disabled => Ok(()),
            Some(_) => Err(Error::DisabledUser),
            None => Err(Error::UnknownUser),
        }
    }
}

fn is_lower_hex_64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
