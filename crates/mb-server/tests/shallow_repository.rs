//! E30 immediate repository metadata, bounds and namespace/ACL regressions.
#![cfg(target_os = "linux")]
#![allow(
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::panic,
    clippy::indexing_slicing
)] // why: fixture-only exact assertions.
#[path = "support/http_safety.rs"]
#[allow(dead_code)]
// why: reuse privilege runner; unrelated HTTP observer helpers are not used here.
mod http_safety;
use mb_core::{Access, Member, NotePath, Role, Rule, Username};
use mb_server::{
    Vault,
    repository::{AuthorizedVault, DirectoryError, validate_directory_token},
    vault::Slug,
};
use std::collections::BTreeMap;
fn user() -> Username {
    Username::parse("alice").expect("user")
}
fn member() -> Access {
    Access::new(
        vec![Member {
            user: user(),
            role: Role::Viewer,
        }],
        vec![],
    )
    .expect("ACL")
}
fn acl(rules: &[(&str, Role)]) -> Access {
    Access::new(
        vec![],
        rules
            .iter()
            .map(|(path, role)| Rule {
                path: NotePath::parse(path).expect("path"),
                grants: BTreeMap::from([(user(), *role)]),
            })
            .collect(),
    )
    .expect("ACL")
}
fn vault(root: &std::path::Path) -> Vault {
    Vault::open(Slug::parse("test").expect("slug"), "Test", root).expect("vault")
}
#[test]
fn literal_sorted_metadata_omits_hidden_unsupported_non_utf8_and_symlinks() {
    use std::os::unix::ffi::OsStringExt;
    let dir = tempfile::tempdir().expect("fixture");
    for name in ["Z", " 日本 %2f ", "A", ".hidden"] {
        std::fs::create_dir(dir.path().join(name)).expect("dir");
    }
    for name in [
        "z.md",
        "a.md",
        " 日本 %.md",
        "hidden.MD",
        "text.txt",
        ".private.md",
    ] {
        std::fs::write(dir.path().join(name), "BODY_CANNOT_APPEAR").expect("file");
    }
    std::fs::write(
        dir.path()
            .join(std::ffi::OsString::from_vec(vec![0xff, b'.', b'm', b'd'])),
        "bad",
    )
    .expect("nonUTF8");
    std::os::unix::fs::symlink("a.md", dir.path().join("link.md")).expect("symlink");
    std::os::unix::fs::symlink("A", dir.path().join("Link")).expect("symlink dir");
    let v = vault(dir.path());
    let access = member();
    let view = AuthorizedVault::new(&v, &access, user());
    let snapshot = view.directory("").expect("shallow");
    assert_eq!(
        snapshot
            .listing()
            .folders
            .iter()
            .map(|e| e.name.as_str())
            .collect::<Vec<_>>(),
        [" 日本 %2f ", "A", "Z"]
    );
    assert_eq!(
        snapshot
            .listing()
            .files
            .iter()
            .map(|e| e.name.as_str())
            .collect::<Vec<_>>(),
        [" 日本 %.md", "a.md", "z.md"]
    );
    assert!(
        !String::from_utf8(snapshot.json().expect("json"))
            .expect("UTF8")
            .contains("BODY")
    );
    assert_eq!(
        view.directory("Link").unwrap_err(),
        DirectoryError::NotFound
    );
    assert_eq!(
        view.directory(" 日本 %2f ")
            .expect("literal folder")
            .listing()
            .path,
        " 日本 %2f "
    );
}
#[test]
fn nested_existing_grants_only_discover_necessary_ancestors_and_denial_is_absorbing() {
    let dir = tempfile::tempdir().expect("fixture");
    for p in ["Shared/Leaf", "Ghost/Private", "Denied/Leaf"] {
        std::fs::create_dir_all(dir.path().join(p)).expect("dir");
    }
    let v = vault(dir.path());
    let access = acl(&[
        ("Shared/Leaf", Role::Viewer),
        ("Ghost/Absent", Role::Viewer),
        ("Denied", Role::None),
        ("Denied/Leaf", Role::Viewer),
    ]);
    let view = AuthorizedVault::new(&v, &access, user());
    assert_eq!(
        view.directory("")
            .expect("root")
            .listing()
            .folders
            .iter()
            .map(|e| e.name.as_str())
            .collect::<Vec<_>>(),
        ["Shared"]
    );
    assert_eq!(
        view.directory("Shared")
            .expect("necessary ancestor")
            .listing()
            .folders[0]
            .path,
        "Shared/Leaf"
    );
    assert_eq!(
        view.directory("Denied").unwrap_err(),
        DirectoryError::NotFound
    );
    assert_eq!(
        view.directory("Ghost").unwrap_err(),
        DirectoryError::NotFound
    );
    std::fs::remove_dir(dir.path().join("Shared/Leaf")).expect("remove exact grant");
    assert_eq!(view.directory("").unwrap_err(), DirectoryError::NotFound);
}
#[test]
fn note_only_grant_verifies_exact_existing_regular_md_target_not_unsupported_target() {
    let dir = tempfile::tempdir().expect("fixture");
    std::fs::create_dir(dir.path().join("Shared")).expect("dir");
    std::fs::write(dir.path().join("Shared/Leaf.md"), "NEVER_READ").expect("note");
    std::fs::write(dir.path().join("Shared/Private.md"), "PRIVATE").expect("note");
    let v = vault(dir.path());
    let access = acl(&[("Shared/Leaf.md", Role::Viewer)]);
    let view = AuthorizedVault::new(&v, &access, user());
    assert_eq!(
        view.directory("Shared")
            .expect("ancestor")
            .listing()
            .files
            .len(),
        1
    );
    let unsupported = acl(&[("Shared/Private.txt", Role::Viewer)]);
    std::fs::write(dir.path().join("Shared/Private.txt"), "exists").expect("file");
    assert_eq!(
        AuthorizedVault::new(&v, &unsupported, user())
            .directory("")
            .unwrap_err(),
        DirectoryError::NotFound
    );
}
#[test]
fn literal_token_limits_are_exact_and_never_repair() {
    for invalid in [
        "/absolute",
        "A//B",
        "A/",
        ".",
        "..",
        "A/../B",
        ".hidden",
        "A\\B",
        "C:drive",
        " ",
        "A\0B",
    ] {
        assert_eq!(
            validate_directory_token(invalid).unwrap_err(),
            DirectoryError::Invalid,
            "{invalid:?}"
        );
    }
    for valid in ["", " 日本 %2e%2e ", "%2f", "%252e%252e", "e\u{301}"] {
        assert_eq!(
            validate_directory_token(valid).expect("literal").as_str(),
            valid
        );
    }
    let at = [
        "a".repeat(255),
        "b".repeat(255),
        "c".repeat(255),
        "d".repeat(255),
        "e".into(),
    ]
    .join("/");
    assert_eq!(at.len(), 1025); // four separators plus one final byte.

    // A valid at-byte-limit token with five components, all <=255.
    let at = [
        "a".repeat(255),
        "b".repeat(255),
        "c".repeat(255),
        "d".repeat(254),
        "e".into(),
    ]
    .join("/");
    assert_eq!(at.len(), 1024);
    assert!(validate_directory_token(&at).is_ok());
    assert_eq!(
        validate_directory_token(&(at + "e")).unwrap_err(),
        DirectoryError::Limit
    );
    assert!(validate_directory_token(&["a"; 16].join("/")).is_ok());
    assert_eq!(
        validate_directory_token(&["a"; 17].join("/")).unwrap_err(),
        DirectoryError::Limit
    );
}
#[test]
fn returned_entry_boundary_refuses_whole_list_at_one_over() {
    let dir = tempfile::tempdir().expect("fixture");
    let v = vault(dir.path());
    let access = member();
    let view = AuthorizedVault::new(&v, &access, user());
    for i in 0..128 {
        std::fs::write(dir.path().join(format!("N{i:03}.md")), "body").expect("note");
    }
    assert_eq!(
        view.directory("").expect("at limit").listing().files.len(),
        128
    );
    std::fs::write(dir.path().join("one-over.md"), "body").expect("note");
    assert_eq!(view.directory("").unwrap_err(), DirectoryError::Limit);
}
#[test]
fn iterator_boundary_has_no_unbudgeted_eof_lookahead() {
    let dir = tempfile::tempdir().expect("fixture");
    let v = vault(dir.path());
    let access = member();
    let view = AuthorizedVault::new(&v, &access, user());
    // rustix Dir includes '.' and '..'. Exactly 4095 returned iterator entries allow
    // the 4096th budgeted call to observe EOF; 4096 entries conservatively refuse.
    for i in 0..4093 {
        std::fs::write(dir.path().join(format!("N{i}.txt")), b"").expect("unsupported");
    }
    assert!(view.directory("").is_ok());
    std::fs::write(dir.path().join("one-more.txt"), b"").expect("unsupported");
    assert_eq!(view.directory("").unwrap_err(), DirectoryError::Limit);
}
#[test]
fn json_escape_budget_refuses_whole_list_without_truncation() {
    let dir = tempfile::tempdir().expect("fixture");
    let prefix = vec!["p".repeat(230); 3].join("/");
    std::fs::create_dir_all(dir.path().join(&prefix)).expect("path");
    let v = vault(dir.path());
    let access = member();
    let view = AuthorizedVault::new(&v, &access, user());
    for i in 0..60 {
        std::fs::write(
            dir.path()
                .join(&prefix)
                .join(format!("{i:03}{}.md", "\"".repeat(200))),
            "",
        )
        .expect("note");
    }
    assert_eq!(view.directory(&prefix).unwrap_err(), DirectoryError::Limit);
}
#[test]
fn exact_json_budget_and_one_byte_over_are_enforced_with_real_entries() {
    let dir = tempfile::tempdir().expect("fixture");
    let mut prefix = ["p".repeat(200), "q".repeat(200), "r".repeat(198)].join("/");
    let mut names = (0..64).map(|i| format!("n{i:03}.md")).collect::<Vec<_>>();
    let size = |prefix: &str, names: &[String]| {
        serde_json::to_vec(&serde_json::json!({"path":prefix,"folders":[],"files":names.iter().map(|n|serde_json::json!({"name":n,"path":format!("{prefix}/{n}")})).collect::<Vec<_>>()})).expect("JSON").len()
    };
    let limit = 64 * 1024;
    if (limit - size(&prefix, &names)) % 2 != 0 {
        prefix.push('r');
    }
    let mut remaining = (limit - size(&prefix, &names)) / 2;
    for name in &mut names {
        let add = remaining.min(255 - name.len());
        name.insert_str(name.len() - 3, &"a".repeat(add));
        remaining -= add;
    }
    assert_eq!(remaining, 0);
    assert_eq!(size(&prefix, &names), limit);
    std::fs::create_dir_all(dir.path().join(&prefix)).expect("path");
    for name in &names {
        std::fs::write(dir.path().join(&prefix).join(name), b"").expect("note");
    }
    let v = vault(dir.path());
    let access = member();
    let view = AuthorizedVault::new(&v, &access, user());
    assert_eq!(
        view.directory(&prefix)
            .expect("exact 64 KiB")
            .json()
            .expect("JSON")
            .len(),
        limit
    );
    let longer = prefix.clone() + "r";
    std::fs::rename(dir.path().join(&prefix), dir.path().join(&longer))
        .expect("one byte longer prefix");
    for name in names.iter_mut().take(32) {
        let old = name.clone();
        name.remove(name.len() - 4);
        std::fs::rename(
            dir.path().join(&longer).join(old),
            dir.path().join(&longer).join(name.as_str()),
        )
        .expect("shorter name");
    }
    assert_eq!(size(&longer, &names), limit + 1);
    assert_eq!(view.directory(&longer).unwrap_err(), DirectoryError::Limit);
}

#[test]
fn stale_acl_and_symlink_or_directory_replacement_invalidate_pinned_snapshot() {
    let dir = tempfile::tempdir().expect("fixture");
    std::fs::create_dir(dir.path().join("Child")).expect("dir");
    let v = vault(dir.path());
    let access = member();
    let view = AuthorizedVault::new(&v, &access, user());
    let snap = view.directory("Child").expect("snapshot");
    assert_eq!(
        snap.revalidate(&AuthorizedVault::new(&v, &Access::default(), user()))
            .unwrap_err(),
        DirectoryError::NotFound
    );
    std::fs::rename(dir.path().join("Child"), dir.path().join("Moved")).expect("move");
    std::os::unix::fs::symlink("Moved", dir.path().join("Child")).expect("replace symlink");
    assert_eq!(
        snap.revalidate(&view).unwrap_err(),
        DirectoryError::NotFound
    );
    std::fs::remove_file(dir.path().join("Child")).expect("unlink");
    std::fs::create_dir(dir.path().join("Child")).expect("replace dir");
    assert_eq!(
        snap.revalidate(&view).unwrap_err(),
        DirectoryError::NotFound
    );
}
#[test]
fn huge_inaccessible_deeper_tree_is_never_opened_and_note_bodies_are_never_read() {
    const NAME: &str =
        "huge_inaccessible_deeper_tree_is_never_opened_and_note_bodies_are_never_read";
    if http_safety::run_unprivileged(NAME) {
        return;
    }
    let dir = tempfile::tempdir().expect("fixture");
    let deep = dir.path().join("Deep");
    std::fs::create_dir(&deep).expect("dir");
    for i in 0..5000 {
        std::fs::write(deep.join(format!("N{i}.md")), b"").expect("deep note");
    }
    let note = dir.path().join("Root.md");
    std::fs::write(&note, "CONTENT_NEVER_READ").expect("note");
    let v = vault(dir.path());
    let access = member();
    let view = AuthorizedVault::new(&v, &access, user());
    use rustix::fs::inotify;
    let trace = inotify::init(inotify::CreateFlags::NONBLOCK).expect("trace");
    inotify::add_watch(
        &trace,
        &deep,
        inotify::WatchFlags::OPEN | inotify::WatchFlags::ACCESS,
    )
    .expect("deep trace");
    inotify::add_watch(
        &trace,
        &note,
        inotify::WatchFlags::OPEN | inotify::WatchFlags::ACCESS,
    )
    .expect("body trace");
    let mut buf = [std::mem::MaybeUninit::uninit(); 4096];
    let mut reader = inotify::Reader::new(&trace, &mut buf);
    // why: an EACCES-only observer would not detect a swallowed denied open. The
    // readable positive case proves no descendant/body I/O before permissions change.
    let readable = view
        .directory("")
        .expect("readable deeper tree stays shallow");
    assert_eq!(readable.listing().folders[0].name, "Deep");
    assert!(
        matches!(reader.next(), Err(rustix::io::Errno::AGAIN)),
        "no readable descendant open or body access"
    );
    let denied = http_safety::FixtureMode::set(&deep, 0o000);
    assert_eq!(
        std::fs::read_dir(&deep).unwrap_err().kind(),
        std::io::ErrorKind::PermissionDenied,
        "genuine EACCES"
    );
    let snap = view
        .directory("")
        .expect("unreadable descendants cannot break shallow listing");
    assert_eq!(snap.listing().folders[0].name, "Deep");
    assert_eq!(snap.listing().files[0].name, "Root.md");
    assert!(
        matches!(reader.next(), Err(rustix::io::Errno::AGAIN)),
        "no descendant open or body access"
    );
    drop(denied);
    std::fs::read_dir(&deep).expect("positive directory observer control");
    std::fs::read(&note).expect("positive body observer control");
    assert!(reader.next().is_ok(), "observer must detect real I/O");
    http_safety::mark_completed(NAME);
}
proptest::proptest! {
    #![proptest_config(proptest::test_runner::Config { cases:32, rng_seed:proptest::test_runner::RngSeed::Fixed(5005), ..Default::default() })]
    #[test]
    fn literal_directory_tokens_preserve_percent_unicode_and_spaces(s in "[a-z]{1,12}") {
        let raw=format!(" 日本 {s} %2e%2e ");
        let parsed=validate_directory_token(&raw).expect("literal");
        proptest::prop_assert_eq!(parsed.as_str(), raw.as_str());
    }
}
