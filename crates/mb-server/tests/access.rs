//! Durable ACL file tests (`SPEC.md` §6.2 and §22.5).

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

mod support;

use mb_core::{NotePath, Role, Username};
use mb_server::AccessFile;

use support::TempDir;

fn user(name: &str) -> Username {
    Username::parse(name).expect("valid test user")
}

fn path(value: &str) -> NotePath {
    NotePath::parse(value).expect("valid test path")
}

#[test]
fn an_absent_access_file_denies_everyone() {
    let vault = TempDir::new("access-absent");
    let access = AccessFile::load(vault.path()).expect("load deny-all ACL");
    assert_eq!(
        access
            .policy()
            .effective_role(&user("alice"), &path("Plans.md")),
        Role::None
    );
}

#[test]
fn a_valid_access_file_resolves_folder_and_note_rules() {
    let access = AccessFile::parse(
        "[[members]]\nuser = \"alice\"\nrole = \"viewer\"\n\n\
         [[rules]]\npath = \"Projects\"\ngrant = { alice = \"editor\" }\n\n\
         [[rules]]\npath = \"Projects/Salary.md\"\ngrant = { alice = \"none\" }\n",
    )
    .expect("parse ACL");

    assert_eq!(
        access
            .policy()
            .effective_role(&user("alice"), &path("Projects/Plan.md")),
        Role::Editor
    );
    assert_eq!(
        access
            .policy()
            .effective_role(&user("alice"), &path("Projects/Salary.md")),
        Role::None
    );
}

#[test]
fn malformed_or_ambiguous_access_files_never_load_as_permissive() {
    for source in [
        "[[members]]\nuser = \"alice\"\nrole = \"administrator\"\n",
        "[[members]]\nuser = \"alice\"\nrole = \"viewer\"\nextra = true\n",
        "[[rules]]\npath = \"../secret.md\"\ngrant = { alice = \"viewer\" }\n",
        "[[rules]]\npath = \"Plans\"\ngrant = { alice = \"viewer\" }\n\n\
         [[rules]]\npath = \"Plans\"\ngrant = { bob = \"viewer\" }\n",
    ] {
        assert!(AccessFile::parse(source).is_err(), "{source}");
    }
}

#[test]
fn saving_then_loading_preserves_the_validated_policy() {
    let vault = TempDir::new("access-roundtrip");
    let original = AccessFile::parse(
        "[[members]]\nuser = \"alice\"\nrole = \"editor\"\n\n\
         [[rules]]\npath = \"Private\"\ngrant = { alice = \"none\" }\n",
    )
    .expect("parse ACL");
    original.save(vault.path()).expect("save ACL");
    let loaded = AccessFile::load(vault.path()).expect("load ACL");
    assert_eq!(loaded, original);
}
