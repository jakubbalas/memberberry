//! Deterministic S1 compatibility/revalidation boundaries, never sleeps or retries.
use super::*;
const SCOPED: &[u8] =
    b"[[members]]\nuser='bob'\nrole='viewer'\n[[rules]]\npath='Private.md'\ngrant={bob='none'}\n";
const MEMBERS: &[u8] = b"[[members]]\nuser='bob'\nrole='viewer'\n";
const NOTE: &[u8] = b"# Preserved\nSYNTHETIC_ONLY_CONTENT\n";
fn project(f: &Fixture) -> std::path::PathBuf {
    f.dir.path().join("Projects/Public")
}
fn compatible(f: &Fixture, add_notes: bool) {
    let root = project(f);
    if add_notes {
        std::fs::write(root.join("access.toml"), SCOPED).expect("scoped no notes");
    } else {
        std::fs::create_dir(root.join("notes")).expect("notes");
        std::fs::write(root.join("notes/Private.md"), NOTE).expect("note");
        std::fs::write(root.join("access.toml"), MEMBERS).expect("member only");
    }
}
fn incompatible(f: &Fixture, add_notes: bool) {
    let root = project(f);
    if add_notes {
        std::fs::create_dir(root.join("notes")).expect("new notes");
        std::fs::write(root.join("notes/Private.md"), NOTE).expect("foreign note");
    } else {
        std::fs::write(root.join("access.toml"), SCOPED).expect("new rule");
    }
}
fn unpublished(f: &Fixture, config: &[u8]) {
    f.assert_unpublished(config);
    assert!(f.state.security.access.read().expect("policies").is_empty());
    assert!(f.state.indexes.indexes.read().expect("indexes").is_empty());
    assert!(
        f.state
            .watchers
            .0
            .lock()
            .expect("watchers")
            .as_ref()
            .expect("live")
            .roots
            .keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>()
            == f.state.watch_roots().into_iter().collect(),
        "only the preexisting management watcher remains; no project enrollment"
    );
    assert_eq!(
        std::fs::read(project(f).join("access.toml")).expect("policy"),
        SCOPED
    );
    assert_eq!(
        std::fs::read(project(f).join("notes/Private.md")).expect("note"),
        NOTE
    );
    for directory in [f.dir.path().to_path_buf(), project(f)] {
        assert!(
            !std::fs::read_dir(directory).expect("names").any(|e| e
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .starts_with(".memberberry-")),
            "owned temporaries must be cleaned"
        );
    }
}
async fn refusal(response: Response) {
    assert_eq!(
        response.status(),
        StatusCode::CONFLICT,
        "compatibility must refuse before actual rename"
    );
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let bytes = axum::body::to_bytes(response.into_body(), 8192)
        .await
        .expect("body");
    let text = std::str::from_utf8(&bytes).expect("utf8");
    for secret in [
        "Private.md",
        "bob",
        "SYNTHETIC_ONLY_CONTENT",
        "confirmation",
    ] {
        assert!(!text.contains(secret));
    }
}
#[tokio::test]
async fn initial_refusal_has_no_receipt_probe_index_or_watcher_publication() {
    let f = Fixture::new();
    compatible(&f, true);
    incompatible(&f, true);
    let config = f.config_bytes();
    let response = handle(
        f.state.clone(),
        Fixture::request(f.headers.clone(), f.input(false), false),
        false,
    )
    .await;
    refusal(response).await;
    assert!(
        f.state
            .registration
            .receipts
            .lock()
            .expect("receipts")
            .is_empty()
    );
    assert!(
        f.state
            .registration
            .hooks
            .staged
            .lock()
            .expect("staged watcher")
            .is_none()
    );
    // A syntactically valid invented confirmation must not defer compatibility to receipt lookup.
    let mut input = f.input(false);
    input["confirmation"] = "0".repeat(64).into();
    refusal(
        handle(
            f.state.clone(),
            Fixture::request(f.headers.clone(), input, true),
            true,
        )
        .await,
    )
    .await;
    unpublished(&f, &config);
}
#[tokio::test]
async fn notes_or_rules_appearing_after_preview_refuse_without_consuming_valid_receipt() {
    for add_notes in [false, true] {
        let f = Fixture::new();
        compatible(&f, add_notes);
        let input = f.confirmed(false).await;
        let config = f.config_bytes();
        incompatible(&f, add_notes);
        refusal(
            handle(
                f.state.clone(),
                Fixture::request(f.headers.clone(), input, true),
                true,
            )
            .await,
        )
        .await;
        unpublished(&f, &config);
        assert_eq!(
            f.state.registration.receipts.lock().expect("receipt").len(),
            1,
            "guard precedes confirmation storage/receipt operations"
        );
    }
}
async fn held_change(phase: Phase) {
    for add_notes in [false, true] {
        let f = Fixture::new();
        compatible(&f, add_notes);
        let input = f.confirmed(false).await;
        let config = f.config_bytes();
        let (ready, release) = f.state.registration.hooks.arm(phase);
        let task = spawn(&f, input, true);
        wait(ready).await;
        if phase == Phase::BeforeCommit || phase == Phase::FinalAuthorization {
            assert!(
                std::fs::read_dir(f.dir.path())
                    .expect("config temp")
                    .any(|e| e
                        .expect("entry")
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".memberberry-")),
                "must reach actual prepared config before refusal"
            );
        }
        incompatible(&f, add_notes);
        release.send(()).expect("release");
        refusal(task.await.expect("handler")).await;
        unpublished(&f, &config);
    }
}
#[tokio::test]
async fn notes_or_rules_appearing_at_preparation_refuse() {
    held_change(Phase::BeforeMutation).await;
}
#[tokio::test]
async fn notes_or_rules_appearing_after_storage_preparation_refuse() {
    held_change(Phase::AfterStorageCheck).await;
}
#[tokio::test]
async fn notes_or_rules_appearing_before_commit_refuse_config_rename() {
    held_change(Phase::BeforeCommit).await;
}
#[tokio::test]
async fn notes_or_rules_appearing_at_final_authorization_refuse_actual_rename() {
    held_change(Phase::FinalAuthorization).await;
}
#[tokio::test]
async fn final_refusal_preserves_foreign_replacement_of_owned_config_temporary() {
    let f = Fixture::new();
    compatible(&f, false);
    let input = f.confirmed(false).await;
    let config = f.config_bytes();
    let (ready, release) = f.state.registration.hooks.arm(Phase::FinalAuthorization);
    let task = spawn(&f, input, true);
    wait(ready).await;
    let temp = std::fs::read_dir(f.dir.path())
        .expect("temp")
        .map(|e| e.expect("entry").path())
        .find(|p| {
            p.file_name()
                .expect("name")
                .to_string_lossy()
                .starts_with(".memberberry-")
        })
        .expect("owned config reached");
    std::fs::remove_file(&temp).expect("replace");
    std::fs::write(&temp, b"FOREIGN_BYTES").expect("foreign");
    incompatible(&f, false);
    release.send(()).expect("release");
    refusal(task.await.expect("handler")).await;
    f.assert_unpublished(&config);
    assert_eq!(
        std::fs::read(&temp).expect("foreign retained"),
        b"FOREIGN_BYTES"
    );
    assert!(f.state.security.access.read().expect("policies").is_empty());
    assert!(f.state.indexes.indexes.read().expect("index").is_empty());
    assert!(
        f.state
            .watchers
            .0
            .lock()
            .expect("watch")
            .as_ref()
            .expect("live")
            .roots
            .keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>()
            == f.state.watch_roots().into_iter().collect(),
        "preexisting management watcher only"
    );
}
#[tokio::test]
async fn revoked_authority_supersedes_incompatibility_before_fs() {
    let f = Fixture::new();
    compatible(&f, true);
    incompatible(&f, true);
    f.state
        .security
        .auth
        .lock()
        .expect("auth")
        .set_admin(f.admin, false)
        .expect("demote");
    assert_eq!(f.call(f.input(false), false).await.0, StatusCode::NOT_FOUND);
    assert_eq!(
        f.state.registration.hooks.before_fs.load(Ordering::Relaxed),
        0
    );
}
#[tokio::test]
async fn revoked_authority_at_finished_supersedes_compatibility_guidance() {
    let f = Fixture::new();
    compatible(&f, true);
    incompatible(&f, true);
    let config = f.config_bytes();
    let (ready, release) = f.state.registration.hooks.arm(Phase::Finished);
    let task = spawn(&f, f.input(false), false);
    wait(ready).await;
    f.state
        .security
        .auth
        .lock()
        .expect("auth")
        .set_admin(f.admin, false)
        .expect("demote");
    release.send(()).expect("release");
    let response = task.await.expect("handler");
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let bytes = axum::body::to_bytes(response.into_body(), 8192)
        .await
        .expect("body");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&bytes).expect("json"),
        serde_json::json!({"error":"not_found"})
    );
    unpublished(&f, &config);
}
#[test]
fn guard_has_no_descendant_stat_or_usability_work_with_positive_counter_control() {
    let f = Fixture::new();
    compatible(&f, true);
    incompatible(&f, true);
    let fd = rustix::fs::open(
        project(&f),
        rustix::fs::OFlags::RDONLY | rustix::fs::OFlags::DIRECTORY,
        rustix::fs::Mode::empty(),
    )
    .expect("pinned fixture");
    storage::WALK_STATS.with(|count| count.set(0));
    let result = storage::layout(&fd)
        .and_then(|(layout, _)| storage::usable(&fd, &layout, false, || Ok(())));
    assert!(matches!(result, Err(Refusal::PolicyLayout)));
    assert_eq!(
        storage::WALK_STATS.with(|count| count.get()),
        0,
        "stat is not observable through inotify"
    );
    std::fs::write(project(&f).join("access.toml"), MEMBERS).expect("compatible control");
    let (layout, _) = storage::layout(&fd).expect("compatible");
    assert!(
        storage::usable(&fd, &layout, false, || Ok(()))
            .expect("usable")
            .contains(&"notes/Private.md".to_owned())
    );
    assert!(
        storage::WALK_STATS.with(|count| count.get()) > 0,
        "counter sees actual descendant stats"
    );
}
#[test]
fn generated_guard_depends_only_on_notes_and_presence_of_rules_not_roles_or_intent() {
    use proptest::prelude::*;
    let config = proptest::test_runner::Config {
        cases: 128,
        rng_seed: proptest::test_runner::RngSeed::Fixed(0x529),
        failure_persistence: None,
        ..Default::default()
    };
    let mut runner = proptest::test_runner::TestRunner::new(config);
    runner
        .run(
            &(
                any::<bool>(),
                any::<bool>(),
                any::<bool>(),
                0usize..8,
                0usize..4,
            ),
            |(notes, present, root_relative, rules, role)| {
                let role = ["none", "viewer", "editor", "owner"][role];
                let mut text = format!("[[members]]\nuser='bob'\nrole='{role}'\n");
                for i in 0..rules {
                    let path = if root_relative {
                        format!("notes/Private{i}.md")
                    } else {
                        format!("Private{i}.md")
                    };
                    text.push_str(&format!(
                        "[[rules]]\npath='{path}'\ngrant={{bob='{role}'}}\n"
                    ));
                }
                let policy = AccessFile::parse(&text).expect("generated valid policy");
                let access = present.then_some(policy.policy());
                prop_assert_eq!(
                    storage::permission_layout_compatible(notes, access),
                    !(notes && present && rules > 0)
                );
                // Adding a rule with a real notes directory can only restrict adoption, never admit it.
                if notes && present && rules > 0 {
                    prop_assert!(!storage::permission_layout_compatible(notes, access));
                }
                Ok(())
            },
        )
        .expect("seeded bounded guard invariant");
}
