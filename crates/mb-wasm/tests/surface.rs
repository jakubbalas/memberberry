//! The wasm surface, tested natively.
//!
//! Everything here is a thin wrapper by design (`SPEC.md` §5.2 — one implementation, two
//! targets), so what is worth testing is the *shape* that crosses the boundary rather than
//! the Markdown behaviour underneath, which `mb-core`'s own suite covers.
//!
//! The JavaScript half of this lives in `web/src/notes.test.ts` and runs against real
//! WebAssembly. Both are needed: this one catches a wrong field before a browser is
//! involved, that one catches a wrong *encoding* — it is how `None` arriving as `undefined`
//! instead of `null` was found.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use mb_wasm::{facts_of, normalize, note_title, schema_json, to_html};

#[test]
fn normalize_is_the_canonical_form_the_server_writes() {
    assert_eq!(normalize("* item\n_em_\n"), "- item\n  *em*\n");
}

#[test]
fn to_html_applies_the_prefixes_it_is_given() {
    let html = to_html("[[Some Note]]\n", "/v/p/", "/m/");
    assert!(html.contains("href=\"/v/p/Some%20Note\""), "{html}");
}

#[test]
fn to_html_escapes_note_content() {
    let html = to_html("<script>alert(1)</script>\n", "", "");
    assert!(!html.contains("<script"), "{html}");
    assert!(html.contains("&lt;script&gt;"), "{html}");
}

#[test]
fn note_title_is_none_when_there_is_nothing_titleable() {
    assert_eq!(note_title("# T\n").as_deref(), Some("T"));
    assert_eq!(note_title("***\n"), None);
}

#[test]
fn facts_carry_every_field_the_typescript_side_declares() {
    // If a field is added here it must be added to `Facts` in `web/src/notes.ts` too; the
    // boundary test there fails when the two disagree.
    let facts = facts_of(
        "---\ntags: [alpha]\n---\n\n# Title\n\nSee [[A]] and ![[B|shown]] #beta ^a1\n\n\
         - [ ] task 📅 2026-09-05\n\n![x](media/y.png)\n\n:tada:\n",
    );
    assert_eq!(facts.title.as_deref(), Some("Title"));
    assert_eq!(facts.tags, ["alpha", "beta"]);
    assert_eq!(facts.emoji, ["tada"]);
    assert_eq!(facts.anchors, ["a1"]);
    assert_eq!(facts.media, ["media/y.png"]);
    assert_eq!(facts.headings.len(), 1);
    assert_eq!(facts.headings[0].level, 1);
    assert_eq!(facts.headings[0].text, "Title");
    assert!(facts.word_count > 0);

    assert_eq!(facts.links.len(), 2);
    assert_eq!(facts.links[0].target, "A");
    assert!(!facts.links[0].embed);
    assert!(facts.links[1].embed);
    assert_eq!(facts.links[1].alias.as_deref(), Some("shown"));

    assert_eq!(facts.tasks.len(), 1);
    assert_eq!(facts.tasks[0].status, "todo");
    assert_eq!(facts.tasks[0].text, "task");
    assert_eq!(facts.tasks[0].due.as_deref(), Some("2026-09-05"));
}

#[test]
fn a_link_anchor_flattens_to_its_text_whichever_kind_it_is() {
    // `Option<Anchor>` is an enum on the Rust side and a nullable string on the other.
    let heading = facts_of("[[A#Heading]]\n");
    assert_eq!(heading.links[0].anchor.as_deref(), Some("Heading"));
    let block = facts_of("[[A#^block-id]]\n");
    assert_eq!(block.links[0].anchor.as_deref(), Some("block-id"));
    let none = facts_of("[[A]]\n");
    assert_eq!(none.links[0].anchor, None);
}

#[test]
fn every_task_status_has_the_name_typescript_expects() {
    let facts = facts_of("- [ ] a\n- [x] b\n- [-] c\n");
    let statuses: Vec<&str> = facts.tasks.iter().map(|t| t.status.as_str()).collect();
    assert_eq!(statuses, ["todo", "done", "cancelled"]);
}

#[test]
fn an_empty_note_yields_empty_collections_rather_than_nothing() {
    let facts = facts_of("");
    assert_eq!(facts.title, None);
    assert!(facts.links.is_empty());
    assert!(facts.tags.is_empty());
    assert!(facts.tasks.is_empty());
    assert_eq!(facts.word_count, 0);
}

#[test]
fn the_schema_shipped_to_the_browser_is_the_one_the_crate_is_held_to() {
    // M3 generates the Tiptap schema from this string, so it must be the same file
    // `mb-core/tests/schema.rs` pins the Rust side against — not a copy.
    let shipped = schema_json();
    assert_eq!(shipped, include_str!("../../mb-core/schema.json"));
    assert!(shipped.contains("\"topNode\": \"doc\""), "{shipped}");
}
