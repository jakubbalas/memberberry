#![cfg(target_os = "linux")]
#![allow(
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::panic,
    clippy::indexing_slicing
)] // why: test assertions deliberately fail on malformed/missing JSON and out-of-order fixture rows.
#[path = "support/vault_discovery.rs"]
mod fixture;
use fixture::{Server, encode, json};
const BASE: &str = "/api/v1/vault-locations";

#[test]
fn discovery_locations_and_immediate_children_are_safe_current_metadata() {
    let s = Server::new(true);
    let (status, body, head) = s.get(BASE, &s.admin);
    assert_eq!(status, 200);
    assert_eq!(
        json(&body),
        serde_json::json!({"locations":[{"id":"projects","name":"Projects"}]})
    );
    assert!(
        head.to_ascii_lowercase()
            .contains("cache-control: no-store")
    );
    let (status, body, _) = s.get(&format!("{BASE}/projects/directories?path="), &s.admin);
    assert_eq!(status, 200);
    let value = json(&body);
    assert_eq!(value["state"]["location_root"], true);
    assert_eq!(value["state"]["selectable"], false);
    assert_eq!(value["children"][0]["path"], "Public");
    assert_eq!(
        value["children"][1]["state"]["registration"],
        "already_registered"
    );
    for private in [
        "PrivateChildName",
        "PrivateTitle",
        "PrivateBody",
        "PrivateLabel",
        s.dir.path().to_str().unwrap(),
    ] {
        assert!(!body.contains(private));
    }
    let (status, body, _) = s.get(&format!("{BASE}/projects/status?path=Registered"), &s.admin);
    assert_eq!(status, 200);
    assert_eq!(json(&body)["state"]["browsable"], false);
    for path in ["Registered", "Registered/PrivateChildName"] {
        assert_eq!(
            s.get(
                &format!("{BASE}/projects/directories?path={}", encode(path)),
                &s.admin
            )
            .0,
            404
        );
    }
    let mut config = s.config();
    config.vault_locations.clear();
    s.save(&config);
    assert_eq!(
        json(&s.get(BASE, &s.admin).1),
        serde_json::json!({"locations":[]})
    );
    assert_eq!(
        s.get(&format!("{BASE}/projects/status?path=Public"), &s.admin)
            .0,
        404
    );
}

#[test]
fn discovery_real_wire_decodes_exactly_once_and_rejects_malformed_syntax() {
    let s = Server::new(false);
    for name in [
        "Design: notes",
        "100% Complete",
        "%2e%2e",
        "%2f",
        "%5c",
        "%252e%252e",
        "日本 📚",
        "a+b",
    ] {
        std::fs::create_dir(s.dir.path().join("Projects").join(name)).expect("literal directory");
        for route in ["directories", "status"] {
            let (status, body, _) = s.get(
                &format!("{BASE}/projects/{route}?path={}", encode(name)),
                &s.admin,
            );
            assert_eq!(status, 200, "{name}: {body}");
            assert_eq!(json(&body)["path"], name);
        }
    }
    for (wire, literal) in [
        ("Design%3A+notes", "Design: notes"),
        ("100%25+Complete", "100% Complete"),
        ("%252e%252e", "%2e%2e"),
        ("%252f", "%2f"),
        ("%255c", "%5c"),
        ("%25252e%25252e", "%252e%252e"),
    ] {
        let (status, body, _) = s.get(&format!("{BASE}/projects/status?path={wire}"), &s.admin);
        assert_eq!(status, 200);
        assert_eq!(json(&body)["path"], literal);
    }
    for raw in [
        "%2e%2e",
        "%2f",
        "%5c",
        "%00",
        "%GG",
        "%",
        "%FF",
        ".hidden",
        "C%3Afoo",
        "Public%2F..",
        "Public//X",
        "%2Fabsolute",
        "path=Public&path=Public",
        "Public&other=x",
    ] {
        let query = if raw.starts_with("path=") {
            raw.to_string()
        } else {
            format!("path={raw}")
        };
        assert_eq!(
            s.get(&format!("{BASE}/projects/status?{query}"), &s.admin)
                .0,
            400,
            "wire {raw}"
        );
    }
    assert_eq!(
        s.get(&format!("{BASE}/%70rojects/status?path=Public"), &s.admin)
            .0,
        400,
        "ids are literal route tokens, no alternate encoded spelling"
    );
}

#[test]
fn discovery_limits_refuse_entire_lists_and_bound_config_and_queries() {
    let s = Server::new(false);
    for n in 0..4097 {
        std::fs::write(s.dir.path().join("Projects").join(format!("f-{n}")), "").expect("file");
    }
    let response = s.get(&format!("{BASE}/projects/directories?path="), &s.admin);
    assert_eq!(response.0, 422);
    assert_eq!(
        json(&response.1),
        serde_json::json!({"error":"limit_exceeded"})
    );
    assert_eq!(
        s.get(
            &format!("{BASE}/projects/status?path={}", "a".repeat(1025)),
            &s.admin
        )
        .0,
        422
    );
    assert_eq!(
        s.get(
            &format!("{BASE}/projects/status?path={}", "a/".repeat(17)),
            &s.admin
        )
        .0,
        422
    );
    std::fs::write(
        s.dir.path().join("server.toml"),
        "#".repeat(1024 * 1024 + 1),
    )
    .expect("overlarge config");
    assert_eq!(s.get(BASE, &s.admin).0, 422);
}

#[test]
fn discovery_seeded_real_http_literal_roundtrip_and_order_are_invariant() {
    use proptest::{
        prelude::*,
        test_runner::{Config, RngSeed, TestRunner},
    };
    let s = Server::new(false);
    println!("real HTTP literal/order property seed=20261009");
    let mut runner = TestRunner::new(Config {
        cases: 16,
        rng_seed: RngSeed::Fixed(20261009),
        failure_persistence: None,
        ..Config::default()
    });
    runner
        .run(
            &(
                "[a-z]{2,10}",
                proptest::sample::select(vec![
                    "日本",
                    "%2e%2e",
                    "%2f",
                    "%5c",
                    "Design: notes",
                    "100% Complete",
                    "é",
                ]),
            ),
            |(prefix, suffix)| {
                let name = format!("{prefix}-{suffix}");
                std::fs::create_dir_all(s.dir.path().join("Projects").join(&name))
                    .expect("literal fixture");
                let (code, body, _) = s.get(
                    &format!("{BASE}/projects/status?path={}", encode(&name)),
                    &s.admin,
                );
                prop_assert_eq!(code, 200);
                let decoded = json(&body);
                prop_assert_eq!(decoded["path"].as_str(), Some(name.as_str()));
                let (code, body, _) =
                    s.get(&format!("{BASE}/projects/directories?path="), &s.admin);
                prop_assert_eq!(code, 200);
                let value = json(&body);
                let names = value["children"]
                    .as_array()
                    .expect("children")
                    .iter()
                    .map(|c| c["name"].as_str().expect("name"))
                    .collect::<Vec<_>>();
                prop_assert!(names.windows(2).all(|p| p[0] < p[1]));
                prop_assert!(names.contains(&name.as_str()));
                Ok(())
            },
        )
        .expect("HTTP roundtrip/order");
}

#[test]
fn discovery_metadata_counts_labels_and_server_paths_are_explicit_limits() {
    use mb_server::vault_locations::{VaultLocation, VaultLocationId};
    let s = Server::new(false);
    let mut config = s.config();
    config.vault_locations = (0..33)
        .map(|i| {
            VaultLocation::new(
                VaultLocationId::parse(&format!("root-{i}")).expect("id"),
                "Label",
                s.dir.path().join("Projects").to_str().expect("path"),
            )
            .expect("location")
        })
        .collect();
    s.save(&config);
    assert_eq!(s.get(BASE, &s.admin).0, 422);
    config.vault_locations = (0..32)
        .map(|i| {
            VaultLocation::new(
                VaultLocationId::parse(&format!("root-{i}")).expect("id"),
                &"x".repeat(256),
                "/missing",
            )
            .expect("valid location")
        })
        .collect();
    s.save(&config);
    assert_eq!(
        s.get(BASE, &s.admin).0,
        422,
        "metadata byte budget, not count"
    );
    config.vault_locations = vec![
        VaultLocation::new(
            VaultLocationId::parse("projects").expect("id"),
            &"x".repeat(257),
            "/missing",
        )
        .expect("valid persisted long label"),
    ];
    s.save(&config);
    assert_eq!(s.get(BASE, &s.admin).0, 422);
    config.vault_locations = vec![
        VaultLocation::new(
            VaultLocationId::parse("projects").expect("id"),
            "Projects",
            &format!("/{}", "a/".repeat(65).trim_end_matches('/')),
        )
        .expect("valid persisted deep root"),
    ];
    s.save(&config);
    assert_eq!(s.get(BASE, &s.admin).0, 422);
    assert_eq!(
        s.get(
            &format!("{BASE}/projects/status?path={}", "%61".repeat(1400)),
            &s.admin
        )
        .0,
        422
    );
    std::fs::write(
        s.dir.path().join("server.toml"),
        "[[vault_locations]]\nid='projects'\nname='SecretConfigLabel'\npath='/unsafe/../private'\n",
    )
    .expect("invalid config");
    let (code, body, _) = s.get(BASE, &s.admin);
    assert_eq!(code, 404);
    assert_eq!(json(&body), serde_json::json!({"error":"not_found"}));
}

#[test]
fn discovery_missing_unsafe_and_live_registry_changes_fail_closed() {
    let s = Server::new(true);
    std::os::unix::fs::symlink(
        s.dir.path().join("Projects/Public"),
        s.dir.path().join("Projects/Escape"),
    )
    .expect("symlink");
    assert_eq!(
        s.get(&format!("{BASE}/projects/status?path=Escape"), &s.admin)
            .0,
        404
    );
    assert_eq!(
        s.get(&format!("{BASE}/projects/status?path=Absent"), &s.admin)
            .0,
        404
    );
    let mut config = s.config();
    config.vaults.clear();
    s.save(&config);
    assert_eq!(
        s.get(&format!("{BASE}/projects/directories?path="), &s.admin)
            .0,
        404,
        "registry drift must not remove a live boundary"
    );
}

#[test]
fn discovery_missing_roots_nonregular_config_and_failures_release_resources() {
    use mb_server::vault_locations::{VaultLocation, VaultLocationId};
    let s = Server::new(false);
    let mut config = s.config();
    config.vault_locations = vec![
        VaultLocation::new(
            VaultLocationId::parse("projects").expect("id"),
            "Projects",
            s.dir.path().join("Absent").to_str().expect("path"),
        )
        .expect("location"),
    ];
    s.save(&config);
    assert_eq!(
        s.get(BASE, &s.admin).0,
        200,
        "metadata is not an availability probe"
    );
    for _ in 0..4 {
        assert_eq!(
            s.get(&format!("{BASE}/projects/directories?path="), &s.admin)
                .0,
            404
        );
    }
    let path = s.dir.path().join("server.toml");
    std::fs::remove_file(&path).expect("remove config");
    assert!(
        std::process::Command::new("mkfifo")
            .arg(&path)
            .status()
            .expect("FIFO fixture")
            .success()
    );
    assert_eq!(s.get(BASE, &s.admin).0, 404, "FIFO refuses nonblockingly");
    std::fs::remove_file(path).expect("remove FIFO");
    config.vault_locations.clear();
    s.save(&config);
    assert_eq!(
        json(&s.get(BASE, &s.admin).1),
        serde_json::json!({"locations":[]})
    );
}

#[test]
fn discovery_global_rate_budget_is_bounded() {
    let s = Server::new(false);
    for _ in 0..60 {
        assert_eq!(s.get(BASE, &s.admin).0, 200);
    }
    let (status, body, _) = s.get(BASE, &s.admin);
    assert_eq!(status, 429);
    assert_eq!(json(&body), serde_json::json!({"error":"busy"}));
}
