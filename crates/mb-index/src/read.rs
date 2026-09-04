//! Queries. Every one of them reads a filtered view, never a table (E5).
//!
//! Read `readable.rs` first: it defines the views and why the filter lives there. The rule
//! this module lives by is that a query here may name only `v_notes`, `v_note_names`,
//! `v_links`, `v_resolved`, `v_tags`, `v_blocks` and `readable`. Naming a base table would
//! bypass one user's permissions in a system holding someone's private notes, so it is a
//! test failure rather than a review note.

use mb_core::model::Anchor;
use mb_core::{Access, Username};
use rusqlite::{Connection, OptionalExtension};

use crate::{Error, Index, readable};

/// Inbound links to one note, grouped by the note they come from (§9.5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BacklinkGroup {
    /// Vault-relative path of the linking note.
    pub path: String,
    /// Its title, or `None` when it has nothing titleable.
    pub title: Option<String>,
    /// Every link from that note into the target, in document order.
    pub links: Vec<Backlink>,
}

/// One inbound link, with the context a reader needs to recognise it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Backlink {
    /// Visible text of the block the link sits in.
    pub context: Option<String>,
    /// `^block-id` of that block, when it has one — what a jump-to-source affordance uses.
    pub source_block: Option<String>,
    /// `![[…]]` rather than `[[…]]`: a transclusion is an inbound link *and* a copy on the
    /// page, so the panel distinguishes them.
    pub embed: bool,
    /// The `#Heading` or `#^block-id` the link pointed at, if any.
    pub anchor: Option<Anchor>,
    /// The target exactly as the source file spells it.
    pub target_raw: String,
}

/// A note a reference resolved to, for this user (§4.3, §9.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    /// Vault-relative path — the canonical identity, which is what a caller reads by.
    pub path: String,
    /// Its title, or `None` when it has nothing titleable.
    pub title: Option<String>,
}

/// One node of the tag tree: a tag or one of its prefixes (§9.3).
///
/// `#project/memberberry/spec` produces three of these, and the count on `project` includes
/// every note tagged anywhere beneath it — which is what makes the pane's counts add up the
/// way a reader expects a folder's would.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagNode {
    /// The prefix as somebody wrote it — see [`Reader::tags`] for which spelling wins.
    pub tag: String,
    /// Its folded form, and the node's identity: `#Project` and `#project` are one tag.
    pub key: String,
    /// How many readable notes carry this tag or one nested under it.
    pub notes: usize,
}

/// Queries scoped to one user's readable set.
///
/// Obtained from [`Index::reader`], which is the only way to construct one: there is no
/// query surface that does not carry a user.
#[derive(Debug)]
pub struct Reader<'a> {
    conn: &'a Connection,
    readable: usize,
}

impl Index {
    /// Opens a reader over the notes `user` may read under `access`.
    ///
    /// Resolving the set is O(indexed notes) ACL evaluations and is done per reader rather
    /// than cached, because `access.toml` is live (§6.4): a cache would serve a revoked
    /// user until it expired, and a revocation that takes effect "soon" is the bug the
    /// per-frame re-check in E3 exists to avoid.
    ///
    /// # Errors
    ///
    /// Fails if the readable set cannot be written to the connection's temporary table.
    pub fn reader(&mut self, access: &Access, user: &Username) -> Result<Reader<'_>, Error> {
        let readable = readable::populate(&mut self.conn, access, user)?;
        Ok(Reader {
            conn: &self.conn,
            readable,
        })
    }
}

impl Reader<'_> {
    /// How many notes this reader may see.
    #[must_use]
    pub fn readable_notes(&self) -> usize {
        self.readable
    }

    /// Whether this note exists *for this user* (§6.5).
    ///
    /// An unreadable note answers `false` exactly as an absent one does, which is the
    /// invisibility rule: a distinguishable answer here would confirm the note exists.
    ///
    /// # Errors
    ///
    /// Fails only if the query itself fails.
    pub fn contains(&self, path: &str) -> Result<bool, Error> {
        Ok(self.note_id(path)?.is_some())
    }

    /// Every readable note that links to `path`, grouped by source note (E8, §9.5).
    ///
    /// Links from notes the user cannot read are absent, and so is the target itself when
    /// the user cannot read it — an unreadable note has no backlinks because it does not
    /// exist. Both are asserted in the leak suite.
    ///
    /// # Errors
    ///
    /// Fails only if the query itself fails.
    pub fn backlinks(&self, path: &str) -> Result<Vec<BacklinkGroup>, Error> {
        let Some(target) = self.note_id(path)? else {
            return Ok(Vec::new());
        };
        let mut statement = self.conn.prepare_cached(
            "SELECT n.path, n.title, l.context, l.source_block, l.kind, l.anchor_kind,
                    l.anchor, l.target_raw
             FROM v_resolved l
             JOIN v_notes n ON n.id = l.source_id
             WHERE l.target_id = ?1
             ORDER BY n.path, l.ordinal",
        )?;
        let rows = statement.query_map([target], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                Backlink {
                    context: row.get(2)?,
                    source_block: row.get(3)?,
                    embed: row.get::<_, String>(4)? == crate::write::KIND_EMBED,
                    anchor: anchor_of(&row.get::<_, String>(5)?, row.get(6)?),
                    target_raw: row.get(7)?,
                },
            ))
        })?;

        let mut groups: Vec<BacklinkGroup> = Vec::new();
        for row in rows {
            let (path, title, link) = row?;
            match groups.last_mut() {
                // The query orders by source path, so a group is finished the moment a
                // different path appears — no map, no second pass, and the output order is
                // the query's order rather than a hash order.
                Some(group) if group.path == path => group.links.push(link),
                _ => groups.push(BacklinkGroup {
                    path,
                    title,
                    links: vec![link],
                }),
            }
        }
        Ok(groups)
    }

    /// The note `reference` names when read from `source`, for this user (§4.3, E9).
    ///
    /// `reference` is a wikilink target as a file spells it — `Roadmap`,
    /// `Projects/Roadmap`, an alias — with no anchor: which *part* of the note a `#Heading`
    /// names is [`mb_core::transclude`]'s question, not this one's.
    ///
    /// Candidates come from the readable set, so this is E9 for a reference that is not in
    /// the index yet: a transclusion the user has just typed resolves against the notes
    /// they may read, and one naming an unreadable note answers `None` exactly as one
    /// naming a note that was never written does (§6.5).
    ///
    /// `source` only breaks ties. §4.3 resolves a name collision by nearest path, so
    /// `[[Roadmap]]` read from `Projects/Q3.md` is `Projects/Roadmap.md` rather than
    /// `Archive/Roadmap.md` — and the ordering is `readable.rs`'s, shared with the view
    /// that resolves the links already in the index, because two rules would be two
    /// answers.
    ///
    /// # Errors
    ///
    /// Fails only if the query itself fails.
    pub fn resolve(&self, source: &str, reference: &str) -> Result<Option<Target>, Error> {
        let key = crate::names::fold(reference);
        if key.is_empty() {
            return Ok(None);
        }
        let sql = format!(
            "SELECT nn.path, (SELECT n.title FROM v_notes n WHERE n.id = nn.note_id)
             FROM v_note_names nn
             WHERE nn.key = ?1
             ORDER BY {order}
             LIMIT 1",
            order = readable::candidate_order("?2")
        );
        let mut statement = self.conn.prepare_cached(&sql)?;
        Ok(statement
            .query_row(rusqlite::params![key, source], |row| {
                Ok(Target {
                    path: row.get(0)?,
                    title: row.get(1)?,
                })
            })
            .optional()?)
    }

    /// Every tag in the readable set, with the count of notes carrying it (§9.3).
    ///
    /// One row per *prefix*, so `#project/memberberry/spec` contributes `project`,
    /// `project/memberberry` and the whole tag, each counting the notes tagged at or below
    /// it. Ordered by [`TagNode::key`], which puts a parent immediately before its children
    /// and never depends on insertion order.
    ///
    /// **Case is not identity.** `#Project` and `#project` are one tag with one count,
    /// because a tag typed at the start of a sentence is the same tag. The spelling shown is
    /// the one the most notes use, ties broken alphabetically — deterministic, and it does
    /// not change under a note the caller cannot read.
    ///
    /// Counts come from the filtered view, so a tag carried *only* by notes this user cannot
    /// read has no row at all: §6.5 makes a tag count a way of asking how many notes exist.
    ///
    /// # Errors
    ///
    /// Fails only if the query itself fails.
    pub fn tags(&self) -> Result<Vec<TagNode>, Error> {
        let mut statement = self.conn.prepare_cached(
            "SELECT t.prefix_key,
                    count(DISTINCT t.note_id),
                    (SELECT s.tag_prefix FROM v_tags s
                     WHERE s.prefix_key = t.prefix_key
                     GROUP BY s.tag_prefix
                     ORDER BY count(*) DESC, s.tag_prefix ASC
                     LIMIT 1)
             FROM v_tags t
             GROUP BY t.prefix_key
             ORDER BY t.prefix_key",
        )?;
        let rows = statement.query_map([], |row| {
            let key: String = row.get(0)?;
            let notes: i64 = row.get(1)?;
            // The subquery groups the same rows this one does, so it cannot come back empty;
            // falling back to the key rather than unwrapping keeps that a display detail
            // instead of a panic in a library (`AGENTS.md` §4.2).
            let tag: Option<String> = row.get(2)?;
            Ok(TagNode {
                tag: tag.unwrap_or_else(|| key.clone()),
                key,
                notes: usize::try_from(notes).unwrap_or(0),
            })
        })?;
        rows.collect::<Result<_, _>>().map_err(Error::from)
    }

    /// The readable notes carrying `prefix` or any tag nested under it (§9.3).
    ///
    /// `prefix` is matched folded, so it may be written in any case, and it names a whole
    /// subtree: `project` answers for `#project/memberberry/spec`. Ordered by path.
    ///
    /// # Errors
    ///
    /// Fails only if the query itself fails.
    pub fn tagged(&self, prefix: &str) -> Result<Vec<Target>, Error> {
        let key = crate::names::fold_tag(prefix.trim().trim_start_matches('#'));
        if key.is_empty() {
            return Ok(Vec::new());
        }
        let mut statement = self.conn.prepare_cached(
            "SELECT DISTINCT n.path, n.title
             FROM v_tags t
             JOIN v_notes n ON n.id = t.note_id
             WHERE t.prefix_key = ?1
             ORDER BY n.path",
        )?;
        let rows = statement.query_map([key], |row| {
            Ok(Target {
                path: row.get(0)?,
                title: row.get(1)?,
            })
        })?;
        rows.collect::<Result<_, _>>().map_err(Error::from)
    }

    fn note_id(&self, path: &str) -> Result<Option<i64>, Error> {
        let mut statement = self
            .conn
            .prepare_cached("SELECT id FROM v_notes WHERE path = ?1")?;
        Ok(statement.query_row([path], |row| row.get(0)).optional()?)
    }
}

fn anchor_of(kind: &str, value: Option<String>) -> Option<Anchor> {
    match (kind, value) {
        (crate::write::ANCHOR_HEADING, Some(value)) => Some(Anchor::Heading(value)),
        (crate::write::ANCHOR_BLOCK, Some(value)) => Some(Anchor::Block(value)),
        _ => None,
    }
}
