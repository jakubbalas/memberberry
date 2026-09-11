//! Durable Markdown version snapshots (`SPEC.md` §18).
//!
//! History deliberately stores compressed Markdown rather than CRDT state. The files remain
//! recoverable with a standard decompressor if the application disappears, and CRDT compaction
//! therefore cannot change what a historical version means.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use thiserror::Error;

const MINIMUM_INTERVAL: Duration = Duration::from_secs(5 * 60);
const ALL_FOR: Duration = Duration::from_secs(24 * 60 * 60);
const HOURLY_FOR: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const DAILY_FOR: Duration = Duration::from_secs(90 * 24 * 60 * 60);
const MAX_LCS_CELLS: usize = 250_000;

#[derive(Debug, Error)]
pub enum HistoryError {
    #[error("history I/O at {path}: {source}")]
    Io { path: PathBuf, source: io::Error },
    #[error("history timestamp is before the Unix epoch")]
    Clock,
    #[error("history compression failed: {0}")]
    Compression(String),
    #[error("history metadata is malformed at {path}: {source}")]
    Metadata {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("history version not found")]
    NotFound,
    #[error("history snapshot is not valid UTF-8")]
    Encoding,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SnapshotInfo {
    pub timestamp: u64,
    pub actor: String,
    pub bytes: u64,
    pub content_hash: String,
    #[serde(default = "enabled")]
    compressed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum DiffPart {
    Equal { text: String },
    Added { text: String },
    Removed { text: String },
}

#[derive(Debug, Clone)]
pub struct HistoryStore {
    directory: PathBuf,
    compressed: bool,
}

impl HistoryStore {
    /// Opens the derived history directory for one note identity.
    pub fn new(vault_root: &Path, note_identity: &str) -> Self {
        let mut digest = Sha256::new();
        digest.update(note_identity.as_bytes());
        let key = digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        Self {
            directory: vault_root.join(".memberberry/history").join(key),
            compressed: true,
        }
    }

    /// Selects whether newly recorded snapshots use zstd compression.
    #[must_use]
    pub fn with_compression(mut self, compressed: bool) -> Self {
        self.compressed = compressed;
        self
    }

    /// Records a changed Markdown version unless the minimum interval has not elapsed.
    ///
    /// Returns `Ok(None)` when the write is intentionally coalesced. The caller supplies the
    /// timestamp so policy tests do not depend on wall-clock sleeps.
    pub fn record(
        &self,
        markdown: &str,
        actor: &str,
        now: SystemTime,
    ) -> Result<Option<SnapshotInfo>, HistoryError> {
        let timestamp = unix_seconds(now)?;
        self.thin(timestamp)?;
        let existing = self.list_raw()?;
        let hash = Sha256::digest(markdown.as_bytes());
        let content_hash = hash
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        if existing
            .last()
            .is_some_and(|snapshot| snapshot.content_hash == content_hash)
        {
            return Ok(None);
        }
        if existing.last().is_some_and(|snapshot| {
            timestamp.saturating_sub(snapshot.timestamp) < MINIMUM_INTERVAL.as_secs()
        }) {
            return Ok(None);
        }
        fs::create_dir_all(&self.directory).map_err(|source| HistoryError::Io {
            path: self.directory.clone(),
            source,
        })?;
        let stem = format!("{timestamp}-{content_hash}");
        let snapshot_path = self.directory.join(if self.compressed {
            format!("{stem}.md.zst")
        } else {
            format!("{stem}.md")
        });
        let metadata_path = self.directory.join(format!("{stem}.json"));
        let body = if self.compressed {
            zstd::stream::encode_all(markdown.as_bytes(), 3)
                .map_err(|error| HistoryError::Compression(error.to_string()))?
        } else {
            markdown.as_bytes().to_vec()
        };
        atomic_write(&snapshot_path, &body)?;
        let info = SnapshotInfo {
            timestamp,
            actor: actor.to_string(),
            bytes: markdown.len() as u64,
            content_hash,
            compressed: self.compressed,
        };
        let metadata = serde_json::to_vec(&info).map_err(|source| HistoryError::Metadata {
            path: metadata_path.clone(),
            source,
        })?;
        atomic_write(&metadata_path, &metadata)?;
        self.thin(timestamp)?;
        Ok(Some(info))
    }

    /// Lists snapshots in chronological order without exposing their Markdown bodies.
    pub fn list(&self) -> Result<Vec<SnapshotInfo>, HistoryError> {
        self.thin(unix_seconds(SystemTime::now())?)?;
        self.list_raw()
    }

    /// Applies the retention policy at a caller-supplied time.
    pub fn prune(&self, now: SystemTime) -> Result<(), HistoryError> {
        self.thin(unix_seconds(now)?)
    }

    /// Counts snapshots the retention policy would remove without changing history.
    pub fn retention_excess(&self, now: SystemTime) -> Result<usize, HistoryError> {
        let timestamp = unix_seconds(now)?;
        Ok(retention_decisions(&self.list_raw()?, timestamp)
            .filter(|keep| !keep)
            .count())
    }

    fn list_raw(&self) -> Result<Vec<SnapshotInfo>, HistoryError> {
        if !self.directory.is_dir() {
            return Ok(Vec::new());
        }
        let mut snapshots = Vec::new();
        let entries = fs::read_dir(&self.directory).map_err(|source| HistoryError::Io {
            path: self.directory.clone(),
            source,
        })?;
        for entry in entries {
            let entry = entry.map_err(|source| HistoryError::Io {
                path: self.directory.clone(),
                source,
            })?;
            if entry
                .path()
                .extension()
                .and_then(|extension| extension.to_str())
                != Some("json")
            {
                continue;
            }
            let path = entry.path();
            let bytes = fs::read(&path).map_err(|source| HistoryError::Io {
                path: path.clone(),
                source,
            })?;
            let info: SnapshotInfo =
                serde_json::from_slice(&bytes).map_err(|source| HistoryError::Metadata {
                    path: path.clone(),
                    source,
                })?;
            snapshots.push(info);
        }
        snapshots.sort_by_key(|snapshot| snapshot.timestamp);
        Ok(snapshots)
    }

    /// Returns the stable, opaque identifier used by the history HTTP surface.
    #[must_use]
    pub fn version_id(snapshot: &SnapshotInfo) -> String {
        format!("{}-{}", snapshot.timestamp, snapshot.content_hash)
    }

    /// Decompresses one previously listed snapshot by its stable identifier.
    pub fn read(&self, version: &str) -> Result<String, HistoryError> {
        let snapshot = self
            .list()?
            .into_iter()
            .find(|snapshot| Self::version_id(snapshot) == version)
            .ok_or(HistoryError::NotFound)?;
        let extension = if snapshot.compressed { "md.zst" } else { "md" };
        let path = self
            .directory
            .join(format!("{}.{}", Self::version_id(&snapshot), extension));
        let body = fs::read(&path).map_err(|source| {
            if source.kind() == io::ErrorKind::NotFound {
                HistoryError::NotFound
            } else {
                HistoryError::Io {
                    path: path.clone(),
                    source,
                }
            }
        })?;
        let markdown = if snapshot.compressed {
            zstd::stream::decode_all(body.as_slice())
                .map_err(|error| HistoryError::Compression(error.to_string()))?
        } else {
            body
        };
        String::from_utf8(markdown).map_err(|_| HistoryError::Encoding)
    }

    /// Computes a word-level diff between two snapshots in this note's history.
    pub fn diff(&self, from: &str, to: &str) -> Result<Vec<DiffPart>, HistoryError> {
        let before = self.read(from)?;
        let after = self.read(to)?;
        Ok(word_diff(&before, &after))
    }

    /// Removes every retained snapshot for this note identity.
    pub fn remove_all(&self) -> Result<(), HistoryError> {
        match fs::remove_dir_all(&self.directory) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(source) => Err(HistoryError::Io {
                path: self.directory.clone(),
                source,
            }),
        }
    }

    fn thin(&self, now: u64) -> Result<(), HistoryError> {
        let snapshots = self.list_raw()?;
        for (snapshot, keep) in snapshots
            .iter()
            .rev()
            .zip(retention_decisions(&snapshots, now))
        {
            if !keep {
                let stem = format!("{}-{}", snapshot.timestamp, snapshot.content_hash);
                for extension in ["md.zst", "md", "json"] {
                    let path = self.directory.join(format!("{stem}.{extension}"));
                    match fs::remove_file(&path) {
                        Ok(()) => {}
                        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                        Err(source) => return Err(HistoryError::Io { path, source }),
                    }
                }
            }
        }
        Ok(())
    }
}

fn retention_decisions(
    snapshots: &[SnapshotInfo],
    now: u64,
) -> impl Iterator<Item = bool> + use<'_> {
    let mut hourly = std::collections::BTreeSet::new();
    let mut daily = std::collections::BTreeSet::new();
    snapshots.iter().rev().map(move |snapshot| {
        let age = now.saturating_sub(snapshot.timestamp);
        if age <= ALL_FOR.as_secs() {
            true
        } else if age <= HOURLY_FOR.as_secs() {
            hourly.insert(snapshot.timestamp / 3_600)
        } else if age <= DAILY_FOR.as_secs() {
            daily.insert(snapshot.timestamp / 86_400)
        } else {
            false
        }
    })
}

fn unix_seconds(now: SystemTime) -> Result<u64, HistoryError> {
    now.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| HistoryError::Clock)
}

const fn enabled() -> bool {
    true
}

fn word_diff(before: &str, after: &str) -> Vec<DiffPart> {
    let left = before
        .split_inclusive(|character: char| character.is_whitespace())
        .collect::<Vec<_>>();
    let right = after
        .split_inclusive(|character: char| character.is_whitespace())
        .collect::<Vec<_>>();
    if (left.len() + 1)
        .checked_mul(right.len() + 1)
        .is_none_or(|cells| cells > MAX_LCS_CELLS)
    {
        return bounded_word_diff(&left, &right);
    }
    let mut table = vec![vec![0usize; right.len() + 1]; left.len() + 1];
    for (left_index, left_word) in left.iter().enumerate() {
        for (right_index, right_word) in right.iter().enumerate() {
            let row = left_index + 1;
            let column = right_index + 1;
            let value = if left_word == right_word {
                table_value(&table, left_index, right_index) + 1
            } else {
                table_value(&table, left_index + 1, right_index).max(table_value(
                    &table,
                    left_index,
                    right_index + 1,
                ))
            };
            if let Some(cell) = table.get_mut(row).and_then(|row| row.get_mut(column)) {
                *cell = value;
            }
        }
    }

    let mut parts = Vec::new();
    let mut left_index = left.len();
    let mut right_index = right.len();
    while left_index > 0 || right_index > 0 {
        if left_index > 0
            && right_index > 0
            && left.get(left_index - 1) == right.get(right_index - 1)
        {
            push_diff(
                &mut parts,
                DiffPart::Equal {
                    text: left.get(left_index - 1).unwrap_or(&"").to_string(),
                },
            );
            left_index -= 1;
            right_index -= 1;
        } else if right_index > 0
            && (left_index == 0
                || table_value(&table, left_index, right_index - 1)
                    >= table_value(&table, left_index - 1, right_index))
        {
            push_diff(
                &mut parts,
                DiffPart::Added {
                    text: right.get(right_index - 1).unwrap_or(&"").to_string(),
                },
            );
            right_index -= 1;
        } else {
            push_diff(
                &mut parts,
                DiffPart::Removed {
                    text: left.get(left_index - 1).unwrap_or(&"").to_string(),
                },
            );
            left_index -= 1;
        }
    }
    parts.reverse();
    for part in &mut parts {
        reverse_part_words(part);
    }
    parts
}

fn bounded_word_diff(left: &[&str], right: &[&str]) -> Vec<DiffPart> {
    let prefix = left
        .iter()
        .zip(right)
        .take_while(|(left, right)| left == right)
        .count();
    let suffix = left
        .get(prefix..)
        .unwrap_or_default()
        .iter()
        .rev()
        .zip(right.get(prefix..).unwrap_or_default().iter().rev())
        .take_while(|(left, right)| left == right)
        .count();
    let mut parts = Vec::new();
    push_diff(
        &mut parts,
        DiffPart::Equal {
            text: left.get(..prefix).unwrap_or_default().concat(),
        },
    );
    push_diff(
        &mut parts,
        DiffPart::Removed {
            text: left
                .get(prefix..left.len().saturating_sub(suffix))
                .unwrap_or_default()
                .concat(),
        },
    );
    push_diff(
        &mut parts,
        DiffPart::Added {
            text: right
                .get(prefix..right.len().saturating_sub(suffix))
                .unwrap_or_default()
                .concat(),
        },
    );
    push_diff(
        &mut parts,
        DiffPart::Equal {
            text: left
                .get(left.len().saturating_sub(suffix)..)
                .unwrap_or_default()
                .concat(),
        },
    );
    parts.retain(|part| match part {
        DiffPart::Equal { text } | DiffPart::Added { text } | DiffPart::Removed { text } => {
            !text.is_empty()
        }
    });
    parts
}

fn reverse_part_words(part: &mut DiffPart) {
    let text = match part {
        DiffPart::Equal { text } | DiffPart::Added { text } | DiffPart::Removed { text } => text,
    };
    let reversed = text
        .split_inclusive(|character: char| character.is_whitespace())
        .rev()
        .collect::<String>();
    *text = reversed;
}

fn table_value(table: &[Vec<usize>], row: usize, column: usize) -> usize {
    table
        .get(row)
        .and_then(|cells| cells.get(column))
        .copied()
        .unwrap_or_default()
}

fn push_diff(parts: &mut Vec<DiffPart>, part: DiffPart) {
    let (kind, text) = match part {
        DiffPart::Equal { text } => (0, text),
        DiffPart::Added { text } => (1, text),
        DiffPart::Removed { text } => (2, text),
    };
    if let Some(last) = parts.last_mut() {
        match (kind, last) {
            (0, DiffPart::Equal { text: existing })
            | (1, DiffPart::Added { text: existing })
            | (2, DiffPart::Removed { text: existing }) => {
                existing.push_str(&text);
                return;
            }
            _ => {}
        }
    }
    parts.push(match kind {
        0 => DiffPart::Equal { text },
        1 => DiffPart::Added { text },
        _ => DiffPart::Removed { text },
    });
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), HistoryError> {
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&temporary, bytes).map_err(|source| HistoryError::Io {
        path: temporary.clone(),
        source,
    })?;
    fs::rename(&temporary, path).map_err(|source| HistoryError::Io {
        path: path.to_path_buf(),
        source,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn snapshots_are_compressed_and_coalesced() -> Result<(), Box<dyn std::error::Error>> {
        let root = tempdir()?;
        let store = HistoryStore::new(root.path(), "Notes/One.md");
        let start = SystemTime::now();
        assert!(store.record("one", "alice", start)?.is_some());
        assert!(
            store
                .record("two", "alice", start + Duration::from_secs(60))?
                .is_none()
        );
        assert!(
            store
                .record("one", "alice", start + Duration::from_secs(600))?
                .is_none()
        );
        let snapshots = store.list()?;
        assert_eq!(snapshots.len(), 1);
        assert_eq!(
            snapshots.first().map(|snapshot| snapshot.actor.as_str()),
            Some("alice")
        );
        let files = fs::read_dir(&store.directory)?.count();
        assert_eq!(files, 2);
        Ok(())
    }

    #[test]
    fn snapshots_can_be_read_by_zstd_tools() -> Result<(), Box<dyn std::error::Error>> {
        let root = tempdir()?;
        let store = HistoryStore::new(root.path(), "One.md");
        let start = SystemTime::now();
        store.record("readable Markdown\n", "external", start)?;
        let snapshot = fs::read_dir(&store.directory)?
            .filter_map(Result::ok)
            .find(|entry| {
                entry
                    .path()
                    .extension()
                    .and_then(|extension| extension.to_str())
                    == Some("zst")
            })
            .ok_or("compressed snapshot missing")?;
        let bytes = fs::read(snapshot.path())?;
        let decoded = zstd::stream::decode_all(bytes.as_slice())?;
        assert_eq!(decoded, b"readable Markdown\n");
        Ok(())
    }

    #[test]
    fn version_ids_are_required_to_read_a_snapshot() -> Result<(), Box<dyn std::error::Error>> {
        let root = tempdir()?;
        let store = HistoryStore::new(root.path(), "One.md");
        let start = SystemTime::now();
        let snapshot = store
            .record("read me\n", "alice", start)?
            .ok_or("snapshot missing")?;
        let version = HistoryStore::version_id(&snapshot);
        assert_eq!(store.read(&version)?, "read me\n");
        assert!(matches!(
            store.read("../secret"),
            Err(HistoryError::NotFound)
        ));
        Ok(())
    }

    #[test]
    fn uncompressed_snapshots_remain_plain_markdown() -> Result<(), Box<dyn std::error::Error>> {
        let root = tempdir()?;
        let store = HistoryStore::new(root.path(), "One.md").with_compression(false);
        let snapshot = store
            .record("plain Markdown\n", "alice", SystemTime::now())?
            .ok_or("snapshot missing")?;
        let version = HistoryStore::version_id(&snapshot);
        assert_eq!(store.read(&version)?, "plain Markdown\n");
        assert_eq!(
            fs::read_to_string(store.directory.join(format!("{version}.md")))?,
            "plain Markdown\n"
        );
        Ok(())
    }

    #[test]
    fn word_diff_preserves_text_and_marks_changes() {
        let parts = word_diff("one old\n", "one new\n");
        assert_eq!(
            parts,
            vec![
                DiffPart::Equal {
                    text: "one ".to_string()
                },
                DiffPart::Removed {
                    text: "old\n".to_string()
                },
                DiffPart::Added {
                    text: "new\n".to_string()
                },
            ]
        );
    }

    #[test]
    fn word_diff_preserves_multi_word_order_and_large_inputs() {
        let before = format!("start {} finish", "old ".repeat(2_100));
        let after = format!("start {} finish", "new ".repeat(2_100));
        let parts = word_diff(&before, &after);
        let reconstructed_before = parts
            .iter()
            .filter_map(|part| match part {
                DiffPart::Equal { text } | DiffPart::Removed { text } => Some(text.as_str()),
                DiffPart::Added { .. } => None,
            })
            .collect::<String>();
        let reconstructed_after = parts
            .iter()
            .filter_map(|part| match part {
                DiffPart::Equal { text } | DiffPart::Added { text } => Some(text.as_str()),
                DiffPart::Removed { .. } => None,
            })
            .collect::<String>();
        assert_eq!(reconstructed_before, before);
        assert_eq!(reconstructed_after, after);
    }

    #[test]
    fn thinning_removes_expired_versions_and_keeps_one_per_old_bucket()
    -> Result<(), Box<dyn std::error::Error>> {
        let root = tempdir()?;
        let store = HistoryStore::new(root.path(), "One.md");
        let now = UNIX_EPOCH + Duration::from_secs(100 * 24 * 60 * 60);
        for (age, body) in [
            (91 * 24 * 60 * 60, "expired"),
            (8 * 24 * 60 * 60, "daily old"),
            (8 * 24 * 60 * 60 - 600, "daily newer"),
            (2 * 24 * 60 * 60, "hourly old"),
            (2 * 24 * 60 * 60 - 600, "hourly newer"),
            (60, "recent"),
        ] {
            store.record(body, "alice", now - Duration::from_secs(age))?;
        }

        store.prune(now)?;
        assert_eq!(store.retention_excess(now)?, 0);
        let snapshots = store.list_raw()?;
        assert_eq!(snapshots.len(), 3);
        assert!(
            snapshots
                .iter()
                .all(|snapshot| snapshot.timestamp >= 10 * 24 * 60 * 60)
        );
        Ok(())
    }

    #[test]
    fn retention_excess_reports_without_removing_snapshots()
    -> Result<(), Box<dyn std::error::Error>> {
        let root = tempdir()?;
        let store = HistoryStore::new(root.path(), "One.md");
        fs::create_dir_all(&store.directory)?;
        let now = 100 * 24 * 60 * 60;
        for (timestamp, hash) in [
            (now - 91 * 24 * 60 * 60, "expired"),
            (now - 8 * 24 * 60 * 60, "daily-old"),
            (now - 8 * 24 * 60 * 60 + 600, "daily-new"),
        ] {
            let info = SnapshotInfo {
                timestamp,
                actor: "alice".to_string(),
                bytes: 1,
                content_hash: hash.to_string(),
                compressed: true,
            };
            fs::write(
                store.directory.join(format!("{timestamp}-{hash}.json")),
                serde_json::to_vec(&info)?,
            )?;
        }

        assert_eq!(
            store.retention_excess(UNIX_EPOCH + Duration::from_secs(now))?,
            2
        );
        assert_eq!(store.list_raw()?.len(), 3, "inspection must not prune");
        Ok(())
    }
}
