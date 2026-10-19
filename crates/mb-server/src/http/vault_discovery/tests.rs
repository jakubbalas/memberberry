#![allow(clippy::expect_used, clippy::panic)] // why: test fixture invariants only.
use super::*;

#[test]
fn rate_window_is_deterministic_and_refused_calls_do_not_allocate_state() {
    let start = std::time::Instant::now();
    let mut budget = DiscoveryRate {
        window: start,
        used: 0,
    };
    for _ in 0..60 {
        assert!(budget.allow_at(start));
    }
    assert!(!budget.allow_at(start));
    assert_eq!(budget.used, 60);
    assert!(budget.allow_at(start + std::time::Duration::from_secs(60)));
    assert_eq!(budget.used, 1);
}
#[test]
fn two_slots_have_no_waiting_queue_and_release_on_failure() {
    let gate = DiscoveryGate::new();
    let first = gate.enter().expect("slot1");
    let second = gate.enter().expect("slot2");
    assert!(matches!(gate.enter(), Err(Refusal::Busy)));
    drop(first);
    assert!(gate.enter().is_ok());
    drop(second);
    assert_eq!(gate.slots.available_permits(), 2);
}
#[tokio::test]
async fn anonymous_and_nonadmin_do_not_reach_any_filesystem_operation() {
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth");
    auth.setup_first_user(mb_auth::NewUser {
        username: "alice",
        display_name: "Alice",
        password: "correct horse battery staple",
    })
    .expect("admin");
    let bob = auth
        .create_user(mb_auth::NewUser {
            username: "bob",
            display_name: "Bob",
            password: "correct horse battery staple",
        })
        .expect("user");
    let session = auth.create_session(bob.id, 4_102_444_800).expect("session");
    let cookie = auth.signed_session_cookie(&session).expect("cookie");
    let dir = tempfile::tempdir().expect("fixture");
    let state = Arc::new(
        AppState::authenticated(vec![], auth)
            .expect("state")
            .with_vault_management(dir.path().join("missing.toml"), false)
            .expect("management"),
    );
    for headers in [HeaderMap::new(), {
        let mut h = HeaderMap::new();
        h.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!("mb_session={cookie}")).expect("header"),
        );
        h
    }] {
        let response = handle(
            state.clone(),
            headers,
            "/api/v1/vault-locations".parse().expect("URI"),
            Operation::Locations,
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(state.discovery.before_fs.load(Ordering::Relaxed), 0);
    }
}
fn admin_state() -> (tempfile::TempDir, Arc<AppState>, HeaderMap, mb_auth::UserId) {
    let dir = tempfile::tempdir().expect("fixture");
    std::fs::write(dir.path().join("server.toml"), "").expect("config");
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth");
    let alice = auth
        .setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: "correct horse battery staple",
        })
        .expect("admin");
    let spare = auth
        .create_user(mb_auth::NewUser {
            username: "spare",
            display_name: "Spare",
            password: "correct horse battery staple",
        })
        .expect("spare");
    auth.set_admin(spare.id, true).expect("second admin");
    let session = auth
        .create_session(alice.id, 4_102_444_800)
        .expect("session");
    let mut headers = HeaderMap::new();
    headers.insert(
        header::COOKIE,
        HeaderValue::from_str(&format!(
            "mb_session={}",
            auth.signed_session_cookie(&session).expect("cookie")
        ))
        .expect("header"),
    );
    let state = Arc::new(
        AppState::authenticated(vec![], auth)
            .expect("state")
            .with_vault_management(dir.path().join("server.toml"), false)
            .expect("management"),
    );
    (dir, state, headers, alice.id)
}

#[tokio::test]
async fn aborting_async_request_retains_blocking_slot_until_job_releases_resources() {
    let (_dir, state, headers, _) = admin_state();
    let other = state.discovery.enter().expect("second slot");
    let (ready, started) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    *state.discovery.pause.lock().expect("pause") = Some((ready, wait));
    let task = tokio::spawn(handle(
        state.clone(),
        headers,
        "/api/v1/vault-locations".parse().expect("URI"),
        Operation::Locations,
    ));
    started.await.expect("blocking job started");
    task.abort();
    assert!(task.await.expect_err("aborted").is_cancelled());
    assert!(
        matches!(state.discovery.enter(), Err(Refusal::Busy)),
        "aborted waiter must not free a running job's permit"
    );
    release.send(()).expect("release");
    let released = state
        .discovery
        .slots
        .acquire()
        .await
        .expect("job releases permit");
    drop(released);
    drop(other);
    assert_eq!(state.discovery.slots.available_permits(), 2);
}

#[tokio::test]
async fn demotion_during_job_refuses_publication_and_next_request_before_fs() {
    let (_dir, state, headers, id) = admin_state();
    let (ready, started) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    *state.discovery.pause.lock().expect("pause") = Some((ready, wait));
    let task = tokio::spawn(handle(
        state.clone(),
        headers.clone(),
        "/api/v1/vault-locations".parse().expect("URI"),
        Operation::Locations,
    ));
    started.await.expect("job started");
    state
        .security
        .auth
        .lock()
        .expect("auth")
        .set_admin(id, false)
        .expect("demote");
    release.send(()).expect("release");
    assert_eq!(task.await.expect("join").status(), StatusCode::NOT_FOUND);
    let touched = state.discovery.before_fs.load(Ordering::Relaxed);
    assert_eq!(
        handle(
            state.clone(),
            headers,
            "/api/v1/vault-locations".parse().expect("URI"),
            Operation::Locations
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(state.discovery.before_fs.load(Ordering::Relaxed), touched);
}

#[tokio::test]
async fn disabled_demoted_invalid_and_scoped_admin_credentials_never_reach_fs() {
    let (_dir, state, headers, id) = admin_state();
    let token = state
        .security
        .auth
        .lock()
        .expect("auth")
        .create_api_token(mb_auth::ApiTokenScope {
            user_id: id,
            vault_slug: "private".into(),
            role: mb_core::Role::Owner,
        })
        .expect("token");
    let mut bearer = HeaderMap::new();
    bearer.insert(
        header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", token.expose_secret())).expect("header"),
    );
    let mut mixed = headers.clone();
    mixed.extend(bearer.clone());
    for h in [bearer, mixed] {
        assert_eq!(
            handle(
                state.clone(),
                h,
                "/api/v1/vault-locations".parse().expect("URI"),
                Operation::Locations
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(state.discovery.before_fs.load(Ordering::Relaxed), 0);
    }
    state
        .security
        .auth
        .lock()
        .expect("auth")
        .set_disabled(id, true)
        .expect("disable");
    assert_eq!(
        handle(
            state.clone(),
            headers.clone(),
            "/api/v1/vault-locations".parse().expect("URI"),
            Operation::Locations
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    state
        .security
        .auth
        .lock()
        .expect("auth")
        .set_disabled(id, false)
        .expect("enable");
    state
        .security
        .auth
        .lock()
        .expect("auth")
        .set_admin(id, false)
        .expect("demote");
    assert_eq!(
        handle(
            state.clone(),
            headers.clone(),
            "/api/v1/vault-locations".parse().expect("URI"),
            Operation::Locations
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    state
        .security
        .auth
        .lock()
        .expect("auth")
        .set_admin(id, true)
        .expect("admin");
    let mut headers = headers;
    headers.insert(
        header::COOKIE,
        HeaderValue::from_static("mb_session=invalid"),
    );
    assert_eq!(
        handle(
            state.clone(),
            headers,
            "/api/v1/vault-locations".parse().expect("URI"),
            Operation::Locations
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(state.discovery.before_fs.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn missing_management_fails_closed_before_fs_for_real_admin() {
    let (_dir, state, headers, _) = admin_state();
    let mut state = Arc::try_unwrap(state).expect("sole state");
    state.management = None;
    let state = Arc::new(state);
    assert_eq!(
        handle(
            state.clone(),
            headers,
            "/api/v1/vault-locations".parse().expect("URI"),
            Operation::Locations
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(state.discovery.before_fs.load(Ordering::Relaxed), 0);
}

#[test]
fn bounded_json_never_allocates_or_publishes_over_budget() {
    assert!(matches!(
        bounded_json(&serde_json::json!({"s":"x".repeat(MAX_RESPONSE_BYTES)})),
        Err(Refusal::Limit)
    ));
}
#[test]
fn seeded_wire_roundtrip_preserves_literal_unicode_and_boundaries() {
    use proptest::{
        prelude::*,
        test_runner::{Config, RngSeed, TestRunner},
    };
    let seed = 20261009;
    println!("discovery wire property seed={seed}");
    let mut runner = TestRunner::new(Config {
        cases: 64,
        rng_seed: RngSeed::Fixed(seed),
        failure_persistence: None,
        ..Config::default()
    });
    runner
        .run(
            &(
                "[a-z]{2,16}",
                proptest::sample::select(vec![
                    "日本 📚",
                    "Design: notes",
                    "%2e%2e",
                    "100% Complete",
                    "%2f",
                    "%5c",
                    "+",
                    "é",
                ]),
            ),
            |(prefix, suffix)| {
                let name = format!("{prefix}-{suffix}");
                let encoded = name
                    .as_bytes()
                    .iter()
                    .map(|b| format!("%{b:02X}"))
                    .collect::<String>();
                let uri = format!("/api/v1/vault-locations/projects/status?path={encoded}")
                    .parse()
                    .expect("URI");
                let request =
                    parse_request(&uri, &HeaderMap::new(), Operation::Status).expect("wire");
                prop_assert_eq!(request.path.as_str(), name.as_str());
                prop_assert!(token(request.path.as_str()));
                Ok(())
            },
        )
        .expect("roundtrip property");
}
