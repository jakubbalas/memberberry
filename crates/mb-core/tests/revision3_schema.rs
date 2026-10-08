//! Revision identity and native/namespace Code exclusions are one coordinated contract.
// why: integration tests, not library code (AGENTS.md 4.2) — a panic is the failure report.
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]
#[test]
fn rust_owned_revision_three_schema_has_exact_coordinated_marks() {
    let schema: serde_json::Value =
        serde_json::from_str(include_str!("../schema.json")).expect("schema");
    assert_eq!(schema["version"], 3);
    assert_eq!(mb_core::schema::VERSION, 3);
    assert_eq!(
        schema["marks"]["code"]["excludes"],
        "code mb_underline mb_color mb_background mb_size"
    );
    for name in ["mb_underline", "mb_color", "mb_background", "mb_size"] {
        assert_eq!(schema["marks"][name]["excludes"], format!("{name} code"));
    }
}
