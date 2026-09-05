//! The n-hop neighbourhood query (`SPEC.md` §9.4).
//!
//! Two halves. The examples below pin the decisions — direction, ghosts, collapsing,
//! the cap — and the property suite at the bottom pins the things that have to be true of
//! *every* link structure, which is where the interesting failures live: a hop number that
//! is not a distance, an edge pointing at a node that is not drawn, a two-hop picture that
//! does not contain the one-hop picture it grew from.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

mod support;

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use mb_core::Access;
use mb_index::{Graph, MAX_HOPS, MAX_NEIGHBOURHOOD};
use proptest::prelude::*;
use support::{indexed, user, viewer_everywhere, viewer_except};

/// The neighbourhood of `path` as a reader who may see everything.
fn graph_of(notes: &[(&str, &str)], path: &str, hops: u8) -> Graph {
    graph_for(notes, path, hops, &viewer_everywhere("alice"))
}

fn graph_for(notes: &[(&str, &str)], path: &str, hops: u8, access: &Access) -> Graph {
    let mut index = indexed(notes);
    let reader = index.reader(access, &user("alice")).expect("reader");
    reader.neighbourhood(path, hops).expect("neighbourhood")
}

/// Node keys, in the order the query returned them.
fn keys(graph: &Graph) -> Vec<String> {
    graph.nodes.iter().map(|node| node.key.clone()).collect()
}

/// Edges as `source -> target`, in the order the query returned them.
fn edges(graph: &Graph) -> Vec<String> {
    graph
        .edges
        .iter()
        .map(|edge| format!("{} -> {}", edge.source, edge.target))
        .collect()
}

#[test]
fn one_hop_shows_the_notes_the_origin_links_to() {
    let graph = graph_of(
        &[
            ("Roadmap.md", "see [[Q3]] and [[Q4]]\n"),
            ("Q3.md", "# Q3\n"),
            ("Q4.md", "# Q4\n"),
        ],
        "Roadmap.md",
        1,
    );
    assert_eq!(keys(&graph), ["n:Roadmap.md", "n:Q3.md", "n:Q4.md"]);
    assert_eq!(
        edges(&graph),
        ["n:Roadmap.md -> n:Q3.md", "n:Roadmap.md -> n:Q4.md"]
    );
}

#[test]
fn one_hop_shows_the_notes_that_link_to_the_origin() {
    // The walk ignores direction — a note that links *to* this one is as much a neighbour —
    // while the edge keeps it, which is what the picture is read for.
    let graph = graph_of(
        &[
            ("Roadmap.md", "# Roadmap\n"),
            ("Q3.md", "see [[Roadmap]]\n"),
        ],
        "Roadmap.md",
        1,
    );
    assert_eq!(keys(&graph), ["n:Roadmap.md", "n:Q3.md"]);
    assert_eq!(edges(&graph), ["n:Q3.md -> n:Roadmap.md"]);
}

#[test]
fn a_second_hop_reaches_a_neighbours_neighbour() {
    let notes = &[("A.md", "[[B]]\n"), ("B.md", "[[C]]\n"), ("C.md", "# C\n")];
    assert_eq!(keys(&graph_of(notes, "A.md", 1)), ["n:A.md", "n:B.md"]);
    assert_eq!(
        keys(&graph_of(notes, "A.md", 2)),
        ["n:A.md", "n:B.md", "n:C.md"]
    );
}

#[test]
fn a_hop_number_is_a_distance_not_an_order_of_discovery() {
    // `C` is two links away along one path and one away along another. The nearer answer is
    // the true one, and a walk that recorded whichever it met first would say otherwise.
    let graph = graph_of(
        &[
            ("A.md", "[[B]] and [[C]]\n"),
            ("B.md", "[[C]]\n"),
            ("C.md", "# C\n"),
        ],
        "A.md",
        2,
    );
    let hops: BTreeMap<&str, u8> = graph
        .nodes
        .iter()
        .map(|node| (node.key.as_str(), node.hop))
        .collect();
    assert_eq!(hops["n:C.md"], 1);
}

#[test]
fn every_link_between_two_shown_notes_is_drawn() {
    // The reason the query has a second phase. `B` and `C` are both one hop from `A`; the
    // link between *them* is found by expanding neither, so a walk that collected edges as
    // it went would draw them as two unconnected dots.
    let graph = graph_of(
        &[
            ("A.md", "[[B]] and [[C]]\n"),
            ("B.md", "[[C]]\n"),
            ("C.md", "# C\n"),
        ],
        "A.md",
        1,
    );
    assert!(edges(&graph).contains(&"n:B.md -> n:C.md".to_string()));
}

#[test]
fn a_link_out_of_the_outermost_ring_draws_no_node_beyond_it() {
    // The complement of the test above: filling in the edges must not smuggle in a node the
    // hop limit excluded, or `hops` would mean one more than it says.
    let graph = graph_of(
        &[("A.md", "[[B]]\n"), ("B.md", "[[C]]\n"), ("C.md", "# C\n")],
        "A.md",
        1,
    );
    assert_eq!(keys(&graph), ["n:A.md", "n:B.md"]);
    assert_eq!(edges(&graph), ["n:A.md -> n:B.md"]);
}

#[test]
fn several_links_between_one_pair_are_one_edge() {
    let graph = graph_of(
        &[
            ("A.md", "[[B]] again [[B]] and [[B#Heading]]\n"),
            ("B.md", "# B\n"),
        ],
        "A.md",
        1,
    );
    assert_eq!(edges(&graph), ["n:A.md -> n:B.md"]);
}

#[test]
fn an_edge_is_marked_as_an_embed_when_any_link_between_the_pair_is_one() {
    let graph = graph_of(
        &[("A.md", "[[B]] and ![[B]]\n"), ("B.md", "# B\n")],
        "A.md",
        1,
    );
    assert!(graph.edges[0].embed);
}

#[test]
fn an_ordinary_link_is_not_an_embed() {
    let graph = graph_of(&[("A.md", "[[B]]\n"), ("B.md", "# B\n")], "A.md", 1);
    assert!(!graph.edges[0].embed);
}

#[test]
fn a_self_link_is_not_an_edge() {
    let graph = graph_of(&[("A.md", "[[A]]\n")], "A.md", 1);
    assert_eq!(keys(&graph), ["n:A.md"]);
    assert!(graph.edges.is_empty());
}

#[test]
fn a_link_to_a_note_nobody_has_written_is_a_ghost() {
    let graph = graph_of(&[("A.md", "[[Someday]]\n")], "A.md", 1);
    assert_eq!(keys(&graph), ["n:A.md", "g:someday"]);
    assert_eq!(edges(&graph), ["n:A.md -> g:someday"]);
    let ghost = &graph.nodes[1];
    assert_eq!(ghost.path, None);
    assert_eq!(ghost.label, "Someday");
}

#[test]
fn two_notes_naming_the_same_absent_target_share_one_ghost() {
    let graph = graph_of(
        &[
            ("A.md", "[[B]] and [[Someday]]\n"),
            ("B.md", "[[someday]]\n"),
        ],
        "A.md",
        1,
    );
    // Ghosts and notes are one ordering, by key within a hop — `g:` before `n:`.
    assert_eq!(keys(&graph), ["n:A.md", "g:someday", "n:B.md"]);
    assert_eq!(
        edges(&graph),
        [
            "n:A.md -> g:someday",
            "n:A.md -> n:B.md",
            "n:B.md -> g:someday"
        ]
    );
}

#[test]
fn a_ghost_keeps_the_shortest_distance_to_it() {
    // The same rule as a note: a ghost named by the origin *and* by a neighbour is one hop
    // away, not two. Reached only by the guard that refuses to overwrite a ghost already
    // placed — nothing else in the walk would notice.
    let graph = graph_of(
        &[
            ("A.md", "[[B]] and [[Someday]]\n"),
            ("B.md", "[[Someday]]\n"),
        ],
        "A.md",
        2,
    );
    let ghost = graph
        .nodes
        .iter()
        .find(|node| node.key == "g:someday")
        .expect("the ghost");
    assert_eq!(ghost.hop, 1);
}

#[test]
fn a_ghost_is_a_leaf_and_expands_no_further() {
    // Nothing resolves to it, so nothing can link out of it — the walk must not treat its
    // name as a note and go looking.
    let graph = graph_of(
        &[("A.md", "[[Someday]]\n"), ("Elsewhere.md", "[[Someday]]\n")],
        "A.md",
        2,
    );
    assert_eq!(keys(&graph), ["n:A.md", "g:someday"]);
}

#[test]
fn a_note_with_no_links_is_a_graph_of_one_node() {
    let graph = graph_of(&[("A.md", "# A\n"), ("B.md", "# B\n")], "A.md", 3);
    assert_eq!(keys(&graph), ["n:A.md"]);
    assert!(graph.edges.is_empty());
    assert!(!graph.truncated);
}

#[test]
fn a_note_that_is_not_in_the_index_has_an_empty_graph() {
    let graph = graph_of(&[("A.md", "# A\n")], "Missing.md", 1);
    assert_eq!(graph, Graph::default());
}

#[test]
fn a_node_is_labelled_with_its_title_and_falls_back_to_its_filename() {
    let graph = graph_of(
        &[
            ("A.md", "[[B]] and [[Notes/C]]\n"),
            ("B.md", "# The Plan\n"),
            // Nothing titleable: no heading and no text (§9.1's `title` is nullable).
            ("Notes/C.md", "\n"),
        ],
        "A.md",
        1,
    );
    let labels: BTreeMap<&str, &str> = graph
        .nodes
        .iter()
        .map(|node| (node.key.as_str(), node.label.as_str()))
        .collect();
    assert_eq!(labels["n:B.md"], "The Plan");
    assert_eq!(labels["n:Notes/C.md"], "C");
}

#[test]
fn a_filename_loses_one_extension_and_not_every_one_it_ends_with() {
    // A note called `Odd.md.md` is labelled `Odd.md`: `trim_end_matches` strips *every*
    // trailing occurrence and would label it `Odd`, which names a different file. Linked by
    // full path, so the link resolves to the note rather than becoming a ghost that happens
    // to carry the same text.
    let graph = graph_of(
        &[("A.md", "# A\n\n[[Odd.md.md]]\n"), ("Odd.md.md", "\n")],
        "A.md",
        1,
    );
    let node = graph
        .nodes
        .iter()
        .find(|node| node.path.as_deref() == Some("Odd.md.md"))
        .expect("the note, not a ghost");
    assert_eq!(node.label, "Odd.md");
}

#[test]
fn hops_are_clamped_to_the_range_the_spec_offers() {
    let notes = &[
        ("A.md", "[[B]]\n"),
        ("B.md", "[[C]]\n"),
        ("C.md", "[[D]]\n"),
        ("D.md", "[[E]]\n"),
        ("E.md", "# E\n"),
    ];
    // Zero hops would be a picture of one dot, which answers nothing.
    assert_eq!(
        keys(&graph_of(notes, "A.md", 0)),
        keys(&graph_of(notes, "A.md", 1))
    );
    assert_eq!(
        keys(&graph_of(notes, "A.md", 250)),
        keys(&graph_of(notes, "A.md", MAX_HOPS))
    );
    assert_eq!(graph_of(notes, "A.md", MAX_HOPS).nodes.len(), 4);
}

#[test]
fn the_node_cap_cuts_the_neighbourhood_short_and_says_so() {
    let mut notes: Vec<(String, String)> = vec![("Hub.md".to_string(), "# Hub\n".to_string())];
    for n in 0..MAX_NEIGHBOURHOOD + 50 {
        notes.push((format!("N{n}.md"), "see [[Hub]]\n".to_string()));
    }
    let borrowed: Vec<(&str, &str)> = notes
        .iter()
        .map(|(path, body)| (path.as_str(), body.as_str()))
        .collect();
    let graph = graph_of(&borrowed, "Hub.md", 1);
    assert_eq!(graph.nodes.len(), MAX_NEIGHBOURHOOD);
    assert!(graph.truncated);
    // Every edge still has both ends on the page — a cut node takes its edges with it.
    let present: BTreeSet<&str> = graph.nodes.iter().map(|n| n.key.as_str()).collect();
    for edge in &graph.edges {
        assert!(present.contains(edge.source.as_str()));
        assert!(present.contains(edge.target.as_str()));
    }
}

#[test]
fn an_uncapped_neighbourhood_does_not_claim_to_be_truncated() {
    assert!(!graph_of(&[("A.md", "[[B]]\n"), ("B.md", "# B\n")], "A.md", 3).truncated);
}

#[test]
fn a_note_the_reader_cannot_see_has_no_graph_at_all() {
    // §6.5: the same answer a note nobody wrote gets, so the two are indistinguishable.
    let graph = graph_for(
        &[("Private/Salary.md", "[[A]]\n"), ("A.md", "# A\n")],
        "Private/Salary.md",
        1,
        &viewer_except("alice", &["Private"]),
    );
    assert_eq!(graph, Graph::default());
}

#[test]
fn a_link_into_an_unreadable_note_is_the_same_ghost_as_a_link_into_nothing() {
    // E9. The picture must not be able to say "there is a note here you may not read", so
    // an unreadable target and an unwritten one are one shape.
    let unreadable = graph_for(
        &[
            ("A.md", "[[Salary]]\n"),
            ("Private/Salary.md", "# Salary\n"),
        ],
        "A.md",
        2,
        &viewer_except("alice", &["Private"]),
    );
    let absent = graph_for(
        &[("A.md", "[[Salary]]\n")],
        "A.md",
        2,
        &viewer_everywhere("alice"),
    );
    assert_eq!(unreadable, absent);
    assert_eq!(keys(&unreadable), ["n:A.md", "g:salary"]);
}

#[test]
fn a_note_reachable_only_through_an_unreadable_one_is_not_in_the_graph() {
    // The path A → Private → C exists in the files and not in this reader's graph: an edge
    // into a note they cannot read is never formed, so there is nothing to walk through.
    let graph = graph_for(
        &[
            ("A.md", "[[Private/Middle]]\n"),
            ("Private/Middle.md", "[[C]]\n"),
            ("C.md", "# C\n"),
        ],
        "A.md",
        3,
        &viewer_except("alice", &["Private"]),
    );
    assert_eq!(keys(&graph), ["n:A.md", "g:private/middle"]);
}

#[test]
fn a_backlink_from_an_unreadable_note_is_not_an_edge() {
    let graph = graph_for(
        &[("A.md", "# A\n"), ("Private/Watcher.md", "[[A]]\n")],
        "A.md",
        1,
        &viewer_except("alice", &["Private"]),
    );
    assert_eq!(keys(&graph), ["n:A.md"]);
    assert!(graph.edges.is_empty());
}

#[test]
fn the_same_question_twice_draws_the_same_picture() {
    // The nodes come out of a hash map, so the ordering is imposed rather than inherited.
    let notes = &[
        ("A.md", "[[B]] [[C]] [[D]] [[Ghost]]\n"),
        ("B.md", "[[C]]\n"),
        ("C.md", "[[D]]\n"),
        ("D.md", "[[A]]\n"),
    ];
    let first = graph_of(notes, "A.md", 3);
    for _ in 0..8 {
        assert_eq!(graph_of(notes, "A.md", 3), first);
    }
}

// ---------------------------------------------------------------------------------------
// Properties. The generator builds a vault of `N0.md`..`Nk.md` and a set of directed links
// between them, which makes the expected answer computable here rather than assumed.
// ---------------------------------------------------------------------------------------

/// A vault: how many notes, and which note links to which.
fn vaults() -> impl Strategy<Value = (usize, Vec<(usize, usize)>)> {
    (2usize..8).prop_flat_map(|count| {
        let pairs = proptest::collection::vec((0..count, 0..count), 0..14);
        (Just(count), pairs)
    })
}

/// The Markdown for that vault.
fn files(count: usize, links: &[(usize, usize)]) -> Vec<(String, String)> {
    (0..count)
        .map(|n| {
            let body: String = links
                .iter()
                .filter(|(from, _)| *from == n)
                .map(|(_, to)| format!("- [[N{to}]]\n"))
                .collect();
            (format!("N{n}.md"), format!("# N{n}\n\n{body}"))
        })
        .collect()
}

fn neighbourhood(files: &[(String, String)], origin: &str, hops: u8) -> Graph {
    let borrowed: Vec<(&str, &str)> = files
        .iter()
        .map(|(path, body)| (path.as_str(), body.as_str()))
        .collect();
    graph_of(&borrowed, origin, hops)
}

/// Shortest distance from `origin` to every note, ignoring link direction — the oracle the
/// hop numbers are checked against.
fn distances(count: usize, links: &[(usize, usize)], origin: usize) -> BTreeMap<usize, u8> {
    let mut adjacent: BTreeMap<usize, BTreeSet<usize>> = BTreeMap::new();
    for (from, to) in links {
        if from == to {
            continue;
        }
        adjacent.entry(*from).or_default().insert(*to);
        adjacent.entry(*to).or_default().insert(*from);
    }
    let mut seen = BTreeMap::from([(origin, 0u8)]);
    let mut queue = VecDeque::from([origin]);
    while let Some(note) = queue.pop_front() {
        let hop = seen[&note];
        for next in adjacent.get(&note).into_iter().flatten() {
            if *next < count && !seen.contains_key(next) {
                seen.insert(*next, hop + 1);
                queue.push_back(*next);
            }
        }
    }
    seen
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 192, ..ProptestConfig::default() })]

    /// An edge that names a node the picture does not draw is a line to nowhere.
    #[test]
    fn every_edge_has_both_ends_on_the_page((count, links) in vaults(), hops in 1u8..=MAX_HOPS) {
        let graph = neighbourhood(&files(count, &links), "N0.md", hops);
        let present: BTreeSet<&str> = graph.nodes.iter().map(|n| n.key.as_str()).collect();
        for edge in &graph.edges {
            prop_assert!(present.contains(edge.source.as_str()), "{} is not a node", edge.source);
            prop_assert!(present.contains(edge.target.as_str()), "{} is not a node", edge.target);
        }
    }

    /// A hop number is the shortest distance from the origin, not the order of discovery.
    #[test]
    fn a_hop_is_the_shortest_distance((count, links) in vaults(), hops in 1u8..=MAX_HOPS) {
        let graph = neighbourhood(&files(count, &links), "N0.md", hops);
        let expected = distances(count, &links, 0);
        for node in &graph.nodes {
            let Some(path) = &node.path else { continue };
            let n: usize = path.trim_start_matches('N').trim_end_matches(".md").parse().unwrap();
            prop_assert_eq!(Some(&node.hop), expected.get(&n), "wrong hop for {}", path);
            prop_assert!(node.hop <= hops);
        }
    }

    /// Every note within `hops` links is drawn, and no note beyond it is.
    #[test]
    fn the_graph_is_exactly_the_notes_within_reach((count, links) in vaults(), hops in 1u8..=MAX_HOPS) {
        let graph = neighbourhood(&files(count, &links), "N0.md", hops);
        prop_assume!(!graph.truncated);
        let drawn: BTreeSet<String> = graph.nodes.iter().filter_map(|n| n.path.clone()).collect();
        let expected: BTreeSet<String> = distances(count, &links, 0)
            .into_iter()
            .filter(|(_, hop)| *hop <= hops)
            .map(|(n, _)| format!("N{n}.md"))
            .collect();
        prop_assert_eq!(drawn, expected);
    }

    /// Every link between two drawn notes is drawn — the outermost ring included.
    #[test]
    fn no_link_between_two_drawn_notes_is_missing((count, links) in vaults(), hops in 1u8..=MAX_HOPS) {
        let graph = neighbourhood(&files(count, &links), "N0.md", hops);
        prop_assume!(!graph.truncated);
        let drawn: BTreeSet<String> = graph.nodes.iter().filter_map(|n| n.path.clone()).collect();
        let edges: BTreeSet<(String, String)> = graph
            .edges
            .iter()
            .map(|e| (e.source.clone(), e.target.clone()))
            .collect();
        for (from, to) in &links {
            if from == to {
                continue;
            }
            let (source, target) = (format!("N{from}.md"), format!("N{to}.md"));
            if drawn.contains(&source) && drawn.contains(&target) {
                prop_assert!(
                    edges.contains(&(format!("n:{source}"), format!("n:{target}"))),
                    "{source} -> {target} is missing"
                );
            }
        }
    }

    /// Widening the walk never takes something away.
    #[test]
    fn a_wider_walk_contains_the_narrower_one((count, links) in vaults(), hops in 1u8..MAX_HOPS) {
        let files = files(count, &links);
        let narrow = neighbourhood(&files, "N0.md", hops);
        let wide = neighbourhood(&files, "N0.md", hops + 1);
        prop_assume!(!narrow.truncated && !wide.truncated);
        let wider: BTreeSet<&str> = wide.nodes.iter().map(|n| n.key.as_str()).collect();
        for node in &narrow.nodes {
            prop_assert!(wider.contains(node.key.as_str()), "{} was dropped", node.key);
        }
        let wider_edges: BTreeSet<(&str, &str)> = wide
            .edges
            .iter()
            .map(|e| (e.source.as_str(), e.target.as_str()))
            .collect();
        for edge in &narrow.edges {
            prop_assert!(wider_edges.contains(&(edge.source.as_str(), edge.target.as_str())));
        }
    }

    /// One node per key, and one edge per ordered pair.
    #[test]
    fn nothing_is_drawn_twice((count, links) in vaults(), hops in 1u8..=MAX_HOPS) {
        let graph = neighbourhood(&files(count, &links), "N0.md", hops);
        let keys: BTreeSet<&str> = graph.nodes.iter().map(|n| n.key.as_str()).collect();
        prop_assert_eq!(keys.len(), graph.nodes.len());
        let pairs: BTreeSet<(&str, &str)> = graph
            .edges
            .iter()
            .map(|e| (e.source.as_str(), e.target.as_str()))
            .collect();
        prop_assert_eq!(pairs.len(), graph.edges.len());
    }

    /// Exactly one origin, and it is the note that was asked about.
    #[test]
    fn the_origin_is_the_only_node_at_hop_zero((count, links) in vaults(), hops in 1u8..=MAX_HOPS) {
        let graph = neighbourhood(&files(count, &links), "N0.md", hops);
        let origins: Vec<&str> = graph
            .nodes
            .iter()
            .filter(|n| n.hop == 0)
            .map(|n| n.key.as_str())
            .collect();
        prop_assert_eq!(origins, vec!["n:N0.md"]);
    }
}
