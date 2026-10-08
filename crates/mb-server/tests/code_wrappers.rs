//! Focused actual coordinator/durable-file proof; not authenticated wire certification.
// why: integration tests, not library code (AGENTS.md 4.2) — a panic is the failure report.
#![allow(
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::panic
)]
mod support;
use mb_crdt::{
    apply_external_markdown, document_from_update_v1, document_from_yrs, encode_update_v1,
};
use mb_server::{
    Vault,
    sync::{MARKDOWN_WRITE_DEBOUNCE, NoteCoordinator},
    vault::Slug,
};
use std::collections::BTreeMap;
use std::path::Path;
use std::time::Instant;
use yrs::{ReadTxn, Text, Transact, XmlFragment};
fn snapshot(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fn visit(root: &Path, path: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for item in std::fs::read_dir(path).unwrap() {
            let p = item.unwrap().path();
            if p.is_dir() {
                visit(root, &p, out)
            } else {
                out.insert(
                    p.strip_prefix(root).unwrap().to_string_lossy().into_owned(),
                    std::fs::read(&p).unwrap(),
                );
            }
        }
    }
    let mut out = BTreeMap::new();
    visit(root, root, &mut out);
    out
}
#[test]
fn ordinary_code_wrappers_open_accept_save_and_durably_reopen() {
    for body in [
        "**`literal`**\n",
        "_`literal`_\n",
        "~~`literal`~~\n",
        "==`literal`==\n",
        "[`literal`](https://example.org \"Authored title\")\n",
    ] {
        let dir = support::TempDir::new("code-wrappers");
        let note = dir.write("notes/One.md", body);
        let vault = Vault::open(Slug::parse("personal").unwrap(), "Personal", dir.path()).unwrap();
        let canonical = vault.canonical_note("One.md").unwrap();
        let mut coordinator = NoteCoordinator::open(&vault, &canonical).unwrap();
        let remote = document_from_update_v1(&coordinator.full_update()).unwrap();
        assert_eq!(document_from_yrs(&remote).unwrap(), mb_core::parse(body));
        let vector = remote.transact().state_vector();
        let changed = body.replace("literal", "literalZ");
        apply_external_markdown(&remote, &changed).unwrap();
        let now = Instant::now();
        coordinator
            .apply_remote_update(&remote.transact().encode_state_as_update_v1(&vector), now)
            .unwrap();
        coordinator
            .flush_if_due(now + MARKDOWN_WRITE_DEBOUNCE)
            .unwrap();
        assert_eq!(
            mb_core::parse(&std::fs::read_to_string(&note).unwrap()),
            mb_core::parse(&changed)
        );
        drop(coordinator);
        let reopened = NoteCoordinator::open(&vault, &canonical).unwrap();
        assert_eq!(
            document_from_yrs(&document_from_update_v1(&reopened.full_update()).unwrap()).unwrap(),
            mb_core::parse(&changed)
        );
    }
}
#[test]
fn invalid_code_payload_refuses_before_sidecar_live_or_markdown_mutation() {
    let dir = support::TempDir::new("code-refusal");
    dir.write("notes/One.md", "`literal`\n");
    let vault = Vault::open(Slug::parse("personal").unwrap(), "Personal", dir.path()).unwrap();
    let canonical = vault.canonical_note("One.md").unwrap();
    let mut coordinator = NoteCoordinator::open(&vault, &canonical).unwrap();
    let before = coordinator.full_update();
    let files = snapshot(dir.path());
    let remote = document_from_update_v1(&before).unwrap();
    let vector = remote.transact().state_vector();
    {
        let mut txn = remote.transact_mut();
        let root = txn.get_xml_fragment("prosemirror").unwrap();
        let p = root.get(&txn, 0).unwrap().into_xml_element().unwrap();
        let t = p.get(&txn, 0).unwrap().into_xml_text().unwrap();
        t.format(
            &mut txn,
            0,
            7,
            std::collections::HashMap::from([("code".into(), yrs::Any::Bool(true))]),
        );
    }
    let update = remote.transact().encode_state_as_update_v1(&vector);
    assert!(
        coordinator
            .apply_remote_update(&update, Instant::now())
            .is_err()
    );
    assert_eq!(coordinator.full_update(), before);
    assert_eq!(snapshot(dir.path()), files);
    let _ = encode_update_v1(&remote);
}
