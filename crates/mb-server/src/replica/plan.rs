//! The three-way comparison behind a replica's sync pass (`SPEC.md` §7.6.9).
//!
//! Pure: it takes what upstream lists, what the local folder holds and the sync record of
//! what both held after the last pass, and says what to do. Nothing here touches a file or a
//! socket, so every rule is tested exhaustively without either.
//!
//! The rules all lean one way: **no outcome may lose writing** (A43, S13). A note only goes
//! away on one side when the other side deleted it *and* this side has not changed it since
//! the last pass. Without a record (I1), nothing is treated as deleted.

use std::collections::{BTreeMap, BTreeSet};

/// A note as upstream lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpstreamNote {
    /// Vault-relative path.
    pub path: String,
    /// Frontmatter `id`, when the note has one (§4.3).
    pub id: Option<String>,
    /// Upstream's opaque change token.
    pub version: String,
    /// Whether the device's user may edit it.
    pub editable: bool,
    /// Its title, kept for listing it while offline (§7.6.10). The planner ignores it.
    pub title: Option<String>,
}

/// A note as the local folder holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalNote {
    /// Vault-relative path.
    pub path: String,
    /// Frontmatter `id`, when the note has one.
    pub id: Option<String>,
    /// The local file's opaque change token.
    pub version: String,
}

/// What both sides held for one note after the last pass.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RecordEntry {
    /// The note's path on both sides.
    pub path: String,
    /// Its frontmatter `id`, if it had one.
    #[serde(default)]
    pub id: Option<String>,
    /// Upstream's change token when last synced.
    pub upstream_version: String,
    /// The local change token when last synced.
    pub local_version: String,
    /// Why the note is not syncing, when it is held back for the user to resolve.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub held: Option<Held>,
}

/// Why a note is held back rather than synced.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Held {
    /// Changed here after upstream stopped listing it (deleted, moved or access removed).
    ///
    /// Read from records written before recovered notes (§7.6.7); a note held for this is
    /// recovered on the next pass, and no pass holds a note for it any more.
    GoneUpstream,
    /// Changed here, but the device's user may only view it upstream.
    ViewOnly,
    /// Created here, and upstream refused it.
    Refused,
}

/// One step of a pass. Executed in the order [`plan`] returns them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Move a local note, changing no text (upstream renamed it).
    MoveLocal { from: String, to: String },
    /// Move an upstream note, changing no text (it was renamed here).
    MoveUpstream { from: String, to: String },
    /// Write a note upstream has and this device does not, from upstream's history.
    Download { path: String },
    /// Create upstream a note only this device has, from this device's history.
    Upload { path: String },
    /// Both sides have the note and at least one changed: exchange histories.
    Exchange {
        path: String,
        local_changed: bool,
        upstream_changed: bool,
    },
    /// The note left the readable set — deleted, moved out of reach, access removed — and
    /// this device has not changed it since: remove every trace of it here (E35).
    Purge { path: String },
    /// The note left the readable set with changes made here: keep them as a recovered note,
    /// then purge it (§7.6.7, E35).
    Recover { path: String },
    /// This device deleted a note upstream has not changed since: send it to upstream trash.
    DeleteUpstream { path: String },
    /// Keep the local note, do not sync it, and tell the user.
    Hold { path: String, why: Held },
    /// Drop the record entry: the note is gone from both sides.
    Forget { path: String },
}

/// The suffix given to this device's copy when two different notes want one path.
pub const THIS_DEVICE: &str = " (this device)";

/// `Notes/Plan.md` → `Notes/Plan (this device).md`.
#[must_use]
pub fn this_device_path(path: &str) -> String {
    let stem = path.strip_suffix(".md").unwrap_or(path);
    format!("{stem}{THIS_DEVICE}.md")
}

/// What each side holds and what was recorded, matched into one row per note.
#[derive(Debug, Default)]
struct Row<'a> {
    upstream: Option<&'a UpstreamNote>,
    local: Option<&'a LocalNote>,
    record: Option<&'a RecordEntry>,
}

/// Plans one pass.
///
/// `upstream_complete` is false when upstream's list was truncated; a note missing from an
/// incomplete list is not evidence of anything, so no deletion is planned in either
/// direction and no new local note is uploaded (its path might be taken).
#[must_use]
pub fn plan(
    upstream: &[UpstreamNote],
    local: &[LocalNote],
    record: &[RecordEntry],
    upstream_complete: bool,
) -> Vec<Action> {
    let rows = match_rows(upstream, local, record);
    let upstream_paths: BTreeSet<&str> = upstream.iter().map(|n| n.path.as_str()).collect();
    let mut moves = Vec::new();
    let mut rest = Vec::new();
    for row in rows {
        plan_row(
            &row,
            upstream_complete,
            &upstream_paths,
            &mut moves,
            &mut rest,
        );
    }
    // why: moves first, so a path a rename frees is free before anything is written there,
    // and an exchange addresses the note by the path it now has on both sides.
    moves.extend(rest);
    moves
}

fn plan_row<'a>(
    row: &Row<'a>,
    upstream_complete: bool,
    upstream_paths: &BTreeSet<&str>,
    moves: &mut Vec<Action>,
    rest: &mut Vec<Action>,
) {
    let held = row.record.and_then(|r| r.held);
    match (row.upstream, row.local, row.record) {
        (Some(up), Some(local), record) => {
            let up_changed = record.is_none_or(|r| r.upstream_version != up.version);
            let local_changed = record.is_none_or(|r| r.local_version != local.version);
            if held.is_some() && !(local_changed || up_changed) {
                rest.push(Action::Hold {
                    path: local.path.clone(),
                    why: held.unwrap_or(Held::Refused),
                });
                return;
            }
            let path = if up.path == local.path {
                up.path.clone()
            } else {
                let renamed_here = record.is_some_and(|r| r.path == up.path);
                if renamed_here && up.editable {
                    moves.push(Action::MoveUpstream {
                        from: up.path.clone(),
                        to: local.path.clone(),
                    });
                    local.path.clone()
                } else {
                    // Upstream renamed it, both did, or this device may not move it there.
                    moves.push(Action::MoveLocal {
                        from: local.path.clone(),
                        to: up.path.clone(),
                    });
                    up.path.clone()
                }
            };
            if !up.editable && local_changed && record.is_some() {
                rest.push(Action::Hold {
                    path,
                    why: Held::ViewOnly,
                });
            } else if up_changed || local_changed {
                rest.push(Action::Exchange {
                    path,
                    local_changed,
                    upstream_changed: up_changed,
                });
            }
        }
        (Some(up), None, Some(record)) => {
            let up_changed = record.upstream_version != up.version;
            if up_changed || !up.editable || !upstream_complete {
                rest.push(Action::Download {
                    path: up.path.clone(),
                });
            } else {
                rest.push(Action::DeleteUpstream {
                    path: up.path.clone(),
                });
            }
        }
        (Some(up), None, None) => rest.push(Action::Download {
            path: up.path.clone(),
        }),
        (None, Some(local), Some(record)) => {
            let local_changed = record.local_version != local.version;
            if !upstream_complete {
                return;
            }
            // why: a note this device created and upstream refused was never in the readable
            // set, so it has not left it; it stays held for the user as before.
            if record.held == Some(Held::Refused) {
                rest.push(Action::Hold {
                    path: local.path.clone(),
                    why: Held::Refused,
                });
            } else if local_changed || record.held.is_some() {
                rest.push(Action::Recover {
                    path: local.path.clone(),
                });
            } else {
                rest.push(Action::Purge {
                    path: local.path.clone(),
                });
            }
        }
        (None, Some(local), None) => {
            if !upstream_complete {
                return;
            }
            if upstream_paths.contains(local.path.as_str()) {
                // A different note holds this path upstream: upstream keeps it (S13).
                let to = this_device_path(&local.path);
                moves.push(Action::MoveLocal {
                    from: local.path.clone(),
                    to: to.clone(),
                });
                rest.push(Action::Upload { path: to });
            } else {
                rest.push(Action::Upload {
                    path: local.path.clone(),
                });
            }
        }
        (None, None, Some(record)) => rest.push(Action::Forget {
            path: record.path.clone(),
        }),
        (None, None, None) => {}
    }
}

/// Marks slot `i` taken, returning whether it was free.
fn take(taken: &mut [bool], i: usize) -> bool {
    match taken.get_mut(i) {
        Some(slot) if !*slot => {
            *slot = true;
            true
        }
        _ => false,
    }
}

/// Pairs notes across the three sources: by frontmatter `id` first, then by path.
///
/// Two notes at one path with *different* ids are different notes and stay unpaired, which
/// is how a create on both sides at one path is told apart from one note on both sides.
fn match_rows<'a>(
    upstream: &'a [UpstreamNote],
    local: &'a [LocalNote],
    record: &'a [RecordEntry],
) -> Vec<Row<'a>> {
    let mut rows: Vec<Row<'a>> = Vec::new();
    let mut local_taken = vec![false; local.len()];
    let mut record_taken = vec![false; record.len()];

    let local_by_id: BTreeMap<&str, usize> = local
        .iter()
        .enumerate()
        .filter_map(|(i, n)| Some((n.id.as_deref()?, i)))
        .collect();
    let record_by_id: BTreeMap<&str, usize> = record
        .iter()
        .enumerate()
        .filter_map(|(i, n)| Some((n.id.as_deref()?, i)))
        .collect();
    let local_by_path: BTreeMap<&str, usize> = local
        .iter()
        .enumerate()
        .map(|(i, n)| (n.path.as_str(), i))
        .collect();
    let record_by_path: BTreeMap<&str, usize> = record
        .iter()
        .enumerate()
        .map(|(i, n)| (n.path.as_str(), i))
        .collect();

    let compatible = |a: Option<&str>, b: Option<&str>| match (a, b) {
        (Some(a), Some(b)) => a == b,
        _ => true,
    };

    for up in upstream {
        let mut row = Row {
            upstream: Some(up),
            ..Row::default()
        };
        let by_id = up.id.as_deref().and_then(|id| local_by_id.get(id).copied());
        let by_path = local_by_path.get(up.path.as_str()).copied().filter(|&i| {
            local
                .get(i)
                .is_some_and(|l| compatible(up.id.as_deref(), l.id.as_deref()))
        });
        if let Some(i) = by_id.or(by_path)
            && take(&mut local_taken, i)
        {
            row.local = local.get(i);
        }
        let by_id = up
            .id
            .as_deref()
            .and_then(|id| record_by_id.get(id).copied());
        let by_path = record_by_path.get(up.path.as_str()).copied().filter(|&i| {
            record
                .get(i)
                .is_some_and(|r| compatible(up.id.as_deref(), r.id.as_deref()))
        });
        if let Some(i) = by_id.or(by_path)
            && take(&mut record_taken, i)
        {
            row.record = record.get(i);
        }
        rows.push(row);
    }
    for (i, note) in local.iter().enumerate() {
        if local_taken.get(i).copied().unwrap_or(true) {
            continue;
        }
        let mut row = Row {
            local: Some(note),
            ..Row::default()
        };
        let by_id = note
            .id
            .as_deref()
            .and_then(|id| record_by_id.get(id).copied());
        let by_path = record_by_path
            .get(note.path.as_str())
            .copied()
            .filter(|&r| {
                record
                    .get(r)
                    .is_some_and(|e| compatible(note.id.as_deref(), e.id.as_deref()))
            });
        if let Some(r) = by_id.or(by_path)
            && take(&mut record_taken, r)
        {
            row.record = record.get(r);
        }
        rows.push(row);
    }
    for (i, entry) in record.iter().enumerate() {
        if !record_taken.get(i).copied().unwrap_or(true) {
            rows.push(Row {
                record: Some(entry),
                ..Row::default()
            });
        }
    }
    rows
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

    use super::*;
    use proptest::prelude::*;

    fn up(path: &str, version: &str) -> UpstreamNote {
        UpstreamNote {
            path: path.into(),
            id: None,
            version: version.into(),
            editable: true,
            title: None,
        }
    }

    fn local(path: &str, version: &str) -> LocalNote {
        LocalNote {
            path: path.into(),
            id: None,
            version: version.into(),
        }
    }

    fn rec(path: &str, upstream_version: &str, local_version: &str) -> RecordEntry {
        RecordEntry {
            path: path.into(),
            id: None,
            upstream_version: upstream_version.into(),
            local_version: local_version.into(),
            held: None,
        }
    }

    fn with_id<T>(mut note: T, id: &str, set: impl Fn(&mut T, Option<String>)) -> T {
        set(&mut note, Some(id.into()));
        note
    }

    #[test]
    fn a_note_unchanged_on_both_sides_needs_nothing() {
        assert!(
            plan(
                &[up("A.md", "1")],
                &[local("A.md", "x")],
                &[rec("A.md", "1", "x")],
                true
            )
            .is_empty()
        );
    }

    #[test]
    fn a_note_changed_upstream_is_exchanged() {
        let actions = plan(
            &[up("A.md", "2")],
            &[local("A.md", "x")],
            &[rec("A.md", "1", "x")],
            true,
        );
        assert_eq!(
            actions,
            vec![Action::Exchange {
                path: "A.md".into(),
                local_changed: false,
                upstream_changed: true
            }]
        );
    }

    #[test]
    fn a_note_changed_here_is_exchanged_as_a_local_change() {
        let actions = plan(
            &[up("A.md", "1")],
            &[local("A.md", "y")],
            &[rec("A.md", "1", "x")],
            true,
        );
        assert_eq!(
            actions,
            vec![Action::Exchange {
                path: "A.md".into(),
                local_changed: true,
                upstream_changed: false,
            }]
        );
    }

    #[test]
    fn a_new_upstream_note_is_downloaded() {
        assert_eq!(
            plan(&[up("A.md", "1")], &[], &[], true),
            vec![Action::Download {
                path: "A.md".into()
            }]
        );
    }

    #[test]
    fn a_new_local_note_is_uploaded() {
        assert_eq!(
            plan(&[], &[local("A.md", "x")], &[], true),
            vec![Action::Upload {
                path: "A.md".into()
            }]
        );
    }

    #[test]
    fn a_note_gone_upstream_and_unchanged_here_is_purged() {
        let actions = plan(&[], &[local("A.md", "x")], &[rec("A.md", "1", "x")], true);
        assert_eq!(
            actions,
            vec![Action::Purge {
                path: "A.md".into()
            }]
        );
    }

    #[test]
    fn a_note_gone_upstream_but_changed_here_is_recovered() {
        let actions = plan(&[], &[local("A.md", "y")], &[rec("A.md", "1", "x")], true);
        assert_eq!(
            actions,
            vec![Action::Recover {
                path: "A.md".into()
            }]
        );
    }

    #[test]
    fn a_view_only_note_changed_here_then_gone_is_recovered() {
        let mut entry = rec("A.md", "1", "x");
        entry.held = Some(Held::ViewOnly);
        let actions = plan(&[], &[local("A.md", "x")], &[entry], true);
        assert_eq!(
            actions,
            vec![Action::Recover {
                path: "A.md".into()
            }]
        );
    }

    #[test]
    fn a_refused_new_note_stays_held_rather_than_recovered() {
        let mut entry = rec("A.md", "", "x");
        entry.held = Some(Held::Refused);
        let actions = plan(&[], &[local("A.md", "y")], &[entry], true);
        assert_eq!(
            actions,
            vec![Action::Hold {
                path: "A.md".into(),
                why: Held::Refused
            }]
        );
    }

    #[test]
    fn a_note_deleted_here_and_unchanged_upstream_is_deleted_upstream() {
        let actions = plan(&[up("A.md", "1")], &[], &[rec("A.md", "1", "x")], true);
        assert_eq!(
            actions,
            vec![Action::DeleteUpstream {
                path: "A.md".into()
            }]
        );
    }

    #[test]
    fn a_note_deleted_here_but_changed_upstream_comes_back() {
        let actions = plan(&[up("A.md", "2")], &[], &[rec("A.md", "1", "x")], true);
        assert_eq!(
            actions,
            vec![Action::Download {
                path: "A.md".into()
            }]
        );
    }

    #[test]
    fn a_view_only_note_deleted_here_comes_back() {
        let mut note = up("A.md", "1");
        note.editable = false;
        let actions = plan(&[note], &[], &[rec("A.md", "1", "x")], true);
        assert_eq!(
            actions,
            vec![Action::Download {
                path: "A.md".into()
            }]
        );
    }

    #[test]
    fn a_view_only_note_changed_here_is_held_not_sent() {
        let mut note = up("A.md", "1");
        note.editable = false;
        let actions = plan(
            &[note],
            &[local("A.md", "y")],
            &[rec("A.md", "1", "x")],
            true,
        );
        assert_eq!(
            actions,
            vec![Action::Hold {
                path: "A.md".into(),
                why: Held::ViewOnly
            }]
        );
    }

    #[test]
    fn a_note_gone_from_both_sides_is_forgotten() {
        assert_eq!(
            plan(&[], &[], &[rec("A.md", "1", "x")], true),
            vec![Action::Forget {
                path: "A.md".into()
            }]
        );
    }

    #[test]
    fn a_rename_upstream_moves_the_local_note() {
        let set_up = |n: &mut UpstreamNote, id| n.id = id;
        let set_local = |n: &mut LocalNote, id| n.id = id;
        let set_rec = |n: &mut RecordEntry, id| n.id = id;
        let actions = plan(
            &[with_id(up("B.md", "2"), "n1", set_up)],
            &[with_id(local("A.md", "x"), "n1", set_local)],
            &[with_id(rec("A.md", "1", "x"), "n1", set_rec)],
            true,
        );
        assert_eq!(
            actions[0],
            Action::MoveLocal {
                from: "A.md".into(),
                to: "B.md".into()
            }
        );
    }

    #[test]
    fn a_rename_here_moves_the_upstream_note() {
        let set_up = |n: &mut UpstreamNote, id| n.id = id;
        let set_local = |n: &mut LocalNote, id| n.id = id;
        let set_rec = |n: &mut RecordEntry, id| n.id = id;
        let actions = plan(
            &[with_id(up("A.md", "1"), "n1", set_up)],
            &[with_id(local("B.md", "y"), "n1", set_local)],
            &[with_id(rec("A.md", "1", "x"), "n1", set_rec)],
            true,
        );
        assert_eq!(
            actions[0],
            Action::MoveUpstream {
                from: "A.md".into(),
                to: "B.md".into()
            }
        );
    }

    #[test]
    fn a_rename_on_both_sides_takes_upstreams_path() {
        let set_up = |n: &mut UpstreamNote, id| n.id = id;
        let set_local = |n: &mut LocalNote, id| n.id = id;
        let set_rec = |n: &mut RecordEntry, id| n.id = id;
        let actions = plan(
            &[with_id(up("B.md", "2"), "n1", set_up)],
            &[with_id(local("C.md", "y"), "n1", set_local)],
            &[with_id(rec("A.md", "1", "x"), "n1", set_rec)],
            true,
        );
        assert_eq!(
            actions[0],
            Action::MoveLocal {
                from: "C.md".into(),
                to: "B.md".into()
            }
        );
    }

    #[test]
    fn two_different_notes_created_at_one_path_keep_both() {
        let set_up = |n: &mut UpstreamNote, id| n.id = id;
        let set_local = |n: &mut LocalNote, id| n.id = id;
        let actions = plan(
            &[with_id(up("A.md", "1"), "theirs", set_up)],
            &[with_id(local("A.md", "x"), "mine", set_local)],
            &[],
            true,
        );
        assert!(actions.contains(&Action::MoveLocal {
            from: "A.md".into(),
            to: "A (this device).md".into()
        }));
        assert!(actions.contains(&Action::Upload {
            path: "A (this device).md".into()
        }));
        assert!(actions.contains(&Action::Download {
            path: "A.md".into()
        }));
    }

    #[test]
    fn the_move_out_of_the_way_comes_before_the_download_into_that_path() {
        let set_up = |n: &mut UpstreamNote, id| n.id = id;
        let set_local = |n: &mut LocalNote, id| n.id = id;
        let actions = plan(
            &[with_id(up("A.md", "1"), "theirs", set_up)],
            &[with_id(local("A.md", "x"), "mine", set_local)],
            &[],
            true,
        );
        let moved = actions
            .iter()
            .position(|a| matches!(a, Action::MoveLocal { .. }));
        let downloaded = actions
            .iter()
            .position(|a| matches!(a, Action::Download { .. }));
        assert!(moved < downloaded);
    }

    #[test]
    fn a_note_with_an_id_on_one_side_only_is_still_one_note() {
        let set_up = |n: &mut UpstreamNote, id| n.id = id;
        let actions = plan(
            &[with_id(up("A.md", "1"), "n1", set_up)],
            &[local("A.md", "x")],
            &[],
            true,
        );
        assert_eq!(
            actions,
            vec![Action::Exchange {
                path: "A.md".into(),
                local_changed: true,
                upstream_changed: true,
            }]
        );
    }

    #[test]
    fn without_a_record_a_note_on_both_sides_is_exchanged_not_deleted() {
        let actions = plan(&[up("A.md", "1")], &[local("A.md", "x")], &[], true);
        assert_eq!(
            actions,
            vec![Action::Exchange {
                path: "A.md".into(),
                local_changed: true,
                upstream_changed: true,
            }]
        );
    }

    #[test]
    fn a_truncated_upstream_list_deletes_and_uploads_nothing() {
        let actions = plan(
            &[],
            &[local("A.md", "x"), local("B.md", "y")],
            &[rec("A.md", "1", "x")],
            false,
        );
        assert!(actions.is_empty(), "{actions:?}");
    }

    #[test]
    fn a_note_held_as_gone_by_an_older_pass_is_recovered() {
        let mut entry = rec("A.md", "1", "x");
        entry.held = Some(Held::GoneUpstream);
        let actions = plan(&[], &[local("A.md", "x")], &[entry], true);
        assert_eq!(
            actions,
            vec![Action::Recover {
                path: "A.md".into()
            }]
        );
    }

    #[test]
    fn this_device_path_keeps_the_folder_and_extension() {
        assert_eq!(
            this_device_path("Notes/Plan.md"),
            "Notes/Plan (this device).md"
        );
    }

    fn arbitrary_side()
    -> impl Strategy<Value = (Vec<UpstreamNote>, Vec<LocalNote>, Vec<RecordEntry>)> {
        let names = prop::sample::select(vec!["A.md", "B.md", "C.md", "D.md"]);
        let ids = prop::option::of(prop::sample::select(vec!["n1", "n2", "n3"]));
        let versions = prop::sample::select(vec!["1", "2"]);
        let ups = prop::collection::vec(
            (names.clone(), ids.clone(), versions.clone(), any::<bool>()),
            0..4,
        )
        .prop_map(|v| {
            let mut seen = BTreeSet::new();
            v.into_iter()
                .filter(|(p, ..)| seen.insert(*p))
                .map(|(p, id, ver, editable)| UpstreamNote {
                    path: p.into(),
                    id: id.map(Into::into),
                    version: ver.into(),
                    editable,
                    title: None,
                })
                .collect::<Vec<_>>()
        });
        let locals = prop::collection::vec((names.clone(), ids.clone(), versions.clone()), 0..4)
            .prop_map(|v| {
                let mut seen = BTreeSet::new();
                v.into_iter()
                    .filter(|(p, ..)| seen.insert(*p))
                    .map(|(p, id, ver)| LocalNote {
                        path: p.into(),
                        id: id.map(Into::into),
                        version: ver.into(),
                    })
                    .collect::<Vec<_>>()
            });
        let records = prop::collection::vec((names, ids, versions.clone(), versions), 0..4)
            .prop_map(|v| {
                let mut seen = BTreeSet::new();
                v.into_iter()
                    .filter(|(p, ..)| seen.insert(*p))
                    .map(|(p, id, uv, lv)| RecordEntry {
                        path: p.into(),
                        id: id.map(Into::into),
                        upstream_version: uv.into(),
                        local_version: lv.into(),
                        held: None,
                    })
                    .collect::<Vec<_>>()
            });
        (ups, locals, records)
    }

    proptest! {
        #[test]
        fn without_a_record_nothing_is_ever_deleted((ups, locals, _) in arbitrary_side()) {
            let actions = plan(&ups, &locals, &[], true);
            prop_assert!(!actions.iter().any(|a| matches!(a, Action::Purge { .. } | Action::Recover { .. } | Action::DeleteUpstream { .. })), "{actions:?}");
        }

        #[test]
        fn a_deletion_never_removes_a_note_changed_since_the_last_pass((ups, locals, records) in arbitrary_side()) {
            for action in plan(&ups, &locals, &records, true) {
                match action {
                    Action::Purge { path } => {
                        let note = locals.iter().find(|n| n.path == path).expect("purged note exists");
                        prop_assert!(records.iter().any(|r| r.local_version == note.version && (r.path == path || (r.id.is_some() && r.id == note.id))));
                    }
                    Action::DeleteUpstream { path } => {
                        let note = ups.iter().find(|n| n.path == path).expect("deleted note exists");
                        prop_assert!(note.editable);
                        prop_assert!(records.iter().any(|r| r.upstream_version == note.version && (r.path == path || (r.id.is_some() && r.id == note.id))));
                    }
                    _ => {}
                }
            }
        }

        #[test]
        fn an_incomplete_upstream_list_never_deletes((ups, locals, records) in arbitrary_side()) {
            let actions = plan(&ups, &locals, &records, false);
            let destructive = actions.iter().any(|a| {
                matches!(
                    a,
                    Action::Purge { .. } | Action::Recover { .. } | Action::DeleteUpstream { .. } | Action::Upload { .. }
                )
            });
            prop_assert!(!destructive, "{:?}", actions);
        }

        #[test]
        fn every_upstream_note_is_accounted_for((ups, locals, records) in arbitrary_side()) {
            let actions = plan(&ups, &locals, &records, true);
            for note in &ups {
                let mentioned = actions.iter().any(|a| match a {
                    Action::Download { path } | Action::DeleteUpstream { path } | Action::Exchange { path, .. } | Action::Hold { path, .. } => path == &note.path,
                    Action::MoveLocal { to, .. } => to == &note.path,
                    Action::MoveUpstream { from, .. } => from == &note.path,
                    _ => false,
                });
                let settled = locals.iter().any(|l| l.path == note.path)
                    && records.iter().any(|r| {
                        r.upstream_version == note.version
                            && (r.path == note.path || (r.id.is_some() && r.id == note.id))
                    });
                prop_assert!(mentioned || settled || locals.iter().any(|l| l.id.is_some() && l.id == note.id), "{note:?} {actions:?}");
            }
        }
    }
}
