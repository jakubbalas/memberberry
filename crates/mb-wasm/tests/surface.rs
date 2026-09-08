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

use mb_search::{AclHash, Change, Note, Segment, ZoneId};
use mb_wasm::{
    conflict_count, daily_path_inner, expand_template_inner, facts_of, merge_search_segments_inner,
    merge_with_conflicts, normalize, note_title, periodic_path_inner, resolve_conflict,
    schema_json, search_segments_inner, to_html, validate_search_segment_inner,
};

fn compact_segment(word: &str) -> Vec<u8> {
    Segment::build(
        ZoneId::from_hex(&"a".repeat(64)).expect("zone"),
        AclHash::from_hex(&"b".repeat(64)).expect("hash"),
        [Change::Upsert(Note {
            id: None,
            title: "Title".to_string(),
            path: "Note.md".to_string(),
            tags: Vec::new(),
            icon: None,
            text: word.to_string(),
        })],
    )
    .expect("segment")
    .as_bytes()
    .to_vec()
}

#[test]
fn calendar_and_template_boundaries_validate_wire_strings() {
    assert_eq!(
        daily_path_inner("Daily/", "%d-%m-%Y.md", "2026-09-08").expect("daily path"),
        "Daily/08-09-2026.md"
    );
    assert_eq!(
        periodic_path_inner("weekly", "Weekly/", "%G-W%V.md", "2021-01-01").expect("weekly path"),
        "Weekly/2020-W53.md"
    );
    assert!(periodic_path_inner("quarterly", "Q/", "%Y.md", "2026-09-08").is_err());
    assert!(daily_path_inner("Daily/", "%Y-%m-%d.md", "not-a-date").is_err());

    let expanded = expand_template_inner(
        "# {{title}} {{time}}",
        "2026-09-08",
        "07:08:09",
        "Plan",
        "",
        "id",
        "Alice",
    )
    .expect("template");
    assert_eq!(expanded.text, "# Plan 07:08:09");
    assert!(expand_template_inner("", "2026-09-08", "24:00:00", "", "", "", "").is_err());
}

#[test]
fn compact_search_bytes_are_validated_and_merge_only_inside_one_acl_epoch() {
    let base = compact_segment("before");
    validate_search_segment_inner(&base).expect("valid segment");
    assert!(validate_search_segment_inner(&base[..40]).is_err());
    let merged = merge_search_segments_inner(&base, &compact_segment("after")).expect("merge");
    validate_search_segment_inner(&merged).expect("merged segment");
}

#[test]
fn compact_segments_are_queried_as_one_permission_filtered_union() {
    let results =
        search_segments_inner("body:road", [compact_segment("roadmap body")]).expect("search");
    assert_eq!(results.hits.len(), 1);
    assert_eq!(results.hits[0].path, "Note.md");
    assert!(!results.phrase_degraded);
}

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

#[test]
fn merging_marks_a_divergence_and_counts_it() {
    let merged = merge_with_conflicts(
        Some("Base.\n".to_string()),
        "Mine.\n",
        "Theirs.\n",
        "2026-08-28T22:41:07Z",
    );
    assert!(merged.starts_with("Mine.\n"), "{merged}");
    assert!(merged.contains("[!conflict]"), "{merged}");
    assert_eq!(conflict_count(&merged), 1);
    assert_eq!(conflict_count("Mine.\n"), 0);
}

#[test]
fn a_base_the_local_side_matches_takes_their_version_without_marking_it() {
    // The case that decides whether this feature is usable: somebody else edited a note this
    // device merely held. Crossing the boundary must not lose the base, or every reconnection
    // in a shared vault produces a callout.
    let merged = merge_with_conflicts(Some("Base.\n".to_string()), "Base.\n", "Theirs.\n", "now");
    assert_eq!(merged, "Theirs.\n");
    assert_eq!(conflict_count(&merged), 0);
}

#[test]
fn a_missing_base_degrades_to_the_two_way_comparison() {
    // `undefined` from JavaScript, which is a note this device has never synced.
    let merged = merge_with_conflicts(None, "Mine.\n", "Theirs.\n", "now");
    assert_eq!(conflict_count(&merged), 1, "{merged}");
    assert!(merged.starts_with("Mine.\n"), "{merged}");
}

#[test]
fn resolving_takes_the_side_it_is_named() {
    let merged = merge_with_conflicts(None, "Mine.\n", "Theirs.\n", "now");
    assert_eq!(resolve_conflict(&merged, 0, "mine"), "Mine.\n");
    assert_eq!(resolve_conflict(&merged, 0, "theirs"), "Theirs.\n");
    assert_eq!(resolve_conflict(&merged, 0, "both"), "Mine.\n\nTheirs.\n");
}

#[test]
fn an_unknown_resolution_changes_nothing() {
    // The argument crosses a language boundary as a string, so a typo on the JavaScript side
    // has to be inert rather than destructive.
    let merged = merge_with_conflicts(None, "Mine.\n", "Theirs.\n", "now");
    assert_eq!(resolve_conflict(&merged, 0, "neither"), merged);
    assert_eq!(resolve_conflict(&merged, 99, "mine"), merged);
}

#[test]
fn compact_phrase_queries_mark_degradation_and_sort_hits_by_path() {
    let zebra = Segment::build(
        ZoneId::from_hex(&"a".repeat(64)).expect("zone"),
        AclHash::from_hex(&"b".repeat(64)).expect("hash"),
        [Change::Upsert(Note {
            id: None,
            title: "Z".to_string(),
            path: "Z.md".to_string(),
            tags: vec!["t".to_string()],
            icon: Some("i".to_string()),
            text: "roadmap body".to_string(),
        })],
    )
    .expect("segment")
    .as_bytes()
    .to_vec();
    let alpha = compact_segment("roadmap body");
    let results =
        search_segments_inner("\"roadmap body\"", [zebra, alpha.clone()]).expect("search");
    assert!(results.phrase_degraded);
    assert_eq!(
        results
            .hits
            .iter()
            .map(|hit| hit.path.as_str())
            .collect::<Vec<_>>(),
        ["Note.md", "Z.md"]
    );
    assert_eq!(results.hits[1].icon.as_deref(), Some("i"));
    assert_eq!(results.hits[1].tags, ["t"]);
    assert!(search_segments_inner("(", [alpha.clone()]).is_err());
    assert!(search_segments_inner("body:road", [alpha[..40].to_vec()]).is_err());
}
