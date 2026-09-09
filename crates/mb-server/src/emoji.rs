//! Server-owned custom emoji packs (`SPEC.md` §11.2).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use image::ImageFormat;
use serde::{Deserialize, Serialize};

/// One file carried by a pack upload request.
#[derive(Debug, Deserialize)]
pub struct UploadFile {
    /// A single image filename.
    pub name: String,
    /// Base64-encoded image bytes.
    pub content_base64: String,
}

/// JSON upload shape used by the management routes.
#[derive(Debug, Deserialize)]
pub struct Upload {
    /// The complete manifest to install.
    pub manifest: Manifest,
    /// Image files referenced by the manifest.
    pub files: Vec<UploadFile>,
}

/// A validated custom emoji entry from a pack manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    /// The name used between colons in Markdown.
    pub shortcode: String,
    /// The pack-relative image filename.
    pub file: String,
    /// Alternative names accepted by the picker.
    #[serde(default)]
    pub aliases: Vec<String>,
}

/// The JSON manifest stored beside a custom pack's image files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    /// Stable pack name and directory name.
    pub name: String,
    /// Manifest format version.
    pub version: u32,
    /// Entries in picker order.
    pub emoji: Vec<Entry>,
}

/// A pack summary exposed to its manager without returning image bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PackSummary {
    /// Stable pack name and directory name.
    pub name: String,
    /// Number of canonical emoji entries in the pack.
    pub emoji_count: usize,
}

/// One resolved entry, including the absolute file path used by the read route.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ResolvedEntry {
    /// The effective shortcode.
    pub shortcode: String,
    /// The resolved image filename.
    pub file: String,
    /// The pack that supplied this entry.
    pub pack: String,
    /// Alternative names that resolve to the same artwork.
    pub aliases: Vec<String>,
    #[serde(skip)]
    pub path: PathBuf,
}

/// Loads and validates one pack manifest from a directory.
pub fn load_pack(directory: &Path) -> Result<Manifest, Error> {
    let manifest_path = directory.join("pack.json");
    let text = std::fs::read_to_string(&manifest_path).map_err(|source| Error::Io {
        path: manifest_path.clone(),
        source,
    })?;
    let manifest: Manifest = serde_json::from_str(&text).map_err(|error| Error::Invalid {
        path: manifest_path,
        message: error.to_string(),
    })?;
    validate_manifest(&manifest, directory)?;
    Ok(manifest)
}

/// Resolves vault-local packs over shared packs, returning one picker entry per artwork.
pub fn resolve(shared_root: Option<&Path>, local_root: &Path) -> Result<Vec<ResolvedEntry>, Error> {
    let mut entries = match shared_root {
        Some(root) => load_root(root)?,
        None => BTreeMap::new(),
    };
    let local = load_root(local_root)?;
    let local_names = resolved_names(local.values());
    entries.retain(|shortcode, entry| {
        if local_names.contains(shortcode) {
            return false;
        }
        entry.aliases.retain(|alias| !local_names.contains(alias));
        true
    });
    entries.extend(local);
    Ok(entries.into_values().collect())
}

/// Lists valid packs in one management root in deterministic order.
pub fn list(root: &Path) -> Result<Vec<PackSummary>, Error> {
    let mut summaries = Vec::new();
    let directories = match std::fs::read_dir(root) {
        Ok(directories) => directories,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(summaries),
        Err(source) => {
            return Err(Error::Io {
                path: root.to_path_buf(),
                source,
            });
        }
    };
    for item in directories {
        let item = item.map_err(|source| Error::Io {
            path: root.to_path_buf(),
            source,
        })?;
        if !item.file_type().map(|kind| kind.is_dir()).unwrap_or(false)
            || item.file_name().to_string_lossy().starts_with('.')
        {
            continue;
        }
        let manifest = load_pack(&item.path())?;
        if item.file_name().to_str() != Some(manifest.name.as_str()) {
            return Err(Error::Invalid {
                path: item.path(),
                message: "emoji pack directory does not match its manifest".to_string(),
            });
        }
        summaries.push(PackSummary {
            name: manifest.name,
            emoji_count: manifest.emoji.len(),
        });
    }
    summaries.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(summaries)
}

/// Removes one validated pack from a management root.
pub fn remove(root: &Path, pack_name: &str) -> Result<(), Error> {
    if !valid_name(pack_name) {
        return Err(Error::Invalid {
            path: root.to_path_buf(),
            message: "invalid emoji pack name".to_string(),
        });
    }
    let path = root.join(pack_name);
    std::fs::remove_dir_all(&path).map_err(|source| Error::Io { path, source })
}

/// Copies referenced shared packs into the vault-local pack directory.
///
/// Existing local packs are left untouched: local content is the more specific layer and may
/// intentionally override a shared pack. The copy is staged under the destination root so a
/// failed file copy never leaves a pack that can be partially resolved.
pub fn materialize(shared_root: Option<&Path>, vault: &crate::Vault) -> Result<usize, Error> {
    let Some(shared_root) = shared_root else {
        return Ok(0);
    };
    let local_root = vault
        .root()
        .join(".memberberry")
        .join("emoji")
        .join("packs");
    let local_entries = resolve(None, &local_root)?;
    let local_names = resolved_names(local_entries.iter());
    let effective_entries = resolve(Some(shared_root), &local_root)?;
    let mut referenced = std::collections::BTreeSet::new();
    for note in vault.notes().map_err(|source| Error::Io {
        path: vault.root().to_path_buf(),
        source: std::io::Error::other(source.to_string()),
    })? {
        let path = vault.resolve(&note).map_err(|source| Error::Io {
            path: vault.root().join(&note),
            source: std::io::Error::other(source.to_string()),
        })?;
        let source = std::fs::read_to_string(&path).map_err(|source| Error::Io {
            path: path.clone(),
            source,
        })?;
        for shortcode in mb_core::extract(&mb_core::parse(&source)).emoji {
            if local_entries.iter().any(|entry| {
                entry.shortcode == shortcode
                    || entry.aliases.iter().any(|alias| alias == &shortcode)
            }) {
                continue;
            }
            if let Some(entry) = effective_entries
                .iter()
                .find(|entry| entry.shortcode == shortcode)
                .or_else(|| {
                    effective_entries
                        .iter()
                        .find(|entry| entry.aliases.iter().any(|alias| alias == &shortcode))
                })
            {
                referenced.insert(entry.pack.clone());
            }
        }
    }
    if referenced.is_empty() {
        return Ok(0);
    }
    std::fs::create_dir_all(&local_root).map_err(|source| Error::Io {
        path: local_root.clone(),
        source,
    })?;
    let mut copied = 0;
    for pack in referenced {
        let source = shared_root.join(&pack);
        let destination_name = available_materialized_name(&local_root, &pack)?;
        let destination = local_root.join(&destination_name);
        let temporary = local_root.join(format!(
            ".{destination_name}.materialize-{}",
            std::process::id()
        ));
        if temporary.exists() {
            return Err(Error::Conflict(temporary));
        }
        std::fs::create_dir(&temporary).map_err(|source| Error::Io {
            path: temporary.clone(),
            source,
        })?;
        let result = (|| {
            let mut manifest = load_pack(&source)?;
            manifest.emoji.retain_mut(|entry| {
                if local_names.contains(&entry.shortcode) {
                    return false;
                }
                entry.aliases.retain(|alias| !local_names.contains(alias));
                true
            });
            manifest.name.clone_from(&destination_name);
            let manifest_bytes = serde_json::to_vec(&manifest).map_err(|error| Error::Invalid {
                path: temporary.join("pack.json"),
                message: error.to_string(),
            })?;
            std::fs::write(temporary.join("pack.json"), manifest_bytes).map_err(|source| {
                Error::Io {
                    path: temporary.join("pack.json"),
                    source,
                }
            })?;
            let mut copied_files = std::collections::BTreeSet::new();
            for entry in manifest.emoji {
                if !copied_files.insert(entry.file.clone()) {
                    continue;
                }
                let source_file = source.join(&entry.file);
                let destination_file = temporary.join(&entry.file);
                std::fs::copy(&source_file, &destination_file).map_err(|source| Error::Io {
                    path: destination_file,
                    source,
                })?;
            }
            load_pack(&temporary)?;
            std::fs::rename(&temporary, &destination).map_err(|source| Error::Io {
                path: destination.clone(),
                source,
            })
        })();
        if result.is_err() {
            let _ = std::fs::remove_dir_all(&temporary);
        } else {
            copied += 1;
        }
        result?;
    }
    Ok(copied)
}

fn available_materialized_name(root: &Path, pack: &str) -> Result<String, Error> {
    if !root.join(pack).exists() {
        return Ok(pack.to_string());
    }
    for suffix in 1_u64..=u64::MAX {
        let candidate = format!("{pack}-materialized-{suffix}");
        if !root.join(&candidate).exists() {
            return Ok(candidate);
        }
    }
    Err(Error::Invalid {
        path: root.to_path_buf(),
        message: "no available materialized emoji pack name".to_string(),
    })
}

/// Installs one validated pack atomically and refuses an existing pack.
pub fn install(root: &Path, pack_name: &str, upload: Upload) -> Result<(), Error> {
    if upload.manifest.name != pack_name || !valid_name(pack_name) {
        return Err(Error::Invalid {
            path: root.to_path_buf(),
            message: "pack name does not match its manifest".to_string(),
        });
    }
    let mut files = BTreeMap::new();
    for file in upload.files {
        if !valid_file_name(&file.name) {
            return Err(Error::Invalid {
                path: root.to_path_buf(),
                message: "invalid emoji filename".to_string(),
            });
        }
        let bytes = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            file.content_base64,
        )
        .map_err(|_| Error::Invalid {
            path: root.to_path_buf(),
            message: "invalid base64 image".to_string(),
        })?;
        if bytes.is_empty() || bytes.len() > 4 * 1024 * 1024 {
            return Err(Error::Invalid {
                path: root.to_path_buf(),
                message: "emoji image is empty or too large".to_string(),
            });
        }
        if !image_matches_extension(&file.name, &bytes) {
            return Err(Error::Invalid {
                path: root.to_path_buf(),
                message: "emoji bytes do not match their extension".to_string(),
            });
        }
        if files.insert(file.name, bytes).is_some() {
            return Err(Error::Invalid {
                path: root.to_path_buf(),
                message: "duplicate emoji filename".to_string(),
            });
        }
    }
    for entry in &upload.manifest.emoji {
        if !files.contains_key(&entry.file) {
            return Err(Error::Invalid {
                path: root.to_path_buf(),
                message: "manifest references an omitted file".to_string(),
            });
        }
    }
    let existing_names = resolved_names(load_root(root)?.values());
    std::fs::create_dir_all(root).map_err(|source| Error::Io {
        path: root.to_path_buf(),
        source,
    })?;
    let final_directory = root.join(pack_name);
    if final_directory.exists() {
        return Err(Error::Conflict(final_directory));
    }
    let temporary = root.join(format!(".{pack_name}.upload-{}", std::process::id()));
    if temporary.exists() {
        return Err(Error::Conflict(temporary));
    }
    std::fs::create_dir(&temporary).map_err(|source| Error::Io {
        path: temporary.clone(),
        source,
    })?;
    let result = (|| {
        let manifest_path = temporary.join("pack.json");
        let manifest = serde_json::to_vec(&upload.manifest).map_err(|error| Error::Invalid {
            path: manifest_path.clone(),
            message: error.to_string(),
        })?;
        std::fs::write(&manifest_path, manifest).map_err(|source| Error::Io {
            path: manifest_path,
            source,
        })?;
        for (name, bytes) in files {
            let path = temporary.join(name);
            std::fs::write(&path, bytes).map_err(|source| Error::Io { path, source })?;
        }
        let manifest = load_pack(&temporary)?;
        if manifest_names(&manifest).any(|name| existing_names.contains(name)) {
            return Err(Error::Conflict(final_directory.clone()));
        }
        std::fs::rename(&temporary, &final_directory).map_err(|source| Error::Io {
            path: final_directory.clone(),
            source,
        })
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&temporary);
    }
    result
}

fn load_root(root: &Path) -> Result<BTreeMap<String, ResolvedEntry>, Error> {
    let directories = match std::fs::read_dir(root) {
        Ok(directories) => directories,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(source) => {
            return Err(Error::Io {
                path: root.to_path_buf(),
                source,
            });
        }
    };
    let mut pack_directories = Vec::new();
    for item in directories {
        let item = item.map_err(|source| Error::Io {
            path: root.to_path_buf(),
            source,
        })?;
        if !item.file_type().map(|kind| kind.is_dir()).unwrap_or(false)
            || item.file_name().to_string_lossy().starts_with('.')
        {
            continue;
        }
        pack_directories.push(item.path());
    }
    pack_directories.sort();
    let mut entries = BTreeMap::new();
    let mut names = std::collections::BTreeSet::new();
    for directory in pack_directories {
        let manifest = load_pack(&directory)?;
        if directory.file_name().and_then(|name| name.to_str()) != Some(&manifest.name) {
            return Err(Error::Invalid {
                path: directory,
                message: "pack directory does not match its manifest".to_string(),
            });
        }
        for entry in manifest.emoji {
            if std::iter::once(&entry.shortcode)
                .chain(entry.aliases.iter())
                .any(|name| !names.insert(name.clone()))
            {
                return Err(Error::Invalid {
                    path: root.to_path_buf(),
                    message: "duplicate emoji shortcode or alias across packs".to_string(),
                });
            }
            let resolved = ResolvedEntry {
                shortcode: entry.shortcode.clone(),
                file: entry.file,
                pack: manifest.name.clone(),
                aliases: entry.aliases,
                path: directory.clone(),
            };
            entries.insert(entry.shortcode, resolved);
        }
    }
    Ok(entries)
}

fn validate_manifest(manifest: &Manifest, directory: &Path) -> Result<(), Error> {
    if manifest.version != 1 || !valid_name(&manifest.name) {
        return Err(Error::Invalid {
            path: directory.to_path_buf(),
            message: "unsupported pack manifest".to_string(),
        });
    }
    let mut names = std::collections::BTreeSet::new();
    for entry in &manifest.emoji {
        if !valid_name(&entry.shortcode) || !valid_file_name(&entry.file) {
            return Err(Error::Invalid {
                path: directory.to_path_buf(),
                message: "invalid emoji entry".to_string(),
            });
        }
        if !names.insert(entry.shortcode.clone()) {
            return Err(Error::Invalid {
                path: directory.to_path_buf(),
                message: "duplicate emoji shortcode".to_string(),
            });
        }
        for alias in &entry.aliases {
            if !valid_name(alias) {
                return Err(Error::Invalid {
                    path: directory.to_path_buf(),
                    message: "invalid emoji alias".to_string(),
                });
            }
            if !names.insert(alias.clone()) {
                return Err(Error::Invalid {
                    path: directory.to_path_buf(),
                    message: "duplicate emoji shortcode or alias".to_string(),
                });
            }
        }
        let file = directory.join(&entry.file);
        let Ok(pack_root) = directory.canonicalize() else {
            return Err(Error::Invalid {
                path: directory.to_path_buf(),
                message: "emoji pack directory is unavailable".to_string(),
            });
        };
        let Ok(canonical_file) = file.canonicalize() else {
            return Err(Error::Invalid {
                path: file,
                message: "emoji file is missing".to_string(),
            });
        };
        if !canonical_file.starts_with(&pack_root) || !canonical_file.is_file() {
            return Err(Error::Invalid {
                path: file,
                message: "emoji file escapes its pack or is missing".to_string(),
            });
        }
    }
    Ok(())
}

fn resolved_names<'a>(
    entries: impl Iterator<Item = &'a ResolvedEntry>,
) -> std::collections::BTreeSet<String> {
    entries
        .flat_map(|entry| std::iter::once(&entry.shortcode).chain(entry.aliases.iter()))
        .cloned()
        .collect()
}

fn manifest_names(manifest: &Manifest) -> impl Iterator<Item = &String> {
    manifest
        .emoji
        .iter()
        .flat_map(|entry| std::iter::once(&entry.shortcode).chain(entry.aliases.iter()))
}

fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'+' | b'-')
        })
}

fn valid_file_name(value: &str) -> bool {
    Path::new(value).components().count() == 1
        && matches!(
            Path::new(value)
                .extension()
                .and_then(|extension| extension.to_str()),
            Some("png" | "gif" | "jpg" | "jpeg" | "webp")
        )
}

fn image_matches_extension(name: &str, bytes: &[u8]) -> bool {
    let Ok(format) = image::guess_format(bytes) else {
        return false;
    };
    match Path::new(name)
        .extension()
        .and_then(|extension| extension.to_str())
    {
        Some("png") => format == ImageFormat::Png,
        Some("gif") => format == ImageFormat::Gif,
        Some("jpg" | "jpeg") => format == ImageFormat::Jpeg,
        Some("webp") => format == ImageFormat::WebP,
        _ => false,
    }
}

/// Errors loading a custom pack. Invalid packs fail closed and never become picker entries.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("reading {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("invalid emoji pack at {path}: {message}")]
    Invalid { path: PathBuf, message: String },
    #[error("emoji pack already exists: {0}")]
    Conflict(PathBuf),
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::{Error, PackSummary, materialize, remove, resolve};
    use crate::Vault;
    use crate::vault::Slug;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn local_pack_overrides_the_complete_shared_entry() {
        let root = tempdir().expect("root");
        let shared = root.path().join("shared");
        let local = root.path().join("local");
        fs::create_dir_all(shared.join("one")).expect("shared");
        fs::create_dir_all(local.join("two")).expect("local");
        fs::write(shared.join("one/a.png"), b"shared").expect("shared image");
        fs::write(local.join("two/b.png"), b"local").expect("local image");
        fs::write(shared.join("one/pack.json"), r#"{"name":"one","version":1,"emoji":[{"shortcode":"party","file":"a.png","aliases":["parrot"]}]}"#).expect("shared manifest");
        fs::write(
            local.join("two/pack.json"),
            r#"{"name":"two","version":1,"emoji":[{"shortcode":"party","file":"b.png","aliases":["celebrate"]}]}"#,
        )
        .expect("local manifest");
        let entries = resolve(Some(&shared), &local).expect("resolve");
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries
                .iter()
                .find(|entry| entry.shortcode == "party")
                .expect("party")
                .pack,
            "two"
        );
        assert!(entries.iter().all(|entry| entry.pack != "one"));
        assert_eq!(entries.first().expect("local entry").aliases, ["celebrate"]);
    }

    #[test]
    fn local_aliases_override_shared_names_without_hiding_unrelated_names() {
        let root = tempdir().expect("root");
        let shared = root.path().join("shared");
        let local = root.path().join("local");
        fs::create_dir_all(shared.join("shared-pack")).expect("shared");
        fs::create_dir_all(local.join("local-pack")).expect("local");
        fs::write(shared.join("shared-pack/a.png"), b"shared").expect("shared image");
        fs::write(local.join("local-pack/b.png"), b"local").expect("local image");
        fs::write(
            shared.join("shared-pack/pack.json"),
            r#"{"name":"shared-pack","version":1,"emoji":[{"shortcode":"party","file":"a.png","aliases":["parrot","bird"]}]}"#,
        )
        .expect("shared manifest");
        fs::write(
            local.join("local-pack/pack.json"),
            r#"{"name":"local-pack","version":1,"emoji":[{"shortcode":"local","file":"b.png","aliases":["parrot"]}]}"#,
        )
        .expect("local manifest");

        let entries = resolve(Some(&shared), &local).expect("resolve");
        let shared_entry = entries
            .iter()
            .find(|entry| entry.shortcode == "party")
            .expect("shared entry remains reachable");
        assert_eq!(shared_entry.aliases, ["bird"]);
        assert_eq!(
            entries
                .iter()
                .find(|entry| entry.shortcode == "local")
                .expect("local entry")
                .aliases,
            ["parrot"]
        );
    }

    #[test]
    fn list_and_remove_are_deterministic_and_contained() {
        let root = tempdir().expect("root");
        fs::create_dir_all(root.path().join("z/")).expect("z");
        fs::create_dir_all(root.path().join("a/")).expect("a");
        fs::create_dir_all(root.path().join(".upload-in-progress/")).expect("staging");
        fs::write(
            root.path().join("z/pack.json"),
            r#"{"name":"z","version":1,"emoji":[]}"#,
        )
        .expect("z manifest");
        fs::write(
            root.path().join("a/pack.json"),
            r#"{"name":"a","version":1,"emoji":[]}"#,
        )
        .expect("a manifest");
        assert_eq!(
            super::list(root.path()).expect("list"),
            vec![
                PackSummary {
                    name: "a".to_string(),
                    emoji_count: 0
                },
                PackSummary {
                    name: "z".to_string(),
                    emoji_count: 0
                },
            ]
        );
        remove(root.path(), "a").expect("remove");
        assert!(!root.path().join("a").exists());
        assert!(matches!(
            remove(root.path(), "../outside"),
            Err(Error::Invalid { .. })
        ));
    }

    #[test]
    fn materialize_copies_only_referenced_shared_packs_and_is_idempotent() {
        let root = tempdir().expect("root");
        let shared = root.path().join("shared");
        let vault_root = root.path().join("vault");
        fs::create_dir_all(shared.join("party")).expect("shared pack");
        fs::create_dir_all(shared.join("unused")).expect("unused pack");
        fs::create_dir_all(&vault_root).expect("vault");
        let image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
        fs::write(
            shared.join("party/berry.png"),
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, image)
                .expect("image"),
        )
        .expect("image bytes");
        fs::write(
            shared.join("party/pack.json"),
            r#"{"name":"party","version":1,"emoji":[{"shortcode":"berry","file":"berry.png","aliases":["fruit"]}]}"#,
        )
        .expect("party manifest");
        fs::write(
            shared.join("unused/pack.json"),
            r#"{"name":"unused","version":1,"emoji":[]}"#,
        )
        .expect("unused manifest");
        fs::write(vault_root.join("Note.md"), "# Note\n\n:fruit:\n").expect("note");
        let vault = Vault::open(Slug::parse("v").expect("slug"), "V", &vault_root).expect("vault");

        assert_eq!(materialize(None, &vault).expect("no shared root"), 0);
        assert_eq!(materialize(Some(&shared), &vault).expect("materialize"), 1);
        assert!(
            vault_root
                .join(".memberberry/emoji/packs/party/berry.png")
                .is_file()
        );
        assert!(!vault_root.join(".memberberry/emoji/packs/unused").exists());
        assert_eq!(materialize(Some(&shared), &vault).expect("repeat"), 0);

        let empty_root = root.path().join("empty-vault");
        fs::create_dir_all(&empty_root).expect("empty vault");
        let empty_vault = Vault::open(Slug::parse("empty").expect("slug"), "Empty", &empty_root)
            .expect("empty vault");
        assert_eq!(
            materialize(Some(&shared), &empty_vault).expect("no references"),
            0
        );
    }

    #[test]
    fn materialize_rejects_a_referenced_pack_with_a_missing_image() {
        let root = tempdir().expect("root");
        let shared = root.path().join("shared");
        let vault_root = root.path().join("vault");
        fs::create_dir_all(shared.join("broken")).expect("shared pack");
        fs::create_dir_all(&vault_root).expect("vault");
        fs::write(
            shared.join("broken/pack.json"),
            r#"{"name":"broken","version":1,"emoji":[{"shortcode":"missing","file":"missing.png"}]}"#,
        )
        .expect("broken manifest");
        fs::write(vault_root.join("Note.md"), "# Note\n\n:missing:\n").expect("note");
        let vault = Vault::open(Slug::parse("broken").expect("slug"), "Broken", &vault_root)
            .expect("vault");

        assert!(materialize(Some(&shared), &vault).is_err());
        assert!(!vault_root.join(".memberberry/emoji/packs/broken").exists());
    }

    #[test]
    fn materialize_preserves_local_overrides_from_a_partially_shadowed_shared_pack() {
        let root = tempdir().expect("root");
        let shared = root.path().join("shared");
        let vault_root = root.path().join("vault");
        let local = vault_root.join(".memberberry/emoji/packs/party");
        fs::create_dir_all(shared.join("party")).expect("shared pack");
        fs::create_dir_all(&local).expect("local pack");
        fs::write(shared.join("party/berry.png"), b"berry").expect("berry image");
        fs::write(shared.join("party/party.png"), b"shared party").expect("party image");
        fs::write(
            shared.join("party/pack.json"),
            r#"{"name":"party","version":1,"emoji":[{"shortcode":"berry","file":"berry.png"},{"shortcode":"party","file":"party.png","aliases":["celebrate"]}]}"#,
        )
        .expect("shared manifest");
        fs::write(local.join("party.png"), b"local party").expect("local image");
        fs::write(
            local.join("pack.json"),
            r#"{"name":"party","version":1,"emoji":[{"shortcode":"party","file":"party.png","aliases":["celebrate"]}]}"#,
        )
        .expect("local manifest");
        fs::write(vault_root.join("Note.md"), "# Note\n\n:berry:\n").expect("note");
        let vault = Vault::open(Slug::parse("v").expect("slug"), "V", &vault_root).expect("vault");

        assert_eq!(materialize(Some(&shared), &vault).expect("materialize"), 1);
        let entries = resolve(None, &vault_root.join(".memberberry/emoji/packs"))
            .expect("materialized root remains valid");
        assert_eq!(entries.len(), 2);
        assert_eq!(
            entries
                .iter()
                .find(|entry| entry.shortcode == "party")
                .expect("party")
                .pack,
            "party"
        );
        assert!(entries.iter().any(|entry| entry.shortcode == "berry"));
        assert!(
            vault_root
                .join(".memberberry/emoji/packs/party-materialized-1")
                .is_dir()
        );
    }

    #[test]
    fn traversal_and_missing_files_are_rejected() {
        let root = tempdir().expect("root");
        fs::create_dir_all(root.path().join("bad")).expect("pack");
        fs::write(
            root.path().join("bad/pack.json"),
            r#"{"name":"bad","version":1,"emoji":[{"shortcode":"x","file":"../secret.png"}]}"#,
        )
        .expect("manifest");
        assert!(matches!(
            resolve(None, root.path()),
            Err(Error::Invalid { .. })
        ));
    }

    #[test]
    fn duplicate_shortcodes_and_aliases_are_rejected() {
        let root = tempdir().expect("root");
        let pack = root.path().join("pack");
        fs::create_dir_all(&pack).expect("pack");
        fs::write(pack.join("a.png"), b"not an image").expect("image");
        fs::write(
            pack.join("pack.json"),
            r#"{"name":"pack","version":1,"emoji":[{"shortcode":"party","file":"a.png","aliases":["parrot"]},{"shortcode":"parrot","file":"a.png"}]}"#,
        )
        .expect("manifest");
        assert!(matches!(
            super::load_pack(&pack),
            Err(Error::Invalid { .. })
        ));
    }

    #[test]
    fn unsupported_manifest_image_extensions_are_rejected() {
        let root = tempdir().expect("root");
        let pack = root.path().join("pack");
        fs::create_dir_all(&pack).expect("pack");
        fs::write(pack.join("active.svg"), "<svg/>").expect("image");
        fs::write(
            pack.join("pack.json"),
            r#"{"name":"pack","version":1,"emoji":[{"shortcode":"active","file":"active.svg"}]}"#,
        )
        .expect("manifest");
        assert!(matches!(
            super::load_pack(&pack),
            Err(Error::Invalid { .. })
        ));
    }

    #[test]
    fn install_writes_a_valid_pack_atomically_and_refuses_replacement() {
        let root = tempdir().expect("root");
        let upload = || {
            super::Upload {
            manifest: super::Manifest {
                name: "party".to_string(),
                version: 1,
                emoji: vec![super::Entry {
                    shortcode: "berry".to_string(),
                    file: "berry.png".to_string(),
                    aliases: vec!["fruit".to_string()],
                }],
            },
            files: vec![super::UploadFile {
                name: "berry.png".to_string(),
                content_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=".to_string(),
            }],
        }
        };

        super::install(root.path(), "party", upload()).expect("install");
        assert!(root.path().join("party/pack.json").is_file());
        assert!(root.path().join("party/berry.png").is_file());
        assert!(matches!(
            super::install(root.path(), "party", upload()),
            Err(Error::Conflict(_))
        ));
    }

    #[test]
    fn install_rejects_names_already_used_by_another_pack() {
        let root = tempdir().expect("root");
        let upload = |name: &str, shortcode: &str, aliases: Vec<String>| {
            super::Upload {
            manifest: super::Manifest {
                name: name.to_string(),
                version: 1,
                emoji: vec![super::Entry {
                    shortcode: shortcode.to_string(),
                    file: "berry.png".to_string(),
                    aliases,
                }],
            },
            files: vec![super::UploadFile {
                name: "berry.png".to_string(),
                content_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=".to_string(),
            }],
        }
        };

        super::install(
            root.path(),
            "first",
            upload("first", "berry", vec!["fruit".to_string()]),
        )
        .expect("first install");
        assert!(matches!(
            super::install(
                root.path(),
                "second",
                upload("second", "other", vec!["fruit".to_string()]),
            ),
            Err(Error::Conflict(_))
        ));
        assert!(!root.path().join("second").exists());
        assert_eq!(
            resolve(None, root.path())
                .expect("first pack remains")
                .len(),
            1
        );
    }

    #[test]
    fn install_rejects_duplicate_uploaded_filenames() {
        let root = tempdir().expect("root");
        let file = || {
            super::UploadFile {
            name: "berry.png".to_string(),
            content_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=".to_string(),
        }
        };
        let upload = super::Upload {
            manifest: super::Manifest {
                name: "party".to_string(),
                version: 1,
                emoji: vec![super::Entry {
                    shortcode: "berry".to_string(),
                    file: "berry.png".to_string(),
                    aliases: Vec::new(),
                }],
            },
            files: vec![file(), file()],
        };

        assert!(matches!(
            super::install(root.path(), "party", upload),
            Err(Error::Invalid { .. })
        ));
        assert!(!root.path().join("party").exists());
    }
}
