//! Name folding and nearest-path link resolution (`SPEC.md` §4.3).
//!
//! A wikilink is written by human-readable name, so resolving one is a *name* lookup, and
//! two notes are allowed to share a name. §4.3 resolves that collision by nearest path:
//! `[[Roadmap]]` in `Projects/Q3.md` means `Projects/Roadmap.md` rather than
//! `Archive/Roadmap.md`.
//!
//! Ranking candidates therefore needs both paths, which is why it is a SQLite scalar
//! function rather than a pass in Rust over query results: the ranking has to happen inside
//! the query that picks the target, and it has to be the same ranking everywhere.

use rusqlite::Connection;
use rusqlite::functions::FunctionFlags;

use crate::Error;

/// The name of the scalar function registered on every connection.
pub(crate) const RANK: &str = "mb_link_rank";

/// Folds a name or path into the form links are matched on.
///
/// `mb-core` owns the rule ([`mb_core::names::fold_name`]): the same folding decides which
/// links a rename rewrites (§6.6), and two copies of it are two answers to "is `[[roadmap]]`
/// a link to `Roadmap.md`". Re-exported here so the SQL in this crate reads as one thing.
pub(crate) fn fold(value: &str) -> String {
    mb_core::names::fold_name(value)
}

/// Folds a tag into the form the tag pane groups on (§9.3).
pub(crate) fn fold_tag(value: &str) -> String {
    mb_core::names::fold_tag(value)
}

/// How near two notes are: the number of leading directory segments they share.
///
/// Both paths are vault-relative. Only directories count — the filename is what is being
/// matched, not what makes a candidate near — so `Projects/Roadmap.md` and `Projects/Q3.md`
/// share one segment, and two notes at the vault root share zero.
pub(crate) fn shared_segments(source: &str, candidate: &str) -> i64 {
    let source = folders(source);
    let candidate = folders(candidate);
    let mut shared = 0;
    for (a, b) in source.zip(candidate) {
        if fold(a) != fold(b) {
            break;
        }
        shared += 1;
    }
    shared
}

fn folders(path: &str) -> impl Iterator<Item = &str> {
    let mut segments: Vec<&str> = path.split('/').collect();
    segments.pop();
    segments.into_iter()
}

/// Registers [`RANK`] so the reader's views can order candidates by nearness.
pub(crate) fn register(conn: &Connection) -> Result<(), Error> {
    conn.create_scalar_function(
        RANK,
        2,
        // Deterministic: it reads only its arguments, which lets SQLite use it inside a
        // view and in an index-driven ORDER BY without re-evaluating it per row twice.
        FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_UTF8,
        |context| {
            // why: both arguments may be NULL. The resolution view ranks over a LEFT JOIN
            // so that a link with no candidate survives as a ghost (§9.1), and SQLite still
            // evaluates the ranking for that row. A missing candidate is maximally far.
            let source = context.get::<Option<String>>(0)?.unwrap_or_default();
            let candidate = context.get::<Option<String>>(1)?.unwrap_or_default();
            Ok(shared_segments(&source, &candidate))
        },
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_path_is_maximally_far() {
        assert_eq!(shared_segments("", "Projects/Roadmap.md"), 0);
        assert_eq!(shared_segments("Projects/Q3.md", ""), 0);
    }

    #[test]
    fn nearness_counts_shared_folders_only() {
        assert_eq!(shared_segments("Projects/Q3.md", "Projects/Roadmap.md"), 1);
        assert_eq!(shared_segments("Projects/Q3.md", "Archive/Roadmap.md"), 0);
        assert_eq!(shared_segments("Q3.md", "Roadmap.md"), 0);
    }

    #[test]
    fn nearness_stops_at_the_first_differing_folder() {
        assert_eq!(
            shared_segments("a/b/c/note.md", "a/b/other/note.md"),
            2,
            "a shared grandparent does not make a cousin nearer than a sibling"
        );
    }

    #[test]
    fn a_folder_name_is_matched_case_insensitively_like_every_other_name() {
        assert_eq!(shared_segments("Projects/Q3.md", "projects/Roadmap.md"), 1);
    }
}
