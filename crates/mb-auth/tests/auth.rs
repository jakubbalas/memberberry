//! Authentication persistence tests (`SPEC.md` §6.8).

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use mb_auth::{
    ApiToken, ApiTokenScope, AuthDb, Error, InviteScope, InviteToken, NewUser, SessionToken,
    ShareLinkScope, ShareToken,
};
use mb_core::Role;

const PASSWORD: &str = "correct horse battery staple";

fn new_user(username: &str) -> NewUser<'_> {
    NewUser {
        username,
        display_name: "Alice Example",
        password: PASSWORD,
    }
}

#[test]
fn first_run_setup_creates_the_only_initial_server_administrator() {
    let mut db = AuthDb::open_in_memory().expect("open auth db");
    assert!(db.needs_setup().expect("setup state"));

    let user = db.setup_first_user(new_user("alice")).expect("setup user");
    assert!(user.is_admin);
    assert!(!user.disabled);
    assert!(!db.needs_setup().expect("setup state"));

    assert!(matches!(
        db.setup_first_user(new_user("bob")),
        Err(Error::SetupAlreadyComplete)
    ));
}

#[test]
fn password_authentication_accepts_only_the_right_active_account() {
    let mut db = AuthDb::open_in_memory().expect("open auth db");
    let alice = db.setup_first_user(new_user("alice")).expect("setup user");

    assert_eq!(
        db.authenticate("alice", PASSWORD).expect("authenticate"),
        Some(alice.clone())
    );
    assert_eq!(
        db.authenticate("alice", "wrong password")
            .expect("authenticate"),
        None
    );
    assert_eq!(
        db.authenticate("nobody", PASSWORD).expect("authenticate"),
        None
    );

    db.set_disabled(alice.id, true)
        .expect_err("last admin remains active");
    let bob = db.create_user(new_user("bob")).expect("create user");
    db.set_disabled(bob.id, true).expect("disable user");
    assert_eq!(
        db.authenticate("bob", PASSWORD).expect("authenticate"),
        None
    );
}

#[test]
fn password_reset_invalidates_the_previous_password() {
    let mut db = AuthDb::open_in_memory().expect("open auth db");
    let alice = db.setup_first_user(new_user("alice")).expect("setup user");
    let replacement = "another correct horse battery staple";
    let session = db
        .create_session(alice.id, 4_102_444_800)
        .expect("create session");

    db.reset_password(alice.id, replacement)
        .expect("reset password");
    assert_eq!(
        db.authenticate("alice", PASSWORD).expect("authenticate"),
        None
    );
    assert_eq!(
        db.authenticate("alice", replacement).expect("authenticate"),
        Some(alice)
    );
    assert_eq!(
        db.authenticate_session(&session)
            .expect("authenticate revoked session"),
        None
    );
}

#[test]
fn user_validation_and_duplicate_usernames_are_rejected() {
    let mut db = AuthDb::open_in_memory().expect("open auth db");
    db.setup_first_user(new_user("alice")).expect("setup user");
    assert!(matches!(
        db.create_user(new_user("alice")),
        Err(Error::DuplicateUsername)
    ));
    assert!(matches!(
        db.create_user(NewUser {
            username: "Alice",
            display_name: "Alice",
            password: PASSWORD,
        }),
        Err(Error::InvalidUsername)
    ));
    assert!(matches!(
        db.create_user(NewUser {
            username: "carol",
            display_name: "Carol",
            password: "short",
        }),
        Err(Error::InvalidPassword)
    ));
}

#[test]
fn sessions_are_opaque_revocable_and_disabled_with_their_user() {
    let mut db = AuthDb::open_in_memory().expect("open auth db");
    let alice = db.setup_first_user(new_user("alice")).expect("setup user");
    let expiry = 4_102_444_800; // 2100-01-01: stable future date for this test.
    let token = db.create_session(alice.id, expiry).expect("create session");

    assert_eq!(
        db.authenticate_session(&token)
            .expect("authenticate session"),
        Some(alice.clone())
    );
    db.revoke_session(&token).expect("revoke session");
    assert_eq!(
        db.authenticate_session(&token)
            .expect("authenticate session"),
        None
    );

    let token = db.create_session(alice.id, expiry).expect("create session");
    let bob = db.create_user(new_user("bob")).expect("create user");
    db.set_admin(bob.id, true).expect("promote second admin");
    db.set_disabled(alice.id, true)
        .expect("disable admin with another active account");
    assert_eq!(
        db.authenticate_session(&token)
            .expect("authenticate session"),
        None
    );
    assert!(
        db.user_by_username("bob")
            .expect("load promoted user")
            .expect("bob exists")
            .is_admin
    );
}

#[test]
fn session_cookies_are_signed_tamper_proof_and_survive_key_rotation() {
    let mut db = AuthDb::open_in_memory().expect("open auth db");
    let alice = db.setup_first_user(new_user("alice")).expect("setup user");
    let token = db
        .create_session(alice.id, 4_102_444_800)
        .expect("create session");
    let cookie = db.signed_session_cookie(&token).expect("sign cookie");

    assert_eq!(
        db.authenticate_signed_session_cookie(&cookie)
            .expect("authenticate cookie"),
        Some(alice.clone())
    );
    assert_eq!(
        db.authenticate_signed_session_cookie(token.expose_secret())
            .expect("authenticate unsigned cookie"),
        None
    );
    let tampered = format!("{cookie}0");
    assert_eq!(
        db.authenticate_signed_session_cookie(&tampered)
            .expect("authenticate tampered cookie"),
        None
    );

    db.rotate_session_cookie_secret().expect("rotate key");
    let rotated_cookie = db.signed_session_cookie(&token).expect("sign cookie");
    assert_ne!(cookie, rotated_cookie);
    assert_eq!(
        db.authenticate_signed_session_cookie(&cookie)
            .expect("authenticate retired cookie"),
        Some(alice.clone())
    );
    assert_eq!(
        db.authenticate_signed_session_cookie(&rotated_cookie)
            .expect("authenticate current cookie"),
        Some(alice)
    );
}

#[test]
fn scoped_api_tokens_are_vault_bound_revocable_and_return_their_scope() {
    let mut db = AuthDb::open_in_memory().expect("open auth db");
    let alice = db.setup_first_user(new_user("alice")).expect("setup user");
    let token = db
        .create_api_token(ApiTokenScope {
            user_id: alice.id,
            vault_slug: "personal".to_string(),
            role: Role::Editor,
        })
        .expect("issue token");
    assert_eq!(
        db.authenticate_api_token(&token)
            .expect("authenticate token"),
        Some(ApiTokenScope {
            user_id: alice.id,
            vault_slug: "personal".to_string(),
            role: Role::Editor,
        })
    );
    let listed = db.list_api_tokens(alice.id).expect("list tokens");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].vault_slug, "personal");
    assert_eq!(listed[0].role, Role::Editor);
    assert!(listed[0].last_used_at.is_some());
    db.revoke_api_token_by_id(alice.id, listed[0].id)
        .expect("revoke token by ID");
    assert_eq!(
        db.authenticate_api_token(&token)
            .expect("authenticate token"),
        None
    );

    let bob = db.create_user(new_user("bob")).expect("create user");
    let second = db
        .create_api_token(ApiTokenScope {
            user_id: alice.id,
            vault_slug: "personal".to_string(),
            role: Role::Viewer,
        })
        .expect("issue second token");
    let second_id = db.list_api_tokens(alice.id).expect("list tokens")[0].id;
    db.revoke_api_token_by_id(bob.id, second_id)
        .expect("foreign revoke is opaque");
    assert!(
        db.authenticate_api_token(&second)
            .expect("authenticate token")
            .is_some()
    );
}

#[test]
fn share_links_use_url_safe_opaque_tokens_and_require_their_password() {
    let mut db = AuthDb::open_in_memory().expect("open auth db");
    let alice = db.setup_first_user(new_user("alice")).expect("setup user");
    let token = db
        .create_share_link(ShareLinkScope {
            vault_slug: "personal".to_string(),
            note_path: "Projects/Roadmap.md".to_string(),
            include_embeds: true,
            password: Some(PASSWORD.to_string()),
            expires_at: Some(4_102_444_800),
            created_by: alice.id,
        })
        .expect("create share link");
    assert_eq!(token.expose_secret().len(), 22);
    assert!(ShareToken::from_secret(token.expose_secret()).is_some());
    assert!(
        db.authenticate_share_link(&token, Some("wrong password"))
            .expect("wrong password")
            .is_none()
    );
    let link = db
        .authenticate_share_link(&token, Some(PASSWORD))
        .expect("authenticate share link")
        .expect("active link");
    assert_eq!(link.scope.note_path, "Projects/Roadmap.md");
    assert_eq!(link.access_count, 0);
    assert!(link.last_accessed_at.is_none());
    assert!(db.record_share_link_access(&token).expect("record access"));
    let listed = db
        .list_share_links(alice.id, "personal")
        .expect("list share links");
    assert_eq!(listed[0].access_count, 1);
    assert!(listed[0].last_accessed_at.is_some());

    db.revoke_share_link(alice.id, &token)
        .expect("revoke share link");
    assert!(
        db.authenticate_share_link(&token, Some(PASSWORD))
            .expect("revoked share link")
            .is_none()
    );
}

#[test]
fn share_links_reject_invalid_paths_expiry_and_passwords() {
    let mut db = AuthDb::open_in_memory().expect("open auth db");
    let alice = db.setup_first_user(new_user("alice")).expect("setup user");
    let scope =
        |note_path: &str, expires_at: Option<i64>, password: Option<String>| ShareLinkScope {
            vault_slug: "personal".to_string(),
            note_path: note_path.to_string(),
            include_embeds: false,
            password,
            expires_at,
            created_by: alice.id,
        };
    assert!(matches!(
        db.create_share_link(scope("../private.md", Some(4_102_444_800), None)),
        Err(Error::InvalidSharePath)
    ));
    assert!(matches!(
        db.create_share_link(scope("note.md", Some(1), None)),
        Err(Error::InvalidShareExpiry)
    ));
    assert!(matches!(
        db.create_share_link(scope(
            "note.md",
            Some(4_102_444_800),
            Some("short".to_string())
        )),
        Err(Error::InvalidPassword)
    ));
    assert!(db.create_share_link(scope("note.md", None, None)).is_ok());
    assert!(ShareToken::from_secret("not-a-share-token").is_none());
}

#[test]
fn existing_share_tables_are_migrated_to_allow_no_expiry() {
    let path = std::env::temp_dir().join(format!(
        "memberberry-auth-share-migration-{}-{}.db",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos()
    ));
    let connection = rusqlite::Connection::open(&path).expect("old database");
    connection
        .execute_batch(
            "CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                username TEXT NOT NULL UNIQUE COLLATE BINARY,
                display_name TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
                is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1))
             );
             INSERT INTO users
                (id, username, display_name, password_hash, created_at, disabled, is_admin)
             VALUES (1, 'alice', 'Alice', 'unused', 1, 0, 1);
             CREATE TABLE share_links (
                token_hash TEXT PRIMARY KEY,
                vault_slug TEXT NOT NULL,
                note_path TEXT NOT NULL,
                include_embeds INTEGER NOT NULL CHECK (include_embeds IN (0, 1)),
                password_hash TEXT,
                expires_at INTEGER NOT NULL,
                created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at INTEGER NOT NULL,
                revoked_at INTEGER,
                access_count INTEGER NOT NULL DEFAULT 0,
                last_accessed_at INTEGER
             );
             CREATE INDEX share_links_creator ON share_links (created_by, vault_slug);",
        )
        .expect("old schema");
    drop(connection);

    let db = AuthDb::open(&path).expect("migrated auth db");
    let alice = db
        .user_by_username("alice")
        .expect("lookup")
        .expect("alice");
    db.create_share_link(ShareLinkScope {
        vault_slug: "personal".to_string(),
        note_path: "Welcome.md".to_string(),
        include_embeds: false,
        password: None,
        expires_at: None,
        created_by: alice.id,
    })
    .expect("never-expiring share after migration");
    drop(db);
    std::fs::remove_file(path).expect("remove test database");
}

#[test]
fn share_media_cookie_is_signed_and_revocation_aware() {
    let mut db = AuthDb::open_in_memory().expect("open auth db");
    let alice = db.setup_first_user(new_user("alice")).expect("setup user");
    let token = db
        .create_share_link(ShareLinkScope {
            vault_slug: "personal".to_string(),
            note_path: "note.md".to_string(),
            include_embeds: false,
            password: Some(PASSWORD.to_string()),
            expires_at: Some(4_102_444_800),
            created_by: alice.id,
        })
        .expect("create share link");
    let cookie = db.signed_share_cookie(&token).expect("sign cookie");
    assert!(
        db.authenticate_share_cookie(&cookie)
            .expect("authenticate cookie")
            .is_some()
    );
    let tampered = format!("{cookie}0");
    assert!(
        db.authenticate_share_cookie(&tampered)
            .expect("tampered cookie")
            .is_none()
    );
    db.revoke_share_link(alice.id, &token).expect("revoke");
    assert!(
        db.authenticate_share_cookie(&cookie)
            .expect("revoked cookie")
            .is_none()
    );
}

#[test]
fn an_invite_creates_one_new_user_and_cannot_be_accepted_twice() {
    let mut db = AuthDb::open_in_memory().expect("open auth db");
    let alice = db.setup_first_user(new_user("alice")).expect("setup user");
    let scope = InviteScope {
        issuer_user_id: alice.id,
        vault_slug: "personal".to_string(),
        role: Role::Viewer,
        expires_at: 4_102_444_800,
    };
    let invite = db.create_invite(scope.clone()).expect("create invite");

    assert_eq!(
        db.accept_invite(&invite, new_user("bob"))
            .expect("accept invite"),
        scope
    );
    assert!(
        db.authenticate("bob", PASSWORD)
            .expect("authenticate new account")
            .is_some()
    );
    assert!(matches!(
        db.accept_invite(&invite, new_user("carol")),
        Err(Error::InvalidInvite)
    ));
}

#[test]
fn invalid_bearers_and_invalid_or_disabled_issuers_fail_closed() {
    let mut db = AuthDb::open_in_memory().expect("open auth db");
    let alice = db.setup_first_user(new_user("alice")).expect("setup user");
    let bob = db.create_user(new_user("bob")).expect("create user");

    assert!(SessionToken::from_secret("not-a-token").is_none());
    assert!(ApiToken::from_secret("not-a-token").is_none());
    assert!(InviteToken::from_secret("not-a-token").is_none());
    assert!(matches!(
        db.create_session(alice.id, 0),
        Err(Error::InvalidSessionExpiry)
    ));
    assert!(matches!(
        db.create_invite(InviteScope {
            issuer_user_id: alice.id,
            vault_slug: "personal".to_string(),
            role: Role::None,
            expires_at: 4_102_444_800,
        }),
        Err(Error::InvalidInviteRole)
    ));
    assert!(matches!(
        db.create_api_token(ApiTokenScope {
            user_id: alice.id,
            vault_slug: "personal".to_string(),
            role: Role::None,
        }),
        Err(Error::InvalidTokenRole)
    ));

    db.set_disabled(bob.id, true).expect("disable non-admin");
    assert!(matches!(
        db.create_invite(InviteScope {
            issuer_user_id: bob.id,
            vault_slug: "personal".to_string(),
            role: Role::Viewer,
            expires_at: 4_102_444_800,
        }),
        Err(Error::DisabledUser)
    ));
    assert!(matches!(
        db.create_api_token(ApiTokenScope {
            user_id: bob.id,
            vault_slug: "personal".to_string(),
            role: Role::Viewer,
        }),
        Err(Error::DisabledUser)
    ));
    assert!(matches!(
        db.set_admin(alice.id, false),
        Err(Error::LastAdmin)
    ));
}
