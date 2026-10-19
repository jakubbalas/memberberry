//! Bounded no-follow directory subscriptions for the opt-in folder filter.
use std::path::{Path, PathBuf};
pub(super) fn directories(root: &Path) -> Result<Vec<PathBuf>, std::io::Error> {
    let mut pending = vec![(root.to_path_buf(), 0)];
    let mut result = Vec::new();
    let mut entries = 0;
    while let Some((directory, depth)) = pending.pop() {
        if !crate::vault::directory_is_writable(&directory) {
            continue;
        }
        if result.len() >= 1024 || depth > 64 {
            return Err(std::io::Error::other("watch directory budget"));
        }
        for entry in std::fs::read_dir(&directory)? {
            let entry = entry?;
            entries += 1;
            if entries > 16384 {
                return Err(std::io::Error::other("watch entry budget"));
            }
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            // DirEntry type lookup does not follow links or enumerate skipped children.
            if entry.file_type()?.is_dir() {
                pending.push((entry.path(), depth + 1));
            }
        }
        result.push(directory);
    }
    Ok(result)
}
