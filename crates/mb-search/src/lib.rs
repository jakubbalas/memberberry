//! Compact offline search segments (`SPEC.md` §14.2).
//!
//! A segment is immutable derived state: an FST maps field-qualified terms to
//! delta-varint postings, while a dense document map points at the small set of fields the
//! result list needs. Segments contain no authorization decisions. The server builds one
//! for an ACL zone and sends it only to readers of that zone (E6).

#![cfg_attr(
    test,
    allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)
)]

mod codec;
mod query;

use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;

use fst::{IntoStreamer, Map, MapBuilder, Streamer};
use unicode_normalization::UnicodeNormalization;

pub use query::{Field, Query, QueryError};

use crate::codec::{Cursor, put_string, put_u32, put_varint};

const MAGIC: &[u8; 8] = b"MBSEARCH";
const VERSION: u16 = 1;
const HEADER_LEN: usize = 124;
const LIVE: u8 = 1;

/// A note UUID stored in the dense document map.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct NoteId([u8; 16]);

impl NoteId {
    /// Creates an ID from its compact 16-byte representation.
    #[must_use]
    pub const fn from_bytes(bytes: [u8; 16]) -> Self {
        Self(bytes)
    }

    /// Returns the compact representation written to a segment.
    #[must_use]
    pub const fn as_bytes(self) -> [u8; 16] {
        self.0
    }
}

/// Identity used by deltas: a frontmatter UUID when present, otherwise the note path.
///
/// The fallback is required by `SPEC.md` §4.3: merely opening an imported vault must not
/// rewrite every Markdown file to inject IDs. Renaming an ID-less note is consequently a
/// delete of the old path identity plus an upsert under the new one.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum NoteIdentity {
    /// Frontmatter UUID.
    Uuid(NoteId),
    /// Vault-relative path for a note that has no frontmatter UUID.
    Path(String),
}

impl FromStr for NoteId {
    type Err = Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let mut bytes = [0_u8; 16];
        let mut high = None;
        let mut written = 0_usize;
        for byte in value.bytes().filter(|byte| *byte != b'-') {
            let nibble = match byte {
                b'0'..=b'9' => byte - b'0',
                b'a'..=b'f' => byte - b'a' + 10,
                b'A'..=b'F' => byte - b'A' + 10,
                _ => return Err(Error::InvalidNoteId),
            };
            if let Some(first) = high.take() {
                let Some(slot) = bytes.get_mut(written) else {
                    return Err(Error::InvalidNoteId);
                };
                *slot = first << 4 | nibble;
                written += 1;
            } else {
                high = Some(nibble);
            }
        }
        if written != bytes.len() || high.is_some() {
            return Err(Error::InvalidNoteId);
        }
        Ok(Self(bytes))
    }
}

/// A 32-byte versioned zone identity (§14.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ZoneId([u8; 32]);

impl ZoneId {
    /// Parses the lower- or upper-case hexadecimal form persisted by `mb-index`.
    pub fn from_hex(value: &str) -> Result<Self, Error> {
        parse_digest(value).map(Self)
    }

    /// Returns the digest bytes written to the segment header.
    #[must_use]
    pub const fn as_bytes(self) -> [u8; 32] {
        self.0
    }
}

/// A hash of the zone's complete effective permission mapping (§14.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AclHash([u8; 32]);

impl AclHash {
    /// Parses the lower- or upper-case hexadecimal form persisted by `mb-index`.
    pub fn from_hex(value: &str) -> Result<Self, Error> {
        parse_digest(value).map(Self)
    }

    /// Returns the digest bytes written to the segment header.
    #[must_use]
    pub const fn as_bytes(self) -> [u8; 32] {
        self.0
    }
}

fn parse_digest(value: &str) -> Result<[u8; 32], Error> {
    if value.len() != 64 {
        return Err(Error::InvalidDigest);
    }
    let mut out = [0_u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        let high = hex(*pair.first().ok_or(Error::InvalidDigest)?).ok_or(Error::InvalidDigest)?;
        let low = hex(*pair.get(1).ok_or(Error::InvalidDigest)?).ok_or(Error::InvalidDigest)?;
        if let Some(slot) = out.get_mut(index) {
            *slot = high << 4 | low;
        }
    }
    Ok(out)
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Searchable and displayable fields for one live note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Note {
    /// Stable frontmatter UUID, when the note carries one.
    pub id: Option<NoteId>,
    /// Display title, or an empty string when the note has none.
    pub title: String,
    /// Vault-relative Markdown path.
    pub path: String,
    /// Full tags as written, without their leading `#`.
    pub tags: Vec<String>,
    /// Optional custom shortcode or Unicode icon.
    pub icon: Option<String>,
    /// Full visible note text. Only its first 200 characters are retained as the result
    /// snippet; all its tokens enter the postings.
    pub text: String,
}

/// One immutable-segment change. Deletes are retained as tombstones until merging.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    /// Add a new note or replace the prior note with this identity.
    Upsert(Note),
    /// Remove the prior note with this identity.
    Delete(NoteIdentity),
}

impl Change {
    fn identity(&self) -> NoteIdentity {
        match self {
            Self::Upsert(note) => note.identity(),
            Self::Delete(identity) => identity.clone(),
        }
    }
}

impl Note {
    fn identity(&self) -> NoteIdentity {
        self.id
            .map_or_else(|| NoteIdentity::Path(self.path.clone()), NoteIdentity::Uuid)
    }
}

/// The small result payload retained for one note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredNote {
    /// Stable frontmatter UUID, when the note carries one.
    pub id: Option<NoteId>,
    /// Display title, or an empty string when the note has none.
    pub title: String,
    /// Vault-relative Markdown path.
    pub path: String,
    /// Full tags as written, without their leading `#`.
    pub tags: Vec<String>,
    /// Optional custom shortcode or Unicode icon.
    pub icon: Option<String>,
    /// First 200 Unicode scalar values of the visible note text.
    pub snippet: String,
}

/// One matching note. Results are ordered by path for deterministic offline behaviour.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    /// The matched note's display payload.
    pub note: StoredNote,
}

/// Query results plus whether unsupported phrase semantics degraded to AND matching.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchResults {
    /// Matching live notes, ordered by vault-relative path.
    pub hits: Vec<Hit>,
    /// True when a quoted phrase used offline AND semantics because positions are absent.
    pub phrase_degraded: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Record {
    note: Option<StoredNote>,
}

#[derive(Debug)]
struct Materialized {
    record: Record,
    terms: BTreeSet<Vec<u8>>,
}

/// One validated immutable compact index segment.
#[derive(Debug)]
pub struct Segment {
    bytes: Vec<u8>,
    zone_id: ZoneId,
    acl_hash: AclHash,
    fst: Map<Vec<u8>>,
    postings_start: usize,
    postings_end: usize,
    records: Vec<Record>,
    identities: Vec<NoteIdentity>,
}

impl Segment {
    /// Builds a deterministic segment. When an identity occurs more than once, its last
    /// change wins, matching the order in which LSM deltas are applied.
    pub fn build(
        zone_id: ZoneId,
        acl_hash: AclHash,
        changes: impl IntoIterator<Item = Change>,
    ) -> Result<Self, Error> {
        let mut latest = BTreeMap::new();
        for change in changes {
            latest.insert(change.identity(), change);
        }
        let materialized = latest
            .into_iter()
            .map(|(identity, change)| match change {
                Change::Upsert(note) => (identity, materialize(note)),
                Change::Delete(_) => (
                    identity,
                    Materialized {
                        record: Record { note: None },
                        terms: BTreeSet::new(),
                    },
                ),
            })
            .collect();
        Self::encode(zone_id, acl_hash, materialized)
    }

    /// Validates and opens serialized bytes. No query reads unchecked offsets.
    pub fn from_bytes(bytes: Vec<u8>) -> Result<Self, Error> {
        if bytes.len() < HEADER_LEN {
            return Err(Error::Truncated);
        }
        let mut header = Cursor::new(&bytes);
        if header.take(8)? != MAGIC {
            return Err(Error::BadMagic);
        }
        if header.u16()? != VERSION {
            return Err(Error::UnsupportedVersion);
        }
        if header.u16()? != 0 {
            return Err(Error::Corrupt("non-zero header flags"));
        }
        let live_count = header.u32()?;
        let record_count = header.u32()?;
        let term_count = header.u32()?;
        let zone_id = ZoneId(header.array()?);
        let acl_hash = AclHash(header.array()?);
        let fst_len = header.u64_usize()?;
        let postings_len = header.u64_usize()?;
        let fields_len = header.u64_usize()?;
        let map_len = header.u64_usize()?;
        let checksum = header.u32()?;
        let payload = bytes.get(HEADER_LEN..).ok_or(Error::Truncated)?;
        if crc32fast::hash(payload) != checksum {
            return Err(Error::Checksum);
        }
        let expected = fst_len
            .checked_add(postings_len)
            .and_then(|size| size.checked_add(fields_len))
            .and_then(|size| size.checked_add(map_len))
            .ok_or(Error::Corrupt("section lengths overflow"))?;
        if expected != payload.len() {
            return Err(Error::Corrupt("section lengths disagree"));
        }

        let fst_start = HEADER_LEN;
        let postings_start = fst_start + fst_len;
        let postings_end = postings_start + postings_len;
        let fields_end = postings_end + fields_len;
        let fst_bytes = bytes
            .get(fst_start..postings_start)
            .ok_or(Error::Truncated)?;
        let fst = Map::new(fst_bytes.to_vec())?;
        if fst.len() != usize::try_from(term_count)? {
            return Err(Error::Corrupt("term count disagrees"));
        }
        validate_posting_offsets(&fst, postings_len)?;
        let field_bytes = bytes
            .get(postings_end..fields_end)
            .ok_or(Error::Truncated)?;
        let mut records = decode_records(field_bytes, record_count)?;
        let map_bytes = bytes.get(fields_end..).ok_or(Error::Truncated)?;
        let identities = decode_identities(map_bytes, record_count)?;
        for (record, identity) in records.iter_mut().zip(&identities) {
            if let Some(note) = &mut record.note {
                match identity {
                    NoteIdentity::Uuid(id) => note.id = Some(*id),
                    NoteIdentity::Path(path) if path == &note.path => note.id = None,
                    NoteIdentity::Path(_) => {
                        return Err(Error::Corrupt("path identity disagrees with fields"));
                    }
                }
            }
        }
        if records
            .iter()
            .filter(|record| record.note.is_some())
            .count()
            != usize::try_from(live_count)?
        {
            return Err(Error::Corrupt("live note count disagrees"));
        }
        let segment = Self {
            bytes,
            zone_id,
            acl_hash,
            fst,
            postings_start,
            postings_end,
            records,
            identities,
        };
        segment.validate_postings()?;
        Ok(segment)
    }

    /// Returns the validated serialized representation.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Returns the zone identity in the header.
    #[must_use]
    pub const fn zone_id(&self) -> ZoneId {
        self.zone_id
    }

    /// Returns the ACL revision in the header.
    #[must_use]
    pub const fn acl_hash(&self) -> AclHash {
        self.acl_hash
    }

    /// Searches this segment using offline prefix semantics.
    pub fn search(&self, query: &Query) -> Result<SearchResults, Error> {
        let live = self
            .records
            .iter()
            .enumerate()
            .filter_map(|(doc, record)| record.note.as_ref().map(|_| doc))
            .map(u32::try_from)
            .collect::<Result<BTreeSet<_>, _>>()?;
        let docs = query.evaluate(&live, |field, term| self.lookup(field, term))?;
        let mut hits = docs
            .into_iter()
            .filter_map(|doc| {
                self.records
                    .get(usize::try_from(doc).ok()?)?
                    .note
                    .clone()
                    .map(|note| Hit { note })
            })
            .collect::<Vec<_>>();
        hits.sort_by(|left, right| left.note.path.cmp(&right.note.path));
        Ok(SearchResults {
            hits,
            phrase_degraded: query.phrase_degraded(),
        })
    }

    /// Merges a base segment followed by newer deltas. A newer upsert or tombstone replaces
    /// the older record with the same UUID or fallback path identity. ACL revisions must
    /// match so bytes from a revoked permission epoch can never be folded into the replacement
    /// segment by accident.
    pub fn merge(segments: &[Self]) -> Result<Self, Error> {
        let first = segments.first().ok_or(Error::EmptyMerge)?;
        let mut latest = BTreeMap::new();
        for segment in segments {
            if segment.zone_id != first.zone_id || segment.acl_hash != first.acl_hash {
                return Err(Error::MetadataMismatch);
            }
            for (identity, materialized) in segment.materialized()? {
                latest.insert(identity, materialized);
            }
        }
        Self::encode(first.zone_id, first.acl_hash, latest)
    }

    fn lookup(&self, field: Field, term: &str) -> Result<BTreeSet<u32>, Error> {
        let prefix = term_key(field, term);
        let mut upper = prefix.clone();
        upper.push(0xff);
        let mut stream = self
            .fst
            .range()
            .ge(prefix.as_slice())
            .lt(upper.as_slice())
            .into_stream();
        let mut docs = BTreeSet::new();
        while let Some((_, offset)) = stream.next() {
            docs.extend(self.postings(offset)?);
        }
        Ok(docs)
    }

    fn postings(&self, offset: u64) -> Result<Vec<u32>, Error> {
        let relative = usize::try_from(offset)?;
        let start = self
            .postings_start
            .checked_add(relative)
            .filter(|start| *start < self.postings_end)
            .ok_or(Error::Corrupt("postings offset out of bounds"))?;
        let bytes = self
            .bytes
            .get(start..self.postings_end)
            .ok_or(Error::Corrupt("postings bounds disagree"))?;
        let mut cursor = Cursor::new(bytes);
        let count = cursor.varint_usize()?;
        let mut last = 0_u32;
        let mut out = Vec::with_capacity(count);
        for index in 0..count {
            let delta = cursor.varint_u32()?;
            if index > 0 && delta == 0 {
                return Err(Error::Corrupt("postings are not strictly increasing"));
            }
            last = if index == 0 {
                delta
            } else {
                last.checked_add(delta)
                    .ok_or(Error::Corrupt("posting delta overflow"))?
            };
            if usize::try_from(last)? >= self.records.len() {
                return Err(Error::Corrupt("posting document out of bounds"));
            }
            out.push(last);
        }
        Ok(out)
    }

    fn validate_postings(&self) -> Result<(), Error> {
        let mut stream = self.fst.stream();
        while let Some((term, offset)) = stream.next() {
            let marker = term
                .first()
                .copied()
                .ok_or(Error::Corrupt("empty FST key"))?;
            if !(Field::Any.marker()..=Field::Tag.marker()).contains(&marker)
                || term.get(1..).is_none_or(|text| text.is_empty())
            {
                return Err(Error::Corrupt("invalid field-qualified term"));
            }
            std::str::from_utf8(term.get(1..).ok_or(Error::Corrupt("empty FST key"))?)?;
            for doc in self.postings(offset)? {
                if self
                    .records
                    .get(usize::try_from(doc)?)
                    .is_none_or(|record| record.note.is_none())
                {
                    return Err(Error::Corrupt("posting refers to a tombstone"));
                }
            }
        }
        Ok(())
    }

    fn materialized(&self) -> Result<BTreeMap<NoteIdentity, Materialized>, Error> {
        let mut out = self
            .identities
            .iter()
            .cloned()
            .zip(self.records.iter().cloned())
            .map(|(id, record)| {
                (
                    id,
                    Materialized {
                        record,
                        terms: BTreeSet::new(),
                    },
                )
            })
            .collect::<BTreeMap<_, _>>();
        let mut stream = self.fst.stream();
        while let Some((term, offset)) = stream.next() {
            for doc in self.postings(offset)? {
                let identity = self
                    .identities
                    .get(usize::try_from(doc)?)
                    .ok_or(Error::Corrupt("posting document out of bounds"))?
                    .clone();
                let record = out
                    .get_mut(&identity)
                    .ok_or(Error::Corrupt("document map disagrees"))?;
                record.terms.insert(term.to_vec());
            }
        }
        Ok(out)
    }

    fn encode(
        zone_id: ZoneId,
        acl_hash: AclHash,
        records: BTreeMap<NoteIdentity, Materialized>,
    ) -> Result<Self, Error> {
        let mut postings_by_term: BTreeMap<Vec<u8>, Vec<u32>> = BTreeMap::new();
        for (doc, materialized) in records.values().enumerate() {
            let doc = u32::try_from(doc)?;
            for term in &materialized.terms {
                postings_by_term.entry(term.clone()).or_default().push(doc);
            }
        }

        let mut postings = Vec::new();
        let mut fst_builder = MapBuilder::memory();
        for (term, docs) in &postings_by_term {
            let offset = u64::try_from(postings.len())?;
            fst_builder.insert(term, offset)?;
            put_varint(&mut postings, u64::try_from(docs.len())?);
            let mut previous = 0_u32;
            for (index, doc) in docs.iter().copied().enumerate() {
                let delta = if index == 0 { doc } else { doc - previous };
                put_varint(&mut postings, u64::from(delta));
                previous = doc;
            }
        }
        let fst = fst_builder.into_inner()?;

        let mut fields = Vec::new();
        let mut map = Vec::new();
        let mut live_count = 0_u32;
        for (identity, materialized) in &records {
            match identity {
                NoteIdentity::Uuid(id) => {
                    map.push(1);
                    map.extend_from_slice(&id.0);
                }
                NoteIdentity::Path(path) => {
                    map.push(0);
                    put_string(&mut map, path)?;
                }
            }
            match &materialized.record.note {
                Some(note) => {
                    live_count = live_count.checked_add(1).ok_or(Error::TooLarge)?;
                    fields.push(LIVE);
                    put_string(&mut fields, &note.title)?;
                    put_string(&mut fields, &note.path)?;
                    put_varint(&mut fields, u64::try_from(note.tags.len())?);
                    for tag in &note.tags {
                        put_string(&mut fields, tag)?;
                    }
                    match &note.icon {
                        Some(icon) => {
                            fields.push(1);
                            put_string(&mut fields, icon)?;
                        }
                        None => fields.push(0),
                    }
                    put_string(&mut fields, &note.snippet)?;
                }
                None => fields.push(0),
            }
        }

        let mut payload = Vec::new();
        payload.extend_from_slice(&fst);
        payload.extend_from_slice(&postings);
        payload.extend_from_slice(&fields);
        payload.extend_from_slice(&map);
        let mut bytes = Vec::with_capacity(HEADER_LEN + payload.len());
        bytes.extend_from_slice(MAGIC);
        bytes.extend_from_slice(&VERSION.to_le_bytes());
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        put_u32(&mut bytes, live_count);
        put_u32(&mut bytes, u32::try_from(records.len())?);
        put_u32(&mut bytes, u32::try_from(postings_by_term.len())?);
        bytes.extend_from_slice(&zone_id.0);
        bytes.extend_from_slice(&acl_hash.0);
        bytes.extend_from_slice(&u64::try_from(fst.len())?.to_le_bytes());
        bytes.extend_from_slice(&u64::try_from(postings.len())?.to_le_bytes());
        bytes.extend_from_slice(&u64::try_from(fields.len())?.to_le_bytes());
        bytes.extend_from_slice(&u64::try_from(map.len())?.to_le_bytes());
        put_u32(&mut bytes, crc32fast::hash(&payload));
        bytes.extend_from_slice(&payload);
        Self::from_bytes(bytes)
    }
}

fn materialize(note: Note) -> Materialized {
    let stored = StoredNote {
        id: note.id,
        title: note.title.clone(),
        path: note.path.clone(),
        tags: note.tags.clone(),
        icon: note.icon,
        snippet: note.text.chars().take(200).collect(),
    };
    let mut terms = BTreeSet::new();
    add_terms(&mut terms, Field::Any, &note.text);
    add_terms(&mut terms, Field::Body, &note.text);
    add_terms(&mut terms, Field::Any, &note.title);
    add_terms(&mut terms, Field::Title, &note.title);
    add_terms(&mut terms, Field::Any, &note.path);
    add_terms(&mut terms, Field::Path, &note.path);
    for tag in &note.tags {
        add_terms(&mut terms, Field::Any, tag);
        add_terms(&mut terms, Field::Tag, tag);
    }
    Materialized {
        record: Record { note: Some(stored) },
        terms,
    }
}

fn decode_identities(bytes: &[u8], count: u32) -> Result<Vec<NoteIdentity>, Error> {
    let mut cursor = Cursor::new(bytes);
    let mut identities = Vec::with_capacity(usize::try_from(count)?);
    for _ in 0..count {
        identities.push(match cursor.byte()? {
            0 => NoteIdentity::Path(cursor.string()?),
            1 => NoteIdentity::Uuid(NoteId(cursor.array()?)),
            _ => return Err(Error::Corrupt("unknown identity flag")),
        });
    }
    if !cursor.is_empty() {
        return Err(Error::Corrupt("trailing document-map bytes"));
    }
    Ok(identities)
}

fn add_terms(terms: &mut BTreeSet<Vec<u8>>, field: Field, text: &str) {
    for term in tokenize(text) {
        terms.insert(term_key(field, &term));
    }
}

fn tokenize(text: &str) -> impl Iterator<Item = String> + '_ {
    text.nfc()
        .collect::<String>()
        .split(|character: char| !character.is_alphanumeric())
        .filter(|term| !term.is_empty())
        .map(str::to_lowercase)
        .collect::<Vec<_>>()
        .into_iter()
}

fn term_key(field: Field, term: &str) -> Vec<u8> {
    let mut key = vec![field.marker()];
    key.extend_from_slice(term.as_bytes());
    key
}

fn validate_posting_offsets(fst: &Map<Vec<u8>>, postings_len: usize) -> Result<(), Error> {
    let mut stream = fst.stream();
    while let Some((_, offset)) = stream.next() {
        if usize::try_from(offset)? >= postings_len {
            return Err(Error::Corrupt("FST postings offset out of bounds"));
        }
    }
    Ok(())
}

fn decode_records(bytes: &[u8], count: u32) -> Result<Vec<Record>, Error> {
    let mut cursor = Cursor::new(bytes);
    let mut records = Vec::with_capacity(usize::try_from(count)?);
    for _ in 0..count {
        let flag = cursor.byte()?;
        if flag == 0 {
            records.push(Record { note: None });
            continue;
        }
        if flag != LIVE {
            return Err(Error::Corrupt("unknown record flag"));
        }
        let title = cursor.string()?;
        let path = cursor.string()?;
        let tag_count = cursor.varint_usize()?;
        let mut tags = Vec::with_capacity(tag_count);
        for _ in 0..tag_count {
            tags.push(cursor.string()?);
        }
        let icon = match cursor.byte()? {
            0 => None,
            1 => Some(cursor.string()?),
            _ => return Err(Error::Corrupt("unknown icon flag")),
        };
        let snippet = cursor.string()?;
        records.push(Record {
            note: Some(StoredNote {
                id: None,
                title,
                path,
                tags,
                icon,
                snippet,
            }),
        });
    }
    if !cursor.is_empty() {
        return Err(Error::Corrupt("trailing field bytes"));
    }
    Ok(records)
}

/// Errors produced by segment construction, validation, merging, and querying.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("note ID is not 32 hexadecimal digits")]
    InvalidNoteId,
    #[error("zone ID or ACL hash is not 64 hexadecimal digits")]
    InvalidDigest,
    #[error("compact index is truncated")]
    Truncated,
    #[error("compact index has the wrong magic")]
    BadMagic,
    #[error("compact index version is unsupported")]
    UnsupportedVersion,
    #[error("compact index checksum does not match")]
    Checksum,
    #[error("compact index is corrupt: {0}")]
    Corrupt(&'static str),
    #[error("cannot merge no segments")]
    EmptyMerge,
    #[error("segments belong to different zone or ACL revisions")]
    MetadataMismatch,
    #[error("compact index exceeds its representable size")]
    TooLarge,
    #[error("FST: {0}")]
    Fst(#[from] fst::Error),
    #[error("query: {0}")]
    Query(#[from] QueryError),
    #[error("integer conversion exceeds this platform")]
    Integer(#[from] std::num::TryFromIntError),
    #[error("field text is not UTF-8")]
    Utf8(#[from] std::str::Utf8Error),
}
