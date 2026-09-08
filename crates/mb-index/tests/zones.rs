//! Persisted ACL zones (`SPEC.md` §14.2).

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

mod support;

use std::collections::BTreeMap;

use mb_core::{Access, Member, NotePath, Role, Rule, Username};
use mb_index::{Index, NoteInput, Stamp};
use mb_search::{Query, Segment};
use support::TempDir;

fn user(name: &str) -> Username {
    Username::parse(name).expect("username")
}

fn rows(path: &std::path::Path) -> Vec<(String, String, String)> {
    let conn = rusqlite::Connection::open(path).expect("open database");
    let mut statement = conn
        .prepare("SELECT zone_id, path_prefix, acl_hash FROM zones ORDER BY path_prefix")
        .expect("prepare");
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows")
}

fn zoned_policy() -> Access {
    let alice = user("alice");
    let bob = user("bob");
    Access::new(
        vec![Member {
            user: alice.clone(),
            role: Role::Viewer,
        }],
        vec![
            Rule {
                path: NotePath::parse("Secret").expect("path"),
                grants: BTreeMap::from([(alice.clone(), Role::None), (bob.clone(), Role::Viewer)]),
            },
            Rule {
                path: NotePath::parse("Secret/Shared").expect("path"),
                grants: BTreeMap::from([(alice, Role::None), (bob, Role::Editor)]),
            },
        ],
    )
    .expect("policy")
}

fn upsert(index: &mut Index, path: &str, markdown: &str, stamp: u128) {
    index
        .upsert(&NoteInput {
            path: path.to_string(),
            markdown: markdown.to_string(),
            stamp: Stamp::from_parts(markdown.len() as u64, stamp),
        })
        .expect("upsert");
}

fn matched_paths(segments: &[mb_index::ClientSegment], query: &str) -> Vec<String> {
    let query = Query::parse(query).expect("query");
    let mut paths = Vec::new();
    for published in segments {
        let segment = Segment::from_bytes(published.bytes.clone()).expect("valid segment");
        paths.extend(
            segment
                .search(&query)
                .expect("search")
                .hits
                .into_iter()
                .map(|hit| hit.note.path),
        );
    }
    paths.sort();
    paths
}

#[test]
fn maximal_acl_zones_are_persisted_in_schema_version_three() {
    let dir = TempDir::new("zones");
    let path = dir.path().join("graph.sqlite");
    let alice = user("alice");
    let bob = user("bob");
    let access = Access::new(
        vec![
            Member {
                user: alice.clone(),
                role: Role::Viewer,
            },
            Member {
                user: bob.clone(),
                role: Role::Editor,
            },
        ],
        vec![
            Rule {
                path: NotePath::parse("Shared").expect("path"),
                grants: BTreeMap::from([(alice.clone(), Role::Viewer)]),
            },
            Rule {
                path: NotePath::parse("Projects").expect("path"),
                grants: BTreeMap::from([(alice.clone(), Role::Editor)]),
            },
            Rule {
                path: NotePath::parse("Projects/Docs").expect("path"),
                grants: BTreeMap::from([(alice.clone(), Role::Editor)]),
            },
            Rule {
                path: NotePath::parse("Projects/Salary.md").expect("path"),
                grants: BTreeMap::from([(alice, Role::None)]),
            },
        ],
    )
    .expect("policy");

    let mut index = Index::open(&path).expect("index");
    assert!(index.replace_zones(&access).expect("replace zones"));
    assert!(!index.replace_zones(&access).expect("same zones"));
    drop(index);

    let persisted = rows(&path);
    let prefixes: Vec<_> = persisted
        .iter()
        .map(|(_, prefix, _)| prefix.as_str())
        .collect();
    assert_eq!(prefixes, ["", "Projects", "Projects/Salary.md"]);
    assert!(
        persisted
            .iter()
            .all(|(id, _, hash)| id.len() == 64 && hash.len() == 64)
    );
}

#[test]
fn a_permission_edit_keeps_the_zone_id_and_changes_the_acl_hash() {
    let dir = TempDir::new("zone-identity");
    let path = dir.path().join("graph.sqlite");
    let alice = user("alice");
    let policy = |role| {
        Access::new(
            vec![Member {
                user: alice.clone(),
                role: Role::Viewer,
            }],
            vec![Rule {
                path: NotePath::parse("Projects").expect("path"),
                grants: BTreeMap::from([(alice.clone(), role)]),
            }],
        )
        .expect("policy")
    };
    let mut index = Index::open(&path).expect("index");
    index
        .replace_zones(&policy(Role::Editor))
        .expect("first policy");
    drop(index);
    let before = rows(&path);

    let mut index = Index::open(&path).expect("reopen");
    index
        .replace_zones(&policy(Role::Owner))
        .expect("second policy");
    drop(index);
    let after = rows(&path);

    assert_eq!(before[1].0, after[1].0);
    assert_ne!(before[1].2, after[1].2);
}

#[test]
fn every_note_is_published_in_exactly_its_deepest_zone() {
    let dir = TempDir::new("zone-segments");
    let path = dir.path().join(".memberberry/index/graph.sqlite");
    let access = zoned_policy();
    let mut index = Index::open(&path).expect("index");
    index.replace_zones(&access).expect("zones");
    upsert(
        &mut index,
        "Welcome.md",
        "---\nid: 019cfb21-75c0-7abc-8def-0123456789ab\ntags: [public/demo]\nicon: :berry:\n---\n\n# Welcome\n\nzoneberry root\n",
        1,
    );
    upsert(
        &mut index,
        "Secret/Plan.md",
        "# Classified Marker\n\nzoneberry private-marker\n",
        2,
    );
    upsert(
        &mut index,
        "Secret/Shared/Brief.md",
        "# Brief\n\nzoneberry shared\n",
        3,
    );
    index.publish().expect("publish");

    let files = std::fs::read_dir(path.with_file_name("zones"))
        .expect("zone directory")
        .collect::<Result<Vec<_>, _>>()
        .expect("zone files");
    assert_eq!(files.len(), 3);
    let mut paths = Vec::new();
    for file in files {
        let segment = Segment::from_bytes(std::fs::read(file.path()).expect("segment bytes"))
            .expect("valid segment");
        paths.extend(
            segment
                .search(&Query::parse("zoneberry").expect("query"))
                .expect("search")
                .hits
                .into_iter()
                .map(|hit| hit.note.path),
        );
    }
    paths.sort();
    assert_eq!(
        paths,
        ["Secret/Plan.md", "Secret/Shared/Brief.md", "Welcome.md"]
    );
}

#[test]
fn e6_client_assembly_contains_every_readable_note_and_no_private_byte() {
    let dir = TempDir::new("client-assembly");
    let path = dir.path().join(".memberberry/index/graph.sqlite");
    let access = zoned_policy();
    let mut index = Index::open(&path).expect("index");
    index.replace_zones(&access).expect("zones");
    upsert(
        &mut index,
        "Welcome.md",
        "---\nid: 019cfb21-75c0-7abc-8def-0123456789ab\ntags: [public/demo]\nicon: :berry:\n---\n\n# Welcome\n\nzoneberry root\n",
        1,
    );
    upsert(
        &mut index,
        "Secret/Plan.md",
        "# Classified Marker\n\nzoneberry private-marker\n",
        2,
    );
    upsert(
        &mut index,
        "Secret/Shared/Brief.md",
        "# Brief\n\nzoneberry shared\n",
        3,
    );
    index.publish().expect("publish");

    let alice = index
        .reader(&access, &user("alice"))
        .expect("alice reader")
        .client_segments();
    assert_eq!(matched_paths(&alice, "zoneberry"), ["Welcome.md"]);
    assert!(alice.iter().all(|segment| {
        !segment
            .bytes
            .windows(b"Classified Marker".len())
            .any(|window| window == b"Classified Marker")
    }));
    let welcome = alice
        .iter()
        .flat_map(|published| {
            Segment::from_bytes(published.bytes.clone())
                .expect("valid segment")
                .search(&Query::parse("title:welcome").expect("query"))
                .expect("search")
                .hits
        })
        .next()
        .expect("welcome hit")
        .note;
    assert_eq!(welcome.tags, ["public/demo"]);
    assert_eq!(welcome.icon.as_deref(), Some(":berry:"));
    assert!(welcome.id.is_some());

    let bob = index
        .reader(&access, &user("bob"))
        .expect("bob reader")
        .client_segments();
    assert_eq!(
        matched_paths(&bob, "zoneberry"),
        ["Secret/Plan.md", "Secret/Shared/Brief.md"]
    );

    let outsider = index
        .reader(&access, &user("mallory"))
        .expect("outsider reader")
        .client_segments();
    assert!(outsider.is_empty());
}

#[test]
fn an_acl_replacement_rebuilds_the_epoch_and_removes_stale_zone_files() {
    let dir = TempDir::new("zone-replacement");
    let path = dir.path().join(".memberberry/index/graph.sqlite");
    let alice = user("alice");
    let initial = Access::new(
        vec![Member {
            user: alice.clone(),
            role: Role::Viewer,
        }],
        Vec::new(),
    )
    .expect("initial policy");
    let restricted = zoned_policy();
    let mut index = Index::open(&path).expect("index");
    index.replace_zones(&initial).expect("initial zones");
    upsert(&mut index, "Welcome.md", "# Welcome\n\nzoneberry root\n", 1);
    upsert(
        &mut index,
        "Secret/Plan.md",
        "# Revoked Canary\n\nzoneberry private\n",
        2,
    );
    index.publish().expect("publish initial epoch");
    assert_eq!(
        matched_paths(
            &index
                .reader(&initial, &alice)
                .expect("initial reader")
                .client_segments(),
            "zoneberry"
        ),
        ["Secret/Plan.md", "Welcome.md"]
    );

    index.replace_zones(&restricted).expect("restricted zones");
    let current = index
        .reader(&restricted, &alice)
        .expect("restricted reader")
        .client_segments();
    assert_eq!(matched_paths(&current, "zoneberry"), ["Welcome.md"]);
    assert!(current.iter().all(|segment| {
        !segment
            .bytes
            .windows(b"Revoked Canary".len())
            .any(|window| window == b"Revoked Canary")
    }));

    let files = std::fs::read_dir(path.with_file_name("zones"))
        .expect("zone directory")
        .collect::<Result<Vec<_>, _>>()
        .expect("zone files");
    assert_eq!(files.len(), 3, "one file per current maximal zone");

    index.replace_zones(&initial).expect("collapse zones");
    let files = std::fs::read_dir(path.with_file_name("zones"))
        .expect("zone directory")
        .collect::<Result<Vec<_>, _>>()
        .expect("zone files");
    assert_eq!(files.len(), 1, "files for retired zones must be removed");
}

#[test]
fn reopening_reassembles_the_persisted_zone_epoch() {
    let dir = TempDir::new("zone-reopen");
    let path = dir.path().join(".memberberry/index/graph.sqlite");
    let access = zoned_policy();
    let alice = user("alice");
    let mut index = Index::open(&path).expect("index");
    index.replace_zones(&access).expect("zones");
    upsert(&mut index, "Welcome.md", "# Welcome\n\nzoneberry root\n", 1);
    index.publish().expect("publish");
    drop(index);

    let mut reopened = Index::open(&path).expect("reopen");
    assert!(!reopened.replace_zones(&access).expect("same policy"));
    let segments = reopened
        .reader(&access, &alice)
        .expect("reader")
        .client_segments();
    assert_eq!(matched_paths(&segments, "zoneberry"), ["Welcome.md"]);
}

#[test]
fn a_malformed_frontmatter_id_falls_back_to_path_identity() {
    let access = zoned_policy();
    let alice = user("alice");
    let mut index = Index::in_memory().expect("index");
    index.replace_zones(&access).expect("zones");
    upsert(
        &mut index,
        "Imported.md",
        "---\nid: not-a-uuid\n---\n\n# Imported\n\nzoneberry\n",
        1,
    );
    index.publish().expect("publish");
    let segments = index
        .reader(&access, &alice)
        .expect("reader")
        .client_segments();
    assert_eq!(matched_paths(&segments, "zoneberry"), ["Imported.md"]);
}
