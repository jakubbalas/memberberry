#![allow(clippy::expect_used, clippy::indexing_slicing)] // why: exact fixture/header invariants are test assertions.
use super::*;
use std::sync::atomic::Ordering;
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
fn fixture() -> (
    tempfile::TempDir,
    Arc<AppState>,
    HeaderMap,
    HeaderMap,
    mb_auth::UserId,
    mb_auth::SessionToken,
) {
    let dir = tempfile::tempdir().expect("fixture");
    std::fs::write(dir.path().join("add-vault.html"), "<h1>Add vault</h1>").expect("bundle");
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
    auth.set_admin(spare.id, true).expect("spare admin");
    let bob = auth
        .create_user(mb_auth::NewUser {
            username: "bob",
            display_name: "Bob",
            password: "correct horse battery staple",
        })
        .expect("nonadmin");
    let session = auth
        .create_session(alice.id, 4_102_444_800)
        .expect("session");
    let user_session = auth
        .create_session(bob.id, 4_102_444_800)
        .expect("user session");
    let mut headers = HeaderMap::new();
    headers.insert(
        header::COOKIE,
        HeaderValue::from_str(&format!(
            "mb_session={}",
            auth.signed_session_cookie(&session).expect("cookie")
        ))
        .expect("header"),
    );
    let mut user_headers = HeaderMap::new();
    user_headers.insert(
        header::COOKIE,
        HeaderValue::from_str(&format!(
            "mb_session={}",
            auth.signed_session_cookie(&user_session).expect("cookie")
        ))
        .expect("header"),
    );
    let state = Arc::new(
        AppState::authenticated_with_web_root(vec![], auth, dir.path().to_path_buf())
            .expect("state"),
    );
    (dir, state, headers, user_headers, alice.id, session)
}
#[tokio::test]
async fn folder_html_requires_current_unique_signed_admin_before_bundle_read() {
    let _serial = SERIAL.lock().await;
    let (_dir, state, headers, user_headers, id, session) = fixture();
    let before = BUNDLE_READS.load(Ordering::SeqCst);
    assert_eq!(
        page(State(state.clone()), headers.clone()).await.status(),
        StatusCode::OK,
        "authorized HTML positive control"
    );
    assert_eq!(BUNDLE_READS.load(Ordering::SeqCst), before + 1);
    let reads = BUNDLE_READS.load(Ordering::SeqCst);
    let mut duplicate = headers.clone();
    duplicate.append(header::COOKIE, headers[header::COOKIE].clone());
    let mut bearer = headers.clone();
    bearer.insert(
        header::AUTHORIZATION,
        HeaderValue::from_static("Bearer ignored"),
    );
    let mut invalid = HeaderMap::new();
    invalid.insert(
        header::COOKIE,
        HeaderValue::from_static("mb_session=invalid"),
    );
    for h in [HeaderMap::new(), user_headers, duplicate, bearer, invalid] {
        let r = page(State(state.clone()), h).await;
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
        assert_eq!(r.headers()[header::CACHE_CONTROL], "no-store");
        assert!(
            r.headers()[header::CONTENT_TYPE]
                .to_str()
                .expect("type")
                .starts_with("text/html")
        );
        assert_eq!(
            BUNDLE_READS.load(Ordering::SeqCst),
            reads,
            "refused before bundle lookup/open/stat"
        );
    }
    state
        .security
        .auth
        .lock()
        .expect("auth")
        .set_admin(id, false)
        .expect("demote");
    assert_eq!(
        page(State(state.clone()), headers.clone()).await.status(),
        StatusCode::NOT_FOUND
    );
    state
        .security
        .auth
        .lock()
        .expect("auth")
        .set_admin(id, true)
        .expect("restore");
    state
        .security
        .auth
        .lock()
        .expect("auth")
        .set_disabled(id, true)
        .expect("disable");
    assert_eq!(
        page(State(state.clone()), headers.clone()).await.status(),
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
        .revoke_session(&session)
        .expect("revoke");
    assert_eq!(
        page(State(state), headers).await.status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(BUNDLE_READS.load(Ordering::SeqCst), reads);
}
#[tokio::test]
async fn folder_html_authority_fails_closed_without_waiting_for_commit_auth_lock() {
    let _serial = SERIAL.lock().await;
    let (_dir, state, headers, _, _, _) = fixture();
    let held = state
        .security
        .auth
        .lock()
        .expect("controlled commit auth lock");
    let worker = state.clone();
    let h = headers.clone();
    let (answer, received) = std::sync::mpsc::channel();
    let task = std::thread::spawn(move || {
        answer.send(administrator(&worker, &h)).expect("reply");
    });
    let result = received.recv_timeout(std::time::Duration::from_secs(1));
    drop(held);
    task.join().expect("joined authority worker");
    assert_eq!(
        result,
        Ok(false),
        "an occupied commit auth lock must yield a neutral refusal, not block the HTML async executor"
    );
    assert!(
        administrator(&state, &headers),
        "available current signed-admin positive control"
    );
}
#[tokio::test]
async fn folder_html_rechecks_revocation_before_publication() {
    let _serial = SERIAL.lock().await;
    let (_dir, state, headers, _, _, session) = fixture();
    let (ready, started) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    *AFTER_READ.lock().expect("pause") = Some((ready, wait));
    let task = tokio::spawn(page(State(state.clone()), headers));
    started.await.expect("actual bundle read completed");
    state
        .security
        .auth
        .lock()
        .expect("auth")
        .revoke_session(&session)
        .expect("revoke");
    release.send(()).expect("release");
    let r = task.await.expect("joined");
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
    let body = axum::body::to_bytes(r.into_body(), 65536)
        .await
        .expect("body");
    assert!(
        !String::from_utf8(body.to_vec())
            .expect("HTML")
            .contains("<h1>Add vault</h1>")
    );
}
#[tokio::test]
async fn folder_html_missing_oversized_symlink_fifo_and_directory_bundles_fail_safely() {
    let _serial = SERIAL.lock().await;
    let (dir, state, headers, _, _, _) = fixture();
    let file = dir.path().join("add-vault.html");
    let outside = tempfile::tempdir().expect("separate external fixture");
    let external = outside.path().join("external.html");
    std::fs::write(&external, "<h1>Untrusted external bundle</h1>").expect("external target");
    for mode in ["missing", "oversized", "symlink", "fifo", "directory"] {
        std::fs::remove_file(&file).expect("remove previous");
        match mode {
            "missing" => {}
            "oversized" => std::fs::write(&file, vec![b'a'; 262145]).expect("oversize"),
            "symlink" => std::os::unix::fs::symlink(&external, &file).expect("symlink"),
            "fifo" => rustix::fs::mknodat(
                rustix::fs::CWD,
                &file,
                rustix::fs::FileType::Fifo,
                rustix::fs::Mode::RUSR,
                0,
            )
            .expect("fifo"),
            "directory" => std::fs::create_dir(&file).expect("directory"),
            _ => {}
        }
        let r = page(State(state.clone()), headers.clone()).await;
        assert_eq!(r.status(), StatusCode::SERVICE_UNAVAILABLE, "{mode}");
        assert_eq!(r.headers()[header::CACHE_CONTROL], "no-store");
        let body = axum::body::to_bytes(r.into_body(), 65536)
            .await
            .expect("body");
        assert!(
            !String::from_utf8(body.to_vec())
                .expect("HTML")
                .contains(dir.path().to_str().expect("path"))
        );
        if mode == "directory" {
            std::fs::remove_dir(&file).expect("cleanup directory");
        } else if mode != "missing" {
            std::fs::remove_file(&file).expect("cleanup file");
        }
        std::fs::write(&file, "placeholder").expect("next fixture");
    }
}

#[tokio::test]
async fn new_vault_form_preserves_escaped_details_and_error_without_inline_script() {
    let _serial = SERIAL.lock().await;
    let (dir, state, headers, _, _, _) = fixture();
    std::fs::write(dir.path().join("add-vault.html"),
        r#"<main data-server-error=""><input id="vault-name"><input id="vault-slug"><p><!-- server-error --></p></main>"#)
        .expect("form template");
    let response = form_page(
        State(state),
        headers,
        Some("Try <again> & keep details"),
        "Notebook 日本 <script>\"",
        "existing-address",
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response.headers()[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .expect("policy")
            .contains("form-action 'self'")
    );
    let body = axum::body::to_bytes(response.into_body(), 65536)
        .await
        .expect("body");
    let html = String::from_utf8(body.to_vec()).expect("UTF-8");
    assert!(html.contains("Notebook 日本 &lt;script&gt;&quot;"));
    assert!(html.contains("value=\"existing-address\""));
    assert!(html.contains("Try &lt;again&gt; &amp; keep details"));
    assert!(!html.contains("<script>"));
}
