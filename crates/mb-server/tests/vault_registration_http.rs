//! T-002c real signed-session HTTP regressions, disposable projects only.
#![cfg(target_os = "linux")]
#![allow(
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::panic,
    clippy::indexing_slicing
)] // why: controlled JSON/array fixtures and behavioral assertions, test-only.
#[path = "support/vault_registration.rs"]
mod registration_fixture;
#[allow(dead_code)] // why: each integration target uses a subset of these shared test helpers.
#[path = "support/http_safety.rs"]
mod safety;
use registration_fixture::{Server, json};
use std::io::{Read, Write};
#[path = "vault_registration_http/cases.rs"]
mod cases;
#[path = "support/project_registration_cases.rs"]
mod registration_cases;
#[path = "support/project_registration_strict_cases.rs"]
mod strict_cases;
#[test]
fn e29_strict_registration_wire_ambiguity_is_neutral_before_storage() {
    strict_cases::strict_wire_gate();
}

fn post(server: &Server, route: &str, headers: &str, body: &str) -> (u16, String) {
    let mut stream = std::net::TcpStream::connect(server.addr).expect("connect");
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(30)))
        .expect("deadline");
    write!(stream, "POST {route} HTTP/1.1\r\nHost: localhost\r\n{headers}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).expect("request");
    let mut raw = String::new();
    stream.read_to_string(&mut raw).expect("response");
    let (head, body) = raw.split_once("\r\n\r\n").expect("HTTP");
    (
        head.split_whitespace()
            .nth(1)
            .expect("status")
            .parse()
            .expect("code"),
        body.into(),
    )
}

#[test]
fn existing_and_new_projects_preserve_files_and_publish_root_layout() {
    let server = Server::new(false);
    let project = server.dir.path().join("Projects/Public");
    let note = b"# Project\n\nPlain Markdown bytes\n";
    let code = b"binary\0content\xff";
    std::fs::write(project.join("Readme.md"), note).expect("note");
    std::fs::write(project.join("program.bin"), code).expect("non-Markdown");
    std::fs::write(
        project.join(".access.toml.memberberry-tmp"),
        b"unrelated hidden artifact",
    )
    .expect("hidden");
    let headers = format!("{}Origin: http://localhost\r\n", server.admin);
    for (slug, mode, path, directory) in [
        ("project", "existing", "Public", None),
        ("fresh", "new", "", Some("Design: 100% 日本")),
    ] {
        let mut request = serde_json::json!({"mode":mode,"path":path,"slug":slug,"name":"Project"});
        if let Some(directory) = directory {
            request["directory"] = directory.into();
        }
        let (status, body) = post(
            &server,
            "/api/v1/vault-locations/projects/preview",
            &headers,
            &request.to_string(),
        );
        assert_eq!(
            status, 200,
            "preview must authorize/check actual storage and issue a confirmation: {body}"
        );
        request["confirmation"] = json(&body)["confirmation"].clone();
        let (status, body) = post(
            &server,
            "/api/v1/vault-locations/projects/register",
            &headers,
            &request.to_string(),
        );
        assert_eq!(status, 201, "confirmed registration: {body}");
        assert_eq!(
            server
                .config()
                .vaults
                .iter()
                .filter(|v| v.slug == slug)
                .count(),
            1
        );
        let root = project
            .parent()
            .expect("projects")
            .join(directory.unwrap_or(path));
        assert!(
            !root.join("notes").exists(),
            "never create notes in a project"
        );
        let acl = mb_server::AccessFile::load(&root).expect("ACL");
        assert_eq!(
            acl.policy().effective_role(
                &mb_core::Username::parse("alice").expect("user"),
                &mb_core::NotePath::parse("Readme.md").expect("path")
            ),
            mb_core::Role::Owner
        );
        assert_eq!(
            post(
                &server,
                "/api/v1/vault-locations/projects/register",
                &headers,
                &request.to_string()
            )
            .0,
            409,
            "receipt is single use"
        );
    }
    assert_eq!(
        std::fs::read(project.join("Readme.md")).expect("preserved"),
        note
    );
    assert_eq!(
        std::fs::read(project.join("program.bin")).expect("preserved"),
        code
    );
    assert_eq!(
        std::fs::read(project.join(".access.toml.memberberry-tmp")).expect("preserved"),
        b"unrelated hidden artifact"
    );
    assert_eq!(
        server.get("/api/v1/vaults/project/notes", &server.admin).0,
        200,
        "live registry must publish"
    );
}

#[test]
fn project_symlinks_are_skipped_without_reading_targets() {
    registration_cases::symlinks_are_skipped_without_reading_targets();
}

#[cfg(target_os = "linux")]
#[path = "support/folder_exclusion_cases.rs"]
mod folder_exclusion_cases;
#[cfg(target_os = "linux")]
#[test]
fn ignore_non_writable_folders_is_opt_in_persistent_and_filtered() {
    folder_exclusion_cases::checked_option_filters_without_reading_or_repairing(
        "ignore_non_writable_folders_is_opt_in_persistent_and_filtered",
    );
}

#[cfg(target_os = "linux")]
#[test]
fn ignore_option_cannot_skip_required_root_media_or_index_storage() {
    folder_exclusion_cases::required_storage_remains_strict(
        "ignore_option_cannot_skip_required_root_media_or_index_storage",
    );
}
