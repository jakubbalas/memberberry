//! Device sign-in storage (`SPEC.md` §6.8.1, E36).

#![allow(clippy::expect_used, clippy::unwrap_used)]

use mb_auth::{
    AuthDb, DEVICE_CODE_SECONDS, DeviceApproval, DeviceCode, DeviceToken, NewUser, User,
    pkce_challenge, valid_redirect_uri,
};

const PASSWORD: &str = "correct horse battery staple";
const REDIRECT: &str = "http://127.0.0.1:54766/desktop/connect/callback";
const VERIFIER: &str = "dBjftJeZ4CVP-mJ92QcmjePbz2ZkJZDV3cZn1qlqVYp1aTNH7k9C";
// why: computed independently, with Python's `hashlib` and `base64.urlsafe_b64encode`, so the
// test checks the S256 transform against a second implementation rather than against itself.
const CHALLENGE: &str = "SEnN_wAWTxD9j_AMtYKytwUrsRjDJX1jWsQ95vj5xMM";
const NOW: i64 = 1_800_000_000;

struct Fixture {
    auth: AuthDb,
    alice: User,
}

fn fixture() -> Fixture {
    let mut auth = AuthDb::open_in_memory().expect("auth db");
    let alice = auth
        .setup_first_user(NewUser {
            username: "alice",
            display_name: "Alice",
            password: PASSWORD,
        })
        .expect("alice");
    Fixture { auth, alice }
}

fn approve(fx: &Fixture) -> DeviceCode {
    fx.auth
        .approve_device_at(
            DeviceApproval {
                user_id: fx.alice.id,
                device_name: "Alice's laptop",
                redirect_uri: REDIRECT,
                code_challenge: CHALLENGE,
            },
            NOW,
        )
        .expect("approval")
}

#[test]
fn the_s256_challenge_matches_an_independent_implementation() {
    assert_eq!(pkce_challenge(VERIFIER), CHALLENGE);
}

#[test]
fn only_the_exact_loopback_callback_is_a_valid_redirect() {
    assert!(valid_redirect_uri(REDIRECT));
    for bad in [
        "http://localhost:54766/desktop/connect/callback",
        "https://127.0.0.1:54766/desktop/connect/callback",
        "http://127.0.0.1:54766/desktop/connect/callback/",
        "http://127.0.0.1:54766/desktop/connect/callback?x=1",
        "http://127.0.0.1:54766/desktop/connect/callback#x",
        "http://127.0.0.1:54766/elsewhere",
        "http://127.0.0.1:0/desktop/connect/callback",
        "http://127.0.0.1:065535/desktop/connect/callback",
        "http://127.0.0.1:65536/desktop/connect/callback",
        "http://127.0.0.1/desktop/connect/callback",
        "http://127.0.0.1:80@evil.example/desktop/connect/callback",
        "http://127.0.0.2:54766/desktop/connect/callback",
    ] {
        assert!(!valid_redirect_uri(bad), "{bad}");
    }
}

#[test]
fn an_approved_code_exchanges_for_a_token_that_acts_as_the_approver() {
    let mut fx = fixture();
    let code = approve(&fx);
    let grant = fx
        .auth
        .exchange_device_code_at(&code, VERIFIER, REDIRECT, NOW + 1)
        .expect("exchange")
        .expect("grant");
    assert_eq!(grant.user.username, "alice");
    let identity = fx
        .auth
        .authenticate_device_token(&grant.token)
        .expect("authenticate")
        .expect("live token");
    assert_eq!(
        (
            identity.user.username.as_str(),
            identity.device_name.as_str()
        ),
        ("alice", "Alice's laptop")
    );
}

#[test]
fn a_code_works_only_once() {
    let mut fx = fixture();
    let code = approve(&fx);
    assert!(
        fx.auth
            .exchange_device_code_at(&code, VERIFIER, REDIRECT, NOW + 1)
            .expect("first")
            .is_some()
    );
    assert!(
        fx.auth
            .exchange_device_code_at(&code, VERIFIER, REDIRECT, NOW + 2)
            .expect("second")
            .is_none()
    );
}

#[test]
fn a_wrong_verifier_spends_the_code() {
    let mut fx = fixture();
    let code = approve(&fx);
    let wrong = "x".repeat(43);
    assert!(
        fx.auth
            .exchange_device_code_at(&code, &wrong, REDIRECT, NOW + 1)
            .expect("wrong verifier")
            .is_none()
    );
    assert!(
        fx.auth
            .exchange_device_code_at(&code, VERIFIER, REDIRECT, NOW + 2)
            .expect("right verifier after a failure")
            .is_none()
    );
}

#[test]
fn a_different_redirect_uri_is_refused() {
    let mut fx = fixture();
    let code = approve(&fx);
    let other = "http://127.0.0.1:1234/desktop/connect/callback";
    assert!(
        fx.auth
            .exchange_device_code_at(&code, VERIFIER, other, NOW + 1)
            .expect("exchange")
            .is_none()
    );
}

#[test]
fn an_expired_code_is_refused() {
    let mut fx = fixture();
    let code = approve(&fx);
    assert!(
        fx.auth
            .exchange_device_code_at(&code, VERIFIER, REDIRECT, NOW + DEVICE_CODE_SECONDS + 1)
            .expect("exchange")
            .is_none()
    );
}

#[test]
fn an_unknown_code_is_refused() {
    let mut fx = fixture();
    let code = DeviceCode::from_secret(&"a".repeat(64)).expect("well-formed");
    assert!(
        fx.auth
            .exchange_device_code_at(&code, VERIFIER, REDIRECT, NOW)
            .expect("exchange")
            .is_none()
    );
}

#[test]
fn a_disabled_users_devices_stop_working() {
    let mut fx = fixture();
    let code = approve(&fx);
    let grant = fx
        .auth
        .exchange_device_code_at(&code, VERIFIER, REDIRECT, NOW + 1)
        .expect("exchange")
        .expect("grant");
    let bob = fx
        .auth
        .create_user(NewUser {
            username: "bob",
            display_name: "Bob",
            password: PASSWORD,
        })
        .expect("bob");
    fx.auth.set_admin(bob.id, true).expect("second admin");
    fx.auth.set_disabled(fx.alice.id, true).expect("disable");
    assert!(
        fx.auth
            .authenticate_device_token(&grant.token)
            .expect("authenticate")
            .is_none()
    );
}

#[test]
fn a_revoked_token_stops_working_and_is_listed_as_revoked() {
    let mut fx = fixture();
    let code = approve(&fx);
    let grant = fx
        .auth
        .exchange_device_code_at(&code, VERIFIER, REDIRECT, NOW + 1)
        .expect("exchange")
        .expect("grant");
    fx.auth.revoke_device_token(&grant.token).expect("revoke");
    assert!(
        fx.auth
            .authenticate_device_token(&grant.token)
            .expect("authenticate")
            .is_none()
    );
    let listed = fx.auth.list_devices(fx.alice.id).expect("list");
    assert!(listed.len() == 1 && listed.iter().all(|d| d.revoked_at.is_some()));
}

#[test]
fn an_operator_can_revoke_a_device_by_id() {
    let mut fx = fixture();
    let code = approve(&fx);
    let grant = fx
        .auth
        .exchange_device_code_at(&code, VERIFIER, REDIRECT, NOW + 1)
        .expect("exchange")
        .expect("grant");
    assert!(
        fx.auth
            .revoke_device_by_id(grant.device_id)
            .expect("revoke")
    );
    assert!(!fx.auth.revoke_device_by_id(grant.device_id).expect("again"));
    assert!(
        fx.auth
            .authenticate_device_token(&grant.token)
            .expect("authenticate")
            .is_none()
    );
}

#[test]
fn a_password_reset_revokes_every_device() {
    let mut fx = fixture();
    let code = approve(&fx);
    let grant = fx
        .auth
        .exchange_device_code_at(&code, VERIFIER, REDIRECT, NOW + 1)
        .expect("exchange")
        .expect("grant");
    fx.auth
        .reset_password(fx.alice.id, "another long passphrase")
        .expect("reset");
    assert!(
        fx.auth
            .authenticate_device_token(&grant.token)
            .expect("authenticate")
            .is_none()
    );
}

#[test]
fn an_approval_with_a_foreign_redirect_is_refused() {
    let fx = fixture();
    let refused = fx.auth.approve_device_at(
        DeviceApproval {
            user_id: fx.alice.id,
            device_name: "Laptop",
            redirect_uri: "https://evil.example/callback",
            code_challenge: CHALLENGE,
        },
        NOW,
    );
    assert!(refused.is_err());
}

#[test]
fn an_approval_with_a_control_character_in_the_name_is_refused() {
    let fx = fixture();
    let refused = fx.auth.approve_device_at(
        DeviceApproval {
            user_id: fx.alice.id,
            device_name: "Laptop\u{7}",
            redirect_uri: REDIRECT,
            code_challenge: CHALLENGE,
        },
        NOW,
    );
    assert!(refused.is_err());
}

#[test]
fn an_api_token_shaped_value_is_not_a_device_token() {
    assert!(DeviceToken::from_secret(&"a".repeat(64)).is_none());
    assert!(DeviceToken::from_secret(&format!("mbd_{}", "a".repeat(64))).is_some());
    assert!(DeviceToken::from_secret(&format!("mbd_{}", "A".repeat(64))).is_none());
}
