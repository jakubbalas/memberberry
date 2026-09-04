//! The index schema (`SPEC.md` §9.1), and the policy for changing it.
//!
//! **The index is derived state.** Everything in it can be rebuilt from the Markdown files,
//! which is Invariant I1 (§22.4): `rm -rf .memberberry/` and the application still works.
//! That makes migrations unnecessary and a liability — a migration is code that has to be
//! right about data it cannot see. So the schema carries a version in SQLite's
//! `user_version`, and a database stamped with anything else is **dropped and rebuilt**.
//! The same applies to a file that will not open at all.

use rusqlite::Connection;

use crate::Error;

/// Bumped whenever the DDL below changes. A mismatch rebuilds; it never migrates.
pub(crate) const VERSION: i32 = 2;

/// Every table the reader's views are built over.
///
/// Written as one string so a partially created schema is impossible: it runs inside the
/// transaction that stamps the version.
const DDL: &str = "
CREATE TABLE notes (
    id           INTEGER PRIMARY KEY,
    path         TEXT    NOT NULL UNIQUE,
    -- §4.3's frontmatter identity, when the note carries one. Nullable on purpose: a note
    -- written by Obsidian, a template, or `printf > note.md` has no `id:` and must still be
    -- indexable, because C2 says the files are the truth and the index answers to them.
    uuid         TEXT,
    title        TEXT,
    icon         TEXT,
    created      TEXT,
    updated      TEXT,
    content_hash TEXT    NOT NULL,
    word_count   INTEGER NOT NULL,
    -- Cheap evidence the file has not changed, so a reconcile can skip reading it.
    stamp        TEXT    NOT NULL
) STRICT;

CREATE INDEX notes_uuid ON notes(uuid);

CREATE TABLE note_names (
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    -- The name as a human wrote it, for display.
    name    TEXT    NOT NULL,
    -- The same name folded for lookup: NFC, lowercase. What a wikilink is matched against.
    key     TEXT    NOT NULL,
    -- path | stem | alias. A full path beats a bare name when both match (§4.3).
    kind    TEXT    NOT NULL,
    -- Denormalised from `notes`, so nearest-path ranking is one join rather than three.
    path    TEXT    NOT NULL
) STRICT;

CREATE INDEX note_names_key ON note_names(key);
CREATE INDEX note_names_note ON note_names(note_id);

CREATE TABLE links (
    -- A link needs its own identity so the resolution view can rank candidates per link.
    -- A view has no rowid, so borrowing the table's was not an option.
    id           INTEGER PRIMARY KEY,
    source_id    INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    -- Denormalised for the same reason as `note_names.path`.
    source_path  TEXT    NOT NULL,
    -- The target exactly as the file spells it: `[[Projects/Roadmap|the plan]]` keeps
    -- `Projects/Roadmap`, because that is what a rename has to rewrite (§6.6).
    target_raw   TEXT    NOT NULL,
    -- The folded form, matched against `note_names.key`.
    target_key   TEXT    NOT NULL,
    anchor_kind  TEXT    NOT NULL,   -- none | heading | block
    anchor       TEXT,
    kind         TEXT    NOT NULL,   -- link | embed
    source_block TEXT,
    -- Visible text of the block the link sits in — the context a backlink row shows (§9.5).
    context      TEXT,
    -- Position within the note, so backlinks read in document order rather than rowid order.
    ordinal      INTEGER NOT NULL
) STRICT;

CREATE INDEX links_source ON links(source_id);
CREATE INDEX links_target ON links(target_key);

CREATE TABLE tags (
    note_id    INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    tag        TEXT    NOT NULL,
    -- One row per prefix of a nested tag, so `#project/mb/spec` answers a query for
    -- `#project` without a LIKE scan (§9.3). The full tag is also one of its own prefixes.
    tag_prefix TEXT    NOT NULL,
    -- The prefix folded to NFC and lowercase, which is the tag's *identity*: `#Project` and
    -- `#project` are one tag with one count (§9.3). `tag_prefix` keeps the spelling so the
    -- pane can show a tag as somebody wrote it.
    prefix_key TEXT    NOT NULL
) STRICT;

CREATE INDEX tags_prefix ON tags(prefix_key);
CREATE INDEX tags_note ON tags(note_id);

CREATE TABLE blocks (
    note_id  INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    block_id TEXT    NOT NULL,
    text     TEXT    NOT NULL
) STRICT;

CREATE INDEX blocks_note ON blocks(note_id);
CREATE UNIQUE INDEX blocks_id ON blocks(note_id, block_id);

CREATE TABLE tasks (
    note_id   INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    block_id  TEXT,
    status    TEXT    NOT NULL,
    due       TEXT,
    scheduled TEXT,
    start     TEXT,
    done      TEXT,
    priority  TEXT,
    text      TEXT    NOT NULL,
    ordinal   INTEGER NOT NULL
) STRICT;

CREATE INDEX tasks_note ON tasks(note_id);
CREATE INDEX tasks_due ON tasks(due);

CREATE TABLE media_refs (
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    -- The vault-relative reference as written, e.g. `media/a3/f9/a3f9…e2.png`.
    path    TEXT    NOT NULL
) STRICT;

CREATE INDEX media_refs_path ON media_refs(path);
CREATE INDEX media_refs_note ON media_refs(note_id);
";

/// Opens `conn` as an index, creating or rebuilding the schema as needed.
pub(crate) fn install(conn: &Connection) -> Result<(), Error> {
    // why: `ON DELETE CASCADE` is a no-op without this pragma, and every child table
    // depends on it to make removing a note one statement instead of eight.
    conn.pragma_update(None, "foreign_keys", "ON")?;
    // The index is rebuildable, so durability buys nothing and costs a fsync per note on a
    // full reindex of 10 000 files.
    conn.pragma_update(None, "synchronous", "OFF")?;
    conn.pragma_update(None, "journal_mode", "WAL")?;

    if version_of(conn)? == VERSION && has_tables(conn)? {
        return Ok(());
    }
    reset(conn)
}

/// Drops everything and recreates it at [`VERSION`].
fn reset(conn: &Connection) -> Result<(), Error> {
    // why: `writable_schema` tricks are how corrupt-schema repairs are usually written, and
    // they are how a repair corrupts a database further. Dropping by name is boring, uses
    // only documented behaviour, and cannot leave a half-dropped schema because it is one
    // transaction with the version stamp.
    let names: Vec<String> = {
        let mut statement = conn.prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<Result<_, _>>()?
    };
    conn.execute_batch("BEGIN")?;
    for name in names {
        // The name comes from `sqlite_schema`, so it cannot be attacker-supplied text;
        // quoting it is still correct rather than optional, because a table name may be a
        // keyword.
        conn.execute_batch(&format!("DROP TABLE IF EXISTS \"{name}\""))?;
    }
    conn.execute_batch(DDL)?;
    conn.pragma_update(None, "user_version", VERSION)?;
    conn.execute_batch("COMMIT")?;
    Ok(())
}

fn version_of(conn: &Connection) -> Result<i32, Error> {
    Ok(conn.query_row("SELECT * FROM pragma_user_version", [], |row| row.get(0))?)
}

/// Whether the stamped version is backed by an actual schema.
///
/// A zero-length file reports `user_version` 0, but so does a database someone stamped by
/// hand. Checking for the table the reader needs first is what turns "the version matches"
/// into "the schema is there".
fn has_tables(conn: &Connection) -> Result<bool, Error> {
    let count: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = 'notes'",
        [],
        |row| row.get(0),
    )?;
    Ok(count == 1)
}
