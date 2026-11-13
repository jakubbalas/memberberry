//! Recovered notes: a server vault's notes that left the readable set with changes made on
//! this device (`SPEC.md` §7.6.7, A43, E35).
//!
//! A recovered note is an ordinary Markdown file under `notes/Recovered/` (C2). What lives
//! here is only the bookkeeping: which files are recovered notes awaiting the user's choice,
//! the path each came from, and whether creating it again there was refused. Kept in
//! `<replica>/.memberberry/replica/recovered.json`.
//!
//! **A missing file fails towards keeping** (I1): the notes are still on disk, and a pass
//! that no longer knows they are recovered would upload them as new notes — which the user
//! never chose. So a pass also treats every note under `Recovered/` named
//! `… (offline edits).md` as recovered, whether or not this file lists it.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// The folder recovered notes are written to.
pub const FOLDER: &str = "Recovered";

/// The suffix that names a recovered note.
const SUFFIX: &str = " (offline edits)";

/// One recovered note awaiting a choice.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Recovered {
    /// Where it is now, vault-relative.
    pub path: String,
    /// The path it had when this device last could read it.
    pub original: String,
    /// "Create the note again" at `original` was refused; only "Make a new note" remains.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub create_again_refused: bool,
}

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct File {
    notes: Vec<Recovered>,
}

fn file_path(root: &Path) -> PathBuf {
    root.join(".memberberry")
        .join("replica")
        .join("recovered.json")
}

/// The recovered notes of the replica at `root`, oldest first.
#[must_use]
pub fn load(root: &Path) -> Vec<Recovered> {
    std::fs::read(file_path(root))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<File>(&bytes).ok())
        .map(|file| file.notes)
        .unwrap_or_default()
}

/// Replaces the recovered notes of the replica at `root`.
///
/// # Errors
///
/// A message when the file cannot be written.
pub fn save(root: &Path, notes: Vec<Recovered>) -> Result<(), String> {
    let path = file_path(root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(&File { notes }).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&temporary, &path).map_err(|e| e.to_string())
}

/// Whether `path` is named as a recovered note is (`Recovered/… (offline edits).md`).
#[must_use]
pub fn is_recovered_name(path: &str) -> bool {
    path.strip_prefix(FOLDER)
        .and_then(|rest| rest.strip_prefix('/'))
        .and_then(|name| name.strip_suffix(".md"))
        .is_some_and(|stem| {
            !stem.contains('/') && (stem.ends_with(SUFFIX) || numbered(stem).is_some())
        })
}

/// `Plan (offline edits 2)` → `Some(2)`.
fn numbered(stem: &str) -> Option<u32> {
    let inner = stem.strip_suffix(')')?;
    let (_, number) = inner.rsplit_once(" (offline edits ")?;
    number.parse().ok()
}

/// Where the recovered copy of `original` goes: `Recovered/<name> (offline edits).md`, or
/// with a number when that is taken by a note in `taken`.
#[must_use]
pub fn path_for(original: &str, taken: &BTreeSet<&str>) -> String {
    let name = original.rsplit('/').next().unwrap_or(original);
    let stem = name.strip_suffix(".md").unwrap_or(name);
    let first = format!("{FOLDER}/{stem}{SUFFIX}.md");
    if !taken.contains(first.as_str()) {
        return first;
    }
    (2_u32..)
        .map(|n| format!("{FOLDER}/{stem} (offline edits {n}).md"))
        .find(|candidate| !taken.contains(candidate.as_str()))
        .unwrap_or(first)
}

/// The note's Markdown without its frontmatter `id`, so the copy is a new note rather than
/// a second claim to the original's identity (§4.3).
#[must_use]
pub fn without_id(markdown: &str) -> String {
    let Some(rest) = markdown.strip_prefix("---\n") else {
        return markdown.to_string();
    };
    let Some(end) = rest.find("\n---\n").map(|i| i + 1).or_else(|| {
        rest.strip_suffix("\n---")
            .map(|front| front.len() + 1)
            .or_else(|| rest.starts_with("---\n").then_some(0))
    }) else {
        return markdown.to_string();
    };
    let (front, body) = rest.split_at(end);
    let kept: Vec<&str> = front
        .lines()
        .filter(|line| !line.trim_start().starts_with("id:"))
        .collect();
    if kept.is_empty() {
        // Nothing but the id: no frontmatter at all, rather than an empty block.
        return body
            .strip_prefix("---\n")
            .or_else(|| body.strip_prefix("---"))
            .unwrap_or(body)
            .to_string();
    }
    format!("---\n{}\n{body}", kept.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::{BTreeSet, is_recovered_name, path_for, without_id};

    #[test]
    fn a_recovered_note_keeps_the_name_and_says_what_it_is() {
        assert_eq!(
            path_for("Projects/Plan.md", &BTreeSet::new()),
            "Recovered/Plan (offline edits).md"
        );
    }

    #[test]
    fn a_taken_name_is_numbered() {
        let taken = BTreeSet::from(["Recovered/Plan (offline edits).md"]);
        assert_eq!(
            path_for("Other/Plan.md", &taken),
            "Recovered/Plan (offline edits 2).md"
        );
    }

    #[test]
    fn recovered_names_are_recognised_and_ordinary_notes_are_not() {
        for path in [
            "Recovered/Plan (offline edits).md",
            "Recovered/Plan (offline edits 3).md",
        ] {
            assert!(is_recovered_name(path), "{path}");
        }
        for path in [
            "Recovered/Plan.md",
            "Plan (offline edits).md",
            "Recovered/Deep/Plan (offline edits).md",
            "Recovered/Plan (offline edits x).md",
        ] {
            assert!(!is_recovered_name(path), "{path}");
        }
    }

    #[test]
    fn the_id_is_dropped_and_the_rest_of_the_frontmatter_kept() {
        let markdown = "---\nid: 0190-abc\ntags: [a]\n---\n# Plan\n\nmine\n";
        assert_eq!(
            without_id(markdown),
            "---\ntags: [a]\n---\n# Plan\n\nmine\n"
        );
    }

    #[test]
    fn frontmatter_holding_only_the_id_goes_entirely() {
        assert_eq!(without_id("---\nid: 0190-abc\n---\n# Plan\n"), "# Plan\n");
    }

    #[test]
    fn a_note_without_frontmatter_is_unchanged() {
        for markdown in ["# Plan\n\nid: not frontmatter\n", "", "---\nunterminated"] {
            assert_eq!(without_id(markdown), markdown);
        }
    }
}
