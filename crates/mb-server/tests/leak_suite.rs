//! Permission leak suite for the enforcement points implemented so far (`SPEC.md` §22.5).
//!
//! This suite is deliberately organised by enforcement point rather than feature. Adding a
//! content-bearing surface means extending this file before that surface can ship.
//!
//! The wire-level counterparts for E2-E4 live in `tests/websocket.rs`, which drives real
//! sockets; the cases here pin the properties those frames must never violate.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod support;

#[cfg(target_os = "linux")]
#[allow(dead_code)] // why: the leak target uses a subset of these shared test helpers.
#[path = "support/http_safety.rs"]
mod safety;

use mb_core::{Access, Member, Role, Username};
use mb_server::Vault;
use mb_server::repository::AuthorizedVault;
use mb_server::sync::ConnectionId;
use mb_server::vault::Slug;
use support::TempDir;

#[cfg(target_os = "linux")]
#[path = "support/vault_discovery.rs"]
mod discovery_fixture;
#[cfg(target_os = "linux")]
#[path = "support/folder_ui_cases.rs"]
mod folder_ui_cases;
#[cfg(target_os = "linux")]
#[test]
fn e29_html_entry_is_signed_admin_filtered_before_io_and_static_assets_are_not_json_authority() {
    folder_ui_cases::html_gate();
}

#[cfg(target_os = "linux")]
#[path = "support/policy_layout_leak_cases.rs"]
mod policy_layout_leak_cases;
#[cfg(target_os = "linux")]
#[path = "support/project_registration_cases.rs"]
mod registration_cases;
#[cfg(target_os = "linux")]
#[path = "support/vault_registration.rs"]
mod registration_fixture;
#[cfg(target_os = "linux")]
#[path = "support/shallow_leak_cases.rs"]
mod shallow_leak_cases;
#[cfg(target_os = "linux")]
#[test]
fn e29_policy_layout_refusal_preserves_legacy_deny_and_never_adopts_or_discloses() {
    policy_layout_leak_cases::refuses_ambiguous_policy_without_adoption_or_disclosure();
}
#[cfg(target_os = "linux")]
#[test]
fn e29_policy_layout_guard_precedes_descendant_io_with_real_observer_control() {
    policy_layout_leak_cases::strict_authority_and_initial_refusal_have_real_no_io_controls();
}
#[cfg(target_os = "linux")]
#[test]
fn e29_policy_layout_selected_root_only_preserves_scoped_denial_without_notes() {
    policy_layout_leak_cases::selected_root_only_and_no_notes_scoped_policy_controls();
}
#[cfg(target_os = "linux")]
#[test]
fn e29_policy_layout_malformed_selected_policy_has_no_nested_fallback() {
    policy_layout_leak_cases::malformed_selected_policy_is_not_rescued_by_shadow();
}
#[cfg(target_os = "linux")]
#[test]
fn e30_shallow_directory_names_are_repository_acl_filtered_without_content_or_denial_leaks() {
    shallow_leak_cases::shallow_acl();
}
#[cfg(target_os = "linux")]
#[test]
fn e31_immediate_mkdir_is_strict_signed_admin_filtered_before_io_and_not_registration() {
    shallow_leak_cases::mkdir_gate();
}
#[cfg(target_os = "linux")]
#[path = "support/project_registration_strict_cases.rs"]
mod strict_registration_cases;
#[cfg(target_os = "linux")]
#[test]
fn e29_strict_registration_wire_ambiguity_refuses_without_storage_or_leaks() {
    strict_registration_cases::strict_wire_gate();
}
#[cfg(target_os = "linux")]
#[test]
fn e29_write_preview_and_registration_gate_refuses_before_fs_without_leaks() {
    registration_cases::write_gate_is_neutral_and_observer_has_positive_control();
}

#[cfg(target_os = "linux")]
#[test]
fn e29_read_discovery_authenticates_before_opening_config_or_directories() {
    use discovery_fixture::{Server, json};
    use rustix::fs::inotify;
    let s = Server::new(true);
    let watch = inotify::init(inotify::CreateFlags::NONBLOCK).expect("observer");
    for path in [
        s.dir.path().join("server.toml"),
        s.dir.path().join("Projects"),
        s.dir.path().join("Projects/Registered"),
    ] {
        inotify::add_watch(
            &watch,
            path,
            inotify::WatchFlags::OPEN | inotify::WatchFlags::ACCESS,
        )
        .expect("watch");
    }
    let routes = [
        "/api/v1/vault-locations",
        "/api/v1/vault-locations/projects/directories?path=Registered/PrivateChildName",
        "/api/v1/vault-locations/projects/status?path=Public",
    ];
    let denied = |headers: &str| {
        for route in routes {
            let (status, body, _) = s.get(route, headers);
            assert_eq!(status, 404);
            assert_eq!(json(&body), serde_json::json!({"error":"not_found"}));
        }
        let mut bytes = [std::mem::MaybeUninit::uninit(); 4096];
        let mut reader = inotify::Reader::new(&watch, &mut bytes);
        assert!(
            matches!(reader.next(), Err(rustix::io::Errno::AGAIN)),
            "denied request opened/read config or a location"
        );
    };
    for headers in [
        "",
        &s.user,
        &s.admin_bearer,
        &s.user_bearer,
        "Cookie: mb_session=invalid\r\n",
    ] {
        denied(headers);
    }
    let auth = s.auth();
    auth.set_admin(s.admin_id, false).expect("demote");
    denied(&s.admin);
    auth.set_admin(s.admin_id, true).expect("restore admin");
    auth.set_disabled(s.admin_id, true).expect("disable");
    denied(&s.admin);
    auth.set_disabled(s.admin_id, false).expect("enable");
    auth.revoke_session(&s.session).expect("revoke");
    denied(&s.admin);
    let fresh = auth
        .create_session(s.admin_id, 4_102_444_800)
        .expect("fresh session");
    let header = format!(
        "Cookie: mb_session={}\r\n",
        auth.signed_session_cookie(&fresh).expect("cookie")
    );
    assert_eq!(s.get("/api/v1/vault-locations", &header).0, 200);
    let mut bytes = [std::mem::MaybeUninit::uninit(); 4096];
    assert!(
        inotify::Reader::new(&watch, &mut bytes).next().is_ok(),
        "positive control: observer detects authorized config access"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn e29_read_admin_metadata_never_discloses_registered_children_or_content_acl_bypass() {
    use discovery_fixture::{Server, json};
    let s = Server::new(true);
    for route in [
        "/api/v1/vault-locations",
        "/api/v1/vault-locations/projects/directories?path=",
        "/api/v1/vault-locations/projects/status?path=Registered",
    ] {
        let (status, body, _) = s.get(route, &s.admin);
        assert_eq!(status, 200);
        for secret in [
            "PrivateChildName",
            "PrivateTitle",
            "PrivateBody",
            "PrivateLabel",
            s.dir.path().to_str().expect("path"),
        ] {
            assert!(!body.contains(secret));
        }
    }
    for path in [
        "Registered",
        "Registered%2FPrivateChildName",
        "Registered%2FAbsent",
    ] {
        let (status, body, _) = s.get(
            &format!("/api/v1/vault-locations/projects/directories?path={path}"),
            &s.admin,
        );
        assert_eq!(status, 404);
        assert_eq!(json(&body), serde_json::json!({"error":"not_found"}));
    }
    assert_eq!(
        s.get("/api/v1/vaults/private/notes", &s.admin).0,
        404,
        "server admin is not a content member"
    );
}

#[test]
fn e14_folder_moves_deny_hidden_descendants_and_destinations_without_partial_moves() {
    let directory = TempDir::new("folder-move-leak");
    directory.write("Source/Public.md", "# Public\n");
    directory.write("Source/Secret.md", "# Secret\n");
    directory.write("Private/Existing/Note.md", "# Hidden\n");
    directory.write("access.toml", "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n[[members]]\nuser = \"bob\"\nrole = \"editor\"\n[[rules]]\npath = \"Source/Secret.md\"\ngrant = { bob = \"none\" }\n[[rules]]\npath = \"Private\"\ngrant = { bob = \"none\" }\n[[rules]]\npath = \"Target/Public.md\"\ngrant = { bob = \"viewer\" }\n");
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        directory.path(),
    )
    .expect("vault");
    let access = mb_server::AccessFile::load(vault.root()).expect("access");
    let index = mb_server::indexing::IndexRegistry::default()
        .get(&vault)
        .expect("index");
    let sync = mb_server::sync::SyncRegistry::default();
    for actor in ["bob", "guest"] {
        let rename = mb_server::rename::Rename::new(
            &vault,
            access.policy(),
            Username::parse(actor).expect("user"),
            &index,
            &sync,
            None,
        );
        for (from, to) in [
            ("Source", "Moved"),
            ("Source", "Private/Existing"),
            ("Source", "Private/Missing"),
            ("Private/Existing", "Moved"),
            ("Private/Missing", "Moved"),
        ] {
            assert!(matches!(
                rename.folder(from, to),
                Err(mb_server::rename::RenameError::Denied)
            ));
        }
    }
    std::fs::remove_file(directory.path().join("Source/Secret.md")).expect("remove hidden fixture");
    let rename = mb_server::rename::Rename::new(
        &vault,
        access.policy(),
        Username::parse("bob").expect("user"),
        &index,
        &sync,
        None,
    );
    assert!(matches!(
        rename.folder("Source", "Target"),
        Err(mb_server::rename::RenameError::Denied)
    ));
    assert!(directory.path().join("Source/Public.md").exists());
    assert!(!directory.path().join("Moved").exists());
}

#[cfg(unix)]
#[test]
fn e14_folder_moves_refuse_symlinks_in_sources_and_destinations() {
    let directory = TempDir::new("folder-move-symlink");
    directory.write("Source/Note.md", "# Note\n");
    directory.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n",
    );
    let outside = TempDir::new("folder-move-outside");
    std::os::unix::fs::symlink(outside.path(), directory.path().join("Escape")).expect("symlink");
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        directory.path(),
    )
    .expect("vault");
    let access = mb_server::AccessFile::load(vault.root()).expect("access");
    let index = mb_server::indexing::IndexRegistry::default()
        .get(&vault)
        .expect("index");
    let sync = mb_server::sync::SyncRegistry::default();
    let rename = mb_server::rename::Rename::new(
        &vault,
        access.policy(),
        Username::parse("alice").expect("user"),
        &index,
        &sync,
        None,
    );
    for (from, to) in [("Source", "Escape/Moved"), ("Escape", "Moved")] {
        assert!(matches!(
            rename.folder(from, to),
            Err(mb_server::rename::RenameError::Denied)
        ));
    }
    std::os::unix::fs::symlink(outside.path(), directory.path().join("Source/Linked"))
        .expect("nested symlink");
    assert!(matches!(
        rename.folder("Source", "Moved"),
        Err(mb_server::rename::RenameError::Denied)
    ));
    assert!(directory.path().join("Source/Note.md").exists());
}

#[test]
fn e28_nested_empty_folders_preserve_deeper_grants_without_exposing_denied_notes() {
    use mb_core::{Access, NotePath, Role, Rule};
    use std::collections::BTreeMap;
    let directory = TempDir::new("leak-nested-empty-folders");
    directory.write("notes/OnlyDenied/Secret.md", "# Hidden note\n");
    directory.write("notes/HiddenContent/.keep", "not physically empty");
    for folder in [
        "Shared/Parent/Leaf",
        "Private/Denied",
        "Private/Allowed/Leaf",
        "DefaultDenied/Allowed/Leaf",
        ".hidden/Leaf",
    ] {
        std::fs::create_dir_all(directory.path().join("notes").join(folder)).expect("folder");
    }
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        directory.path(),
    )
    .expect("vault");
    let bob = Username::parse("bob").expect("user");
    let access = Access::new(
        vec![],
        [
            ("Shared", Role::Viewer),
            ("DefaultDenied/Allowed", Role::Viewer),
            ("Private", Role::None),
            ("Private/Allowed", Role::Viewer),
            ("OnlyDenied", Role::Viewer),
            ("OnlyDenied/Secret.md", Role::None),
            ("HiddenContent", Role::Viewer),
            (".hidden", Role::Viewer),
        ]
        .into_iter()
        .map(|(path, role)| Rule {
            path: NotePath::parse(path).expect("path"),
            grants: BTreeMap::from([(bob.clone(), role)]),
        })
        .collect(),
    )
    .expect("ACL");
    let view = AuthorizedVault::new(&vault, &access, bob);
    assert_eq!(
        view.empty_folders().expect("filtered folders"),
        vec!["DefaultDenied/Allowed/Leaf", "Shared/Parent/Leaf"]
    );
    assert!(view.notes().expect("filtered notes").is_empty());
    let deny = Access::default();
    assert!(
        AuthorizedVault::new(&vault, &deny, Username::parse("admin").expect("user"))
            .empty_folders()
            .expect("no policy")
            .is_empty()
    );
}

#[test]
fn e28_empty_folders_are_filtered_and_creation_authorizes_before_probing() {
    let directory = TempDir::new("leak-empty-folders");
    directory.write("Shared/Welcome.md", "# Welcome\n");
    directory.write("Private/Secret.md", "# Secret\n");
    directory.write("access.toml", "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n[[members]]\nuser = \"bob\"\nrole = \"viewer\"\n[[rules]]\npath = \"Shared\"\ngrant = { bob = \"editor\" }\n[[rules]]\npath = \"Private\"\ngrant = { bob = \"none\" }\n");
    std::fs::create_dir_all(directory.path().join("Shared/Empty")).expect("shared folder");
    std::fs::create_dir_all(directory.path().join("Private/Empty")).expect("private folder");
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        directory.path(),
    )
    .expect("vault");
    let access = mb_server::AccessFile::load(vault.root()).expect("access");
    let registry = mb_server::indexing::IndexRegistry::default();
    assert!(
        registry
            .maintain(std::iter::once(&vault), &mb_server::watch::Changes::All)
            .is_empty()
    );
    let index = registry.get(&vault).expect("index");
    let bob = Username::parse("bob").expect("user");
    let view = AuthorizedVault::new(&vault, access.policy(), bob.clone());
    assert_eq!(view.empty_folders().expect("folders"), vec!["Shared/Empty"]);
    let create = mb_server::create::CreateNote::new(&vault, access.policy(), bob, &index);
    for path in ["Private/Empty", "Private/Missing", "RootFolder"] {
        assert!(matches!(
            create.folder(path),
            Err(mb_server::create::CreateError::Denied)
        ));
    }
    create.folder("Shared/Ideas 📓").expect("create allowed");
    assert!(directory.path().join("Shared/Ideas 📓").is_dir());
    assert_eq!(
        std::fs::read_dir(directory.path().join("Shared/Ideas 📓"))
            .expect("empty")
            .count(),
        0
    );
    assert!(matches!(
        create.folder("Shared/Ideas 📓"),
        Err(mb_server::create::CreateError::Exists(_))
    ));
    for path in [
        "",
        "../escape",
        "/absolute",
        ".hidden",
        "Shared//Bad",
        "Shared/../Bad",
    ] {
        assert!(matches!(
            create.folder(path),
            Err(mb_server::create::CreateError::InvalidName(_))
        ));
    }
    let guest = AuthorizedVault::new(
        &vault,
        access.policy(),
        Username::parse("guest").expect("user"),
    );
    assert!(guest.empty_folders().expect("guest list").is_empty());
}

#[cfg(unix)]
#[test]
fn e28_folder_symlinks_cannot_expose_or_create_outside_the_vault() {
    let directory = TempDir::new("folder-symlink");
    directory.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n",
    );
    let outside = TempDir::new("folder-outside");
    std::fs::create_dir(outside.path().join("Secret")).expect("outside folder");
    std::os::unix::fs::symlink(outside.path(), directory.path().join("Escape")).expect("symlink");
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        directory.path(),
    )
    .expect("vault");
    let access = mb_server::AccessFile::load(vault.root()).expect("access");
    let index = std::sync::Mutex::new(mb_index::Index::in_memory().expect("index"));
    let actor = Username::parse("alice").expect("user");
    assert!(
        AuthorizedVault::new(&vault, access.policy(), actor.clone())
            .empty_folders()
            .expect("folders")
            .is_empty()
    );
    assert!(
        mb_server::create::CreateNote::new(&vault, access.policy(), actor, &index)
            .folder("Escape/New")
            .is_err()
    );
    assert!(!outside.path().join("New").exists());
}

#[tokio::test]
async fn e26_vault_administration_rejects_guests_members_disabled_admins_and_api_tokens() {
    use axum::http::header;
    use mb_server::http::{AppState, router};
    use std::sync::Arc;
    let directory = TempDir::new("e26-management");
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth");
    let admin = auth
        .setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: "correct horse battery staple",
        })
        .expect("admin");
    let member = auth
        .create_user(mb_auth::NewUser {
            username: "bob",
            display_name: "Bob",
            password: "correct horse battery staple",
        })
        .expect("member");
    let session = |user| {
        let token = auth.create_session(user, 4_102_444_800).expect("session");
        format!(
            "mb_session={}",
            auth.signed_session_cookie(&token).expect("cookie")
        )
    };
    let admin_cookie = session(admin.id);
    let member_cookie = session(member.id);
    let other_admin = auth
        .create_user(mb_auth::NewUser {
            username: "charlie",
            display_name: "Charlie",
            password: "correct horse battery staple",
        })
        .expect("other admin");
    auth.set_admin(other_admin.id, true).expect("promote");
    let api_token = auth
        .create_api_token(mb_auth::ApiTokenScope {
            user_id: other_admin.id,
            vault_slug: "personal".to_string(),
            role: Role::Owner,
        })
        .expect("valid scoped token");
    auth.set_disabled(admin.id, true).expect("disable admin");
    let state = Arc::new(
        AppState::authenticated(vec![], auth)
            .expect("state")
            .with_vault_management(directory.path().join("server.toml"), true)
            .expect("management"),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let origin = format!("http://{}", listener.local_addr().expect("address"));
    let app = router(Arc::clone(&state));
    let server = tokio::spawn(async move { axum::serve(listener, app).await });
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("client");
    for cookie in ["", member_cookie.as_str(), admin_cookie.as_str()] {
        for slug in ["personal", "../private"] {
            let response = client
                .post(format!("{origin}/vaults/new"))
                .header(header::ORIGIN, &origin)
                .header(header::COOKIE, cookie)
                .form(&[("name", "Private notebook"), ("slug", slug)])
                .send()
                .await
                .expect("response");
            assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND);
            let body = response.text().await.expect("body");
            assert!(!body.contains("Private notebook"));
            assert!(!body.contains(directory.path().to_str().expect("path")));
        }
        let response = client
            .get(format!("{origin}/vaults/new"))
            .header(header::COOKIE, cookie)
            .send()
            .await
            .expect("page");
        assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND);
    }
    let response = client
        .post(format!("{origin}/vaults/new"))
        .header(header::ORIGIN, &origin)
        .bearer_auth(api_token.expose_secret())
        .form(&[("name", "Private notebook"), ("slug", "personal")])
        .send()
        .await
        .expect("response");
    assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND);
    assert!(state.is_empty());
    assert!(!directory.path().join("server.toml").exists());
    assert!(!directory.path().join("vaults/personal").exists());
    server.abort();
    let _stopped = server.await;
}

#[tokio::test]
async fn e27_initial_setup_denies_requests_without_a_trusted_local_peer() {
    use mb_server::http::{AppState, router};
    let directory = TempDir::new("e27-setup");
    let state = std::sync::Arc::new(
        AppState::authenticated(vec![], mb_auth::AuthDb::open_in_memory().expect("auth"))
            .expect("state")
            .with_vault_management(directory.path().join("server.toml"), true)
            .expect("management"),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let origin = format!("http://{}", listener.local_addr().expect("address"));
    let app = router(state);
    let server = tokio::spawn(async move { axum::serve(listener, app).await });
    let response = reqwest::Client::new()
        .post(format!("{origin}/setup"))
        .header("origin", &origin)
        .header("x-forwarded-for", "127.0.0.1")
        .form(&[
            ("username", "attacker"),
            ("display_name", "Attacker"),
            ("password", "correct horse battery staple"),
            ("confirmation", "correct horse battery staple"),
        ])
        .send()
        .await
        .expect("response");
    assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND);
    server.abort();
    let _stopped = server.await;
}

/// E23: both the live ACL and a scoped token independently cap clip writes.
#[test]
fn e23_clipper_requires_editor_access_at_the_destination() {
    let alice = Username::parse("alice").expect("username");
    let access = Access::new(
        vec![Member {
            user: alice.clone(),
            role: Role::Viewer,
        }],
        vec![mb_core::Rule {
            path: mb_core::NotePath::parse("Clips").expect("path"),
            grants: std::collections::BTreeMap::from([(alice.clone(), Role::Editor)]),
        }],
    )
    .expect("policy");
    let allowed = mb_core::NotePath::parse("Clips/Page.md").expect("path");
    let denied = mb_core::NotePath::parse("Private/Page.md").expect("path");

    assert!(mb_server::clip::may_write(&access, &alice, &allowed, None));
    assert!(!mb_server::clip::may_write(&access, &alice, &denied, None));
    assert!(!mb_server::clip::may_write(
        &access,
        &alice,
        &allowed,
        Some(Role::Viewer)
    ));
}

/// E5: every repository query is pre-filtered and an unreadable note is indistinguishable
/// from a missing note, including metadata lookup and source reads.
#[test]
fn e5_repository_never_reveals_an_unreadable_note() {
    let dir = TempDir::new("leak-repository");
    dir.write("Shared.md", "# Shared\n");
    dir.write("Private/Salary.md", "# Salary Review\n");
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let alice = Username::parse("alice").expect("username");
    let access = Access::new(
        vec![Member {
            user: alice.clone(),
            role: Role::Viewer,
        }],
        vec![mb_core::Rule {
            path: mb_core::NotePath::parse("Private").expect("path"),
            grants: std::collections::BTreeMap::from([(alice.clone(), Role::None)]),
        }],
    )
    .expect("policy");
    let view = AuthorizedVault::new(&vault, &access, alice);

    assert_eq!(view.notes().expect("notes"), vec!["Shared.md"]);
    assert_eq!(view.find_by_name("Salary"), None);
    assert!(matches!(
        view.resolve("Private/Salary.md"),
        Err(mb_server::Error::NotFound)
    ));
    assert!(matches!(
        view.read("Private/Salary.md"),
        Err(mb_server::Error::NotFound)
    ));
}

/// E10: history is derived only after the note itself has passed the readable repository view.
#[test]
fn e10_history_never_reveals_an_unreadable_note() {
    let dir = TempDir::new("leak-history");
    dir.write("Shared.md", "# Shared\n");
    dir.write("Private.md", "# Private\n");
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let alice = Username::parse("alice").expect("username");
    let access = Access::new(
        vec![Member {
            user: alice.clone(),
            role: Role::Viewer,
        }],
        vec![mb_core::Rule {
            path: mb_core::NotePath::parse("Private.md").expect("path"),
            grants: std::collections::BTreeMap::from([(alice.clone(), Role::None)]),
        }],
    )
    .expect("policy");
    let visible = mb_server::history::HistoryStore::new(dir.path(), "Shared.md");
    visible
        .record("# Shared old\n", "alice", std::time::SystemTime::now())
        .expect("history");
    let private = mb_server::history::HistoryStore::new(dir.path(), "Private.md");
    private
        .record("# Private old\n", "bob", std::time::SystemTime::now())
        .expect("history");
    let view = AuthorizedVault::new(&vault, &access, alice);

    let shared_identity = view.identity("Shared.md").expect("readable identity");
    assert_eq!(
        mb_server::history::HistoryStore::new(dir.path(), &shared_identity)
            .list()
            .expect("history list")
            .len(),
        1
    );
    assert!(matches!(
        view.identity("Private.md"),
        Err(mb_server::Error::NotFound)
    ));
}

/// E24: a deleted note remains invisible when its original path is denied, even though its
/// Markdown and metadata are present in server-owned trash.
#[test]
fn e24_trash_never_reveals_a_deleted_unreadable_note() {
    let dir = TempDir::new("leak-trash");
    dir.write("Private.md", "# Private\n");
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let alice = Username::parse("alice").expect("username");
    let access = Access::new(
        vec![Member {
            user: alice.clone(),
            role: Role::Viewer,
        }],
        vec![mb_core::Rule {
            path: mb_core::NotePath::parse("Private.md").expect("path"),
            grants: std::collections::BTreeMap::from([(alice.clone(), Role::None)]),
        }],
    )
    .expect("policy");
    let store = mb_server::trash::TrashStore::new(&vault);
    store
        .delete(&vault, "Private.md", "owner", 1_000)
        .expect("trash");
    let entries = store.list(1_000).expect("entries");
    let view = AuthorizedVault::new(&vault, &access, alice);

    assert_eq!(entries.len(), 1);
    assert!(entries.iter().all(|entry| !view.can_read_path(&entry.path)));
    assert!(
        entries
            .iter()
            .all(|entry| view.write_path(&entry.path).is_err())
    );
    assert!(!dir.path().join("Private.md").exists());
}

/// E5: the Tantivy query itself carries the readable set, so no denied title, path, tag or
/// body can become a hit (`SPEC.md` §14.1).
#[test]
fn e5_search_never_reveals_an_unreadable_note() {
    let mut index = mb_index::Index::in_memory().expect("index");
    for (ordinal, (path, markdown)) in [
        ("Shared.md", "ordinary visible words\n"),
        (
            "Private/Salary.md",
            "---\ntags: [secret-payroll]\n---\n\n# Compensation\n\nThe canary salary is private.\n",
        ),
    ]
    .into_iter()
    .enumerate()
    {
        index
            .upsert(&mb_index::NoteInput {
                path: path.to_string(),
                markdown: markdown.to_string(),
                stamp: mb_index::Stamp::from_parts(markdown.len() as u64, ordinal as u128),
            })
            .expect("upsert");
    }
    index.publish().expect("publish");
    let alice = Username::parse("alice").expect("username");
    let access = Access::new(
        vec![Member {
            user: alice.clone(),
            role: Role::Viewer,
        }],
        vec![mb_core::Rule {
            path: mb_core::NotePath::parse("Private").expect("path"),
            grants: std::collections::BTreeMap::from([(alice.clone(), Role::None)]),
        }],
    )
    .expect("policy");
    let reader = index.reader(&access, &alice).expect("reader");

    for query in [
        "canary",
        "title:compensation",
        "tag:secret-payroll",
        "path:private",
    ] {
        assert!(
            reader.search(query, 10).expect("search").is_empty(),
            "{query} disclosed an unreadable note"
        );
    }
}

/// E11: content addressing is not authorization. A media path referenced only by a denied
/// note does not exist for the reader, even if they know the complete hash.
#[test]
fn e11_media_from_an_unreadable_note_is_not_fetchable() {
    let public = format!("media/aa/aa/{}.png", "a".repeat(64));
    let private = format!("media/bb/bb/{}.png", "b".repeat(64));
    let mut index = mb_index::Index::in_memory().expect("index");
    for (ordinal, (path, markdown)) in [
        ("Shared.md", format!("![public]({public})\n")),
        (
            "Private/Salary.md",
            format!("![private salary chart]({private})\n"),
        ),
    ]
    .into_iter()
    .enumerate()
    {
        index
            .upsert(&mb_index::NoteInput {
                path: path.to_string(),
                stamp: mb_index::Stamp::from_parts(markdown.len() as u64, ordinal as u128),
                markdown,
            })
            .expect("upsert");
    }
    let alice = Username::parse("alice").expect("username");
    let access = Access::new(
        vec![Member {
            user: alice.clone(),
            role: Role::Viewer,
        }],
        vec![mb_core::Rule {
            path: mb_core::NotePath::parse("Private").expect("path"),
            grants: std::collections::BTreeMap::from([(alice.clone(), Role::None)]),
        }],
    )
    .expect("policy");
    let reader = index.reader(&access, &alice).expect("reader");

    assert!(reader.references_media(&public).expect("public reference"));
    assert!(
        !reader
            .references_media(&private)
            .expect("private reference")
    );
}

/// E11 also protects header images stored in Markdown frontmatter.
#[test]
fn e11_cover_from_an_unreadable_note_is_not_fetchable() {
    let public = format!("media/aa/aa/{}.png", "a".repeat(64));
    let private = format!("media/bb/bb/{}.png", "b".repeat(64));
    let mut index = mb_index::Index::in_memory().expect("index");
    for (path, cover) in [("Shared.md", &public), ("Private/Salary.md", &private)] {
        let markdown = format!("---\ncover: {cover}\n---\n# Note\n");
        index
            .upsert(&mb_index::NoteInput {
                path: path.to_string(),
                stamp: mb_index::Stamp::from_parts(markdown.len() as u64, 1),
                markdown,
            })
            .expect("upsert cover");
    }
    let alice = Username::parse("alice").expect("username");
    let access = Access::new(
        vec![Member {
            user: alice.clone(),
            role: Role::Viewer,
        }],
        vec![mb_core::Rule {
            path: mb_core::NotePath::parse("Private").expect("path"),
            grants: std::collections::BTreeMap::from([(alice.clone(), Role::None)]),
        }],
    )
    .expect("policy");
    let reader = index.reader(&access, &alice).expect("reader");
    assert!(reader.references_media(&public).expect("readable cover"));
    assert!(!reader.references_media(&private).expect("denied cover"));
}

/// E13: public links remain capped by the creator's current ACL, and bearer states are opaque.
#[test]
fn e13_share_links_never_expand_creator_access_or_survive_revocation() {
    let dir = TempDir::new("leak-public-share");
    dir.write("Shared.md", "# Shared\n\n![[Private/Salary]]\n");
    dir.write("Private/Salary.md", "private salary canary\n");
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let alice = Username::parse("alice").expect("username");
    let access = Access::new(
        vec![Member {
            user: alice.clone(),
            role: Role::Viewer,
        }],
        vec![mb_core::Rule {
            path: mb_core::NotePath::parse("Private").expect("path"),
            grants: std::collections::BTreeMap::from([(alice.clone(), Role::None)]),
        }],
    )
    .expect("policy");
    let view = AuthorizedVault::new(&vault, &access, alice.clone());
    assert!(view.read("Shared.md").is_ok());
    assert!(matches!(
        view.read("Private/Salary.md"),
        Err(mb_server::Error::NotFound)
    ));

    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth db");
    let user = auth
        .setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: "correct horse battery staple",
        })
        .expect("setup user");
    let token = auth
        .create_share_link(mb_auth::ShareLinkScope {
            vault_slug: "personal".to_string(),
            note_path: "Shared.md".to_string(),
            include_embeds: true,
            password: Some("correct horse battery staple".to_string()),
            expires_at: Some(4_102_444_800),
            created_by: user.id,
        })
        .expect("share link");
    assert!(
        auth.authenticate_share_link(&token, Some("wrong password"))
            .expect("wrong password check")
            .is_none()
    );
    assert!(
        auth.authenticate_share_link(&token, Some("correct horse battery staple"))
            .expect("correct password check")
            .is_some()
    );
    auth.revoke_share_link(user.id, &token)
        .expect("revoke link");
    assert!(
        auth.authenticate_share_link(&token, Some("correct horse battery staple"))
            .expect("revoked check")
            .is_none()
    );

    let revoked_access = Access::new(Vec::new(), Vec::new()).expect("deny-all policy");
    let revoked_view = AuthorizedVault::new(&vault, &revoked_access, alice);
    assert!(matches!(
        revoked_view.read("Shared.md"),
        Err(mb_server::Error::NotFound)
    ));
}

/// E22: custom pack names, aliases, and image paths do not exist outside a readable vault.
#[test]
fn e22_custom_emoji_are_filtered_before_resolution() {
    let dir = TempDir::new("leak-emoji");
    dir.write(
        ".memberberry/emoji/packs/canary/pack.json",
        r#"{"name":"canary","version":1,"emoji":[{"shortcode":"secret_salary","file":"secret.png","aliases":["compensation"]}]}"#,
    );
    dir.write(
        ".memberberry/emoji/packs/canary/secret.png",
        "private image bytes",
    );
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let outsider = Username::parse("server-admin").expect("username");
    let access = Access::new(Vec::new(), Vec::new()).expect("empty policy");
    let view = AuthorizedVault::new(&vault, &access, outsider);

    assert!(matches!(
        view.emoji_entries(None),
        Err(mb_server::Error::NotFound)
    ));
}

/// E33: vault settings and emoji management exist only for the vault-wide owner.
///
/// Every route answers editor, viewer, non-member and a server admin who is merely an editor
/// with the same 404, carries no emoji name or setting in the body, and writes nothing. The
/// owner's success is asserted too, so the denials cannot pass by the routes being broken.
#[tokio::test]
async fn e33_vault_settings_and_emoji_management_are_owner_only() {
    use axum::http::header;
    use mb_server::http::{AppState, router};
    use std::sync::Arc;
    let dir = TempDir::new("e33-settings");
    dir.write("Note.md", "# Note\n\n:secret_salary:\n");
    dir.write(
        ".memberberry/config.toml",
        "theme = \"memberberry-dark\"\naccent = \"#123456\"\n",
    );
    dir.write(
        ".memberberry/emoji/packs/canary/pack.json",
        r#"{"name":"canary","version":1,"emoji":[{"shortcode":"secret_salary","file":"secret.png","aliases":["compensation"]}]}"#,
    );
    dir.write(
        ".memberberry/emoji/packs/canary/secret.png",
        "private image bytes",
    );
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"editor\"\n\n\
         [[members]]\nuser = \"bob\"\nrole = \"viewer\"\n\n\
         [[members]]\nuser = \"dave\"\nrole = \"owner\"\n",
    );
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth");
    let password = "correct horse battery staple";
    // alice is the first user, so she is a server admin — and only an editor here.
    let mut cookies = Vec::new();
    for (index, name) in ["alice", "bob", "carol", "dave"].into_iter().enumerate() {
        let user = mb_auth::NewUser {
            username: name,
            display_name: name,
            password,
        };
        let created = if index == 0 {
            auth.setup_first_user(user).expect("first user")
        } else {
            auth.create_user(user).expect("user")
        };
        let token = auth
            .create_session(created.id, 4_102_444_800)
            .expect("session");
        cookies.push(format!(
            "mb_session={}",
            auth.signed_session_cookie(&token).expect("cookie")
        ));
    }
    let state = Arc::new(AppState::authenticated(vec![vault], auth).expect("state"));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let origin = format!("http://{}", listener.local_addr().expect("address"));
    let server = tokio::spawn(async move { axum::serve(listener, router(state)).await });
    let client = reqwest::Client::new();
    let snapshot = || {
        [
            "Note.md",
            ".memberberry/config.toml",
            ".memberberry/emoji/packs/canary/pack.json",
            ".memberberry/emoji/packs/canary/secret.png",
        ]
        .map(|path| std::fs::read(dir.path().join(path)).expect("file"))
    };
    let before = snapshot();
    let base = format!("{origin}/api/v1/vaults/personal");
    for (caller, cookie) in [
        ("anonymous", ""),
        ("admin editor", cookies[0].as_str()),
        ("viewer", cookies[1].as_str()),
        ("non-member", cookies[2].as_str()),
    ] {
        let probes = [
            client.get(format!("{base}/settings")),
            client
                .put(format!("{base}/settings"))
                .body(r##"{"theme":"memberberry-light","accent":"#ffffff"}"##),
            client.delete(format!("{base}/emoji-entries/secret_salary")),
            client.delete(format!(
                "{base}/emoji-entries/secret_salary/aliases/compensation"
            )),
            client
                .post(format!("{base}/rename"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(r#"{"kind":"emoji","from":"secret_salary","to":"public"}"#),
        ];
        for probe in probes {
            let response = probe
                .header(header::COOKIE, cookie)
                .send()
                .await
                .expect("response");
            assert_eq!(
                response.status(),
                reqwest::StatusCode::NOT_FOUND,
                "{caller}"
            );
            let body = response.text().await.expect("body");
            for canary in [
                "secret_salary",
                "compensation",
                "#123456",
                "memberberry-dark",
            ] {
                assert!(
                    !body.contains(canary),
                    "{canary} leaked to {caller}: {body}"
                );
            }
        }
    }
    assert_eq!(snapshot(), before, "a refused caller changed the vault");

    let response = client
        .get(format!("{base}/settings"))
        .header(header::COOKIE, &cookies[3])
        .send()
        .await
        .expect("owner response");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert!(
        response
            .text()
            .await
            .expect("body")
            .contains("secret_salary")
    );
    server.abort();
    let _stopped = server.await;
}

/// E14 for emoji: the rename reaches notes the owner cannot read, and does not say so.
#[test]
fn e14_an_emoji_rename_never_reports_what_it_reached() {
    let dir = TempDir::new("leak-emoji-rename");
    dir.write("Open.md", "Hello :parrot:\n");
    dir.write("Private/Salary.md", ":parrot: :parrot:\n");
    dir.write(
        ".memberberry/emoji/packs/emoji-a/pack.json",
        r#"{"name":"emoji-a","version":1,"emoji":[{"shortcode":"parrot","file":"parrot.png"}]}"#,
    );
    dir.write(".memberberry/emoji/packs/emoji-a/parrot.png", "image");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n\n\
         [[rules]]\npath = \"Private\"\ngrant = { alice = \"none\" }\n",
    );
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let access = mb_server::AccessFile::load(vault.root()).expect("access.toml");
    let registry = mb_server::indexing::IndexRegistry::default();
    let errors = registry.maintain(std::iter::once(&vault), &mb_server::watch::Changes::All);
    assert!(errors.is_empty(), "indexing the vault: {errors:?}");
    let index = registry.get(&vault).expect("index");
    let sync = mb_server::sync::SyncRegistry::default();
    let alice = Username::parse("alice").expect("username");
    let rename =
        mb_server::rename::Rename::new(&vault, access.policy(), alice, &index, &sync, None);

    let renamed = rename
        .emoji("parrot", "bird", None)
        .expect("the owner may rename it");
    assert_eq!(
        (renamed.notes, renamed.references),
        (1, 1),
        "the reply counted a note alice cannot read"
    );
    let hidden = std::fs::read_to_string(dir.path().join("Private/Salary.md")).expect("hidden");
    assert_eq!(
        hidden, ":bird: :bird:\n",
        "the hidden note was left with the old name"
    );
}

/// E18: an inbox row is a source note's name and text, so task queries are filtered at the
/// index layer before any row reaches the pane.
#[test]
fn e18_task_inbox_never_reveals_an_unreadable_note() {
    let mut index = mb_index::Index::in_memory().expect("index");
    for (ordinal, (path, markdown)) in [
        ("Shared.md", "- [ ] Visible task 📅 2026-09-10\n"),
        (
            "Private/Salary.md",
            "- [ ] Canary compensation task 📅 2026-09-09 🔺\n",
        ),
    ]
    .into_iter()
    .enumerate()
    {
        index
            .upsert(&mb_index::NoteInput {
                path: path.to_string(),
                markdown: markdown.to_string(),
                stamp: mb_index::Stamp::from_parts(markdown.len() as u64, ordinal as u128),
            })
            .expect("upsert");
    }
    let alice = Username::parse("alice").expect("username");
    let access = Access::new(
        vec![Member {
            user: alice.clone(),
            role: Role::Viewer,
        }],
        vec![mb_core::Rule {
            path: mb_core::NotePath::parse("Private").expect("path"),
            grants: std::collections::BTreeMap::from([(alice.clone(), Role::None)]),
        }],
    )
    .expect("policy");
    let reader = index.reader(&access, &alice).expect("reader");

    let tasks = reader
        .tasks(&mb_index::TaskQuery::default())
        .expect("tasks");
    assert_eq!(tasks.len(), 1);
    assert_eq!(
        tasks.first().map(|task| task.path.as_str()),
        Some("Shared.md")
    );
    assert!(!tasks.iter().any(|task| task.text.contains("Canary")));
}

/// E20: calendar metadata starts from the authorized repository, including periodic notes.
#[test]
fn e20_calendar_metadata_never_names_an_unreadable_period() {
    let dir = TempDir::new("leak-calendar");
    dir.write("Daily/2026-09-08.md", "# Visible day\n");
    dir.write("Daily/2026-09-09.md", "# Canary private day\n");
    dir.write("Weekly/2026-W37.md", "# Visible week\n");
    dir.write("Weekly/2026-W38.md", "# Canary private week\n");
    dir.write("Monthly/2026-09.md", "# Visible month\n");
    dir.write("Monthly/2026-10.md", "# Canary private month\n");
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let alice = Username::parse("alice").expect("username");
    let denied = [
        "Daily/2026-09-09.md",
        "Weekly/2026-W38.md",
        "Monthly/2026-10.md",
    ];
    let access = Access::new(
        vec![Member {
            user: alice.clone(),
            role: Role::Viewer,
        }],
        denied
            .iter()
            .map(|path| mb_core::Rule {
                path: mb_core::NotePath::parse(path).expect("path"),
                grants: std::collections::BTreeMap::from([(alice.clone(), Role::None)]),
            })
            .collect(),
    )
    .expect("policy");
    let view = AuthorizedVault::new(&vault, &access, alice);
    let readable = view.notes().expect("readable calendar source");

    for path in denied {
        assert!(
            !readable.contains(&path.to_string()),
            "calendar source leaked {path}"
        );
    }
    assert_eq!(readable.len(), 3);
}

/// E6: compact client search is assembled from permitted zones, never filtered after bytes
/// have crossed the boundary. A denied title must therefore be absent from the payload itself.
#[test]
fn e6_client_search_segments_never_contain_an_unreadable_note() {
    let dir = TempDir::new("leak-client-search");
    dir.write("Shared.md", "# Visible Canary\n\nordinary text\n");
    dir.write(
        "Private/Salary.md",
        "# Forbidden Canary\n\nThe private salary is classified.\n",
    );
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let alice = Username::parse("alice").expect("username");
    let access = Access::new(
        vec![Member {
            user: alice.clone(),
            role: Role::Viewer,
        }],
        vec![mb_core::Rule {
            path: mb_core::NotePath::parse("Private").expect("path"),
            grants: std::collections::BTreeMap::from([(alice.clone(), Role::None)]),
        }],
    )
    .expect("policy");
    let registry = mb_server::indexing::IndexRegistry::default();
    let errors = registry.maintain(std::iter::once(&vault), &mb_server::watch::Changes::All);
    assert!(errors.is_empty(), "indexing the vault: {errors:?}");
    registry
        .maintain_zones(&vault, &access)
        .expect("publishing zones");
    let index = registry.get(&vault).expect("index");
    let mut index = index.lock().expect("index lock");
    let payloads = index
        .reader(&access, &alice)
        .expect("reader")
        .client_segments();

    let bytes: Vec<u8> = payloads
        .iter()
        .flat_map(|segment| segment.bytes.iter().copied())
        .collect();
    assert!(
        bytes
            .windows(b"Visible Canary".len())
            .any(|window| window == b"Visible Canary")
    );
    assert!(
        !bytes
            .windows(b"Forbidden Canary".len())
            .any(|window| window == b"Forbidden Canary")
    );
    assert!(
        !bytes
            .windows(b"classified".len())
            .any(|window| window == b"classified")
    );
}

/// E1: an admin without an ACL membership has no implicit content access.
#[test]
fn e1_server_admin_is_not_a_vault_reader() {
    let dir = TempDir::new("leak-admin");
    dir.write("Private.md", "# Private\n");
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let access = Access::new(Vec::new(), Vec::new()).expect("empty policy");
    let admin = Username::parse("server-admin").expect("username");
    let view = AuthorizedVault::new(&vault, &access, admin);

    assert!(view.notes().expect("notes").is_empty());
    assert_eq!(view.find_by_name("Private"), None);
    assert!(matches!(
        view.read("Private.md"),
        Err(mb_server::Error::NotFound)
    ));
}

/// E2/E3/E4: the sync boundary denies every failure the same way.
///
/// The invisibility rule (§6.5) applies to *how* a frame is refused, not only to what it
/// carries. An unknown vault, an unresolvable path and a note the caller merely cannot read
/// must be one indistinguishable answer — and so must a caller who is sent nothing at all,
/// which is why the wire test asserts a frame arrives for each of the six probes rather
/// than only that no content does.
#[test]
fn e2_e3_e4_sync_denials_are_indistinguishable() {
    let dir = TempDir::new("leak-sync-denial");
    dir.write("Private.md", "# Private\n");
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let access = Access::new(Vec::new(), Vec::new()).expect("empty policy");
    let outsider = Username::parse("outsider").expect("username");

    // The two probes differ in exactly the way an attacker cares about — one resolves to a
    // real file, one does not — and must still produce one answer. Resolution succeeding is
    // what an earlier revision leaked: it took the caller down a branch that replied, while
    // the unresolvable path fell through to silence.
    assert!(vault.canonical_note("Private.md").is_ok());
    assert!(vault.canonical_note("Absent.md").is_err());
    for note in ["Private.md", "Absent.md"] {
        let path = mb_core::NotePath::parse(note).expect("path");
        assert_eq!(
            access.effective_role(&outsider, &path),
            Role::None,
            "{note} must be denied identically whether or not it exists"
        );
    }
}

/// E2: an unsupported editor receives no body and cannot initialize disposable state.
/// Authentication/invisibility counterparts exercise real sockets in websocket.rs.
#[test]
fn e2_schema_refresh_withholds_content_before_note_state_is_opened() {
    use mb_server::sync::{SchemaSubscription, ServerFrame, SyncRegistry, current_schema_version};
    let dir = TempDir::new("leak-schema-admission");
    dir.write("Private.md", "KEEP PRIVATE BODY\n");
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let canonical = vault.canonical_note("Private.md").expect("canonical");
    let registry = SyncRegistry::default();
    let user = Username::parse("reader").expect("user");
    let current = current_schema_version().expect("schema revision");
    for schema_version in [None, Some(current - 1), Some(current + 1)] {
        let (outbound, mut inbox) = tokio::sync::mpsc::unbounded_channel();
        let result = registry.subscribe_versioned(
            &vault,
            &canonical,
            SchemaSubscription {
                note: "Private.md",
                user: &user,
                connection: ConnectionId::issue(),
                schema_version,
                outbound,
            },
            &|_, _, _| true,
        );
        assert!(result.is_err());
        assert!(inbox.try_recv().is_err(), "no metadata or body on refusal");
        assert!(
            !dir.path().join(".memberberry/crdt").exists(),
            "refusal must precede sidecar creation"
        );
    }
    let (outbound, mut inbox) = tokio::sync::mpsc::unbounded_channel();
    registry
        .subscribe_versioned(
            &vault,
            &canonical,
            SchemaSubscription {
                note: "Private.md",
                user: &user,
                connection: ConnectionId::issue(),
                schema_version: Some(current),
                outbound,
            },
            &|_, _, _| true,
        )
        .expect("current editor admitted");
    assert!(matches!(inbox.try_recv(), Ok(ServerFrame::Admitted { .. })));
    assert!(matches!(inbox.try_recv(), Ok(ServerFrame::Sync { .. })));
    assert_eq!(
        std::fs::read_to_string(dir.path().join("Private.md")).expect("source"),
        "KEEP PRIVATE BODY\n"
    );
}

/// E3: a subscription's fresh external import must not broadcast to a revoked reader.
#[test]
fn e3_first_sync_external_refresh_rechecks_existing_recipients() {
    use mb_server::sync::{SchemaSubscription, ServerFrame, SyncRegistry, current_schema_version};
    let dir = TempDir::new("leak-fresh-sync-import");
    let note = dir.write("One.md", "old body\n");
    dir.write("access.toml", "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n[[members]]\nuser = \"bob\"\nrole = \"viewer\"\n");
    let vault = Vault::open(Slug::parse("personal").unwrap(), "Personal", dir.path()).unwrap();
    let canonical = vault.canonical_note("One.md").unwrap();
    let registry = SyncRegistry::default();
    let alice = Username::parse("alice").unwrap();
    let bob = Username::parse("bob").unwrap();
    let (allowed, mut allowed_inbox) = tokio::sync::mpsc::unbounded_channel();
    let (revoked, mut revoked_inbox) = tokio::sync::mpsc::unbounded_channel();
    registry
        .subscribe(
            &vault,
            &canonical,
            "One.md",
            &alice,
            ConnectionId::issue(),
            allowed,
        )
        .unwrap();
    registry
        .subscribe(
            &vault,
            &canonical,
            "One.md",
            &bob,
            ConnectionId::issue(),
            revoked,
        )
        .unwrap();
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n",
    );
    std::fs::write(note, "fresh private external body\n").unwrap();
    let (outbound, mut inbox) = tokio::sync::mpsc::unbounded_channel();
    registry
        .subscribe_versioned(
            &vault,
            &canonical,
            SchemaSubscription {
                note: "One.md",
                user: &alice,
                connection: ConnectionId::issue(),
                outbound,
                schema_version: Some(current_schema_version().unwrap()),
            },
            &|_, note, reader| {
                mb_server::AccessFile::load(vault.root())
                    .unwrap()
                    .policy()
                    .effective_role(reader, &mb_core::NotePath::parse(note).unwrap())
                    != Role::None
            },
        )
        .unwrap();
    assert!(matches!(inbox.try_recv(), Ok(ServerFrame::Admitted { .. })));
    assert!(matches!(inbox.try_recv(), Ok(ServerFrame::Sync { .. })));
    assert!(matches!(
        allowed_inbox.try_recv(),
        Ok(ServerFrame::Update { .. })
    ));
    assert!(
        revoked_inbox.try_recv().is_err(),
        "revoked recipients receive neither body nor metadata"
    );
}

/// E4: presence is data. A room only ever holds readers, and re-checks on every frame.
#[test]
fn e4_awareness_reaches_only_current_readers() {
    let dir = TempDir::new("leak-awareness");
    dir.write("One.md", "# One\n");
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let canonical = vault.canonical_note("One.md").expect("canonical");
    let registry = mb_server::sync::SyncRegistry::default();
    let reader = Username::parse("reader").expect("username");
    let revoked = Username::parse("revoked").expect("username");
    let (to_reader, mut reader_inbox) = tokio::sync::mpsc::unbounded_channel();
    let (to_revoked, mut revoked_inbox) = tokio::sync::mpsc::unbounded_channel();
    registry
        .subscribe(
            &vault,
            &canonical,
            "One.md",
            &reader,
            ConnectionId::issue(),
            to_reader,
        )
        .expect("subscribe");
    registry
        .subscribe(
            &vault,
            &canonical,
            "One.md",
            &revoked,
            ConnectionId::issue(),
            to_revoked,
        )
        .expect("subscribe");
    // `subscribe` returns the initial state to its caller; the channel carries only
    // subsequent broadcasts.

    registry.broadcast_awareness(
        &vault,
        &canonical,
        mb_server::sync::Announcement {
            user: reader.as_str(),
            connection: ConnectionId::issue(),
            clients: &[7],
            state: serde_json::json!({ "cursor": 4 }),
        },
        &|_, _, user| user != &revoked,
    );

    assert!(
        reader_inbox.try_recv().is_ok(),
        "a current reader sees presence"
    );
    assert!(
        revoked_inbox.try_recv().is_err(),
        "presence reveals who is reading which note and follows the same filter as content"
    );
}

/// E15: a workspace layout is one user's private list of open notes.
///
/// `SPEC.md` §8.1 originally keyed the file by device alone, which made it readable by every
/// other member of the vault — the same class of disclosure §6.4 E4 already
/// permission-filters awareness for, because both reveal which note a person is reading. The
/// path now carries the user, and this is the test that it is the *authenticated* user rather
/// than anything a caller can choose.
#[test]
fn e15_a_workspace_layout_is_not_readable_by_another_member() {
    use mb_server::workspace::{DeviceId, WorkspaceStore};

    let dir = TempDir::new("leak-workspace");
    dir.write("Shared.md", "# Shared\n");
    let store = WorkspaceStore::new(dir.path());

    let alice = Username::parse("alice").expect("username");
    let bob = Username::parse("bob").expect("username");
    // The same device id on purpose: two people at one shared machine is the case that
    // collides if the path does not carry the user.
    let laptop = DeviceId::parse("shared-laptop").expect("device");

    let alices = r#"{"format":1,"vault":"personal","focusedGroup":"g","root":{"kind":"group","id":"g","tabs":[{"id":"t","note":"Private/Salary.md","mode":"edit","scroll":0,"history":["Private/Salary.md"],"historyIndex":0}],"activeTab":"t"}}"#;
    store.save(&alice, &laptop, alices).expect("alice saves");

    assert_eq!(
        store.load(&bob, &laptop).expect("bob loads"),
        None,
        "one member must not read another's layout, even from the same device"
    );
    assert_eq!(
        store.load(&alice, &laptop).expect("alice loads"),
        Some(alices.to_string()),
        "and her own must still come back unchanged"
    );

    // Bob writing his own does not disturb hers.
    let bobs = r#"{"format":1,"vault":"personal","focusedGroup":"g","root":{"kind":"group","id":"g","tabs":[],"activeTab":null}}"#;
    store.save(&bob, &laptop, bobs).expect("bob saves");
    assert_eq!(
        store.load(&alice, &laptop).expect("alice loads"),
        Some(alices.to_string())
    );
}

/// E15: a device id becomes a filename, so it cannot be allowed to name a path.
#[test]
fn e15_a_device_id_cannot_escape_the_workspace_directory() {
    use mb_server::workspace::DeviceId;

    for hostile in [
        "../../../etc/passwd",
        "..",
        ".",
        "a/b",
        "a\\b",
        "",
        "with space",
        "sémi-colon",
        "nul\0byte",
        &"x".repeat(65),
    ] {
        assert!(
            matches!(DeviceId::parse(hostile), Err(mb_server::Error::NotFound)),
            "`{hostile}` must not parse as a device id"
        );
    }
    // And the shapes a real client generates do.
    for usable in ["laptop", "Pixel-7a", "device_1", "0", &"x".repeat(64)] {
        assert!(DeviceId::parse(usable).is_ok(), "`{usable}` should parse");
    }
}

/// E5: the note index is the largest disclosure surface in the application.
///
/// The quick switcher ranks client-side (§21.2 budgets it at 80 ms over 10 000 notes), so the
/// *whole readable list* travels to the browser — every path and every title. That is the one
/// place where "the client never receives data it may not see" (AGENTS.md §3.1) is doing the
/// most work, and where a missing filter is least likely to be noticed by looking at a screen:
/// the results simply contain a note the user forgot they should not have.
#[test]
fn e5_the_note_index_names_nothing_the_viewer_cannot_read() {
    use mb_server::titles::TitleCache;

    let dir = TempDir::new("leak-note-index");
    dir.write("Shared.md", "# Shared\n");
    dir.write("Private/Salary.md", "# Salary Review\n");
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let alice = Username::parse("alice").expect("username");
    let access = Access::new(
        vec![Member {
            user: alice.clone(),
            role: Role::Viewer,
        }],
        vec![mb_core::Rule {
            path: mb_core::NotePath::parse("Private").expect("path"),
            grants: std::collections::BTreeMap::from([(alice.clone(), Role::None)]),
        }],
    )
    .expect("policy");
    let view = AuthorizedVault::new(&vault, &access, alice);

    let readable = view.notes().expect("notes");
    let cache = TitleCache::new();
    let summaries = cache.summaries(readable.iter().map(String::as_str), |relative| {
        view.resolve(relative).ok()
    });

    let rendered = format!("{summaries:?}");
    assert!(
        !rendered.contains("Salary"),
        "an unreadable note's title reached the index: {rendered}"
    );
    assert!(
        !rendered.contains("Private"),
        "nor may its folder be named: {rendered}"
    );
    assert_eq!(summaries.len(), 1);
    assert_eq!(
        summaries.first().and_then(|note| note.title.as_deref()),
        Some("Shared")
    );
}

/// E5: the title cache must not become a way to read a note the ACL just took away.
#[test]
fn e5_a_revoked_note_leaves_the_title_cache_on_the_next_listing() {
    use mb_server::titles::TitleCache;

    let dir = TempDir::new("leak-title-cache");
    dir.write("Shared.md", "# Shared\n");
    dir.write("Secret.md", "# Secret Plans\n");
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let alice = Username::parse("alice").expect("username");
    let permissive = Access::new(
        vec![Member {
            user: alice.clone(),
            role: Role::Viewer,
        }],
        Vec::new(),
    )
    .expect("policy");
    let cache = TitleCache::new();

    // While she can read it, the title is cached.
    let open = AuthorizedVault::new(&vault, &permissive, alice.clone());
    let before = cache.summaries(
        open.notes().expect("notes").iter().map(String::as_str),
        |relative| open.resolve(relative).ok(),
    );
    assert!(format!("{before:?}").contains("Secret Plans"));

    // After revocation the note is not in the readable list, so it is never named to the
    // cache — and a cached title cannot become a way back to it.
    let revoked = Access::new(
        vec![Member {
            user: alice.clone(),
            role: Role::Viewer,
        }],
        vec![mb_core::Rule {
            path: mb_core::NotePath::parse("Secret.md").expect("path"),
            grants: std::collections::BTreeMap::from([(alice.clone(), Role::None)]),
        }],
    )
    .expect("policy");
    let closed = AuthorizedVault::new(&vault, &revoked, alice);
    let after = cache.summaries(
        closed.notes().expect("notes").iter().map(String::as_str),
        |relative| closed.resolve(relative).ok(),
    );

    let rendered = format!("{after:?}");
    assert!(
        !rendered.contains("Secret"),
        "a cached title outlived the permission that produced it: {rendered}"
    );
}

/// E5: §3.5's conflict badge is a statement about a note, so it is filtered like the title.
///
/// A badge is a smaller leak than a title and a worse one to reason about, because it is a
/// number rather than a name: "one of the notes you cannot see has an unresolved conflict" is
/// still knowledge of a note that, under §6.5, does not exist for this reader. It travels on
/// the note summary, so the same filter carries it — and this is the assertion that says so.
#[test]
fn e5_a_conflict_badge_names_no_note_the_viewer_cannot_read() {
    use mb_server::titles::TitleCache;

    const CONFLICTED: &str =
        "Mine.\n\n> [!conflict] Conflicting version — external edit, now\n>\n> Theirs.\n";

    let dir = TempDir::new("leak-conflict-badge");
    dir.write("Shared.md", "# Shared\n");
    dir.write("Private/Salary.md", CONFLICTED);
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let alice = Username::parse("alice").expect("username");
    let access = Access::new(
        vec![Member {
            user: alice.clone(),
            role: Role::Viewer,
        }],
        vec![mb_core::Rule {
            path: mb_core::NotePath::parse("Private").expect("path"),
            grants: std::collections::BTreeMap::from([(alice.clone(), Role::None)]),
        }],
    )
    .expect("policy");
    let view = AuthorizedVault::new(&vault, &access, alice);

    let cache = TitleCache::new();
    let summaries = cache.summaries(
        view.notes().expect("notes").iter().map(String::as_str),
        |relative| view.resolve(relative).ok(),
    );

    assert_eq!(summaries.len(), 1);
    assert_eq!(
        summaries.iter().map(|note| note.conflicts).sum::<usize>(),
        0,
        "a conflict in a note this viewer cannot read was counted: {summaries:?}",
    );
}

/// The badge is a real count for a note the viewer *can* read, or the test above proves
/// nothing: a count that is always zero passes every filter.
#[test]
fn e5_a_conflict_badge_counts_a_note_the_viewer_can_read() {
    use mb_server::titles::TitleCache;

    let dir = TempDir::new("leak-conflict-badge-visible");
    dir.write(
        "Shared.md",
        "Mine.\n\n> [!conflict] Conflicting version — external edit, now\n>\n> Theirs.\n",
    );
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let alice = Username::parse("alice").expect("username");
    let access = Access::new(
        vec![Member {
            user: alice.clone(),
            role: Role::Viewer,
        }],
        Vec::new(),
    )
    .expect("policy");
    let view = AuthorizedVault::new(&vault, &access, alice);

    let cache = TitleCache::new();
    let summaries = cache.summaries(
        view.notes().expect("notes").iter().map(String::as_str),
        |relative| view.resolve(relative).ok(),
    );

    assert_eq!(summaries.first().map(|note| note.conflicts), Some(1));
}

/// E15: a bookmark outlives the permission that created it, so reading one is filtered.
///
/// This is the case a workspace layout does not have to handle. A layout is short-lived and
/// its tree shape makes filtering awkward, so a stale entry there simply fails to open. A
/// bookmark list is curated over months and sits in a sidebar, so a note whose access was
/// revoked would keep showing its name — which is exactly what §6.5 forbids.
#[test]
fn e15_a_revoked_note_leaves_the_bookmark_list() {
    use mb_server::bookmarks::BookmarkStore;

    let vault_dir = TempDir::new("leak-bookmarks-vault");
    let data_dir = TempDir::new("leak-bookmarks-data");
    vault_dir.write("Shared.md", "# Shared\n");
    vault_dir.write("Private/Salary.md", "# Salary Review\n");
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        vault_dir.path(),
    )
    .expect("vault");
    let alice = Username::parse("alice").expect("username");
    let store = BookmarkStore::new(data_dir.path());

    let permissive = Access::new(
        vec![Member {
            user: alice.clone(),
            role: Role::Viewer,
        }],
        Vec::new(),
    )
    .expect("policy");

    // Bookmarked while she could read it.
    let open = AuthorizedVault::new(&vault, &permissive, alice.clone());
    let wanted = vec!["Shared.md".to_string(), "Private/Salary.md".to_string()];
    assert!(wanted.iter().all(|path| open.resolve(path).is_ok()));
    store
        .save(&alice, vault.slug(), &wanted)
        .expect("saving bookmarks");

    // After revocation the stored file is untouched, and the *read* is what filters.
    let revoked = Access::new(
        vec![Member {
            user: alice.clone(),
            role: Role::Viewer,
        }],
        vec![mb_core::Rule {
            path: mb_core::NotePath::parse("Private").expect("path"),
            grants: std::collections::BTreeMap::from([(alice.clone(), Role::None)]),
        }],
    )
    .expect("policy");
    let closed = AuthorizedVault::new(&vault, &revoked, alice.clone());

    let visible: Vec<String> = store
        .load(&alice, vault.slug())
        .into_iter()
        .filter(|path| closed.resolve(path).is_ok())
        .collect();

    assert_eq!(visible, vec!["Shared.md".to_string()]);
    let rendered = format!("{visible:?}");
    assert!(
        !rendered.contains("Salary") && !rendered.contains("Private"),
        "a revoked note must not be named by its own bookmark: {rendered}"
    );
}

/// E15: one member's bookmarks are not another's, and neither can name a path.
#[test]
fn e15_bookmarks_are_per_user_and_cannot_escape_the_data_directory() {
    use mb_server::bookmarks::{BookmarkStore, MAX_BOOKMARKS};

    let vault_dir = TempDir::new("leak-bookmarks-users-vault");
    let data_dir = TempDir::new("leak-bookmarks-users-data");
    vault_dir.write("Shared.md", "# Shared\n");
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        vault_dir.path(),
    )
    .expect("vault");
    let alice = Username::parse("alice").expect("username");
    let bob = Username::parse("bob").expect("username");
    let store = BookmarkStore::new(data_dir.path());

    store
        .save(&alice, vault.slug(), &["Shared.md".to_string()])
        .expect("alice saves");
    assert!(
        store.load(&bob, vault.slug()).is_empty(),
        "one member must not read another's bookmarks"
    );

    // A path is parsed before it is stored, because everything downstream joins these strings
    // to a vault root — and a `..` reaching one of them is a traversal.
    for hostile in [
        "../../etc/passwd",
        "/etc/passwd",
        "..",
        "Private/../../secret.md",
    ] {
        assert!(
            store
                .save(&alice, vault.slug(), &[hostile.to_string()])
                .is_err(),
            "`{hostile}` must not be storable as a bookmark"
        );
    }
    // And the refusals left the good list alone.
    assert_eq!(
        store.load(&alice, vault.slug()),
        vec!["Shared.md".to_string()]
    );

    // A member is trusted to read notes, not to fill the server's own directory.
    let too_many: Vec<String> = (0..=MAX_BOOKMARKS)
        .map(|n| format!("Note {n}.md"))
        .collect();
    assert!(store.save(&alice, vault.slug(), &too_many).is_err());
}

/// E8: backlinks are titles and note text, and both are filtered by the readable set.
///
/// The index's own suite (`mb-index/tests/permissions.rs`) covers the query layer against
/// hand-built policies. This is the server's side of the same point: a real vault, a real
/// `access.toml`, and the index maintained the way the maintenance tick maintains it — so a
/// filter that is right in `mb-index` and wrongly wired here still fails.
#[test]
fn e8_backlinks_name_no_note_the_viewer_cannot_read() {
    let dir = TempDir::new("leak-backlinks");
    dir.write("Shared.md", "# Shared\n");
    dir.write(
        "Private/Salary.md",
        "# Salary Review\n\nCosting for [[Shared]].\n",
    );
    dir.write("Open.md", "# Open\n\nAlso about [[Shared]].\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"viewer\"\n\n\
         [[rules]]\npath = \"Private\"\ngrant = { alice = \"none\" }\n",
    );
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let access = mb_server::AccessFile::load(vault.root()).expect("access.toml");
    let registry = mb_server::indexing::IndexRegistry::default();
    let errors = registry.maintain(std::iter::once(&vault), &mb_server::watch::Changes::All);
    assert!(errors.is_empty(), "indexing the vault: {errors:?}");
    let index = registry.get(&vault).expect("index");
    let mut index = index.lock().expect("index lock");
    let alice = Username::parse("alice").expect("username");
    let reader = index
        .reader(access.policy(), &alice)
        .expect("a reader for alice");

    let sources: Vec<String> = reader
        .backlinks("Shared.md")
        .expect("backlinks")
        .into_iter()
        .map(|group| group.path)
        .collect();
    assert_eq!(
        sources,
        vec!["Open.md".to_string()],
        "the private note appeared in the backlinks of a note alice may read"
    );

    // The private note itself has no backlinks, because for alice it does not exist — and
    // the answer is the same as for a note that was never written.
    assert!(
        reader
            .backlinks("Private/Salary.md")
            .expect("backlinks")
            .is_empty()
    );
    assert_eq!(
        reader.contains("Private/Salary.md").expect("contains"),
        reader.contains("Private/Never.md").expect("contains")
    );
}

/// E8: an unlinked mention discloses a *sentence*, which is more than a backlink discloses.
///
/// A backlink row leaks the linking note's title and the block a link sits in. A mention has
/// no link to have been found by, so what puts it on screen is only that a private note
/// happens to use a word — and the row then quotes that note's prose. The filter is the same
/// readable set; this test exists because the consequence of losing it is larger, and because
/// mentions reach Tantivy rather than SQLite and so are a second code path to the same data.
#[test]
fn e8_unlinked_mentions_quote_no_note_the_viewer_cannot_read() {
    let dir = TempDir::new("leak-mentions");
    dir.write("Shared.md", "# Shared\n\nBody.\n");
    dir.write(
        "Private/Salary.md",
        "# Salary Review\n\nThe canary Shared budget is confidential.\n",
    );
    dir.write("Open.md", "# Open\n\nThe Shared plan is agreed.\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"viewer\"\n\n\
         [[rules]]\npath = \"Private\"\ngrant = { alice = \"none\" }\n",
    );
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let access = mb_server::AccessFile::load(vault.root()).expect("access.toml");
    let registry = mb_server::indexing::IndexRegistry::default();
    let errors = registry.maintain(std::iter::once(&vault), &mb_server::watch::Changes::All);
    assert!(errors.is_empty(), "indexing the vault: {errors:?}");
    let index = registry.get(&vault).expect("index");
    let mut index = index.lock().expect("index lock");
    let alice = Username::parse("alice").expect("username");
    let reader = index
        .reader(access.policy(), &alice)
        .expect("a reader for alice");

    let mentions = reader
        .unlinked_mentions("Shared.md", 50)
        .expect("unlinked mentions");
    let paths: Vec<&str> = mentions.iter().map(|group| group.path.as_str()).collect();
    assert_eq!(
        paths,
        vec!["Open.md"],
        "the private note appeared in the mentions of a note alice may read"
    );
    // why: asserted on the whole rendered value rather than on the paths. The paths above
    // would still be right if a private note's *sentence* were attached to a readable
    // group, which is the shape of leak this route is uniquely capable of.
    let rendered = format!("{mentions:?}");
    assert!(
        !rendered.contains("canary"),
        "a private note's text reached a mention row: {rendered}"
    );

    // An unreadable target has no mentions, because for alice it does not exist.
    assert!(
        reader
            .unlinked_mentions("Private/Salary.md", 50)
            .expect("unlinked mentions")
            .is_empty()
    );
}

/// E9: a graph is a picture of a vault, and every dot in it is a note that exists.
///
/// The disclosure a graph makes is *shape*: a node the viewer cannot read names it, an edge
/// into one says it is there, and a dot with no label still says a note is at the end of
/// that line. So the assertion is in two halves, because either alone passes against a
/// broken implementation of the other — no node names an unreadable note, **and** the link
/// into one draws exactly what a link into a note nobody has written draws.
#[test]
fn e9_a_graph_draws_no_note_the_viewer_cannot_read() {
    let dir = TempDir::new("leak-graph");
    dir.write("Shared.md", "# Shared\n\nSee [[Never]].\n");
    dir.write(
        "Private/Salary.md",
        "# Salary Review\n\nCosting for [[Shared]], and [[Private/Deeper]].\n",
    );
    dir.write("Private/Deeper.md", "# Deeper\n");
    dir.write("Open.md", "# Open\n\nAlso about [[Shared]].\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"viewer\"\n\n\
         [[rules]]\npath = \"Private\"\ngrant = { alice = \"none\" }\n",
    );
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let access = mb_server::AccessFile::load(vault.root()).expect("access.toml");
    let registry = mb_server::indexing::IndexRegistry::default();
    let errors = registry.maintain(std::iter::once(&vault), &mb_server::watch::Changes::All);
    assert!(errors.is_empty(), "indexing the vault: {errors:?}");
    let index = registry.get(&vault).expect("index");
    let mut index = index.lock().expect("index lock");
    let alice = Username::parse("alice").expect("username");
    let reader = index
        .reader(access.policy(), &alice)
        .expect("a reader for alice");

    // Three hops out of a note two links from everything private: nothing private is drawn,
    // named, or reachable through.
    let graph = reader.neighbourhood("Shared.md", 3).expect("neighbourhood");
    let drawn: Vec<&str> = graph.nodes.iter().map(|node| node.key.as_str()).collect();
    assert_eq!(
        drawn,
        vec!["n:Shared.md", "g:never", "n:Open.md"],
        "the graph drew something alice cannot read"
    );
    for node in &graph.nodes {
        assert!(!node.label.contains("Salary"), "a denied title: {node:?}");
        assert!(!node.label.contains("Deeper"), "a denied title: {node:?}");
    }
    for edge in &graph.edges {
        assert!(
            !edge.source.contains("Private") && !edge.target.contains("Private"),
            "an edge into a denied note: {edge:?}"
        );
    }

    // The private note has no graph of its own, and answers exactly as a note nobody wrote.
    assert_eq!(
        reader
            .neighbourhood("Private/Salary.md", 3)
            .expect("neighbourhood"),
        reader
            .neighbourhood("Private/Never.md", 3)
            .expect("neighbourhood")
    );

    // The half a filtered node list cannot catch. `[[Shared]]` written inside a note alice
    // cannot read is *absent*; `[[Never]]` naming a note nobody wrote is a **ghost**. If an
    // unreadable target were ever drawn as a ghost from a readable source, the picture would
    // report the note's existence while claiming it does not exist — so the two have to be
    // the same shape, which is what comparing them proves.
    let ghosts: Vec<&str> = graph
        .nodes
        .iter()
        .filter(|node| node.path.is_none())
        .map(|node| node.label.as_str())
        .collect();
    assert_eq!(ghosts, vec!["Never"]);
}

/// E9: the whole-vault picture is a picture of the vault *this viewer has*.
///
/// The neighbourhood above is bounded by an origin and a hop count, so most of a vault is
/// out of its picture for reasons that have nothing to do with permissions. The whole-vault
/// query has no such excuse: every readable note is a node, so a note that leaks here leaks
/// in the one place a viewer would notice a gap. What it must not disclose is the same list
/// as ever — no node, no title, no edge, no tag, and no *count*, because "showing 3 of 5"
/// answers the question the invisibility rule exists to refuse (§6.5).
#[test]
fn e9_a_whole_vault_graph_draws_no_note_the_viewer_cannot_read() {
    let dir = TempDir::new("leak-vault-graph");
    dir.write("Shared.md", "# Shared\n\nSee [[Never]].\n");
    dir.write(
        "Private/Salary.md",
        "# Salary Review\n\n#compensation\n\nCosting for [[Shared]].\n",
    );
    dir.write("Private/Deeper.md", "# Deeper\n\nSee [[Private/Salary]].\n");
    // The two links that have to draw the same thing: one names a note alice cannot read,
    // the other names a note nobody has written.
    dir.write(
        "Open.md",
        "# Open\n\nAbout [[Shared]], [[Private/Salary]] and [[Nowhere]].\n",
    );
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"viewer\"\n\n\
         [[rules]]\npath = \"Private\"\ngrant = { alice = \"none\" }\n",
    );
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let access = mb_server::AccessFile::load(vault.root()).expect("access.toml");
    let registry = mb_server::indexing::IndexRegistry::default();
    let errors = registry.maintain(std::iter::once(&vault), &mb_server::watch::Changes::All);
    assert!(errors.is_empty(), "indexing the vault: {errors:?}");
    let index = registry.get(&vault).expect("index");
    let mut index = index.lock().expect("index lock");
    let alice = Username::parse("alice").expect("username");
    let reader = index
        .reader(access.policy(), &alice)
        .expect("a reader for alice");

    let graph = reader.vault_graph(None).expect("vault graph");
    let drawn: Vec<&str> = graph.nodes.iter().map(|node| node.key.as_str()).collect();
    assert_eq!(
        drawn,
        vec![
            "g:never",
            "g:nowhere",
            "g:private/salary",
            "n:Open.md",
            "n:Shared.md"
        ],
        "the graph drew something alice cannot read"
    );
    assert_eq!(
        graph.total, 5,
        "the count is over the readable set, or it is a way of asking how many notes exist"
    );

    // A ghost is a name a readable note spells, so `g:private/salary` says nothing alice
    // cannot already read in `Open.md`. What must never appear is anything only the note
    // itself knows: its title, its tags, and the fact that it is a note at all — which is
    // why every ghost has to look identical whatever is behind it.
    for node in &graph.nodes {
        assert!(!node.label.contains("Salary Review"), "a title: {node:?}");
        assert!(!node.label.contains("Deeper"), "a denied note: {node:?}");
        assert!(
            !node.tags.iter().any(|tag| tag == "compensation"),
            "a denied note's tag: {node:?}"
        );
        assert!(
            node.path
                .as_deref()
                .is_none_or(|path| !path.contains("Private")),
            "a denied path: {node:?}"
        );
    }
    let unreadable = graph
        .nodes
        .iter()
        .find(|node| node.key == "g:private/salary")
        .expect("the unreadable target");
    let unwritten = graph
        .nodes
        .iter()
        .find(|node| node.key == "g:nowhere")
        .expect("the unwritten target");
    assert_eq!(
        (
            unreadable.path.as_deref(),
            unreadable.degree,
            unreadable.words,
            unreadable.created.as_deref(),
            unreadable.tags.as_slice(),
        ),
        (
            unwritten.path.as_deref(),
            unwritten.degree,
            unwritten.words,
            unwritten.created.as_deref(),
            unwritten.tags.as_slice(),
        ),
        "a link into a note alice cannot read must draw exactly what a link into a note \
         nobody has written draws — anything else reports that the note is there"
    );

    // `Private/Deeper` links to `Private/Salary`, so an unfiltered link query would draw an
    // edge between two notes alice cannot see.
    for edge in &graph.edges {
        assert!(
            edge.source == "n:Open.md" || edge.source == "n:Shared.md",
            "an edge out of a denied note: {edge:?}"
        );
    }

    // A cap must not be a channel either: asking for one node still reports five, and the
    // one it keeps is a readable note.
    let capped = reader.vault_graph(Some(1)).expect("capped vault graph");
    assert_eq!(capped.total, 5);
    assert!(capped.truncated);
    assert_eq!(capped.nodes.len(), 1);
    assert_eq!(
        capped.nodes.first().map(|node| node.key.as_str()),
        Some("n:Open.md"),
        "the highest degree"
    );
}

/// E7: a transclusion resolves against the caller's readable set, so an unreadable target
/// is not a candidate — and a nearer unreadable note does not shadow a readable one.
#[test]
fn e7_a_transclusion_resolves_to_nothing_it_cannot_read() {
    let dir = TempDir::new("leak-transclusion");
    dir.write(
        "Private/Roadmap.md",
        "# Secret Roadmap\n\nAcquire Initech.\n",
    );
    dir.write("Archive/Roadmap.md", "# Old Roadmap\n\nShipped.\n");
    dir.write("Private/Salary.md", "# Salary Review\n");
    dir.write("Projects/Q3.md", "quarter: ![[Roadmap]]\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"viewer\"\n\n\
         [[rules]]\npath = \"Private\"\ngrant = { alice = \"none\" }\n",
    );
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let access = mb_server::AccessFile::load(vault.root()).expect("access.toml");
    let registry = mb_server::indexing::IndexRegistry::default();
    let errors = registry.maintain(std::iter::once(&vault), &mb_server::watch::Changes::All);
    assert!(errors.is_empty(), "indexing the vault: {errors:?}");
    let index = registry.get(&vault).expect("index");
    let mut index = index.lock().expect("index lock");
    let alice = Username::parse("alice").expect("username");
    let reader = index
        .reader(access.policy(), &alice)
        .expect("a reader for alice");

    // `Private/Roadmap.md` is the nearer candidate for nobody: for alice it does not exist,
    // so the reference means the archived one. Resolving first and dropping the result
    // afterwards would leave a dead embed exactly where a secret note is (§9.1).
    let target = reader
        .resolve("Projects/Q3.md", "Roadmap")
        .expect("resolve")
        .expect("a readable candidate");
    assert_eq!(target.path, "Archive/Roadmap.md");
    let rendered = format!("{target:?}");
    assert!(
        !rendered.contains("Secret") && !rendered.contains("Private"),
        "the unreadable candidate was named: {rendered}"
    );

    // And a reference that names *only* an unreadable note answers as one naming a note
    // that was never written does.
    assert_eq!(
        reader.resolve("Projects/Q3.md", "Salary").expect("resolve"),
        reader.resolve("Projects/Q3.md", "Never").expect("resolve"),
    );
}

/// E5: nothing outside the vault reaches the index, and therefore nothing outside the vault
/// comes back out of a query over it.
#[test]
fn e5_content_from_outside_the_vault_never_reaches_the_index() {
    // The containment boundary is `Vault::resolve`, and it always refused this file — but
    // the index is built from `Vault::notes`, which used to list it. The title and the block
    // text of a file the note route will not serve were reaching the index and coming back
    // out as a backlink row's context. Asserted here as well as in `vault.rs` because the
    // property that matters is about the *query surface*: this stays true only while
    // whatever the indexer lists by keeps the boundary.
    let outside = TempDir::new("leak-outside");
    outside.write(
        "secret.md",
        "# Secret Outside\n\nA token, and a mention of [[Shared]].\n",
    );
    let dir = TempDir::new("leak-symlink");
    dir.write("Shared.md", "# Shared\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n",
    );
    let link = dir.path().join("Escape.md");
    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.path().join("secret.md"), &link)
        .expect("creating the symlink");
    #[cfg(not(unix))]
    {
        let _ = &link;
        return;
    }

    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let access = mb_server::AccessFile::load(vault.root()).expect("access.toml");
    let registry = mb_server::indexing::IndexRegistry::default();
    let errors = registry.maintain(std::iter::once(&vault), &mb_server::watch::Changes::All);
    assert!(errors.is_empty(), "indexing the vault: {errors:?}");
    let index = registry.get(&vault).expect("index");
    let mut index = index.lock().expect("index lock");
    let alice = Username::parse("alice").expect("username");
    let reader = index
        .reader(access.policy(), &alice)
        .expect("a reader for alice");

    assert_eq!(
        reader.readable_notes(),
        1,
        "the symlinked file was indexed as a note of this vault"
    );
    let rendered = format!("{:?}", reader.backlinks("Shared.md").expect("backlinks"));
    for leak in ["Secret Outside", "A token", "Escape"] {
        assert!(
            !rendered.contains(leak),
            "`{leak}` came from outside the vault: {rendered}"
        );
    }
    assert_eq!(
        reader.resolve("Shared.md", "Escape").expect("resolve"),
        None,
        "and it cannot be transcluded either (E7)"
    );
}

/// E16: a tag count is a statement about how many notes exist, so it is filtered too.
///
/// The disclosure here is arithmetic rather than a name. `#salary` appearing at all tells a
/// reader a note they cannot see carries it; `#shared` reading "3" when they can see one
/// tells them there are two more. Both are §6.5, and neither is visible in a route test that
/// only checks which strings came back.
#[test]
fn e16_tag_counts_never_include_a_note_the_viewer_cannot_read() {
    let dir = TempDir::new("leak-tags");
    dir.write("Open.md", "# Open\n\n#shared\n");
    dir.write("Private/Salary.md", "# Salary\n\n#shared #salary/2026\n");
    dir.write("Private/Bonus.md", "# Bonus\n\n#shared\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"viewer\"\n\n\
         [[rules]]\npath = \"Private\"\ngrant = { alice = \"none\" }\n",
    );
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let access = mb_server::AccessFile::load(vault.root()).expect("access.toml");
    let registry = mb_server::indexing::IndexRegistry::default();
    let errors = registry.maintain(std::iter::once(&vault), &mb_server::watch::Changes::All);
    assert!(errors.is_empty(), "indexing the vault: {errors:?}");
    let index = registry.get(&vault).expect("index");
    let mut index = index.lock().expect("index lock");
    let alice = Username::parse("alice").expect("username");
    let reader = index
        .reader(access.policy(), &alice)
        .expect("a reader for alice");

    let tags = reader.tags().expect("tags");
    assert_eq!(
        tags.iter()
            .map(|node| (node.key.as_str(), node.notes))
            .collect::<Vec<_>>(),
        vec![("shared", 1)],
        "a tag only an unreadable note carries must not exist, and one shared with two \
         unreadable notes must count one"
    );

    // Asking for the private tag by name answers as it does for a tag nobody ever wrote.
    assert!(reader.tagged("salary").expect("tagged").is_empty());
    assert_eq!(
        reader.tagged("salary/2026").expect("tagged"),
        reader.tagged("no-such-tag").expect("tagged")
    );
    assert_eq!(
        reader
            .tagged("shared")
            .expect("tagged")
            .into_iter()
            .map(|target| target.path)
            .collect::<Vec<_>>(),
        vec!["Open.md".to_string()]
    );
}

/// E14: a rename rewrites what the actor cannot see, and says nothing about it.
///
/// The privilege in §6.6 is real — the rewrite reaches notes outside the actor's readable
/// set on purpose — so what has to be tested is the seam between "it did the work" and "it
/// admitted to the work". Three claims, and each fails independently:
///
/// 1. a note the actor cannot read *is* repointed, because §6.6 says a broken link is worse;
/// 2. the reply counts only the notes they can read, because a count is a claim about how
///    many notes exist (§6.5, the same argument as E16's tag counts);
/// 3. a note they cannot read cannot be renamed, and the refusal is the one a missing note
///    gets — so a rename is not an oracle for which notes are there.
#[test]
fn e14_a_privileged_rewrite_never_reports_what_it_reached() {
    let dir = TempDir::new("leak-rename");
    dir.write("Roadmap.md", "# Roadmap\n");
    dir.write("Open.md", "See [[Roadmap]].\n");
    dir.write(
        "Private/Salary.md",
        "Budget in [[Roadmap]] and [[Roadmap]].\n",
    );
    dir.write("Private/Board.md", "Also [[Roadmap]].\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n\n\
         [[members]]\nuser = \"bob\"\nrole = \"editor\"\n\n\
         [[rules]]\npath = \"Private\"\ngrant = { bob = \"none\" }\n",
    );
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let access = mb_server::AccessFile::load(vault.root()).expect("access.toml");
    let registry = mb_server::indexing::IndexRegistry::default();
    let errors = registry.maintain(std::iter::once(&vault), &mb_server::watch::Changes::All);
    assert!(errors.is_empty(), "indexing the vault: {errors:?}");
    let index = registry.get(&vault).expect("index");
    let sync = mb_server::sync::SyncRegistry::default();
    let bob = Username::parse("bob").expect("username");

    // Bob may not read `Private/`, so it does not exist for him — including as a rename
    // target, and including in a way that would tell him apart from a note nobody wrote.
    let rename =
        mb_server::rename::Rename::new(&vault, access.policy(), bob.clone(), &index, &sync, None);
    for probe in ["Private/Salary.md", "Private/NeverExisted.md"] {
        assert!(
            matches!(
                rename.note(probe, "Pay.md"),
                Err(mb_server::rename::RenameError::Denied)
            ),
            "{probe} must answer as a note that is not there"
        );
    }
    assert!(dir.path().join("Private/Salary.md").exists());

    let renamed = rename
        .note("Roadmap.md", "Plan.md")
        .expect("bob may rename this one");
    assert_eq!(
        (renamed.notes, renamed.references),
        (1, 1),
        "the reply counted a note bob cannot read: it must describe only his own vault"
    );
    for hidden in ["Private/Salary.md", "Private/Board.md"] {
        let rewritten = std::fs::read_to_string(dir.path().join(hidden)).expect("the hidden note");
        assert!(
            !rewritten.contains("[[Roadmap]]"),
            "{hidden} was left with a broken link, which §6.6 exists to prevent"
        );
    }
}

/// E17: creating a note must not become an oracle for which notes and folders exist.
///
/// This is the enforcement point with the newest shape: every earlier write path was asked
/// about a note that already existed, so the ACL had a subject. Creation is asked about a
/// *name*, and the danger is entirely in the ordering. If "that already exists" were
/// answered before "you may write here", anyone who could reach the route could map a
/// private vault by trying to create over it — the reply would differ for an occupied path
/// and an empty one, which is precisely the distinction §6.5 forbids.
///
/// Four claims, each of which fails independently:
///
/// 1. a member who may not write in a folder cannot create there;
/// 2. the refusal is **byte-identical** whether or not a note occupies the path, so it
///    carries no information about what is there;
/// 3. nothing is written on a refusal;
/// 4. a per-folder grant is what bounds it, not vault-wide membership — so the same user
///    who is refused in `Private/` succeeds in the folder they were granted.
#[test]
fn e17_creating_a_note_never_reveals_what_is_already_there() {
    let dir = TempDir::new("leak-create");
    dir.write("Shared/Welcome.md", "# Welcome\n");
    dir.write("Private/Salary.md", "# Salary Review\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n\n\
         [[members]]\nuser = \"bob\"\nrole = \"viewer\"\n\n\
         [[rules]]\npath = \"Shared\"\ngrant = { bob = \"editor\" }\n\n\
         [[rules]]\npath = \"Private\"\ngrant = { bob = \"none\" }\n",
    );
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let access = mb_server::AccessFile::load(vault.root()).expect("access.toml");
    let registry = mb_server::indexing::IndexRegistry::default();
    let errors = registry.maintain(std::iter::once(&vault), &mb_server::watch::Changes::All);
    assert!(errors.is_empty(), "indexing the vault: {errors:?}");
    let index = registry.get(&vault).expect("index");
    let bob = Username::parse("bob").expect("username");
    let create = mb_server::create::CreateNote::new(&vault, access.policy(), bob, &index);

    // `Private/` does not exist for bob, so neither does what is in it. The occupied path and
    // the empty one must be one answer — compared as strings, because two `Denied` variants
    // that formatted differently would leak just as surely as two different variants.
    let occupied = create.note("Private/Salary.md");
    let empty = create.note("Private/NeverExisted.md");
    for (probe, outcome) in [
        ("Private/Salary.md", &occupied),
        ("Private/NeverExisted.md", &empty),
    ] {
        assert!(
            matches!(outcome, Err(mb_server::create::CreateError::Denied)),
            "{probe} must answer as a folder that is not there: {outcome:?}"
        );
    }
    assert_eq!(
        occupied.expect_err("denied").to_string(),
        empty.expect_err("denied").to_string(),
        "an occupied path and an empty one must give one refusal, byte for byte"
    );
    assert!(!dir.path().join("Private/NeverExisted.md").exists());
    // The note bob probed is untouched, which is the other half of "nothing was written".
    assert_eq!(
        std::fs::read_to_string(dir.path().join("Private/Salary.md")).expect("the hidden note"),
        "# Salary Review\n"
    );

    // Vault-wide he is only a viewer, so the grant on `Shared/` is doing the work — and the
    // refusal above was about the folder, not about bob being unable to create anything.
    let allowed = create.note("Shared/Plan.md");
    assert!(
        allowed.is_ok(),
        "the folder grant must permit this: {allowed:?}"
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("Shared/Plan.md")).expect("the new note"),
        "# Plan\n"
    );
    // And a viewer's own root, where he has no grant at all, stays closed.
    assert!(matches!(
        create.note("Root.md"),
        Err(mb_server::create::CreateError::Denied)
    ));
    assert!(!dir.path().join("Root.md").exists());
}

/// E25: every static-site artifact comes from one permission-filtered repository view.
#[test]
fn e25_static_export_contains_no_unreadable_note_or_graph_edge() {
    let dir = TempDir::new("leak-static-export");
    dir.write("Public.md", "# Public\n\n[[Shared]] [[Private/Salary]]\n");
    dir.write("Shared.md", "# Shared\n\nreadable-copy\n");
    dir.write("Private/Salary.md", "# Payroll\n\nprivate-copy\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"viewer\"\n\n\
         [[rules]]\npath = \"Private\"\ngrant = { alice = \"none\" }\n",
    );
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let media = mb_server::media::LocalStore::new(&vault);
    let readable_media = media.put(b"readable image", "png").expect("public media");
    let private_media = media.put(b"private image", "png").expect("private media");
    dir.write(
        "Shared.md",
        &format!("# Shared\n\nreadable-copy\n\n![public]({readable_media})\n"),
    );
    dir.write(
        "Private/Salary.md",
        &format!("# Payroll\n\nprivate-copy\n\n![private]({private_media})\n"),
    );
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth");
    auth.setup_first_user(mb_auth::NewUser {
        username: "alice",
        display_name: "Alice",
        password: "correct horse battery staple",
    })
    .expect("user");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    let destination = dir.path().join(".site");

    let count = mb_server::static_site::write(&vault, &auth, "alice", &destination, &runtime)
        .expect("export");

    assert_eq!(count, 2);
    assert!(!destination.join("notes/Private/Salary.html").exists());
    assert!(destination.join(&readable_media).is_file());
    assert!(!destination.join(&private_media).exists());
    let search = std::fs::read_to_string(destination.join("site-data.js")).expect("search");
    let graph = std::fs::read_to_string(destination.join("graph.html")).expect("graph");
    assert!(!search.contains("private-copy"), "{search}");
    assert!(!search.contains("Private/Salary.html"), "{search}");
    assert!(!graph.contains("Private/Salary.html"), "{graph}");
    assert!(search.contains("readable-copy"), "{search}");
    assert!(graph.contains("Shared.html"), "{graph}");
}

#[cfg(target_os = "linux")]
#[test]
fn e29_symlink_adoption_never_reads_or_publishes_link_targets() {
    registration_cases::symlinks_are_skipped_without_reading_targets();
}

#[cfg(target_os = "linux")]
#[path = "support/folder_exclusion_cases.rs"]
mod folder_exclusion_cases;
#[cfg(target_os = "linux")]
#[test]
fn e29_non_writable_folder_opt_in_never_reads_or_discloses_excluded_descendants() {
    folder_exclusion_cases::checked_option_filters_without_reading_or_repairing(
        "e29_non_writable_folder_opt_in_never_reads_or_discloses_excluded_descendants",
    );
}

#[path = "support/folder_delete_cases.rs"]
mod folder_delete_cases;

#[test]
fn e32_folder_delete_authorizes_all_descendants_before_confirmation_or_mutation() {
    folder_delete_cases::permission_preflight();
}

/// E34: on the desktop app's loopback server, anything but the launched window — another
/// local process, or a web page reaching loopback through DNS rebinding — gets one identical
/// refusal and no byte of note content, from every kind of route.
#[tokio::test]
async fn e34_nothing_but_the_launched_window_reaches_the_desktop_server() {
    use mb_server::desktop::{DesktopPaths, DesktopServer};
    let dir = TempDir::new("e34");
    let paths = DesktopPaths {
        app_data: dir.path().join("app-data"),
        notes_home: dir.path().join("Memberberry"),
        web_root: dir.path().join("web"),
    };
    let server = DesktopServer::start(
        &paths,
        &mb_server::desktop::DesktopIdentity {
            display_name: "Jo".into(),
            device_name: "Jo's laptop".into(),
        },
        mb_server::desktop::DesktopHost {
            secrets: std::sync::Arc::new(mb_server::desktop::MemorySecrets::default()),
            browser: std::sync::Arc::new(mb_server::desktop::RecordingBrowser::default()),
        },
    )
    .expect("desktop server");
    let origin = format!("http://127.0.0.1:{}", server.port());
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("client");
    let launched = client
        .get(server.launch_url())
        .send()
        .await
        .expect("launch");
    let desktop = launched
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok()?.split(';').next())
        .find(|pair| pair.starts_with("mb_desktop="))
        .expect("desktop cookie")
        .to_string();
    let created = client
        .post(format!("{origin}/vaults/new"))
        .header(reqwest::header::COOKIE, &desktop)
        .header(reqwest::header::ORIGIN, &origin)
        .form(&[("name", "Journal"), ("slug", "journal")])
        .send()
        .await
        .expect("create vault");
    assert!(created.status().is_redirection());
    std::fs::write(
        paths.notes_home.join("journal/notes/diary.md"),
        "# Diary\n\nprivate-e34-marker\n",
    )
    .expect("note");

    let probes = [
        "/",
        "/api/v1/vaults",
        "/api/v1/vaults/journal/notes",
        "/v/journal/diary",
        "/api/v1/sync",
        "/assets/index.js",
    ];
    let rebound = format!("attacker.example:{}", server.port());
    let mut bodies = std::collections::BTreeSet::new();
    for path in probes {
        let attempts = [
            client.get(format!("{origin}{path}")),
            client
                .get(format!("{origin}{path}"))
                .header(reqwest::header::COOKIE, &desktop)
                .header(reqwest::header::HOST, &rebound),
            client
                .get(format!("{origin}{path}"))
                .header(reqwest::header::COOKIE, &desktop)
                .header(reqwest::header::ORIGIN, "https://attacker.example"),
            client.get(format!("{origin}{path}")).header(
                reqwest::header::COOKIE,
                "mb_desktop=0000000000000000000000000000000000000000000000000000000000000000",
            ),
        ];
        for attempt in attempts {
            let response = attempt.send().await.expect("probe");
            assert_eq!(response.status(), reqwest::StatusCode::FORBIDDEN, "{path}");
            let body = response.text().await.expect("body");
            assert!(!body.contains("private-e34-marker") && !body.contains("Diary"));
            bodies.insert(body);
        }
    }
    let replayed = client
        .get(server.launch_url())
        .send()
        .await
        .expect("replayed launch");
    assert_eq!(replayed.status(), reqwest::StatusCode::FORBIDDEN);
    bodies.insert(replayed.text().await.expect("body"));
    assert_eq!(bodies.len(), 1, "every refusal is the same answer");

    // The positive control: the launched window does read the note, so the refusals above
    // are the guard's and not a vault that serves nothing.
    let window = client
        .get(format!("{origin}/v/journal/diary"))
        .header(reqwest::header::COOKIE, &desktop)
        .send()
        .await
        .expect("window read");
    assert_eq!(window.status(), reqwest::StatusCode::OK);
    assert!(
        window
            .text()
            .await
            .expect("body")
            .contains("private-e34-marker")
    );
    server.stop().expect("stop");
}

/// E36: a device token reads exactly what its user reads — another user's private note is as
/// absent for it as for its user's own browser — and an administrator's device administers
/// nothing.
#[tokio::test]
async fn e36_a_device_reads_what_its_user_reads_and_administers_nothing() {
    use mb_server::http::{AppState, router};
    let dir = TempDir::new("e36");
    let make = |slug: &str, policy: &str, text: &str| {
        let root = dir.path().join(slug);
        std::fs::create_dir_all(root.join("notes")).expect("notes");
        std::fs::write(root.join("access.toml"), policy).expect("policy");
        std::fs::write(root.join("notes/hello.md"), text).expect("note");
        Vault::open(Slug::parse(slug).expect("slug"), slug, root).expect("vault")
    };
    let vaults = vec![
        make(
            "private",
            "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n",
            "# Hello\n\nprivate-e36-marker\n",
        ),
        make(
            "shared",
            "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n[[members]]\nuser = \"bob\"\nrole = \"viewer\"\n",
            "# Hello\n\nshared-e36-marker\n",
        ),
    ];
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth");
    let alice = auth
        .setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: "correct horse battery staple",
        })
        .expect("alice");
    let bob = auth
        .create_user(mb_auth::NewUser {
            username: "bob",
            display_name: "Bob",
            password: "correct horse battery staple",
        })
        .expect("bob");
    let verifier = "v".repeat(43);
    let redirect = "http://127.0.0.1:4000/desktop/connect/callback";
    let mut grant = |user_id| {
        let code = auth
            .approve_device(mb_auth::DeviceApproval {
                user_id,
                device_name: "Laptop",
                redirect_uri: redirect,
                code_challenge: &mb_auth::pkce_challenge(&verifier),
            })
            .expect("approve");
        auth.exchange_device_code(&code, &verifier, redirect)
            .expect("exchange")
            .expect("grant")
            .token
            .expose_secret()
            .to_string()
    };
    let alice_device = grant(alice.id);
    let bob_device = grant(bob.id);
    let state = AppState::authenticated(vaults, auth)
        .expect("state")
        .with_vault_management(dir.path().join("server.toml"), false)
        .expect("management");
    let state = std::sync::Arc::new(state);
    let errors = state.maintain_index(&mb_server::watch::Changes::All);
    assert!(errors.is_empty(), "{errors:?}");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let origin = format!("http://{}", listener.local_addr().expect("addr"));
    let app = router(std::sync::Arc::clone(&state));
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
    });
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("client");
    let read = |token: &str, path: &str| {
        client
            .get(format!("{origin}{path}"))
            .bearer_auth(token.to_string())
            .send()
    };

    for path in [
        "/v/private/hello",
        "/v/private/",
        "/api/v1/vaults/private/notes",
    ] {
        let response = read(&bob_device, path).await.expect("probe");
        let status = response.status();
        let body = response.text().await.expect("body");
        assert!(!status.is_success(), "{path} answered {status}");
        assert!(!body.contains("private-e36-marker"), "{path}");
    }
    let vaults = read(&bob_device, "/api/v1/vaults")
        .await
        .expect("vaults")
        .text()
        .await
        .expect("body");
    assert!(vaults.contains("shared") && !vaults.contains("private"));
    // The positive control: the same device does read what its user may.
    let shared = read(&bob_device, "/v/shared/hello")
        .await
        .expect("shared")
        .text()
        .await
        .expect("body");
    assert!(shared.contains("shared-e36-marker"));

    let planted = client
        .post(format!("{origin}/vaults/new"))
        .bearer_auth(&alice_device)
        .header(reqwest::header::ORIGIN, &origin)
        .form(&[("name", "Planted"), ("slug", "planted")])
        .send()
        .await
        .expect("create vault");
    assert!(!planted.status().is_success() && !planted.status().is_redirection());
    assert!(!dir.path().join("vaults/planted").exists());
    server.abort();
}

/// E36 for what a workspace keeps per user (§7.6.10): a device's bookmarks, saved layout and
/// share links are its user's, behind the same filter as that user's browser. The app needs
/// them to work in a server vault; none of them may reach a vault, note or link its user
/// cannot.
#[tokio::test]
async fn e36_a_devices_bookmarks_layout_and_shares_are_its_users_and_filtered_like_them() {
    use mb_server::http::{AppState, router};
    let dir = TempDir::new("e36-workspace");
    let make = |slug: &str, policy: &str| {
        let root = dir.path().join(slug);
        std::fs::create_dir_all(root.join("notes")).expect("notes");
        std::fs::write(root.join("access.toml"), policy).expect("policy");
        std::fs::write(root.join("notes/hello.md"), "# Hello\n").expect("note");
        Vault::open(Slug::parse(slug).expect("slug"), slug, root).expect("vault")
    };
    let vaults = vec![
        make(
            "private",
            "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n",
        ),
        make(
            "shared",
            "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n[[members]]\nuser = \"bob\"\nrole = \"viewer\"\n",
        ),
    ];
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth");
    let alice = auth
        .setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: "correct horse battery staple",
        })
        .expect("alice");
    let bob = auth
        .create_user(mb_auth::NewUser {
            username: "bob",
            display_name: "Bob",
            password: "correct horse battery staple",
        })
        .expect("bob");
    let verifier = "v".repeat(43);
    let redirect = "http://127.0.0.1:4000/desktop/connect/callback";
    let mut grant = |user_id| {
        let code = auth
            .approve_device(mb_auth::DeviceApproval {
                user_id,
                device_name: "Laptop",
                redirect_uri: redirect,
                code_challenge: &mb_auth::pkce_challenge(&verifier),
            })
            .expect("approve");
        auth.exchange_device_code(&code, &verifier, redirect)
            .expect("exchange")
            .expect("grant")
            .token
            .expose_secret()
            .to_string()
    };
    let alice_device = grant(alice.id);
    let bob_device = grant(bob.id);
    let state = AppState::authenticated(vaults, auth)
        .expect("state")
        .with_data_dir(dir.path().join("data"));
    let state = std::sync::Arc::new(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let origin = format!("http://{}", listener.local_addr().expect("addr"));
    let app = router(std::sync::Arc::clone(&state));
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
    });
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("client");
    let send = |method: reqwest::Method, token: &str, path: &str, body: &str| {
        client
            .request(method, format!("{origin}{path}"))
            .bearer_auth(token.to_string())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body.to_string())
            .send()
    };
    use reqwest::Method;

    // The positive controls: Alice's device keeps her bookmarks, layout and links.
    let routes = [
        ("/api/v1/vaults/private/bookmarks", "[\"hello.md\"]"),
        (
            "/api/v1/vaults/private/workspace/laptop",
            "{\"tabs\":[\"hello.md\"]}",
        ),
    ];
    for (route, body) in routes {
        let saved = send(Method::PUT, &alice_device, route, body)
            .await
            .expect("save");
        assert!(saved.status().is_success(), "{route}: {}", saved.status());
        let loaded = send(Method::GET, &alice_device, route, "")
            .await
            .expect("load");
        assert!(loaded.status().is_success(), "{route}");
        assert!(
            loaded.text().await.expect("body").contains("hello.md"),
            "{route}"
        );
    }
    let created = send(
        Method::POST,
        &alice_device,
        "/api/v1/vaults/private/shares",
        "{\"note\":\"hello.md\",\"never_expires\":true}",
    )
    .await
    .expect("share");
    assert!(created.status().is_success(), "{}", created.status());
    let listed = send(
        Method::GET,
        &alice_device,
        "/api/v1/vaults/private/shares",
        "",
    )
    .await
    .expect("links")
    .text()
    .await
    .expect("body");
    assert!(listed.contains("hello.md"), "{listed}");

    // Bob's device reaches none of it in a vault he is not in, and shares nothing he only
    // views.
    for (method, route, body) in [
        (Method::GET, "/api/v1/vaults/private/bookmarks", ""),
        (
            Method::PUT,
            "/api/v1/vaults/private/bookmarks",
            "[\"hello.md\"]",
        ),
        (Method::GET, "/api/v1/vaults/private/workspace/laptop", ""),
        (Method::PUT, "/api/v1/vaults/private/workspace/laptop", "{}"),
        (Method::GET, "/api/v1/vaults/private/shares", ""),
        (
            Method::POST,
            "/api/v1/vaults/private/shares",
            "{\"note\":\"hello.md\",\"never_expires\":true}",
        ),
        (
            Method::POST,
            "/api/v1/vaults/shared/shares",
            "{\"note\":\"hello.md\",\"never_expires\":true}",
        ),
    ] {
        let response = send(method.clone(), &bob_device, route, body)
            .await
            .expect("probe");
        let status = response.status();
        let text = response.text().await.expect("body");
        assert!(!status.is_success(), "{method} {route} answered {status}");
        assert!(!text.contains("hello.md"), "{method} {route}: {text}");
    }
    // Alice's layout is not Bob's, even in a vault they share.
    let bobs = send(
        Method::GET,
        &bob_device,
        "/api/v1/vaults/shared/workspace/laptop",
        "",
    )
    .await
    .expect("bob layout");
    assert_eq!(bobs.status(), reqwest::StatusCode::NO_CONTENT);
    server.abort();
}

/// E36 on the sync path (§7.6.9): a device token opens the sync socket as its user, reads
/// only what that user reads, cannot write where the user may only view, and is
/// re-authenticated per frame, so a revocation lands on the very next frame.
#[tokio::test]
async fn e36_a_device_syncs_only_what_its_user_reads_and_dies_with_its_revocation() {
    use futures_util::{SinkExt, StreamExt};
    use mb_server::http::{AppState, router};
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::protocol::Message;

    let dir = TempDir::new("e36-sync");
    let make = |slug: &str, policy: &str| {
        let root = dir.path().join(slug);
        std::fs::create_dir_all(root.join("notes")).expect("notes");
        std::fs::write(root.join("access.toml"), policy).expect("policy");
        std::fs::write(root.join("notes/hello.md"), "# Hello\n\ne36-sync-marker\n").expect("note");
        Vault::open(Slug::parse(slug).expect("slug"), slug, root).expect("vault")
    };
    let vaults = vec![
        make(
            "private",
            "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n",
        ),
        make(
            "shared",
            "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n[[members]]\nuser = \"bob\"\nrole = \"viewer\"\n",
        ),
    ];
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth");
    auth.setup_first_user(mb_auth::NewUser {
        username: "alice",
        display_name: "Alice",
        password: "correct horse battery staple",
    })
    .expect("alice");
    let bob = auth
        .create_user(mb_auth::NewUser {
            username: "bob",
            display_name: "Bob",
            password: "correct horse battery staple",
        })
        .expect("bob");
    let verifier = "v".repeat(43);
    let redirect = "http://127.0.0.1:4000/desktop/connect/callback";
    let code = auth
        .approve_device(mb_auth::DeviceApproval {
            user_id: bob.id,
            device_name: "Laptop",
            redirect_uri: redirect,
            code_challenge: &mb_auth::pkce_challenge(&verifier),
        })
        .expect("approve");
    let token = auth
        .exchange_device_code(&code, &verifier, redirect)
        .expect("exchange")
        .expect("grant")
        .token
        .expose_secret()
        .to_string();
    let state = std::sync::Arc::new(AppState::authenticated(vaults, auth).expect("state"));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let address = listener.local_addr().expect("addr");
    let app = router(std::sync::Arc::clone(&state));
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
    });
    let mut request = format!("ws://{address}/api/v1/sync")
        .into_client_request()
        .expect("request");
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {token}").parse().expect("header"),
    );
    let (mut socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .expect("a device token opens the sync socket");
    let schema = mb_server::sync::current_schema_version().expect("schema");
    let subscribe = |vault: &str| {
        Message::Text(
            serde_json::json!({"type":"subscribe","vault":vault,"note":"hello.md","schema_version":schema})
                .to_string()
                .into(),
        )
    };
    // Readable: admitted, then the full state arrives.
    socket.send(subscribe("shared")).await.expect("send");
    let admitted = tokio::time::timeout(std::time::Duration::from_secs(5), socket.next())
        .await
        .expect("reply")
        .expect("open")
        .expect("frame");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(admitted.to_text().expect("text")).expect("json")
            ["type"],
        "admitted"
    );
    let reply = tokio::time::timeout(std::time::Duration::from_secs(5), socket.next())
        .await
        .expect("reply")
        .expect("open")
        .expect("frame");
    let Message::Binary(state_frame) = reply else {
        panic!("expected the shared note's state, got {reply:?}");
    };
    assert_eq!(state_frame.first(), Some(&0x01));

    // Unreadable: refused exactly as a note that does not exist.
    socket.send(subscribe("private")).await.expect("send");
    let reply = tokio::time::timeout(std::time::Duration::from_secs(5), socket.next())
        .await
        .expect("reply")
        .expect("open")
        .expect("frame");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(reply.to_text().expect("text")).expect("json")["code"],
        "not_found"
    );

    // View-only: an update is refused.
    let mut frame = vec![0x02];
    frame.extend_from_slice(&6u16.to_be_bytes());
    frame.extend_from_slice(&8u16.to_be_bytes());
    frame.extend_from_slice(b"sharedhello.md");
    frame.extend_from_slice(&[0, 0]);
    socket
        .send(Message::Binary(frame.into()))
        .await
        .expect("send");
    let reply = tokio::time::timeout(std::time::Duration::from_secs(5), socket.next())
        .await
        .expect("reply")
        .expect("open")
        .expect("frame");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(reply.to_text().expect("text")).expect("json")["code"],
        "read_only"
    );

    // Revoked while the socket stays open: the next frame is denied.
    let revoked = reqwest::Client::new()
        .delete(format!("http://{address}/api/v1/devices/self"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("revoke");
    assert!(revoked.status().is_success());
    socket.send(subscribe("shared")).await.expect("send");
    let reply = tokio::time::timeout(std::time::Duration::from_secs(5), socket.next())
        .await
        .expect("reply")
        .expect("open")
        .expect("frame");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(reply.to_text().expect("text")).expect("json")["code"],
        "not_found",
        "a device token is re-authenticated per frame"
    );
    server.abort();
}

/// E37 (§7.6.10): the desktop app forwards only a registered server vault's routes, only
/// with the device token, and never its own cookies; upstream's answer comes back as is.
#[tokio::test]
async fn e37_forwarding_carries_only_the_device_token_and_only_server_vault_routes() {
    use mb_server::desktop::{
        DesktopHost, DesktopIdentity, DesktopPaths, DesktopServer, MemorySecrets, RecordingBrowser,
        SecretStore,
    };
    use mb_server::http::{AppState, router};
    use std::sync::{Arc, Mutex};

    let dir = TempDir::new("e37");
    let make = |slug: &str, owner: &str| {
        let root = dir.path().join("server").join(slug);
        std::fs::create_dir_all(root.join("notes")).expect("notes");
        std::fs::write(
            root.join("access.toml"),
            format!("[[members]]\nuser = \"{owner}\"\nrole = \"owner\"\n"),
        )
        .expect("policy");
        std::fs::write(root.join("notes/Hello.md"), "# Hello\n\ne37-marker\n").expect("note");
        Vault::open(Slug::parse(slug).expect("slug"), slug, root).expect("vault")
    };
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth");
    let alice = auth
        .setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: "correct horse battery staple",
        })
        .expect("alice");
    auth.create_user(mb_auth::NewUser {
        username: "bob",
        display_name: "Bob",
        password: "correct horse battery staple",
    })
    .expect("bob");
    let verifier = "v".repeat(43);
    let redirect = "http://127.0.0.1:4000/desktop/connect/callback";
    let code = auth
        .approve_device(mb_auth::DeviceApproval {
            user_id: alice.id,
            device_name: "Laptop",
            redirect_uri: redirect,
            code_challenge: &mb_auth::pkce_challenge(&verifier),
        })
        .expect("approve");
    let token = auth
        .exchange_device_code(&code, &verifier, redirect)
        .expect("exchange")
        .expect("grant")
        .token
        .expose_secret()
        .to_string();
    let server = Arc::new(
        AppState::authenticated(vec![make("work", "alice"), make("secret", "bob")], auth)
            .expect("server"),
    );
    let _ = server.maintain_index(&mb_server::watch::Changes::All);
    let seen: Arc<Mutex<Vec<(String, axum::http::HeaderMap)>>> = Arc::default();
    let record = Arc::clone(&seen);
    let app = router(server).layer(axum::middleware::from_fn(
        move |request: axum::extract::Request, next: axum::middleware::Next| {
            let record = Arc::clone(&record);
            async move {
                if let Ok(mut seen) = record.lock() {
                    seen.push((request.uri().path().to_string(), request.headers().clone()));
                }
                next.run(request).await
            }
        },
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let origin = format!("http://{}", listener.local_addr().expect("addr"));
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
    });

    let paths = DesktopPaths {
        app_data: dir.path().join("app"),
        notes_home: dir.path().join("home"),
        web_root: dir.path().join("web"),
    };
    std::fs::create_dir_all(&paths.app_data).expect("app data");
    std::fs::write(
        paths.app_data.join("desktop.toml"),
        format!(
            "[server]\norigin = \"{origin}\"\nusername = \"alice\"\ndisplay_name = \"Alice\"\ndevice_id = 1\n"
        ),
    )
    .expect("settings");
    let secrets = Arc::new(MemorySecrets::default());
    secrets.set(&origin, &token).expect("token");
    let desktop = DesktopServer::start(
        &paths,
        &DesktopIdentity {
            display_name: "Jo".into(),
            device_name: "Laptop".into(),
        },
        DesktopHost {
            secrets,
            browser: Arc::new(RecordingBrowser::default()),
        },
    )
    .expect("desktop");
    let local = format!("http://127.0.0.1:{}", desktop.port());
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("client");
    let launched = client
        .get(desktop.launch_url())
        .send()
        .await
        .expect("launch");
    let cookie = launched
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok()?.split(';').next())
        .find(|pair| pair.starts_with("mb_desktop="))
        .expect("desktop cookie")
        .to_string();
    let get = |path: &str| {
        client
            .get(format!("{local}{path}"))
            .header(reqwest::header::COOKIE, &cookie)
            .send()
    };
    let created = client
        .post(format!("{local}/vaults/new"))
        .header(reqwest::header::COOKIE, &cookie)
        .header(reqwest::header::ORIGIN, &local)
        .form(&[("name", "Mine"), ("slug", "mine")])
        .send()
        .await
        .expect("local vault");
    assert!(created.status().is_redirection());
    let mut registered = false;
    for _ in 0..100 {
        let listed = get("/api/v1/vaults")
            .await
            .expect("vaults")
            .text()
            .await
            .expect("body");
        if listed.contains("\"work\"") {
            registered = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(registered, "the server vault was never registered");
    assert!(
        !get("/api/v1/vaults")
            .await
            .expect("vaults")
            .text()
            .await
            .expect("body")
            .contains("secret"),
        "a vault the user cannot read upstream must not appear"
    );

    // Forwarded, with the device token and nothing of the window's.
    let notes = get("/api/v1/vaults/work/notes")
        .await
        .expect("notes")
        .text()
        .await
        .expect("body");
    assert!(notes.contains("Hello.md"), "{notes}");
    // Upstream's own denial comes back unchanged.
    let denied = get("/api/v1/vaults/work/backlinks/Nowhere")
        .await
        .expect("denied");
    assert_eq!(denied.status(), reqwest::StatusCode::NOT_FOUND);
    // Not forwarded: a local vault, and a vault that is not a registered server vault.
    drop(get("/api/v1/vaults/mine/notes").await.expect("local"));
    let secret = get("/api/v1/vaults/secret/notes").await.expect("secret");
    assert!(!secret.text().await.expect("body").contains("e37-marker"));

    let seen = seen.lock().expect("seen").clone();
    let forwarded: Vec<&(String, axum::http::HeaderMap)> = seen
        .iter()
        .filter(|(path, _)| path == "/api/v1/vaults/work/notes")
        .collect();
    assert!(!forwarded.is_empty(), "the notes request reached upstream");
    for (path, headers) in &seen {
        assert!(
            headers.get("cookie").is_none(),
            "{path} carried a cookie upstream"
        );
        assert!(
            !path.contains("/vaults/mine/"),
            "a local vault's route was forwarded: {path}"
        );
        assert!(
            !path.contains("/vaults/secret/"),
            "an unregistered vault was forwarded: {path}"
        );
    }
    for (_, headers) in forwarded {
        assert_eq!(
            headers.get("authorization").and_then(|v| v.to_str().ok()),
            Some(format!("Bearer {token}").as_str())
        );
    }
    desktop.stop().expect("stop");
}

/// The vault picker's note count (§6.5): a count is a claim about how many notes exist, so it
/// counts only what the viewer can read — the same argument as E16's tag counts.
#[tokio::test]
async fn the_vault_picker_counts_only_notes_the_viewer_can_read() {
    use mb_server::http::{AppState, router};
    let dir = TempDir::new("leak-picker");
    dir.write("Open.md", "# Open\n");
    dir.write("Private/Salary.md", "# Salary\n");
    dir.write("Private/Bonus.md", "# Bonus\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n[[members]]\nuser = \"bob\"\nrole = \"viewer\"\n\n\
         [[rules]]\npath = \"Private\"\ngrant = { bob = \"none\" }\n",
    );
    let vault = Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault");
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth");
    auth.setup_first_user(mb_auth::NewUser {
        username: "alice",
        display_name: "Alice",
        password: "correct horse battery staple",
    })
    .expect("alice");
    let bob = auth
        .create_user(mb_auth::NewUser {
            username: "bob",
            display_name: "Bob",
            password: "correct horse battery staple",
        })
        .expect("bob");
    let token = auth.create_session(bob.id, 4_102_444_800).expect("session");
    let cookie = format!(
        "mb_session={}",
        auth.signed_session_cookie(&token).expect("cookie")
    );
    let app = router(std::sync::Arc::new(
        AppState::authenticated(vec![vault], auth).expect("state"),
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let origin = format!("http://{}", listener.local_addr().expect("addr"));
    let server = tokio::spawn(async move { axum::serve(listener, app).await });
    let page = reqwest::Client::new()
        .get(format!("{origin}/"))
        .header(reqwest::header::COOKIE, cookie)
        .send()
        .await
        .expect("picker")
        .text()
        .await
        .expect("body");
    assert!(page.contains("1 note<"), "{page}");
    assert!(!page.contains("3 notes"), "{page}");
    server.abort();
}

#[path = "support/oidc_provider.rs"]
mod oidc_provider;

/// E38 (§6.8.2): every way a provider sign-in can be forged or stale ends without a session,
/// and an unverified email never reaches an existing account's vaults.
#[tokio::test]
async fn e38_a_forged_stale_or_mismatched_provider_sign_in_yields_no_session() {
    use mb_server::http::{AppState, router};
    use oidc_provider::{Provider, finish, start};

    let provider = Provider::start().await;
    let dir = TempDir::new("e38");
    dir.write("Secret.md", "# Secret\n\ne38-marker\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n",
    );
    let vault = Vault::open(Slug::parse("home").expect("slug"), "Home", dir.path()).expect("vault");
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth");
    let alice = auth
        .setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: "correct horse battery staple",
        })
        .expect("alice");
    auth.set_email(alice.id, Some("alice@example.com"))
        .expect("email");
    let state = std::sync::Arc::new(
        AppState::authenticated(vec![vault], auth)
            .expect("state")
            .with_oidc(provider.config(true))
            .expect("oidc"),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let origin = format!("http://{}", listener.local_addr().expect("addr"));
    let app = router(state);
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
    });

    // Each case breaks exactly one thing about an otherwise valid sign-in as alice.
    let cases: Vec<(&str, Box<dyn Fn(&mut serde_json::Value)>)> = vec![
        (
            "wrong nonce",
            Box::new(|c| c["nonce"] = "not-the-nonce".into()),
        ),
        (
            "wrong audience",
            Box::new(|c| c["aud"] = "someone-else".into()),
        ),
        (
            "wrong authorized party",
            Box::new(|c| c["azp"] = "someone-else".into()),
        ),
        (
            "wrong issuer",
            Box::new(|c| c["iss"] = "https://evil.example".into()),
        ),
        ("expired", Box::new(|c| c["exp"] = 1_000_000_000_i64.into())),
    ];
    for (n, (why, break_it)) in cases.iter().enumerate() {
        let attempt = start(&origin).await;
        let mut claims = provider.claims(&attempt.nonce, "sub-alice", "alice@example.com", true);
        break_it(&mut claims);
        let code = format!("code-{n}");
        provider.issue(&code, &attempt.challenge, claims);
        assert!(
            finish(&origin, &attempt, &code, &attempt.cookie)
                .await
                .is_none(),
            "{why} produced a session"
        );
    }

    // A state that is not this browser's, and a replay of a used one.
    let attempt = start(&origin).await;
    provider.issue(
        "forged",
        &attempt.challenge,
        provider.claims(&attempt.nonce, "sub-alice", "alice@example.com", true),
    );
    assert!(
        finish(&origin, &attempt, "forged", "mb_oidc=someone-elses-state")
            .await
            .is_none(),
        "forged state"
    );
    let attempt = start(&origin).await;
    provider.issue(
        "once",
        &attempt.challenge,
        provider.claims(&attempt.nonce, "sub-alice", "alice@example.com", true),
    );
    assert!(
        finish(&origin, &attempt, "once", &attempt.cookie)
            .await
            .is_some(),
        "the valid sign-in"
    );
    provider.issue(
        "once",
        &attempt.challenge,
        provider.claims(&attempt.nonce, "sub-alice", "alice@example.com", true),
    );
    assert!(
        finish(&origin, &attempt, "once", &attempt.cookie)
            .await
            .is_none(),
        "replayed state"
    );

    // An unverified email signs in, but to a new account that sees nothing of alice's.
    let attempt = start(&origin).await;
    provider.issue(
        "unverified",
        &attempt.challenge,
        provider.claims(&attempt.nonce, "sub-mallory", "alice@example.com", false),
    );
    let session = finish(&origin, &attempt, "unverified", &attempt.cookie)
        .await
        .expect("a session for a new account");
    let client = reqwest::Client::new();
    for path in ["/", "/v/home/Secret", "/api/v1/vaults/home/notes"] {
        let body = client
            .get(format!("{origin}{path}"))
            .header(reqwest::header::COOKIE, &session)
            .send()
            .await
            .expect("probe")
            .text()
            .await
            .expect("body");
        assert!(
            !body.contains("e38-marker") && !body.contains("Secret.md"),
            "{path}: {body}"
        );
    }
    server.abort();
}

/// M20b (§6.8.2): a provider group's grant reaches exactly its members — notes, listings,
/// search — including its explicit `none`, and lapses at the member's next sign-in without
/// the group.
#[tokio::test]
async fn e38_provider_groups_grant_exactly_their_access_and_lapse_at_the_next_sign_in() {
    use mb_server::http::{AppState, router};
    use oidc_provider::{Provider, finish, start};

    let provider = Provider::start().await;
    let dir = TempDir::new("e38-groups");
    dir.write("Shared.md", "# Shared\n\ngroup-shared-marker\n");
    dir.write("Private/Salary.md", "# Salary\n\ngroup-private-marker\n");
    dir.write(
        "access.toml",
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n\n\
         [[members]]\nuser = \"group:family\"\nrole = \"viewer\"\n\n\
         [[rules]]\npath = \"Private\"\ngrant = { \"group:family\" = \"none\" }\n",
    );
    let vault = Vault::open(Slug::parse("home").expect("slug"), "Home", dir.path()).expect("vault");
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth");
    auth.setup_first_user(mb_auth::NewUser {
        username: "alice",
        display_name: "Alice",
        password: "correct horse battery staple",
    })
    .expect("alice");
    let state = std::sync::Arc::new(
        AppState::authenticated(vec![vault], auth)
            .expect("state")
            .with_oidc(provider.config(true))
            .expect("oidc"),
    );
    let errors = state.maintain_index(&mb_server::watch::Changes::All);
    assert!(errors.is_empty(), "{errors:?}");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let origin = format!("http://{}", listener.local_addr().expect("addr"));
    let app = router(std::sync::Arc::clone(&state));
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
    });

    let sign_in = |sub: &'static str, groups: Vec<&'static str>| {
        let provider = &provider;
        let origin = origin.clone();
        async move {
            let attempt = start(&origin).await;
            let mut claims =
                provider.claims(&attempt.nonce, sub, &format!("{sub}@example.com"), true);
            claims["groups"] = serde_json::json!(groups);
            let code = format!("{sub}-{}", attempt.nonce);
            provider.issue(&code, &attempt.challenge, claims);
            finish(&origin, &attempt, &code, &attempt.cookie)
                .await
                .expect("a session")
        }
    };
    let client = reqwest::Client::new();
    let read = |session: String, path: &'static str| {
        let client = client.clone();
        let origin = origin.clone();
        async move {
            client
                .get(format!("{origin}{path}"))
                .header(reqwest::header::COOKIE, session)
                .send()
                .await
                .expect("probe")
                .text()
                .await
                .expect("body")
        }
    };

    // In the group: the vault-wide grant, minus the group's explicit `none`.
    let bob = sign_in("bob", vec!["family"]).await;
    assert!(
        read(bob.clone(), "/v/home/Shared")
            .await
            .contains("group-shared-marker")
    );
    for path in [
        "/v/home/Private/Salary",
        "/api/v1/vaults/home/notes",
        "/api/v1/vaults/home/search?q=group",
    ] {
        let body = read(bob.clone(), path).await;
        assert!(
            !body.contains("group-private-marker") && !body.contains("Salary"),
            "{path}: {body}"
        );
    }
    assert!(
        read(bob.clone(), "/api/v1/vaults/home/notes")
            .await
            .contains("Shared.md")
    );

    // Not in the group: nothing at all.
    let carol = sign_in("carol", vec!["other"]).await;
    for path in ["/", "/v/home/Shared", "/api/v1/vaults/home/notes"] {
        let body = read(carol.clone(), path).await;
        assert!(
            !body.contains("group-shared-marker") && !body.contains("Shared.md"),
            "{path}: {body}"
        );
    }

    // Out of the group at the next sign-in: the old session's access lapses too, because
    // access is resolved from the account's current groups on every request.
    let bob_again = sign_in("bob", vec![]).await;
    for session in [bob, bob_again] {
        let body = read(session, "/v/home/Shared").await;
        assert!(!body.contains("group-shared-marker"), "{body}");
    }
    server.abort();
}

/// Starts a server with vault `work` owned by alice holding `marker`, records every request
/// it receives, and issues alice a device token for it.
async fn e37_recorded_upstream(
    dir: &std::path::Path,
    marker: &str,
) -> (
    String,
    String,
    std::sync::Arc<std::sync::Mutex<Vec<(String, axum::http::HeaderMap)>>>,
) {
    use mb_server::http::{AppState, router};
    use std::sync::{Arc, Mutex};
    let root = dir.join("work");
    std::fs::create_dir_all(root.join("notes")).expect("notes");
    std::fs::write(
        root.join("access.toml"),
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n",
    )
    .expect("policy");
    std::fs::write(
        root.join("notes/Hello.md"),
        format!("# Hello\n\n{marker}\n"),
    )
    .expect("note");
    let vault = Vault::open(Slug::parse("work").expect("slug"), "Work", root).expect("vault");
    let mut auth = mb_auth::AuthDb::open_in_memory().expect("auth");
    let alice = auth
        .setup_first_user(mb_auth::NewUser {
            username: "alice",
            display_name: "Alice",
            password: "correct horse battery staple",
        })
        .expect("alice");
    let verifier = "v".repeat(43);
    let redirect = "http://127.0.0.1:4000/desktop/connect/callback";
    let code = auth
        .approve_device(mb_auth::DeviceApproval {
            user_id: alice.id,
            device_name: "Laptop",
            redirect_uri: redirect,
            code_challenge: &mb_auth::pkce_challenge(&verifier),
        })
        .expect("approve");
    let token = auth
        .exchange_device_code(&code, &verifier, redirect)
        .expect("exchange")
        .expect("grant")
        .token
        .expose_secret()
        .to_string();
    let server = Arc::new(AppState::authenticated(vec![vault], auth).expect("server"));
    let _ = server.maintain_index(&mb_server::watch::Changes::All);
    let seen: Arc<Mutex<Vec<(String, axum::http::HeaderMap)>>> = Arc::default();
    let record = Arc::clone(&seen);
    let app = router(server).layer(axum::middleware::from_fn(
        move |request: axum::extract::Request, next: axum::middleware::Next| {
            let record = Arc::clone(&record);
            async move {
                if let Ok(mut seen) = record.lock() {
                    seen.push((request.uri().path().to_string(), request.headers().clone()));
                }
                next.run(request).await
            }
        },
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let origin = format!("http://{}", listener.local_addr().expect("addr"));
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
    });
    (origin, token, seen)
}

/// E37 with two servers (§7.6.11): each vault's requests reach only the server it came from,
/// carrying only that server's token, and a server signed out of receives nothing more.
#[tokio::test]
async fn e37_two_servers_each_vault_reaches_only_its_own_server_with_its_own_token() {
    use mb_server::desktop::{
        DesktopHost, DesktopIdentity, DesktopPaths, DesktopServer, MemorySecrets, RecordingBrowser,
        SecretStore,
    };
    use std::sync::Arc;

    let dir = TempDir::new("e37-two");
    let (a_origin, a_token, a_seen) = e37_recorded_upstream(&dir.path().join("a"), "from-a").await;
    let (b_origin, b_token, b_seen) = e37_recorded_upstream(&dir.path().join("b"), "from-b").await;
    let paths = DesktopPaths {
        app_data: dir.path().join("app"),
        notes_home: dir.path().join("home"),
        web_root: dir.path().join("web"),
    };
    std::fs::create_dir_all(&paths.app_data).expect("app data");
    std::fs::write(
        paths.app_data.join("desktop.toml"),
        format!(
            "[[servers]]\norigin = \"{a_origin}\"\nusername = \"alice\"\ndisplay_name = \"Alice\"\ndevice_id = 1\n\
             [[servers]]\norigin = \"{b_origin}\"\nusername = \"alice\"\ndisplay_name = \"Alice\"\ndevice_id = 1\n"
        ),
    )
    .expect("settings");
    let secrets = Arc::new(MemorySecrets::default());
    secrets.set(&a_origin, &a_token).expect("token a");
    secrets.set(&b_origin, &b_token).expect("token b");
    let kept_secrets = Arc::clone(&secrets);
    let desktop = DesktopServer::start(
        &paths,
        &DesktopIdentity {
            display_name: "Jo".into(),
            device_name: "Laptop".into(),
        },
        DesktopHost {
            secrets,
            browser: Arc::new(RecordingBrowser::default()),
        },
    )
    .expect("desktop");
    let local = format!("http://127.0.0.1:{}", desktop.port());
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("client");
    let launched = client
        .get(desktop.launch_url())
        .send()
        .await
        .expect("launch");
    let cookie = launched
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok()?.split(';').next())
        .find(|pair| pair.starts_with("mb_desktop="))
        .expect("desktop cookie")
        .to_string();
    let get = |path: String| {
        client
            .get(format!("{local}{path}"))
            .header(reqwest::header::COOKIE, &cookie)
            .send()
    };
    let mut registered = false;
    for _ in 0..100 {
        let listed = get("/api/v1/vaults".into())
            .await
            .expect("vaults")
            .text()
            .await
            .expect("body");
        if listed.contains("\"work\"") && listed.contains("\"work-2\"") {
            registered = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(registered, "both servers' vaults were never registered");
    // Which local address belongs to which server is decided by which pass ran first.
    let settings = std::fs::read_to_string(paths.app_data.join("desktop.toml")).expect("settings");
    let parsed: toml::Value = toml::from_str(&settings).expect("toml");
    let local_of = |origin: &str| {
        parsed["replicas"]
            .as_array()
            .expect("replicas")
            .iter()
            .find(|r| r["origin"].as_str() == Some(origin))
            .and_then(|r| r["local"].as_str())
            .expect("replica")
            .to_string()
    };
    let (a_local, b_local) = (local_of(&a_origin), local_of(&b_origin));
    // Each server's note carries its own marker; a search answers from the server it reaches.
    let read = |slug: String, marker: &'static str| {
        let get = &get;
        async move {
            get(format!("/api/v1/vaults/{slug}/search?q={marker}"))
                .await
                .expect("note")
                .text()
                .await
                .expect("body")
        }
    };
    let hit = |answer: &str| answer.contains("Hello.md");
    assert!(
        hit(&read(a_local.clone(), "from-a").await),
        "A's vault did not reach A"
    );
    assert!(
        !hit(&read(a_local.clone(), "from-b").await),
        "A's vault reached B"
    );
    assert!(
        hit(&read(b_local.clone(), "from-b").await),
        "B's vault did not reach B"
    );
    assert!(
        !hit(&read(b_local.clone(), "from-a").await),
        "B's vault reached A"
    );
    let bearer = |token: &str| format!("Bearer {token}");
    let carried = |seen: &std::sync::Mutex<Vec<(String, axum::http::HeaderMap)>>, token: &str| {
        seen.lock().expect("seen").iter().any(|(_, headers)| {
            headers
                .get(axum::http::header::AUTHORIZATION)
                .is_some_and(|v| v.as_bytes() == bearer(token).as_bytes())
        })
    };
    assert!(
        !carried(&a_seen, &b_token),
        "server A was sent server B's token"
    );
    assert!(
        !carried(&b_seen, &a_token),
        "server B was sent server A's token"
    );
    assert!(carried(&a_seen, &a_token) && carried(&b_seen, &b_token));

    // Sign out of B, keeping its notes: B's vault stays, and is never forwarded again.
    let signed_out = client
        .post(format!("{local}/desktop/disconnect"))
        .header(reqwest::header::COOKIE, &cookie)
        .header(reqwest::header::ORIGIN, &local)
        .form(&[("server", b_origin.as_str()), ("notes", "keep")])
        .send()
        .await
        .expect("sign out");
    assert!(signed_out.status().is_redirection());
    // Only forwarding searches (the background pass never does), so counting searches
    // isolates forwarding from the pass.
    let note_requests = || {
        b_seen
            .lock()
            .expect("seen")
            .iter()
            .filter(|(path, _)| path.ends_with("/search"))
            .count()
    };
    let before = note_requests();
    let after_sign_out = read(b_local.clone(), "from-b").await;
    assert_eq!(
        note_requests(),
        before,
        "a signed-out server's vault was forwarded"
    );
    assert!(!hit(&after_sign_out), "{after_sign_out}");
    // why: the background pass needs a token to contact a server at all.
    assert!(
        kept_secrets.get(&b_origin).expect("store").is_none(),
        "the signed-out server's token is still kept"
    );
    drop(desktop.stop());
}

/// A server vault alice owns and a desktop replica of it keeping everything offline, for
/// E35. Returns the server, the replica and both folders.
struct E35 {
    _dir: TempDir,
    server: std::sync::Arc<mb_server::http::AppState>,
    upstream_root: std::path::PathBuf,
    local: mb_server::http::AppState,
    local_root: std::path::PathBuf,
    config: mb_server::replica::ReplicaConfig,
    upstream: mb_server::replica::upstream::Upstream,
}

async fn e35_replica(notes: &[(&str, &str)]) -> E35 {
    use mb_server::http::{AppState, router};
    use mb_server::replica::pins::{self, PinKind};
    let dir = TempDir::new("e35");
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
            password: "correct horse battery staple",
        })
        .expect("alice");
    let verifier = "v".repeat(43);
    let redirect = "http://127.0.0.1:4000/desktop/connect/callback";
    let code = auth
        .approve_device(mb_auth::DeviceApproval {
            user_id: alice.id,
            device_name: "Laptop",
            redirect_uri: redirect,
            code_challenge: &mb_auth::pkce_challenge(&verifier),
        })
        .expect("approve");
    let token = auth
        .exchange_device_code(&code, &verifier, redirect)
        .expect("exchange")
        .expect("grant")
        .token
        .expose_secret()
        .to_string();
    let server = std::sync::Arc::new(AppState::authenticated(vec![vault], auth).expect("server"));
    let _ = server.maintain_index(&mb_server::watch::Changes::All);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let origin = format!("http://{}", listener.local_addr().expect("addr"));
    let app = router(std::sync::Arc::clone(&server));
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
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
    let config = mb_server::replica::ReplicaConfig {
        local: "work".into(),
        upstream: "work".into(),
        name: "Work".into(),
        origin: origin.clone(),
    };
    let local_root = dir.path().join("home/work");
    mb_server::replica::create_local(&local, &config, &local_root).expect("replica");
    let mut kept = pins::load(&local_root, []).expect("pins");
    kept.set(PinKind::Vault, "", true);
    pins::save(&local_root, &kept).expect("pins");
    let upstream = mb_server::replica::upstream::Upstream::new(&origin, &token).expect("upstream");
    E35 {
        _dir: dir,
        server,
        upstream_root,
        local,
        local_root,
        config,
        upstream,
    }
}

impl E35 {
    async fn pass(&self) -> mb_server::replica::PassReport {
        mb_server::replica::pass(&self.local, &self.config, &self.upstream)
            .await
            .expect("pass")
    }

    fn revoke(&self, policy: &str) {
        std::fs::write(self.upstream_root.join("access.toml"), policy).expect("policy");
        assert!(self.server.reload_access().is_empty());
    }

    fn edit_here(&self, path: &str, text: &str) {
        let file = self.local_root.join("notes").join(path);
        std::fs::write(&file, text).expect("edit");
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(2);
        std::fs::File::options()
            .write(true)
            .open(&file)
            .and_then(|f| f.set_modified(later))
            .expect("touch");
    }
}

/// Every file under `root` whose bytes hold `marker`: notes, sidecars, trash, indexes,
/// title caches and the replica's own state alike.
fn e35_files_holding(root: &std::path::Path, marker: &str) -> Vec<std::path::PathBuf> {
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

/// E35 (§7.6.6, §7.6.7): a note whose access was removed leaves nothing on the device —
/// file, sidecar, trash, index, title or listing — and edits made here to another such note
/// are kept as a recovered note on this device only, never sent upstream without a choice.
#[tokio::test]
async fn e35_a_revoked_note_leaves_no_trace_and_offline_edits_stay_on_this_device() {
    let fx = e35_replica(&[
        ("Private/Plain.md", "# e35-title-plain\n\ne35-body-plain\n"),
        ("Private/Edited.md", "# Edited\n\ne35-body-edited\n"),
        ("Open.md", "# Open\n"),
    ])
    .await;
    fx.pass().await;
    assert!(
        !e35_files_holding(&fx.local_root, "e35-body-plain").is_empty(),
        "control"
    );
    fx.edit_here(
        "Private/Edited.md",
        "# Edited\n\ne35-body-edited\n\ne35-offline-line\n",
    );
    fx.revoke(
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n[[rules]]\npath = \"Private\"\ngrant = { alice = \"none\" }\n",
    );
    fx.pass().await;
    fx.pass().await;
    for marker in ["e35-title-plain", "e35-body-plain"] {
        assert_eq!(
            e35_files_holding(&fx.local_root, marker),
            Vec::<std::path::PathBuf>::new(),
            "{marker}"
        );
    }
    // The recovered note is here, and its text never reached the server.
    assert!(
        std::fs::read_to_string(
            fx.local_root
                .join("notes/Recovered/Edited (offline edits).md")
        )
        .is_ok_and(|text| text.contains("e35-offline-line"))
    );
    assert_eq!(
        e35_files_holding(&fx.upstream_root, "e35-offline-line"),
        Vec::<std::path::PathBuf>::new()
    );
}

/// E35 for a whole vault (§7.6.7 case 4): removed from it, the device keeps nothing of it
/// but the recovered notes — no unedited note, and no listing of the notes it held.
#[tokio::test]
async fn e35_a_vault_the_user_was_removed_from_leaves_only_their_recovered_notes() {
    let fx = e35_replica(&[
        ("Plain.md", "# e35-vault-title\n\ne35-vault-body\n"),
        ("Edited.md", "# Edited\n"),
    ])
    .await;
    fx.pass().await;
    fx.edit_here("Edited.md", "# Edited\n\ne35-vault-offline-line\n");
    fx.revoke("[[members]]\nuser = \"bob\"\nrole = \"owner\"\n");
    let left = mb_server::replica::vault_gone(&fx.local, &fx.config)
        .await
        .expect("settled");
    assert_eq!(left, 1);
    for marker in ["e35-vault-title", "e35-vault-body"] {
        assert_eq!(
            e35_files_holding(&fx.local_root, marker),
            Vec::<std::path::PathBuf>::new(),
            "{marker}"
        );
    }
    assert_eq!(
        e35_files_holding(&fx.upstream_root, "e35-vault-offline-line"),
        Vec::<std::path::PathBuf>::new()
    );
}

/// PNG-signed bytes holding `marker`, and their content address.
fn e35_image(marker: &str) -> (Vec<u8>, String) {
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.extend_from_slice(marker.as_bytes());
    let path = mb_server::media::LocalStore::object_path(&bytes, "png").expect("address");
    (bytes, path)
}

/// E35 and E11 for media on a desktop replica (§7.6.3): a revoked note's image leaves this
/// device with it, and naming an image's address in a note here fetches nothing the user
/// cannot already see — the address is not the permission.
#[tokio::test]
async fn e35_media_follows_the_readable_set_and_its_address_grants_nothing() {
    let (revoked, revoked_path) = e35_image("e35-revoked-image");
    let (hidden, hidden_path) = e35_image("e35-hidden-image");
    let fx = e35_replica(&[
        (
            "Private/Pic.md",
            &format!("# Pic\n\n![p]({revoked_path})\n"),
        ),
        (
            "Secret/Only.md",
            &format!("# Only\n\n![s]({hidden_path})\n"),
        ),
        ("Open.md", "# Open\n"),
    ])
    .await;
    for (bytes, path) in [(&revoked, &revoked_path), (&hidden, &hidden_path)] {
        let file = fx.upstream_root.join(path);
        std::fs::create_dir_all(file.parent().expect("parent")).expect("folder");
        std::fs::write(file, bytes).expect("media");
    }
    // Secret was never this user's; Private is, until it is revoked below.
    fx.revoke(
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n[[rules]]\npath = \"Secret\"\ngrant = { alice = \"none\" }\n",
    );
    fx.pass().await;
    assert!(fx.local_root.join(&revoked_path).exists(), "control");
    fx.edit_here("Open.md", &format!("# Open\n\n![guess]({hidden_path})\n"));
    fx.revoke(
        "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n[[rules]]\npath = \"Secret\"\ngrant = { alice = \"none\" }\n[[rules]]\npath = \"Private\"\ngrant = { alice = \"none\" }\n",
    );
    fx.pass().await;
    fx.pass().await;
    for marker in ["e35-revoked-image", "e35-hidden-image"] {
        assert_eq!(
            e35_files_holding(&fx.local_root, marker),
            Vec::<std::path::PathBuf>::new(),
            "{marker}"
        );
    }
}
