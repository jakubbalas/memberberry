//! Provider groups in vault access (`SPEC.md` §6.8.2, M20b): a grant to a group counts exactly
//! like a grant to each of its members, and to nobody else.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

use std::collections::{BTreeMap, BTreeSet};

use mb_core::{Access, GroupName, Member, NotePath, Role, Rule, Username};
use proptest::prelude::*;

fn user(name: &str) -> Username {
    Username::parse(name).expect("username")
}

fn group(name: &str) -> GroupName {
    GroupName::parse(name).expect("group")
}

fn path(value: &str) -> NotePath {
    NotePath::parse(value).expect("path")
}

fn in_groups(name: &str, groups: &[&str]) -> BTreeMap<Username, BTreeSet<GroupName>> {
    BTreeMap::from([(user(name), groups.iter().map(|g| group(g)).collect())])
}

#[test]
fn a_vault_wide_group_grant_reaches_its_members() {
    let access = Access::new(vec![], vec![])
        .unwrap()
        .with_group_grants(vec![(group("family"), Role::Viewer)], vec![])
        .unwrap()
        .with_user_groups(&in_groups("alice", &["family"]));
    assert_eq!(
        access.effective_role(&user("alice"), &path("A.md")),
        Role::Viewer
    );
}

#[test]
fn a_group_grant_reaches_nobody_outside_the_group() {
    let access = Access::new(vec![], vec![])
        .unwrap()
        .with_group_grants(vec![(group("family"), Role::Viewer)], vec![])
        .unwrap()
        .with_user_groups(&in_groups("alice", &["work"]));
    assert_eq!(
        access.effective_role(&user("alice"), &path("A.md")),
        Role::None
    );
}

#[test]
fn without_sign_in_groups_a_group_grants_nothing() {
    let access = Access::new(vec![], vec![])
        .unwrap()
        .with_group_grants(vec![(group("family"), Role::Owner)], vec![])
        .unwrap();
    assert_eq!(
        access.effective_role(&user("alice"), &path("A.md")),
        Role::None
    );
}

#[test]
fn the_more_capable_of_a_users_and_a_groups_grant_applies() {
    let access = Access::new(
        vec![Member {
            user: user("alice"),
            role: Role::Viewer,
        }],
        vec![],
    )
    .unwrap()
    .with_group_grants(vec![(group("family"), Role::Editor)], vec![])
    .unwrap()
    .with_user_groups(&in_groups("alice", &["family"]));
    assert_eq!(
        access.effective_role(&user("alice"), &path("A.md")),
        Role::Editor
    );
}

#[test]
fn a_groups_explicit_none_is_final_for_its_members() {
    let access = Access::new(
        vec![Member {
            user: user("alice"),
            role: Role::Owner,
        }],
        vec![],
    )
    .unwrap()
    .with_group_grants(
        vec![],
        vec![(
            path("Private"),
            BTreeMap::from([(group("guests"), Role::None)]),
        )],
    )
    .unwrap()
    .with_user_groups(&in_groups("alice", &["guests"]));
    assert_eq!(
        access.effective_role(&user("alice"), &path("Private/Salary.md")),
        Role::None
    );
}

#[test]
fn a_more_specific_group_rule_overrides_a_vault_wide_membership() {
    let access = Access::new(
        vec![Member {
            user: user("alice"),
            role: Role::Viewer,
        }],
        vec![],
    )
    .unwrap()
    .with_group_grants(
        vec![],
        vec![(
            path("Shared"),
            BTreeMap::from([(group("family"), Role::Editor)]),
        )],
    )
    .unwrap()
    .with_user_groups(&in_groups("alice", &["family"]));
    assert_eq!(
        access.effective_role(&user("alice"), &path("Shared/List.md")),
        Role::Editor
    );
}

#[test]
fn group_members_count_as_principals() {
    let access = Access::new(vec![], vec![])
        .unwrap()
        .with_group_grants(vec![(group("family"), Role::Viewer)], vec![])
        .unwrap()
        .with_user_groups(&in_groups("alice", &["family"]));
    assert!(access.principals().contains(&user("alice")));
}

#[test]
fn a_group_listed_twice_is_refused() {
    let built = Access::new(vec![], vec![]).unwrap().with_group_grants(
        vec![
            (group("family"), Role::Viewer),
            (group("family"), Role::Editor),
        ],
        vec![],
    );
    assert!(built.is_err());
}

#[test]
fn a_group_name_with_surrounding_space_is_refused() {
    assert!(GroupName::parse(" family").is_err() && GroupName::parse("").is_err());
}

#[test]
fn a_keycloak_style_group_path_is_a_valid_name() {
    assert!(GroupName::parse("/family/kids").is_ok());
}

// ---------------------------------------------------------------- properties

const PATHS: [&str; 4] = ["A", "A/B", "A/B/C.md", "D.md"];
const NOTES: [&str; 4] = ["A/B/C.md", "A/x.md", "D.md", "E.md"];

fn role() -> impl Strategy<Value = Role> {
    prop_oneof![
        Just(Role::Owner),
        Just(Role::Editor),
        Just(Role::Viewer),
        Just(Role::None)
    ]
}

/// A random policy: alice's own grants, and grants to groups `g0`..`g2`.
#[derive(Debug, Clone)]
struct Policy {
    own_member: Option<Role>,
    own_rules: BTreeMap<usize, Role>,
    group_members: BTreeMap<usize, Role>,
    group_rules: BTreeMap<(usize, usize), Role>,
    memberships: BTreeSet<usize>,
}

fn policy() -> impl Strategy<Value = Policy> {
    (
        prop::option::of(role()),
        prop::collection::btree_map(0..PATHS.len(), role(), 0..3),
        prop::collection::btree_map(0..3usize, role(), 0..3),
        prop::collection::btree_map((0..PATHS.len(), 0..3usize), role(), 0..4),
        prop::collection::btree_set(0..3usize, 0..3),
    )
        .prop_map(
            |(own_member, own_rules, group_members, group_rules, memberships)| Policy {
                own_member,
                own_rules,
                group_members,
                group_rules,
                memberships,
            },
        )
}

fn g(i: usize) -> GroupName {
    group(&format!("g{i}"))
}

fn build(policy: &Policy, with_groups: bool) -> Access {
    let members = policy
        .own_member
        .map(|role| Member {
            user: user("alice"),
            role,
        })
        .into_iter()
        .collect();
    let rules = policy
        .own_rules
        .iter()
        .map(|(i, role)| Rule {
            path: path(PATHS[*i]),
            grants: BTreeMap::from([(user("alice"), *role)]),
        })
        .collect();
    let mut access = Access::new(members, rules).unwrap();
    if with_groups {
        let mut by_path: BTreeMap<usize, BTreeMap<GroupName, Role>> = BTreeMap::new();
        for ((i, group), role) in &policy.group_rules {
            by_path.entry(*i).or_default().insert(g(*group), *role);
        }
        access = access
            .with_group_grants(
                policy
                    .group_members
                    .iter()
                    .map(|(i, role)| (g(*i), *role))
                    .collect(),
                by_path
                    .into_iter()
                    .map(|(i, grants)| (path(PATHS[i]), grants))
                    .collect(),
            )
            .unwrap();
    }
    access
}

/// The same policy with alice's groups' grants written onto alice herself.
fn expanded(policy: &Policy) -> Access {
    let combine = |roles: Vec<Role>| -> Option<Role> {
        if roles.contains(&Role::None) {
            return Some(Role::None);
        }
        roles.into_iter().min()
    };
    let mut member: Vec<Role> = policy.own_member.into_iter().collect();
    for (i, role) in &policy.group_members {
        if policy.memberships.contains(i) {
            member.push(*role);
        }
    }
    let members = combine(member)
        .map(|role| Member {
            user: user("alice"),
            role,
        })
        .into_iter()
        .collect();
    let mut rules = Vec::new();
    for (i, path_text) in PATHS.iter().enumerate() {
        let mut roles: Vec<Role> = policy.own_rules.get(&i).copied().into_iter().collect();
        for ((p, group), role) in &policy.group_rules {
            if *p == i && policy.memberships.contains(group) {
                roles.push(*role);
            }
        }
        if let Some(role) = combine(roles) {
            rules.push(Rule {
                path: path(path_text),
                grants: BTreeMap::from([(user("alice"), role)]),
            });
        }
    }
    Access::new(members, rules).unwrap()
}

proptest! {
    #[test]
    fn a_group_grant_counts_exactly_like_the_users_own(policy in policy()) {
        let memberships = BTreeMap::from([(
            user("alice"),
            policy.memberships.iter().map(|i| g(*i)).collect::<BTreeSet<_>>(),
        )]);
        let with_groups = build(&policy, true).with_user_groups(&memberships);
        let model = expanded(&policy);
        for note in NOTES {
            prop_assert_eq!(
                with_groups.effective_role(&user("alice"), &path(note)),
                model.effective_role(&user("alice"), &path(note)),
                "note {}", note
            );
        }
    }

    #[test]
    fn groups_change_nothing_for_someone_in_none_of_them(policy in policy()) {
        let with_groups = build(&policy, true);
        let without = build(&policy, false);
        for note in NOTES {
            prop_assert_eq!(
                with_groups.effective_role(&user("alice"), &path(note)),
                without.effective_role(&user("alice"), &path(note)),
                "note {}", note
            );
        }
    }
}
