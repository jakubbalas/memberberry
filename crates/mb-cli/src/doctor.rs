//! Cross-store vault integrity checks (`SPEC.md` §19.3).

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use mb_index::Stamp;
use sha2::{Digest, Sha256};

#[derive(Debug)]
struct Note {
    relative: String,
    path: PathBuf,
    source: String,
    document: mb_core::Document,
}

#[derive(Debug, Default)]
struct Totals {
    found: usize,
    fixed: usize,
    remaining: usize,
}

impl Totals {
    fn finding(&mut self, repaired: bool) {
        self.found += 1;
        if repaired {
            self.fixed += 1;
        } else {
            self.remaining += 1;
        }
    }
}

pub(crate) fn run(
    vaults: &[&mb_server::Vault],
    auth: &mb_auth::AuthDb,
    data_dir: &Path,
    fix: bool,
    runtime: &tokio::runtime::Runtime,
    out: &mut dyn Write,
) -> Result<ExitCode, String> {
    let mut totals = Totals::default();
    for vault in vaults {
        check_vault(vault, auth, data_dir, fix, runtime, out, &mut totals)?;
    }
    if totals.found == 0 {
        writeln!(out, "doctor: no integrity problems").map_err(io("writing doctor report"))?;
    } else {
        writeln!(
            out,
            "doctor: {} finding(s), {} fixed, {} remaining",
            totals.found, totals.fixed, totals.remaining
        )
        .map_err(io("writing doctor report"))?;
    }
    Ok(if totals.remaining == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    })
}

fn check_vault(
    vault: &mb_server::Vault,
    auth: &mb_auth::AuthDb,
    data_dir: &Path,
    fix: bool,
    runtime: &tokio::runtime::Runtime,
    out: &mut dyn Write,
    totals: &mut Totals,
) -> Result<(), String> {
    let mut notes = read_notes(vault)?;
    check_ids(vault, &mut notes, fix, out, totals)?;
    check_links_conflicts_and_emoji(vault, data_dir, &notes, out, totals)?;
    check_sidecars(vault, &notes, fix, out, totals)?;
    check_index(vault, fix, out, totals)?;
    check_history(vault, &notes, fix, out, totals)?;
    check_access(vault, auth, out, totals)?;
    check_shares(vault, auth, fix, out, totals)?;
    check_media(vault, runtime, out, totals)
}

fn read_notes(vault: &mb_server::Vault) -> Result<Vec<Note>, String> {
    vault
        .notes()
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|relative| {
            let path = vault
                .resolve(&relative)
                .map_err(|error| error.to_string())?;
            let source = fs::read_to_string(&path)
                .map_err(|error| format!("reading {}: {error}", path.display()))?;
            let document = mb_core::parse(&source);
            Ok(Note {
                relative,
                path,
                source,
                document,
            })
        })
        .collect()
}

fn check_ids(
    vault: &mb_server::Vault,
    notes: &mut [Note],
    fix: bool,
    out: &mut dyn Write,
    totals: &mut Totals,
) -> Result<(), String> {
    let mut first_by_id = BTreeMap::new();
    for note in notes {
        let finding = match &note.document.frontmatter.id {
            None => Some("missing note id"),
            Some(id)
                if first_by_id
                    .insert(id.clone(), note.relative.clone())
                    .is_some() =>
            {
                Some("duplicate note id")
            }
            Some(_) => None,
        };
        let Some(kind) = finding else { continue };
        let repaired = if fix {
            let id = uuid::Uuid::now_v7().to_string();
            let updated = if note.document.frontmatter.id.is_some() {
                replace_id(&note.source, &id)?
            } else {
                super::obsidian::inject_id(&note.source, &id)
            };
            super::write_atomic(&note.path, &updated)?;
            note.source = updated;
            note.document = mb_core::parse(&note.source);
            true
        } else {
            false
        };
        report(vault, kind, &note.relative, repaired, out, totals)?;
    }
    Ok(())
}

fn replace_id(source: &str, id: &str) -> Result<String, String> {
    let (frontmatter, _) = mb_core::frontmatter::split(source);
    let frontmatter = frontmatter.ok_or("cannot replace an id outside frontmatter")?;
    let opening_bytes = source.len() - source.strip_prefix("---").unwrap_or(source).len();
    let body_start = source
        .get(opening_bytes..)
        .and_then(|rest| rest.find('\n').map(|offset| opening_bytes + offset + 1))
        .ok_or("frontmatter opening fence has no newline")?;
    let body_end = body_start + frontmatter.len();
    let body = source.get(body_start..body_end).unwrap_or("");
    let mut offset = body_start;
    for line in body.split_inclusive('\n') {
        if line.starts_with("id:") {
            let end = offset + line.len();
            let newline = if line.ends_with("\r\n") { "\r\n" } else { "\n" };
            return Ok(format!(
                "{}id: {id}{newline}{}",
                source.get(..offset).unwrap_or(""),
                source.get(end..).unwrap_or("")
            ));
        }
        offset += line.len();
    }
    Err("parsed frontmatter id has no source line".to_string())
}

fn check_links_conflicts_and_emoji(
    vault: &mb_server::Vault,
    data_dir: &Path,
    notes: &[Note],
    out: &mut dyn Write,
    totals: &mut Totals,
) -> Result<(), String> {
    let known = known_names(notes);
    let trash_names = mb_server::trash::TrashStore::new(vault)
        .inspect()
        .map_err(|error| error.to_string())?
        .into_iter()
        .flat_map(|entry| {
            let stem = Path::new(&entry.path)
                .file_stem()
                .and_then(|stem| stem.to_str())
                .map(mb_core::names::fold_name);
            std::iter::once(mb_core::names::fold_name(&entry.path)).chain(stem)
        })
        .collect::<BTreeSet<_>>();
    let local = vault.root().join(".memberberry/emoji/packs");
    let shared = data_dir.join("emoji/packs");
    let custom = match mb_server::emoji::resolve(Some(&shared), &local) {
        Ok(entries) => entries
            .into_iter()
            .flat_map(|entry| std::iter::once(entry.shortcode).chain(entry.aliases))
            .collect::<BTreeSet<_>>(),
        Err(error) => {
            report(
                vault,
                "invalid emoji pack",
                &error.to_string(),
                false,
                out,
                totals,
            )?;
            BTreeSet::new()
        }
    };
    for note in notes {
        let facts = mb_core::extract(&note.document);
        for link in facts.links {
            if !link.target.is_empty() && !known.contains(&mb_core::names::fold_name(&link.target))
            {
                let kind = if trash_names.contains(&mb_core::names::fold_name(&link.target)) {
                    "wikilink points into trash"
                } else {
                    "broken wikilink"
                };
                report(
                    vault,
                    kind,
                    &format!("{} -> [[{}]]", note.relative, link.target),
                    false,
                    out,
                    totals,
                )?;
            }
        }
        let conflicts = mb_core::conflict::count(&note.document);
        if conflicts > 0 {
            report(
                vault,
                "unresolved conflict callout",
                &format!("{} ({conflicts})", note.relative),
                false,
                out,
                totals,
            )?;
        }
        for shortcode in facts.emoji {
            if mb_core::emoji::resolve(&shortcode).is_none() && !custom.contains(&shortcode) {
                report(
                    vault,
                    "missing emoji shortcode",
                    &format!("{} -> :{shortcode}:", note.relative),
                    false,
                    out,
                    totals,
                )?;
            }
        }
    }
    Ok(())
}

fn known_names(notes: &[Note]) -> BTreeSet<String> {
    notes
        .iter()
        .flat_map(|note| {
            let stem = Path::new(&note.relative)
                .file_stem()
                .and_then(|stem| stem.to_str())
                .map(mb_core::names::fold_name);
            std::iter::once(mb_core::names::fold_name(&note.relative))
                .chain(stem)
                .chain(
                    note.document
                        .frontmatter
                        .aliases
                        .iter()
                        .map(|alias| mb_core::names::fold_name(alias)),
                )
        })
        .collect()
}

fn check_sidecars(
    vault: &mb_server::Vault,
    notes: &[Note],
    fix: bool,
    out: &mut dyn Write,
    totals: &mut Totals,
) -> Result<(), String> {
    let mut expected = BTreeMap::new();
    for note in notes {
        expected.insert(sidecar_name(&note.relative), note.relative.as_str());
    }
    let trash = vault.notes_root().join(".trash");
    if let Ok(entries) = fs::read_dir(&trash) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|extension| extension == "md")
                && let Some(id) = path.file_stem().and_then(|stem| stem.to_str())
            {
                expected.insert(sidecar_name(&format!(".trash/{id}")), ".trash entry");
            }
        }
    }
    let root = vault.root().join(".memberberry/crdt");
    let actual = directory_files(&root, "bin")?;
    for (name, identity) in &expected {
        if actual.contains(name) {
            continue;
        }
        let repaired = if fix && *identity != ".trash entry" {
            let canonical = vault
                .canonical_note(identity)
                .map_err(|error| error.to_string())?;
            drop(
                mb_server::sync::NoteCoordinator::open(vault, &canonical)
                    .map_err(|error| error.to_string())?,
            );
            true
        } else {
            false
        };
        report(
            vault,
            "note without CRDT sidecar",
            identity,
            repaired,
            out,
            totals,
        )?;
    }
    for name in actual.difference(&expected.keys().cloned().collect()) {
        let path = root.join(name);
        let repaired = if fix {
            fs::remove_file(&path)
                .map_err(|error| format!("removing {}: {error}", path.display()))?;
            let marker = path.with_extension("last-write");
            if marker.exists() {
                fs::remove_file(&marker)
                    .map_err(|error| format!("removing {}: {error}", marker.display()))?;
            }
            true
        } else {
            false
        };
        report(
            vault,
            "CRDT sidecar without note",
            name,
            repaired,
            out,
            totals,
        )?;
    }
    Ok(())
}

fn sidecar_name(identity: &str) -> String {
    format!("{:x}.bin", Sha256::digest(identity.as_bytes()))
}

fn directory_files(root: &Path, extension: &str) -> Result<BTreeSet<String>, String> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeSet::new()),
        Err(error) => return Err(format!("reading {}: {error}", root.display())),
    };
    let mut files = BTreeSet::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("reading {}: {error}", root.display()))?;
        if entry
            .path()
            .extension()
            .is_some_and(|found| found == extension)
        {
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| "non-UTF-8 derived filename".to_string())?;
            files.insert(name);
        }
    }
    Ok(files)
}

fn check_index(
    vault: &mb_server::Vault,
    fix: bool,
    out: &mut dyn Write,
    totals: &mut Totals,
) -> Result<(), String> {
    let drift = index_drift(vault)?;
    if drift.is_empty() {
        return Ok(());
    }
    let repaired = if fix {
        let path = vault.root().join(".memberberry/index/graph.sqlite");
        let mut index = mb_index::Index::open(path).map_err(|error| error.to_string())?;
        mb_server::indexing::reconcile(vault, &mut index)?;
        true
    } else {
        false
    };
    for detail in drift {
        report(vault, "index drift", &detail, repaired, out, totals)?;
    }
    Ok(())
}

fn index_drift(vault: &mb_server::Vault) -> Result<Vec<String>, String> {
    let source = vault.root().join(".memberberry/index");
    if !source.join("graph.sqlite").is_file() {
        return Ok(vec!["index is missing".to_string()]);
    }
    let temporary = TemporaryDirectory::new("index-audit")?;
    copy_tree(&source, temporary.path())?;
    let mut index = mb_index::Index::open(temporary.path().join("graph.sqlite"))
        .map_err(|error| error.to_string())?;
    let present = vault
        .notes()
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter_map(|relative| {
            Stamp::of(&vault.notes_root().join(&relative)).map(|stamp| (relative, stamp))
        })
        .collect::<Vec<_>>();
    let plan = index
        .reconcile(&present)
        .map_err(|error| error.to_string())?;
    Ok(plan
        .stale
        .into_iter()
        .map(|path| format!("stale or absent {path}"))
        .chain(
            plan.removed
                .into_iter()
                .map(|path| format!("deleted {path}")),
        )
        .collect())
}

fn check_history(
    vault: &mb_server::Vault,
    notes: &[Note],
    fix: bool,
    out: &mut dyn Write,
    totals: &mut Totals,
) -> Result<(), String> {
    for note in notes {
        let history = mb_server::history::HistoryStore::new(vault.root(), &note.relative)
            .with_compression(vault.history_compression());
        let excess = history
            .retention_excess(SystemTime::now())
            .map_err(|error| error.to_string())?;
        if excess == 0 {
            continue;
        }
        let repaired = if fix {
            history
                .prune(SystemTime::now())
                .map_err(|error| error.to_string())?;
            true
        } else {
            false
        };
        report(
            vault,
            "oversized history",
            &format!("{} ({excess} excess snapshot(s))", note.relative),
            repaired,
            out,
            totals,
        )?;
    }
    Ok(())
}

fn check_access(
    vault: &mb_server::Vault,
    auth: &mb_auth::AuthDb,
    out: &mut dyn Write,
    totals: &mut Totals,
) -> Result<(), String> {
    let access = mb_server::AccessFile::load(vault.root()).map_err(|error| error.to_string())?;
    let users = access
        .policy()
        .members()
        .map(|(user, _)| user.to_string())
        .chain(
            access
                .policy()
                .rules()
                .flat_map(|rule| rule.grants.keys().map(ToString::to_string)),
        )
        .collect::<BTreeSet<_>>();
    for username in users {
        if auth
            .user_by_username(&username)
            .map_err(|error| error.to_string())?
            .is_none()
        {
            report(
                vault,
                "access.toml unknown user",
                &username,
                false,
                out,
                totals,
            )?;
        }
    }
    Ok(())
}

fn check_shares(
    vault: &mb_server::Vault,
    auth: &mb_auth::AuthDb,
    fix: bool,
    out: &mut dyn Write,
    totals: &mut Totals,
) -> Result<(), String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs() as i64;
    for share in auth
        .active_share_links(vault.slug().as_str(), now)
        .map_err(|error| error.to_string())?
    {
        if vault.resolve(&share.scope.note_path).is_ok() {
            continue;
        }
        let repaired = if fix {
            auth.revoke_share_link_by_id(share.scope.created_by, share.id)
                .map_err(|error| error.to_string())?;
            true
        } else {
            false
        };
        report(
            vault,
            "share link to deleted note",
            &share.scope.note_path,
            repaired,
            out,
            totals,
        )?;
    }
    Ok(())
}

fn check_media(
    vault: &mb_server::Vault,
    runtime: &tokio::runtime::Runtime,
    out: &mut dyn Write,
    totals: &mut Totals,
) -> Result<(), String> {
    let orphaned = runtime
        .block_on(mb_server::media::orphaned(vault))
        .map_err(|error| error.to_string())?;
    for path in orphaned {
        report(vault, "orphaned media", &path, false, out, totals)?;
    }
    Ok(())
}

fn report(
    vault: &mb_server::Vault,
    kind: &str,
    detail: &str,
    repaired: bool,
    out: &mut dyn Write,
    totals: &mut Totals,
) -> Result<(), String> {
    totals.finding(repaired);
    let status = if repaired { "fixed" } else { "found" };
    writeln!(out, "vault {}: {status} {kind}: {detail}", vault.slug())
        .map_err(io("writing doctor report"))
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|error| format!("creating {}: {error}", destination.display()))?;
    for entry in
        fs::read_dir(source).map_err(|error| format!("reading {}: {error}", source.display()))?
    {
        let entry = entry.map_err(|error| format!("reading {}: {error}", source.display()))?;
        let target = destination.join(entry.file_name());
        let kind = entry
            .file_type()
            .map_err(|error| format!("reading {}: {error}", entry.path().display()))?;
        if kind.is_symlink() {
            return Err(format!(
                "refusing symlink inside derived index: {}",
                entry.path().display()
            ));
        }
        if kind.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), &target)
                .map_err(|error| format!("copying {}: {error}", entry.path().display()))?;
        }
    }
    Ok(())
}

#[derive(Debug)]
struct TemporaryDirectory(PathBuf);

impl TemporaryDirectory {
    fn new(label: &str) -> Result<Self, String> {
        let path =
            std::env::temp_dir().join(format!("memberberry-{label}-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).map_err(|error| format!("creating {}: {error}", path.display()))?;
        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TemporaryDirectory {
    fn drop(&mut self) {
        drop(fs::remove_dir_all(&self.0));
    }
}

fn io(what: &str) -> impl Fn(std::io::Error) -> String + '_ {
    move |error| format!("{what}: {error}")
}
