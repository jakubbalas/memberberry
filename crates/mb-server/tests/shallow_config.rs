//! Persisted exact roots and backward-compatible finite selection.
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)] // why: test-only assertions.
use mb_server::{ServerConfig, config::NotesLayout};
#[test]
fn omitted_auto_is_not_serialized_and_unknown_selectors_refuse() {
    for setting in ["", "notes_layout='auto'\n"] {
        let config = ServerConfig::parse(&format!(
            "[[vaults]]\nslug='test'\npath='/absent'\n{setting}"
        ))
        .expect("old config");
        assert_eq!(config.vaults[0].notes_layout, NotesLayout::Auto);
        assert!(
            !config
                .to_toml()
                .expect("serialization")
                .contains("notes_layout")
        );
    }
    for value in ["notes", "ROOT", "root/", "unknown", ""] {
        assert!(
            ServerConfig::parse(&format!(
                "[[vaults]]\nslug='test'\npath='/absent'\nnotes_layout='{value}'\n"
            ))
            .is_err()
        );
    }
}
#[test]
fn explicit_root_survives_reopen_and_auto_layout_still_selects_notes() {
    let dir = tempfile::tempdir().expect("fixture");
    std::fs::create_dir(dir.path().join("notes")).expect("notes");
    std::fs::write(dir.path().join("Root.md"), "# Root\n").expect("note");
    std::fs::write(dir.path().join("notes/Child.md"), "# Child\n").expect("note");
    for (selector, expected) in [
        ("auto", dir.path().join("notes")),
        ("root", dir.path().to_path_buf()),
    ] {
        let text = format!(
            "[[vaults]]\nslug='test'\npath='{}'\nnotes_layout='{selector}'\n",
            dir.path().display()
        );
        let config = ServerConfig::parse(&text).expect("config");
        let reopened = ServerConfig::parse(&config.to_toml().expect("persist"))
            .expect("parse")
            .open_vaults(None)
            .expect("open");
        assert_eq!(reopened[0].notes_root(), expected);
    }
}
proptest::proptest! {
    #![proptest_config(proptest::test_runner::Config {cases:32,rng_seed:proptest::test_runner::RngSeed::Fixed(5005),..Default::default()})]
    #[test]
    fn layout_roundtrip_does_not_migrate_old_entries(root in proptest::bool::ANY) {
        let selector=if root {"root"}else{"auto"};
        let config=ServerConfig::parse(&format!("[[vaults]]\nslug='test'\npath='/absent'\nnotes_layout='{selector}'\n")).expect("config");
        let restored=ServerConfig::parse(&config.to_toml().expect("serialize")).expect("restore");
        proptest::prop_assert_eq!(&restored.vaults,&config.vaults);
    }
}
