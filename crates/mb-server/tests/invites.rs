//! Invite orchestration tests (`SPEC.md` §6.8).

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use mb_auth::{AuthDb, NewUser};
use mb_core::{Role, Username};
use mb_server::invites;
use mb_server::vault::Slug;
use mb_server::{AccessFile, Vault};

use support::TempDir;

const PASSWORD: &str = "correct horse battery staple";

#[test]
fn an_owner_invite_creates_the_account_and_durable_vault_membership() {
    let dir = TempDir::new("invite-accept");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n",
    );
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let access = AccessFile::load(dir.path()).expect("access");
    let mut auth = AuthDb::open_in_memory().expect("auth");
    auth.setup_first_user(NewUser {
        username: "alice",
        display_name: "Alice",
        password: PASSWORD,
    })
    .expect("owner");
    let actor = Username::parse("alice").expect("actor");
    let token =
        invites::issue(&vault, &access, &auth, &actor, Role::Viewer, 4_102_444_800).expect("issue");

    invites::accept(
        &vault,
        &mut auth,
        &token,
        NewUser {
            username: "bob",
            display_name: "Bob",
            password: PASSWORD,
        },
    )
    .expect("accept");
    assert!(
        auth.authenticate("bob", PASSWORD)
            .expect("account")
            .is_some()
    );
    let saved = AccessFile::load(dir.path()).expect("saved access");
    assert!(
        saved
            .policy()
            .members()
            .any(|(user, role)| user.as_str() == "bob" && role == Role::Viewer)
    );
}

#[test]
fn a_non_owner_cannot_issue_an_invite() {
    let dir = TempDir::new("invite-denied");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n",
    );
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let access = AccessFile::load(dir.path()).expect("access");
    let mut auth = AuthDb::open_in_memory().expect("auth");
    auth.setup_first_user(NewUser {
        username: "alice",
        display_name: "Alice",
        password: PASSWORD,
    })
    .expect("owner");
    auth.create_user(NewUser {
        username: "bob",
        display_name: "Bob",
        password: PASSWORD,
    })
    .expect("non-owner");
    let actor = Username::parse("bob").expect("actor");

    assert!(matches!(
        invites::issue(&vault, &access, &auth, &actor, Role::Viewer, 4_102_444_800),
        Err(invites::InviteError::Denied)
    ));
}
