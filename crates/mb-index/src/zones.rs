//! ACL-zone computation and persistence (`SPEC.md` §14.2).
//!
//! Zones are derived from the live policy, not from note Markdown. The vault root begins one
//! zone and a rule path starts another only when the complete effective user/role mapping
//! differs there. Redundant rules therefore do not fragment the compact search index.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use mb_core::{Access, NotePath, Role, Username};
use mb_search::{AclHash, Change, Note, NoteId, Segment, ZoneId};
use rusqlite::Transaction;
use sha2::{Digest, Sha256};

use crate::{Error, Index};

#[derive(Debug, Clone, PartialEq, Eq)]
struct Zone {
    zone_id: String,
    path_prefix: String,
    acl_hash: String,
    permissions: BTreeMap<Username, Role>,
}

#[derive(Debug)]
pub(crate) struct PublishedSegment {
    acl_hash: String,
    bytes: Vec<u8>,
}

pub(crate) type PublishedSegments = BTreeMap<String, PublishedSegment>;

/// One compact segment the current reader is permitted to receive (E6).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientSegment {
    /// Stable zone identity, as lower-case hexadecimal.
    pub zone_id: String,
    /// Hash of the complete effective permission mapping for this segment.
    pub acl_hash: String,
    /// Validated `mb-search` binary-v1 bytes.
    pub bytes: Vec<u8>,
}

impl Index {
    /// Replaces the persisted ACL zones with the maximal zones of `access`.
    ///
    /// Returns whether the zone description changed. The root zone always exists, including
    /// for a deny-all policy; rule paths whose effective permissions equal their containing
    /// zone are deliberately omitted.
    ///
    /// # Errors
    ///
    /// Fails if SQLite cannot read or atomically replace the derived rows.
    pub fn replace_zones(&mut self, access: &Access) -> Result<bool, Error> {
        let zones = compute(access);
        let existing = read(&self.conn)?;
        let replacement: Vec<_> = zones
            .iter()
            .map(|zone| {
                (
                    zone.zone_id.clone(),
                    zone.path_prefix.clone(),
                    zone.acl_hash.clone(),
                )
            })
            .collect();
        if existing == replacement {
            if !published_matches(&self.zone_segments, &zones) {
                self.search.publish()?;
                self.rebuild_zone_segments()?;
            }
            return Ok(false);
        }

        let transaction = self.conn.transaction()?;
        write(&transaction, &zones)?;
        transaction.commit()?;
        // The text writer may contain note changes when a caller updates policy directly.
        // Publishing first makes the replacement permission epoch a complete snapshot.
        self.search.publish()?;
        self.rebuild_zone_segments()?;
        Ok(true)
    }

    /// Rebuilds every zone segment from the published derived index.
    ///
    /// A full rebuild is deliberate for this first boundary: it establishes the exact zone
    /// partition and crash-safe file format before incremental deltas and transport add a
    /// second cadence. Every note is assigned to the deepest matching zone, so parent and
    /// child segments never duplicate content.
    pub(crate) fn rebuild_zone_segments(&mut self) -> Result<(), Error> {
        // An error below must fail closed. Keeping the previous snapshot would be unsafe
        // when a note just moved from a readable zone into a denied one.
        self.zone_segments.clear();
        let zones = zones(&self.conn)?;
        let text = self.search.all_text()?;
        let mut notes = notes(&self.conn, &text)?;
        let mut changes: BTreeMap<String, Vec<Change>> = zones
            .iter()
            .map(|zone| (zone.zone_id.clone(), Vec::new()))
            .collect();
        for (path, note) in &mut notes {
            let Some(zone) = containing_zone(&zones, path) else {
                continue;
            };
            if let Some(zone_changes) = changes.get_mut(&zone.zone_id) {
                zone_changes.push(Change::Upsert(note.clone()));
            }
        }

        let mut published = PublishedSegments::new();
        for zone in &zones {
            let segment = Segment::build(
                ZoneId::from_hex(&zone.zone_id)?,
                AclHash::from_hex(&zone.acl_hash)?,
                changes.remove(&zone.zone_id).unwrap_or_default(),
            )?;
            published.insert(
                zone.zone_id.clone(),
                PublishedSegment {
                    acl_hash: zone.acl_hash.clone(),
                    bytes: segment.as_bytes().to_vec(),
                },
            );
        }
        if let Some(index_path) = &self.path {
            persist(&index_path.with_file_name("zones"), &published)?;
        }
        self.zone_segments = published;
        Ok(())
    }
}

fn published_matches(published: &PublishedSegments, zones: &[Zone]) -> bool {
    published.len() == zones.len()
        && zones.iter().all(|zone| {
            published
                .get(&zone.zone_id)
                .is_some_and(|segment| segment.acl_hash == zone.acl_hash)
        })
}

impl crate::Reader<'_> {
    /// Returns only compact zone segments this reader may receive (E6, §14.2).
    ///
    /// Both the zone ID and ACL hash must match the live policy snapshot captured when this
    /// reader was created. A failed or partial rebuild therefore withholds a segment rather
    /// than returning bytes from an older permission epoch.
    #[must_use]
    pub fn client_segments(&self) -> Vec<ClientSegment> {
        self.permitted_zones
            .iter()
            .filter_map(|(zone_id, acl_hash)| {
                let segment = self.zone_segments.get(zone_id)?;
                (segment.acl_hash == *acl_hash).then(|| ClientSegment {
                    zone_id: zone_id.clone(),
                    acl_hash: acl_hash.clone(),
                    bytes: segment.bytes.clone(),
                })
            })
            .collect()
    }
}

fn compute(access: &Access) -> Vec<Zone> {
    let mut users: BTreeSet<Username> = access.members().map(|(user, _)| user.clone()).collect();
    for rule in access.rules() {
        users.extend(rule.grants.keys().cloned());
    }

    let root_permissions = access
        .members()
        .filter(|(_, role)| *role != Role::None)
        .map(|(user, role)| (user.clone(), role))
        .collect();
    let mut zones = vec![zone(String::new(), root_permissions)];
    let mut paths: Vec<_> = access.rules().map(|rule| rule.path.clone()).collect();
    paths.sort_by(|left, right| {
        left.as_str()
            .split('/')
            .count()
            .cmp(&right.as_str().split('/').count())
            .then_with(|| left.as_str().cmp(right.as_str()))
    });

    for path in paths {
        let permissions = users
            .iter()
            .filter_map(|user| {
                let role = access.effective_role(user, &path);
                (role != Role::None).then(|| (user.clone(), role))
            })
            .collect::<BTreeMap<_, _>>();
        let parent = zones
            .iter()
            .filter(|candidate| prefix_matches(&candidate.path_prefix, path.as_str()))
            .max_by_key(|candidate| prefix_depth(&candidate.path_prefix));
        if parent.is_some_and(|candidate| candidate.permissions == permissions) {
            continue;
        }
        zones.push(zone(path.to_string(), permissions));
    }
    zones
}

pub(crate) fn permitted(
    conn: &rusqlite::Connection,
    access: &Access,
    user: &Username,
) -> Result<BTreeMap<String, String>, Error> {
    Ok(zones(conn)?
        .into_iter()
        .filter(|zone| role_at(access, user, &zone.path_prefix) != Role::None)
        .map(|zone| (zone.zone_id, zone.acl_hash))
        .collect())
}

fn role_at(access: &Access, user: &Username, path_prefix: &str) -> Role {
    if path_prefix.is_empty() {
        return access
            .members()
            .find_map(|(candidate, role)| (candidate == user).then_some(role))
            .unwrap_or(Role::None);
    }
    NotePath::parse(path_prefix)
        .map(|path| access.effective_role(user, &path))
        .unwrap_or(Role::None)
}

fn prefix_matches(prefix: &str, path: &str) -> bool {
    prefix.is_empty()
        || path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|remainder| remainder.starts_with('/'))
}

fn prefix_depth(prefix: &str) -> usize {
    if prefix.is_empty() {
        0
    } else {
        prefix.split('/').count()
    }
}

fn zone(path_prefix: String, permissions: BTreeMap<Username, Role>) -> Zone {
    Zone {
        zone_id: digest("memberberry-zone-id-v1", path_prefix.as_bytes()),
        acl_hash: permissions_hash(&permissions),
        path_prefix,
        permissions,
    }
}

fn permissions_hash(permissions: &BTreeMap<Username, Role>) -> String {
    let mut source = Vec::new();
    for (user, role) in permissions {
        let username = user.as_str().as_bytes();
        source.extend_from_slice(&(username.len() as u64).to_be_bytes());
        source.extend_from_slice(username);
        source.extend_from_slice(role.as_str().as_bytes());
        source.push(0);
    }
    digest("memberberry-zone-acl-v1", &source)
}

fn digest(domain: &str, value: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(domain.as_bytes());
    hash.update([0]);
    hash.update(value);
    format!("{:x}", hash.finalize())
}

fn read(conn: &rusqlite::Connection) -> Result<Vec<(String, String, String)>, Error> {
    let mut statement = conn
        .prepare_cached("SELECT zone_id, path_prefix, acl_hash FROM zones ORDER BY path_prefix")?;
    let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn zones(conn: &rusqlite::Connection) -> Result<Vec<Zone>, Error> {
    let mut statement = conn
        .prepare_cached("SELECT zone_id, path_prefix, acl_hash FROM zones ORDER BY path_prefix")?;
    let rows = statement.query_map([], |row| {
        Ok(Zone {
            zone_id: row.get(0)?,
            path_prefix: row.get(1)?,
            acl_hash: row.get(2)?,
            permissions: BTreeMap::new(),
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn containing_zone<'a>(zones: &'a [Zone], path: &str) -> Option<&'a Zone> {
    zones
        .iter()
        .filter(|zone| prefix_matches(&zone.path_prefix, path))
        .max_by_key(|zone| prefix_depth(&zone.path_prefix))
}

fn notes(
    conn: &rusqlite::Connection,
    text: &BTreeMap<String, String>,
) -> Result<Vec<(String, Note)>, Error> {
    let mut statement =
        conn.prepare_cached("SELECT id, path, uuid, title, icon FROM notes ORDER BY path")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
        ))
    })?;
    let metadata = rows.collect::<Result<Vec<_>, _>>()?;
    let mut tag_statement =
        conn.prepare_cached("SELECT DISTINCT tag FROM tags WHERE note_id = ?1 ORDER BY tag")?;
    metadata
        .into_iter()
        .map(|(row_id, path, id, title, icon)| {
            let tags = tag_statement
                .query_map([row_id], |row| row.get(0))?
                .collect::<Result<Vec<String>, _>>()?;
            let id = id.and_then(|value| value.parse::<NoteId>().ok());
            let note = Note {
                id,
                title: title.unwrap_or_default(),
                path: path.clone(),
                tags,
                icon,
                text: text.get(&path).cloned().unwrap_or_default(),
            };
            Ok((path, note))
        })
        .collect()
}

fn persist(directory: &Path, segments: &PublishedSegments) -> Result<(), Error> {
    fs::create_dir_all(directory).map_err(|source| Error::Directory {
        path: directory.to_path_buf(),
        source,
    })?;
    let expected: BTreeSet<PathBuf> = segments
        .keys()
        .map(|zone_id| directory.join(format!("{zone_id}.idx")))
        .collect();
    for (zone_id, segment) in segments {
        let path = directory.join(format!("{zone_id}.idx"));
        let temporary = directory.join(format!(".{zone_id}.idx.tmp"));
        fs::write(&temporary, &segment.bytes).map_err(|source| Error::SegmentWrite {
            path: temporary.clone(),
            source,
        })?;
        fs::rename(&temporary, &path).map_err(|source| Error::SegmentWrite {
            path: path.clone(),
            source,
        })?;
    }
    for entry in fs::read_dir(directory).map_err(|source| Error::Directory {
        path: directory.to_path_buf(),
        source,
    })? {
        let path = entry
            .map_err(|source| Error::Directory {
                path: directory.to_path_buf(),
                source,
            })?
            .path();
        if path.extension().is_some_and(|extension| extension == "idx") && !expected.contains(&path)
        {
            fs::remove_file(&path).map_err(|source| Error::SegmentWrite { path, source })?;
        }
    }
    Ok(())
}

fn write(transaction: &Transaction<'_>, zones: &[Zone]) -> Result<(), Error> {
    transaction.execute("DELETE FROM zones", [])?;
    let mut insert = transaction
        .prepare_cached("INSERT INTO zones (zone_id, path_prefix, acl_hash) VALUES (?1, ?2, ?3)")?;
    for zone in zones {
        insert.execute(rusqlite::params![
            &zone.zone_id,
            &zone.path_prefix,
            &zone.acl_hash
        ])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use mb_core::{Member, NotePath, Rule};
    use proptest::prelude::*;

    fn user(name: &str) -> Username {
        Username::parse(name).expect("username")
    }

    fn rule(path: &str, name: &str, role: Role) -> Rule {
        Rule {
            path: NotePath::parse(path).expect("path"),
            grants: BTreeMap::from([(user(name), role)]),
        }
    }

    #[test]
    fn redundant_rules_do_not_split_a_zone() {
        let access = Access::new(
            vec![Member {
                user: user("alice"),
                role: Role::Viewer,
            }],
            vec![
                rule("Shared", "alice", Role::Viewer),
                rule("Private", "alice", Role::None),
                rule("Private/Still", "alice", Role::None),
            ],
        )
        .expect("policy");
        let prefixes: Vec<_> = compute(&access)
            .into_iter()
            .map(|zone| zone.path_prefix)
            .collect();
        assert_eq!(prefixes, ["", "Private"]);
    }

    proptest! {
        #[test]
        fn zone_computation_is_independent_of_rule_order(order in prop::collection::vec(0usize..4, 0..20)) {
            let rules = [
                rule("Projects", "alice", Role::Editor),
                rule("Projects/Private", "bob", Role::None),
                rule("Archive", "alice", Role::None),
                rule("Archive/Public", "carol", Role::Viewer),
            ];
            let selected: BTreeSet<_> = order.into_iter().collect();
            let forward: Vec<_> = selected.iter().map(|index| rules[*index].clone()).collect();
            let reverse: Vec<_> = forward.iter().rev().cloned().collect();
            let members = vec![
                Member { user: user("alice"), role: Role::Viewer },
                Member { user: user("bob"), role: Role::Editor },
            ];
            let left = Access::new(members.clone(), forward).expect("policy");
            let right = Access::new(members, reverse).expect("policy");
            prop_assert_eq!(compute(&left), compute(&right));
        }
    }
}
