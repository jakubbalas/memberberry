//! The graph query: the n-hop neighbourhood of one note (`SPEC.md` §9.4).
//!
//! A read path, so it names only the filtered views — `tests/no_unfiltered_query.rs` fails
//! if that ever stops being true. Which is the whole of enforcement point **E9** here:
//! candidates come from `v_resolved`, whose resolution runs against `v_note_names`, so an
//! edge into a note this reader cannot see is never formed. It becomes a *ghost* instead,
//! exactly as a link to a note nobody has written yet does — which is §6.5 rather than a
//! compromise: the two have to be indistinguishable, and the picture that shows them
//! differently is the one that says an unreadable note exists.
//!
//! **Two phases, and the second one is not an optimisation.** A breadth-first walk decides
//! which notes are in the picture; a second pass then asks for every edge *between* those
//! notes. Collecting edges during the walk instead would leave the outermost ring drawn as
//! unconnected dots — its neighbours are found by expanding it, which is what the hop limit
//! stops. So the invariant this buys is worth a query: **every link between two notes the
//! graph shows is an edge the graph shows.**

use std::collections::{BTreeMap, HashMap};

use rusqlite::types::Value;

use crate::{Error, read::Reader};

/// A note's neighbourhood, ready to draw (§9.4).
///
/// Deterministic: nodes are ordered by hop and then by [`GraphNode::key`], edges by their
/// endpoints. Nothing here depends on rowid order or on which link happened to be indexed
/// first, so the same vault draws the same picture twice.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Graph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    /// Whether the node cap cut the neighbourhood short — see [`Reader::neighbourhood`].
    pub truncated: bool,
}

/// One node: a readable note, or a link target that resolves to nothing for this reader.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphNode {
    /// Unique within the graph, and what an edge names its endpoints by.
    ///
    /// `n:<path>` for a note and `g:<folded target>` for a ghost. Prefixed rather than
    /// shared, because a ghost is identified by the name a link spells and a note by its
    /// path, and nothing stops those two strings from being equal.
    pub key: String,
    /// The note's vault-relative path, or `None` for a ghost — which has no path *because
    /// there is no note*, whether it was never written or cannot be read (§6.5).
    pub path: Option<String>,
    /// What to draw on the node: a note's title or filename, a ghost's target as written.
    pub label: String,
    /// Distance from the origin in links, ignoring direction. The origin is `0`.
    pub hop: u8,
}

/// One edge, in the direction the link points.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphEdge {
    /// [`GraphNode::key`] of the linking note.
    pub source: String,
    /// [`GraphNode::key`] of the note or ghost it points at.
    pub target: String,
    /// Whether any link between this pair is a transclusion (§9.2).
    ///
    /// Several links between one pair of notes are one edge: the picture answers "are these
    /// two connected", and three parallel lines between the same dots say nothing a reader
    /// can use. The backlinks panel is where the individual links are listed (§9.5).
    pub embed: bool,
}

/// An endpoint before it has a key: a note is a row id, a ghost is a folded target.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum Endpoint {
    Note(i64),
    Ghost(String),
}

/// One row of the resolution view, as the walk reads it.
struct Edge {
    source: i64,
    target: Option<i64>,
    target_raw: String,
    target_key: String,
    embed: bool,
}

/// The most nodes a neighbourhood may hold, whatever `hops` asks for.
///
/// A three-hop walk out of a hub note is most of a vault, and a sidebar panel that tries to
/// draw ten thousand dots is a frozen tab rather than a graph (§21.2). The cap is reported
/// as [`Graph::truncated`] so the UI can say so, which §9.4 requires of the mobile cap and
/// is no less honest here.
pub const MAX_NEIGHBOURHOOD: usize = 200;

/// The deepest walk §9.4 offers.
pub const MAX_HOPS: u8 = 3;

impl Reader<'_> {
    /// The `hops`-hop neighbourhood of `path`, for this reader (§9.4, E9).
    ///
    /// Traversal ignores link direction — a note that links *to* this one is as much a
    /// neighbour as one it links to — while the edges keep theirs, because which way a link
    /// points is what a reader is looking at the picture to learn.
    ///
    /// `hops` is clamped to `1..=`[`MAX_HOPS`] and the node count to
    /// [`MAX_NEIGHBOURHOOD`]. An unreadable or absent origin answers with an empty graph:
    /// one answer for both, which is §6.5.
    ///
    /// # Errors
    ///
    /// Fails only if one of the queries fails.
    pub fn neighbourhood(&self, path: &str, hops: u8) -> Result<Graph, Error> {
        let hops = hops.clamp(1, MAX_HOPS);
        let Some(origin) = self.note_id(path)? else {
            return Ok(Graph::default());
        };

        let mut hop_of: HashMap<i64, u8> = HashMap::from([(origin, 0)]);
        let mut ghosts: BTreeMap<String, (String, u8)> = BTreeMap::new();
        let mut frontier = vec![origin];
        let mut truncated = false;

        for hop in 0..hops {
            if frontier.is_empty() {
                break;
            }
            let mut next = Vec::new();
            for edge in self.edges_touching(&frontier)? {
                match edge.target {
                    Some(target) => {
                        // Both ends: the walk is undirected, and this row may have been
                        // found by either of them.
                        for id in [edge.source, target] {
                            if hop_of.contains_key(&id) {
                                continue;
                            }
                            if hop_of.len() + ghosts.len() >= MAX_NEIGHBOURHOOD {
                                truncated = true;
                                continue;
                            }
                            hop_of.insert(id, hop + 1);
                            next.push(id);
                        }
                    }
                    // A ghost is a leaf. It resolves to no note, so there is nothing to
                    // expand — and it is reached only from its source, never towards it.
                    None if !edge.target_key.is_empty() => {
                        if ghosts.contains_key(&edge.target_key) {
                            continue;
                        }
                        if hop_of.len() + ghosts.len() >= MAX_NEIGHBOURHOOD {
                            truncated = true;
                            continue;
                        }
                        ghosts.insert(edge.target_key, (edge.target_raw, hop + 1));
                    }
                    None => {}
                }
            }
            next.sort_unstable();
            frontier = next;
        }

        let ids: Vec<i64> = hop_of.keys().copied().collect();
        let notes = self.note_details(&ids)?;
        let mut nodes: Vec<GraphNode> = Vec::with_capacity(notes.len() + ghosts.len());
        for (id, hop) in &hop_of {
            // A note indexed between the walk and this query has no details row. Dropping
            // it is right: a node with no path is a ghost, and this one is not.
            if let Some((path, title)) = notes.get(id) {
                nodes.push(GraphNode {
                    key: note_key(path),
                    path: Some(path.clone()),
                    label: label_of(path, title.as_deref()),
                    hop: *hop,
                });
            }
        }
        for (key, (raw, hop)) in &ghosts {
            nodes.push(GraphNode {
                key: ghost_key(key),
                path: None,
                label: raw.clone(),
                hop: *hop,
            });
        }
        nodes.sort_by(|a, b| (a.hop, &a.key).cmp(&(b.hop, &b.key)));

        let edges = self.edges_between(&ids, &ghosts, &notes)?;
        Ok(Graph {
            nodes,
            edges,
            truncated,
        })
    }

    /// Every resolved link with either end in `ids`.
    ///
    /// `IN (...)` with a placeholder per id rather than a temporary table: the list is
    /// bounded by [`MAX_NEIGHBOURHOOD`], so it cannot approach SQLite's variable limit, and
    /// a scratch table in this connection would be one more thing living beside the
    /// readable set that a reader could forget to clear.
    fn edges_touching(&self, ids: &[i64]) -> Result<Vec<Edge>, Error> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = std::iter::repeat_n("?", ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT l.source_id, l.target_id, l.target_raw, l.target_key, l.kind
             FROM v_resolved l
             WHERE l.source_id IN ({placeholders}) OR l.target_id IN ({placeholders})
             ORDER BY l.source_id, l.ordinal"
        );
        let doubled: Vec<Value> = ids
            .iter()
            .chain(ids.iter())
            .map(|id| Value::Integer(*id))
            .collect();
        let mut statement = self.connection().prepare_cached(&sql)?;
        let rows = statement.query_map(rusqlite::params_from_iter(doubled), |row| {
            Ok(Edge {
                source: row.get(0)?,
                target: row.get(1)?,
                target_raw: row.get(2)?,
                target_key: row.get(3)?,
                embed: row.get::<_, String>(4)? == crate::write::KIND_EMBED,
            })
        })?;
        rows.collect::<Result<_, _>>().map_err(Error::from)
    }

    /// The edges among a settled set of nodes — the second phase (see the module docs).
    ///
    /// Adds no node. A link out of the outermost ring into a note beyond it is not drawn,
    /// because drawing it would mean drawing a node one hop further than was asked for.
    ///
    /// why: an endpoint is resolved through `notes` and `ghosts`, which *are* the node set —
    /// so "every edge has both ends on the page" holds by construction rather than by a
    /// filter. An explicit membership check was written here first and no test could observe
    /// it, which is the definition of a branch that is not doing anything (`AGENTS.md` §4.1).
    fn edges_between(
        &self,
        ids: &[i64],
        ghosts: &BTreeMap<String, (String, u8)>,
        notes: &HashMap<i64, (String, Option<String>)>,
    ) -> Result<Vec<GraphEdge>, Error> {
        let mut collapsed: BTreeMap<(Endpoint, Endpoint), bool> = BTreeMap::new();
        for edge in self.edges_touching(ids)? {
            let target = match edge.target {
                Some(target) => Endpoint::Note(target),
                None if ghosts.contains_key(&edge.target_key) => Endpoint::Ghost(edge.target_key),
                None => continue,
            };
            let pair = (Endpoint::Note(edge.source), target);
            let entry = collapsed.entry(pair).or_insert(false);
            *entry = *entry || edge.embed;
        }

        let mut edges = Vec::with_capacity(collapsed.len());
        for ((source, target), embed) in collapsed {
            // A missing key is an endpoint the cap or the hop limit left out of the picture.
            let (Some(source), Some(target)) =
                (endpoint_key(&source, notes), endpoint_key(&target, notes))
            else {
                continue;
            };
            // A self-link is a loop nothing can draw usefully.
            if source == target {
                continue;
            }
            edges.push(GraphEdge {
                source,
                target,
                embed,
            });
        }
        edges.sort_by(|a, b| (&a.source, &a.target).cmp(&(&b.source, &b.target)));
        Ok(edges)
    }

    /// Path and title for each id, from the filtered view.
    fn note_details(&self, ids: &[i64]) -> Result<HashMap<i64, (String, Option<String>)>, Error> {
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let placeholders = std::iter::repeat_n("?", ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql =
            format!("SELECT n.id, n.path, n.title FROM v_notes n WHERE n.id IN ({placeholders})");
        let mut statement = self.connection().prepare_cached(&sql)?;
        let bound: Vec<Value> = ids.iter().map(|id| Value::Integer(*id)).collect();
        let rows = statement.query_map(rusqlite::params_from_iter(bound), |row| {
            Ok((row.get::<_, i64>(0)?, (row.get(1)?, row.get(2)?)))
        })?;
        rows.collect::<Result<_, _>>().map_err(Error::from)
    }
}

fn endpoint_key(
    endpoint: &Endpoint,
    notes: &HashMap<i64, (String, Option<String>)>,
) -> Option<String> {
    match endpoint {
        Endpoint::Note(id) => notes.get(id).map(|(path, _)| note_key(path)),
        Endpoint::Ghost(key) => Some(ghost_key(key)),
    }
}

fn note_key(path: &str) -> String {
    format!("n:{path}")
}

fn ghost_key(key: &str) -> String {
    format!("g:{key}")
}

/// A note's title, or its filename with the extension off when it has none.
///
/// The same fallback the backlinks panel uses, in the crate that already knows the path —
/// a graph node with no label is a dot the reader cannot identify.
fn label_of(path: &str, title: Option<&str>) -> String {
    match title {
        Some(title) if !title.is_empty() => title.to_string(),
        _ => {
            let file = path.rsplit('/').next().unwrap_or(path);
            // why: `strip_suffix` rather than `trim_end_matches`, which strips *every*
            // trailing occurrence and would label `Notes.md.md` as `Notes`.
            file.strip_suffix(".md").unwrap_or(file).to_string()
        }
    }
}
