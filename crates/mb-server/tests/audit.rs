//! Audit log tests (`SPEC.md` §6.9).

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

mod support;

use mb_server::audit::{AuditAction, AuditEvent, AuditLog, AuditResult};

use support::TempDir;

fn event<'a>(targets: &'a [String]) -> AuditEvent<'a> {
    AuditEvent {
        timestamp: "2026-09-01T12:34:56Z",
        actor: Some("alice"),
        source_ip: Some("127.0.0.1"),
        vault: Some("personal"),
        action: AuditAction::AccessChanged,
        targets,
        result: AuditResult::Success,
    }
}

#[test]
fn audit_events_are_json_lines_with_identifiers_and_outcomes() {
    let dir = TempDir::new("audit-json");
    let log = AuditLog::new(dir.path(), 4_096).expect("create log");
    let targets = vec!["Projects/Access.md".to_string()];
    log.append(&event(&targets)).expect("append event");

    let contents = std::fs::read_to_string(dir.path().join("audit.log")).expect("read log");
    let value: serde_json::Value = serde_json::from_str(&contents).expect("valid JSON line");
    assert_eq!(value["actor"], "alice");
    assert_eq!(value["vault"], "personal");
    assert_eq!(value["action"], "access_changed");
    assert_eq!(value["result"], "success");
    assert_eq!(value["targets"][0], "Projects/Access.md");
}

#[test]
fn audit_log_rotates_before_a_record_exceeds_its_size_limit() {
    let dir = TempDir::new("audit-rotate");
    let targets = vec!["note-a".to_string()];
    let sample = serde_json::to_vec(&event(&targets))
        .expect("serialize sample")
        .len()
        + 1;
    let log = AuditLog::new(dir.path(), (sample * 2 - 1) as u64).expect("create log");

    log.append(&event(&targets)).expect("first append");
    log.append(&event(&targets)).expect("second append");

    assert!(dir.path().join("audit.log.1").exists());
    let current = std::fs::read_to_string(dir.path().join("audit.log")).expect("current log");
    assert_eq!(current.lines().count(), 1);
}
