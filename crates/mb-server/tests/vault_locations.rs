//! Config compatibility and lexical token invariants for project-folder vaults (SPEC §6.1).
#![allow(clippy::expect_used)] // why: fixture invariants and test assertions only.

use mb_server::ServerConfig;
use mb_server::vault_locations::{
    DirectoryName, DirectoryPathError, RelativeDirectoryPath, VaultLocation, VaultLocationId,
};
use proptest::prelude::*;

fn location_text(id: &str, name: &str, path: &str) -> String {
    // TOML's own encoder preserves control characters instead of accidentally making invalid TOML.
    let mut table = toml::Table::new();
    for (key, value) in [("id", id), ("name", name), ("path", path)] {
        table.insert(key.into(), toml::Value::String(value.into()));
    }
    format!(
        "[[vault_locations]]\n{}",
        toml::to_string(&table).expect("fixture TOML")
    )
}

#[test]
fn configured_locations_parse_without_accessing_the_filesystem() {
    let config = ServerConfig::parse(
        "[[vault_locations]]\nid = \"projects\"\nname = \"Projects 📚\"\npath = \"/not-mounted-yet/projects\"\n",
    );
    assert!(
        config.is_ok(),
        "valid structural config must not probe roots"
    );
}

#[test]
fn legacy_configs_round_trip_without_changing_vault_or_media_values() {
    let text = "bind = \"127.0.0.1:9010\"\nweb_root = \"web/dist\"\n\
        [[vaults]]\nslug = \"legacy\"\nname = \"Existing\"\npath = \"~/notes\"\n\
        [vaults.media]\nbackend = \"s3\"\nbucket = \"test-bucket\"\nregion = \"test-region\"\n\
        endpoint = \"http://127.0.0.1:9000\"\naccess_key_id = \"fixture-key\"\n\
        secret_access_key = \"fixture-secret\"\nallow_http = true\nvirtual_hosted_style = true\n";
    let config = ServerConfig::parse(text).expect("legacy config");
    let encoded = config.to_toml().expect("serialize");
    let reparsed = ServerConfig::parse(&encoded).expect("reparse");
    assert_eq!(config.bind, reparsed.bind);
    assert_eq!(config.web_root, reparsed.web_root);
    assert_eq!(config.vaults, reparsed.vaults);
    assert!(reparsed.vault_locations.is_empty());
    assert!(
        !encoded.contains("vault_locations"),
        "empty locations do not change legacy TOML shape"
    );
}

#[test]
fn defaults_and_absent_config_files_have_no_available_locations() {
    let dir = tempfile::tempdir().expect("fixture");
    assert!(ServerConfig::default().vault_locations.is_empty());
    assert!(
        ServerConfig::parse("")
            .expect("empty config")
            .vault_locations
            .is_empty()
    );
    assert!(
        ServerConfig::load(&dir.path().join("absent.toml"))
            .expect("absent config")
            .vault_locations
            .is_empty()
    );
}

#[test]
fn duplicate_ids_are_rejected_by_all_deserialization_paths_and_serialization() {
    let text = location_text("projects", "Projects", "/projects")
        + &location_text("projects", "Different", "/different");
    assert!(ServerConfig::parse(&text).is_err());
    assert!(
        toml::from_str::<ServerConfig>(&text).is_err(),
        "direct serde cannot bypass validation"
    );
    let mut config =
        ServerConfig::parse(&location_text("projects", "Projects", "/projects")).expect("config");
    config
        .vault_locations
        .extend(config.vault_locations.clone());
    assert!(
        config.to_toml().is_err(),
        "programmatic edits cannot persist duplicate ids"
    );
}

#[test]
fn malformed_identifiers_are_rejected_without_normalization() {
    for id in [
        "",
        "Projects",
        "with space",
        "with/slash",
        "../escape",
        "with_underscore",
        "é",
        "a%2fb",
        "-a",
        "a-",
        "a\n",
        "a\\b",
    ] {
        assert!(
            ServerConfig::parse(&location_text(id, "Projects", "/projects")).is_err(),
            "{id:?}"
        );
    }
    assert!(VaultLocationId::parse(&"a".repeat(64)).is_ok());
    assert!(VaultLocationId::parse(&"a".repeat(65)).is_err());
}

#[test]
fn blank_and_control_invalid_labels_are_rejected() {
    for name in ["", " ", "\t", "Projects\n", "a\0b", "a\u{85}b", "a\u{7f}b"] {
        assert!(
            ServerConfig::parse(&location_text("projects", name, "/projects")).is_err(),
            "{name:?}"
        );
    }
}

#[test]
fn invalid_absolute_path_shapes_are_rejected_structurally() {
    for path in [
        "",
        "projects",
        "~/projects",
        "./projects",
        "../projects",
        "/projects/../outside",
        "/projects/./child",
        "/projects//child",
        "//projects",
        "/projects/",
        "/projects\nchild",
        "/projects\0child",
        "/projects\\child",
        "C:\\Projects",
        "C:/Projects",
    ] {
        assert!(
            ServerConfig::parse(&location_text("projects", "Projects", path)).is_err(),
            "{path:?}"
        );
    }
    assert!(ServerConfig::parse(&location_text("projects", "Projects", "/")).is_ok());
    assert!(
        ServerConfig::parse(&location_text(
            "projects",
            "Projects",
            "/not-yet-mounted/.operator-root/日本"
        ))
        .is_ok()
    );
}

#[test]
fn missing_fields_wrong_types_and_unknown_location_keys_fail_closed() {
    for text in [
        "[[vault_locations]]\nid = 'projects'\npath = '/projects'",
        "[[vault_locations]]\nname = 'Projects'\npath = '/projects'",
        "[[vault_locations]]\nid = 'projects'\nname = 'Projects'",
        "[[vault_locations]]\nid = 1\nname = 'Projects'\npath = '/projects'",
        "[[vault_locations]]\nid = 'projects'\nname = 'Projects'\npath = '/projects'\nunknown = true",
        "vault_locations = 42",
    ] {
        assert!(ServerConfig::parse(text).is_err(), "{text}");
    }
}

#[test]
fn location_labels_and_unicode_paths_are_preserved_exactly() {
    let config = ServerConfig::parse(&location_text(
        "projects",
        " 📚 שלום Projects ",
        "/projects/e\u{301}/日本",
    ))
    .expect("config");
    let entry = config.vault_locations.first().expect("entry");
    assert_eq!(entry.name(), " 📚 שלום Projects ");
    assert_eq!(entry.path().to_str(), Some("/projects/e\u{301}/日本"));
    let decoded = ServerConfig::parse(&config.to_toml().expect("serialize")).expect("reparse");
    assert_eq!(decoded.vault_locations, config.vault_locations);
}

#[test]
fn empty_token_is_browse_only_and_not_a_selection_or_single_name() {
    assert!(
        RelativeDirectoryPath::for_browse("")
            .expect("root browse")
            .is_root()
    );
    assert_eq!(
        RelativeDirectoryPath::for_selection(""),
        Err(DirectoryPathError::EmptySelection)
    );
    assert!(DirectoryName::parse("").is_err());
}

#[test]
fn unsafe_relative_paths_are_rejected_rather_than_repaired() {
    for raw in [
        "/absolute",
        "//server/share",
        "../escape",
        ".",
        "..",
        "a/../b",
        "a/./b",
        ".hidden",
        "a/.hidden/b",
        "a//b",
        "a/",
        "a\\b",
        "a\0b",
        "a\nb",
        "a\rb",
        "a/\t/b",
        "a\u{85}b",
        "C:/Projects",
        "C:Projects",
        "a/C:Projects",
        "z:",
        "C:\\Projects",
        " ",
    ] {
        assert!(RelativeDirectoryPath::for_browse(raw).is_err(), "{raw:?}");
        assert!(
            RelativeDirectoryPath::for_selection(raw).is_err(),
            "{raw:?}"
        );
    }
}

#[test]
fn single_names_reject_multiple_components_and_oversize_utf8() {
    assert!(DirectoryName::parse("a/b").is_err());
    assert!(DirectoryName::parse(&"a".repeat(255)).is_ok());
    assert!(DirectoryName::parse(&"a".repeat(256)).is_err());
    assert!(DirectoryName::parse(&"📚".repeat(64)).is_err());
}

#[test]
fn unicode_directory_tokens_and_component_boundaries_are_preserved() {
    for raw in [
        "日本/שלום/📚",
        "e\u{301}/é",
        " nested /with space",
        "Project..name",
        "a~b",
    ] {
        assert_eq!(
            RelativeDirectoryPath::for_selection(raw)
                .expect("token")
                .as_str(),
            raw
        );
    }
}

#[test]
fn repair_literal_colon_and_percent_names_parse_and_compose_exactly() {
    let parent = RelativeDirectoryPath::for_browse("Parent").expect("parent");
    for raw in [
        "Design: notes",
        ": notes",
        "1: notes",
        "é: notes",
        "100% Complete",
        "%2e%2e",
        "%2f",
        "%5c",
        "%252e%252e",
        "日本: e\u{301} 50%",
    ] {
        let name = DirectoryName::parse(raw).expect("ordinary literal name");
        assert_eq!(name.as_str(), raw);
        assert_eq!(
            RelativeDirectoryPath::for_selection(raw)
                .expect("literal token")
                .as_str(),
            raw
        );
        let composed = parent.child(&name);
        assert_eq!(composed.as_str(), format!("Parent/{raw}"));
        assert_eq!(
            RelativeDirectoryPath::for_selection(composed.as_str()).expect("reparse"),
            composed
        );
    }
}

fn safe_name() -> impl Strategy<Value = String> {
    proptest::collection::vec(
        proptest::sample::select(vec![
            "a", "Z", "é", "e\u{301}", "日本", "שלום", "📚", "_", " ",
        ]),
        1..15,
    )
    .prop_map(|parts| parts.concat())
    .prop_filter("not blank", |name| !name.trim().is_empty())
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 256, rng_seed: proptest::test_runner::RngSeed::Fixed(20261009), ..ProptestConfig::default() })]
    #[test]
    fn valid_token_composition_round_trips_without_normalization(parts in proptest::collection::vec(safe_name(), 1..8)) {
        eprintln!("proptest seed: 20261009");
        let raw = parts.join("/");
        let token = RelativeDirectoryPath::for_selection(&raw).expect("token");
        prop_assert_eq!(token.as_str(), raw.as_str());
        let mut built = RelativeDirectoryPath::for_browse("").expect("root");
        for part in parts { built = built.child(&DirectoryName::parse(&part).expect("name")); }
        prop_assert_eq!(built, token);
    }

    #[test]
    fn injecting_unsafe_components_never_becomes_a_valid_path(prefix in safe_name(), suffix in safe_name(), bad in proptest::sample::select(vec![".", "..", ".hidden", "", "back\\slash", "a\nb", "C:drive"])) {
        eprintln!("proptest seed: 20261009");
        let raw = format!("{prefix}/{bad}/{suffix}");
        prop_assert!(RelativeDirectoryPath::for_browse(&raw).is_err());
    }

    #[test]
    fn repair_literal_punctuation_composition_preserves_all_bytes(prefix in safe_name(), suffix in safe_name(), literal in proptest::sample::select(vec!["Design: notes", "100% Complete", "%2e%2e", "%2f", "%5c", "%252e%252e"])) {
        eprintln!("proptest seed: 20261009");
        let raw_name = format!("{literal}{suffix}");
        let name = DirectoryName::parse(&raw_name).expect("literal name");
        prop_assert_eq!(name.as_str(), raw_name.as_str());
        let parent = RelativeDirectoryPath::for_browse(&prefix).expect("parent");
        let composed = parent.child(&name);
        let raw_path = format!("{prefix}/{raw_name}");
        prop_assert_eq!(composed.as_str(), raw_path.as_str());
        prop_assert_eq!(RelativeDirectoryPath::for_selection(&raw_path).expect("reparse"), composed);
    }

    #[test]
    fn config_round_trips_locations_and_preserves_media_values(name in safe_name(), root in safe_name(), s3 in any::<bool>()) {
        eprintln!("proptest seed: 20261009");
        let location = VaultLocation::new(VaultLocationId::parse("projects").expect("id"), &name, &format!("/projects/{root}")).expect("location");
        let media = if s3 {
            mb_server::MediaBackendConfig::S3 { bucket: "fixture-bucket".into(), region: "fixture-region".into(), endpoint: Some("http://127.0.0.1:9000".into()), access_key_id: "fixture-key".into(), secret_access_key: "fixture-secret".into(), allow_http: true, virtual_hosted_style: true }
        } else { mb_server::MediaBackendConfig::Local };
        let original = ServerConfig {
            bind: Some("127.0.0.1:9010".into()), web_root: Some("web/dist".into()), vault_locations: vec![location],
            vaults: vec![mb_server::config::VaultEntry { slug: "existing".into(), name: Some("Existing".into()), path: "~/Existing".into(), media, notes_layout: mb_server::config::NotesLayout::Auto, ignore_non_writable_folders: false }],
        };
        let restored = ServerConfig::parse(&original.to_toml().expect("serialize")).expect("reparse");
        prop_assert_eq!(restored.vault_locations, original.vault_locations);
        prop_assert_eq!(restored.vaults, original.vaults);
        prop_assert_eq!(restored.bind, original.bind);
        prop_assert_eq!(restored.web_root, original.web_root);
    }
}
