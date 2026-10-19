//! Permanent S1 HTTP/permission regressions for the approved conservative guard.
#![cfg(target_os = "linux")]
#[path = "support/policy_layout_leak_cases.rs"]
mod cases;
#[path = "support/vault_registration.rs"]
mod registration_fixture;
#[test]
fn legacy_and_root_relative_rules_with_notes_refuse_without_adoption_or_disclosure() {
    cases::refuses_ambiguous_policy_without_adoption_or_disclosure();
}
#[test]
fn initial_guard_and_strict_authority_have_observer_positive_controls() {
    cases::strict_authority_and_initial_refusal_have_real_no_io_controls();
}
#[test]
fn selected_root_policy_only_and_no_notes_scoped_denial_are_preserved() {
    cases::selected_root_only_and_no_notes_scoped_policy_controls();
}
#[test]
fn malformed_selected_root_policy_has_no_nested_fallback() {
    cases::malformed_selected_policy_is_not_rescued_by_shadow();
}
