use super::*;
use crate::registration_cases as leak;
#[allow(dead_code)] // why: this focused target uses only the accepted helper's unprivileged runner/mode guard.
#[path = "../support/http_safety.rs"]
mod safety;
const PREVIEW: &str = "/api/v1/vault-locations/projects/preview";
const REGISTER: &str = "/api/v1/vault-locations/projects/register";
fn headers(s: &Server) -> String {
    format!("{}Origin: http://localhost\r\n", s.admin)
}
fn selection(mode: &str, path: &str, slug: &str, directory: Option<&str>) -> serde_json::Value {
    let mut r = serde_json::json!({"mode":mode,"path":path,"slug":slug,"name":"Project"});
    if let Some(directory) = directory {
        r["directory"] = directory.into();
    }
    r
}
fn preview(s: &Server, mut r: serde_json::Value) -> serde_json::Value {
    let (status, body) = post(s, PREVIEW, &headers(s), &r.to_string());
    assert_eq!(status, 200, "{body}");
    r["confirmation"] = json(&body)["confirmation"].clone();
    r
}
#[test]
fn e29_signed_session_origin_matrix_is_neutral_before_fs_with_positive_control() {
    leak::write_gate_is_neutral_and_observer_has_positive_control();
}
#[test]
fn valid_existing_policy_excluding_admin_is_preserved_and_content_remains_denied() {
    let s = Server::new(false);
    let project = s.dir.path().join("Projects/Public");
    let policy = b"# exact existing bytes\n[[members]]\nuser='bob'\nrole='owner'\n";
    std::fs::write(project.join("access.toml"), policy).expect("policy");
    std::fs::write(
        project.join("Private.md"),
        "# PrivateAdoptedTitle\nPrivateAdoptedBody\n",
    )
    .expect("note");
    let input = preview(&s, selection("existing", "Public", "project", None));
    let (status, body) = post(&s, REGISTER, &headers(&s), &input.to_string());
    assert_eq!(status, 201, "{body}");
    assert_eq!(
        std::fs::read(project.join("access.toml")).expect("preserved"),
        policy
    );
    for endpoint in ["notes", "graph", "search?q=PrivateAdoptedBody"] {
        let denied = s.get(&format!("/api/v1/vaults/project/{endpoint}"), &s.admin);
        let absent = s.get(&format!("/api/v1/vaults/absent/{endpoint}"), &s.admin);
        assert_eq!((denied.0, &denied.1), (absent.0, &absent.1));
        assert!(
            !denied.1.contains("PrivateAdoptedTitle") && !denied.1.contains("PrivateAdoptedBody")
        );
        assert_eq!(
            s.get(&format!("/api/v1/vaults/project/{endpoint}"), &s.user)
                .0,
            200,
            "owner's normal permission-filtered endpoint"
        );
    }
}
#[test]
fn malformed_symlink_and_special_policy_fail_closed_without_any_publication() {
    for kind in ["malformed", "symlink", "fifo", "oversized"] {
        let s = Server::new(false);
        let root = s.dir.path().join("Projects/Public");
        let config = std::fs::read(s.dir.path().join("server.toml")).expect("config");
        let policy = root.join("access.toml");
        match kind {
            "malformed" => std::fs::write(&policy, b"[[members]]\nrole='god'\n").expect("invalid"),
            "symlink" => {
                std::fs::write(s.dir.path().join("foreign.toml"), b"members=[]").expect("foreign");
                std::os::unix::fs::symlink(s.dir.path().join("foreign.toml"), &policy)
                    .expect("symlink");
            }
            "fifo" => rustix::fs::mknodat(
                rustix::fs::CWD,
                &policy,
                rustix::fs::FileType::Fifo,
                rustix::fs::Mode::from_raw_mode(0o600),
                0,
            )
            .expect("FIFO"),
            _ => std::fs::write(&policy, vec![b'a'; 65537]).expect("oversize"),
        }
        let (status, body) = post(
            &s,
            PREVIEW,
            &headers(&s),
            &selection("existing", "Public", "project", None).to_string(),
        );
        assert_eq!(
            status,
            if kind == "oversized" { 422 } else { 503 },
            "{kind}: {body}"
        );
        assert_eq!(
            std::fs::read(s.dir.path().join("server.toml")).expect("unchanged"),
            config
        );
        assert_eq!(s.state.len(), 0);
        assert!(std::fs::symlink_metadata(&policy).is_ok());
    }
}
#[test]
fn literal_percent_unicode_and_colon_names_survive_json_without_decoding() {
    for name in ["%2e%2e", "%2f", "Design: 100% 日本"] {
        let s = Server::new(false);
        let root = s.dir.path().join("Projects").join(name);
        std::fs::create_dir(&root).expect("literal folder");
        let input = preview(&s, selection("existing", name, "project", None));
        assert_eq!(post(&s, REGISTER, &headers(&s), &input.to_string()).0, 201);
        assert_eq!(
            s.config().vaults[0].path,
            root.to_str().expect("literal path")
        );
        assert!(root.join("access.toml").is_file());
    }
}
#[test]
fn preview_preserves_all_bytes_and_project_layout_pins_exact_root() {
    let s = Server::new(false);
    let root = s.dir.path().join("Projects/Public");
    std::fs::create_dir(root.join("notes")).expect("notes");
    std::fs::write(root.join("IgnoredRoot.md"), "# RootUnindexed\n").expect("root");
    std::fs::write(root.join("notes/Kept.md"), "# ExistingNotesLayout\n").expect("note");
    std::fs::write(root.join("Cargo.toml"), b"[package]\n").expect("code");
    let before = snapshot(&root);
    let input = preview(&s, selection("existing", "Public", "project", None));
    assert_eq!(
        snapshot(&root),
        before,
        "temporary write probes remove only their own names; no preexisting bytes change"
    );
    assert_eq!(post(&s, REGISTER, &headers(&s), &input.to_string()).0, 201);
    let reopened = s.config().open_vaults(None).expect("fresh registry");
    assert_eq!(reopened[0].notes_root(), root);
    let (status, body, _) = s.get("/api/v1/vaults/project/graph", &s.admin);
    assert_eq!(status, 200);
    assert!(body.contains("ExistingNotesLayout"));
    assert!(body.contains("RootUnindexed"));
    for (path, bytes) in before {
        assert_eq!(std::fs::read(root.join(path)).expect("preserved"), bytes);
    }
}
fn snapshot(root: &std::path::Path) -> std::collections::BTreeMap<std::path::PathBuf, Vec<u8>> {
    let mut out = std::collections::BTreeMap::new();
    let mut dirs = vec![root.to_owned()];
    while let Some(dir) = dirs.pop() {
        for e in std::fs::read_dir(dir).expect("scan") {
            let p = e.expect("entry").path();
            if p.is_dir() {
                dirs.push(p);
            } else {
                out.insert(
                    p.strip_prefix(root).expect("relative").to_owned(),
                    std::fs::read(p).expect("read"),
                );
            }
        }
    }
    out
}
#[test]
fn new_collisions_registered_parents_and_overlap_ancestors_refuse() {
    let s = Server::new(true);
    for (input, expected) in [
        (selection("existing", "", "root", None), 400),
        (selection("existing", "Registered", "same", None), 409),
        (selection("new", "Registered", "inside", Some("Child")), 409),
        (selection("new", "", "collision", Some("Public")), 409),
        (
            selection(
                "existing",
                "Registered/PrivateChildName",
                "private-child",
                None,
            ),
            409,
        ),
    ] {
        assert_eq!(
            post(&s, PREVIEW, &headers(&s), &input.to_string()).0,
            expected
        );
    }
    let input = preview(&s, selection("new", "", "nonoverlap", Some("Sibling")));
    assert_eq!(
        post(&s, REGISTER, &headers(&s), &input.to_string()).0,
        201,
        "parent containing a registered descendant may create a nonoverlapping child"
    );
    assert_eq!(s.config().vaults.len(), 2);
}
#[test]
fn concurrent_same_slug_folder_new_name_and_ancestor_confirmations_publish_once() {
    for race in ["slug", "folder", "new-name", "ancestor", "alias"] {
        let s = Server::new(false);
        let projects = s.dir.path().join("Projects");
        std::fs::create_dir(projects.join("Public/Child")).expect("child");
        std::fs::create_dir(projects.join("Other")).expect("other");
        if race == "alias" {
            let mut config = s.config();
            let alias = s.dir.path().join("Alias");
            std::os::unix::fs::symlink(&projects, &alias).expect("trusted alias");
            config.vault_locations.push(
                mb_server::vault_locations::VaultLocation::new(
                    mb_server::vault_locations::VaultLocationId::parse("alias").expect("id"),
                    "Alias",
                    alias.to_str().expect("path"),
                )
                .expect("location"),
            );
            s.save(&config);
        }
        let (a, b) = match race {
            "slug" => (
                selection("existing", "Public", "same", None),
                selection("existing", "Other", "same", None),
            ),
            "new-name" => (
                selection("new", "", "one", Some("New")),
                selection("new", "", "two", Some("New")),
            ),
            "ancestor" => (
                selection("existing", "Public", "one", None),
                selection("existing", "Public/Child", "two", None),
            ),
            _ => (
                selection("existing", "Public", "one", None),
                selection("existing", "Public", "two", None),
            ),
        };
        let a = preview(&s, a);
        let b = if race == "alias" {
            let (status, body) = post(
                &s,
                "/api/v1/vault-locations/alias/preview",
                &headers(&s),
                &b.to_string(),
            );
            assert_eq!(status, 200);
            let mut b = b;
            b["confirmation"] = json(&body)["confirmation"].clone();
            b
        } else {
            preview(&s, b)
        };
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let statuses = std::thread::scope(|scope| {
            let aa = barrier.clone();
            let sref = &s;
            let h = headers(&s);
            let one = scope.spawn(move || {
                aa.wait();
                post(sref, REGISTER, &h, &a.to_string()).0
            });
            let bb = barrier.clone();
            let sref = &s;
            let h = headers(&s);
            let two = scope.spawn(move || {
                bb.wait();
                post(
                    sref,
                    if race == "alias" {
                        "/api/v1/vault-locations/alias/register"
                    } else {
                        REGISTER
                    },
                    &h,
                    &b.to_string(),
                )
                .0
            });
            barrier.wait();
            [one.join().expect("one"), two.join().expect("two")]
        });
        assert_eq!(
            statuses.iter().filter(|&&s| s == 201).count(),
            1,
            "{race}: {statuses:?}"
        );
        assert!(
            statuses.iter().all(|s| matches!(s, 201 | 409 | 429)),
            "{race}: {statuses:?}"
        );
        assert_eq!(s.state.len(), 1);
        assert_eq!(s.config().vaults.len(), 1);
    }
}
#[test]
fn actual_unprivileged_config_temp_denial_after_policy_preparation_rolls_back_and_retries() {
    let name = "cases::actual_unprivileged_config_temp_denial_after_policy_preparation_rolls_back_and_retries";
    if safety::run_unprivileged(name) {
        return;
    }
    let s = Server::new(true);
    let project = s.dir.path().join("Projects/Public");
    std::fs::write(project.join("Keep.md"), b"# Markdown\nOriginal bytes\n").expect("note");
    std::fs::write(project.join("code.bin"), b"non-Markdown\0\xff").expect("code");
    let prior = std::fs::read(s.dir.path().join("server.toml")).expect("config");
    let prior_tree = snapshot(&s.dir.path().join("Projects"));
    let input = preview(&s, selection("existing", "Public", "project", None));
    let trace = leak::Observer::new(&[&project]);
    let mode = safety::FixtureMode::set(s.dir.path(), 0o500);
    let error = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(s.dir.path().join("denied-proof"))
        .expect_err("actual EACCES under service identity");
    assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
    let (status, body) = post(&s, REGISTER, &headers(&s), &input.to_string());
    assert_eq!(status, 503, "{body}");
    let events = trace.events();
    use rustix::fs::inotify::ReadFlags;
    assert!(
        events
            .iter()
            .any(|(bits, name)| bits & ReadFlags::MOVED_TO.bits() != 0
                && name.as_deref() == Some("access.toml")),
        "prepared policy publication before failed config creation"
    );
    assert!(
        events
            .iter()
            .any(|(bits, name)| bits & ReadFlags::DELETE.bits() != 0
                && name.as_deref() == Some("access.toml")),
        "ownership-scoped policy rollback"
    );
    assert_eq!(snapshot(&s.dir.path().join("Projects")), prior_tree);
    assert_eq!(
        std::fs::read(s.dir.path().join("server.toml")).expect("config"),
        prior
    );
    assert_eq!(s.state.len(), 1);
    assert_eq!(s.config().vaults.len(), 1);
    drop(mode);
    let retry = preview(&s, selection("existing", "Public", "project", None));
    assert_eq!(post(&s, REGISTER, &headers(&s), &retry.to_string()).0, 201);
    assert_eq!(s.config().vaults.len(), 2);
    drop(s);
    safety::mark_completed(name);
}
#[test]
fn actual_unprivileged_recursive_directory_and_markdown_write_denial_refuse_adoption() {
    let name =
        "cases::actual_unprivileged_recursive_directory_and_markdown_write_denial_refuse_adoption";
    if safety::run_unprivileged(name) {
        return;
    }
    let s = Server::new(false);
    let root = s.dir.path().join("Projects/Public");
    std::fs::create_dir(root.join("Dependency")).expect("dependency");
    let config = std::fs::read(s.dir.path().join("server.toml")).expect("config");
    let mode = safety::FixtureMode::set(&root.join("Dependency"), 0);
    assert_eq!(
        std::fs::read_dir(root.join("Dependency"))
            .expect_err("actual denied directory")
            .kind(),
        std::io::ErrorKind::PermissionDenied
    );
    assert_eq!(
        post(
            &s,
            PREVIEW,
            &headers(&s),
            &selection("existing", "Public", "project", None).to_string()
        )
        .0,
        503
    );
    drop(mode);
    std::fs::write(root.join("Keep.md"), b"# Note\n").expect("note");
    let mode = safety::FixtureMode::set(&root.join("Keep.md"), 0o400);
    assert_eq!(
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(root.join("Keep.md"))
            .expect_err("actual denied note write")
            .kind(),
        std::io::ErrorKind::PermissionDenied
    );
    assert_eq!(
        post(
            &s,
            PREVIEW,
            &headers(&s),
            &selection("existing", "Public", "project", None).to_string()
        )
        .0,
        503
    );
    drop(mode);
    assert_eq!(
        std::fs::read(s.dir.path().join("server.toml")).expect("preserved"),
        config
    );
    assert_eq!(s.state.len(), 0);
    assert!(!root.join("access.toml").exists());
    drop(s);
    safety::mark_completed(name);
}
#[tokio::test]
async fn external_root_is_dynamically_watched_and_real_events_update_filtered_index_and_policy() {
    let mut s = Server::new(false);
    let root = s.dir.path().join("Projects/Public");
    assert!(
        !s.state.watch_roots().iter().any(|p| root.starts_with(p)),
        "startup did not watch the selected external location"
    );
    let input = preview(&s, selection("existing", "Public", "project", None));
    assert_eq!(post(&s, REGISTER, &headers(&s), &input.to_string()).0, 201);
    for (action, body) in [
        ("create", "# WatchedOne\n"),
        ("change", "# WatchedTwo\n"),
        ("remove", ""),
    ] {
        let fence = root.join(format!(".event-fence-{action}"));
        let fence_generation = s.signal.generation();
        std::fs::write(&fence, b"event-order fence").expect("fixture fence");
        drop(exact_event(&s, &fence, fence_generation).await);
        std::fs::remove_file(&fence).expect("remove fixture fence");
        drop(s.signal.take());
        let generation = s.signal.generation();
        if action == "remove" {
            std::fs::remove_file(root.join("New.md")).expect("delete");
        } else {
            std::fs::write(root.join("New.md"), body).expect("external edit");
        }
        let changes = exact_event(&s, &root.join("New.md"), generation).await;
        let state = s.state.clone();
        tokio::task::spawn_blocking(move || {
            assert!(state.maintain_sync(&changes).is_empty());
            assert!(state.maintain_index(&changes).is_empty());
        })
        .await
        .expect("tick");
        let (status, graph, _) = s.get("/api/v1/vaults/project/graph", &s.admin);
        assert_eq!(status, 200);
        assert_eq!(graph.contains("WatchedOne"), action == "create");
        assert_eq!(graph.contains("WatchedTwo"), action == "change");
    }
    drop(s.signal.take());
    let generation = s.signal.generation();
    std::fs::write(
        root.join("access.toml"),
        b"[[members]]\nuser='bob'\nrole='owner'\n",
    )
    .expect("external ACL change");
    let changes = exact_event(&s, &root.join("access.toml"), generation).await;
    let state = s.state.clone();
    tokio::task::spawn_blocking(move || {
        assert!(state.maintain_sync(&changes).is_empty());
        assert!(state.maintain_index(&changes).is_empty());
    })
    .await
    .expect("policy tick");
    assert_eq!(s.get("/api/v1/vaults/project/graph", &s.admin).0, 404);
    assert_eq!(s.get("/api/v1/vaults/project/graph", &s.user).0, 200);
    drop(s.lease.take());
    drop(s.signal.take());
    let generation = s.signal.generation();
    std::fs::write(root.join("AfterStop.md"), b"# No listener\n").expect("write after teardown");
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_millis(100),
            s.signal.changed_after(generation)
        )
        .await
        .is_err(),
        "dropped lifecycle stops external listener"
    );
    let address = s.addr;
    drop(s);
    assert!(
        std::net::TcpStream::connect(address).is_err(),
        "checked fixture teardown stops HTTP task/listener"
    );
}
async fn exact_event(
    s: &Server,
    path: &std::path::Path,
    mut generation: u64,
) -> mb_server::watch::Changes {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            s.signal.changed_after(generation).await;
            generation = s.signal.generation();
            let changes = s.signal.take();
            match &changes {
                mb_server::watch::Changes::All => {
                    panic!("expected exact real watcher path, not recovery/overflow substitution")
                }
                mb_server::watch::Changes::Only(paths) if paths.contains(path) => return changes,
                _ => {}
            }
        }
    })
    .await
    .expect("exact real filesystem callback must arrive")
}

#[test]
fn prior_registry_locations_media_and_credential_values_are_preserved_without_exposure() {
    let s = Server::configured(true, |config| {
        config.bind = Some("127.0.0.1:0".into());
        config.web_root = Some("fixture-unrelated-web-root".into());
        config.vaults[0].name = Some("PrivateLabel".into());
        config.vaults[0].media = mb_server::MediaBackendConfig::S3 {
            bucket: "fixture-bucket".into(),
            region: "fixture-region".into(),
            endpoint: Some("http://127.0.0.1:9".into()),
            access_key_id: "FixtureAccessCredential".into(),
            secret_access_key: "FixtureSecretCredential".into(),
            allow_http: true,
            virtual_hosted_style: false,
        };
    });
    let prior = s.config();
    let bytes = snapshot(&s.dir.path().join("Projects"));
    for mode in ["existing", "new"] {
        let input = preview(
            &s,
            selection(
                mode,
                if mode == "new" { "" } else { "Public" },
                if mode == "new" { "new" } else { "existing" },
                if mode == "new" { Some("New") } else { None },
            ),
        );
        let (status, body) = post(&s, REGISTER, &headers(&s), &input.to_string());
        assert_eq!(status, 201, "{body}");
        assert!(
            !body.contains("FixtureAccessCredential")
                && !body.contains("FixtureSecretCredential")
                && !body.contains(s.dir.path().to_str().expect("root"))
        );
        let current = s.config();
        assert!(
            current.vaults[0] == prior.vaults[0],
            "prior registration/media/credential values must remain identical; never print them"
        );
        assert_eq!(current.bind, prior.bind);
        assert_eq!(current.web_root, prior.web_root);
        assert!(
            current.vault_locations == prior.vault_locations,
            "locations unchanged"
        );
        let reopened = current.open_vaults(None).expect("fresh registry");
        assert!(
            reopened[0].media_backend() == &prior.vaults[0].media,
            "fresh media compatibility"
        );
        for (path, bytes) in &bytes {
            assert_eq!(
                std::fs::read(s.dir.path().join("Projects").join(path)).expect("preserved bytes"),
                *bytes
            );
        }
    }
}
#[test]
fn new_mode_actual_config_temp_denial_removes_owned_root_preserves_prior_tree_and_retries() {
    let name = "cases::new_mode_actual_config_temp_denial_removes_owned_root_preserves_prior_tree_and_retries";
    if safety::run_unprivileged(name) {
        return;
    }
    let s = Server::new(true);
    let prior = std::fs::read(s.dir.path().join("server.toml")).expect("prior config");
    let before = snapshot(&s.dir.path().join("Projects"));
    let input = preview(&s, selection("new", "", "project", Some("New")));
    let trace = leak::Observer::new(&[&s.dir.path().join("Projects")]);
    let mode = safety::FixtureMode::set(s.dir.path(), 0o500);
    assert_eq!(
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(s.dir.path().join("denied-proof"))
            .expect_err("actual service EACCES")
            .kind(),
        std::io::ErrorKind::PermissionDenied
    );
    assert_eq!(post(&s, REGISTER, &headers(&s), &input.to_string()).0, 503);
    drop(mode);
    let events = trace.events();
    use rustix::fs::inotify::ReadFlags;
    for flag in [ReadFlags::CREATE, ReadFlags::DELETE] {
        assert!(
            events
                .iter()
                .any(|(bits, name)| bits & flag.bits() != 0 && name.as_deref() == Some("New")),
            "owned root prepared and removed at real failure"
        );
    }
    assert!(!s.dir.path().join("Projects/New").exists());
    assert_eq!(snapshot(&s.dir.path().join("Projects")), before);
    assert_eq!(
        std::fs::read(s.dir.path().join("server.toml")).expect("config"),
        prior
    );
    assert_eq!(s.state.len(), 1);
    assert_eq!(s.config().vaults.len(), 1);
    let input = preview(&s, selection("new", "", "project", Some("New")));
    assert_eq!(post(&s, REGISTER, &headers(&s), &input.to_string()).0, 201);
    assert_eq!(s.config().vaults.len(), 2);
    drop(s);
    safety::mark_completed(name);
}
#[test]
fn actual_unprivileged_acl_media_and_index_denials_refuse_without_permission_repairs() {
    let name =
        "cases::actual_unprivileged_acl_media_and_index_denials_refuse_without_permission_repairs";
    if safety::run_unprivileged(name) {
        return;
    }
    for target in ["access.toml", "media", ".memberberry/index"] {
        let s = Server::new(false);
        let root = s.dir.path().join("Projects/Public");
        let before = std::fs::read(s.dir.path().join("server.toml")).expect("config");
        let path = root.join(target);
        if target == "access.toml" {
            std::fs::write(&path, b"[[members]]\nuser='bob'\nrole='owner'\n").expect("policy");
        } else {
            std::fs::create_dir_all(&path).expect("storage directory");
        }
        let mode = safety::FixtureMode::set(&path, if target == "access.toml" { 0 } else { 0o500 });
        if target == "access.toml" {
            assert_eq!(
                std::fs::read(&path)
                    .expect_err("genuine policy denial")
                    .kind(),
                std::io::ErrorKind::PermissionDenied
            );
        } else {
            assert_eq!(
                std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(path.join("denied-proof"))
                    .expect_err("genuine storage denial")
                    .kind(),
                std::io::ErrorKind::PermissionDenied
            );
        }
        assert_eq!(
            post(
                &s,
                PREVIEW,
                &headers(&s),
                &selection("existing", "Public", "project", None).to_string()
            )
            .0,
            503
        );
        assert_eq!(
            std::fs::read(s.dir.path().join("server.toml")).expect("preserved"),
            before
        );
        assert_eq!(s.state.len(), 0);
        drop(mode);
        drop(s);
    }
    safety::mark_completed(name);
}
#[test]
fn nested_fifo_and_scan_limits_refuse_without_partial_adoption() {
    for kind in ["fifo", "depth", "note-bytes"] {
        let s = Server::new(false);
        let root = s.dir.path().join("Projects/Public");
        let config = std::fs::read(s.dir.path().join("server.toml")).expect("config");
        match kind {
            "fifo" => rustix::fs::mknodat(
                rustix::fs::CWD,
                root.join("Pipe.md"),
                rustix::fs::FileType::Fifo,
                rustix::fs::Mode::from_raw_mode(0o600),
                0,
            )
            .expect("fifo"),
            "depth" => {
                let mut path = root.clone();
                for _ in 0..65 {
                    path = path.join("d");
                    std::fs::create_dir(&path).expect("bounded deep fixture");
                }
            }
            _ => {
                let f = std::fs::File::create(root.join("Large.md")).expect("large");
                f.set_len(4 * 1024 * 1024 + 1).expect("size");
            }
        }
        assert_eq!(
            post(
                &s,
                PREVIEW,
                &headers(&s),
                &selection("existing", "Public", "project", None).to_string()
            )
            .0,
            if matches!(kind, "depth" | "note-bytes") {
                422
            } else {
                503
            }
        );
        assert_eq!(
            std::fs::read(s.dir.path().join("server.toml")).expect("preserved"),
            config
        );
        assert_eq!(s.state.len(), 0);
        assert!(!root.join("access.toml").exists());
    }
}

#[test]
fn preview_discloses_mutating_probe_scope_without_claiming_uncreated_child_inventory() {
    for mode in ["existing", "new"] {
        let s = Server::new(false);
        let project = s.dir.path().join("Projects");
        let before = snapshot(&project);
        let input = selection(
            mode,
            if mode == "existing" { "Public" } else { "" },
            "project",
            (mode == "new").then_some("Created"),
        );
        let (status, body) = post(&s, PREVIEW, &headers(&s), &input.to_string());
        assert_eq!(status, 200);
        let body = json(&body);
        assert_eq!(body["mode"], mode);
        assert_eq!(body["read_only"], false);
        assert_eq!(
            body["scope"],
            if mode == "existing" {
                "existing-project"
            } else {
                "existing-parent"
            }
        );
        assert_eq!(body["recursive_markdown"], mode == "existing");
        assert_eq!(body["storage_check"], "bounded_service_identity_probes");
        assert_eq!(snapshot(&project), before);
        assert!(!project.join("Created").exists());
    }
}

#[test]
fn preview_checks_note_descriptors_without_reading_note_bodies() {
    let s = Server::new(false);
    let root = s.dir.path().join("Projects/Public");
    let note = root.join("Secret.md");
    std::fs::write(&note, b"# PreviewPrivateTitle\nPreviewPrivateBody\n").expect("note");
    let observer = leak::Observer::new(&[&note]);
    let (status, body) = post(
        &s,
        PREVIEW,
        &headers(&s),
        &selection("existing", "Public", "project", None).to_string(),
    );
    assert_eq!(status, 200);
    assert!(!body.contains("PreviewPrivateTitle") && !body.contains("PreviewPrivateBody"));
    let events = observer.events();
    use rustix::fs::inotify::ReadFlags;
    assert!(
        events
            .iter()
            .any(|(bits, _)| bits & ReadFlags::OPEN.bits() != 0),
        "positive control: actual note descriptor usability open occurred"
    );
    assert!(
        events
            .iter()
            .all(|(bits, _)| bits & ReadFlags::ACCESS.bits() == 0),
        "preview must not read note bytes"
    );
}
#[test]
fn recursive_entry_directory_total_note_and_project_config_caps_refuse_whole_adoption() {
    for kind in [
        "entries",
        "directories",
        "total-notes",
        "project-config",
        "server-config",
    ] {
        let s = Server::new(false);
        let root = s.dir.path().join("Projects/Public");
        let original = std::fs::read(s.dir.path().join("server.toml")).expect("config");
        match kind {
            "entries" => {
                for i in 0..16385 {
                    std::fs::File::create(root.join(format!("File-{i}.bin")))
                        .expect("bounded entries fixture");
                }
            }
            "directories" => {
                for i in 0..1024 {
                    std::fs::create_dir(root.join(format!("Dir-{i}")))
                        .expect("bounded directory fixture");
                }
            }
            "total-notes" => {
                for i in 0..17 {
                    std::fs::File::create(root.join(format!("Note-{i}.md")))
                        .expect("note")
                        .set_len(4 * 1024 * 1024)
                        .expect("sparse byte cap fixture");
                }
            }
            "project-config" => {
                std::fs::create_dir(root.join(".memberberry")).expect("settings");
                std::fs::File::create(root.join(".memberberry/config.toml"))
                    .expect("config")
                    .set_len(1024 * 1024 + 1)
                    .expect("cap");
            }
            _ => {
                std::fs::File::options()
                    .write(true)
                    .open(s.dir.path().join("server.toml"))
                    .expect("server config")
                    .set_len(1024 * 1024 + 1)
                    .expect("cap");
            }
        }
        let before = std::fs::read(s.dir.path().join("server.toml")).expect("before");
        assert_eq!(
            post(
                &s,
                PREVIEW,
                &headers(&s),
                &selection("existing", "Public", "project", None).to_string()
            )
            .0,
            422,
            "{kind} must refuse, never a partial inventory"
        );
        assert_eq!(
            std::fs::read(s.dir.path().join("server.toml")).expect("after"),
            before
        );
        assert_eq!(s.state.len(), 0);
        assert!(!root.join("access.toml").exists());
        if kind != "server-config" {
            assert_eq!(before, original);
        }
    }
}

#[test]
fn linked_notes_with_scoped_policy_refuses_without_target_reads_or_policy_translation() {
    let s = Server::new(false);
    let root = s.dir.path().join("Projects/Public");
    let outside = s.dir.path().join("LegacyNotes");
    std::fs::create_dir(&outside).expect("outside");
    let secret = outside.join("Private.md");
    std::fs::write(&secret, "# Private legacy target\n").expect("secret");
    std::os::unix::fs::symlink(&outside, root.join("notes")).expect("notes alias");
    let policy = b"[[members]]\nuser='bob'\nrole='owner'\n[[rules]]\npath='Private.md'\ngrant={bob='none'}\n";
    std::fs::write(root.join("access.toml"), policy).expect("policy");
    let before = std::fs::read(s.dir.path().join("server.toml")).expect("config");
    let observer = leak::Observer::new(&[&outside, &secret]);
    let (status, body) = post(
        &s,
        PREVIEW,
        &headers(&s),
        &selection("existing", "Public", "project", None).to_string(),
    );
    assert_eq!(status, 409);
    assert_eq!(json(&body)["error"], "permission_layout_conflict");
    assert!(
        observer.events().is_empty(),
        "the alias target was inspected"
    );
    assert_eq!(
        std::fs::read(root.join("access.toml")).expect("policy"),
        policy
    );
    assert_eq!(
        std::fs::read(s.dir.path().join("server.toml")).expect("config"),
        before
    );
    assert_eq!(s.state.len(), 0);
    std::fs::read(secret).expect("positive observer control");
    assert!(!observer.events().is_empty());
}
