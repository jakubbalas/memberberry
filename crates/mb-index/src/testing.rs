//! Helpers for the crate's own unit tests.
//!
//! `#[cfg(test)]`, and that is the point: asserting what the *writer* wrote means reading a
//! base table, which no production caller may do (E5). Keeping that ability inside the crate
//! means there is no public escape hatch for it — see `tests/no_unfiltered_query.rs`.

use crate::{Index, NoteInput, Stamp};

/// Runs a query and returns every row as strings, `NULL` included.
pub(crate) fn rows(index: &Index, sql: &str) -> Vec<Vec<String>> {
    let mut statement = index.conn.prepare(sql).expect("prepare");
    let columns = statement.column_count();
    let mut query = statement.query([]).expect("query");
    let mut out = Vec::new();
    while let Some(row) = query.next().expect("row") {
        let mut values = Vec::new();
        for column in 0..columns {
            let value = row.get_ref(column).expect("column");
            values.push(match value {
                rusqlite::types::ValueRef::Null => "NULL".to_string(),
                rusqlite::types::ValueRef::Integer(n) => n.to_string(),
                rusqlite::types::ValueRef::Real(n) => n.to_string(),
                rusqlite::types::ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
                rusqlite::types::ValueRef::Blob(_) => "<blob>".to_string(),
            });
        }
        out.push(values);
    }
    out
}

/// An in-memory index holding exactly these notes.
pub(crate) fn indexed(notes: &[(&str, &str)]) -> Index {
    let mut index = Index::in_memory().expect("in-memory index");
    for (n, (path, markdown)) in notes.iter().enumerate() {
        index
            .upsert(&NoteInput {
                path: (*path).to_string(),
                markdown: (*markdown).to_string(),
                stamp: Stamp::from_parts(markdown.len() as u64, n as u128),
            })
            .expect("upsert");
    }
    index
}
