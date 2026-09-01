use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use thiserror::Error;
use yrs::updates::decoder::Decode;
use yrs::{Doc, Transact, Update};

use crate::{CrdtError, FRONTMATTER_ROOT, PROSEMIRROR_ROOT, document_from_yrs, encode_update_v1};

const MAGIC: &[u8; 8] = b"MBCRDT\0\x01";
const RECORD_HEADER_BYTES: usize = 8;
const MAX_UPDATE_BYTES: usize = 64 * 1024 * 1024;

/// Number of appended updates after which the server should compact a sidecar.
pub const DEFAULT_COMPACTION_THRESHOLD: usize = 500;

/// A loaded CRDT sidecar and the number of update records it contained.
#[derive(Debug)]
pub struct SidecarState {
    pub doc: Doc,
    pub update_count: usize,
}

/// Failure to read or durably update a CRDT sidecar.
#[derive(Debug, Error)]
pub enum SidecarError {
    #[error("sidecar I/O failed at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("sidecar at {path} has an unsupported or corrupt header")]
    InvalidHeader { path: PathBuf },
    #[error("sidecar at {path} ends partway through update record {record}")]
    Truncated { path: PathBuf, record: usize },
    #[error("sidecar update record {record} at {path} is {bytes} bytes; maximum is {maximum}")]
    UpdateTooLarge {
        path: PathBuf,
        record: usize,
        bytes: usize,
        maximum: usize,
    },
    #[error("sidecar update record {record} at {path} failed its checksum")]
    ChecksumMismatch { path: PathBuf, record: usize },
    #[error("sidecar update record {record} at {path} is not a valid Yjs v1 update: {reason}")]
    InvalidUpdate {
        path: PathBuf,
        record: usize,
        reason: String,
    },
    #[error("sidecar at {path} contains no updates")]
    Empty { path: PathBuf },
    #[error("sidecar at {path} materializes invalid note content: {source}")]
    InvalidDocument {
        path: PathBuf,
        #[source]
        source: CrdtError,
    },
    #[error("sidecar lock is poisoned at {path}")]
    LockPoisoned { path: PathBuf },
}

/// Durable append-only merge state for one note.
///
/// A `Sidecar` serializes operations made through that instance. The server must keep one
/// instance per note; cross-process writers are deliberately unsupported because a note's sync
/// coordinator is its single server-side writer.
#[derive(Debug)]
pub struct Sidecar {
    path: PathBuf,
    gate: Mutex<()>,
}

impl Sidecar {
    #[must_use]
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            gate: Mutex::new(()),
        }
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Loads and validates every update in the sidecar.
    ///
    /// A missing file returns `Ok(None)`: callers rebuild merge state from the Markdown note,
    /// preserving invariant I1. Corrupt state is an error rather than a partial recovery.
    ///
    /// # Errors
    ///
    /// Returns [`SidecarError`] for I/O, framing, checksum, Yjs, or schema failures.
    pub fn load(&self) -> Result<Option<SidecarState>, SidecarError> {
        let _guard = self.lock()?;
        self.load_locked()
    }

    /// Durably appends one syntactically valid lib0 v1 update.
    ///
    /// The update may depend on earlier records; full document validation happens during load
    /// and before sync frames reach this boundary.
    ///
    /// # Errors
    ///
    /// Returns [`SidecarError`] if the update or destination is invalid or cannot be synced.
    pub fn append(&self, update: &[u8]) -> Result<(), SidecarError> {
        let _guard = self.lock()?;
        validate_update(update, &self.path, 0)?;
        ensure_parent(&self.path)?;

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .read(true)
            .open(&self.path)
            .map_err(|source| io_error(&self.path, source))?;
        let len = file
            .metadata()
            .map_err(|source| io_error(&self.path, source))?
            .len();
        if len == 0 {
            file.write_all(MAGIC)
                .map_err(|source| io_error(&self.path, source))?;
        } else {
            validate_existing_header(&mut file, &self.path)?;
        }
        write_record(&mut file, update, &self.path)?;
        file.sync_data()
            .map_err(|source| io_error(&self.path, source))
    }

    /// Atomically replaces the sidecar with one complete state update.
    ///
    /// # Errors
    ///
    /// Returns [`SidecarError`] if the document is malformed or the atomic rewrite fails.
    pub fn replace(&self, doc: &Doc) -> Result<(), SidecarError> {
        let _guard = self.lock()?;
        document_from_yrs(doc).map_err(|source| SidecarError::InvalidDocument {
            path: self.path.clone(),
            source,
        })?;
        self.replace_locked(&encode_update_v1(doc))
    }

    /// Compacts logs whose update count is greater than `threshold` into one state update.
    ///
    /// Returns `true` only when a rewrite happened. A missing sidecar returns `false`.
    ///
    /// # Errors
    ///
    /// Returns [`SidecarError`] if loading or atomically rewriting the sidecar fails.
    pub fn compact_if_needed(&self, threshold: usize) -> Result<bool, SidecarError> {
        let _guard = self.lock()?;
        let Some(state) = self.load_locked()? else {
            return Ok(false);
        };
        if state.update_count <= threshold {
            return Ok(false);
        }
        self.replace_locked(&encode_update_v1(&state.doc))?;
        Ok(true)
    }

    fn lock(&self) -> Result<MutexGuard<'_, ()>, SidecarError> {
        self.gate.lock().map_err(|_| SidecarError::LockPoisoned {
            path: self.path.clone(),
        })
    }

    fn load_locked(&self) -> Result<Option<SidecarState>, SidecarError> {
        let file = match File::open(&self.path) {
            Ok(file) => file,
            Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(source) => return Err(io_error(&self.path, source)),
        };
        let mut reader = BufReader::new(file);
        read_header(&mut reader, &self.path)?;

        let doc = Doc::new();
        doc.get_or_insert_xml_fragment(PROSEMIRROR_ROOT);
        doc.get_or_insert_map(FRONTMATTER_ROOT);
        let mut count = 0usize;
        while let Some(update) = read_record(&mut reader, &self.path, count)? {
            let update = validate_update(&update, &self.path, count)?;
            doc.transact_mut().apply_update(update).map_err(|error| {
                SidecarError::InvalidUpdate {
                    path: self.path.clone(),
                    record: count,
                    reason: error.to_string(),
                }
            })?;
            count += 1;
        }
        if count == 0 {
            return Err(SidecarError::Empty {
                path: self.path.clone(),
            });
        }
        document_from_yrs(&doc).map_err(|source| SidecarError::InvalidDocument {
            path: self.path.clone(),
            source,
        })?;
        Ok(Some(SidecarState {
            doc,
            update_count: count,
        }))
    }

    fn replace_locked(&self, update: &[u8]) -> Result<(), SidecarError> {
        validate_update(update, &self.path, 0)?;
        ensure_parent(&self.path)?;
        let temporary = temporary_path(&self.path);
        let result = (|| {
            let file = OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&temporary)
                .map_err(|source| io_error(&temporary, source))?;
            let mut writer = BufWriter::new(file);
            writer
                .write_all(MAGIC)
                .map_err(|source| io_error(&temporary, source))?;
            write_record(&mut writer, update, &temporary)?;
            writer
                .flush()
                .map_err(|source| io_error(&temporary, source))?;
            writer
                .get_ref()
                .sync_all()
                .map_err(|source| io_error(&temporary, source))?;
            fs::rename(&temporary, &self.path).map_err(|source| io_error(&self.path, source))?;
            sync_parent(&self.path)
        })();
        if result.is_err() {
            // Cleanup is best-effort because the original error names the failed durability step;
            // a stale temp is disposable and the next rewrite truncates it.
            drop(fs::remove_file(&temporary));
        }
        result
    }
}

fn validate_update(update: &[u8], path: &Path, record: usize) -> Result<Update, SidecarError> {
    if update.len() > MAX_UPDATE_BYTES {
        return Err(SidecarError::UpdateTooLarge {
            path: path.to_path_buf(),
            record,
            bytes: update.len(),
            maximum: MAX_UPDATE_BYTES,
        });
    }
    Update::decode_v1(update).map_err(|error| SidecarError::InvalidUpdate {
        path: path.to_path_buf(),
        record,
        reason: error.to_string(),
    })
}

fn ensure_parent(path: &Path) -> Result<(), SidecarError> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    if parent.as_os_str().is_empty() {
        return Ok(());
    }
    fs::create_dir_all(parent).map_err(|source| io_error(parent, source))
}

fn validate_existing_header(file: &mut File, path: &Path) -> Result<(), SidecarError> {
    let mut header = [0u8; MAGIC.len()];
    file.read_exact(&mut header)
        .map_err(|source| io_error(path, source))?;
    if &header != MAGIC {
        return Err(SidecarError::InvalidHeader {
            path: path.to_path_buf(),
        });
    }
    Ok(())
}

fn read_header(reader: &mut impl Read, path: &Path) -> Result<(), SidecarError> {
    let mut header = [0u8; MAGIC.len()];
    match reader.read_exact(&mut header) {
        Ok(()) if &header == MAGIC => Ok(()),
        Ok(()) => Err(SidecarError::InvalidHeader {
            path: path.to_path_buf(),
        }),
        Err(source) if source.kind() == io::ErrorKind::UnexpectedEof => {
            Err(SidecarError::InvalidHeader {
                path: path.to_path_buf(),
            })
        }
        Err(source) => Err(io_error(path, source)),
    }
}

fn read_record(
    reader: &mut impl Read,
    path: &Path,
    record: usize,
) -> Result<Option<Vec<u8>>, SidecarError> {
    let mut header = [0u8; RECORD_HEADER_BYTES];
    let read = reader
        .read(&mut header[..1])
        .map_err(|source| io_error(path, source))?;
    if read == 0 {
        return Ok(None);
    }
    reader
        .read_exact(&mut header[1..])
        .map_err(|source| truncated_or_io(path, record, source))?;
    let length = u32::from_le_bytes([header[0], header[1], header[2], header[3]]) as usize;
    if length > MAX_UPDATE_BYTES {
        return Err(SidecarError::UpdateTooLarge {
            path: path.to_path_buf(),
            record,
            bytes: length,
            maximum: MAX_UPDATE_BYTES,
        });
    }
    let expected_crc = u32::from_le_bytes([header[4], header[5], header[6], header[7]]);
    let mut update = vec![0u8; length];
    reader
        .read_exact(&mut update)
        .map_err(|source| truncated_or_io(path, record, source))?;
    if crc32fast::hash(&update) != expected_crc {
        return Err(SidecarError::ChecksumMismatch {
            path: path.to_path_buf(),
            record,
        });
    }
    Ok(Some(update))
}

fn write_record(writer: &mut impl Write, update: &[u8], path: &Path) -> Result<(), SidecarError> {
    let length = u32::try_from(update.len()).map_err(|_| SidecarError::UpdateTooLarge {
        path: path.to_path_buf(),
        record: 0,
        bytes: update.len(),
        maximum: MAX_UPDATE_BYTES,
    })?;
    writer
        .write_all(&length.to_le_bytes())
        .and_then(|()| writer.write_all(&crc32fast::hash(update).to_le_bytes()))
        .and_then(|()| writer.write_all(update))
        .map_err(|source| io_error(path, source))
}

fn truncated_or_io(path: &Path, record: usize, source: io::Error) -> SidecarError {
    if source.kind() == io::ErrorKind::UnexpectedEof {
        SidecarError::Truncated {
            path: path.to_path_buf(),
            record,
        }
    } else {
        io_error(path, source)
    }
}

fn temporary_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("sidecar.bin");
    path.with_file_name(format!(".{name}.tmp"))
}

fn sync_parent(path: &Path) -> Result<(), SidecarError> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    if parent.as_os_str().is_empty() {
        return Ok(());
    }
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|source| io_error(parent, source))
}

fn io_error(path: &Path, source: io::Error) -> SidecarError {
    SidecarError::Io {
        path: path.to_path_buf(),
        source,
    }
}
