//! Finding, linking and creating accounts for provider sign-ins (`SPEC.md` §6.8.2, E38).

#![allow(clippy::expect_used, clippy::unwrap_used)]

use mb_auth::{AuthDb, NewUser, OidcAccount, OidcIdentity};

const ISSUER: &str = "https://id.example";

fn db_with_alice(email: Option<&str>) -> (AuthDb, mb_auth::User) {
    let mut db = AuthDb::open_in_memory().expect("db");
    let alice = db
        .setup_first_user(NewUser {
            username: "alice",
            display_name: "Alice",
            password: "correct horse battery staple",
        })
        .expect("alice");
    db.set_email(alice.id, email).expect("email");
    (db, alice)
}

fn person<'a>(subject: &'a str, email: Option<&'a str>, verified: bool) -> OidcIdentity<'a> {
    OidcIdentity {
        issuer: ISSUER,
        subject,
        email,
        email_verified: verified,
        preferred_username: Some("alice"),
        name: Some("Alice Provider"),
    }
}

#[test]
fn a_verified_email_links_the_one_account_that_carries_it() {
    let (mut db, alice) = db_with_alice(Some("alice@example.com"));
    let account = db
        .sign_in_oidc(&person("sub-1", Some("Alice@Example.com"), true))
        .expect("sign in");
    assert_eq!(account, OidcAccount::Linked(alice));
}

#[test]
fn a_linked_person_returns_to_the_same_account_whatever_their_email_becomes() {
    let (mut db, alice) = db_with_alice(Some("alice@example.com"));
    db.sign_in_oidc(&person("sub-1", Some("alice@example.com"), true))
        .expect("first");
    let again = db
        .sign_in_oidc(&person("sub-1", Some("someone@else.example"), false))
        .expect("again");
    assert_eq!(again, OidcAccount::Returning(alice));
}

#[test]
fn an_unverified_email_links_nothing() {
    let (mut db, alice) = db_with_alice(Some("alice@example.com"));
    let account = db
        .sign_in_oidc(&person("sub-1", Some("alice@example.com"), false))
        .expect("sign in");
    assert!(matches!(&account, OidcAccount::Created(user) if user.id != alice.id));
}

#[test]
fn an_account_without_an_email_is_never_linked() {
    let (mut db, alice) = db_with_alice(None);
    let account = db
        .sign_in_oidc(&person("sub-1", Some("alice@example.com"), true))
        .expect("sign in");
    assert!(matches!(&account, OidcAccount::Created(user) if user.id != alice.id));
}

#[test]
fn an_email_two_accounts_share_links_neither() {
    let (mut db, alice) = db_with_alice(Some("shared@example.com"));
    let bob = db
        .create_user(NewUser {
            username: "bob",
            display_name: "Bob",
            password: "correct horse battery staple",
        })
        .expect("bob");
    db.set_email(bob.id, Some("shared@example.com"))
        .expect("email");
    let account = db
        .sign_in_oidc(&person("sub-1", Some("shared@example.com"), true))
        .expect("sign in");
    assert!(
        matches!(&account, OidcAccount::Created(user) if user.id != alice.id && user.id != bob.id)
    );
}

#[test]
fn a_new_account_is_never_an_administrator() {
    let (mut db, _) = db_with_alice(None);
    let account = db
        .sign_in_oidc(&person("sub-2", Some("new@example.com"), true))
        .expect("sign in");
    assert!(!account.user().is_admin);
}

#[test]
fn a_new_account_takes_a_free_username() {
    let (mut db, _) = db_with_alice(None);
    let account = db
        .sign_in_oidc(&person("sub-2", None, false))
        .expect("sign in");
    assert_eq!(account.user().username, "alice-2");
}

#[test]
fn a_new_account_cannot_sign_in_with_an_empty_or_guessed_password() {
    let (mut db, _) = db_with_alice(None);
    let account = db
        .sign_in_oidc(&person("sub-2", None, false))
        .expect("sign in");
    let username = account.user().username.clone();
    assert!(db.authenticate(&username, "").expect("auth").is_none());
    assert!(
        db.authenticate(&username, "correct horse battery staple")
            .expect("auth")
            .is_none()
    );
}

#[test]
fn a_new_account_keeps_a_verified_email() {
    let (mut db, _) = db_with_alice(None);
    let account = db
        .sign_in_oidc(&person("sub-2", Some("new@example.com"), true))
        .expect("sign in");
    assert_eq!(
        db.email_of(account.user().id).expect("email").as_deref(),
        Some("new@example.com")
    );
}

#[test]
fn the_same_subject_from_another_issuer_is_another_person() {
    let (mut db, _) = db_with_alice(None);
    let first = db
        .sign_in_oidc(&person("sub-1", None, false))
        .expect("first");
    let other = OidcIdentity {
        issuer: "https://other.example",
        ..person("sub-1", None, false)
    };
    let second = db.sign_in_oidc(&other).expect("second");
    assert_ne!(first.user().id, second.user().id);
}

#[test]
fn a_malformed_email_is_refused() {
    let (db, alice) = db_with_alice(None);
    assert!(db.set_email(alice.id, Some("not an email")).is_err());
}

#[test]
fn a_sign_in_replaces_the_previous_groups() {
    let (mut db, alice) = db_with_alice(None);
    db.set_groups(alice.id, &["family".into(), "work".into()])
        .expect("first");
    db.set_groups(alice.id, &["family".into()]).expect("second");
    let groups = db.all_groups().expect("groups");
    assert_eq!(
        groups
            .get("alice")
            .map(|names| names.iter().cloned().collect::<Vec<_>>()),
        Some(vec!["family".to_string()])
    );
}

#[test]
fn a_disabled_account_has_no_groups() {
    let (mut db, alice) = db_with_alice(None);
    let bob = db
        .create_user(NewUser {
            username: "bob",
            display_name: "Bob",
            password: "correct horse battery staple",
        })
        .expect("bob");
    db.set_groups(bob.id, &["family".into()]).expect("groups");
    db.set_disabled(bob.id, true).expect("disable");
    assert!(!db.all_groups().expect("groups").contains_key("bob"));
    let _ = alice;
}
