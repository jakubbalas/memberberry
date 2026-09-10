//! Permission leak suite for the enforcement points implemented so far (`SPEC.md` §22.5).
//!
//! This suite is deliberately organised by enforcement point rather than feature. Adding a
//! content-bearing surface means extending this file before that surface can ship.
//!
//! The wire-level counterparts for E2-E4 live in `tests/websocket.rs`, which drives real
//! sockets; the cases here pin the properties those frames must never violate.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod support;

use mb_core::{Access, Member, Role, Username};
use mb_server::Vault;
use mb_server::repository::AuthorizedVault;
use mb_server::sync::ConnectionId;
use mb_server::vault::Slug;
use support::TempDir;

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
