//! Local content-addressed media storage (SPEC §12.1–§12.2).

use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use bytes::Bytes;
use futures_util::TryStreamExt;
use image::{ImageFormat, ImageReader, Limits};
use object_store::ObjectStore;
use object_store::aws::AmazonS3Builder;
use object_store::path::Path as ObjectPath;
use sha2::{Digest, Sha256};

use crate::{Error, MediaBackendConfig, Vault};

/// One configured media object store.
#[derive(Debug)]
pub enum Store<'a> {
    Local(LocalStore<'a>),
    S3(Arc<dyn ObjectStore>),
}

impl<'a> Store<'a> {
    /// Builds the backend configured for this vault.
    pub fn new(vault: &'a Vault) -> Result<Self, Error> {
        match vault.media_backend() {
            MediaBackendConfig::Local => Ok(Self::Local(LocalStore::new(vault))),
            MediaBackendConfig::S3 {
                bucket,
                region,
                endpoint,
                access_key_id,
                secret_access_key,
                allow_http,
                virtual_hosted_style,
            } => {
                let mut builder = AmazonS3Builder::new()
                    .with_bucket_name(bucket)
                    .with_region(region)
                    .with_access_key_id(access_key_id)
                    .with_secret_access_key(secret_access_key)
                    .with_virtual_hosted_style_request(*virtual_hosted_style)
                    .with_allow_http(*allow_http);
                if let Some(endpoint) = endpoint {
                    builder = builder.with_endpoint(endpoint);
                }
                builder
                    .build()
                    .map(|store| Self::S3(Arc::new(store)))
                    .map_err(|error| Error::MediaStore(error.to_string()))
            }
        }
    }

    /// Stores bytes under their content address and returns the Markdown-safe relative path.
    pub async fn put(&self, bytes: &[u8], extension: &str) -> Result<String, Error> {
        let relative = LocalStore::object_path(bytes, extension).ok_or(Error::NotFound)?;
        match self {
            Self::Local(store) => store.put(bytes, extension),
            Self::S3(store) => {
                let path = ObjectPath::parse(&relative)
                    .map_err(|error| Error::MediaStore(error.to_string()))?;
                store
                    .put(&path, Bytes::copy_from_slice(bytes).into())
                    .await
                    .map_err(|error| Error::MediaStore(error.to_string()))?;
                Ok(relative)
            }
        }
    }

    /// Reads one contained object from the configured backend.
    pub async fn get(&self, relative: &str) -> Result<Vec<u8>, Error> {
        validate_object_path(relative)?;
        match self {
            Self::Local(store) => store.get(relative).map(|(_, bytes)| bytes),
            Self::S3(store) => {
                let path = ObjectPath::parse(relative)
                    .map_err(|error| Error::MediaStore(error.to_string()))?;
                store
                    .get(&path)
                    .await
                    .map_err(|_| Error::NotFound)?
                    .bytes()
                    .await
                    .map(Vec::from)
                    .map_err(|_| Error::NotFound)
            }
        }
    }

    /// Lists every content-addressed object path in this backend.
    pub async fn list(&self) -> Result<Vec<String>, Error> {
        match self {
            Self::Local(store) => store.list(),
            Self::S3(store) => {
                store
                    .list(Some(&ObjectPath::from("media")))
                    .map_ok(|object| object.location.to_string())
                    .map_err(|error| Error::MediaStore(error.to_string()))
                    .try_collect()
                    .await
            }
        }
    }
}

/// Every media path referenced by the vault's Markdown, sorted and deduplicated.
pub fn references(vault: &Vault) -> Result<Vec<String>, Error> {
    let mut references = Vec::new();
    for note in vault.notes()? {
        let path = vault.resolve(&note)?;
        let source =
            std::fs::read_to_string(&path).map_err(|source| Error::MediaIo { path, source })?;
        references.extend(mb_core::extract(&mb_core::parse(&source)).media);
    }
    references.sort();
    references.dedup();
    let retained = original_manifest(vault)?;
    let originals: Vec<String> = references
        .iter()
        .filter_map(|path| retained.get(path).cloned())
        .collect();
    references.extend(originals);
    references.sort();
    references.dedup();
    Ok(references)
}

/// Records the retained original for a downscaled display object.
pub fn retain_original(vault: &Vault, display: &str, original: &str) -> Result<(), Error> {
    validate_object_path(display)?;
    validate_object_path(original)?;
    let mut manifest = original_manifest(vault)?;
    manifest.insert(display.to_string(), original.to_string());
    let directory = vault.root().join(".memberberry");
    std::fs::create_dir_all(&directory).map_err(|source| Error::MediaIo {
        path: directory.clone(),
        source,
    })?;
    let path = directory.join("media-originals.json");
    let temporary = directory.join("media-originals.writing");
    let bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| Error::MediaStore(error.to_string()))?;
    std::fs::write(&temporary, bytes).map_err(|source| Error::MediaIo {
        path: temporary.clone(),
        source,
    })?;
    std::fs::rename(&temporary, &path).map_err(|source| Error::MediaIo { path, source })
}

fn original_manifest(vault: &Vault) -> Result<BTreeMap<String, String>, Error> {
    let path = vault.root().join(".memberberry/media-originals.json");
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(source) => return Err(Error::MediaIo { path, source }),
    };
    let manifest: BTreeMap<String, String> = serde_json::from_slice(&bytes)
        .map_err(|error| Error::MediaStore(format!("invalid media originals manifest: {error}")))?;
    if manifest.iter().any(|(display, original)| {
        validate_object_path(display).is_err() || validate_object_path(original).is_err()
    }) {
        return Err(Error::MediaStore(
            "invalid path in media originals manifest".to_string(),
        ));
    }
    Ok(manifest)
}

/// Resolves a display object to its retained original, if it has one.
pub fn original_for(vault: &Vault, display: &str) -> Result<Option<String>, Error> {
    validate_object_path(display)?;
    Ok(original_manifest(vault)?.get(display).cloned())
}

/// Downloads every referenced remote object into `<vault>/media` (`SPEC.md` §12.3).
pub async fn materialize(vault: &Vault) -> Result<usize, Error> {
    if matches!(vault.media_backend(), MediaBackendConfig::Local) {
        return Ok(0);
    }
    let store = Store::new(vault)?;
    let local = LocalStore::new(vault);
    let mut written = 0;
    for reference in references(vault)? {
        let bytes = store.get(&reference).await?;
        if local.write_exact(&reference, &bytes)? {
            written += 1;
        }
    }
    Ok(written)
}

/// Media objects no Markdown note references, across the configured backend.
pub async fn orphaned(vault: &Vault) -> Result<Vec<String>, Error> {
    let referenced = references(vault)?;
    let mut orphaned: Vec<String> = Store::new(vault)?
        .list()
        .await?
        .into_iter()
        .filter(|path| !referenced.contains(path))
        .collect();
    orphaned.sort();
    Ok(orphaned)
}

/// Deletes unreferenced media after the uploader-only access window has closed.
pub async fn prune_orphaned(vault: &Vault, protected: &[String]) -> Result<Vec<String>, Error> {
    let referenced = references(vault)?;
    let protected: std::collections::HashSet<&str> = protected.iter().map(String::as_str).collect();
    let candidates: Vec<String> = Store::new(vault)?
        .list()
        .await?
        .into_iter()
        .filter(|path| !referenced.contains(path) && !protected.contains(path.as_str()))
        .collect();
    let store = Store::new(vault)?;
    for path in &candidates {
        match &store {
            Store::Local(local) => local.remove(path)?,
            Store::S3(remote) => {
                let path = ObjectPath::parse(path)
                    .map_err(|error| Error::MediaStore(error.to_string()))?;
                remote
                    .delete(&path)
                    .await
                    .map_err(|error| Error::MediaStore(error.to_string()))?;
            }
        }
    }
    if let Store::Local(local) = &store {
        local.prune_empty_directories()?;
    }
    Ok(candidates)
}

/// Produces a bounded WebP thumbnail without trusting dimensions from the encoded image.
pub fn thumbnail(bytes: &[u8], maximum: u32) -> Result<Vec<u8>, Error> {
    let maximum = maximum.clamp(64, 2048);
    let format =
        image::guess_format(bytes).map_err(|error| Error::MediaStore(error.to_string()))?;
    let mut reader = ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(20_000);
    limits.max_image_height = Some(20_000);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|error| Error::MediaStore(error.to_string()))?;
    let thumbnail = image.thumbnail(maximum, maximum);
    let mut out = std::io::Cursor::new(Vec::new());
    thumbnail
        .write_to(&mut out, ImageFormat::WebP)
        .map_err(|error| Error::MediaStore(error.to_string()))?;
    Ok(out.into_inner())
}

fn validate_object_path(relative: &str) -> Result<(), Error> {
    let mut components = Path::new(relative).components();
    let valid = components
        .next()
        .is_some_and(|part| part.as_os_str() == OsStr::new("media"))
        && components
            .next()
            .is_some_and(|part| valid_fanout(part.as_os_str()))
        && components
            .next()
            .is_some_and(|part| valid_fanout(part.as_os_str()))
        && components
            .next()
            .is_some_and(|part| valid_object_name(part.as_os_str(), relative))
        && components.next().is_none();
    if valid { Ok(()) } else { Err(Error::NotFound) }
}

fn valid_fanout(value: &OsStr) -> bool {
    value
        .to_str()
        .is_some_and(|value| value.len() == 2 && value.bytes().all(is_lower_hex))
}

fn valid_object_name(value: &OsStr, relative: &str) -> bool {
    let Some(value) = value.to_str() else {
        return false;
    };
    let Some((hash, extension)) = value.rsplit_once('.') else {
        return false;
    };
    let mut path = relative.split('/');
    let fanout_matches = path.nth(1).is_some_and(|first| hash.starts_with(first))
        && path
            .next()
            .is_some_and(|second| hash.get(2..4) == Some(second));
    hash.len() == 64
        && hash.bytes().all(is_lower_hex)
        && fanout_matches
        && !extension.is_empty()
        && extension.len() <= 16
        && extension.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
        })
}

fn is_lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')
}

/// Returns the canonical safe extension when the filename and bytes agree.
pub(crate) fn upload_extension(bytes: &[u8], requested: &str) -> Option<&'static str> {
    let requested = requested
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    let requested = match requested.as_str() {
        "jpeg" | "jpg" => "jpg",
        "png" => "png",
        "gif" => "gif",
        "webp" => "webp",
        "pdf" => "pdf",
        _ => return None,
    };
    let detected = if bytes.starts_with(b"%PDF-") {
        "pdf"
    } else {
        match image::guess_format(bytes).ok()? {
            ImageFormat::Jpeg => "jpg",
            ImageFormat::Png => "png",
            ImageFormat::Gif => "gif",
            ImageFormat::WebP => "webp",
            _ => return None,
        }
    };
    (requested == detected).then_some(detected)
}

/// A local media object store rooted at the vault's media directory.
#[derive(Debug, Clone, Copy)]
pub struct LocalStore<'a> {
    vault: &'a Vault,
}

impl<'a> LocalStore<'a> {
    /// Creates a store for one vault.
    #[must_use]
    pub fn new(vault: &'a Vault) -> Self {
        Self { vault }
    }

    /// Returns the content-addressed relative path for bytes and an extension.
    #[must_use]
    pub fn object_path(bytes: &[u8], extension: &str) -> Option<String> {
        let extension = extension
            .trim()
            .trim_start_matches('.')
            .to_ascii_lowercase();
        if extension.is_empty()
            || extension.len() > 16
            || !extension
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            return None;
        }
        let digest = Sha256::digest(bytes);
        let hash = format!("{digest:x}");
        Some(format!(
            "media/{}/{}/{}.{}",
            &hash[..2],
            &hash[2..4],
            hash,
            extension
        ))
    }

    /// Stores bytes under their content address, returning the vault-relative path.
    pub fn put(&self, bytes: &[u8], extension: &str) -> Result<String, Error> {
        let relative = Self::object_path(bytes, extension).ok_or(Error::NotFound)?;
        let path = self.contained_path(&relative, false)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|source| Error::MediaIo {
                path: parent.to_path_buf(),
                source,
            })?;
        }
        if !path.exists() {
            let temporary = path.with_extension("uploading");
            std::fs::write(&temporary, bytes).map_err(|source| Error::MediaIo {
                path: temporary.clone(),
                source,
            })?;
            std::fs::rename(&temporary, &path).map_err(|source| Error::MediaIo {
                path: path.clone(),
                source,
            })?;
        }
        Ok(relative)
    }

    /// Opens a stored object after validating its path and containment.
    pub fn get(&self, relative: &str) -> Result<(PathBuf, Vec<u8>), Error> {
        let path = self.contained_path(relative, true)?;
        let bytes = std::fs::read(&path).map_err(|_| Error::NotFound)?;
        Ok((path, bytes))
    }

    fn remove(&self, relative: &str) -> Result<(), Error> {
        let path = self.contained_path(relative, true)?;
        std::fs::remove_file(&path).map_err(|source| Error::MediaIo { path, source })
    }

    fn prune_empty_directories(&self) -> Result<(), Error> {
        let root = self.vault.root().join("media");
        if !root.is_dir() {
            return Ok(());
        }
        let mut pending = vec![root.clone()];
        let mut directories = Vec::new();
        while let Some(directory) = pending.pop() {
            let entries = std::fs::read_dir(&directory).map_err(|source| Error::MediaIo {
                path: directory.clone(),
                source,
            })?;
            for entry in entries {
                let entry = entry.map_err(|source| Error::MediaIo {
                    path: directory.clone(),
                    source,
                })?;
                if entry
                    .file_type()
                    .map_err(|source| Error::MediaIo {
                        path: entry.path(),
                        source,
                    })?
                    .is_dir()
                {
                    directories.push(entry.path());
                    pending.push(entry.path());
                }
            }
        }
        directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
        for directory in directories {
            match std::fs::remove_dir(&directory) {
                Ok(()) => {}
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::DirectoryNotEmpty | std::io::ErrorKind::NotFound
                    ) => {}
                Err(source) => {
                    return Err(Error::MediaIo {
                        path: directory,
                        source,
                    });
                }
            }
        }
        Ok(())
    }

    fn write_exact(&self, relative: &str, bytes: &[u8]) -> Result<bool, Error> {
        let extension = relative.rsplit('.').next().ok_or(Error::NotFound)?;
        if Self::object_path(bytes, extension).as_deref() != Some(relative) {
            return Err(Error::MediaStore(format!(
                "object bytes do not match content-addressed path `{relative}`"
            )));
        }
        let path = self.contained_path(relative, false)?;
        if path.exists() {
            return Ok(false);
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|source| Error::MediaIo {
                path: parent.to_path_buf(),
                source,
            })?;
        }
        let temporary = path.with_extension("materializing");
        std::fs::write(&temporary, bytes).map_err(|source| Error::MediaIo {
            path: temporary.clone(),
            source,
        })?;
        std::fs::rename(&temporary, &path).map_err(|source| Error::MediaIo {
            path: path.clone(),
            source,
        })?;
        Ok(true)
    }

    fn list(&self) -> Result<Vec<String>, Error> {
        let root = self.vault.root().join("media");
        if !root.exists() {
            return Ok(Vec::new());
        }
        let mut pending = vec![root.clone()];
        let mut objects = Vec::new();
        while let Some(directory) = pending.pop() {
            let entries = std::fs::read_dir(&directory).map_err(|source| Error::MediaIo {
                path: directory.clone(),
                source,
            })?;
            for entry in entries {
                let entry = entry.map_err(|source| Error::MediaIo {
                    path: directory.clone(),
                    source,
                })?;
                let path = entry.path();
                if path.is_dir() {
                    pending.push(path);
                } else if path.is_file()
                    && let Ok(relative) = path.strip_prefix(self.vault.root())
                {
                    let relative = relative.to_string_lossy().replace('\\', "/");
                    if validate_object_path(&relative).is_ok() {
                        objects.push(relative);
                    }
                }
            }
        }
        objects.sort();
        Ok(objects)
    }

    fn contained_path(&self, relative: &str, must_exist: bool) -> Result<PathBuf, Error> {
        validate_object_path(relative)?;
        let candidate = Path::new(relative);
        let media_root = self.vault.root().join("media");
        let suffix = candidate
            .strip_prefix("media")
            .map_err(|_| Error::NotFound)?;
        let joined = media_root.join(suffix);
        if must_exist {
            let real = joined.canonicalize().map_err(|_| Error::NotFound)?;
            let base = media_root.canonicalize().map_err(|_| Error::NotFound)?;
            if !real.starts_with(&base) || !real.is_file() {
                return Err(Error::NotFound);
            }
            return Ok(real);
        }
        let base = media_root
            .canonicalize()
            .or_else(|_| std::fs::canonicalize(self.vault.root()))
            .map_err(|_| Error::NotFound)?;
        let mut parent = joined.parent().ok_or(Error::NotFound)?.to_path_buf();
        loop {
            if let Ok(real) = parent.canonicalize() {
                if !real.starts_with(&base) {
                    return Err(Error::NotFound);
                }
                break;
            }
            let next = parent.parent().ok_or(Error::NotFound)?;
            if next == parent {
                return Err(Error::NotFound);
            }
            parent = next.to_path_buf();
        }
        Ok(joined)
    }
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use std::fs;
    use std::sync::Arc;

    use super::LocalStore;
    use crate::{Slug, Vault};

    #[test]
    fn object_path_is_stable_and_content_addressed() {
        assert_eq!(
            LocalStore::object_path(b"hello", "png"),
            Some(
                "media/2c/f2/2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824.png"
                    .to_string()
            )
        );
        assert_eq!(
            LocalStore::object_path(b"hello", ".png"),
            LocalStore::object_path(b"hello", "png")
        );
        assert_eq!(
            LocalStore::object_path(b"hello", "PNG"),
            LocalStore::object_path(b"hello", "png")
        );
        assert!(LocalStore::object_path(b"hello", "../png").is_none());
    }

    #[test]
    fn object_paths_require_the_exact_hash_fanout_layout() {
        let path = LocalStore::object_path(b"hello", "png").expect("path");
        assert!(super::validate_object_path(&path).is_ok());
        assert!(super::validate_object_path("media/2c/f2/not-a-hash.png").is_err());
        assert!(
            super::validate_object_path(
                "media/ff/f2/2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824.png"
            )
            .is_err()
        );
        assert!(
            super::validate_object_path(
                "media/2c/f2/2CF24DBA5FB0A30E26E83B2AC5B9E29E1B161E5C1FA7425E73043362938B9824.png"
            )
            .is_err()
        );
    }

    #[test]
    fn uploads_accept_only_matching_safe_raster_or_pdf_bytes() {
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(1, 1)
            .write_to(&mut png, image::ImageFormat::Png)
            .expect("png");
        assert_eq!(
            super::upload_extension(&png.into_inner(), "PNG"),
            Some("png")
        );
        assert_eq!(super::upload_extension(b"%PDF-1.7\n", "pdf"), Some("pdf"));
        assert_eq!(super::upload_extension(b"<svg></svg>", "svg"), None);
        assert_eq!(super::upload_extension(b"%PDF-1.7\n", "png"), None);
    }

    #[test]
    fn put_and_get_stays_inside_the_vault() {
        let root =
            std::env::temp_dir().join(format!("memberberry-media-test-{}", std::process::id()));
        drop(fs::remove_dir_all(&root));
        fs::create_dir_all(&root).expect("creating vault");
        let vault = Vault::open(
            Slug::parse("media-test").expect("slug"),
            "Media test",
            &root,
        )
        .expect("vault");
        let store = LocalStore::new(&vault);
        let path = store.put(b"hello", "png").expect("put");
        assert_eq!(store.get(&path).expect("get").1, b"hello");
        assert!(store.get("media/../access.toml").is_err());
        drop(fs::remove_dir_all(root));
    }

    #[tokio::test]
    async fn references_and_orphans_come_from_markdown_and_real_objects() {
        let root = std::env::temp_dir().join(format!(
            "memberberry-media-orphan-test-{}",
            std::process::id()
        ));
        drop(fs::remove_dir_all(&root));
        fs::create_dir_all(&root).expect("creating vault");
        let vault = Vault::open(
            Slug::parse("media-orphan-test").expect("slug"),
            "Media orphan test",
            &root,
        )
        .expect("vault");
        let store = LocalStore::new(&vault);
        let used = store.put(b"used", "png").expect("used object");
        let orphan = store.put(b"orphan", "png").expect("orphan object");
        let original = store.put(b"original", "png").expect("original object");
        let empty_directory = root.join("media/aa/bb");
        fs::create_dir_all(&empty_directory).expect("empty media directory");
        assert_eq!(
            store
                .put(b"original", "png")
                .expect("deduplicated original"),
            original
        );
        assert_eq!(store.get(&original).expect("original bytes").1, b"original");
        fs::write(root.join("Note.md"), format!("![used](./{used})\n")).expect("writing note");
        super::retain_original(&vault, &used, &original).expect("retain original");

        assert_eq!(
            super::references(&vault).expect("references"),
            vec![original, used]
        );
        assert_eq!(
            super::orphaned(&vault).await.expect("orphans"),
            vec![orphan.clone()]
        );
        assert_eq!(
            super::prune_orphaned(&vault, std::slice::from_ref(&orphan))
                .await
                .expect("protected orphan"),
            Vec::<String>::new()
        );
        assert_eq!(
            super::prune_orphaned(&vault, &[]).await.expect("pruned"),
            vec![orphan.clone()]
        );
        assert!(store.get(&orphan).is_err());
        assert!(!empty_directory.exists());
        assert_eq!(super::materialize(&vault).await.expect("materialize"), 0);
        drop(fs::remove_dir_all(root));
    }

    #[test]
    fn thumbnail_bounds_both_dimensions_and_encodes_webp() {
        let source = image::DynamicImage::new_rgb8(400, 200);
        let mut encoded = std::io::Cursor::new(Vec::new());
        source
            .write_to(&mut encoded, image::ImageFormat::Png)
            .expect("source png");
        let output = super::thumbnail(&encoded.into_inner(), 100).expect("thumbnail");
        let decoded =
            image::load_from_memory_with_format(&output, image::ImageFormat::WebP).expect("webp");
        assert_eq!((decoded.width(), decoded.height()), (100, 50));
    }

    #[tokio::test]
    async fn object_store_backend_puts_gets_and_lists_content_addresses() {
        let store = super::Store::S3(Arc::new(object_store::memory::InMemory::new()));
        let path = store.put(b"remote", "png").await.expect("put");
        assert_eq!(store.get(&path).await.expect("get"), b"remote");
        assert_eq!(store.list().await.expect("list"), vec![path]);
        assert!(store.get("../outside").await.is_err());
    }
}
