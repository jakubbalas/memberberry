//! The graph queries (`SPEC.md` §9.4): the n-hop neighbourhood of one note, and the whole
//! readable vault.
//!
//! Two queries because they answer two questions. [`Reader::neighbourhood`] answers "how far
//! is this note from that one", so it walks out from an origin and a node's *hop* is the
//! whole of what it says. [`Reader::vault_graph`] answers "what shape is this vault", so
//! there is no origin, every readable note is a node, and what bounds the answer is a cap by
//! degree. They share the node keys, the edge collapsing and the ghost rule below, and
//! nothing else.
//!
//! A read path, so it names only the filtered views — `tests/no_unfiltered_query.rs` fails
//! if that ever stops being true. Which is the whole of enforcement point **E9** here:
//! candidates come from `v_resolved`, whose resolution runs against `v_note_names`, so an
//! edge into a note this reader cannot see is never formed. It becomes a *ghost* instead,
//! exactly as a link to a note nobody has written yet does — which is §6.5 rather than a
//! compromise: the two have to be indistinguishable, and the picture that shows them
//! differently is the one that says an unreadable note exists.
//!
//! **The neighbourhood is two phases, and the second one is not an optimisation.** A
//! breadth-first walk decides which notes are in the picture; a second pass then asks for
//! every edge *between* those notes. Collecting edges during the walk instead would leave
//! the outermost ring drawn as unconnected dots — its neighbours are found by expanding it,
//! which is what the hop limit stops. So the invariant this buys is worth a query: **every
//! link between two notes the graph shows is an edge the graph shows.**

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

// ---------------------------------------------------------------- the whole vault

/// The whole readable vault as a graph (§9.4).
///
/// The other half of §9.4, and a different question from [`Reader::neighbourhood`]'s: not
/// "how far is this from that" but "what shape is this vault". So there is no origin and no
/// hop — every readable note is a node, every link between two of them is an edge, and what
/// bounds the answer is a cap by degree rather than a distance.
///
/// Deterministic: nodes ordered by [`VaultNode::key`], edges by their endpoints, and the cap
/// broken by key when two nodes have the same degree.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VaultGraph {
    pub nodes: Vec<VaultNode>,
    pub edges: Vec<GraphEdge>,
    /// How many nodes the readable vault has **before** the cap — §9.4's "of 10,431".
    ///
    /// Counted over the readable set, so it is not a way of asking how many notes exist
    /// (§6.5): a vault of ten thousand notes of which this reader may see four reports four.
    pub total: usize,
    /// Whether the cap left some of them out, which the picture has to say on screen.
    pub truncated: bool,
}

/// One node of the whole-vault graph: a readable note, or a link target that resolves to
/// nothing for this reader.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultNode {
    /// `n:<path>` for a note and `g:<folded target>` for a ghost, as in [`GraphNode::key`].
    pub key: String,
    /// The note's vault-relative path, or `None` for a ghost (§6.5).
    pub path: Option<String>,
    /// A note's title or filename, a ghost's target as the linking note spells it.
    pub label: String,
    /// Edges touching this node **in the whole vault**, not in the drawn picture.
    ///
    /// The cap is applied to this number, so it has to be the vault's — a degree counted
    /// after the cap would rank a hub by how much of it survived. It is also what §9.4 sizes
    /// a node by, and "this note has forty links" stays true when the picture shows six.
    pub degree: u32,
    /// Words in the note, §9.4's other node size. `0` for a ghost, which has no note.
    pub words: u32,
    /// `YYYY-MM-DD` for the creation scrubber, or `None` when nothing in the note says.
    ///
    /// Frontmatter `created` first; failing that, the timestamp inside a UUIDv7 `id`, which
    /// is what §9.4 means by the scrubber being free. A note with neither — the `printf >
    /// note.md` case C2 requires to work (§4.3) — is undated, and a scrubber that filtered it
    /// out would hide notes for having been written by the wrong tool.
    pub created: Option<String>,
    /// The note's tags, folded, full tags only — `#project/mb`, never its `#project` prefix.
    ///
    /// A prefix filter is then a string prefix on the client, which is the same nesting rule
    /// §9.3 uses, and it keeps a nested tag from being sent once per level.
    pub tags: Vec<String>,
}

/// The most nodes a whole-vault graph may hold, whatever a caller asks for.
///
/// §21.2 budgets the graph at 10 000 nodes on a desktop, so a picture larger than that is
/// one no budget covers and no reader can take in. The reply says how many there were, which
/// is the same honesty §9.4 requires of the mobile cap — and unlike the mobile cap this one
/// is a ceiling rather than a default: a caller asking for fewer gets fewer.
pub const MAX_VAULT_GRAPH: usize = 10_000;

/// One note as the whole-vault query reads it.
struct NoteRow {
    id: i64,
    path: String,
    title: Option<String>,
    words: u32,
    created: Option<String>,
    uuid: Option<String>,
}

impl Reader<'_> {
    /// Every readable note and every link between two of them (§9.4, E9).
    ///
    /// `limit` caps the node count, top-degree first — §9.4's "showing 2,000 of 10,431",
    /// which is how the mobile picture stays honest rather than merely small. `None` means
    /// [`MAX_VAULT_GRAPH`], and a larger `limit` is clamped to it.
    ///
    /// The permission story is [`Reader::neighbourhood`]'s exactly: nodes come from
    /// `v_notes`, edges from `v_resolved`, and a link into a note this reader cannot see
    /// resolves to nothing and becomes a ghost, indistinguishable from a link nobody has
    /// written a note for (§6.5).
    ///
    /// # Errors
    ///
    /// Fails only if one of the queries fails.
    pub fn vault_graph(&self, limit: Option<usize>) -> Result<VaultGraph, Error> {
        let limit = limit.unwrap_or(MAX_VAULT_GRAPH).min(MAX_VAULT_GRAPH);
        let notes = self.all_notes()?;
        let paths: HashMap<i64, &str> = notes
            .iter()
            .map(|note| (note.id, note.path.as_str()))
            .collect();

        // Ghost labels first: an unresolved link contributes a node whose name is the one
        // the *source* note spells, and several notes may spell it differently. The lowest
        // spelling wins, so the picture does not depend on which note was indexed first.
        let mut ghosts: BTreeMap<String, String> = BTreeMap::new();
        let mut collapsed: BTreeMap<(Endpoint, Endpoint), bool> = BTreeMap::new();
        for edge in self.all_links()? {
            let target = match edge.target {
                Some(target) => Endpoint::Note(target),
                None if edge.target_key.is_empty() => continue,
                None => {
                    let label = ghosts.entry(edge.target_key.clone()).or_default();
                    if label.is_empty() || edge.target_raw < *label {
                        *label = edge.target_raw;
                    }
                    Endpoint::Ghost(edge.target_key)
                }
            };
            let pair = (Endpoint::Note(edge.source), target);
            let entry = collapsed.entry(pair).or_insert(false);
            *entry = *entry || edge.embed;
        }

        let mut edges: Vec<GraphEdge> = Vec::with_capacity(collapsed.len());
        let mut degree: HashMap<String, u32> = HashMap::new();
        for ((source, target), embed) in collapsed {
            // A source whose note vanished between the two queries has no key. Dropping the
            // edge is right: an edge needs both of its nodes to be on the page.
            let (Some(source), Some(target)) = (
                endpoint_path_key(&source, &paths),
                endpoint_path_key(&target, &paths),
            ) else {
                continue;
            };
            // A self-link is a loop nothing can draw usefully, as in the neighbourhood.
            if source == target {
                continue;
            }
            *degree.entry(source.clone()).or_insert(0) += 1;
            *degree.entry(target.clone()).or_insert(0) += 1;
            edges.push(GraphEdge {
                source,
                target,
                embed,
            });
        }

        let mut tags = self.note_tags()?;
        let mut nodes: Vec<VaultNode> = Vec::with_capacity(notes.len() + ghosts.len());
        for note in notes {
            let key = note_key(&note.path);
            nodes.push(VaultNode {
                degree: degree.get(&key).copied().unwrap_or(0),
                label: label_of(&note.path, note.title.as_deref()),
                words: note.words,
                created: created_date(note.created.as_deref(), note.uuid.as_deref()),
                tags: tags.remove(&note.id).unwrap_or_default(),
                path: Some(note.path),
                key,
            });
        }
        for (key, label) in ghosts {
            let key = ghost_key(&key);
            nodes.push(VaultNode {
                degree: degree.get(&key).copied().unwrap_or(0),
                key,
                path: None,
                label,
                words: 0,
                created: None,
                tags: Vec::new(),
            });
        }

        let total = nodes.len();
        let truncated = total > limit;
        if truncated {
            // why: sort the whole list rather than a partial selection. `select_nth_unstable`
            // would be O(n) instead of O(n log n), and at ten thousand nodes the difference is
            // invisible next to the two queries above — while the full sort is what makes the
            // *tie* deterministic, which a reader comparing two runs of the same vault sees.
            nodes.sort_by(|a, b| (b.degree, &a.key).cmp(&(a.degree, &b.key)));
            nodes.truncate(limit);
            let kept: std::collections::HashSet<&str> =
                nodes.iter().map(|node| node.key.as_str()).collect();
            edges.retain(|edge| {
                kept.contains(edge.source.as_str()) && kept.contains(edge.target.as_str())
            });
        }
        nodes.sort_by(|a, b| a.key.cmp(&b.key));
        edges.sort_by(|a, b| (&a.source, &a.target).cmp(&(&b.source, &b.target)));

        Ok(VaultGraph {
            nodes,
            edges,
            total,
            truncated,
        })
    }

    /// Every readable note, with the columns a node is drawn from.
    fn all_notes(&self) -> Result<Vec<NoteRow>, Error> {
        let mut statement = self.connection().prepare_cached(
            "SELECT n.id, n.path, n.title, n.word_count, n.created, n.uuid
             FROM v_notes n
             ORDER BY n.path",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(NoteRow {
                id: row.get(0)?,
                path: row.get(1)?,
                title: row.get(2)?,
                words: u32::try_from(row.get::<_, i64>(3)?).unwrap_or(u32::MAX),
                created: row.get(4)?,
                uuid: row.get(5)?,
            })
        })?;
        rows.collect::<Result<_, _>>().map_err(Error::from)
    }

    /// Every link out of a readable note, resolved.
    ///
    /// Unbounded on purpose: the cap in [`Reader::vault_graph`] bounds what is *drawn*, and
    /// applying it here instead would mean choosing the top nodes by a degree counted over
    /// an arbitrary subset of the links. At §21's ten thousand notes this is tens of
    /// thousands of rows read once per graph opened, which is the same order as the index
    /// build itself (§21.8).
    fn all_links(&self) -> Result<Vec<Edge>, Error> {
        let mut statement = self.connection().prepare_cached(
            "SELECT l.source_id, l.target_id, l.target_raw, l.target_key, l.kind
             FROM v_resolved l
             ORDER BY l.source_id, l.ordinal",
        )?;
        let rows = statement.query_map([], |row| {
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

    /// The full tags of every readable note, folded, by note id.
    ///
    /// `tag = tag_prefix` picks the row where the running prefix has reached the whole tag —
    /// §9.3 writes one row per prefix so a query for `#project` needs no scan, and this is
    /// the query that wants the other end of that.
    fn note_tags(&self) -> Result<HashMap<i64, Vec<String>>, Error> {
        let mut statement = self.connection().prepare_cached(
            "SELECT DISTINCT t.note_id, t.prefix_key
             FROM v_tags t
             WHERE t.tag = t.tag_prefix
             ORDER BY t.note_id, t.prefix_key",
        )?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get(1)?)))?;
        let mut tags: HashMap<i64, Vec<String>> = HashMap::new();
        for row in rows {
            let (note, tag) = row?;
            tags.entry(note).or_default().push(tag);
        }
        Ok(tags)
    }
}

fn endpoint_path_key(endpoint: &Endpoint, paths: &HashMap<i64, &str>) -> Option<String> {
    match endpoint {
        Endpoint::Note(id) => paths.get(id).map(|path| note_key(path)),
        Endpoint::Ghost(key) => Some(ghost_key(key)),
    }
}

/// The day a note was created, for §9.4's scrubber, or `None` when nothing says.
///
/// Frontmatter `created` wins over the `id`, because a person or a template wrote it and the
/// UUID's timestamp only records when the identity was minted — an imported note carries the
/// date it was written and an `id` from the day it was imported.
fn created_date(created: Option<&str>, uuid: Option<&str>) -> Option<String> {
    if let Some(date) = created
        .map(str::trim)
        // A `created:` that carries a time — `2026-08-28T09:41:00Z` — is a date this can
        // read; `get` rather than slicing, so a value whose tenth byte is inside a character
        // answers `None` instead of panicking.
        .and_then(|text| text.get(..10))
        .and_then(mb_core::task::Date::parse)
    {
        return Some(date.to_string());
    }
    uuid.and_then(uuid_v7_millis)
        .and_then(mb_core::task::Date::from_unix_millis)
        .map(|date| date.to_string())
}

/// The Unix milliseconds a UUIDv7 carries in its first 48 bits, or `None` for anything else.
///
/// Strict about the canonical form: §4.3 says the `id` is a UUIDv7, and a value that is not
/// one is a note whose creation date this cannot know rather than one to guess at. The
/// version nibble is checked and the variant is not — a v7 with a wrong variant still has a
/// timestamp where a v7's timestamp goes, and the alternative is discarding a real date over
/// a byte nothing here reads.
fn uuid_v7_millis(uuid: &str) -> Option<i64> {
    let bytes = uuid.as_bytes();
    if bytes.len() != 36 {
        return None;
    }
    for (at, byte) in bytes.iter().enumerate() {
        let expected_dash = matches!(at, 8 | 13 | 18 | 23);
        if expected_dash != (*byte == b'-') || (!expected_dash && !byte.is_ascii_hexdigit()) {
            return None;
        }
    }
    if bytes.get(14) != Some(&b'7') {
        return None;
    }
    let hex: String = uuid.chars().take(18).filter(|c| *c != '-').collect();
    i64::from_str_radix(hex.get(..12)?, 16).ok()
}
