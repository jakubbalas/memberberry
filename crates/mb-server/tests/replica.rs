//! A desktop replica kept in step with a vault on the user's server (`SPEC.md` §7.6.9).
//!
//! Both sides are real: the user's server over HTTP and the sync socket with a device token,
//! and the desktop app's embedded server in-process. Each test changes one side, runs a
//! pass, and looks at the files on the other — the Markdown is the truth (C2).

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

use std::path::{Path, PathBuf};
use std::sync::Arc;

use mb_server::Vault;
use mb_server::http::{AppState, router};
use mb_server::replica::pins::{self, PinKind};
use mb_server::replica::upstream::Upstream;
use mb_server::replica::{ReplicaConfig, ReplicaError, create_local, pass};
use mb_server::vault::Slug;

const PASSWORD: &str = "correct horse battery staple";
const REDIRECT: &str = "http://127.0.0.1:4000/desktop/connect/callback";

struct Fixture {
    _dir: tempfile::TempDir,
    upstream_root: PathBuf,
    local_root: PathBuf,
    local: AppState,
    config: ReplicaConfig,
    upstream: Upstream,
    server: Arc<AppState>,
    _stop: tokio::sync::oneshot::Sender<()>,
}

fn device_token(auth: &mut mb_auth::AuthDb, user: mb_auth::UserId) -> String {
    let verifier = "v".repeat(43);
    let code = auth
        .approve_device(mb_auth::DeviceApproval {
            user_id: user,
            device_name: "Laptop",
            redirect_uri: REDIRECT,
            code_challenge: &mb_auth::pkce_challenge(&verifier),
        })
        .expect("approve");
    auth.exchange_device_code(&code, &verifier, REDIRECT)
        .expect("exchange")
        .expect("grant")
        .token
        .expose_secret()
        .to_string()
}

/// A server vault `work` alice owns, holding `notes`, and a desktop app keeping the whole
/// vault available offline.
async fn fixture(notes: &[(&str, &str)]) -> Fixture {
    let fx = fixture_without_pins(notes).await;
    fx.pin(PinKind::Vault, "", true);
    fx
}

/// As [`fixture`], with nothing available offline yet.
async fn fixture_without_pins(notes: &[(&str, &str)]) -> Fixture {
    let dir = tempfile::tempdir().expect("dir");
    let upstream_root = dir.path().join("server/work");
    std::fs::create_dir_all(upstream_root.join("notes")).expect("notes");
    std::fs::write(
        upstream_root.join("access.toml"),
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n",
    )
    .expect("policy");
    for (path, text) in notes {
        let file = upstream_root.join("notes").join(path);
        std::fs::create_dir_all(file.parent().expect("parent")).expect("folder");
        std::fs::write(file, text).expect("note");
    }
    let vault =
        Vault::open(Slug::parse("work").expect("slug"), "Work", &upstream_root).expect("vault");
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth");
    let alice = auth
        .setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: PASSWORD,
        })
        .expect("alice");
    let token = device_token(&mut auth, alice.id);
    let server = Arc::new(AppState::authenticated(vec![vault], auth).expect("server"));
    let errors = server.maintain_index(&mb_server::watch::Changes::All);
    assert!(errors.is_empty(), "{errors:?}");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let origin = format!("http://{}", listener.local_addr().expect("addr"));
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let app = router(Arc::clone(&server));
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .with_graceful_shutdown(async {
            drop(stopped.await);
        })
        .await
    });

    let app_data = dir.path().join("app");
    std::fs::create_dir_all(&app_data).expect("app data");
    let mut local_auth = mb_auth::AuthDb::open(&app_data.join("auth.db")).expect("local auth");
    mb_server::desktop::ensure_local_user(&mut local_auth, "Jo").expect("local user");
    let local = AppState::authenticated(vec![], local_auth)
        .expect("local")
        .with_vault_management_root(app_data.join("server.toml"), dir.path().join("home"), false)
        .expect("management");
    let config = ReplicaConfig {
        local: "work".into(),
        upstream: "work".into(),
        name: "Work".into(),
        origin: origin.clone(),
    };
    let local_root = dir.path().join("home/127.0.0.1/work");
    create_local(&local, &config, &local_root).expect("replica vault");
    let upstream = Upstream::new(&origin, &token).expect("upstream");
    Fixture {
        _dir: dir,
        upstream_root,
        local_root,
        local,
        config,
        upstream,
        server,
        _stop: stop,
    }
}

impl Fixture {
    async fn sync(&self) -> mb_server::replica::PassReport {
        pass(&self.local, &self.config, &self.upstream)
            .await
            .expect("pass")
    }

    fn upstream_file(&self, path: &str) -> Option<String> {
        std::fs::read_to_string(self.upstream_root.join("notes").join(path)).ok()
    }

    fn local_file(&self, path: &str) -> Option<String> {
        std::fs::read_to_string(self.local_root.join("notes").join(path)).ok()
    }

    fn write_upstream(&self, path: &str, text: &str) {
        write(&self.upstream_root.join("notes").join(path), text);
        let _ = self.server.maintain_index(&mb_server::watch::Changes::All);
    }

    fn write_local(&self, path: &str, text: &str) {
        write(&self.local_root.join("notes").join(path), text);
    }

    fn pin(&self, kind: PinKind, path: &str, offline: bool) {
        let mut current = pins::load(&self.local_root, []).expect("pins");
        current.set(kind, path, offline);
        pins::save(&self.local_root, &current).expect("save pins");
    }
}

/// Writes a file so its fingerprint differs from before even within one clock tick.
fn write(file: &Path, text: &str) {
    std::fs::create_dir_all(file.parent().expect("parent")).expect("folder");
    std::fs::write(file, text).expect("write");
    let later = std::time::SystemTime::now() + std::time::Duration::from_secs(2);
    std::fs::File::options()
        .write(true)
        .open(file)
        .and_then(|f| f.set_modified(later))
        .expect("touch");
}

#[tokio::test]
async fn downloading_writes_every_note_as_upstream_has_it() {
    let fx = fixture(&[("One.md", "# One\n\nfirst\n"), ("Folder/Two.md", "# Two\n")]).await;
    fx.sync().await;
    assert_eq!(fx.local_file("One.md").as_deref(), Some("# One\n\nfirst\n"));
    assert_eq!(fx.local_file("Folder/Two.md").as_deref(), Some("# Two\n"));
}

#[tokio::test]
async fn a_second_pass_with_nothing_changed_changes_nothing() {
    let fx = fixture(&[("One.md", "# One\n\nfirst\n")]).await;
    fx.sync().await;
    let report = fx.sync().await;
    assert_eq!((report.downloaded, report.uploaded), (0, 0), "{report:?}");
}

#[tokio::test]
async fn an_edit_upstream_reaches_this_device() {
    let fx = fixture(&[("One.md", "# One\n\nfirst\n")]).await;
    fx.sync().await;
    fx.write_upstream("One.md", "# One\n\nfirst\n\nadded upstream\n");
    fx.sync().await;
    assert_eq!(
        fx.local_file("One.md").as_deref(),
        Some("# One\n\nfirst\n\nadded upstream\n")
    );
}

#[tokio::test]
async fn an_edit_here_reaches_upstream_without_duplicating_anything() {
    let fx = fixture(&[("One.md", "# One\n\nfirst\n")]).await;
    fx.sync().await;
    fx.write_local("One.md", "# One\n\nfirst\n\nadded here\n");
    fx.sync().await;
    fx.server.sync_flush_for_test();
    assert_eq!(
        fx.upstream_file("One.md").as_deref(),
        Some("# One\n\nfirst\n\nadded here\n")
    );
}

#[tokio::test]
async fn edits_on_both_sides_merge() {
    let fx = fixture(&[("One.md", "# One\n\nmiddle\n")]).await;
    fx.sync().await;
    fx.write_upstream("One.md", "# One\n\nupstream first\n\nmiddle\n");
    fx.write_local("One.md", "# One\n\nmiddle\n\nhere last\n");
    fx.sync().await;
    fx.server.sync_flush_for_test();
    let expected = "# One\n\nupstream first\n\nmiddle\n\nhere last\n";
    assert_eq!(fx.local_file("One.md").as_deref(), Some(expected));
    assert_eq!(fx.upstream_file("One.md").as_deref(), Some(expected));
}

#[tokio::test]
async fn a_note_created_here_is_created_upstream() {
    let fx = fixture(&[]).await;
    fx.sync().await;
    fx.write_local("New.md", "# New\n\nwritten offline\n");
    fx.sync().await;
    assert_eq!(
        fx.upstream_file("New.md").as_deref(),
        Some("# New\n\nwritten offline\n")
    );
}

#[tokio::test]
async fn a_note_created_upstream_and_then_edited_here_does_not_duplicate() {
    let fx = fixture(&[]).await;
    fx.sync().await;
    fx.write_local("New.md", "# New\n\nonce\n");
    fx.sync().await;
    fx.write_local("New.md", "# New\n\nonce\n\ntwice\n");
    fx.sync().await;
    fx.server.sync_flush_for_test();
    assert_eq!(
        fx.upstream_file("New.md").as_deref(),
        Some("# New\n\nonce\n\ntwice\n")
    );
}

#[tokio::test]
async fn a_note_deleted_upstream_is_purged_here_not_trashed() {
    let fx = fixture(&[("One.md", "# One\n\npurge-marker\n"), ("Two.md", "# Two\n")]).await;
    fx.sync().await;
    std::fs::remove_file(fx.upstream_root.join("notes/One.md")).expect("delete");
    let _ = fx.server.maintain_index(&mb_server::watch::Changes::All);
    let report = fx.sync().await;
    assert!(fx.local_file("One.md").is_none() && fx.local_file("Two.md").is_some());
    assert_eq!(report.purged, 1, "{report:?}");
    assert_eq!(
        files_holding(&fx.local_root, "purge-marker"),
        Vec::<PathBuf>::new()
    );
}

#[tokio::test]
async fn a_note_deleted_here_goes_to_upstreams_trash() {
    let fx = fixture(&[("One.md", "# One\n"), ("Two.md", "# Two\n")]).await;
    fx.sync().await;
    std::fs::remove_file(fx.local_root.join("notes/One.md")).expect("delete");
    fx.sync().await;
    assert!(fx.upstream_file("One.md").is_none() && fx.upstream_file("Two.md").is_some());
}

/// Every file under `root` whose bytes contain `marker` — the note, its sidecar, a trash
/// entry, an index, a cache — so a purge is checked against the whole replica, not one path.
fn files_holding(root: &Path, marker: &str) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if std::fs::read(&path).is_ok_and(|bytes| {
                bytes
                    .windows(marker.len())
                    .any(|window| window == marker.as_bytes())
            }) {
                found.push(path);
            }
        }
    }
    found
}

fn recovered_list(fx: &Fixture) -> Vec<mb_server::replica::recovered::Recovered> {
    mb_server::replica::recovered::load(&fx.local_root)
}

#[tokio::test]
async fn a_note_deleted_upstream_but_edited_here_is_recovered_whole() {
    let fx = fixture(&[("Projects/One.md", "---\nid: n1\n---\n# One\n\ntheirs\n")]).await;
    fx.sync().await;
    std::fs::remove_file(fx.upstream_root.join("notes/Projects/One.md")).expect("delete");
    let _ = fx.server.maintain_index(&mb_server::watch::Changes::All);
    fx.write_local(
        "Projects/One.md",
        "---\nid: n1\n---\n# One\n\ntheirs\n\nunsent work\n",
    );
    let report = fx.sync().await;
    assert_eq!(report.recovered, 1, "{report:?}");
    assert!(fx.local_file("Projects/One.md").is_none());
    assert_eq!(
        fx.local_file("Recovered/One (offline edits).md").as_deref(),
        Some("# One\n\ntheirs\n\nunsent work\n")
    );
    let listed = recovered_list(&fx);
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].path, "Recovered/One (offline edits).md");
    assert_eq!(listed[0].original, "Projects/One.md");
}

#[tokio::test]
async fn a_recovered_note_is_never_uploaded_on_its_own() {
    let fx = fixture(&[("One.md", "# One\n")]).await;
    fx.sync().await;
    std::fs::remove_file(fx.upstream_root.join("notes/One.md")).expect("delete");
    let _ = fx.server.maintain_index(&mb_server::watch::Changes::All);
    fx.write_local("One.md", "# One\n\nunsent work\n");
    fx.sync().await;
    fx.write_local(
        "Recovered/One (offline edits).md",
        "# One\n\nunsent work, and more\n",
    );
    let report = fx.sync().await;
    assert_eq!(report.uploaded, 0, "{report:?}");
    assert!(
        fx.upstream_file("Recovered/One (offline edits).md")
            .is_none()
    );
    assert!(files_holding(&fx.upstream_root, "unsent work").is_empty());
}

#[tokio::test]
async fn a_recovered_note_the_user_deleted_is_forgotten() {
    let fx = fixture(&[("One.md", "# One\n")]).await;
    fx.sync().await;
    std::fs::remove_file(fx.upstream_root.join("notes/One.md")).expect("delete");
    let _ = fx.server.maintain_index(&mb_server::watch::Changes::All);
    fx.write_local("One.md", "# One\n\nunsent work\n");
    fx.sync().await;
    std::fs::remove_file(fx.local_root.join("notes/Recovered/One (offline edits).md"))
        .expect("delete");
    fx.sync().await;
    assert!(recovered_list(&fx).is_empty());
}

#[tokio::test]
async fn a_recovered_note_stays_out_of_sync_without_its_bookkeeping() {
    let fx = fixture(&[("One.md", "# One\n")]).await;
    fx.sync().await;
    std::fs::remove_file(fx.upstream_root.join("notes/One.md")).expect("delete");
    let _ = fx.server.maintain_index(&mb_server::watch::Changes::All);
    fx.write_local("One.md", "# One\n\nunsent work\n");
    fx.sync().await;
    std::fs::remove_dir_all(fx.local_root.join(".memberberry")).expect("I1");
    fx.sync().await;
    assert!(fx.local_file("Recovered/One (offline edits).md").is_some());
    assert!(files_holding(&fx.upstream_root, "unsent work").is_empty());
}

#[tokio::test]
async fn a_note_whose_access_was_removed_is_purged_or_recovered() {
    let fx = fixture(&[
        ("Private/Kept.md", "# Kept\n\nowner-text-a\n"),
        ("Private/Edited.md", "# Edited\n\nowner-text-b\n"),
        ("Open.md", "# Open\n"),
    ])
    .await;
    fx.pin(PinKind::Note, "Private/Kept.md", true);
    fx.sync().await;
    fx.write_local(
        "Private/Edited.md",
        "# Edited\n\nowner-text-b\n\nmy-offline-line\n",
    );
    std::fs::write(
        fx.upstream_root.join("access.toml"),
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n[[rules]]\npath = \"Private\"\ngrant = { alice = \"none\" }\n",
    )
    .expect("policy");
    assert!(fx.server.reload_access().is_empty());
    let report = fx.sync().await;
    assert_eq!((report.purged, report.recovered), (1, 1), "{report:?}");
    assert_eq!(
        files_holding(&fx.local_root, "owner-text-a"),
        Vec::<PathBuf>::new()
    );
    // The whole note, as the user chose (§7.6.7): their line, in context.
    let recovered = fx
        .local_file("Recovered/Edited (offline edits).md")
        .expect("recovered");
    assert!(recovered.contains("my-offline-line") && recovered.contains("owner-text-b"));
    // The original's sidecar went with it: one history holds the text, the recovered note's.
    let sidecars: Vec<PathBuf> = files_holding(&fx.local_root, "owner-text-b")
        .into_iter()
        .filter(|p| p.to_string_lossy().contains("/.memberberry/crdt/"))
        .collect();
    assert_eq!(sidecars.len(), 1, "{sidecars:?}");
    let pins = pins::load(&fx.local_root, []).expect("pins");
    assert!(!pins.notes.contains("Private/Kept.md"), "{pins:?}");
    assert!(fx.local_file("Open.md").is_some());
}

#[tokio::test]
async fn a_note_moved_upstream_out_of_the_pinned_folder_is_not_recovered() {
    let fx = fixture_without_pins(&[("Pinned/One.md", "---\nid: n1\n---\n# One\n")]).await;
    fx.pin(PinKind::Folder, "Pinned", true);
    fx.sync().await;
    fx.write_local("Pinned/One.md", "---\nid: n1\n---\n# One\n\nmine\n");
    std::fs::create_dir_all(fx.upstream_root.join("notes/Elsewhere")).expect("folder");
    std::fs::rename(
        fx.upstream_root.join("notes/Pinned/One.md"),
        fx.upstream_root.join("notes/Elsewhere/One.md"),
    )
    .expect("move");
    let _ = fx.server.maintain_index(&mb_server::watch::Changes::All);
    let report = fx.sync().await;
    assert_eq!(report.recovered, 0, "{report:?}");
    assert!(recovered_list(&fx).is_empty());
    assert!(
        fx.upstream_file("Elsewhere/One.md")
            .expect("upstream")
            .contains("mine")
    );
}

#[tokio::test]
async fn a_note_deleted_here_but_edited_upstream_comes_back() {
    let fx = fixture(&[("One.md", "# One\n")]).await;
    fx.sync().await;
    std::fs::remove_file(fx.local_root.join("notes/One.md")).expect("delete");
    fx.write_upstream("One.md", "# One\n\nnewer\n");
    fx.sync().await;
    assert_eq!(fx.local_file("One.md").as_deref(), Some("# One\n\nnewer\n"));
}

#[tokio::test]
async fn a_rename_upstream_moves_the_note_here() {
    let fx = fixture(&[(
        "Old.md",
        "---\nid: 0190a1b2-0000-7000-8000-00000000000a\n---\n# Old\n",
    )])
    .await;
    fx.sync().await;
    std::fs::rename(
        fx.upstream_root.join("notes/Old.md"),
        fx.upstream_root.join("notes/New.md"),
    )
    .expect("rename");
    let _ = fx.server.maintain_index(&mb_server::watch::Changes::All);
    fx.sync().await;
    assert!(fx.local_file("Old.md").is_none() && fx.local_file("New.md").is_some());
}

#[tokio::test]
async fn a_rename_here_moves_the_note_upstream() {
    let fx = fixture(&[(
        "Old.md",
        "---\nid: 0190a1b2-0000-7000-8000-00000000000b\n---\n# Old\n",
    )])
    .await;
    fx.sync().await;
    std::fs::rename(
        fx.local_root.join("notes/Old.md"),
        fx.local_root.join("notes/New.md"),
    )
    .expect("rename");
    fx.sync().await;
    assert!(fx.upstream_file("Old.md").is_none() && fx.upstream_file("New.md").is_some());
}

#[tokio::test]
async fn a_renamed_note_edited_here_afterwards_merges_rather_than_forking() {
    let fx = fixture(&[(
        "Old.md",
        "---\nid: 0190a1b2-0000-7000-8000-00000000000c\n---\n# Old\n",
    )])
    .await;
    fx.sync().await;
    std::fs::rename(
        fx.local_root.join("notes/Old.md"),
        fx.local_root.join("notes/New.md"),
    )
    .expect("rename");
    fx.sync().await;
    fx.write_local(
        "New.md",
        "---\nid: 0190a1b2-0000-7000-8000-00000000000c\n---\n# Old\n\nmore\n",
    );
    fx.sync().await;
    fx.server.sync_flush_for_test();
    // The server writes its canonical form (a blank line after frontmatter); what matters is
    // that the edit arrived once and the note did not fork.
    let upstream = fx.upstream_file("New.md").expect("moved upstream");
    assert!(fx.local_file("New (this device).md").is_none());
    assert!(
        upstream.ends_with("# Old\n\nmore\n") && upstream.matches("# Old").count() == 1,
        "{upstream}"
    );
}

#[tokio::test]
async fn two_notes_created_at_one_path_are_both_kept() {
    let fx = fixture(&[]).await;
    fx.sync().await;
    fx.write_upstream(
        "Plan.md",
        "---\nid: 0190a1b2-0000-7000-8000-0000000000a1\n---\n# Theirs\n",
    );
    fx.write_local(
        "Plan.md",
        "---\nid: 0190a1b2-0000-7000-8000-0000000000b2\n---\n# Mine\n",
    );
    fx.sync().await;
    assert!(fx.local_file("Plan.md").unwrap().contains("Theirs"));
    assert!(
        fx.upstream_file("Plan (this device).md")
            .unwrap()
            .contains("Mine")
    );
}

#[tokio::test]
async fn without_the_sync_record_nothing_is_deleted_or_duplicated() {
    let fx = fixture(&[("One.md", "# One\n\nfirst\n"), ("Two.md", "# Two\n")]).await;
    fx.sync().await;
    std::fs::remove_dir_all(fx.local_root.join(".memberberry")).expect("I1");
    std::fs::remove_file(fx.local_root.join("notes/Two.md")).expect("delete");
    fx.sync().await;
    fx.server.sync_flush_for_test();
    assert_eq!(
        fx.upstream_file("One.md").as_deref(),
        Some("# One\n\nfirst\n")
    );
    assert_eq!(fx.upstream_file("Two.md").as_deref(), Some("# Two\n"));
    // The pins went with `.memberberry/`, so only what was still on disk stays downloaded;
    // `Two.md` is online-only now, and — what matters — still on the server.
    assert_eq!(fx.local_file("One.md").as_deref(), Some("# One\n\nfirst\n"));
    assert!(fx.local_file("One (this device).md").is_none());
}

#[tokio::test]
async fn a_revoked_device_stops_syncing() {
    let fx = fixture(&[("One.md", "# One\n")]).await;
    fx.sync().await;
    fx.server.revoke_all_devices_for_test();
    let result = pass(&fx.local, &fx.config, &fx.upstream).await;
    assert!(
        matches!(result, Err(ReplicaError::Unauthorized)),
        "{result:?}"
    );
}

#[tokio::test]
async fn without_a_pin_nothing_is_downloaded() {
    let fx = fixture_without_pins(&[("One.md", "# One\n")]).await;
    fx.sync().await;
    assert!(fx.local_file("One.md").is_none());
}

#[tokio::test]
async fn pinning_a_note_downloads_that_note_only() {
    let fx = fixture_without_pins(&[("One.md", "# One\n"), ("Two.md", "# Two\n")]).await;
    fx.pin(PinKind::Note, "One.md", true);
    fx.sync().await;
    assert!(fx.local_file("One.md").is_some() && fx.local_file("Two.md").is_none());
}

#[tokio::test]
async fn a_folder_pin_also_downloads_notes_created_there_later() {
    let fx =
        fixture_without_pins(&[("Projects/Plan.md", "# Plan\n"), ("Other.md", "# Other\n")]).await;
    fx.pin(PinKind::Folder, "Projects", true);
    fx.sync().await;
    fx.write_upstream("Projects/Later.md", "# Later\n");
    fx.sync().await;
    assert!(fx.local_file("Projects/Later.md").is_some() && fx.local_file("Other.md").is_none());
}

#[tokio::test]
async fn online_only_removes_the_local_copy_and_leaves_upstream_alone() {
    let fx = fixture_without_pins(&[("One.md", "# One\n")]).await;
    fx.pin(PinKind::Note, "One.md", true);
    fx.sync().await;
    fx.pin(PinKind::Note, "One.md", false);
    let report = fx.sync().await;
    assert!(fx.local_file("One.md").is_none(), "{report:?}");
    assert_eq!(fx.upstream_file("One.md").as_deref(), Some("# One\n"));
}

#[tokio::test]
async fn online_only_sends_unsent_changes_before_removing_the_copy() {
    let fx = fixture_without_pins(&[("One.md", "# One\n")]).await;
    fx.pin(PinKind::Note, "One.md", true);
    fx.sync().await;
    fx.write_local("One.md", "# One\n\nwritten offline\n");
    fx.pin(PinKind::Note, "One.md", false);
    fx.sync().await;
    fx.server.sync_flush_for_test();
    assert!(fx.local_file("One.md").is_none());
    assert_eq!(
        fx.upstream_file("One.md").as_deref(),
        Some("# One\n\nwritten offline\n")
    );
}

#[tokio::test]
async fn a_released_note_is_not_put_in_upstreams_trash() {
    let fx = fixture_without_pins(&[("One.md", "# One\n")]).await;
    fx.pin(PinKind::Note, "One.md", true);
    fx.sync().await;
    fx.pin(PinKind::Note, "One.md", false);
    fx.sync().await;
    fx.sync().await;
    assert!(fx.upstream_file("One.md").is_some());
}

#[tokio::test]
async fn a_note_written_here_while_offline_is_uploaded_and_stays_downloaded() {
    let fx = fixture_without_pins(&[]).await;
    fx.sync().await;
    fx.write_local("New.md", "# New\n");
    fx.sync().await;
    fx.sync().await;
    assert!(fx.upstream_file("New.md").is_some() && fx.local_file("New.md").is_some());
}

#[tokio::test]
async fn losing_the_pin_file_keeps_every_downloaded_note() {
    let fx = fixture_without_pins(&[("One.md", "# One\n"), ("Two.md", "# Two\n")]).await;
    fx.pin(PinKind::Note, "One.md", true);
    fx.sync().await;
    std::fs::remove_file(fx.local_root.join(".memberberry/replica/pins.json")).expect("lose pins");
    fx.sync().await;
    assert!(fx.local_file("One.md").is_some() && fx.local_file("Two.md").is_none());
}

#[tokio::test]
async fn the_last_upstream_list_is_kept_for_offline_use() {
    let fx = fixture_without_pins(&[("One.md", "# One\n"), ("Two.md", "# Two title\n")]).await;
    fx.sync().await;
    let listed = mb_server::replica::load_listing(&fx.local_root);
    assert!(
        listed
            .iter()
            .any(|n| n.path == "Two.md" && n.title.as_deref() == Some("Two title"))
    );
}

#[tokio::test]
async fn a_vault_gone_upstream_keeps_only_what_was_written_here() {
    let fx = fixture(&[
        ("Plain.md", "# Plain\n\nvault-text-a\n"),
        ("Edited.md", "# Edited\n\nvault-text-b\n"),
    ])
    .await;
    fx.sync().await;
    fx.write_local("Edited.md", "# Edited\n\nvault-text-b\n\nmy-line\n");
    fx.write_local("New.md", "# New\n\nwritten offline\n");
    let left = mb_server::replica::vault_gone(&fx.local, &fx.config)
        .await
        .expect("settled");
    assert_eq!(left, 2);
    assert_eq!(
        files_holding(&fx.local_root, "vault-text-a"),
        Vec::<PathBuf>::new()
    );
    assert!(
        fx.local_file("Recovered/Edited (offline edits).md")
            .is_some_and(|text| text.contains("my-line"))
    );
    assert!(fx.local_file("Recovered/New (offline edits).md").is_some());
    // Nothing of the replica's own state is left, the last listing's titles included.
    assert!(!fx.local_root.join(".memberberry/replica").exists());
}

#[tokio::test]
async fn a_vault_gone_upstream_with_nothing_written_here_leaves_nothing() {
    let fx = fixture(&[("Plain.md", "# Plain\n\nvault-text-a\n")]).await;
    fx.sync().await;
    let left = mb_server::replica::vault_gone(&fx.local, &fx.config)
        .await
        .expect("settled");
    assert_eq!(left, 0);
    assert_eq!(
        files_holding(&fx.local_root, "vault-text-a"),
        Vec::<PathBuf>::new()
    );
}

/// A note deleted upstream after this device edited it: recovered on the next pass.
async fn with_recovered_note() -> Fixture {
    let fx = fixture(&[("Projects/One.md", "# One\n\ntheirs\n")]).await;
    fx.sync().await;
    std::fs::remove_file(fx.upstream_root.join("notes/Projects/One.md")).expect("delete");
    let _ = fx.server.maintain_index(&mb_server::watch::Changes::All);
    fx.write_local("Projects/One.md", "# One\n\ntheirs\n\nunsent work\n");
    fx.sync().await;
    fx
}

const RECOVERED: &str = "Recovered/One (offline edits).md";

#[tokio::test]
async fn creating_a_recovered_note_again_puts_it_back_where_it_was_and_syncs_it() {
    use mb_server::replica::{Placed, place_recovered};
    let fx = with_recovered_note().await;
    let placed = place_recovered(&fx.local, &fx.config, &fx.upstream, RECOVERED, None)
        .await
        .expect("placed");
    assert_eq!(placed, Placed::Created);
    assert!(
        fx.upstream_file("Projects/One.md")
            .expect("upstream")
            .contains("unsent work")
    );
    assert!(recovered_list(&fx).is_empty());
    // It is an ordinary synced note now: an edit here reaches upstream, once.
    fx.sync().await;
    fx.write_local(
        "Projects/One.md",
        "# One\n\ntheirs\n\nunsent work\n\nand later\n",
    );
    fx.sync().await;
    let text = fx.upstream_file("Projects/One.md").expect("upstream");
    assert_eq!(text.matches("unsent work").count(), 1, "{text}");
    assert!(text.contains("and later"), "{text}");
}

#[tokio::test]
async fn creating_again_where_the_server_refuses_keeps_it_recovered_and_says_so() {
    use mb_server::replica::{Placed, place_recovered};
    let fx = with_recovered_note().await;
    // Someone made a new note at the old path meanwhile.
    fx.write_upstream("Projects/One.md", "# One\n\nsomeone else's\n");
    let placed = place_recovered(&fx.local, &fx.config, &fx.upstream, RECOVERED, None)
        .await
        .expect("answered");
    assert_eq!(placed, Placed::Refused);
    assert_eq!(
        fx.upstream_file("Projects/One.md").as_deref(),
        Some("# One\n\nsomeone else's\n")
    );
    assert!(fx.local_file(RECOVERED).is_some());
    let listed = recovered_list(&fx);
    assert!(
        listed.len() == 1 && listed[0].create_again_refused,
        "{listed:?}"
    );
}

#[tokio::test]
async fn making_a_new_note_from_a_recovered_one_creates_it_where_the_user_chose() {
    use mb_server::replica::{Placed, place_recovered};
    let fx = with_recovered_note().await;
    let placed = place_recovered(
        &fx.local,
        &fx.config,
        &fx.upstream,
        RECOVERED,
        Some("Ideas/Mine.md"),
    )
    .await
    .expect("placed");
    assert_eq!(placed, Placed::Created);
    assert!(
        fx.upstream_file("Ideas/Mine.md")
            .expect("upstream")
            .contains("unsent work")
    );
    assert!(fx.local_file(RECOVERED).is_none() && recovered_list(&fx).is_empty());
}

#[tokio::test]
async fn only_a_recovered_note_can_be_placed() {
    use mb_server::replica::place_recovered;
    let fx = with_recovered_note().await;
    fx.write_local("Other.md", "# Other\n");
    let refused = place_recovered(
        &fx.local,
        &fx.config,
        &fx.upstream,
        "Other.md",
        Some("Else.md"),
    )
    .await;
    assert!(refused.is_err());
    assert!(fx.upstream_file("Else.md").is_none());
}

/// PNG-signed bytes holding `marker`, and where they live in any vault.
fn image(marker: &str) -> (Vec<u8>, String) {
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.extend_from_slice(marker.as_bytes());
    let path = mb_server::media::LocalStore::object_path(&bytes, "png").expect("address");
    (bytes, path)
}

fn write_bytes(file: &Path, bytes: &[u8]) {
    std::fs::create_dir_all(file.parent().expect("parent")).expect("folder");
    std::fs::write(file, bytes).expect("write");
}

#[tokio::test]
async fn a_note_kept_offline_brings_its_media() {
    let (bytes, path) = image("server-image");
    let fx = fixture(&[("One.md", &format!("# One\n\n![chart]({path})\n"))]).await;
    write_bytes(&fx.upstream_root.join(&path), &bytes);
    let report = fx.sync().await;
    assert_eq!(report.media_downloaded, 1, "{report:?}");
    assert_eq!(
        std::fs::read(fx.local_root.join(&path)).ok().as_deref(),
        Some(bytes.as_slice())
    );
}

#[tokio::test]
async fn media_of_a_note_not_kept_offline_is_not_downloaded() {
    let (bytes, path) = image("unpinned-image");
    let fx = fixture_without_pins(&[
        ("Kept.md", "# Kept\n"),
        ("Other.md", &format!("# Other\n\n![x]({path})\n")),
    ])
    .await;
    write_bytes(&fx.upstream_root.join(&path), &bytes);
    fx.pin(PinKind::Note, "Kept.md", true);
    fx.sync().await;
    assert!(!fx.local_root.join(&path).exists());
}

#[tokio::test]
async fn media_added_here_reaches_upstream_before_the_note_that_shows_it() {
    let fx = fixture(&[("One.md", "# One\n")]).await;
    fx.sync().await;
    let (bytes, path) = image("local-image");
    write_bytes(&fx.local_root.join(&path), &bytes);
    fx.write_local("One.md", &format!("# One\n\n![mine]({path})\n"));
    let report = fx.sync().await;
    assert_eq!(report.media_uploaded, 1, "{report:?}");
    assert_eq!(
        std::fs::read(fx.upstream_root.join(&path)).ok().as_deref(),
        Some(bytes.as_slice())
    );
    assert!(fx.upstream_file("One.md").expect("note").contains(&path));
    // Known on both sides now: a later pass sends nothing again.
    let again = fx.sync().await;
    assert_eq!(again.media_uploaded, 0, "{again:?}");
}

#[tokio::test]
async fn a_purged_notes_media_goes_with_it_unless_a_kept_note_shows_it_too() {
    let (only, only_path) = image("only-in-gone");
    let (shared, shared_path) = image("shared-image");
    let fx = fixture(&[
        (
            "Gone.md",
            &format!("# Gone\n\n![a]({only_path})\n\n![b]({shared_path})\n"),
        ),
        ("Stays.md", &format!("# Stays\n\n![b]({shared_path})\n")),
    ])
    .await;
    write_bytes(&fx.upstream_root.join(&only_path), &only);
    write_bytes(&fx.upstream_root.join(&shared_path), &shared);
    fx.sync().await;
    assert!(fx.local_root.join(&only_path).exists(), "control");
    std::fs::remove_file(fx.upstream_root.join("notes/Gone.md")).expect("delete");
    let _ = fx.server.maintain_index(&mb_server::watch::Changes::All);
    fx.sync().await;
    assert!(!fx.local_root.join(&only_path).exists());
    assert!(fx.local_root.join(&shared_path).exists());
}

#[tokio::test]
async fn a_recovered_notes_media_stays_here_and_is_never_uploaded() {
    let fx = fixture(&[("One.md", "# One\n")]).await;
    fx.sync().await;
    let (bytes, path) = image("recovered-image");
    write_bytes(&fx.local_root.join(&path), &bytes);
    fx.write_local("One.md", &format!("# One\n\n![mine]({path})\n"));
    std::fs::remove_file(fx.upstream_root.join("notes/One.md")).expect("delete");
    let _ = fx.server.maintain_index(&mb_server::watch::Changes::All);
    fx.sync().await;
    fx.sync().await;
    assert!(fx.local_file("Recovered/One (offline edits).md").is_some());
    assert!(fx.local_root.join(&path).exists());
    assert!(!fx.upstream_root.join(&path).exists());
}

#[tokio::test]
async fn creating_a_recovered_note_again_takes_its_media_along() {
    use mb_server::replica::place_recovered;
    let fx = fixture(&[("One.md", "# One\n")]).await;
    fx.sync().await;
    let (bytes, path) = image("placed-image");
    write_bytes(&fx.local_root.join(&path), &bytes);
    fx.write_local("One.md", &format!("# One\n\n![mine]({path})\n"));
    std::fs::remove_file(fx.upstream_root.join("notes/One.md")).expect("delete");
    let _ = fx.server.maintain_index(&mb_server::watch::Changes::All);
    fx.sync().await;
    place_recovered(
        &fx.local,
        &fx.config,
        &fx.upstream,
        "Recovered/One (offline edits).md",
        None,
    )
    .await
    .expect("placed");
    assert_eq!(
        std::fs::read(fx.upstream_root.join(&path)).ok().as_deref(),
        Some(bytes.as_slice())
    );
}
