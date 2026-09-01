//! Invite orchestration across `auth.db` and durable vault ACLs.

use mb_auth::{AuthDb, InviteScope, InviteToken, NewUser};
use mb_core::{Access, Member, Role, Username};

use crate::{AccessFile, Vault};

/// Issues an invite only when the authenticated actor is a vault owner.
pub fn issue(
    vault: &Vault,
    access: &AccessFile,
    auth: &AuthDb,
    actor: &Username,
    role: Role,
    expires_at: i64,
) -> Result<InviteToken, InviteError> {
    let is_owner = access
        .policy()
        .members()
        .any(|(user, assigned)| user == actor && assigned == Role::Owner);
    if !is_owner {
        return Err(InviteError::Denied);
    }
    let user = auth
        .user_by_username(actor.as_str())?
        .ok_or(InviteError::Denied)?;
    auth.create_invite(InviteScope {
        issuer_user_id: user.id,
        vault_slug: vault.slug().as_str().to_string(),
        role,
        expires_at,
    })
    .map_err(InviteError::Auth)
}

/// Accepts an invite and atomically restores the old ACL if account creation fails.
pub fn accept(
    vault: &Vault,
    auth: &mut AuthDb,
    token: &InviteToken,
    new_user: NewUser<'_>,
) -> Result<InviteScope, InviteError> {
    let scope = auth.invite_scope(token)?.ok_or(InviteError::Invalid)?;
    if scope.vault_slug != vault.slug().as_str() {
        return Err(InviteError::Invalid);
    }
    let original = AccessFile::load(vault.root())?;
    let username = Username::parse(new_user.username).map_err(InviteError::Acl)?;
    let mut members: Vec<Member> = original
        .policy()
        .members()
        .map(|(user, role)| Member {
            user: user.clone(),
            role,
        })
        .collect();
    members.push(Member {
        user: username,
        role: scope.role,
    });
    let rules = original.policy().rules().cloned().collect();
    let updated = AccessFile::from_access(Access::new(members, rules).map_err(InviteError::Acl)?);
    updated.save(vault.root())?;
    if let Err(error) = auth.accept_invite(token, new_user) {
        original.save(vault.root())?;
        return Err(InviteError::Auth(error));
    }
    Ok(scope)
}

/// Invite service failure.
#[derive(Debug, thiserror::Error)]
pub enum InviteError {
    #[error("invite denied")]
    Denied,
    #[error("invite is invalid, expired, or for another vault")]
    Invalid,
    #[error("authentication: {0}")]
    Auth(#[from] mb_auth::Error),
    #[error("access: {0}")]
    Access(#[from] crate::access::AccessError),
    #[error("ACL: {0}")]
    Acl(mb_core::AclError),
}
