//! Fixtures shared by the index suites.
//!
//! The temp directory is hand-rolled for the same reason `mb-server`'s is: a dozen lines,
//! no dependency, and uniqueness from the process id plus a counter rather than a clock.

#![allow(dead_code, clippy::expect_used, clippy::unwrap_used)]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use mb_core::{Access, Member, NotePath, Role, Rule, Username};
use mb_index::{Index, NoteInput, Stamp};

pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new(label: &str) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("mb-index-{label}-{}-{n}", std::process::id()));
        drop(fs::remove_dir_all(&path));
        fs::create_dir_all(&path).expect("creating the temp dir");
        Self(path)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

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

/// An in-memory index holding exactly these notes.
pub fn indexed(notes: &[(&str, &str)]) -> Index {
    let mut index = Index::in_memory().expect("in-memory index");
    for (n, (path, markdown)) in notes.iter().enumerate() {
        index
            .upsert(&NoteInput {
                path: (*path).to_string(),
                markdown: (*markdown).to_string(),
                stamp: Stamp::from_parts(markdown.len() as u64, n as u128),
            })
            .expect("upsert");
    }
    index
}

pub fn user(name: &str) -> Username {
    Username::parse(name).expect("username")
}

/// A policy granting `name` vault-wide viewer access.
pub fn viewer_everywhere(name: &str) -> Access {
    Access::new(
        vec![Member {
            user: user(name),
            role: Role::Viewer,
        }],
        vec![],
    )
    .expect("policy")
}

/// Vault-wide viewer access, with `denied` paths explicitly withheld.
pub fn viewer_except(name: &str, denied: &[&str]) -> Access {
    let rules = denied
        .iter()
        .map(|path| Rule {
            path: NotePath::parse(path).expect("acl path"),
            grants: BTreeMap::from([(user(name), Role::None)]),
        })
        .collect();
    Access::new(
        vec![Member {
            user: user(name),
            role: Role::Viewer,
        }],
        rules,
    )
    .expect("policy")
}
