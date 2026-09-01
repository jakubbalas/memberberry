//! A throwaway directory for tests that need a real filesystem.
//!
//! Hand-rolled rather than `tempfile`: it is a dozen lines and keeps the dependency list
//! short. Uniqueness comes from the process id plus a counter, so tests running in parallel
//! and concurrent `cargo test` runs both stay separate, with no clock and no RNG.

#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new(label: &str) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("mb-server-{label}-{}-{n}", std::process::id()));
        drop(fs::remove_dir_all(&path));
        fs::create_dir_all(&path).expect("creating the temp dir");
        Self(path)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    /// Writes a file, creating parent directories, and returns its path.
    pub fn write(&self, rel: &str, contents: &str) -> PathBuf {
        let path = self.0.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("creating parent directories");
        }
        fs::write(&path, contents).expect("writing the file");
        path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        drop(fs::remove_dir_all(&self.0));
    }
}
