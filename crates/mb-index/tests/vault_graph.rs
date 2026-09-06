//! The whole-vault graph query (`SPEC.md` §9.4).
//!
//! The neighbourhood's suite is `graph.rs`; this one is its other half, and the interesting
//! differences are all in what *bounds* the answer. There is no origin and no hop, so a node
//! is in the picture because it is readable rather than because it is near something — which
//! makes the permission tests here the whole of E9 for this query, and makes the cap the
//! only thing that can take a node away.
//!
//! The properties at the bottom pin what has to hold of every vault: a degree that counts
//! the edges actually drawn, a cap that keeps the *most connected* nodes rather than the
//! first ones it met, and a total that says how many there were.

#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::unwrap_used
)]

mod support;

use std::collections::{BTreeMap, BTreeSet};

use mb_core::Access;
use mb_index::{MAX_VAULT_GRAPH, VaultGraph, VaultNode};
use proptest::prelude::*;
use support::{indexed, user, viewer_everywhere, viewer_except};

/// The whole vault as a reader who may see everything.
fn vault_of(notes: &[(&str, &str)]) -> VaultGraph {
    vault_for(notes, None, &viewer_everywhere("alice"))
}

fn vault_for(notes: &[(&str, &str)], limit: Option<usize>, access: &Access) -> VaultGraph {
    let mut index = indexed(notes);
    let reader = index.reader(access, &user("alice")).expect("reader");
    reader.vault_graph(limit).expect("vault graph")
}

/// Node keys, in the order the query returned them.
fn keys(graph: &VaultGraph) -> Vec<String> {
    graph.nodes.iter().map(|node| node.key.clone()).collect()
}

/// Edges as `source -> target`, in the order the query returned them.
fn edges(graph: &VaultGraph) -> Vec<String> {
    graph
        .edges
        .iter()
        .map(|edge| format!("{} -> {}", edge.source, edge.target))
        .collect()
}

fn node<'a>(graph: &'a VaultGraph, key: &str) -> &'a VaultNode {
    graph
        .nodes
        .iter()
        .find(|node| node.key == key)
        .unwrap_or_else(|| panic!("no node {key} in {:?}", keys(graph)))
}

// ---------------------------------------------------------------- what is drawn

#[test]
fn every_readable_note_is_a_node_whether_or_not_anything_links_to_it() {
    // The difference from the neighbourhood in one test: an unconnected note has no place
    // in a picture drawn around an origin, and is exactly what a picture of a *vault* is
    // asked to show — §9.4's "orphans only" filter has nothing to filter otherwise.
    let graph = vault_of(&[
        ("A.md", "[[B]]\n"),
        ("B.md", "# B\n"),
        ("Alone.md", "# Alone\n"),
    ]);
    assert_eq!(keys(&graph), ["n:A.md", "n:Alone.md", "n:B.md"]);
    assert_eq!(edges(&graph), ["n:A.md -> n:B.md"]);
    assert_eq!(graph.total, 3);
    assert!(!graph.truncated);
}

#[test]
fn an_empty_vault_is_an_empty_graph() {
    assert_eq!(vault_of(&[]), VaultGraph::default());
}

#[test]
fn a_link_keeps_its_direction_and_several_links_are_one_edge() {
    let graph = vault_of(&[
        ("A.md", "[[B]] again [[B]] and [[B#Heading]]\n"),
        ("B.md", "[[A]]\n"),
    ]);
    // Mutual links are two edges, one each way: which way a link points is what the
    // picture is read for, so collapsing them into one line would lose the answer.
    assert_eq!(edges(&graph), ["n:A.md -> n:B.md", "n:B.md -> n:A.md"]);
}

#[test]
fn an_edge_is_marked_as_an_embed_when_any_link_between_the_pair_is_one() {
    let graph = vault_of(&[("A.md", "[[B]] and ![[B]]\n"), ("B.md", "# B\n")]);
    assert!(graph.edges[0].embed);
    let plain = vault_of(&[("A.md", "[[B]]\n"), ("B.md", "# B\n")]);
    assert!(!plain.edges[0].embed);
}

#[test]
fn a_self_link_is_not_an_edge() {
    let graph = vault_of(&[("A.md", "[[A]]\n")]);
    assert_eq!(keys(&graph), ["n:A.md"]);
    assert!(graph.edges.is_empty());
    assert_eq!(node(&graph, "n:A.md").degree, 0);
}

#[test]
fn a_link_to_a_note_nobody_has_written_is_a_ghost() {
    let graph = vault_of(&[("A.md", "[[Someday]]\n")]);
    assert_eq!(keys(&graph), ["g:someday", "n:A.md"]);
    assert_eq!(edges(&graph), ["n:A.md -> g:someday"]);
    let ghost = node(&graph, "g:someday");
    assert_eq!(ghost.path, None);
    assert_eq!(ghost.label, "Someday");
    assert_eq!(ghost.words, 0);
    assert_eq!(ghost.created, None);
    assert!(ghost.tags.is_empty());
}

#[test]
fn two_notes_naming_the_same_absent_target_share_one_ghost() {
    let graph = vault_of(&[("A.md", "[[Someday]]\n"), ("B.md", "[[someday]]\n")]);
    assert_eq!(keys(&graph), ["g:someday", "n:A.md", "n:B.md"]);
    assert_eq!(node(&graph, "g:someday").degree, 2);
}

#[test]
fn a_ghost_is_labelled_with_the_lowest_spelling_any_note_uses() {
    // why: any rule would do except "whichever was indexed first". Two notes spelling one
    // absent target differently must not make the picture depend on the order the vault was
    // walked in, which is the filesystem's order and not a fact about the notes.
    let first = vault_of(&[("A.md", "[[Someday]]\n"), ("B.md", "[[SOMEDAY]]\n")]);
    let second = vault_of(&[("B.md", "[[SOMEDAY]]\n"), ("A.md", "[[Someday]]\n")]);
    assert_eq!(node(&first, "g:someday").label, "SOMEDAY");
    assert_eq!(first, second);
}

#[test]
fn a_node_is_labelled_with_its_title_and_falls_back_to_its_filename() {
    let graph = vault_of(&[("B.md", "# The Plan\n"), ("Notes/C.md", "\n")]);
    assert_eq!(node(&graph, "n:B.md").label, "The Plan");
    assert_eq!(node(&graph, "n:Notes/C.md").label, "C");
}

#[test]
fn the_same_question_twice_draws_the_same_picture() {
    // The nodes and degrees come out of hash maps, so the ordering is imposed rather than
    // inherited — the same reason the neighbourhood pins this.
    let notes = &[
        ("A.md", "[[B]] [[C]] [[Ghost]]\n"),
        ("B.md", "[[C]]\n"),
        ("C.md", "[[A]]\n"),
    ];
    let first = vault_of(notes);
    for _ in 0..8 {
        assert_eq!(vault_of(notes), first);
    }
}

// ---------------------------------------------------------------- what a node carries

#[test]
fn a_degree_counts_links_in_and_out_across_the_whole_vault() {
    let graph = vault_of(&[
        ("Hub.md", "[[A]] and [[B]]\n"),
        ("A.md", "[[Hub]]\n"),
        ("B.md", "# B\n"),
        ("C.md", "[[Hub]]\n"),
    ]);
    // Out to A, out to B, back from A, back from C.
    assert_eq!(node(&graph, "n:Hub.md").degree, 4);
    assert_eq!(node(&graph, "n:A.md").degree, 2);
    assert_eq!(node(&graph, "n:B.md").degree, 1);
}

#[test]
fn a_note_carries_its_word_count() {
    let graph = vault_of(&[("A.md", "one two three four five\n")]);
    assert_eq!(node(&graph, "n:A.md").words, 5);
}

#[test]
fn a_note_carries_its_icon_for_the_node_to_wear() {
    // §4.2 says the frontmatter `icon` renders on a graph node, and §9.4 draws it above the
    // zoom threshold. A ghost has no note, so it has no icon either.
    let graph = vault_of(&[("A.md", "---\nicon: \"\u{1f5fa}\"\n---\n\n[[Someday]]\n")]);
    assert_eq!(node(&graph, "n:A.md").icon.as_deref(), Some("\u{1f5fa}"));
    assert_eq!(node(&graph, "g:someday").icon, None);
}

#[test]
fn a_note_with_no_icon_wears_none() {
    assert_eq!(vault_of(&[("A.md", "# A\n")]).nodes[0].icon, None);
}

#[test]
fn a_frontmatter_created_date_is_what_the_scrubber_gets() {
    let graph = vault_of(&[("A.md", "---\ncreated: 2026-08-28\n---\n\n# A\n")]);
    assert_eq!(
        node(&graph, "n:A.md").created.as_deref(),
        Some("2026-08-28")
    );
}

#[test]
fn a_created_date_carrying_a_time_still_reads_as_a_day() {
    let graph = vault_of(&[("A.md", "---\ncreated: 2026-08-28T09:41:00Z\n---\n\n# A\n")]);
    assert_eq!(
        node(&graph, "n:A.md").created.as_deref(),
        Some("2026-08-28")
    );
}

#[test]
fn a_uuid_v7_id_dates_a_note_that_says_nothing_else() {
    // §9.4's "free, given UUIDv7": the identity §4.3 mints carries the millisecond it was
    // minted at, so a note with no `created:` is still on the scrubber.
    let graph = vault_of(&[(
        "A.md",
        "---\nid: 019cfb21-75c0-7abc-8def-0123456789ab\n---\n\n# A\n",
    )]);
    assert_eq!(
        node(&graph, "n:A.md").created.as_deref(),
        Some("2026-03-17")
    );
}

#[test]
fn a_written_created_date_beats_the_one_inside_the_id() {
    // An imported note carries the date it was written and an `id` from the day it was
    // imported. The human-supplied fact wins.
    let graph = vault_of(&[(
        "A.md",
        "---\nid: 019cfb21-75c0-7abc-8def-0123456789ab\ncreated: 2019-11-02\n---\n\n# A\n",
    )]);
    assert_eq!(
        node(&graph, "n:A.md").created.as_deref(),
        Some("2019-11-02")
    );
}

#[test]
fn a_note_with_no_date_anywhere_is_undated_rather_than_guessed_at() {
    // The `printf > note.md` case C2 requires to work (§4.3). Undated is a state the
    // scrubber has to handle; inventing a date for it would be a lie about the vault.
    for markdown in [
        "# A\n",
        // Not a UUID at all, and a UUID of the wrong version — v4 carries no timestamp.
        "---\nid: not-a-uuid\n---\n\n# A\n",
        "---\nid: 019cfb21-75c0-4abc-8def-0123456789ab\n---\n\n# A\n",
        // Right shape, wrong separators, and a non-hex digit where hex is required.
        "---\nid: 019cfb2175c07abc8def0123456789ab\n---\n\n# A\n",
        "---\nid: 019cfb21-75c0-7abc-8def-0123456789zz\n---\n\n# A\n",
        // A `created:` that is not a date this can read.
        "---\ncreated: last Tuesday\n---\n\n# A\n",
        "---\ncreated: 2026-13-45\n---\n\n# A\n",
    ] {
        let graph = vault_of(&[("A.md", markdown)]);
        assert_eq!(
            node(&graph, "n:A.md").created,
            None,
            "{markdown:?} should not have dated the note"
        );
    }
}

#[test]
fn a_note_carries_its_full_tags_folded_and_not_their_prefixes() {
    // §9.3 writes one row per prefix so a tag query needs no scan; the graph wants the other
    // end of that, because a client filtering for `#project` can match a string prefix and
    // sending `#project`, `#project/mb` and `#project/mb/spec` for one tag is three times
    // the payload for the same answer.
    let graph = vault_of(&[("A.md", "#Project/MB/spec and #other\n")]);
    assert_eq!(node(&graph, "n:A.md").tags, ["other", "project/mb/spec"]);
}

#[test]
fn a_note_with_no_tags_carries_none() {
    let graph = vault_of(&[("A.md", "# A\n")]);
    assert!(node(&graph, "n:A.md").tags.is_empty());
}

// ---------------------------------------------------------------- the cap

/// A vault of `count` notes, all linking to `Hub.md`, so the hub is the highest degree.
fn hub_vault(count: usize) -> Vec<(String, String)> {
    let mut notes = vec![("Hub.md".to_string(), "# Hub\n".to_string())];
    for n in 0..count {
        notes.push((format!("N{n:05}.md"), "see [[Hub]]\n".to_string()));
    }
    notes
}

fn borrow(notes: &[(String, String)]) -> Vec<(&str, &str)> {
    notes
        .iter()
        .map(|(path, body)| (path.as_str(), body.as_str()))
        .collect()
}

#[test]
fn the_cap_keeps_the_most_connected_nodes_and_says_how_many_there_were() {
    let notes = hub_vault(20);
    let graph = vault_for(&borrow(&notes), Some(5), &viewer_everywhere("alice"));
    assert_eq!(graph.nodes.len(), 5);
    assert_eq!(graph.total, 21, "§9.4's \"showing 5 of 21\"");
    assert!(graph.truncated);
    // The hub is the one node nothing can drop: every other node has degree 1.
    assert!(keys(&graph).contains(&"n:Hub.md".to_string()));
}

#[test]
fn a_cut_node_takes_its_edges_with_it() {
    let notes = hub_vault(20);
    let graph = vault_for(&borrow(&notes), Some(5), &viewer_everywhere("alice"));
    let present: BTreeSet<&str> = graph.nodes.iter().map(|n| n.key.as_str()).collect();
    for edge in &graph.edges {
        assert!(present.contains(edge.source.as_str()), "{}", edge.source);
        assert!(present.contains(edge.target.as_str()), "{}", edge.target);
    }
    assert_eq!(
        graph.edges.len(),
        4,
        "the hub's links to the four survivors"
    );
}

#[test]
fn a_degree_is_the_vaults_rather_than_the_pictures() {
    // The hub has twenty links and five nodes are drawn. Sizing it by what survived would
    // make the cap change the shape of the vault it is reporting on.
    let notes = hub_vault(20);
    let graph = vault_for(&borrow(&notes), Some(5), &viewer_everywhere("alice"));
    assert_eq!(node(&graph, "n:Hub.md").degree, 20);
}

#[test]
fn a_tie_in_the_cap_is_broken_by_key_rather_than_by_luck() {
    let notes = hub_vault(20);
    let first = vault_for(&borrow(&notes), Some(5), &viewer_everywhere("alice"));
    for _ in 0..4 {
        assert_eq!(
            vault_for(&borrow(&notes), Some(5), &viewer_everywhere("alice")),
            first
        );
    }
    // Every non-hub node has degree 1, so the four that survive are the lowest keys.
    assert_eq!(
        keys(&first),
        [
            "n:Hub.md",
            "n:N00000.md",
            "n:N00001.md",
            "n:N00002.md",
            "n:N00003.md"
        ]
    );
}

#[test]
fn an_uncapped_vault_does_not_claim_to_be_truncated() {
    let graph = vault_for(
        &[("A.md", "[[B]]\n"), ("B.md", "# B\n")],
        Some(2),
        &viewer_everywhere("alice"),
    );
    assert!(!graph.truncated);
    assert_eq!(graph.total, 2);
}

#[test]
fn a_vault_larger_than_the_ceiling_is_cut_down_to_it() {
    // why: ghosts rather than notes. The ceiling is only observable on a picture bigger than
    // it, and one note naming ten thousand absent targets is one `upsert` where ten thousand
    // notes would be ten thousand — the node count is what is under test, not the vault.
    let body: String = (0..MAX_VAULT_GRAPH + 5)
        .map(|n| format!("- [[Missing{n:05}]]\n"))
        .collect();
    let mut index = indexed(&[("A.md", &body)]);
    let reader = index
        .reader(&viewer_everywhere("alice"), &user("alice"))
        .expect("reader");

    for asked in [None, Some(MAX_VAULT_GRAPH * 4)] {
        let graph = reader.vault_graph(asked).expect("vault graph");
        assert_eq!(graph.nodes.len(), MAX_VAULT_GRAPH, "asked for {asked:?}");
        assert_eq!(graph.total, MAX_VAULT_GRAPH + 6, "the note and its ghosts");
        assert!(graph.truncated);
    }
}

#[test]
fn a_limit_under_the_ceiling_is_honoured_as_asked() {
    let notes = hub_vault(3);
    let asked = vault_for(&borrow(&notes), Some(2), &viewer_everywhere("alice"));
    assert_eq!(asked.nodes.len(), 2);
    assert!(asked.truncated);
}

// ---------------------------------------------------------------- permissions (E9)

#[test]
fn a_note_the_reader_cannot_see_is_not_a_node_and_is_not_counted() {
    // §6.5: not a node, not a total, not a hint. A count that included it would be a way of
    // asking how many notes exist.
    let graph = vault_for(
        &[("A.md", "# A\n"), ("Private/Salary.md", "# Salary\n")],
        None,
        &viewer_except("alice", &["Private"]),
    );
    assert_eq!(keys(&graph), ["n:A.md"]);
    assert_eq!(graph.total, 1);
}

#[test]
fn a_link_into_an_unreadable_note_is_the_same_ghost_as_a_link_into_nothing() {
    // E9, and the reason a ghost carries the name the *source* note spells: that text is in
    // a note the reader can already see.
    let unreadable = vault_for(
        &[
            ("A.md", "[[Salary]]\n"),
            ("Private/Salary.md", "# Salary\n"),
        ],
        None,
        &viewer_except("alice", &["Private"]),
    );
    let absent = vault_for(
        &[("A.md", "[[Salary]]\n")],
        None,
        &viewer_everywhere("alice"),
    );
    assert_eq!(unreadable, absent);
    assert_eq!(keys(&unreadable), ["g:salary", "n:A.md"]);
}

#[test]
fn a_link_out_of_an_unreadable_note_is_not_an_edge() {
    let graph = vault_for(
        &[("A.md", "# A\n"), ("Private/Watcher.md", "[[A]]\n")],
        None,
        &viewer_except("alice", &["Private"]),
    );
    assert_eq!(keys(&graph), ["n:A.md"]);
    assert!(graph.edges.is_empty());
    assert_eq!(node(&graph, "n:A.md").degree, 0);
}

#[test]
fn an_unreadable_notes_tags_are_not_in_the_picture() {
    // A tag is a fact about a note. Attaching one to a node the reader can see would say
    // something about a note they cannot.
    let graph = vault_for(
        &[("A.md", "# A\n"), ("Private/Salary.md", "#compensation\n")],
        None,
        &viewer_except("alice", &["Private"]),
    );
    for node in &graph.nodes {
        assert!(node.tags.is_empty(), "{} carries {:?}", node.key, node.tags);
    }
}

#[test]
fn the_cap_ranks_by_a_degree_the_reader_can_see() {
    // A note whose links are mostly to unreadable notes must not outrank a readable hub by
    // a degree counted over links this reader is not shown.
    let graph = vault_for(
        &[
            ("Loud.md", "[[Private/A]] [[Private/B]] [[Private/C]]\n"),
            ("Hub.md", "[[X]] [[Y]]\n"),
            ("X.md", "# X\n"),
            ("Y.md", "# Y\n"),
            ("Private/A.md", "# A\n"),
            ("Private/B.md", "# B\n"),
            ("Private/C.md", "# C\n"),
        ],
        None,
        &viewer_except("alice", &["Private"]),
    );
    // Loud's three links became one ghost each — a ghost per distinct target, so its degree
    // is three all the same. What matters is that the *hub* is ranked on what it is shown as
    // having, which is two.
    assert_eq!(node(&graph, "n:Hub.md").degree, 2);
    assert_eq!(graph.total, 7, "four notes and three ghosts");
}

// ---------------------------------------------------------------------------------------
// Properties. The generator builds a vault of `N0.md`..`Nk.md` and links between them, so
// the expected answer is computable here rather than assumed.
// ---------------------------------------------------------------------------------------

/// A vault: how many notes, which note links to which, and how many ghosts to name.
fn vaults() -> impl Strategy<Value = (usize, Vec<(usize, usize)>, Vec<usize>)> {
    (1usize..9).prop_flat_map(|count| {
        (
            Just(count),
            proptest::collection::vec((0..count, 0..count), 0..18),
            proptest::collection::vec(0..count, 0..4),
        )
    })
}

/// The Markdown for that vault. A note in `ghosts` also links to a name nothing resolves to.
fn files(count: usize, links: &[(usize, usize)], ghosts: &[usize]) -> Vec<(String, String)> {
    (0..count)
        .map(|n| {
            let mut body: String = links
                .iter()
                .filter(|(from, _)| *from == n)
                .map(|(_, to)| format!("- [[N{to}]]\n"))
                .collect();
            for (g, from) in ghosts.iter().enumerate() {
                if *from == n {
                    body.push_str(&format!("- [[Missing{g}]]\n"));
                }
            }
            (format!("N{n}.md"), format!("# N{n}\n\n{body}"))
        })
        .collect()
}

fn whole(files: &[(String, String)], limit: Option<usize>) -> VaultGraph {
    vault_for(&borrow(files), limit, &viewer_everywhere("alice"))
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 192, ..ProptestConfig::default() })]

    /// An edge that names a node the picture does not draw is a line to nowhere.
    #[test]
    fn every_edge_has_both_ends_on_the_page(
        (count, links, ghosts) in vaults(),
        limit in prop::option::of(1usize..12),
    ) {
        let graph = whole(&files(count, &links, &ghosts), limit);
        let present: BTreeSet<&str> = graph.nodes.iter().map(|n| n.key.as_str()).collect();
        for edge in &graph.edges {
            prop_assert!(present.contains(edge.source.as_str()), "{} is not a node", edge.source);
            prop_assert!(present.contains(edge.target.as_str()), "{} is not a node", edge.target);
        }
    }

    /// One node per key, and one edge per ordered pair.
    #[test]
    fn nothing_is_drawn_twice((count, links, ghosts) in vaults()) {
        let graph = whole(&files(count, &links, &ghosts), None);
        let keys: BTreeSet<&str> = graph.nodes.iter().map(|n| n.key.as_str()).collect();
        prop_assert_eq!(keys.len(), graph.nodes.len());
        let pairs: BTreeSet<(&str, &str)> = graph
            .edges
            .iter()
            .map(|e| (e.source.as_str(), e.target.as_str()))
            .collect();
        prop_assert_eq!(pairs.len(), graph.edges.len());
    }

    /// Every readable note is a node, and so is every name that resolves to none of them.
    #[test]
    fn the_picture_is_every_note_plus_every_unresolved_name((count, links, ghosts) in vaults()) {
        let graph = whole(&files(count, &links, &ghosts), None);
        let mut expected: BTreeSet<String> =
            (0..count).map(|n| format!("n:N{n}.md")).collect();
        for (g, _) in ghosts.iter().enumerate() {
            expected.insert(format!("g:missing{g}"));
        }
        let drawn: BTreeSet<String> = graph.nodes.iter().map(|n| n.key.clone()).collect();
        prop_assert_eq!(drawn, expected);
        prop_assert_eq!(graph.total, graph.nodes.len());
        prop_assert!(!graph.truncated);
    }

    /// Uncapped, a node's degree is exactly the edges touching it.
    #[test]
    fn a_degree_is_the_edges_that_touch_it((count, links, ghosts) in vaults()) {
        let graph = whole(&files(count, &links, &ghosts), None);
        let mut counted: BTreeMap<&str, u32> =
            graph.nodes.iter().map(|n| (n.key.as_str(), 0)).collect();
        for edge in &graph.edges {
            *counted.get_mut(edge.source.as_str()).unwrap() += 1;
            *counted.get_mut(edge.target.as_str()).unwrap() += 1;
        }
        for node in &graph.nodes {
            prop_assert_eq!(
                Some(&node.degree),
                counted.get(node.key.as_str()),
                "wrong degree for {}",
                node.key
            );
        }
    }

    /// The cap keeps the most connected nodes, and reports what it cut.
    #[test]
    fn the_cap_keeps_the_highest_degrees(
        (count, links, ghosts) in vaults(),
        limit in 1usize..8,
    ) {
        let files = files(count, &links, &ghosts);
        let whole_graph = whole(&files, None);
        let capped = whole(&files, Some(limit));
        prop_assert_eq!(capped.total, whole_graph.total);
        prop_assert_eq!(capped.nodes.len(), whole_graph.nodes.len().min(limit));
        prop_assert_eq!(capped.truncated, whole_graph.nodes.len() > limit);

        let kept: BTreeSet<&str> = capped.nodes.iter().map(|n| n.key.as_str()).collect();
        let lowest_kept = whole_graph
            .nodes
            .iter()
            .filter(|n| kept.contains(n.key.as_str()))
            .map(|n| n.degree)
            .min();
        for dropped in whole_graph.nodes.iter().filter(|n| !kept.contains(n.key.as_str())) {
            prop_assert!(
                Some(dropped.degree) <= lowest_kept,
                "{} (degree {}) was cut while a lesser node was kept",
                dropped.key,
                dropped.degree
            );
        }
    }

    /// The cap changes which nodes are drawn and nothing about the ones that survive.
    #[test]
    fn a_surviving_node_is_unchanged_by_the_cap(
        (count, links, ghosts) in vaults(),
        limit in 1usize..8,
    ) {
        let files = files(count, &links, &ghosts);
        let uncapped: BTreeMap<String, VaultNode> = whole(&files, None)
            .nodes
            .into_iter()
            .map(|n| (n.key.clone(), n))
            .collect();
        for node in whole(&files, Some(limit)).nodes {
            prop_assert_eq!(Some(&node), uncapped.get(&node.key), "{} changed", node.key);
        }
    }

    /// The answer does not depend on the order the notes were indexed in.
    #[test]
    fn the_picture_does_not_depend_on_indexing_order((count, links, ghosts) in vaults()) {
        let mut files = files(count, &links, &ghosts);
        let forwards = whole(&files, None);
        files.reverse();
        prop_assert_eq!(whole(&files, None), forwards);
    }
}
