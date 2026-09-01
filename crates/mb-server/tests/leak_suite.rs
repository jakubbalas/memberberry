//! Permission leak suite for enforcement points implemented through M4 (`SPEC.md` §22.5).
//!
//! This suite is deliberately organised by enforcement point rather than feature. Adding a
//! content-bearing M4 surface means extending this file before that surface can ship.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod support;

use mb_core::{Access, Member, Role, Username};
use mb_server::Vault;
use mb_server::repository::AuthorizedVault;
use mb_server::vault::Slug;
use support::TempDir;

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
