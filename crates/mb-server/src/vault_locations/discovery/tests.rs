//! Real filesystem tests stay inside the module so discovery need not become public.
#![allow(clippy::expect_used, clippy::panic)] // why: assertions and fixture invariants only.

use std::fs;
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::os::unix::process::CommandExt;

use proptest::prelude::*;

use super::*;
use crate::Slug;

fn id() -> VaultLocationId {
    VaultLocationId::parse("projects").expect("id")
}
fn relative(raw: &str) -> RelativeDirectoryPath {
    RelativeDirectoryPath::for_browse(raw).expect("token")
}
fn config(root: &Path) -> ServerConfig {
    ServerConfig {
        vault_locations: vec![
            VaultLocation::new(id(), "Projects", root.to_str().expect("UTF8 fixture"))
                .expect("location"),
        ],
        ..ServerConfig::default()
    }
}
fn vault(root: &Path) -> Vault {
    Vault::open(Slug::parse("existing").expect("slug"), "Existing", root).expect("vault")
}
fn mkdir(root: &Path, name: &str) {
    fs::create_dir_all(root.join(name)).expect("directory");
}
fn names(listing: &DirectoryListing) -> Vec<&str> {
    listing
        .children
        .iter()
        .map(|entry| entry.name.as_str())
        .collect()
}

#[test]
fn no_configured_locations_and_unknown_ids_fail_before_registered_filesystem_lookup() {
    let dir = tempfile::tempdir().expect("fixture");
    let registered = vault(dir.path());
    fs::remove_dir(dir.path()).expect("remove root");
    assert!(matches!(
        list(
            &ServerConfig::default(),
            &id(),
            &relative(""),
            &[registered]
        ),
        Err(DiscoveryError::UnknownLocation)
    ));
}

#[test]
fn programmatic_duplicate_location_ids_are_refused_before_discovery() {
    let dir = tempfile::tempdir().expect("fixture");
    let mut cfg = config(dir.path());
    cfg.vault_locations.extend(cfg.vault_locations.clone());
    assert!(matches!(
        list(&cfg, &id(), &relative(""), &[]),
        Err(DiscoveryError::DuplicateLocation)
    ));
}

#[test]
fn empty_root_is_browsable_but_not_selectable() {
    let dir = tempfile::tempdir().expect("fixture");
    let listing = list(&config(dir.path()), &id(), &relative(""), &[]).expect("list");
    assert!(listing.children.is_empty());
    assert!(listing.state.browsable());
    assert!(!listing.state.selectable());
    assert!(listing.state.location_root);
}

#[test]
fn missing_and_non_directory_roots_are_errors_not_empty_listings() {
    let dir = tempfile::tempdir().expect("fixture");
    let missing = config(&dir.path().join("missing"));
    assert!(matches!(
        list(&missing, &id(), &relative(""), &[]),
        Err(DiscoveryError::Io { .. })
    ));
    fs::write(dir.path().join("file"), "not a directory").expect("file");
    assert!(matches!(
        list(&config(&dir.path().join("file")), &id(), &relative(""), &[]),
        Err(DiscoveryError::Io { .. })
    ));
}

#[test]
fn missing_and_non_directory_relative_paths_are_errors() {
    let dir = tempfile::tempdir().expect("fixture");
    fs::write(dir.path().join("file"), "body").expect("file");
    for raw in ["missing", "file", "file/child"] {
        assert!(
            matches!(
                list(&config(dir.path()), &id(), &relative(raw), &[]),
                Err(DiscoveryError::Io { .. })
            ),
            "{raw}"
        );
    }
}

#[test]
fn listing_is_immediate_sorted_and_preserves_unicode_without_reading_bodies() {
    let dir = tempfile::tempdir().expect("fixture");
    for name in [
        "zeta",
        "Alpha",
        "日本",
        "שלום",
        "📚",
        "é",
        "e\u{301}",
        "with space",
        " nested ",
    ] {
        mkdir(dir.path(), name);
    }
    mkdir(dir.path(), "Alpha/private-grandchild");
    mkdir(dir.path(), ".hidden");
    mkdir(dir.path(), "literal%2fencoded");
    mkdir(dir.path(), "unsafe\\name");
    mkdir(dir.path(), "unsafe\nname");
    fs::create_dir(
        dir.path()
            .join(std::ffi::OsString::from_vec(vec![b'n', 0xff])),
    )
    .expect("non-UTF8 directory");
    fs::write(dir.path().join("ordinary.txt"), "ordinary").expect("file");
    // why: a dangling symlink and a FIFO named *.md must not be opened as note bodies.
    symlink("absent", dir.path().join("unreadable.md")).expect("dangling symlink");
    rustix::fs::mknodat(
        rustix::fs::CWD,
        dir.path().join("would-block.md"),
        FileType::Fifo,
        Mode::RUSR,
        0,
    )
    .expect("fifo");
    let listing = list(&config(dir.path()), &id(), &relative(""), &[]).expect("list");
    assert_eq!(
        names(&listing),
        vec![
            " nested ",
            "Alpha",
            "e\u{301}",
            "literal%2fencoded",
            "with space",
            "zeta",
            "é",
            "שלום",
            "日本",
            "📚"
        ]
    );
    assert!(
        listing
            .children
            .iter()
            .all(|child| child.state.selectable() && child.path.as_str() == child.name.as_str())
    );
}

#[test]
fn ordinary_child_navigation_does_not_scan_grandchildren_or_invent_note_layout() {
    let dir = tempfile::tempdir().expect("fixture");
    mkdir(dir.path(), "Parent/Child/Grandchild");
    fs::write(dir.path().join("Parent/README.md"), "unchanged markdown").expect("note");
    let listing = list(&config(dir.path()), &id(), &relative("Parent"), &[]).expect("list");
    assert_eq!(names(&listing), vec!["Child"]);
    assert_eq!(
        listing.children.first().expect("child").path.as_str(),
        "Parent/Child"
    );
    assert!(listing.state.selectable());
    assert!(!dir.path().join("Parent/notes").exists());
    assert_eq!(
        fs::read_to_string(dir.path().join("Parent/README.md")).expect("note"),
        "unchanged markdown"
    );
}

#[test]
fn symlinks_inside_and_outside_the_root_are_neither_listed_nor_traversed() {
    let dir = tempfile::tempdir().expect("fixture");
    let outside = tempfile::tempdir().expect("outside");
    mkdir(dir.path(), "real/child");
    mkdir(outside.path(), "secret");
    symlink(dir.path().join("real"), dir.path().join("inside")).expect("inside symlink");
    // why: BENEATH alone rejects absolute links, even to an inside target. A relative
    // inside link specifically proves the stricter no-symlink-traversal policy.
    symlink("real", dir.path().join("relative-inside")).expect("relative inside symlink");
    symlink(outside.path(), dir.path().join("outside")).expect("outside symlink");
    symlink("missing", dir.path().join("broken")).expect("broken symlink");
    assert_eq!(
        names(&list(&config(dir.path()), &id(), &relative(""), &[]).expect("list")),
        vec!["real"]
    );
    for raw in [
        "inside",
        "inside/child",
        "relative-inside",
        "relative-inside/child",
        "outside",
        "outside/secret",
        "broken",
    ] {
        assert!(
            matches!(
                list(&config(dir.path()), &id(), &relative(raw), &[]),
                Err(DiscoveryError::Io { .. })
            ),
            "{raw}"
        );
    }
}

#[test]
fn explicitly_configured_root_alias_is_pinned_but_child_symlinks_are_still_refused() {
    let dir = tempfile::tempdir().expect("fixture");
    mkdir(dir.path(), "real/Project");
    symlink(dir.path().join("real"), dir.path().join("configured-alias")).expect("root alias");
    let cfg = config(&dir.path().join("configured-alias"));
    assert_eq!(
        names(&list(&cfg, &id(), &relative(""), &[]).expect("list")),
        vec!["Project"]
    );
}

#[test]
fn a_replaced_child_cannot_turn_an_earlier_picker_result_into_symlink_authority() {
    let dir = tempfile::tempdir().expect("fixture");
    let outside = tempfile::tempdir().expect("outside");
    mkdir(dir.path(), "Project");
    mkdir(outside.path(), "secret");
    let cfg = config(dir.path());
    let listing = list(&cfg, &id(), &relative(""), &[]).expect("preview");
    let picked = &listing.children.first().expect("child").path;
    fs::remove_dir(dir.path().join("Project")).expect("remove");
    symlink(outside.path(), dir.path().join("Project")).expect("replacement symlink");
    assert!(matches!(
        list(&cfg, &id(), picked, &[]),
        Err(DiscoveryError::Io { .. })
    ));
}

#[test]
fn a_pinned_directory_replaced_or_moved_outside_the_root_is_rejected_before_listing() {
    let dir = tempfile::tempdir().expect("fixture");
    let outside = tempfile::tempdir().expect("outside");
    mkdir(dir.path(), "Project/OldChild");
    let cfg = config(dir.path());
    let roots = RegisteredRoots::from_vaults(&[]).expect("snapshot");
    let opened = open_directory(
        location(&cfg, &id()).expect("location"),
        &relative("Project"),
        &roots,
    )
    .expect("open");
    fs::rename(
        dir.path().join("Project"),
        outside.path().join("MovedProject"),
    )
    .expect("move");
    mkdir(dir.path(), "Project/NewChild");
    assert!(matches!(
        list_open_directory(&opened, &relative("Project"), &roots),
        Err(DiscoveryError::IdentityChanged)
    ));
}

#[test]
fn registered_roots_are_visible_boundaries_without_child_enumeration() {
    let dir = tempfile::tempdir().expect("fixture");
    mkdir(dir.path(), "Registered/private/secret");
    mkdir(dir.path(), "Sibling");
    let registered = vault(&dir.path().join("Registered"));
    let cfg = config(dir.path());
    let listing = list(
        &cfg,
        &id(),
        &relative(""),
        std::slice::from_ref(&registered),
    )
    .expect("root listing");
    let boundary = listing
        .children
        .iter()
        .find(|child| child.name.as_str() == "Registered")
        .expect("boundary");
    assert_eq!(
        boundary.state.registration,
        RegistrationStatus::AlreadyRegistered
    );
    assert!(!boundary.state.selectable());
    assert!(!boundary.state.browsable());
    assert_eq!(
        inspect(
            &cfg,
            &id(),
            &relative("Registered"),
            std::slice::from_ref(&registered)
        )
        .expect("inspect")
        .registration,
        RegistrationStatus::AlreadyRegistered
    );
    assert!(matches!(
        list(
            &cfg,
            &id(),
            &relative("Registered"),
            std::slice::from_ref(&registered)
        ),
        Err(DiscoveryError::RegisteredBoundary(
            RegistrationStatus::AlreadyRegistered
        ))
    ));
    // Even an absent descendant is refused at the boundary, not looked up privately.
    for raw in ["Registered/private", "Registered/missing"] {
        assert!(
            matches!(
                list(
                    &cfg,
                    &id(),
                    &relative(raw),
                    std::slice::from_ref(&registered)
                ),
                Err(DiscoveryError::RegisteredBoundary(
                    RegistrationStatus::InsideRegisteredVault
                ))
            ),
            "{raw}"
        );
    }
}

#[test]
fn ancestors_of_registered_vaults_are_navigable_but_not_selectable_and_siblings_are_available() {
    let dir = tempfile::tempdir().expect("fixture");
    mkdir(dir.path(), "Group/Existing/private");
    mkdir(dir.path(), "Group/Sibling");
    mkdir(dir.path(), "Group/Existing-prefix");
    let registered = vault(&dir.path().join("Group/Existing"));
    let cfg = config(dir.path());
    let listing = list(&cfg, &id(), &relative("Group"), &[registered]).expect("ancestor listing");
    assert_eq!(
        listing.state.registration,
        RegistrationStatus::ContainsRegisteredVault
    );
    assert!(!listing.state.selectable());
    assert!(listing.state.browsable());
    assert!(
        listing
            .children
            .iter()
            .filter(|child| child.name.as_str() != "Existing")
            .all(|child| child.state.selectable())
    );
}

#[test]
fn configured_roots_equal_to_or_inside_registered_vaults_cannot_be_browsed() {
    let dir = tempfile::tempdir().expect("fixture");
    mkdir(dir.path(), "private");
    let registered = vault(dir.path());
    for (path, status) in [
        (
            dir.path().to_path_buf(),
            RegistrationStatus::AlreadyRegistered,
        ),
        (
            dir.path().join("private"),
            RegistrationStatus::InsideRegisteredVault,
        ),
    ] {
        let cfg = config(&path);
        let state = inspect(
            &cfg,
            &id(),
            &relative(""),
            std::slice::from_ref(&registered),
        )
        .expect("state");
        assert!(state.location_root);
        assert_eq!(state.registration, status);
        assert!(!state.selectable());
        assert!(
            matches!(list(&cfg, &id(), &relative(""), std::slice::from_ref(&registered)), Err(DiscoveryError::RegisteredBoundary(found)) if found == status)
        );
    }
}

#[test]
fn registered_root_aliases_and_duplicate_roots_do_not_escape_boundaries() {
    let dir = tempfile::tempdir().expect("fixture");
    mkdir(dir.path(), "Registered/private");
    symlink(dir.path().join("Registered"), dir.path().join("alias")).expect("alias");
    let registrations = [
        vault(&dir.path().join("Registered")),
        vault(&dir.path().join("alias")),
    ];
    assert!(matches!(
        list(
            &config(dir.path()),
            &id(),
            &relative("Registered"),
            &registrations
        ),
        Err(DiscoveryError::RegisteredBoundary(
            RegistrationStatus::AlreadyRegistered
        ))
    ));
}

#[test]
fn renamed_registered_roots_are_still_boundaries_by_directory_identity() {
    let dir = tempfile::tempdir().expect("fixture");
    mkdir(dir.path(), "Existing/private");
    let roots =
        RegisteredRoots::from_vaults(&[vault(&dir.path().join("Existing"))]).expect("snapshot");
    fs::rename(dir.path().join("Existing"), dir.path().join("Renamed")).expect("rename");
    let location =
        VaultLocation::new(id(), "Projects", dir.path().to_str().expect("UTF8")).expect("location");
    let moved = dir.path().join("Renamed");
    let fd = open_canonical(&moved, PIN_FLAGS).expect("pin moved boundary");
    assert_eq!(
        roots
            .directory_relation(&moved, &fd)
            .expect("identity boundary"),
        RegistrationStatus::AlreadyRegistered
    );
    // A moved root remains an identity boundary, and its unavailable snapshot now refuses
    // discovery entirely instead of allowing even public listings with stale registry paths.
    assert!(open_directory(&location, &relative("Renamed"), &roots).is_err());
    assert!(open_directory(&location, &relative("Renamed/private"), &roots).is_err());
}

#[test]
fn inaccessible_registered_roots_fail_closed_instead_of_removing_the_boundary() {
    let dir = tempfile::tempdir().expect("fixture");
    mkdir(dir.path(), "Registered");
    let registered = vault(&dir.path().join("Registered"));
    fs::remove_dir(dir.path().join("Registered")).expect("remove");
    assert!(matches!(
        list(&config(dir.path()), &id(), &relative(""), &[registered]),
        Err(DiscoveryError::Io { .. })
    ));
}

#[test]
fn permission_denial_is_observed_as_an_unprivileged_process_not_root_mode_bits() {
    const MARKER: &str = "MB_LOCATION_DENIAL_FIXTURE";
    if let Some(path) = std::env::var_os(MARKER) {
        let denied = PathBuf::from(path);
        let error = list(&config(&denied), &id(), &relative(""), &[])
            .expect_err("unprivileged process must be denied");
        assert!(
            matches!(error, DiscoveryError::Io { source, .. } if source.kind() == std::io::ErrorKind::PermissionDenied)
        );
        println!("\nMB_LOCATION_DENIAL_ASSERTION_COMPLETED");
        return;
    }
    let dir = tempfile::tempdir().expect("fixture");
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).expect("fixture parent");
    mkdir(dir.path(), "Denied");
    let denied = dir.path().join("Denied");
    fs::set_permissions(&denied, fs::Permissions::from_mode(0o0)).expect("deny");
    let mut command = std::process::Command::new(std::env::current_exe().expect("test executable"));
    command.args(["--exact", "vault_locations::discovery::tests::permission_denial_is_observed_as_an_unprivileged_process_not_root_mode_bits", "--nocapture"]);
    command.env(MARKER, &denied);
    // why: development tests run as root in Docker; actually drop privileges for the probe.
    if rustix::process::geteuid().is_root() {
        command.uid(65534).gid(65534);
    }
    let output = command.output().expect("denial subprocess");
    fs::set_permissions(&denied, fs::Permissions::from_mode(0o755))
        .expect("restore fixture cleanup");
    assert!(
        denial_completed(&output),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn denial_completed(output: &std::process::Output) -> bool {
    output.status.success()
        && String::from_utf8_lossy(&output.stdout)
            .lines()
            .any(|line| line == "MB_LOCATION_DENIAL_ASSERTION_COMPLETED")
}

#[test]
fn unmatched_exact_filter_cannot_prove_permission_denial() {
    let output = std::process::Command::new(std::env::current_exe().expect("test binary"))
        .args(["--exact", "no_such_denial_test", "--nocapture"])
        .output()
        .expect("unmatched subprocess");
    assert!(
        output.status.success(),
        "harness exits successfully for zero tests"
    );
    assert!(
        !denial_completed(&output),
        "zero executed tests are not denial proof"
    );
}

#[test]
fn bounded_scan_counts_files_and_refuses_instead_of_publishing_partial_children() {
    let dir = tempfile::tempdir().expect("fixture");
    mkdir(dir.path(), "Safe");
    for n in 0..4097 {
        fs::write(dir.path().join(format!("file-{n}")), "").expect("file");
    }
    assert!(
        matches!(
            list(&config(dir.path()), &id(), &relative(""), &[]),
            Err(DiscoveryError::LimitExceeded)
        ),
        "files consume the scan budget, no partial Safe listing"
    );
}

#[test]
fn bounded_child_vector_refuses_before_unbounded_growth() {
    let dir = tempfile::tempdir().expect("fixture");
    for n in 0..129 {
        mkdir(dir.path(), &format!("Dir-{n}"));
    }
    assert!(matches!(
        list(&config(dir.path()), &id(), &relative(""), &[]),
        Err(DiscoveryError::LimitExceeded)
    ));
}

#[test]
fn bounded_registry_refuses_before_snapshot_filesystem_access() {
    let dir = tempfile::tempdir().expect("fixture");
    let v = vault(dir.path());
    fs::remove_dir(dir.path()).expect("missing registered root");
    let roots = vec![v; 129];
    let error = list(
        &config(Path::new("/missing-test-fixture")),
        &id(),
        &relative(""),
        &roots,
    )
    .expect_err("registry cap");
    assert!(
        matches!(error, DiscoveryError::LimitExceeded),
        "exact budget refusal must precede stat/open"
    );
}

#[test]
fn bounded_child_response_bytes_refuse_without_partial_list() {
    let dir = tempfile::tempdir().expect("fixture");
    for n in 0..32 {
        mkdir(dir.path(), &format!("{n:03}-{}", "x".repeat(240)));
    }
    assert!(matches!(
        list(&config(dir.path()), &id(), &relative(""), &[]),
        Err(DiscoveryError::LimitExceeded)
    ));
}

#[test]
fn bounded_work_and_cancel_refuse_before_ancestry_or_publication() {
    let dir = tempfile::tempdir().expect("fixture");
    let mut roots = RegisteredRoots::from_vaults(&[]).expect("snapshot");
    let opened = open_directory(
        location(&config(dir.path()), &id()).expect("location"),
        &relative(""),
        &roots,
    )
    .expect("open");
    roots.1.set(MAX_WORK);
    assert!(matches!(
        list_open_directory(&opened, &relative(""), &roots),
        Err(DiscoveryError::LimitExceeded)
    ));
    roots.1.set(0);
    roots.2 = Some(Arc::new(AtomicBool::new(true)));
    assert!(matches!(
        list_open_directory(&opened, &relative(""), &roots),
        Err(DiscoveryError::LimitExceeded)
    ));
}

#[test]
fn seeded_bound_invariant_never_returns_a_partial_child_vector() {
    use proptest::test_runner::{Config, RngSeed, TestRunner};
    println!("discovery bound property seed=20261009");
    let mut runner = TestRunner::new(Config {
        cases: 24,
        rng_seed: RngSeed::Fixed(20261009),
        failure_persistence: None,
        ..Config::default()
    });
    runner
        .run(&(0usize..300), |count| {
            let dir = tempfile::tempdir().expect("fixture");
            for n in 0..count {
                mkdir(dir.path(), &format!("Dir-{n:03}"));
            }
            match list(&config(dir.path()), &id(), &relative(""), &[]) {
                Ok(listing) => {
                    prop_assert_eq!(listing.children.len(), count);
                    prop_assert!(count <= MAX_CHILDREN);
                }
                Err(DiscoveryError::LimitExceeded) => {
                    prop_assert!(
                        count > MAX_CHILDREN || 2048 + count * (6 * 14 + 256) > MAX_RESPONSE_BYTES
                    );
                }
                Err(e) => {
                    return Err(proptest::test_runner::TestCaseError::fail(format!(
                        "unexpected {e}"
                    )));
                }
            }
            Ok(())
        })
        .expect("bound property");
}

#[test]
fn repair_configured_anchor_ancestry_detects_moved_registered_identity() {
    let dir = tempfile::tempdir().expect("fixture");
    mkdir(dir.path(), "Registered/private/SecretName");
    let roots =
        RegisteredRoots::from_vaults(&[vault(&dir.path().join("Registered"))]).expect("snapshot");
    fs::rename(dir.path().join("Registered"), dir.path().join("New")).expect("move");
    let moved_private = dir.path().join("New/private");
    let fd = open_canonical(&moved_private, PIN_FLAGS).expect("pin private anchor");
    // Exercise the ancestry boundary independently of the additional stale-snapshot guard.
    assert_eq!(
        roots
            .directory_relation(&moved_private, &fd)
            .expect("ancestry"),
        RegistrationStatus::InsideRegisteredVault
    );
}

#[test]
fn repair_moved_registered_root_below_configured_anchor_refuses_listing() {
    for replace_old in [false, true] {
        let dir = tempfile::tempdir().expect("fixture");
        mkdir(dir.path(), "Registered/private/SecretName");
        let cfg = config(&dir.path().join("New/private"));
        let roots = RegisteredRoots::from_vaults(&[vault(&dir.path().join("Registered"))])
            .expect("snapshot");
        fs::rename(dir.path().join("Registered"), dir.path().join("New")).expect("move");
        if replace_old {
            mkdir(dir.path(), "Registered");
        }
        let result = open_directory(
            location(&cfg, &id()).expect("location"),
            &relative(""),
            &roots,
        )
        .and_then(|opened| list_open_directory(&opened, &relative(""), &roots));
        assert!(
            result.is_err(),
            "moved private anchor must not enumerate; replaced={replace_old}"
        );
    }
}

#[test]
fn repair_moved_registered_root_below_configured_anchor_refuses_inspection() {
    let dir = tempfile::tempdir().expect("fixture");
    mkdir(dir.path(), "Registered/private/SecretName");
    let cfg = config(&dir.path().join("New/private"));
    let roots =
        RegisteredRoots::from_vaults(&[vault(&dir.path().join("Registered"))]).expect("snapshot");
    fs::rename(dir.path().join("Registered"), dir.path().join("New")).expect("move");
    // The same internal snapshot/open path used by inspect, with a deterministic interleaving.
    let result = open_directory(
        location(&cfg, &id()).expect("location"),
        &relative(""),
        &roots,
    )
    .map(|opened| opened.state);
    assert!(
        result.is_err(),
        "stale registered snapshot must not report Available"
    );
}

#[test]
fn repair_moved_registered_ancestor_refuses_private_configured_anchor() {
    let dir = tempfile::tempdir().expect("fixture");
    mkdir(dir.path(), "Parent/Registered/private/SecretName");
    let cfg = config(&dir.path().join("Moved/Registered/private"));
    let roots = RegisteredRoots::from_vaults(&[vault(&dir.path().join("Parent/Registered"))])
        .expect("snapshot");
    fs::rename(dir.path().join("Parent"), dir.path().join("Moved")).expect("move ancestor");
    mkdir(dir.path(), "Parent/Registered");
    assert!(
        open_directory(
            location(&cfg, &id()).expect("location"),
            &relative(""),
            &roots
        )
        .is_err()
    );
}

#[test]
fn repair_unavailable_or_replaced_registered_snapshot_refuses_opened_listing() {
    for replace_old in [false, true] {
        let dir = tempfile::tempdir().expect("fixture");
        mkdir(dir.path(), "Registered/private/SecretName");
        mkdir(dir.path(), "Sibling/Ordinary");
        let cfg = config(dir.path());
        let roots = RegisteredRoots::from_vaults(&[vault(&dir.path().join("Registered"))])
            .expect("snapshot");
        let opened = open_directory(
            location(&cfg, &id()).expect("location"),
            &relative("Sibling"),
            &roots,
        )
        .expect("public sibling");
        fs::rename(dir.path().join("Registered"), dir.path().join("Moved")).expect("move");
        if replace_old {
            mkdir(dir.path(), "Registered");
        }
        let read_completed = std::cell::Cell::new(false);
        let result = list_open_directory_after_read(&opened, &relative("Sibling"), &roots, || {
            read_completed.set(true);
        });
        assert!(result.is_err(), "replaced={replace_old}");
        assert!(
            !read_completed.get(),
            "invalid snapshot must refuse before enumeration; replaced={replace_old}"
        );
    }
}

#[test]
fn repair_registered_snapshot_changed_after_read_refuses_publication() {
    for replace_old in [false, true] {
        let dir = tempfile::tempdir().expect("fixture");
        mkdir(dir.path(), "Registered/private/SecretName");
        mkdir(dir.path(), "Sibling/Ordinary");
        let cfg = config(dir.path());
        let roots = RegisteredRoots::from_vaults(&[vault(&dir.path().join("Registered"))])
            .expect("snapshot");
        let opened = open_directory(
            location(&cfg, &id()).expect("location"),
            &relative("Sibling"),
            &roots,
        )
        .expect("public sibling");
        let result = list_open_directory_after_read(&opened, &relative("Sibling"), &roots, || {
            fs::rename(dir.path().join("Registered"), dir.path().join("Moved")).expect("move");
            if replace_old {
                mkdir(dir.path(), "Registered");
            }
        });
        assert!(
            result.is_err(),
            "publication must revalidate registered snapshot; replaced={replace_old}"
        );
    }
}

#[test]
fn repair_registered_alias_changed_after_open_refuses_listing() {
    let dir = tempfile::tempdir().expect("fixture");
    mkdir(dir.path(), "Registered/private/SecretName");
    mkdir(dir.path(), "Other");
    mkdir(dir.path(), "Sibling/Ordinary");
    symlink("Registered", dir.path().join("alias")).expect("alias");
    let cfg = config(dir.path());
    let roots =
        RegisteredRoots::from_vaults(&[vault(&dir.path().join("alias"))]).expect("snapshot");
    let opened = open_directory(
        location(&cfg, &id()).expect("location"),
        &relative("Sibling"),
        &roots,
    )
    .expect("open");
    fs::remove_file(dir.path().join("alias")).expect("remove alias");
    symlink("Other", dir.path().join("alias")).expect("retarget alias");
    assert!(list_open_directory(&opened, &relative("Sibling"), &roots).is_err());
}

#[test]
fn repair_configured_alias_changed_after_read_refuses_publication() {
    let dir = tempfile::tempdir().expect("fixture");
    mkdir(dir.path(), "Public/Ordinary");
    mkdir(dir.path(), "Other");
    symlink("Public", dir.path().join("alias")).expect("alias");
    let cfg = config(&dir.path().join("alias"));
    let roots = RegisteredRoots::from_vaults(&[]).expect("snapshot");
    let opened = open_directory(
        location(&cfg, &id()).expect("location"),
        &relative(""),
        &roots,
    )
    .expect("open");
    let result = list_open_directory_after_read(&opened, &relative(""), &roots, || {
        fs::remove_file(dir.path().join("alias")).expect("remove alias");
        symlink("Other", dir.path().join("alias")).expect("retarget alias");
    });
    assert!(
        result.is_err(),
        "root-relative dot cannot validate a retargeted alias"
    );
}

#[test]
fn repair_configured_ancestor_moved_inside_registered_root_refuses_listing() {
    let dir = tempfile::tempdir().expect("fixture");
    mkdir(dir.path(), "Public/Configured/Ordinary");
    mkdir(dir.path(), "Registered/private/SecretName");
    let cfg = config(&dir.path().join("Public/Configured"));
    let roots =
        RegisteredRoots::from_vaults(&[vault(&dir.path().join("Registered"))]).expect("snapshot");
    let opened = open_directory(
        location(&cfg, &id()).expect("location"),
        &relative(""),
        &roots,
    )
    .expect("open");
    fs::rename(
        dir.path().join("Public"),
        dir.path().join("Registered/Moved"),
    )
    .expect("move ancestor");
    assert!(list_open_directory(&opened, &relative(""), &roots).is_err());
}

#[test]
fn repair_listing_preserves_ordinary_colon_and_literal_percent_names() {
    let dir = tempfile::tempdir().expect("fixture");
    let expected = [
        "%252e%252e",
        "%2e%2e",
        "%2f",
        "%5c",
        "100% Complete",
        "Design: notes",
        "literal%2ftext",
        "literal%5ctext",
    ];
    for name in expected {
        mkdir(dir.path(), name);
    }
    mkdir(dir.path(), "C:drive");
    let cfg = config(dir.path());
    let listing = list(&cfg, &id(), &relative(""), &[]).expect("list");
    assert_eq!(names(&listing), expected);
    for child in &listing.children {
        assert_eq!(child.path.as_str(), child.name.as_str());
        assert!(
            list(&cfg, &id(), &child.path, &[])
                .expect("literal navigation")
                .children
                .is_empty()
        );
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 48, rng_seed: proptest::test_runner::RngSeed::Fixed(20261009), ..ProptestConfig::default() })]
    #[test]
    fn listing_order_is_independent_of_creation_order(names in proptest::collection::btree_set("[a-zA-Z0-9_]{1,15}", 0..20)) {
        eprintln!("proptest seed: 20261009");
        let dir = tempfile::tempdir().expect("fixture");
        for name in names.iter().rev() { mkdir(dir.path(), name); }
        let listing = list(&config(dir.path()), &id(), &relative(""), &[]).expect("list");
        let actual: Vec<String> = listing.children.into_iter().map(|entry| entry.name.as_str().to_owned()).collect();
        prop_assert_eq!(actual, names.into_iter().collect::<Vec<_>>());
    }
}
