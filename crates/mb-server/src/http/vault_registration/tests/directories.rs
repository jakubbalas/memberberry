//! E31 reuses strict current signed-admin boundary with deterministic admission/rates.
use super::*;
fn request(headers: HeaderMap, body: &str) -> axum::extract::Request {
    let mut request = axum::extract::Request::builder()
        .method("POST")
        .uri("/api/v1/vault-locations/projects/directories")
        .body(axum::body::Body::from(body.to_owned()))
        .expect("request");
    *request.headers_mut() = headers;
    request
}
async fn call(f: &Fixture, headers: HeaderMap, body: &str) -> (StatusCode, serde_json::Value) {
    f.state.registration.budget.lock().expect("rate").used = 0;
    let response = directories::create(State(f.state.clone()), request(headers, body)).await;
    let status = response.status();
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let bytes = axum::body::to_bytes(response.into_body(), 8192)
        .await
        .expect("body");
    (status, serde_json::from_slice(&bytes).expect("JSON"))
}
const INPUT: &str = "{\"path\":\"\",\"directory\":\"Child\"}";
#[tokio::test]
async fn e31_body_and_admission_boundaries_refuse_before_fs() {
    let f = Fixture::new();
    f.state.registration.budget.lock().expect("rate").used = 12;
    let response =
        directories::create(State(f.state.clone()), request(f.headers.clone(), INPUT)).await;
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        f.state.registration.hooks.before_fs.load(Ordering::Relaxed),
        0
    );
    let over = INPUT.to_owned() + &" ".repeat(8193 - INPUT.len());
    assert_eq!(
        call(&f, f.headers.clone(), &over).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let at = INPUT.to_owned() + &" ".repeat(8192 - INPUT.len());
    assert_eq!(
        call(&f, f.headers.clone(), &at).await.0,
        StatusCode::CREATED
    );
    for body in [
        serde_json::json!({"path":"","directory":"x".repeat(256)}).to_string(),
        serde_json::json!({"path":(["x";16].join("/")),"directory":"x"}).to_string(),
    ] {
        assert_eq!(
            call(&f, f.headers.clone(), &body).await.0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    let _slot1 = f.state.registration.reserve().expect("slot");
    let _slot2 = f.state.registration.reserve().expect("slot");
    assert_eq!(
        directories::create(State(f.state.clone()), request(f.headers.clone(), INPUT))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
}

fn spawn_directory(f: &Fixture) -> tokio::task::JoinHandle<Response> {
    let state = f.state.clone();
    let headers = f.headers.clone();
    tokio::spawn(async move { directories::create(State(state), request(headers, INPUT)).await })
}
#[tokio::test]
async fn e31_strict_wire_gates_have_no_fs_and_unique_content_type_positive_control() {
    let f = Fixture::new();
    let mut cases = vec![(HeaderMap::new(), StatusCode::NOT_FOUND)];
    for (name, value, append, status) in [
        (header::AUTHORIZATION, "", false, StatusCode::NOT_FOUND),
        (
            header::AUTHORIZATION,
            "Basic x",
            false,
            StatusCode::NOT_FOUND,
        ),
        (
            header::COOKIE,
            "mb_session=invalid",
            true,
            StatusCode::NOT_FOUND,
        ),
        (header::HOST, "localhost", true, StatusCode::NOT_FOUND),
        (header::HOST, "localhost/.", false, StatusCode::NOT_FOUND),
        (
            header::ORIGIN,
            "http://localhost",
            true,
            StatusCode::NOT_FOUND,
        ),
        (
            header::ORIGIN,
            "http://elsewhere",
            false,
            StatusCode::NOT_FOUND,
        ),
        (
            header::ORIGIN,
            "http://localhost/%2e",
            false,
            StatusCode::NOT_FOUND,
        ),
        (
            header::CONTENT_TYPE,
            "application/json",
            true,
            StatusCode::BAD_REQUEST,
        ),
        (
            header::CONTENT_TYPE,
            "text/plain",
            false,
            StatusCode::BAD_REQUEST,
        ),
        (
            header::HeaderName::from_static("sec-fetch-site"),
            "cross-site",
            false,
            StatusCode::NOT_FOUND,
        ),
    ] {
        let mut headers = f.headers.clone();
        if append {
            headers.append(name, HeaderValue::from_static(value));
        } else {
            headers.insert(name, HeaderValue::from_static(value));
        }
        cases.push((headers, status));
    }
    let before = f.config_bytes();
    for (headers, status) in cases {
        assert_eq!(call(&f, headers, INPUT).await.0, status);
        assert_eq!(
            f.state.registration.hooks.before_fs.load(Ordering::Relaxed),
            0
        );
    }
    assert_eq!(
        f.headers.get_all(header::CONTENT_TYPE).iter().count(),
        1,
        "unique positive control content type"
    );
    assert_eq!(
        call(&f, f.headers.clone(), INPUT).await.0,
        StatusCode::CREATED
    );
    assert_eq!(
        f.state.registration.hooks.before_fs.load(Ordering::Relaxed),
        1
    );
    f.assert_unpublished(&before);
    assert!(f.dir.path().join("Projects/Child").is_dir());
}
#[tokio::test]
async fn e31_revocation_after_wait_precedes_config_or_directory_work() {
    let f = Fixture::new();
    let (ready, release) = f.state.registration.hooks.arm(Phase::BeforeFs);
    let job = spawn_directory(&f);
    wait(ready).await;
    f.state
        .security
        .auth
        .lock()
        .expect("auth")
        .revoke_session(&f.session)
        .expect("revoke");
    release.send(()).expect("release");
    assert_eq!(job.await.expect("worker").status(), StatusCode::NOT_FOUND);
    assert_eq!(
        f.state.registration.hooks.before_fs.load(Ordering::Relaxed),
        0
    );
}
#[tokio::test]
async fn e31_revocation_at_mkdir_prevents_mutation() {
    let f = Fixture::new();
    let (ready, release) = f.state.registration.hooks.arm(Phase::BeforeMutation);
    let job = spawn_directory(&f);
    wait(ready).await;
    f.state
        .security
        .auth
        .lock()
        .expect("auth")
        .revoke_session(&f.session)
        .expect("revoke");
    release.send(()).expect("release");
    assert_eq!(job.await.expect("worker").status(), StatusCode::NOT_FOUND);
    assert!(!f.dir.path().join("Projects/Child").exists());
}
#[tokio::test]
async fn e31_postmkdir_revocation_cleans_only_owned_empty_child() {
    let f = Fixture::new();
    let (ready, release) = f.state.registration.hooks.arm(Phase::AfterCommit);
    let job = spawn_directory(&f);
    wait(ready).await;
    assert!(
        f.dir.path().join("Projects/Child").is_dir(),
        "real mkdir happened"
    );
    f.state
        .security
        .auth
        .lock()
        .expect("auth")
        .revoke_session(&f.session)
        .expect("revoke");
    release.send(()).expect("release");
    assert_eq!(job.await.expect("worker").status(), StatusCode::NOT_FOUND);
    assert!(!f.dir.path().join("Projects/Child").exists());
}
#[tokio::test]
async fn e31_postmkdir_failure_never_deletes_foreign_bytes_or_replaced_identity() {
    for change in ["foreign-content", "replacement", "symlink"] {
        let f = Fixture::new();
        let (ready, release) = f.state.registration.hooks.arm(Phase::AfterCommit);
        let job = spawn_directory(&f);
        wait(ready).await;
        let child = f.dir.path().join("Projects/Child");
        if change != "foreign-content" {
            std::fs::rename(&child, child.with_file_name("OwnedMoved")).expect("move owned child");
            if change == "symlink" {
                std::os::unix::fs::symlink("Public", &child).expect("foreign symlink");
            } else {
                std::fs::create_dir(&child).expect("foreign replacement");
            }
        } else {
            std::fs::write(child.join("foreign.bin"), b"KEEP").expect("foreign bytes");
            std::fs::rename(
                f.dir.path().join("Projects"),
                f.dir.path().join("MovedProjects"),
            )
            .expect("invalidate parent identity");
        }
        release.send(()).expect("release");
        assert_eq!(
            job.await.expect("worker").status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        let kept = if change == "foreign-content" {
            f.dir.path().join("MovedProjects/Child")
        } else {
            child
        };
        assert!(
            std::fs::symlink_metadata(&kept).is_ok(),
            "foreign changes must survive"
        );
        if change == "foreign-content" {
            assert_eq!(
                std::fs::read(kept.join("foreign.bin")).expect("kept"),
                b"KEEP"
            );
        }
    }
}
#[tokio::test]
async fn e31_final_authority_refusal_does_not_roll_back_successfully_created_child() {
    let f = Fixture::new();
    let (ready, release) = f.state.registration.hooks.arm(Phase::Finished);
    let job = spawn_directory(&f);
    wait(ready).await;
    f.state
        .security
        .auth
        .lock()
        .expect("auth")
        .revoke_session(&f.session)
        .expect("revoke");
    release.send(()).expect("release");
    assert_eq!(job.await.expect("worker").status(), StatusCode::NOT_FOUND);
    assert!(
        f.dir.path().join("Projects/Child").is_dir(),
        "neutral refusal does not promise rollback"
    );
}
#[tokio::test]
async fn e31_directory_sync_failure_reports_false_after_real_mkdir_readback() {
    let f = Fixture::new();
    *f.state
        .registration
        .hooks
        .commit_fault
        .lock()
        .expect("fault") = storage::test_io::Fault::DirectorySync;
    let (status, value) = call(&f, f.headers.clone(), INPUT).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(value["directory_synced"], false);
    assert!(f.dir.path().join("Projects/Child").is_dir());
}
#[tokio::test]
async fn e31_collisions_and_wire_failures_leave_original_bytes_and_registry_intact() {
    let f = Fixture::new();
    let before = f.config_bytes();
    std::fs::write(f.dir.path().join("Projects/File"), b"KEEP").expect("file");
    std::os::unix::fs::symlink("Public", f.dir.path().join("Projects/Link")).expect("link");
    for directory in ["Public", "File", "Link"] {
        assert_eq!(
            call(
                &f,
                f.headers.clone(),
                &serde_json::json!({"path":"","directory":directory}).to_string()
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
    }
    for body in [
        "{\"path\":\"\",\"path\":\"Public\",\"directory\":\"X\"}",
        "{\"path\":\"\",\"directory\":\"X\",\"unknown\":true}",
        "{\"path\":\"\",\"directory\":null}",
        "{\"path\":\"\",\"directory\":\"../X\"}",
    ] {
        assert_eq!(
            call(&f, f.headers.clone(), body).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        std::fs::read(f.dir.path().join("Projects/File")).expect("kept"),
        b"KEEP"
    );
    f.assert_unpublished(&before);
}
