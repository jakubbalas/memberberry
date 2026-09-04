//! Maintaining the index: what is stale, and what one note becomes in SQL.
//!
//! Reindexing is incremental in two steps, because reading a file is the expensive part and
//! most files have not changed:
//!
//! 1. [`Index::reconcile`] compares a cheap per-file stamp against the stored one and says
//!    which notes to read and which rows to drop. No note is opened.
//! 2. [`Index::upsert`] parses what the caller read and rewrites that note's rows — unless
//!    the content hash is unchanged, in which case only the stamp moves. A `touch`, a
//!    same-content save and a `git checkout` that restores a file all land there.
//!
//! The watcher is a hint and may miss events (`SPEC.md` §3.4), so the reconcile is also the
//! recovery sweep: it is correct with no watcher at all, just slower to notice.

use std::path::Path;
use std::time::SystemTime;

use mb_core::extract::Extracted;
use mb_core::model::Anchor;
use mb_core::task::{Priority, TaskStatus};
use rusqlite::{OptionalExtension, Transaction};
use sha2::{Digest, Sha256};

use crate::{Error, Index, names};

/// `links.kind` for a `[[…]]`.
pub(crate) const KIND_LINK: &str = "link";
/// `links.kind` for a `![[…]]` transclusion (§9.2).
pub(crate) const KIND_EMBED: &str = "embed";
/// `links.anchor_kind` for a link with no `#…` part.
pub(crate) const ANCHOR_NONE: &str = "none";
/// `links.anchor_kind` for `[[Note#Heading]]`.
pub(crate) const ANCHOR_HEADING: &str = "heading";
/// `links.anchor_kind` for `[[Note#^block-id]]`.
pub(crate) const ANCHOR_BLOCK: &str = "block";

/// Cheap evidence that a note file has not changed.
///
/// Size alone is far too weak — an edit that preserves length is ordinary — so the
/// modification time carries it. A stamp is never trusted for *content*: when it differs the
/// file is read and hashed, and the hash decides whether any row changes. So a filesystem
/// with a coarse clock costs a parse, never a wrong answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stamp(String);

impl Stamp {
    /// Stamps a file, or returns `None` if it cannot be stat-ed.
    #[must_use]
    pub fn of(path: &Path) -> Option<Self> {
        let meta = std::fs::metadata(path).ok()?;
        let modified = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map_or_else(|| "?".to_string(), |since| since.as_nanos().to_string());
        Some(Self(format!("{}:{modified}", meta.len())))
    }

    /// Builds a stamp from parts, for tests and for callers that already have the metadata.
    #[must_use]
    pub fn from_parts(len: u64, modified_nanos: u128) -> Self {
        Self(format!("{len}:{modified_nanos}"))
    }
}

/// One note, as the caller read it off disk.
#[derive(Debug, Clone)]
pub struct NoteInput {
    /// Vault-relative path, `.md` included: the same spelling `access.toml` rules use.
    pub path: String,
    /// The file's full text, frontmatter included.
    pub markdown: String,
    /// The stamp of the file the text came from.
    pub stamp: Stamp,
}

/// What a reconcile decided.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Plan {
    /// Notes to read and pass to [`Index::upsert`], in vault order.
    pub stale: Vec<String>,
    /// Indexed notes that are no longer on disk. Already removed by the reconcile.
    pub removed: Vec<String>,
}

impl Plan {
    /// Whether there is nothing to do, so a tick can skip the vault entirely.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.stale.is_empty() && self.removed.is_empty()
    }
}

/// What one [`Index::upsert`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Changed {
    /// The note was not in the index.
    Inserted,
    /// The note's content changed; every row for it was rewritten.
    Rewritten,
    /// Same content hash: only the stamp moved, so no row for this note changed.
    Unchanged,
}

impl Index {
    /// Decides which notes need reading, and drops rows for notes that are gone.
    ///
    /// `present` is every note currently in the vault, with its stamp — including notes the
    /// requesting user could not read, because the index describes the vault and the filter
    /// is applied on the way out (§6.5). Removals are applied here rather than reported,
    /// because a deleted note must stop being visible immediately, not after the caller
    /// works through a list.
    ///
    /// # Errors
    ///
    /// Fails if the index cannot be read or the removals cannot be committed.
    pub fn reconcile(&mut self, present: &[(String, Stamp)]) -> Result<Plan, Error> {
        let known: std::collections::BTreeMap<String, String> = {
            let mut statement = self.conn.prepare_cached("SELECT path, stamp FROM notes")?;
            let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
            rows.collect::<Result<_, _>>()?
        };

        let mut plan = Plan::default();
        let mut seen = std::collections::BTreeSet::new();
        for (path, stamp) in present {
            seen.insert(path.as_str());
            if known.get(path).is_none_or(|stored| stored != &stamp.0) {
                plan.stale.push(path.clone());
            }
        }
        for path in known.keys() {
            if !seen.contains(path.as_str()) {
                plan.removed.push(path.clone());
            }
        }

        if !plan.removed.is_empty() {
            let transaction = self.conn.transaction()?;
            {
                let mut delete = transaction.prepare_cached("DELETE FROM notes WHERE path = ?1")?;
                for path in &plan.removed {
                    delete.execute([path])?;
                }
            }
            transaction.commit()?;
        }
        Ok(plan)
    }

    /// Writes one note's rows, replacing whatever was there.
    ///
    /// # Errors
    ///
    /// Fails if the transaction cannot be committed. Nothing about a note's *content* can
    /// fail: parsing is total (§3.1), so an unparseable note is not a modelled outcome.
    pub fn upsert(&mut self, input: &NoteInput) -> Result<Changed, Error> {
        let hash = content_hash(&input.markdown);
        let existing: Option<String> = self
            .conn
            .prepare_cached("SELECT content_hash FROM notes WHERE path = ?1")?
            .query_row([&input.path], |row| row.get(0))
            .optional()?;

        if existing.as_deref() == Some(hash.as_str()) {
            self.conn
                .prepare_cached("UPDATE notes SET stamp = ?2 WHERE path = ?1")?
                .execute(rusqlite::params![&input.path, &input.stamp.0])?;
            return Ok(Changed::Unchanged);
        }

        let doc = mb_core::parse(&input.markdown);
        let facts = mb_core::extract(&doc);
        let transaction = self.conn.transaction()?;
        // why: delete rather than update. Every child table cascades from `notes`, so one
        // statement clears links, tags, blocks, tasks, names and media refs together —
        // there is no path on which a stale child row survives its parent's rewrite.
        transaction.execute("DELETE FROM notes WHERE path = ?1", [&input.path])?;
        transaction.execute(
            "INSERT INTO notes
                (path, uuid, title, icon, created, updated, content_hash, word_count, stamp)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                &input.path,
                &doc.frontmatter.id,
                mb_core::extract::title(&doc),
                &doc.frontmatter.icon,
                &doc.frontmatter.created,
                &doc.frontmatter.updated,
                &hash,
                i64::try_from(facts.word_count).unwrap_or(i64::MAX),
                &input.stamp.0,
            ],
        )?;
        let note_id = transaction.last_insert_rowid();
        write_names(&transaction, note_id, &input.path, &doc)?;
        write_links(&transaction, note_id, &input.path, &facts)?;
        write_tags(&transaction, note_id, &facts)?;
        write_blocks(&transaction, note_id, &facts)?;
        write_tasks(&transaction, note_id, &facts)?;
        write_media(&transaction, note_id, &facts)?;
        transaction.commit()?;

        Ok(if existing.is_some() {
            Changed::Rewritten
        } else {
            Changed::Inserted
        })
    }

    /// Drops every row for one note. Returns whether it was there.
    ///
    /// # Errors
    ///
    /// Fails only if the delete fails.
    pub fn remove(&mut self, path: &str) -> Result<bool, Error> {
        let removed = self
            .conn
            .prepare_cached("DELETE FROM notes WHERE path = ?1")?
            .execute([path])?;
        Ok(removed > 0)
    }
}

/// The names a wikilink may reach this note by (§4.3).
fn write_names(
    transaction: &Transaction<'_>,
    note_id: i64,
    path: &str,
    doc: &mb_core::Document,
) -> Result<(), Error> {
    let mut insert = transaction.prepare_cached(
        "INSERT INTO note_names (note_id, name, key, kind, path) VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    let relative = path.trim_end_matches(".md");
    insert.execute(rusqlite::params![
        note_id,
        relative,
        names::fold(relative),
        "path",
        path
    ])?;
    let stem = relative.rsplit('/').next().unwrap_or(relative);
    if stem != relative {
        insert.execute(rusqlite::params![
            note_id,
            stem,
            names::fold(stem),
            "stem",
            path
        ])?;
    }
    for alias in &doc.frontmatter.aliases {
        insert.execute(rusqlite::params![
            note_id,
            alias,
            names::fold(alias),
            "alias",
            path
        ])?;
    }
    Ok(())
}

fn write_links(
    transaction: &Transaction<'_>,
    note_id: i64,
    path: &str,
    facts: &Extracted,
) -> Result<(), Error> {
    let mut insert = transaction.prepare_cached(
        "INSERT INTO links
            (source_id, source_path, target_raw, target_key, anchor_kind, anchor, kind,
             source_block, context, ordinal)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    )?;
    for (ordinal, link) in facts.links.iter().enumerate() {
        let (anchor_kind, anchor) = match &link.anchor {
            None => (ANCHOR_NONE, None),
            Some(Anchor::Heading(value)) => (ANCHOR_HEADING, Some(value.clone())),
            Some(Anchor::Block(value)) => (ANCHOR_BLOCK, Some(value.clone())),
        };
        insert.execute(rusqlite::params![
            note_id,
            path,
            &link.target,
            names::fold(&link.target),
            anchor_kind,
            anchor,
            if link.embed { KIND_EMBED } else { KIND_LINK },
            &link.source_block,
            &link.context,
            i64::try_from(ordinal).unwrap_or(i64::MAX),
        ])?;
    }
    Ok(())
}

/// One row per (tag, prefix) pair, so `#project` finds `#project/mb/spec` (§9.3).
fn write_tags(transaction: &Transaction<'_>, note_id: i64, facts: &Extracted) -> Result<(), Error> {
    let mut insert = transaction.prepare_cached(
        "INSERT INTO tags (note_id, tag, tag_prefix, prefix_key) VALUES (?1, ?2, ?3, ?4)",
    )?;
    for tag in &facts.tags {
        let mut prefix = String::new();
        for segment in tag.split('/') {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(segment);
            insert.execute(rusqlite::params![
                note_id,
                tag,
                &prefix,
                crate::names::fold_tag(&prefix)
            ])?;
        }
    }
    Ok(())
}

fn write_blocks(
    transaction: &Transaction<'_>,
    note_id: i64,
    facts: &Extracted,
) -> Result<(), Error> {
    let mut insert = transaction
        .prepare_cached("INSERT INTO blocks (note_id, block_id, text) VALUES (?1, ?2, ?3)")?;
    for block in &facts.anchors {
        insert.execute(rusqlite::params![note_id, &block.anchor, &block.text])?;
    }
    Ok(())
}

fn write_tasks(
    transaction: &Transaction<'_>,
    note_id: i64,
    facts: &Extracted,
) -> Result<(), Error> {
    let mut insert = transaction.prepare_cached(
        "INSERT INTO tasks
            (note_id, block_id, status, due, scheduled, start, done, priority, text, ordinal)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    )?;
    for (ordinal, task) in facts.tasks.iter().enumerate() {
        let meta = &task.task.meta;
        insert.execute(rusqlite::params![
            note_id,
            &task.anchor,
            status_name(task.task.status),
            meta.due.map(|date| date.to_string()),
            meta.scheduled.map(|date| date.to_string()),
            meta.start.map(|date| date.to_string()),
            meta.done.map(|date| date.to_string()),
            meta.priority.map(priority_name),
            &task.text,
            i64::try_from(ordinal).unwrap_or(i64::MAX),
        ])?;
    }
    Ok(())
}

fn write_media(
    transaction: &Transaction<'_>,
    note_id: i64,
    facts: &Extracted,
) -> Result<(), Error> {
    let mut insert =
        transaction.prepare_cached("INSERT INTO media_refs (note_id, path) VALUES (?1, ?2)")?;
    for reference in &facts.media {
        insert.execute(rusqlite::params![note_id, reference])?;
    }
    Ok(())
}

/// why: stored as words rather than as the emoji marker the file uses. The marker is the
/// *file* format and belongs in `mb-core`; a column a human may have to read in `sqlite3`
/// while debugging a task view is better off saying `highest`.
const fn priority_name(priority: Priority) -> &'static str {
    match priority {
        Priority::Highest => "highest",
        Priority::High => "high",
        Priority::Medium => "medium",
        Priority::Low => "low",
        Priority::Lowest => "lowest",
    }
}

const fn status_name(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Todo => "todo",
        TaskStatus::Done => "done",
        TaskStatus::Cancelled => "cancelled",
    }
}

/// The hash that decides whether a note's rows need rewriting.
///
/// Of the file text exactly as read, not of the parsed document: two files that differ only
/// in whitespace the parser discards still produce the same rows, and rewriting them is
/// cheap enough that being wrong in the safe direction costs nothing.
fn content_hash(markdown: &str) -> String {
    let digest = Sha256::digest(markdown.as_bytes());
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    //! What one note becomes in the index, and what a reindex re-reads (§9.1).
    //!
    //! These read base tables through `testing::rows`, which is exactly what production
    //! code may not do (E5). A test of the *writer* has to see what was written; asserting
    //! it through the filtered reader would test the filter instead.

    use super::*;
    use crate::testing::{indexed, rows};

    #[test]
    fn a_note_records_its_frontmatter_identity_title_and_word_count() {
        let index = indexed(&[(
            "Projects/Roadmap.md",
            "---\nid: 018f2c4e-7b3a-7000-9c1e-4d5f6a7b8c9d\ncreated: 2026-01-01T00:00:00Z\nicon: \"\u{1f9e0}\"\n---\n\n# The Roadmap\n\nthree more words\n",
        )]);
        let note = &rows(
            &index,
            "SELECT path, uuid, title, icon, created, word_count FROM notes",
        )[0];
        assert_eq!(note[0], "Projects/Roadmap.md");
        assert_eq!(note[1], "018f2c4e-7b3a-7000-9c1e-4d5f6a7b8c9d");
        assert_eq!(note[2], "The Roadmap");
        assert_eq!(note[3], "\u{1f9e0}");
        assert_eq!(note[4], "2026-01-01T00:00:00Z");
        assert_eq!(note[5], "5", "the title counts as words too");
    }

    #[test]
    fn a_note_without_frontmatter_is_indexed_with_a_null_identity() {
        // why: C2. A note created by Obsidian, a template or `printf` has no `id:`, and the
        // index answers to the files rather than the other way round.
        let index = indexed(&[("inbox.md", "just text\n")]);
        assert_eq!(rows(&index, "SELECT uuid FROM notes")[0][0], "NULL");
    }

    #[test]
    fn a_note_is_reachable_by_path_stem_and_alias() {
        let index = indexed(&[(
            "Projects/Roadmap.md",
            "---\naliases: [MB Plan]\n---\n\n# Roadmap\n",
        )]);
        let names = rows(&index, "SELECT key, kind FROM note_names ORDER BY kind");
        assert_eq!(
            names,
            vec![
                vec!["mb plan".to_string(), "alias".to_string()],
                vec!["projects/roadmap".to_string(), "path".to_string()],
                vec!["roadmap".to_string(), "stem".to_string()],
            ]
        );
    }

    #[test]
    fn a_root_note_has_no_separate_stem_row() {
        // Its path and its stem are the same string; two identical rows would double every
        // candidate in the resolution query for no gain.
        let index = indexed(&[("inbox.md", "# Inbox\n")]);
        assert_eq!(
            rows(&index, "SELECT kind FROM note_names"),
            vec![vec!["path"]]
        );
    }

    #[test]
    fn a_link_records_its_raw_target_anchor_kind_and_context() {
        let index = indexed(&[(
            "Q3.md",
            "Plan: see [[Projects/Roadmap#Goals|the goals]] ^plan\n\nAlso ![[Notes#^b1]].\n",
        )]);
        let links = rows(
            &index,
            "SELECT target_raw, target_key, anchor_kind, anchor, kind, source_block, context, ordinal
             FROM links ORDER BY ordinal",
        );
        assert_eq!(links[0][0], "Projects/Roadmap");
        assert_eq!(links[0][1], "projects/roadmap");
        assert_eq!(links[0][2], "heading");
        assert_eq!(links[0][3], "Goals");
        assert_eq!(links[0][4], "link");
        assert_eq!(links[0][5], "plan");
        assert_eq!(links[0][6], "Plan: see the goals");
        assert_eq!(links[1][2], "block");
        assert_eq!(links[1][3], "b1");
        assert_eq!(links[1][4], "embed");
        assert_eq!(links[1][5], "NULL");
    }

    #[test]
    fn a_nested_tag_writes_one_row_per_prefix() {
        let index = indexed(&[("a.md", "#project/memberberry/spec\n")]);
        let tags = rows(&index, "SELECT tag_prefix FROM tags ORDER BY tag_prefix");
        assert_eq!(
            tags,
            vec![
                vec!["project"],
                vec!["project/memberberry"],
                vec!["project/memberberry/spec"],
            ]
        );
    }

    #[test]
    fn a_prefix_is_stored_folded_beside_the_spelling_that_was_written() {
        let index = indexed(&[("a.md", "#Project/Memberberry\n")]);
        assert_eq!(
            rows(
                &index,
                "SELECT tag_prefix, prefix_key FROM tags ORDER BY tag_prefix"
            ),
            vec![
                vec!["Project", "project"],
                vec!["Project/Memberberry", "project/memberberry"],
            ]
        );
    }

    #[test]
    fn frontmatter_and_inline_tags_are_both_indexed() {
        let index = indexed(&[("a.md", "---\ntags: [architecture]\n---\n\n#inline\n")]);
        assert_eq!(
            rows(&index, "SELECT tag FROM tags ORDER BY tag"),
            vec![vec!["architecture"], vec!["inline"]]
        );
    }

    #[test]
    fn only_anchored_blocks_are_indexed_and_they_carry_their_text() {
        let index = indexed(&[("a.md", "anchored ^b1\n\nunanchored\n")]);
        assert_eq!(
            rows(&index, "SELECT block_id, text FROM blocks"),
            vec![vec!["b1", "anchored"]]
        );
    }

    #[test]
    fn a_task_records_its_status_dates_and_priority() {
        let index = indexed(&[(
            "a.md",
            "- [x] ship it \u{1f4c5} 2026-09-05 \u{23eb} \u{2705} 2026-09-04 ^t1\n",
        )]);
        let tasks = rows(
            &index,
            "SELECT block_id, status, due, done, priority, text FROM tasks",
        );
        assert_eq!(
            tasks,
            vec![vec![
                "t1",
                "done",
                "2026-09-05",
                "2026-09-04",
                "high",
                "ship it"
            ]]
        );
    }

    #[test]
    fn a_media_reference_is_indexed_by_its_vault_relative_path() {
        let index = indexed(&[("a.md", "![alt](media/a3/f9/a3f9.png)\n")]);
        assert_eq!(
            rows(&index, "SELECT path FROM media_refs"),
            vec![vec!["media/a3/f9/a3f9.png"]]
        );
    }

    // --- Incremental behaviour.

    #[test]
    fn upserting_the_same_content_under_a_new_stamp_changes_no_rows() {
        let mut index = Index::in_memory().expect("index");
        let input = |stamp| NoteInput {
            path: "a.md".to_string(),
            markdown: "see [[B]]\n".to_string(),
            stamp,
        };
        assert_eq!(
            index
                .upsert(&input(Stamp::from_parts(10, 1)))
                .expect("first"),
            Changed::Inserted
        );
        let before = rows(&index, "SELECT rowid FROM links");
        assert_eq!(
            index
                .upsert(&input(Stamp::from_parts(10, 2)))
                .expect("second"),
            Changed::Unchanged,
            "a touch must not rewrite rows"
        );
        assert_eq!(
            rows(&index, "SELECT rowid FROM links"),
            before,
            "the link row survived, so nothing downstream saw a change"
        );
        assert_eq!(rows(&index, "SELECT stamp FROM notes")[0][0], "10:2");
    }

    #[test]
    fn changed_content_replaces_every_row_for_that_note() {
        let mut index = Index::in_memory().expect("index");
        index
            .upsert(&NoteInput {
                path: "a.md".to_string(),
                markdown: "see [[Gone]] #old\n".to_string(),
                stamp: Stamp::from_parts(1, 1),
            })
            .expect("first");
        assert_eq!(
            index
                .upsert(&NoteInput {
                    path: "a.md".to_string(),
                    markdown: "see [[New]]\n".to_string(),
                    stamp: Stamp::from_parts(2, 2),
                })
                .expect("second"),
            Changed::Rewritten
        );
        assert_eq!(
            rows(&index, "SELECT target_raw FROM links"),
            vec![vec!["New"]]
        );
        assert!(
            rows(&index, "SELECT tag FROM tags").is_empty(),
            "the removed tag must not survive its note's rewrite"
        );
        assert_eq!(rows(&index, "SELECT count(*) FROM notes")[0][0], "1");
    }

    #[test]
    fn removing_a_note_removes_everything_that_hung_off_it() {
        let mut index = indexed(&[("a.md", "see [[B]] #tag ^b1\n\n- [ ] task\n")]);
        assert!(index.remove("a.md").expect("remove"));
        for table in ["notes", "links", "tags", "blocks", "tasks", "note_names"] {
            assert_eq!(
                rows(&index, &format!("SELECT count(*) FROM {table}"))[0][0],
                "0",
                "{table} kept a row for a deleted note"
            );
        }
    }

    #[test]
    fn removing_a_note_that_was_never_indexed_reports_nothing_removed() {
        let mut index = Index::in_memory().expect("index");
        assert!(!index.remove("ghost.md").expect("remove"));
    }

    #[test]
    fn a_reconcile_asks_for_new_and_changed_notes_only() {
        let mut index = Index::in_memory().expect("index");
        index
            .upsert(&NoteInput {
                path: "same.md".to_string(),
                markdown: "unchanged\n".to_string(),
                stamp: Stamp::from_parts(1, 1),
            })
            .expect("upsert");
        index
            .upsert(&NoteInput {
                path: "edited.md".to_string(),
                markdown: "before\n".to_string(),
                stamp: Stamp::from_parts(1, 1),
            })
            .expect("upsert");
        let plan = index
            .reconcile(&[
                ("same.md".to_string(), Stamp::from_parts(1, 1)),
                ("edited.md".to_string(), Stamp::from_parts(2, 5)),
                ("new.md".to_string(), Stamp::from_parts(3, 3)),
            ])
            .expect("reconcile");
        assert_eq!(plan.stale, vec!["edited.md", "new.md"]);
        assert!(plan.removed.is_empty());
        assert!(!plan.is_empty());
    }

    #[test]
    fn a_reconcile_deletes_notes_that_left_the_vault() {
        let mut index = indexed(&[("gone.md", "see [[B]]\n"), ("kept.md", "here\n")]);
        let plan = index
            .reconcile(&[("kept.md".to_string(), Stamp::from_parts(7, 0))])
            .expect("reconcile");
        assert_eq!(plan.removed, vec!["gone.md"]);
        assert_eq!(
            rows(&index, "SELECT path FROM notes"),
            vec![vec!["kept.md"]],
            "removals are applied by the reconcile, not reported for the caller to apply"
        );
        assert!(
            rows(&index, "SELECT target_raw FROM links").is_empty(),
            "the deleted note's links went with it"
        );
    }

    #[test]
    fn a_settled_vault_reconciles_to_nothing() {
        let mut index = Index::in_memory().expect("index");
        index
            .upsert(&NoteInput {
                path: "a.md".to_string(),
                markdown: "text\n".to_string(),
                stamp: Stamp::from_parts(5, 9),
            })
            .expect("upsert");
        let plan = index
            .reconcile(&[("a.md".to_string(), Stamp::from_parts(5, 9))])
            .expect("reconcile");
        assert!(plan.is_empty(), "{plan:?}");
    }
}
