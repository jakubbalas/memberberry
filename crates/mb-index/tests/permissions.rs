//! The index's half of the permission leak suite (`SPEC.md` §22.5, E5, E8, E9).
//!
//! Every assertion here is of the form "the caller cannot tell the note exists". The
//! invisibility rule (§6.5) is stronger than "cannot read it": a title in a backlink row, a
//! path in an error, or a count that changes are all disclosures.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

mod support;

use mb_core::{Access, Username};
use mb_index::Index;
use support::{indexed, user, viewer_everywhere, viewer_except};

/// The notes used by most cases: a private note that links to a shared one and back.
fn vault() -> Index {
    indexed(&[
        ("Shared.md", "# Shared\n\nsee [[Private/Salary]]\n"),
        (
            "Private/Salary.md",
            "# Salary Review\n\nsee [[Shared]] and #private/pay\n",
        ),
    ])
}

fn backlink_paths(index: &mut Index, access: &Access, who: &Username, path: &str) -> Vec<String> {
    let reader = index.reader(access, who).expect("reader");
    reader
        .backlinks(path)
        .expect("backlinks")
        .into_iter()
        .map(|group| group.path)
        .collect()
}

#[test]
fn e5_a_reader_with_no_membership_sees_no_notes_at_all() {
    // Deny by default: a user the ACL never mentions gets an empty readable set, so every
    // query answers as if the vault were empty rather than as if the filter were absent.
    let mut index = vault();
    let access = Access::default();
    let reader = index.reader(&access, &user("stranger")).expect("reader");
    assert_eq!(reader.readable_notes(), 0);
    assert!(!reader.contains("Shared.md").expect("contains"));
    assert!(reader.backlinks("Shared.md").expect("backlinks").is_empty());
}

#[test]
fn e5_an_unreadable_note_is_indistinguishable_from_a_missing_one() {
    let mut index = vault();
    let access = viewer_except("alice", &["Private"]);
    let reader = index.reader(&access, &user("alice")).expect("reader");
    assert_eq!(reader.readable_notes(), 1);
    assert_eq!(
        reader.contains("Private/Salary.md").expect("contains"),
        reader.contains("Private/Nonexistent.md").expect("contains"),
        "an unreadable note and an absent one must answer the same"
    );
}

#[test]
fn e11_media_referenced_only_by_an_unreadable_note_is_not_visible() {
    let mut index = indexed(&[
        ("Shared.md", "![public](media/aa/bb/public.png)\n"),
        ("Private/Salary.md", "![secret](media/cc/dd/secret.png)\n"),
    ]);
    let limited = viewer_except("alice", &["Private"]);
    let reader = index.reader(&limited, &user("alice")).expect("reader");
    assert!(
        reader
            .references_media("media/aa/bb/public.png")
            .expect("public media")
    );
    assert!(
        !reader
            .references_media("media/cc/dd/secret.png")
            .expect("private media")
    );
    assert!(
        !reader
            .references_media("media/ee/ff/missing.png")
            .expect("missing media")
    );
}

#[test]
fn e8_a_backlink_from_an_unreadable_note_is_not_reported() {
    // `Private/Salary.md` links to `Shared.md`. Alice can read the target and not the
    // source, and the source's *name* is the disclosure.
    let mut index = vault();
    let access = viewer_except("alice", &["Private"]);
    assert!(
        backlink_paths(&mut index, &access, &user("alice"), "Shared.md").is_empty(),
        "the private note's name leaked through the backlinks of a note alice may read"
    );
    // The same query as someone who may read everything proves the link is really there,
    // so the empty answer above is the filter working rather than the fixture being wrong.
    let all = viewer_everywhere("bob");
    assert_eq!(
        backlink_paths(&mut index, &all, &user("bob"), "Shared.md"),
        vec!["Private/Salary.md"]
    );
}

#[test]
fn e8_an_unreadable_note_has_no_backlinks_because_it_does_not_exist() {
    let mut index = vault();
    let access = viewer_except("alice", &["Private"]);
    assert!(backlink_paths(&mut index, &access, &user("alice"), "Private/Salary.md").is_empty());
}

#[test]
fn e9_a_link_resolves_among_readable_candidates_only() {
    // Two notes are called `Roadmap`. The nearer one is denied to alice, so for her the
    // link resolves to the far one — and for bob, who can read both, it resolves to the
    // near one. Two users seeing one link resolve differently looks alarming and is exactly
    // what §6.5 asks for: a note alice cannot read *does not exist* for her, so it cannot
    // be the nearest candidate, and it cannot leave a dead link where a visible note
    // matches the name either. Resolving first and then dropping the edge would tell her
    // something is there.
    let mut index = indexed(&[
        ("Private/Roadmap.md", "# Secret plan\n"),
        ("Archive/Roadmap.md", "# Old plan\n"),
        ("Private/Q3.md", "see [[Roadmap]]\n"),
    ]);
    let alice = viewer_except("alice", &["Private/Roadmap.md"]);
    assert_eq!(
        backlink_paths(&mut index, &alice, &user("alice"), "Archive/Roadmap.md"),
        vec!["Private/Q3.md"]
    );
    assert!(backlink_paths(&mut index, &alice, &user("alice"), "Private/Roadmap.md").is_empty());

    let bob = viewer_everywhere("bob");
    assert_eq!(
        backlink_paths(&mut index, &bob, &user("bob"), "Private/Roadmap.md"),
        vec!["Private/Q3.md"],
        "nearness decides for a reader who can see both"
    );
    assert!(backlink_paths(&mut index, &bob, &user("bob"), "Archive/Roadmap.md").is_empty());
}

#[test]
fn a_revoked_note_disappears_from_the_next_reader_without_a_reindex() {
    // §6.4: `access.toml` is live. The readable set is resolved per reader, so a revocation
    // takes effect on the next query rather than at the next restart or reindex.
    let mut index = vault();
    let before = viewer_everywhere("alice");
    assert_eq!(
        backlink_paths(&mut index, &before, &user("alice"), "Shared.md"),
        vec!["Private/Salary.md"]
    );
    let after = viewer_except("alice", &["Private"]);
    assert!(backlink_paths(&mut index, &after, &user("alice"), "Shared.md").is_empty());
}

#[test]
fn a_grant_of_none_at_the_vault_level_reads_nothing() {
    let mut index = vault();
    let access = Access::new(
        vec![mb_core::Member {
            user: user("alice"),
            role: mb_core::Role::None,
        }],
        vec![],
    )
    .expect("policy");
    let reader = index.reader(&access, &user("alice")).expect("reader");
    assert_eq!(reader.readable_notes(), 0);
}

#[test]
fn a_per_note_grant_reads_exactly_that_note() {
    // §6.3: the longest matching path wins, so a single note can be shared out of a folder
    // that is otherwise denied.
    let mut index = vault();
    let alice = user("alice");
    let access = Access::new(
        vec![],
        vec![mb_core::Rule {
            path: mb_core::NotePath::parse("Private/Salary.md").expect("path"),
            grants: std::collections::BTreeMap::from([(alice.clone(), mb_core::Role::Viewer)]),
        }],
    )
    .expect("policy");
    let reader = index.reader(&access, &alice).expect("reader");
    assert_eq!(reader.readable_notes(), 1);
    assert!(reader.contains("Private/Salary.md").expect("contains"));
    assert!(!reader.contains("Shared.md").expect("contains"));
}

#[test]
fn two_readers_do_not_see_each_others_readable_set() {
    // The readable set lives on the connection, so a reader replacing it is the one bug that
    // would make every permission test above pass while the server leaked in production.
    let mut index = vault();
    let all = viewer_everywhere("bob");
    let limited = viewer_except("alice", &["Private"]);
    assert_eq!(
        index
            .reader(&all, &user("bob"))
            .expect("reader")
            .readable_notes(),
        2
    );
    assert_eq!(
        index
            .reader(&limited, &user("alice"))
            .expect("reader")
            .readable_notes(),
        1
    );
    assert_eq!(
        index
            .reader(&all, &user("bob"))
            .expect("reader")
            .readable_notes(),
        2,
        "the previous reader's narrower set outlived it"
    );
}

#[test]
fn a_note_whose_path_the_acl_cannot_express_is_denied() {
    // why: fail closed (§3.1). A path `NotePath` rejects has no resolvable permissions, so
    // the note becomes invisible rather than public. Reaching this state needs a file the
    // vault boundary would not serve either, which is why it is asserted here rather than
    // being left to be assumed.
    let mut index = indexed(&[("../escape.md", "# Nope\n")]);
    let access = viewer_everywhere("alice");
    let reader = index.reader(&access, &user("alice")).expect("reader");
    assert_eq!(reader.readable_notes(), 0);
}
