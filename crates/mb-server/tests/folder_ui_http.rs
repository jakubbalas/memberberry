#![cfg(target_os = "linux")]
#[path = "support/folder_ui_cases.rs"]
mod cases;
#[path = "support/vault_discovery.rs"]
mod discovery_fixture;
#[test]
fn folder_ui_html_and_public_assets_use_real_current_authorization_without_leaks() {
    cases::html_gate();
}
