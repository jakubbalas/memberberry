//! The permission filter, in one place (`SPEC.md` §6.5, E5).
//!
//! §6.5 requires the readable-set filter to live at the index layer rather than in feature
//! code, so this module owns it entirely and `read.rs` never mentions a base table. The
//! shape is a temporary table of readable note ids plus one view per content table joined
//! against it; a query that forgets the filter would have to name a base table to do so, and
//! `tests/no_unfiltered_query.rs` fails when one does.
//!
//! Failing closed is structural here: the temp table starts empty, so a query run before a
//! readable set is installed returns nothing rather than everything.

use mb_core::{Access, NotePath, Role, Username};
use rusqlite::Connection;

use crate::{Error, names};

/// The readable-set table and the filtered views over it.
///
/// Temporary, so they belong to the connection rather than the database file: an index
/// opened by another process is not carrying one user's permissions around in its schema.
const VIEWS: &str = "
CREATE TEMP TABLE readable (note_id INTEGER PRIMARY KEY) STRICT;

CREATE TEMP VIEW v_notes AS
    SELECT n.* FROM notes n JOIN readable r ON r.note_id = n.id;

CREATE TEMP VIEW v_note_names AS
    SELECT nn.* FROM note_names nn JOIN readable r ON r.note_id = nn.note_id;

CREATE TEMP VIEW v_links AS
    SELECT l.* FROM links l JOIN readable r ON r.note_id = l.source_id;

CREATE TEMP VIEW v_tags AS
    SELECT t.* FROM tags t JOIN readable r ON r.note_id = t.note_id;

CREATE TEMP VIEW v_blocks AS
    SELECT b.* FROM blocks b JOIN readable r ON r.note_id = b.note_id;
";

/// Resolves each link to the note it points at, or to NULL (§4.3).
///
/// Separate from [`VIEWS`] because it interpolates the ranking function's name, and because
/// the ordering *is* §4.3's collision rule and deserves to be read on its own:
///
/// 1. a candidate matched by full path beats one matched by bare name or alias, so writing
///    `[[Projects/Roadmap]]` is how a human disambiguates and it always wins;
/// 2. then the nearest candidate, by shared folders with the source note;
/// 3. then the shallowest, then alphabetical — deterministic, never filesystem order.
///
/// Candidates come from `v_note_names`, so a link into a note the caller cannot read
/// resolves to NULL exactly as a link into a note that was never written does. That is E9
/// ("edges into unreadable notes are dropped") and §6.5 in one clause: an unreadable target
/// is indistinguishable from a missing one.
///
/// why: a window function rather than a correlated subquery. The ranking needs columns from
/// both the link and the candidate, and SQLite does not resolve an outer reference inside a
/// subquery's `ORDER BY` — the first version of this view failed with `no such column:
/// l.source_path`. Ranking over a `LEFT JOIN` keeps unresolved links, which is what makes a
/// ghost node (§9.1) a row rather than an absence.
const RESOLVED: &str = "
CREATE TEMP VIEW v_resolved AS
SELECT * FROM (
    SELECT l.*, nn.note_id AS target_id,
           row_number() OVER (
               PARTITION BY l.id
               ORDER BY (nn.kind = 'path') DESC,
                        {rank}(l.source_path, nn.path) DESC,
                        (length(nn.path) - length(replace(nn.path, '/', ''))) ASC,
                        nn.path ASC
           ) AS pick
    FROM v_links l
    LEFT JOIN v_note_names nn ON nn.key = l.target_key
)
WHERE pick = 1;
";

/// Creates the filter's table and views on a fresh connection.
pub(crate) fn install(conn: &Connection) -> Result<(), Error> {
    conn.execute_batch(VIEWS)?;
    conn.execute_batch(&RESOLVED.replace("{rank}", names::RANK))?;
    Ok(())
}

/// Replaces the readable set with the notes `user` may read under `access`.
///
/// Returns how many notes that is, which is what makes an empty answer distinguishable
/// from an unpopulated one in a test.
pub(crate) fn populate(
    conn: &mut Connection,
    access: &Access,
    user: &Username,
) -> Result<usize, Error> {
    let indexed: Vec<(i64, String)> = {
        let mut statement = conn.prepare_cached("SELECT id, path FROM notes")?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    let transaction = conn.transaction()?;
    transaction.execute("DELETE FROM readable", [])?;
    let mut readable = 0;
    {
        let mut insert =
            transaction.prepare_cached("INSERT INTO readable (note_id) VALUES (?1)")?;
        for (id, path) in indexed {
            if !may_read(access, user, &path) {
                continue;
            }
            insert.execute([id])?;
            readable += 1;
        }
    }
    transaction.commit()?;
    Ok(readable)
}

/// why: an unparseable path denies. A path the ACL vocabulary cannot express is one whose
/// permissions cannot be resolved, and §3.1 says that fails closed — the note becomes
/// invisible rather than public.
fn may_read(access: &Access, user: &Username, path: &str) -> bool {
    NotePath::parse(path).is_ok_and(|note| access.effective_role(user, &note) != Role::None)
}
