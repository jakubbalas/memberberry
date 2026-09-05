//! Server-owned CRDT-to-Markdown coordination (`SPEC.md` §3.3 and §3.4).
//!
//! This is the only server boundary allowed to mutate a note's `Y.Doc`. It persists every
//! accepted update, batches human-readable Markdown writes, and imports external file edits.

use std::collections::btree_map::Entry;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use mb_crdt::{
    CrdtError, DEFAULT_COMPACTION_THRESHOLD, Sidecar, SidecarError, apply_external_markdown,
    document_from_update_v1, document_from_yrs, document_to_yrs, encode_update_v1,
};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::sync::mpsc;
use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

use mb_core::Username;

use crate::vault::CanonicalNote;
use crate::watch::Changes;
use crate::{Error as ServerError, Vault};

/// The quiet time before a CRDT document is materialized to Markdown.
pub const MARKDOWN_WRITE_DEBOUNCE: Duration = Duration::from_millis(800);

/// Fail-closed errors from the server's single-writer sync boundary.
#[derive(Debug, Error)]
pub enum SyncError {
    #[error("note path is unavailable: {0}")]
    Note(#[from] ServerError),
    #[error("reading Markdown at {path}: {source}")]
    Read { path: PathBuf, source: io::Error },
    #[error("writing Markdown at {path}: {source}")]
    Write { path: PathBuf, source: io::Error },
    #[error("CRDT state: {0}")]
    Crdt(#[from] CrdtError),
    #[error("CRDT sidecar: {0}")]
    Sidecar(#[from] SidecarError),
    #[error("remote update is not a valid lib0 v1 update: {0}")]
    Update(String),
}

/// Result of an external Markdown inspection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExternalUpdate {
    /// The file contains exactly the bytes last written by this coordinator.
    SelfWrite,
    /// The file had not changed semantically.
    Unchanged,
    /// An external edit was applied and should be broadcast as this update.
    Applied(Vec<u8>),
}

/// A client-to-server sync frame. Paths are always re-authorized by the HTTP boundary.
#[derive(Debug, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientFrame {
    Subscribe {
        vault: String,
        note: String,
    },
    Update {
        vault: String,
        note: String,
        update: Vec<u8>,
    },
    Awareness {
        vault: String,
        note: String,
        /// The awareness client ids this frame speaks for. Recorded so the server can
        /// retract exactly this peer's presence the instant its socket closes, rather than
        /// leaving a ghost cursor until `y-protocols` times it out 30s later (§7.5).
        #[serde(default)]
        clients: Vec<u64>,
        state: serde_json::Value,
    },
    Unsubscribe {
        vault: String,
        note: String,
    },
}

/// A server-to-client sync frame.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerFrame {
    Sync {
        vault: String,
        note: String,
        update: Vec<u8>,
    },
    Update {
        vault: String,
        note: String,
        update: Vec<u8>,
    },
    Awareness {
        vault: String,
        note: String,
        user: String,
        state: serde_json::Value,
    },
    /// Retracts presence for clients whose peer has left, so cursors vanish on close.
    Departed {
        vault: String,
        note: String,
        clients: Vec<u64>,
    },
    Error {
        code: &'static str,
    },
}

/// Tag byte for a full-state frame.
const FRAME_SYNC: u8 = 0x01;
/// Tag byte for an incremental update frame.
const FRAME_UPDATE: u8 = 0x02;
/// `tag` + `u16` vault length + `u16` note length.
const BINARY_HEADER_BYTES: usize = 5;

/// A frame as it goes on the wire.
///
/// why: CRDT payloads travel as binary, everything else as JSON. Serde encodes a `Vec<u8>`
/// as a JSON array of decimal numbers — roughly 3-4x the bytes, plus a per-element parse on
/// the receiving side, on the path a keystroke takes (§21). Control frames are small,
/// infrequent and much easier to debug as text, so they stay readable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Wire {
    Text(String),
    Binary(Vec<u8>),
}

impl ServerFrame {
    /// Encodes this frame for transmission, or `None` if it cannot be serialized.
    #[must_use]
    pub fn to_wire(&self) -> Option<Wire> {
        match self {
            Self::Sync {
                vault,
                note,
                update,
            } => Some(Wire::Binary(encode_binary(FRAME_SYNC, vault, note, update))),
            Self::Update {
                vault,
                note,
                update,
            } => Some(Wire::Binary(encode_binary(
                FRAME_UPDATE,
                vault,
                note,
                update,
            ))),
            other => serde_json::to_string(other).ok().map(Wire::Text),
        }
    }
}

impl ClientFrame {
    /// Decodes a binary update frame. Clients send no other binary frame.
    #[must_use]
    pub fn from_binary(bytes: &[u8]) -> Option<Self> {
        let (tag, vault, note, payload) = decode_binary(bytes)?;
        (tag == FRAME_UPDATE).then_some(Self::Update {
            vault,
            note,
            update: payload.to_vec(),
        })
    }
}

fn encode_binary(tag: u8, vault: &str, note: &str, payload: &[u8]) -> Vec<u8> {
    let mut out =
        Vec::with_capacity(BINARY_HEADER_BYTES + vault.len() + note.len() + payload.len());
    out.push(tag);
    // Lengths are u16: a vault slug and a note path are both far below 64 KiB, and a
    // saturating cast here would silently truncate a name rather than fail a frame.
    out.extend_from_slice(&u16::try_from(vault.len()).unwrap_or(u16::MAX).to_be_bytes());
    out.extend_from_slice(&u16::try_from(note.len()).unwrap_or(u16::MAX).to_be_bytes());
    out.extend_from_slice(vault.as_bytes());
    out.extend_from_slice(note.as_bytes());
    out.extend_from_slice(payload);
    out
}

/// Splits a binary frame into `(tag, vault, note, payload)`, rejecting anything malformed.
fn decode_binary(bytes: &[u8]) -> Option<(u8, String, String, &[u8])> {
    let tag = *bytes.first()?;
    let vault_len = usize::from(read_u16(bytes, 1)?);
    let note_len = usize::from(read_u16(bytes, 3)?);
    let vault_end = BINARY_HEADER_BYTES.checked_add(vault_len)?;
    let note_end = vault_end.checked_add(note_len)?;
    let vault = std::str::from_utf8(bytes.get(BINARY_HEADER_BYTES..vault_end)?).ok()?;
    let note = std::str::from_utf8(bytes.get(vault_end..note_end)?).ok()?;
    Some((
        tag,
        vault.to_string(),
        note.to_string(),
        bytes.get(note_end..)?,
    ))
}

fn read_u16(bytes: &[u8], at: usize) -> Option<u16> {
    let slice = bytes.get(at..at.checked_add(2)?)?;
    Some(u16::from_be_bytes([*slice.first()?, *slice.get(1)?]))
}

/// Process-local document rooms. A room only contains clients already authorized by E2.
///
/// Rooms are keyed by [`CanonicalNote::identity`], never by the name a client sent: one
/// file is one room and therefore one writer, however many ways it can be spelled.
#[derive(Debug, Default)]
pub struct SyncRegistry {
    rooms: Mutex<BTreeMap<String, Room>>,
}

#[derive(Debug)]
struct Room {
    coordinator: NoteCoordinator,
    peers: Vec<Peer>,
}

/// Identifies one WebSocket connection for the lifetime of that socket.
///
/// why: a room must be leavable. Without a connection identity the registry can only
/// notice a departure when a send fails, which keeps closed sockets' rooms — and their
/// coordinators, and their 100ms of file I/O — resident for as long as the process runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ConnectionId(u64);

impl ConnectionId {
    /// Issues an identifier no live connection is using.
    #[must_use]
    pub fn issue() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        Self(NEXT.fetch_add(1, Ordering::Relaxed))
    }
}

/// One E2-authorized subscriber.
#[derive(Debug)]
struct Peer {
    connection: ConnectionId,
    /// The name this client subscribed under. A peer that reached the room through an
    /// alias is addressed by its own name, or its client-side note filter drops the frame.
    note: String,
    /// Carried so every outbound frame can re-ask whether this reader is still permitted.
    user: Username,
    /// Awareness client ids this peer has published into the room.
    presence: BTreeSet<u64>,
    outbound: mpsc::UnboundedSender<ServerFrame>,
}

/// One presence announcement from a connection the HTTP boundary has already authenticated.
///
/// The `user` is the server's own answer, never the client's claim about itself.
#[derive(Debug)]
pub struct Announcement<'a> {
    pub user: &'a str,
    pub connection: ConnectionId,
    pub clients: &'a [u64],
    pub state: serde_json::Value,
}

/// Re-checks that a subscriber may still read a document, by vault slug and note identity.
///
/// why: `AGENTS.md` §3.1 — authorize per frame, not per connection. A room admits a peer
/// once, and E2 at subscribe time says nothing about the frame being sent now. Threading
/// the check through every broadcast means a reader who loses access stops receiving
/// content and presence on the next frame rather than whenever they happen to disconnect.
pub type ReadCheck<'a> = &'a dyn Fn(&str, &str, &Username) -> bool;

impl SyncRegistry {
    fn rooms(&self) -> Result<MutexGuard<'_, BTreeMap<String, Room>>, SyncError> {
        self.rooms
            .lock()
            .map_err(|_| SyncError::Update("sync registry lock poisoned".to_string()))
    }

    /// Adds an E2-authorized subscriber and returns the complete state it must apply first.
    pub fn subscribe(
        &self,
        vault: &Vault,
        canonical: &CanonicalNote,
        note: &str,
        user: &Username,
        connection: ConnectionId,
        outbound: mpsc::UnboundedSender<ServerFrame>,
    ) -> Result<ServerFrame, SyncError> {
        let mut rooms = self.rooms()?;
        let room = match rooms.entry(room_key(vault, canonical)) {
            Entry::Occupied(room) => room.into_mut(),
            Entry::Vacant(slot) => slot.insert(Room {
                coordinator: NoteCoordinator::open(vault, canonical)?,
                peers: Vec::new(),
            }),
        };
        // Re-subscribing replaces rather than duplicates: a reconnecting client that sends
        // `subscribe` twice would otherwise receive every frame once per attempt.
        room.peers
            .retain(|peer| peer.connection != connection || peer.note != note);
        room.peers.push(Peer {
            connection,
            note: note.to_string(),
            user: user.clone(),
            presence: BTreeSet::new(),
            outbound,
        });
        Ok(ServerFrame::Sync {
            vault: vault.slug().to_string(),
            note: note.to_string(),
            update: room.coordinator.full_update(),
        })
    }

    /// Removes one connection from one document, releasing the room if it empties.
    ///
    /// # Errors
    ///
    /// Returns [`SyncError`] if the registry lock is poisoned or a final flush fails.
    pub fn unsubscribe(
        &self,
        vault: &Vault,
        canonical: &CanonicalNote,
        connection: ConnectionId,
    ) -> Result<(), SyncError> {
        let mut rooms = self.rooms()?;
        let key = room_key(vault, canonical);
        let Some(room) = rooms.get_mut(&key) else {
            return Ok(());
        };
        let slug = vault.slug().to_string();
        let departed = retract(room, connection, &slug);
        if room.peers.is_empty() {
            release(&mut rooms, &key)?;
        }
        drop(departed);
        Ok(())
    }

    /// Removes a closed connection from every document it had open.
    ///
    /// Presence is retracted immediately rather than left for `y-protocols`' 30s timeout:
    /// §7.5 requires a disconnected client's cursor to disappear on socket close.
    pub fn disconnect(&self, connection: ConnectionId) -> Vec<String> {
        let Ok(mut rooms) = self.rooms.lock() else {
            return vec!["sync registry lock poisoned".to_string()];
        };
        let mut emptied = Vec::new();
        for (key, room) in rooms.iter_mut() {
            if !room.peers.iter().any(|peer| peer.connection == connection) {
                continue;
            }
            let slug = room.coordinator.vault_slug.clone();
            drop(retract(room, connection, &slug));
            if room.peers.is_empty() {
                emptied.push(key.clone());
            }
        }
        emptied
            .iter()
            .filter_map(|key| release(&mut rooms, key).err())
            .map(|error| error.to_string())
            .collect()
    }

    /// Applies an E3-authorized update and broadcasts it only to E2-authorized room members.
    pub fn apply_update(
        &self,
        vault: &Vault,
        canonical: &CanonicalNote,
        update: &[u8],
        authorize: ReadCheck<'_>,
    ) -> Result<(), SyncError> {
        let mut rooms = self.rooms()?;
        let Some(room) = rooms.get_mut(&room_key(vault, canonical)) else {
            return Err(SyncError::Update("document was not subscribed".to_string()));
        };
        let update = room
            .coordinator
            .apply_remote_update(update, Instant::now())?;
        let slug = vault.slug().to_string();
        let room_id = (slug.as_str(), canonical.identity());
        broadcast(&mut room.peers, room_id, authorize, |note| {
            ServerFrame::Update {
                vault: slug.clone(),
                note: note.to_string(),
                update: update.clone(),
            }
        });
        Ok(())
    }

    /// Broadcasts transient awareness to readers already admitted to the room (E4).
    pub fn broadcast_awareness(
        &self,
        vault: &Vault,
        canonical: &CanonicalNote,
        announcement: Announcement<'_>,
        authorize: ReadCheck<'_>,
    ) {
        let Announcement {
            user,
            connection,
            clients,
            state,
        } = announcement;
        let Ok(mut rooms) = self.rooms.lock() else {
            return;
        };
        let Some(room) = rooms.get_mut(&room_key(vault, canonical)) else {
            return;
        };
        if let Some(peer) = room
            .peers
            .iter_mut()
            .find(|peer| peer.connection == connection)
        {
            peer.presence.extend(clients.iter().copied());
        }
        let slug = vault.slug().to_string();
        let room_id = (slug.as_str(), canonical.identity());
        broadcast(&mut room.peers, room_id, authorize, |note| {
            ServerFrame::Awareness {
                vault: slug.clone(),
                note: note.to_string(),
                user: user.to_string(),
                state: state.clone(),
            }
        });
    }

    /// Materializes every open note, discarding no pending debounce. Call on shutdown.
    ///
    /// Recovery makes an unflushed edit survivable (see
    /// [`NoteCoordinator::recover_unflushed_markdown`]), but an orderly stop should still
    /// leave Layer 1 current: after `memberberry serve` exits, the `.md` files are what a
    /// backup, a `git commit` or Obsidian will see.
    pub fn flush_all(&self) -> Vec<String> {
        let Ok(mut rooms) = self.rooms.lock() else {
            return vec!["sync registry lock poisoned".to_string()];
        };
        // Treating the debounce as elapsed flushes exactly the notes with an outstanding
        // write, rather than touching the mtime of every note that merely happens to be open.
        let deadline = Instant::now() + MARKDOWN_WRITE_DEBOUNCE;
        rooms
            .values_mut()
            .filter_map(|room| room.coordinator.flush_if_due(deadline).err())
            .map(|error| error.to_string())
            .collect()
    }

    /// Flushes and closes the room for one note, so its file can be moved (§6.6).
    ///
    /// Returns whether a room was open. A rename must do this **before** it touches the
    /// file: a coordinator holds an absolute path and a debounced write, so a note renamed
    /// underneath one would either error on every maintenance tick or — worse — have the
    /// pending write recreate the file at the old name, resurrecting the note that was just
    /// renamed away.
    ///
    /// Subscribers are not told. There is no frame for "this note is now called something
    /// else" and inventing one is §7.1's business, not §6.6's; a client that keeps editing
    /// the old name gets the same neutral `not_found` a deleted note gives, and reopening
    /// it at the new name is what the client that asked for the rename does.
    ///
    /// # Errors
    ///
    /// Fails if the registry lock is poisoned or the final Markdown write fails — in which
    /// case the caller must not proceed, because the file it is about to move is stale.
    pub fn close(&self, vault: &Vault, identity: &str) -> Result<bool, SyncError> {
        let mut rooms = self.rooms()?;
        let key = format!("{}:{identity}", vault.slug());
        if !rooms.contains_key(&key) {
            return Ok(false);
        }
        release(&mut rooms, &key)?;
        Ok(true)
    }

    /// Performs the timer-driven part of the write and external-change paths for open notes.
    ///
    /// A due Markdown write is flushed for every open note — that is driven by the clock,
    /// not by the filesystem. External inspection is driven by `changed`, so an idle server
    /// reads nothing at all; the watcher says what to look at and the caller's recovery
    /// sweep passes [`Changes::All`] periodically to cover events the platform lost.
    /// Content hashing still prevents a coordinator's own atomic write from looping.
    pub fn maintain(
        &self,
        now: Instant,
        changed: &Changes,
        authorize: ReadCheck<'_>,
    ) -> Vec<String> {
        let Ok(mut rooms) = self.rooms.lock() else {
            return vec!["sync registry lock poisoned".to_string()];
        };
        let mut errors = Vec::new();
        for room in rooms.values_mut() {
            if let Err(error) = room.coordinator.flush_if_due(now) {
                errors.push(error.to_string());
                continue;
            }
            if !changed.includes(&room.coordinator.markdown_path) {
                continue;
            }
            match room.coordinator.inspect_external_change() {
                Ok(ExternalUpdate::Applied(update)) => {
                    // Recipients reached this room only after E2 authorization, and the
                    // update has already passed CRDT validation.
                    let slug = room.coordinator.vault_slug.clone();
                    let room_id = (slug.as_str(), room.coordinator.note.as_str());
                    broadcast(&mut room.peers, room_id, authorize, |note| {
                        ServerFrame::Update {
                            vault: slug.clone(),
                            note: note.to_string(),
                            update: update.clone(),
                        }
                    });
                }
                Ok(ExternalUpdate::SelfWrite | ExternalUpdate::Unchanged) => {}
                Err(error) => errors.push(error.to_string()),
            }
            if let Err(error) = room.coordinator.compact_if_needed() {
                errors.push(error.to_string());
            }
        }
        errors
    }
}

/// Drops `connection`'s peers from `room` and tells the rest to forget their cursors.
fn retract(room: &mut Room, connection: ConnectionId, slug: &str) -> Vec<u64> {
    let mut departed = Vec::new();
    room.peers.retain(|peer| {
        if peer.connection == connection {
            departed.extend(peer.presence.iter().copied());
            return false;
        }
        true
    });
    if !departed.is_empty() {
        // why: a retraction is not a read. It removes state the recipient already holds, so
        // withholding it from anyone in the room would only leave them a stale ghost cursor.
        for peer in &room.peers {
            drop(peer.outbound.send(ServerFrame::Departed {
                vault: slug.to_string(),
                note: peer.note.clone(),
                clients: departed.clone(),
            }));
        }
    }
    departed
}

/// Materializes and closes an empty room, so a note nobody has open costs nothing.
fn release(rooms: &mut BTreeMap<String, Room>, key: &str) -> Result<(), SyncError> {
    let Some(mut room) = rooms.remove(key) else {
        return Ok(());
    };
    room.coordinator
        .flush_if_due(Instant::now() + MARKDOWN_WRITE_DEBOUNCE)?;
    Ok(())
}

fn room_key(vault: &Vault, canonical: &CanonicalNote) -> String {
    // The identity is vault-relative, so the slug is load-bearing: every vault has a
    // `One.md`, and without it two vaults with separate ACLs would share one room.
    format!("{}:{}", vault.slug(), canonical.identity())
}

/// Sends `frame` to every peer still permitted to read the room, dropping the rest.
///
/// A peer that fails the check is removed outright rather than skipped: it has lost read
/// access, so it should also stop appearing in the room and receiving presence.
fn broadcast(
    peers: &mut Vec<Peer>,
    room: (&str, &str),
    authorize: ReadCheck<'_>,
    frame: impl Fn(&str) -> ServerFrame,
) {
    let (vault_slug, note_identity) = room;
    peers.retain(|peer| {
        authorize(vault_slug, note_identity, &peer.user)
            && peer.outbound.send(frame(&peer.note)).is_ok()
    });
}

/// A serialized writer for one note. Keep one instance alive per open document.
#[derive(Debug)]
pub struct NoteCoordinator {
    vault_slug: String,
    /// The room's canonical note identity, needed to re-authorize an imported file change.
    note: String,
    markdown_path: PathBuf,
    /// Records the hash of the Markdown this note last had written to it, so a restart can
    /// tell its own unflushed state from a file somebody edited while the server was down.
    marker: PathBuf,
    sidecar: Sidecar,
    doc: Doc,
    last_written_hash: Option<[u8; 32]>,
    write_due: Option<Instant>,
}

impl NoteCoordinator {
    /// Opens a sidecar, rebuilding it from Markdown when derived state is absent.
    ///
    /// A sidecar that outlived its process is recovered rather than overwritten: see
    /// [`NoteCoordinator::recover_unflushed_markdown`].
    pub fn open(vault: &Vault, canonical: &CanonicalNote) -> Result<Self, SyncError> {
        let markdown_path = canonical.path().to_path_buf();
        // why: the sidecar is named from the canonical identity, not the caller's spelling.
        // Two names for one file must share one sidecar or they diverge silently.
        let sidecar_file = sidecar_path(vault.root(), canonical.identity());
        let marker = marker_path(&sidecar_file);
        let sidecar = Sidecar::new(sidecar_file);
        let restored = sidecar.load()?;
        let recovering = restored.is_some();
        let (doc, last_written_hash) = match restored {
            Some(state) => (state.doc, read_marker(&marker)),
            None => {
                let markdown = read_markdown(&markdown_path)?;
                let doc = document_to_yrs(&mb_core::parse(&markdown))?;
                sidecar.replace(&doc)?;
                let hash = content_hash(markdown.as_bytes());
                write_marker(&marker, &hash)?;
                (doc, Some(hash))
            }
        };
        drop(document_from_yrs(&doc)?);
        let mut coordinator = Self {
            vault_slug: vault.slug().to_string(),
            note: canonical.identity().to_string(),
            markdown_path,
            marker,
            sidecar,
            doc,
            last_written_hash,
            write_due: None,
        };
        if recovering {
            coordinator.recover_unflushed_markdown()?;
        }
        Ok(coordinator)
    }

    /// Re-materializes Markdown a restart interrupted before the debounce elapsed.
    ///
    /// why: `SPEC.md` §3.3 makes the sidecar the crash-safe layer — an update is durable
    /// when it is accepted, not when the 800ms write fires. So when the file on disk is
    /// byte-for-byte what this note's coordinator last wrote, anything the sidecar holds
    /// beyond it is an accepted and already-broadcast edit that never reached Layer 1, and
    /// the sidecar wins. Without this, the first external inspection after a restart reads
    /// the stale file as an incoming edit and reverts those updates.
    ///
    /// A file that does *not* match the marker was edited while the server was down. That
    /// is a real external change and is left to [`Self::inspect_external_change`].
    fn recover_unflushed_markdown(&mut self) -> Result<(), SyncError> {
        let on_disk = read_markdown(&self.markdown_path)?;
        if self.last_written_hash != Some(content_hash(on_disk.as_bytes())) {
            return Ok(());
        }
        if mb_core::to_markdown(&document_from_yrs(&self.doc)?) == on_disk {
            return Ok(());
        }
        self.write_markdown()
    }

    /// Encodes the complete state for a subscriber's initial sync step.
    #[must_use]
    pub fn full_update(&self) -> Vec<u8> {
        encode_update_v1(&self.doc)
    }

    /// Encodes only updates absent from a subscriber's state vector.
    #[must_use]
    pub fn update_since(&self, vector: &StateVector) -> Vec<u8> {
        self.doc.transact().encode_state_as_update_v1(vector)
    }

    /// Applies a client update only after proving its merged document remains schema-valid.
    pub fn apply_remote_update(
        &mut self,
        update: &[u8],
        now: Instant,
    ) -> Result<Vec<u8>, SyncError> {
        // why: validation must precede mutation, or a malformed client frame contaminates
        // the live doc even though the frame is reported as rejected.
        let candidate = document_from_update_v1(&self.full_update())?;
        candidate
            .transact_mut()
            .apply_update(decode_update(update)?)
            .map_err(|error| SyncError::Update(error.to_string()))?;
        drop(document_from_yrs(&candidate)?);
        self.sidecar.append(update)?;
        self.doc
            .transact_mut()
            .apply_update(decode_update(update)?)
            .map_err(|error| SyncError::Update(error.to_string()))?;
        self.write_due = Some(now + MARKDOWN_WRITE_DEBOUNCE);
        Ok(update.to_vec())
    }

    /// Flushes a due Markdown write. Returns `true` only when an atomic write occurred.
    pub fn flush_if_due(&mut self, now: Instant) -> Result<bool, SyncError> {
        if self.write_due.is_none_or(|deadline| now < deadline) {
            return Ok(false);
        }
        self.write_markdown()?;
        self.write_due = None;
        Ok(true)
    }

    /// Writes immediately, used for controlled shutdown and deterministic tests.
    pub fn flush(&mut self) -> Result<(), SyncError> {
        self.write_markdown()?;
        self.write_due = None;
        Ok(())
    }

    /// Compacts an append log once it exceeds the server's bounded replay budget.
    pub fn compact_if_needed(&self) -> Result<(), SyncError> {
        self.sidecar
            .compact_if_needed(DEFAULT_COMPACTION_THRESHOLD)
            .map(|_| ())
            .map_err(SyncError::from)
    }

    /// Imports a filesystem change, suppressing only bytes this coordinator last wrote.
    pub fn inspect_external_change(&mut self) -> Result<ExternalUpdate, SyncError> {
        let markdown = read_markdown(&self.markdown_path)?;
        if self.last_written_hash == Some(content_hash(markdown.as_bytes())) {
            return Ok(ExternalUpdate::SelfWrite);
        }
        let before = self.doc.transact().state_vector();
        let changed = apply_external_markdown(&self.doc, &markdown)?;
        if !changed.changed() {
            return Ok(ExternalUpdate::Unchanged);
        }
        self.sidecar.replace(&self.doc)?;
        Ok(ExternalUpdate::Applied(self.update_since(&before)))
    }

    fn write_markdown(&mut self) -> Result<(), SyncError> {
        let markdown = mb_core::to_markdown(&document_from_yrs(&self.doc)?);
        atomic_write(&self.markdown_path, markdown.as_bytes())?;
        let hash = content_hash(markdown.as_bytes());
        write_marker(&self.marker, &hash)?;
        self.last_written_hash = Some(hash);
        Ok(())
    }
}

/// Moves a note's CRDT sidecar and last-write marker to follow a rename (§6.6).
///
/// why: the sidecar is named from a hash of the note's identity, so a renamed note would
/// otherwise open against a fresh document — losing the editing history — while the old
/// sidecar stayed behind and was picked up by whatever note was created at the old path
/// next, resurrecting content that had been renamed away. Moving it keeps both from
/// happening, and the marker moves with it so the recovery check in
/// [`NoteCoordinator::recover_unflushed_markdown`] still recognises the file.
///
/// Absent derived state is not an error: `rm -rf .memberberry/` must leave a working vault
/// (invariant I1, §22.4), so there may simply be nothing to move.
///
/// # Errors
///
/// Fails only if a sidecar exists and cannot be moved.
pub fn relocate_sidecar(vault_root: &Path, from: &str, to: &str) -> Result<(), SyncError> {
    let old = sidecar_path(vault_root, from);
    let new = sidecar_path(vault_root, to);
    for (old, new) in [(marker_path(&old), marker_path(&new)), (old, new)] {
        if !old.exists() {
            continue;
        }
        if let Some(parent) = new.parent() {
            fs::create_dir_all(parent).map_err(|source| SyncError::Write {
                path: parent.to_path_buf(),
                source,
            })?;
        }
        fs::rename(&old, &new).map_err(|source| SyncError::Write { path: old, source })?;
    }
    Ok(())
}

fn sidecar_path(vault_root: &Path, relative: &str) -> PathBuf {
    let mut name = String::with_capacity(68);
    for byte in content_hash(relative.as_bytes()) {
        name.push_str(&format!("{byte:02x}"));
    }
    name.push_str(".bin");
    vault_root.join(".memberberry").join("crdt").join(name)
}

/// The last-written marker sits beside its sidecar, so `rm -rf .memberberry/` still leaves
/// a vault that rebuilds cleanly from Markdown alone (invariant I1, `SPEC.md` §22.4).
fn marker_path(sidecar: &Path) -> PathBuf {
    sidecar.with_extension("last-write")
}

fn read_marker(path: &Path) -> Option<[u8; 32]> {
    <[u8; 32]>::try_from(fs::read(path).ok()?.as_slice()).ok()
}

fn write_marker(path: &Path, hash: &[u8; 32]) -> Result<(), SyncError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| SyncError::Write {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    atomic_write(path, hash)
}

fn read_markdown(path: &Path) -> Result<String, SyncError> {
    fs::read_to_string(path).map_err(|source| SyncError::Read {
        path: path.to_path_buf(),
        source,
    })
}

fn content_hash(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn decode_update(update: &[u8]) -> Result<Update, SyncError> {
    Update::decode_v1(update).map_err(|error| SyncError::Update(error.to_string()))
}

/// Writes `bytes` to `path` via a temporary file in the same directory.
///
/// Shared with [`crate::rename`]: a rename rewrites notes this module also writes, and a
/// second write implementation would be a second set of crash semantics for one file.
///
/// # Errors
///
/// Fails if the temporary file cannot be written or moved into place.
pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), SyncError> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("note.md");
    let temporary = path.with_file_name(format!(".{name}.memberberry.tmp"));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temporary)
            .map_err(|source| SyncError::Write {
                path: temporary.clone(),
                source,
            })?;
        file.write_all(bytes).map_err(|source| SyncError::Write {
            path: temporary.clone(),
            source,
        })?;
        file.sync_all().map_err(|source| SyncError::Write {
            path: temporary.clone(),
            source,
        })?;
        fs::rename(&temporary, path).map_err(|source| SyncError::Write {
            path: path.to_path_buf(),
            source,
        })?;
        File::open(path.parent().unwrap_or(path))
            .and_then(|directory| directory.sync_all())
            .map_err(|source| SyncError::Write {
                path: path.to_path_buf(),
                source,
            })
    })();
    if result.is_err() {
        drop(fs::remove_file(&temporary));
    }
    result
}
