//! E29 write-side leak matrix shared by the focused HTTP and leak targets.
#![allow(dead_code, clippy::expect_used, clippy::unwrap_used, clippy::panic)] // why: disposable test fixtures only.
use crate::registration_fixture::{Server, json};
use std::io::{Read, Write};
pub fn post(s: &Server, route: &str, headers: &str, body: &str) -> (u16, String) {
    let mut stream = std::net::TcpStream::connect(s.addr).expect("connect");
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(30)))
        .expect("deadline");
    write!(stream,"POST {route} HTTP/1.1\r\nHost: localhost\r\n{headers}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).expect("request");
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
pub struct Observer(std::os::fd::OwnedFd);
impl Observer {
    pub fn new(paths: &[&std::path::Path]) -> Self {
        use rustix::fs::inotify::*;
        let fd = init(CreateFlags::NONBLOCK).expect("observer");
        for path in paths {
            add_watch(
                &fd,
                *path,
                WatchFlags::OPEN
                    | WatchFlags::ACCESS
                    | WatchFlags::CREATE
                    | WatchFlags::DELETE
                    | WatchFlags::MOVED_FROM
                    | WatchFlags::MOVED_TO,
            )
            .expect("watch fixture");
        }
        Self(fd)
    }
    pub fn events(&self) -> Vec<(u32, Option<String>)> {
        let mut bytes = [std::mem::MaybeUninit::uninit(); 16384];
        let mut read = rustix::fs::inotify::Reader::new(&self.0, &mut bytes);
        let mut result = Vec::new();
        loop {
            match read.next() {
                Ok(e) => result.push((
                    e.events().bits(),
                    e.file_name().map(|n| n.to_string_lossy().into_owned()),
                )),
                Err(rustix::io::Errno::AGAIN) => return result,
                Err(e) => panic!("observer: {e}"),
            }
        }
    }
}
fn valid_request(mode: &str, action: &str, confirmation: &str) -> String {
    let mut value = serde_json::Map::new();
    for (key, value_text) in [
        ("mode", mode),
        ("path", if mode == "new" { "" } else { "Public" }),
        ("slug", "project"),
        ("name", "Project"),
    ] {
        value.insert(key.into(), value_text.into());
    }
    if mode == "new" {
        value.insert("directory".into(), "New".into());
    }
    if action == "register" {
        value.insert("confirmation".into(), confirmation.into());
    }
    serde_json::Value::Object(value).to_string()
}
pub fn write_gate_is_neutral_and_observer_has_positive_control() {
    let s = Server::configured(true, |config| {
        config.vaults.first_mut().expect("registered fixture").media =
            mb_server::MediaBackendConfig::S3 {
                bucket: "fixture-bucket".into(),
                region: "fixture-region".into(),
                endpoint: Some("http://127.0.0.1:9".into()),
                access_key_id: "FixtureAccessCredential".into(),
                secret_access_key: "FixtureSecretCredential".into(),
                allow_http: true,
                virtual_hosted_style: false,
            };
    });
    let config = s.dir.path().join("server.toml");
    let project = s.dir.path().join("Projects/Public");
    let before = std::fs::read(&config).expect("snapshot");
    // Genuine, correctly bound admin confirmations make every denied mutation request
    // actionable if a decisive credential guard is broken; malformed bodies alone are not proof.
    let mut confirmations = std::collections::BTreeMap::new();
    for mode in ["existing", "new"] {
        let (status, body) = post(
            &s,
            "/api/v1/vault-locations/projects/preview",
            &format!("{}Origin: http://localhost\r\n", s.admin),
            &valid_request(mode, "preview", ""),
        );
        assert_eq!(status, 200);
        confirmations.insert(
            mode,
            json(&body)
                .get("confirmation")
                .and_then(serde_json::Value::as_str)
                .expect("real receipt")
                .to_owned(),
        );
    }
    let observer = Observer::new(&[&config, &project]);
    assert!(observer.events().is_empty());
    let mixed = format!("{}{}", s.admin, s.admin_bearer);
    let credentials = [
        String::new(),
        s.user.clone(),
        s.admin_bearer.clone(),
        s.user_bearer.clone(),
        mixed,
        "Cookie: mb_session=invalid\r\n".into(),
    ];
    for credentials in &credentials {
        for mode in ["existing", "new"] {
            for action in ["preview", "register"] {
                let raw = valid_request(
                    mode,
                    action,
                    confirmations.get(mode).expect("issued confirmation"),
                );
                for route in [
                    format!("/api/v1/vault-locations/projects/{action}"),
                    format!("/api/v1/vault-locations/unknown/{action}?path=../secret"),
                ] {
                    let (status, body) = post(
                        &s,
                        &route,
                        &format!("{credentials}Origin: http://localhost\r\n"),
                        &raw,
                    );
                    assert_eq!(status, 404);
                    assert_eq!(json(&body), serde_json::json!({"error":"not_found"}));
                    assert!(
                        !body.contains("PrivateTitle")
                            && !body.contains("PrivateBody")
                            && !body.contains(s.dir.path().to_str().expect("path"))
                    );
                }
            }
        }
    }
    for origin in [
        "",
        "Origin: http://foreign.invalid\r\n",
        "Origin: null\r\n",
        "Origin: http://localhost\r\nSec-Fetch-Site: cross-site\r\n",
    ] {
        for mode in ["existing", "new"] {
            for action in ["preview", "register"] {
                let valid = valid_request(
                    mode,
                    action,
                    confirmations.get(mode).expect("issued confirmation"),
                );
                for raw in [valid.as_str(), "malformed"] {
                    let (status, body) = post(
                        &s,
                        &format!("/api/v1/vault-locations/projects/{action}"),
                        &format!("{}{origin}", s.admin),
                        raw,
                    );
                    assert_eq!(status, 404);
                    assert_eq!(json(&body), serde_json::json!({"error":"not_found"}));
                }
            }
        }
    }
    assert!(observer.events().is_empty());
    let moved_config = s.dir.path().join("MovedConfig");
    std::fs::rename(&config, &moved_config).expect("disposable unavailable config");
    observer.events();
    for credentials in &credentials {
        for mode in ["existing", "new"] {
            for action in ["preview", "register"] {
                let raw = valid_request(
                    mode,
                    action,
                    confirmations.get(mode).expect("issued confirmation"),
                );
                let (status, body) = post(
                    &s,
                    &format!("/api/v1/vault-locations/projects/{action}"),
                    &format!("{credentials}Origin: http://localhost\r\n"),
                    &raw,
                );
                assert_eq!(status, 404);
                assert_eq!(json(&body), serde_json::json!({"error":"not_found"}));
            }
        }
    }
    assert!(
        observer.events().is_empty(),
        "unavailable configuration cannot move credential checks after filesystem work"
    );
    std::fs::rename(moved_config, &config).expect("restore fixture config");
    observer.events();
    for action in ["demote", "disable", "revoke"] {
        let auth = s.auth();
        match action {
            "demote" => auth.set_admin(s.admin_id, false).expect("demote"),
            "disable" => auth.set_disabled(s.admin_id, true).expect("disable"),
            _ => auth.revoke_session(&s.session).expect("revoke"),
        }
        for mode in ["existing", "new"] {
            for operation in ["preview", "register"] {
                let raw = valid_request(
                    mode,
                    operation,
                    confirmations.get(mode).expect("issued confirmation"),
                );
                let (status, body) = post(
                    &s,
                    &format!("/api/v1/vault-locations/projects/{operation}"),
                    &format!("{}Origin: http://localhost\r\n", s.admin),
                    &raw,
                );
                assert_eq!(status, 404);
                assert_eq!(json(&body), serde_json::json!({"error":"not_found"}));
            }
        }
        if action == "demote" {
            auth.set_admin(s.admin_id, true).expect("restore admin");
        }
        if action == "disable" {
            auth.set_disabled(s.admin_id, false)
                .expect("restore enabled");
        }
    }
    assert!(
        observer.events().is_empty(),
        "no denied request may open/access/probe config or selected project"
    );
    assert_eq!(std::fs::read(&config).expect("preserved"), before);
    // Positive control occurs after the neutral probes and snapshot read, which itself
    // produces ACCESS. Drain it, then authorize a current second session for a real preview.
    observer.events();
    let auth = s.auth();
    let token = auth
        .create_session(s.admin_id, 4_102_444_800)
        .expect("fresh session");
    let headers = format!(
        "Cookie: mb_session={}\r\nOrigin: http://localhost\r\n",
        auth.signed_session_cookie(&token).expect("signed")
    );
    let raw = r#"{"mode":"existing","path":"Public","slug":"project","name":"Project"}"#;
    assert_eq!(
        post(
            &s,
            "/api/v1/vault-locations/projects/preview",
            &headers,
            raw
        )
        .0,
        200
    );
    assert!(
        !observer.events().is_empty(),
        "positive control proves filesystem observer watches the exercised code"
    );
    // Expire a genuinely issued, positively authorized signed session in the disposable
    // auth DB. No forged session, clock sleep, or production credential is involved.
    let expired=std::process::Command::new("python3").args(["-c","import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('UPDATE sessions SET expires_at=0'); c.commit(); assert c.execute('SELECT COUNT(*) FROM sessions WHERE expires_at!=0').fetchone()[0]==0"]).arg(s.dir.path().join("auth.sqlite")).output().expect("controlled expiry");
    assert!(
        expired.status.success(),
        "fixture session expiry must execute"
    );
    for mode in ["existing", "new"] {
        for action in ["preview", "register"] {
            let raw = valid_request(
                mode,
                action,
                confirmations.get(mode).expect("issued confirmation"),
            );
            let (status, body) = post(
                &s,
                &format!("/api/v1/vault-locations/projects/{action}"),
                &headers,
                &raw,
            );
            assert_eq!(status, 404);
            assert_eq!(json(&body), serde_json::json!({"error":"not_found"}));
        }
    }
    assert!(
        observer.events().is_empty(),
        "expired signed session cannot access config or project"
    );
}

/// t-012: adoption skips links; E1/E5/E29/E30 never read or publish their targets.
pub fn symlinks_are_skipped_without_reading_targets() {
    let s = Server::new(false);
    let root = s.dir.path().join("Projects/Public");
    let outside = s.dir.path().join("Outside");
    std::fs::create_dir(&outside).expect("outside");
    let secret = outside.join("Secret.md");
    std::fs::write(&secret, "# OUTSIDE_LINK_SECRET\n").expect("secret");
    std::fs::create_dir(root.join("Real")).expect("real");
    std::fs::write(root.join("Real/Readme.md"), "# Visible\n").expect("note");
    std::fs::create_dir_all(root.join("node_modules/.bin")).expect("dependency");
    for (target, name) in [
        (root.join("Real/Readme.md"), "Alias.md"),
        (root.join("Real"), "Linked"),
        (outside.clone(), "External"),
        (outside.clone(), "notes"),
        (secret.clone(), "Escape.md"),
        (root.join("missing"), "Broken.md"),
        (root.clone(), "Loop"),
        (secret.clone(), "node_modules/.bin/tool"),
    ] {
        std::os::unix::fs::symlink(target, root.join(name)).expect("symlink");
    }
    let observer = Observer::new(&[&outside, &secret]);
    let headers = format!("{}Origin: http://localhost\r\n", s.admin);
    let mut request =
        serde_json::json!({"mode":"existing","path":"Public","slug":"project","name":"Project"});
    let (status, body) = post(
        &s,
        "/api/v1/vault-locations/projects/preview",
        &headers,
        &request.to_string(),
    );
    assert_eq!(status, 200, "links must not refuse preview: {body}");
    request["confirmation"] = json(&body)["confirmation"].clone();
    let (status, body) = post(
        &s,
        "/api/v1/vault-locations/projects/register",
        &headers,
        &request.to_string(),
    );
    assert_eq!(status, 201, "links must not refuse registration: {body}");
    let listing = s.get("/api/v1/vaults/project/notes", &s.admin);
    assert_eq!(listing.0, 200);
    assert!(listing.1.contains("Real/Readme.md"));
    for name in [
        "Alias",
        "Linked",
        "External",
        "Escape",
        "Broken",
        "Loop",
        "OUTSIDE_LINK_SECRET",
    ] {
        assert!(!listing.1.contains(name), "catalog leaked {name}");
    }
    let directory = s.get("/api/v1/vaults/project/directory", &s.admin);
    assert_eq!(directory.0, 200);
    assert!(directory.1.contains("Real"));
    for name in ["Alias", "Linked", "External", "Escape", "Broken", "Loop"] {
        assert!(!directory.1.contains(name), "directory leaked {name}");
    }
    let real = s.get("/v/project/Real/Readme.md", &s.admin);
    assert_eq!(real.0, 200);
    assert!(real.1.contains("Visible"));
    let absent = s.get("/v/project/Missing.md", &s.admin);
    assert_eq!(absent.0, 404);
    for name in [
        "Alias.md",
        "Linked/Readme.md",
        "External/Secret.md",
        "Escape.md",
        "Broken.md",
        "Loop/Real/Readme.md",
    ] {
        let denied = s.get(&format!("/v/project/{name}"), &s.admin);
        assert_eq!((denied.0, denied.1), (absent.0, absent.1.clone()), "{name}");
    }
    let denied = s.get("/api/v1/vaults/project/notes", &s.user);
    assert_eq!(denied.0, 404);
    assert!(!denied.1.contains("Readme"));
    assert!(
        observer.events().is_empty(),
        "a link target was opened, read or modified"
    );
    // Positive control proves this observer can detect a real body read.
    std::fs::read(&secret).expect("observer control");
    assert!(!observer.events().is_empty());
}
