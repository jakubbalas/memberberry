// why: failure-path fixtures deliberately cut and corrupt known-valid byte records.
#![allow(clippy::expect_used, clippy::indexing_slicing, clippy::unwrap_used)]

use std::fs;
use std::sync::Arc;
use std::thread;

use mb_core::frontmatter::YamlValue;
use tempfile::TempDir;
use yrs::{Map, Transact, WriteTxn, XmlElementPrelim, XmlFragment};

use mb_crdt::{
    FRONTMATTER_ROOT, PROSEMIRROR_ROOT, Sidecar, SidecarError, document_from_update_v1,
    document_from_yrs, document_to_yrs, encode_update_v1,
};

#[test]
fn a_missing_sidecar_is_rebuilt_by_the_caller() {
    let temp = TempDir::new().unwrap();
    let sidecar = Sidecar::new(temp.path().join("crdt/note.bin"));

    assert!(sidecar.load().unwrap().is_none());
}

#[test]
fn replace_creates_parent_directories_and_one_portable_state_record() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join(".memberberry/crdt/note.bin");
    let sidecar = Sidecar::new(&path);
    let expected = mb_core::parse("---\nid: note-id\n---\n\n# Persisted\n");
    let doc = document_to_yrs(&expected).unwrap();

    sidecar.replace(&doc).unwrap();
    let loaded = sidecar.load().unwrap().unwrap();

    assert_eq!(sidecar.path(), path);
    assert_eq!(loaded.update_count, 1);
    assert_eq!(document_from_yrs(&loaded.doc).unwrap(), expected);
    assert!(!temp.path().join(".memberberry/crdt/.note.bin.tmp").exists());
}

#[test]
fn appended_incremental_updates_replay_in_order() {
    let temp = TempDir::new().unwrap();
    let sidecar = Sidecar::new(temp.path().join("note.bin"));
    let doc = document_to_yrs(&mb_core::parse("base\n")).unwrap();
    sidecar.append(&encode_update_v1(&doc)).unwrap();

    let update = insert_frontmatter(&doc, "status", "edited");
    sidecar.append(&update).unwrap();
    let loaded = sidecar.load().unwrap().unwrap();
    let materialized = document_from_yrs(&loaded.doc).unwrap();

    assert_eq!(loaded.update_count, 2);
    assert_eq!(
        materialized.frontmatter.extra.get("status"),
        Some(&YamlValue::Scalar("edited".to_string()))
    );
}

#[test]
fn compaction_rewrites_many_updates_as_one_without_changing_content() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("note.bin");
    let sidecar = Sidecar::new(&path);
    let doc = document_to_yrs(&mb_core::parse("base\n")).unwrap();
    sidecar.append(&encode_update_v1(&doc)).unwrap();
    for index in 0..4 {
        sidecar
            .append(&insert_frontmatter(
                &doc,
                &format!("key-{index}"),
                &format!("value-{index}"),
            ))
            .unwrap();
    }
    let before = fs::metadata(&path).unwrap().len();
    let expected = document_from_yrs(&sidecar.load().unwrap().unwrap().doc).unwrap();

    assert!(sidecar.compact_if_needed(4).unwrap());
    let loaded = sidecar.load().unwrap().unwrap();

    assert_eq!(loaded.update_count, 1);
    assert_eq!(document_from_yrs(&loaded.doc).unwrap(), expected);
    assert!(fs::metadata(&path).unwrap().len() < before);
    assert!(!temp.path().join(".note.bin.tmp").exists());
}

#[test]
fn compaction_below_threshold_and_missing_sidecars_do_not_rewrite() {
    let temp = TempDir::new().unwrap();
    let missing = Sidecar::new(temp.path().join("missing.bin"));
    assert!(!missing.compact_if_needed(0).unwrap());

    let sidecar = Sidecar::new(temp.path().join("note.bin"));
    let doc = document_to_yrs(&mb_core::parse("base\n")).unwrap();
    sidecar.replace(&doc).unwrap();
    let before = fs::read(sidecar.path()).unwrap();

    assert!(!sidecar.compact_if_needed(1).unwrap());
    assert_eq!(fs::read(sidecar.path()).unwrap(), before);
}

#[test]
fn concurrent_appends_through_one_sidecar_are_complete_and_convergent() {
    let temp = TempDir::new().unwrap();
    let sidecar = Arc::new(Sidecar::new(temp.path().join("note.bin")));
    let base = document_to_yrs(&mb_core::parse("base\n")).unwrap();
    let base_update = encode_update_v1(&base);
    sidecar.append(&base_update).unwrap();

    let updates = (0..8)
        .map(|index| {
            let replica = document_from_update_v1(&base_update).unwrap();
            insert_frontmatter(&replica, &format!("peer-{index}"), "present")
        })
        .collect::<Vec<_>>();
    let handles = updates
        .into_iter()
        .map(|update| {
            let sidecar = Arc::clone(&sidecar);
            thread::spawn(move || sidecar.append(&update))
        })
        .collect::<Vec<_>>();
    for handle in handles {
        handle
            .join()
            .expect("append thread must not panic")
            .unwrap();
    }

    let loaded = sidecar.load().unwrap().unwrap();
    let materialized = document_from_yrs(&loaded.doc).unwrap();
    assert_eq!(loaded.update_count, 9);
    for index in 0..8 {
        assert_eq!(
            materialized.frontmatter.extra.get(&format!("peer-{index}")),
            Some(&YamlValue::Scalar("present".to_string()))
        );
    }
}

#[test]
fn invalid_updates_are_rejected_before_a_file_is_created() {
    let temp = TempDir::new().unwrap();
    let sidecar = Sidecar::new(temp.path().join("note.bin"));

    let error = sidecar
        .append(&[0xff, 0x01])
        .expect_err("garbage must fail");

    assert!(matches!(error, SidecarError::InvalidUpdate { .. }));
    assert!(!sidecar.path().exists());
}

#[test]
fn invalid_header_empty_log_truncation_and_checksum_corruption_are_distinct() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("note.bin");
    let sidecar = Sidecar::new(&path);
    let doc = document_to_yrs(&mb_core::parse("base\n")).unwrap();
    sidecar.replace(&doc).unwrap();
    let valid = fs::read(&path).unwrap();

    fs::write(&path, b"not-a-sidecar").unwrap();
    assert!(matches!(
        sidecar.load().expect_err("header must fail"),
        SidecarError::InvalidHeader { .. }
    ));

    fs::write(&path, b"MB").unwrap();
    assert!(matches!(
        sidecar.load().expect_err("short header must fail"),
        SidecarError::InvalidHeader { .. }
    ));

    fs::write(&path, &valid[..8]).unwrap();
    assert!(matches!(
        sidecar.load().expect_err("empty log must fail"),
        SidecarError::Empty { .. }
    ));

    fs::write(&path, &valid[..valid.len() - 1]).unwrap();
    assert!(matches!(
        sidecar.load().expect_err("partial update must fail"),
        SidecarError::Truncated { record: 0, .. }
    ));

    fs::write(&path, &valid[..9]).unwrap();
    assert!(matches!(
        sidecar.load().expect_err("partial record header must fail"),
        SidecarError::Truncated { record: 0, .. }
    ));

    let mut corrupt = valid;
    let last = corrupt.len() - 1;
    corrupt[last] ^= 0xff;
    fs::write(&path, corrupt).unwrap();
    assert!(matches!(
        sidecar.load().expect_err("checksum must fail"),
        SidecarError::ChecksumMismatch { record: 0, .. }
    ));
}

#[test]
fn append_refuses_to_extend_a_file_with_the_wrong_header() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("note.bin");
    fs::write(&path, b"not-a-sidecar").unwrap();
    let sidecar = Sidecar::new(&path);
    let doc = document_to_yrs(&mb_core::parse("base\n")).unwrap();

    let error = sidecar
        .append(&encode_update_v1(&doc))
        .expect_err("append must preserve an unknown file");

    assert!(matches!(error, SidecarError::InvalidHeader { .. }));
    assert_eq!(fs::read(path).unwrap(), b"not-a-sidecar");
}

#[test]
fn oversized_record_lengths_are_rejected_without_allocating_the_payload() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("note.bin");
    let sidecar = Sidecar::new(&path);
    let mut bytes = b"MBCRDT\0\x01".to_vec();
    bytes.extend_from_slice(&(64_u32 * 1024 * 1024 + 1).to_le_bytes());
    bytes.extend_from_slice(&0_u32.to_le_bytes());
    fs::write(&path, bytes).unwrap();

    let error = sidecar.load().expect_err("oversized record must fail");

    assert!(matches!(
        error,
        SidecarError::UpdateTooLarge { record: 0, .. }
    ));
}

#[test]
fn schema_invalid_materialized_state_is_not_returned() {
    let temp = TempDir::new().unwrap();
    let sidecar = Sidecar::new(temp.path().join("note.bin"));
    let invalid = yrs::Doc::new();
    let mut txn = invalid.transact_mut();
    txn.get_or_insert_xml_fragment(PROSEMIRROR_ROOT)
        .push_back(&mut txn, XmlElementPrelim::empty("database_view"));
    txn.get_or_insert_map(FRONTMATTER_ROOT);
    drop(txn);
    sidecar.append(&encode_update_v1(&invalid)).unwrap();

    let error = sidecar.load().expect_err("unknown node must fail closed");

    assert!(matches!(error, SidecarError::InvalidDocument { .. }));
}

#[test]
fn replace_rejects_schema_invalid_state_before_writing() {
    let temp = TempDir::new().unwrap();
    let sidecar = Sidecar::new(temp.path().join("note.bin"));
    let invalid = yrs::Doc::new();
    let mut txn = invalid.transact_mut();
    txn.get_or_insert_xml_fragment(PROSEMIRROR_ROOT)
        .push_back(&mut txn, XmlElementPrelim::empty("database_view"));
    txn.get_or_insert_map(FRONTMATTER_ROOT);
    drop(txn);

    let error = sidecar
        .replace(&invalid)
        .expect_err("invalid state must not be persisted");

    assert!(matches!(error, SidecarError::InvalidDocument { .. }));
    assert!(!sidecar.path().exists());
}

#[test]
fn failed_atomic_rename_removes_the_temporary_file() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("note.bin");
    fs::create_dir(&path).unwrap();
    let sidecar = Sidecar::new(&path);
    let doc = document_to_yrs(&mb_core::parse("base\n")).unwrap();

    let error = sidecar
        .replace(&doc)
        .expect_err("a directory cannot be atomically replaced by a file");

    assert!(matches!(error, SidecarError::Io { .. }));
    assert!(!temp.path().join(".note.bin.tmp").exists());
    assert!(path.is_dir());
}

#[test]
fn an_unusable_parent_path_reports_the_filesystem_failure() {
    let temp = TempDir::new().unwrap();
    let parent = temp.path().join("not-a-directory");
    fs::write(&parent, b"file").unwrap();
    let sidecar = Sidecar::new(parent.join("note.bin"));
    let doc = document_to_yrs(&mb_core::parse("base\n")).unwrap();

    let error = sidecar.replace(&doc).expect_err("file cannot be a parent");

    assert!(matches!(error, SidecarError::Io { .. }));
    assert!(error.to_string().contains("not-a-directory"));
}

fn insert_frontmatter(doc: &yrs::Doc, key: &str, value: &str) -> Vec<u8> {
    let mut txn = doc.transact_mut();
    txn.get_or_insert_map(FRONTMATTER_ROOT)
        .insert(&mut txn, key, value);
    txn.encode_update_v1()
}
