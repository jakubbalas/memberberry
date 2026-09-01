//! Permission resolution properties (`SPEC.md` §6.3 and §22.5).

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use std::collections::BTreeMap;

use mb_core::{Access, Member, NotePath, Role, Rule, Username};
use proptest::prelude::*;

fn user(name: &str) -> Username {
    Username::parse(name).expect("valid test username")
}

fn path(value: &str) -> NotePath {
    NotePath::parse(value).expect("valid test path")
}

fn grants(entries: &[(&str, Role)]) -> BTreeMap<Username, Role> {
    entries
        .iter()
        .map(|(name, role)| (user(name), *role))
        .collect()
}

#[test]
fn an_absent_member_has_no_access() {
    let access = Access::new(vec![], vec![]).expect("empty ACL is valid");
    assert_eq!(
        access.effective_role(&user("alice"), &path("Plans.md")),
        Role::None
    );
}

#[test]
fn the_most_specific_rule_overrides_a_vault_wide_membership() {
    let access = Access::new(
        vec![Member {
            user: user("alice"),
            role: Role::Viewer,
        }],
        vec![Rule {
            path: path("Projects/Shared"),
            grants: grants(&[("alice", Role::Editor)]),
        }],
    )
    .expect("valid ACL");

    assert_eq!(
        access.effective_role(&user("alice"), &path("Projects/Shared/Plan.md")),
        Role::Editor
    );
    assert_eq!(
        access.effective_role(&user("alice"), &path("Projects/Private/Plan.md")),
        Role::Viewer
    );
}

#[test]
fn an_explicit_denial_is_absorbing() {
    let access = Access::new(
        vec![Member {
            user: user("alice"),
            role: Role::Editor,
        }],
        vec![
            Rule {
                path: path("Projects"),
                grants: grants(&[("alice", Role::None)]),
            },
            Rule {
                path: path("Projects/Shared"),
                grants: grants(&[("alice", Role::Owner)]),
            },
        ],
    )
    .expect("valid ACL");

    assert_eq!(
        access.effective_role(&user("alice"), &path("Projects/Shared/Plan.md")),
        Role::None
    );
}

#[test]
fn invalid_paths_cannot_escape_or_ambiguously_match_the_vault() {
    for invalid in ["", "/private.md", "a/../private.md", "a//b", "a/", "a\\b"] {
        assert!(NotePath::parse(invalid).is_err(), "{invalid:?}");
    }
}

#[test]
fn duplicate_members_and_rule_paths_are_rejected() {
    let alice = user("alice");
    let members = vec![
        Member {
            user: alice.clone(),
            role: Role::Viewer,
        },
        Member {
            user: alice,
            role: Role::Editor,
        },
    ];
    assert!(Access::new(members, vec![]).is_err());

    let rules = vec![
        Rule {
            path: path("Projects"),
            grants: grants(&[("alice", Role::Viewer)]),
        },
        Rule {
            path: path("Projects"),
            grants: grants(&[("alice", Role::Editor)]),
        },
    ];
    assert!(Access::new(vec![], rules).is_err());
}

proptest! {
    #[test]
    fn explicit_none_is_absorbing_for_every_matching_descendant(
        suffix in "[a-z]{1,12}",
        role in prop_oneof![Just(Role::Owner), Just(Role::Editor), Just(Role::Viewer)],
    ) {
        let access = Access::new(
            vec![Member { user: user("alice"), role }],
            vec![Rule {
                path: path("Private"),
                grants: grants(&[("alice", Role::None)]),
            }],
        ).expect("valid ACL");
        prop_assert_eq!(
            access.effective_role(&user("alice"), &path(&format!("Private/{suffix}.md"))),
            Role::None,
        );
    }

    #[test]
    fn resolution_is_order_independent(
        base in prop_oneof![Just(Role::Owner), Just(Role::Editor), Just(Role::Viewer), Just(Role::None)],
        folder in prop_oneof![Just(Role::Owner), Just(Role::Editor), Just(Role::Viewer)],
        note in prop_oneof![Just(Role::Owner), Just(Role::Editor), Just(Role::Viewer)],
    ) {
        let members = vec![Member { user: user("alice"), role: base }];
        let project = Rule { path: path("Projects"), grants: grants(&[("alice", folder)]) };
        let target = Rule { path: path("Projects/Plan.md"), grants: grants(&[("alice", note)]) };
        let forward = Access::new(members.clone(), vec![project.clone(), target.clone()]).expect("valid ACL");
        let reverse = Access::new(members, vec![target, project]).expect("valid ACL");
        let target = path("Projects/Plan.md");
        prop_assert_eq!(
            forward.effective_role(&user("alice"), &target),
            reverse.effective_role(&user("alice"), &target),
        );
    }
}
