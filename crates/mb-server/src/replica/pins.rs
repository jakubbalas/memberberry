//! Which notes of a server vault this device keeps available offline (`SPEC.md` §7.6.10).
//!
//! A pin is a note, a folder (every note under it, including ones created there later) or
//! the whole vault. Kept in `<replica>/.memberberry/replica/pins.json`.
//!
//! **A missing pin file fails towards keeping** (I1): if it is gone, every note already on
//! disk is treated as pinned and the file is rewritten that way. The alternative — no pins,
//! so every downloaded note is released on the next pass — would turn a cleanup of
//! `.memberberry/` into the loss of everything this device kept offline.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// What one pin covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PinKind {
    /// One note.
    Note,
    /// A folder and everything under it.
    Folder,
    /// The whole vault.
    Vault,
}

/// The pins of one replica.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct Pins {
    /// The whole vault is available offline.
    #[serde(default)]
    pub vault: bool,
    /// Folders available offline, vault-relative, without a trailing `/`.
    #[serde(default)]
    pub folders: BTreeSet<String>,
    /// Notes available offline, vault-relative.
    #[serde(default)]
    pub notes: BTreeSet<String>,
}

impl Pins {
    /// Whether `path` is kept offline by any pin.
    #[must_use]
    pub fn covers(&self, path: &str) -> bool {
        self.vault || self.notes.contains(path) || self.folder_holding(path).is_some()
    }

    /// The pin that keeps `path` offline, broadest first: what releasing it would need.
    #[must_use]
    pub fn held_by(&self, path: &str) -> Option<(PinKind, String)> {
        if self.vault {
            return Some((PinKind::Vault, String::new()));
        }
        if let Some(folder) = self.folder_holding(path) {
            return Some((PinKind::Folder, folder.to_string()));
        }
        self.notes
            .contains(path)
            .then(|| (PinKind::Note, path.to_string()))
    }

    fn folder_holding(&self, path: &str) -> Option<&str> {
        self.folders.iter().map(String::as_str).find(|folder| {
            path.strip_prefix(folder)
                .is_some_and(|rest| rest.starts_with('/'))
        })
    }

    /// Adds or removes one pin.
    pub fn set(&mut self, kind: PinKind, path: &str, offline: bool) {
        let path = path.trim_matches('/').to_string();
        match (kind, offline) {
            (PinKind::Vault, on) => self.vault = on,
            (PinKind::Folder, true) => {
                self.folders.insert(path);
            }
            (PinKind::Folder, false) => {
                self.folders.remove(&path);
            }
            (PinKind::Note, true) => {
                self.notes.insert(path);
            }
            (PinKind::Note, false) => {
                self.notes.remove(&path);
            }
        }
    }
}

fn pins_path(root: &Path) -> PathBuf {
    root.join(".memberberry").join("replica").join("pins.json")
}

/// The replica's pins, or — when the file is missing — every note in `on_disk`, saved.
///
/// # Errors
///
/// Fails if the file exists but cannot be read or parsed, or cannot be rewritten.
pub fn load<'a>(root: &Path, on_disk: impl IntoIterator<Item = &'a str>) -> Result<Pins, String> {
    let path = pins_path(root);
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| e.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let pins = Pins {
                notes: on_disk.into_iter().map(str::to_string).collect(),
                ..Pins::default()
            };
            save(root, &pins)?;
            Ok(pins)
        }
        Err(error) => Err(error.to_string()),
    }
}

/// Writes the replica's pins.
///
/// # Errors
///
/// Fails if the file cannot be written.
pub fn save(root: &Path, pins: &Pins) -> Result<(), String> {
    let path = pins_path(root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(pins).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, text).map_err(|e| e.to_string())?;
    std::fs::rename(&temporary, &path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used)]

    use super::*;

    #[test]
    fn a_folder_pin_covers_notes_under_it_and_not_beside_it() {
        let mut pins = Pins::default();
        pins.set(PinKind::Folder, "Projects", true);
        assert!(pins.covers("Projects/Plan.md") && !pins.covers("Projects.md"));
    }

    #[test]
    fn a_folder_pin_covers_notes_created_there_later() {
        let mut pins = Pins::default();
        pins.set(PinKind::Folder, "Projects/", true);
        assert!(pins.covers("Projects/Deep/New.md"));
    }

    #[test]
    fn the_vault_pin_covers_everything() {
        let mut pins = Pins::default();
        pins.set(PinKind::Vault, "", true);
        assert!(pins.covers("Anything.md"));
    }

    #[test]
    fn a_note_held_by_a_folder_names_that_folder() {
        let mut pins = Pins::default();
        pins.set(PinKind::Note, "Projects/Plan.md", true);
        pins.set(PinKind::Folder, "Projects", true);
        assert_eq!(
            pins.held_by("Projects/Plan.md"),
            Some((PinKind::Folder, "Projects".to_string()))
        );
    }

    #[test]
    fn a_missing_pin_file_keeps_every_note_already_on_disk() {
        let dir = tempfile::tempdir().expect("dir");
        let pins = load(dir.path(), ["A.md", "B/C.md"]).expect("load");
        assert!(pins.covers("A.md") && pins.covers("B/C.md") && !pins.covers("D.md"));
    }

    #[test]
    fn pins_survive_a_save_and_load() {
        let dir = tempfile::tempdir().expect("dir");
        let mut pins = Pins::default();
        pins.set(PinKind::Folder, "Projects", true);
        save(dir.path(), &pins).expect("save");
        assert_eq!(load(dir.path(), ["Other.md"]).expect("load"), pins);
    }
}
