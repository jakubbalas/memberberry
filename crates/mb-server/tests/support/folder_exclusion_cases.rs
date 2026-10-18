//! Real service-identity permission checks shared by focused HTTP and leak targets.
#![allow(dead_code, clippy::expect_used, clippy::unwrap_used, clippy::panic)]
use super::registration_cases::{Observer, post};
use super::registration_fixture::{Server, json};
use crate::safety;
use std::os::unix::fs::PermissionsExt;

struct Mode(std::path::PathBuf, std::fs::Permissions);
impl Mode {
    fn set(path: &std::path::Path, mode: u32) -> Self {
        let old = std::fs::metadata(path).expect("metadata").permissions();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).expect("mode");
        Self(path.to_path_buf(), old)
    }
}
impl Drop for Mode {
    fn drop(&mut self) {
        let _ = std::fs::set_permissions(&self.0, self.1.clone());
    }
}
pub fn checked_option_filters_without_reading_or_repairing(test: &str) {
    if safety::run_unprivileged(test) {
        return;
    }
    let s = Server::new(false);
    let root = s.dir.path().join("Projects/Public");
    for name in ["Real", "ReadOnly", "Private"] {
        std::fs::create_dir(root.join(name)).expect("dir");
    }
    std::fs::write(root.join("Real/Visible.md"), "# Visible\n").expect("note");
    for name in ["ReadOnly", "Private"] {
        std::fs::write(root.join(name).join("Secret.md"), "# ExcludedSentinel\n")
            .expect("excluded note");
    }
    let observer = Observer::new(&[
        &root.join("ReadOnly"),
        &root.join("Private"),
        &root.join("ReadOnly/Secret.md"),
        &root.join("Private/Secret.md"),
    ]);
    let read_only = Mode::set(&root.join("ReadOnly"), 0o555);
    let private = Mode::set(&root.join("Private"), 0);
    let before = std::fs::read(s.dir.path().join("server.toml")).expect("config");
    let headers = format!("{}Origin: http://localhost\r\n", s.admin);
    let mut request =
        serde_json::json!({"mode":"existing","path":"Public","slug":"filtered","name":"Filtered"});
    let preview = "/api/v1/vault-locations/projects/preview";
    assert_eq!(
        post(&s, preview, &headers, &request.to_string()).0,
        503,
        "unchecked remains strict"
    );
    observer.events(); // the strict attempt may open the readable but unwritable folder.
    assert_eq!(
        std::fs::read(s.dir.path().join("server.toml")).expect("unchanged"),
        before
    );
    for invalid in [
        serde_json::Value::Null,
        "true".into(),
        1.into(),
        serde_json::json!({}),
        serde_json::json!([]),
    ] {
        let mut malformed = request.clone();
        malformed
            .as_object_mut()
            .expect("selection object")
            .insert("ignore_non_writable_folders".into(), invalid);
        assert_eq!(post(&s, preview, &headers, &malformed.to_string()).0, 400);
    }
    let duplicate = request.to_string().trim_end_matches('}').to_owned()
        + ",\"ignore_non_writable_folders\":true,\"ignore_non_writable_folders\":false}";
    assert_eq!(post(&s, preview, &headers, &duplicate).0, 400);
    assert!(
        observer.events().is_empty(),
        "malformed options reached excluded storage"
    );
    request
        .as_object_mut()
        .expect("selection object")
        .insert("ignore_non_writable_folders".into(), true.into());
    let (status, body) = post(&s, preview, &headers, &request.to_string());
    assert_eq!(status, 200, "checked preview: {body}");
    let mut changed = request.clone();
    changed.as_object_mut().expect("selection object").insert(
        "confirmation".into(),
        json(&body)
            .get("confirmation")
            .expect("preview receipt")
            .clone(),
    );
    changed
        .as_object_mut()
        .expect("selection object")
        .insert("ignore_non_writable_folders".into(), false.into());
    assert_eq!(
        post(
            &s,
            "/api/v1/vault-locations/projects/register",
            &headers,
            &changed.to_string()
        )
        .0,
        409,
        "receipt must bind the option"
    );
    let (status, body) = post(&s, preview, &headers, &request.to_string());
    assert_eq!(status, 200);
    request.as_object_mut().expect("selection object").insert(
        "confirmation".into(),
        json(&body)
            .get("confirmation")
            .expect("preview receipt")
            .clone(),
    );
    let (status, body) = post(
        &s,
        "/api/v1/vault-locations/projects/register",
        &headers,
        &request.to_string(),
    );
    assert_eq!(status, 201, "checked registration: {body}");
    for endpoint in ["notes", "directory", "search?q=ExcludedSentinel"] {
        let (status, body, _) = s.get(&format!("/api/v1/vaults/filtered/{endpoint}"), &s.admin);
        assert_eq!(status, 200, "{endpoint}: {body}");
        for name in ["ReadOnly", "Private", "Secret", "ExcludedSentinel"] {
            assert!(!body.contains(name), "{endpoint} leaked {name}: {body}");
        }
    }
    assert!(
        s.get("/api/v1/vaults/filtered/notes", &s.admin)
            .1
            .contains("Real/Visible.md")
    );
    assert_eq!(s.get("/v/filtered/Real/Visible.md", &s.admin).0, 200);
    for path in ["ReadOnly/Secret.md", "Private/Secret.md", "Missing.md"] {
        assert_eq!(s.get(&format!("/v/filtered/{path}"), &s.admin).0, 404);
    }
    for path in ["ReadOnly", "Private", "Missing"] {
        assert_eq!(
            s.get(
                &format!("/api/v1/vaults/filtered/directory?path={path}"),
                &s.admin
            )
            .0,
            404
        );
    }
    assert_eq!(s.get("/api/v1/vaults/filtered/notes", &s.user).0, 404);
    assert!(
        observer.events().is_empty(),
        "opt-in scans opened or read excluded descendants"
    );
    let _ = s.signal.take();
    std::fs::create_dir(root.join("New")).expect("new included directory");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if matches!(s.signal.take(), mb_server::watch::Changes::All) {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "directory event did not schedule enrollment refresh"
        );
        std::thread::yield_now();
    }
    assert!(
        s.state
            .maintain_index(&mb_server::watch::Changes::All)
            .is_empty()
    );
    let live_note = root.join("New/Live.md");
    std::fs::write(&live_note, "# NativeWatchProofMarker\n").expect("live note");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let changes = loop {
        let changes = s.signal.take();
        if matches!(&changes, mb_server::watch::Changes::Only(paths) if paths.contains(&live_note))
        {
            break changes;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "new directory never received native subscriptions"
        );
        std::thread::yield_now();
    };
    assert!(s.state.maintain_index(&changes).is_empty());
    assert!(
        s.get(
            "/api/v1/vaults/filtered/search?q=NativeWatchProofMarker",
            &s.admin
        )
        .1
        .contains("New/Live.md")
    );
    assert!(
        observer.events().is_empty(),
        "watch refresh opened excluded directories"
    );
    let config =
        mb_server::ServerConfig::load(&s.dir.path().join("server.toml")).expect("saved config");
    let reopened = config.open_vaults(None).expect("fresh open");
    assert_eq!(
        reopened
            .first()
            .expect("registered vault")
            .notes()
            .expect("fresh catalog"),
        ["New/Live.md", "Real/Visible.md"]
    );
    assert!(
        std::fs::read_to_string(s.dir.path().join("server.toml"))
            .expect("config")
            .contains("ignore_non_writable_folders = true")
    );
    assert_eq!(
        std::fs::metadata(root.join("ReadOnly"))
            .expect("mode")
            .permissions()
            .mode()
            & 0o777,
        0o555
    );
    assert_eq!(
        std::fs::metadata(root.join("Private"))
            .expect("mode")
            .permissions()
            .mode()
            & 0o777,
        0
    );
    drop(read_only);
    drop(private);
    std::fs::read(root.join("Private/Secret.md")).expect("observer positive control");
    assert!(!observer.events().is_empty());
    safety::mark_completed(test);
}

pub fn required_storage_remains_strict(test: &str) {
    if safety::run_unprivileged(test) {
        return;
    }
    for relative in ["", "media", ".memberberry/index"] {
        let s = Server::new(false);
        let root = s.dir.path().join("Projects/Public");
        let target = root.join(relative);
        std::fs::create_dir_all(&target).expect("required storage");
        let mode = Mode::set(&target, 0o555);
        let config = std::fs::read(s.dir.path().join("server.toml")).expect("config");
        let request = serde_json::json!({"mode":"existing","path":"Public","slug":"filtered","name":"Filtered","ignore_non_writable_folders":true});
        let headers = format!("{}Origin: http://localhost\r\n", s.admin);
        let preview = "/api/v1/vault-locations/projects/preview";
        assert_eq!(
            post(&s, preview, &headers, &request.to_string()).0,
            503,
            "required path {relative}"
        );
        assert_eq!(
            std::fs::read(s.dir.path().join("server.toml")).expect("preserved"),
            config
        );
        assert_eq!(s.state.len(), 0);
        assert_eq!(
            std::fs::metadata(&target)
                .expect("mode")
                .permissions()
                .mode()
                & 0o777,
            0o555
        );
        assert!(!root.join("access.toml").exists());
        drop(mode);
        assert_eq!(
            post(&s, preview, &headers, &request.to_string()).0,
            200,
            "restored positive control {relative}"
        );
    }
    safety::mark_completed(test);
}
