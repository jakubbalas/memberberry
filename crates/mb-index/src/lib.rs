//! # mb-index
//!
//! The per-vault SQLite store behind links, backlinks, tags, tasks, media references and
//! the graph (`SPEC.md` §9.1). One database per vault, at
//! `<vault>/.memberberry/index/graph.sqlite`.
//!
//! ## Two rules shape everything here
//!
//! **It is derived state.** Every row can be rebuilt from the Markdown files, so nothing in
//! it is ever the truth about a note (C2). Deleting the file is a supported operation, not a
//! disaster (Invariant I1, §22.4): the next reconcile finds every note stale and rebuilds.
//! That is also why there are no migrations — see [`schema`].
//!
//! **There is no unfiltered read.** Queries live on [`Reader`], which cannot exist without a
//! user and an ACL, and every one of them is written against views that already join the
//! readable set (E5, §6.5). The filter is in one place — `readable::VIEWS` — rather than
//! repeated per query, because a filter repeated per query is a filter someone will forget.
//! `tests/no_unfiltered_query.rs` fails if a query in `read.rs` names a base table.
//!
//! ## What is written versus what is read
//!
//! The writer populates every table in §9.1 that has facts available today, including
//! `tasks` and `media_refs`, whose readers arrive with task views and M11's media
//! authorization. That is deliberate: the extractor already produces those facts, one
//! reindex path is cheaper to trust than four, and a table that starts being written two
//! milestones after its rows first mattered is a table full of holes. `tags` was written
//! that way for two milestones and read for the first time by the tag pane (§9.3), which
//! needed no reindex to work.
//!
//! `zones` is derived from the live ACL rather than Markdown, and is maintained separately
//! from note rows for that reason. `media_refs` records the vault-relative reference rather
//! than a content hash because §12.2's content-addressed store does not exist before M11.

// AGENTS.md 4.2 permits panicking constructs in tests only.
#![cfg_attr(
    test,
    allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)
)]

#[cfg(test)]
mod testing;

mod graph;
mod names;
mod read;
mod readable;
mod schema;
mod search;
mod write;
mod zones;

use std::path::{Path, PathBuf};

use rusqlite::Connection;

pub use graph::{
    Graph, GraphEdge, GraphNode, MAX_HOPS, MAX_NEIGHBOURHOOD, MAX_VAULT_GRAPH, VaultGraph,
    VaultNode,
};
pub use read::{Backlink, BacklinkGroup, Reader, TagNode, Target, TaskEntry, TaskQuery, TaskSort};
pub use search::{MentionGroup, SearchHit};
pub use write::{Changed, NoteInput, Plan, Stamp};
pub use zones::ClientSegment;

/// Everything that can go wrong reading or maintaining an index.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("index database: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("full-text index: {0}")]
    Search(#[from] tantivy::TantivyError),

    #[error("invalid search query: {0}")]
    Query(#[from] tantivy::query::QueryParserError),

    #[error("compact client index: {0}")]
    Compact(#[from] mb_search::Error),

    #[error("creating the index directory {path}: {source}")]
    Directory {
        path: PathBuf,
        source: std::io::Error,
    },

    #[error("writing client index segment {path}: {source}")]
    SegmentWrite {
        path: PathBuf,
        source: std::io::Error,
    },

    /// The file could not be replaced after it failed to open as a database.
    #[error("replacing the unreadable index at {path}: {source}")]
    Replace {
        path: PathBuf,
        source: std::io::Error,
    },
}

/// One vault's index.
///
/// Holds a single connection, so it is used behind a lock. That is deliberate rather than a
/// limitation to work around: writes are serialized anyway, [`Reader`] needs `&mut` to
/// guarantee one readable set is installed at a time, and a connection pool would buy
/// concurrency the maintenance tick does not have.
#[derive(Debug)]
pub struct Index {
    conn: Connection,
    path: Option<PathBuf>,
    search: search::SearchIndex,
    zone_segments: zones::PublishedSegments,
}

impl Index {
    /// Opens, creating the parent directory, the database and the schema as needed.
    ///
    /// A file that will not open as a database, or one stamped with a different schema
    /// version, is **replaced**. Both are recoverable exactly because the index is derived
    /// state: the alternative is a vault that serves no backlinks until an operator notices
    /// a log line.
    ///
    /// # Errors
    ///
    /// Fails if the directory cannot be created, if an unusable file cannot be removed, or
    /// if a freshly created database rejects the schema.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, Error> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|source| Error::Directory {
                path: parent.to_path_buf(),
                source,
            })?;
        }
        match Self::try_open(path) {
            Ok(index) => Ok(index),
            Err(_) => {
                std::fs::remove_file(path).map_err(|source| Error::Replace {
                    path: path.to_path_buf(),
                    source,
                })?;
                Self::try_open(path)
            }
        }
    }

    fn try_open(path: &Path) -> Result<Self, Error> {
        let conn = Connection::open(path)?;
        names::register(&conn)?;
        schema::install(&conn)?;
        readable::install(&conn)?;
        let mut search = search::SearchIndex::open(path.with_file_name("search-v1"))?;
        let sqlite_notes = schema::note_count(&conn)?;
        if sqlite_notes > 0 && search.is_empty() {
            // The text directory was lost independently. Clearing stamps makes the next
            // reconcile reread every Markdown file instead of preserving a silently empty
            // search index (Invariant I1).
            schema::clear_notes(&conn)?;
        } else if sqlite_notes == 0 && !search.is_empty() {
            // The SQLite half was rebuilt. Its readable set is the authorization source,
            // so stale text documents are not a leak, but clearing them avoids resurrecting
            // matches if the same paths are later recreated.
            search.clear()?;
        }
        Ok(Self {
            conn,
            path: Some(path.to_path_buf()),
            search,
            zone_segments: zones::PublishedSegments::default(),
        })
    }

    /// An index that exists only for the lifetime of the process.
    ///
    /// For tests, and for a vault whose `.memberberry/` is not writable — a read-only mount
    /// should degrade to a cold index rather than to no index.
    ///
    /// # Errors
    ///
    /// Fails only if SQLite cannot create an in-memory database.
    pub fn in_memory() -> Result<Self, Error> {
        let conn = Connection::open_in_memory()?;
        names::register(&conn)?;
        schema::install(&conn)?;
        readable::install(&conn)?;
        let search = search::SearchIndex::in_memory()?;
        Ok(Self {
            conn,
            path: None,
            search,
            zone_segments: zones::PublishedSegments::default(),
        })
    }

    /// Where this index is stored, or `None` for [`Index::in_memory`].
    #[must_use]
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }
}
