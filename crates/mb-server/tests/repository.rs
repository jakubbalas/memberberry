//! Permission-filtered repository leak tests (`SPEC.md` §6.4 and §22.5).

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

mod support;

use std::collections::BTreeMap;

use mb_core::{Access, Member, NotePath, Role, Rule, Username};
use mb_server::repository::AuthorizedVault;
use mb_server::vault::Slug;
use mb_server::{Error, Vault};

use support::TempDir;

fn user(name: &str) -> Username {
    Username::parse(name).expect("valid username")
}

fn path(value: &str) -> NotePath {
    NotePath::parse(value).expect("valid path")
}

fn vault(dir: &TempDir) -> Vault {
    Vault::open(
        Slug::parse("personal").expect("slug"),
        "Personal",
        dir.path(),
    )
    .expect("vault")
}

fn access() -> Access {
    Access::new(
        vec![Member {
            user: user("alice"),
            role: Role::Viewer,
        }],
        vec![Rule {
            path: path("Private"),
            grants: BTreeMap::from([(user("alice"), Role::None)]),
        }],
    )
    .expect("valid ACL")
}

#[test]
fn unreadable_notes_do_not_exist_in_a_repository_list_or_lookup() {
    let dir = TempDir::new("repository-list");
    dir.write("Public.md", "# Public\n");
    dir.write("Private/Salary.md", "# Salary Review\n");
    let vault = vault(&dir);
    let policy = access();
    let view = AuthorizedVault::new(&vault, &policy, user("alice"));

    assert_eq!(view.notes().expect("list notes"), vec!["Public.md"]);
    assert_eq!(view.find_by_name("Salary"), None);
    assert_eq!(view.find_by_name("Public"), Some("Public.md".to_string()));
}

#[test]
fn unreadable_note_paths_and_source_return_not_found() {
    let dir = TempDir::new("repository-read");
    dir.write("Private/Salary.md", "# Salary Review\n");
    let vault = vault(&dir);
    let policy = access();
    let view = AuthorizedVault::new(&vault, &policy, user("alice"));

    assert!(matches!(
        view.resolve("Private/Salary.md"),
        Err(Error::NotFound)
    ));
    assert!(matches!(
        view.read("Private/Salary.md"),
        Err(Error::NotFound)
    ));
}

#[test]
fn an_admin_without_a_vault_membership_cannot_read_any_note() {
    let dir = TempDir::new("repository-admin");
    dir.write("Journal.md", "# Private Journal\n");
    let vault = vault(&dir);
    let policy = Access::default();
    let view = AuthorizedVault::new(&vault, &policy, user("server-admin"));

    assert!(view.notes().expect("list notes").is_empty());
    assert!(matches!(view.read("Journal.md"), Err(Error::NotFound)));
}

#[test]
fn viewer_cannot_upload_but_a_path_editor_can() {
    let dir = TempDir::new("repository-write-access");
    dir.write("Public.md", "# Public\n");
    let vault = vault(&dir);
    let viewer = access();
    assert!(
        !AuthorizedVault::new(&vault, &viewer, user("alice"))
            .has_any_write_access()
            .expect("viewer access")
    );
    let path_editor = Access::new(
        vec![Member {
            user: user("alice"),
            role: Role::Viewer,
        }],
        vec![Rule {
            path: path("Public.md"),
            grants: BTreeMap::from([(user("alice"), Role::Editor)]),
        }],
    )
    .expect("path editor ACL");
    assert!(
        AuthorizedVault::new(&vault, &path_editor, user("alice"))
            .has_any_write_access()
            .expect("editor access")
    );
}

#[test]
fn a_path_editor_can_upload_before_the_granted_folder_has_notes() {
    let dir = TempDir::new("repository-empty-write-access");
    dir.write("Public.md", "# Public\n");
    let vault = vault(&dir);
    let path_editor = Access::new(
        vec![Member {
            user: user("alice"),
            role: Role::Viewer,
        }],
        vec![Rule {
            path: path("Future"),
            grants: BTreeMap::from([(user("alice"), Role::Editor)]),
        }],
    )
    .expect("path editor ACL");
    assert!(
        AuthorizedVault::new(&vault, &path_editor, user("alice"))
            .has_any_write_access()
            .expect("editor access")
    );
}
