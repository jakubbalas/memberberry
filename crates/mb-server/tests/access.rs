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

/// `group:<name>` in `access.toml` (§6.8.2, M20b).
mod groups {
    use std::collections::{BTreeMap, BTreeSet};

    use mb_core::{GroupName, NotePath, Role, Username};
    use mb_server::AccessFile;

    const POLICY: &str = "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n\n\
        [[members]]\nuser = \"group:family\"\nrole = \"viewer\"\n\n\
        [[rules]]\npath = \"Shared\"\ngrant = { \"group:family\" = \"editor\", bob = \"viewer\" }\n";

    fn bob_in_family() -> BTreeMap<Username, BTreeSet<GroupName>> {
        BTreeMap::from([(
            Username::parse("bob").unwrap(),
            BTreeSet::from([GroupName::parse("family").unwrap()]),
        )])
    }

    #[test]
    fn a_group_member_and_a_group_grant_are_read() {
        let access = AccessFile::parse(POLICY)
            .expect("parses")
            .policy()
            .with_user_groups(&bob_in_family());
        let bob = Username::parse("bob").unwrap();
        assert_eq!(
            (
                access.effective_role(&bob, &NotePath::parse("Home.md").unwrap()),
                access.effective_role(&bob, &NotePath::parse("Shared/List.md").unwrap()),
            ),
            (Role::Viewer, Role::Editor)
        );
    }

    #[test]
    fn group_grants_survive_a_save_and_reload() {
        let parsed = AccessFile::parse(POLICY).expect("parses");
        let saved = parsed.to_toml().expect("serializes");
        assert_eq!(
            AccessFile::parse(&saved).expect("reparses"),
            parsed,
            "{saved}"
        );
    }

    #[test]
    fn a_malformed_group_name_denies_the_whole_file() {
        assert!(
            AccessFile::parse("[[members]]\nuser = \"group: spaced\"\nrole = \"viewer\"\n")
                .is_err()
        );
    }
}
