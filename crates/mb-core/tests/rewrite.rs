//! Renaming rewrites link spans and nothing else (`SPEC.md` §6.6).
//!
//! The requirement this file exists for is the third bullet of §6.6: *it rewrites only the
//! link text, never any other content — enforced by asserting the diff touches only link
//! spans*. Two assertions carry that between them:
//!
//! - [`rebuilt`] reconstructs the rewritten text from the source plus the reported spans, so
//!   a byte changed anywhere else fails the test rather than being noticed later by a user
//!   whose note came back reformatted;
//! - every reported span is checked to be a name the rename was asked to change.
//!
//! The fixtures are deliberately **not** canonical Markdown. A rename runs over notes
//! somebody else wrote — in Obsidian, in vim, by hand — and re-canonicalizing them is the
//! failure mode being ruled out, so the input has to be able to show it.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

mod support;

use mb_core::names;
use mb_core::rewrite::{Rewrite, RewriteError, Span, rename_link_target, rename_tag, rename_title};
use proptest::prelude::*;

fn from(names: &[&str]) -> Vec<String> {
    names.iter().map(|name| (*name).to_string()).collect()
}

#[test]
fn simultaneous_targets_do_not_cascade_and_preserve_aliases() {
    let replacements = std::collections::BTreeMap::from([
        ("One".to_string(), "Two".to_string()),
        ("Two".to_string(), "Three".to_string()),
    ]);
    let rewritten = mb_core::rewrite::rename_link_targets(
        "[[One#part|first]] [[Two]] `[[One]]`",
        &replacements,
    )
    .expect("rewrite");
    assert_eq!(rewritten.text(), "[[Two#part|first]] [[Three]] `[[One]]`");
}

proptest! {
    #![proptest_config(ProptestConfig { rng_seed: proptest::test_runner::RngSeed::Fixed(20260922), ..ProptestConfig::default() })]
    #[test]
    fn simultaneous_folder_link_moves_round_trip(suffix in "[a-z]{1,24}") {
        let old = format!("Source/{suffix}");
        let new = format!("Archive/Source/{suffix}");
        let source = format!("# Title\n\n[[{old}#part|📓]] ![[{old}]] `[[{old}]]`\n");
        let replacements = std::collections::BTreeMap::from([(old.clone(), new.clone())]);
        let moved = mb_core::rewrite::rename_link_targets(&source, &replacements).expect("move");
        prop_assert_eq!(moved.count(), 2);
        let inverse = std::collections::BTreeMap::from([(new, old)]);
        let restored = mb_core::rewrite::rename_link_targets(moved.text(), &inverse).expect("restore");
        prop_assert_eq!(restored.text(), source);
    }
}

#[test]
fn rename_title_replaces_the_first_h1_and_preserves_the_body() {
    let result =
        rename_title("# Old title\n\nBody **stays**.\n", "New title").expect("valid title");
    assert_eq!(result.text(), "# New title\n\nBody **stays**.\n");
}

#[test]
fn rename_title_inserts_a_title_for_a_legacy_note() {
    let result = rename_title("body\n", "Recovered").expect("valid title");
    assert_eq!(result.text(), "# Recovered\n\nbody\n");
}

/// The rewritten text, rebuilt from the source and the spans the rewrite says it replaced.
///
/// If this differs from what the rewrite actually returned, something outside a reported
/// span changed — which is exactly the thing §6.6 forbids.
fn rebuilt(source: &str, spans: &[Span], replacement: impl Fn(&str) -> String) -> String {
    let mut out = String::new();
    let mut cursor = 0usize;
    for span in spans {
        out.push_str(&source[cursor..span.start]);
        out.push_str(&replacement(&source[span.start..span.end]));
        cursor = span.end;
    }
    out.push_str(&source[cursor..]);
    out
}

/// The tag a rename produces from one it replaced — the test's own copy of the rule, so a
/// change to the crate's has to be made here too rather than silently agreeing with itself.
fn retagged(replaced: &str, from: &str, to: &str) -> String {
    let kept: Vec<&str> = replaced.split('/').skip(from.split('/').count()).collect();
    if kept.is_empty() {
        to.to_string()
    } else {
        format!("{to}/{}", kept.join("/"))
    }
}

/// Asserts the promise of §6.6 for a link rename: nothing but the named targets moved.
fn assert_only_link_spans(source: &str, rewrite: &Rewrite, keys: &[&str], to: &str) {
    for span in rewrite.spans() {
        let replaced = &source[span.start..span.end];
        assert!(
            keys.iter()
                .any(|key| names::fold_name(key) == names::fold_name(replaced)),
            "the rewrite replaced {replaced:?}, which is not one of the names it was given"
        );
    }
    assert_eq!(
        rebuilt(source, rewrite.spans(), |_| to.to_string()),
        rewrite.text(),
        "a byte outside a reported span changed"
    );
}

#[test]
fn a_wikilink_naming_the_renamed_note_is_repointed() {
    let source = "See [[Roadmap]] for the plan.\n";
    let rewrite = rename_link_target(source, &from(&["Roadmap"]), "Plan").unwrap();
    assert_eq!(rewrite.text(), "See [[Plan]] for the plan.\n");
    assert_eq!(rewrite.count(), 1);
    assert_only_link_spans(source, &rewrite, &["Roadmap"], "Plan");
}

#[test]
fn an_anchor_and_an_alias_survive_the_rename() {
    let source = "[[Roadmap#Q3 goals|the plan]] and [[Roadmap#^abc123]]\n";
    let rewrite = rename_link_target(source, &from(&["Roadmap"]), "Plan").unwrap();
    assert_eq!(
        rewrite.text(),
        "[[Plan#Q3 goals|the plan]] and [[Plan#^abc123]]\n"
    );
}

#[test]
fn an_embed_is_repointed_exactly_as_a_link_is() {
    // A transclusion is an inbound reference too (§9.2); leaving it behind would break the
    // one kind of link whose breakage is visible as a placeholder in the middle of a note.
    let source = "![[Roadmap]]\n";
    let rewrite = rename_link_target(source, &from(&["Roadmap"]), "Plan").unwrap();
    assert_eq!(rewrite.text(), "![[Plan]]\n");
}

#[test]
fn every_spelling_the_caller_supplies_is_rewritten_to_one_name() {
    // §4.3 lets one note be named by its path, its stem or an alias, and the caller is what
    // resolved which of those point here.
    let source = "[[Roadmap]], [[Projects/Roadmap]] and [[the plan]].\n";
    let rewrite = rename_link_target(
        source,
        &from(&["Roadmap", "Projects/Roadmap", "the plan"]),
        "Plan",
    )
    .unwrap();
    assert_eq!(rewrite.text(), "[[Plan]], [[Plan]] and [[Plan]].\n");
    assert_eq!(rewrite.count(), 3);
}

#[test]
fn case_and_unicode_composition_do_not_make_two_names() {
    // "Cafe\u{301}" is what a macOS directory listing gives for a note called "Café".
    let source = "[[café]] and [[Cafe\u{301}]]\n";
    let rewrite = rename_link_target(source, &from(&["Café"]), "Bistro").unwrap();
    assert_eq!(rewrite.text(), "[[Bistro]] and [[Bistro]]\n");
}

#[test]
fn a_note_with_no_inbound_reference_is_returned_byte_for_byte() {
    let source = "Nothing to see.\n\n*  odd   spacing  *\n";
    let rewrite = rename_link_target(source, &from(&["Roadmap"]), "Plan").unwrap();
    assert_eq!(rewrite.text(), source);
    assert!(!rewrite.changed());
}

#[test]
fn a_note_nobody_normalized_keeps_every_byte_it_had() {
    // The whole point of the surgical rewrite: this note is full of things `serialize`
    // would rewrite — setext headings, `*` bullets, aligned table pipes, trailing spaces —
    // and the rename must leave all of them exactly where they were.
    let source = concat!(
        "Old Title\n",
        "=========\n",
        "\n",
        "*   a bullet with [[Roadmap]]\n",
        "*   another\n",
        "\n",
        "| a        | b   |\n",
        "|:---------|----:|\n",
        "| [[Roadmap]] | x |\n",
        "\n",
        "Trailing spaces here.   \n",
    );
    let expected = source.replace("[[Roadmap]]", "[[Plan]]");
    let rewrite = rename_link_target(source, &from(&["Roadmap"]), "Plan").unwrap();
    assert_eq!(rewrite.text(), expected);
    assert_only_link_spans(source, &rewrite, &["Roadmap"], "Plan");
}

#[test]
fn a_link_inside_a_code_fence_is_not_a_link() {
    let source = "```markdown\n[[Roadmap]]\n```\n\nBut [[Roadmap]] here.\n";
    let rewrite = rename_link_target(source, &from(&["Roadmap"]), "Plan").unwrap();
    assert_eq!(
        rewrite.text(),
        "```markdown\n[[Roadmap]]\n```\n\nBut [[Plan]] here.\n"
    );
}

#[test]
fn a_link_inside_a_code_span_is_not_a_link() {
    let source = "Write `[[Roadmap]]` to link to [[Roadmap]].\n";
    let rewrite = rename_link_target(source, &from(&["Roadmap"]), "Plan").unwrap();
    assert_eq!(rewrite.text(), "Write `[[Roadmap]]` to link to [[Plan]].\n");
}

#[test]
fn a_link_inside_an_indented_code_block_is_not_a_link() {
    let source = "Para\n\n    [[Roadmap]]\n";
    let rewrite = rename_link_target(source, &from(&["Roadmap"]), "Plan").unwrap();
    assert_eq!(rewrite.text(), source);
}

#[test]
fn a_link_inside_inline_maths_is_not_a_link() {
    // Maths is lifted out before CommonMark sees it (`parse::math`), so `[[x]]` in a formula
    // never becomes a link and must never be rewritten as one.
    let source = "The bound $f([[Roadmap]])$ holds, see [[Roadmap]].\n";
    let rewrite = rename_link_target(source, &from(&["Roadmap"]), "Plan").unwrap();
    assert_eq!(
        rewrite.text(),
        "The bound $f([[Roadmap]])$ holds, see [[Plan]].\n"
    );
}

#[test]
fn an_escaped_wikilink_is_left_as_the_text_it_is() {
    let source = "\\[[Roadmap]] is how you write it, unlike [[Roadmap]].\n";
    let rewrite = rename_link_target(source, &from(&["Roadmap"]), "Plan").unwrap();
    assert_eq!(
        rewrite.text(),
        "\\[[Roadmap]] is how you write it, unlike [[Plan]].\n"
    );
}

#[test]
fn a_new_name_that_could_close_the_link_early_is_refused() {
    // Without this the rename is a markup-injection primitive into notes the actor cannot
    // read: `Ev]] il [[x` would end one link and open another in every file it touched.
    for name in ["Ev]]il", "a|b", "a#b", "a[b", "a\nb", "a\\b", " padded", ""] {
        assert_eq!(
            rename_link_target("[[Roadmap]]\n", &from(&["Roadmap"]), name),
            Err(RewriteError::InvalidName(name.to_string())),
            "{name:?} should not be usable as a note name"
        );
    }
}

#[test]
fn a_target_spelled_with_a_backslash_escape_is_still_found() {
    // The serializer escapes a `|` inside a wikilink in a table cell, and CommonMark
    // escapes are resolved before the parser looks for Memberberry syntax — so a scanner
    // that stopped at a backslash would decide the link is not there and refuse every
    // rename of a note linked to from a table.
    let source = "| h |\n| --- |\n| [[Roadmap\\|the plan]] |\n";
    let rewrite = rename_link_target(source, &from(&["Roadmap"]), "Plan").unwrap();
    assert_eq!(rewrite.text(), "| h |\n| --- |\n| [[Plan\\|the plan]] |\n");
}

#[test]
fn a_name_that_becomes_markup_where_it_lands_is_refused_rather_than_written() {
    // `Q1$Q2` is a perfectly good name on its own — `[[Q1$Q2]]` parses as that link — but
    // spliced into a line that already has a `$`, the two pair and the span between them
    // becomes maths, so the link stops being one. Nothing is written for any note: the
    // model check sees a document that is not the renamed one and discards the rewrite.
    let source = "Costs $5 and [[Roadmap]] here.\n";
    assert_eq!(
        rename_link_target(source, &from(&["Roadmap"]), "Q1$Q2"),
        Err(RewriteError::Unverified)
    );
}

#[test]
fn a_link_in_a_callout_a_quote_and_a_table_is_reached() {
    let source = concat!(
        "> [!note] See [[Roadmap]]\n",
        "> body [[Roadmap]]\n",
        "\n",
        "> plain quote [[Roadmap]]\n",
        "\n",
        "| h |\n|---|\n| [[Roadmap]] |\n",
    );
    let rewrite = rename_link_target(source, &from(&["Roadmap"]), "Plan").unwrap();
    assert_eq!(rewrite.count(), 4);
    assert!(!rewrite.text().contains("Roadmap"));
}

#[test]
fn a_nested_tag_moves_with_the_prefix_that_was_renamed() {
    let source = "#project and #project/memberberry and #project/memberberry/spec\n";
    let rewrite = rename_tag(source, "project", "work").unwrap();
    assert_eq!(
        rewrite.text(),
        "#work and #work/memberberry and #work/memberberry/spec\n"
    );
}

#[test]
fn a_tag_that_merely_starts_with_the_prefix_is_left_alone() {
    // Nesting is by segment. `#projection` is a different tag, not a child of `#project`.
    let source = "#projection stays, #project moves\n";
    let rewrite = rename_tag(source, "project", "work").unwrap();
    assert_eq!(rewrite.text(), "#projection stays, #work moves\n");
}

#[test]
fn a_tag_is_matched_whatever_case_it_was_written_in() {
    let source = "#Project and #project\n";
    let rewrite = rename_tag(source, "project", "work").unwrap();
    assert_eq!(rewrite.text(), "#work and #work\n");
}

#[test]
fn a_heading_anchor_in_a_wikilink_is_not_a_tag() {
    // `[[Note#project]]` names a heading. Renaming the tag `#project` must not touch it, or
    // a tag rename quietly breaks a link.
    let source = "[[Note#project]] and #project\n";
    let rewrite = rename_tag(source, "project", "work").unwrap();
    assert_eq!(rewrite.text(), "[[Note#project]] and #work\n");
}

#[test]
fn a_tag_inside_code_or_a_link_destination_is_not_a_tag() {
    let source = "`#project` and [x](https://e.com/#project) and #project\n";
    let rewrite = rename_tag(source, "project", "work").unwrap();
    assert_eq!(
        rewrite.text(),
        "`#project` and [x](https://e.com/#project) and #work\n"
    );
}

#[test]
fn an_escaped_hash_is_text_and_stays_text() {
    let source = "\\#project is literal, #project is not\n";
    let rewrite = rename_tag(source, "project", "work").unwrap();
    assert_eq!(rewrite.text(), "\\#project is literal, #work is not\n");
}

#[test]
fn frontmatter_tags_are_renamed_in_every_shape_the_frontmatter_parser_accepts() {
    let flow = "---\ntags: [project/mb, other]\n---\n\nbody\n";
    assert_eq!(
        rename_tag(flow, "project", "work").unwrap().text(),
        "---\ntags: [work/mb, other]\n---\n\nbody\n"
    );

    let block = "---\ntags:\n  - project/mb\n  - other\n---\n\nbody\n";
    assert_eq!(
        rename_tag(block, "project", "work").unwrap().text(),
        "---\ntags:\n  - work/mb\n  - other\n---\n\nbody\n"
    );

    let scalar = "---\ntags: project/mb other\n---\n\nbody\n";
    assert_eq!(
        rename_tag(scalar, "project", "work").unwrap().text(),
        "---\ntags: work/mb other\n---\n\nbody\n"
    );

    let quoted = "---\ntags: [\"project/mb\", 'project']\n---\n\nbody\n";
    assert_eq!(
        rename_tag(quoted, "project", "work").unwrap().text(),
        "---\ntags: [\"work/mb\", 'work']\n---\n\nbody\n"
    );
}

#[test]
fn a_frontmatter_key_that_is_not_tags_is_left_alone() {
    // An alias, a title or a user key may happen to hold the same word. Only `tags:` is a
    // tag, and §9.3 says so.
    let source = "---\naliases: [project]\nsummary: project\ntags: [project]\n---\n\nbody\n";
    let rewrite = rename_tag(source, "project", "work").unwrap();
    assert_eq!(
        rewrite.text(),
        "---\naliases: [project]\nsummary: project\ntags: [work]\n---\n\nbody\n"
    );
}

#[test]
fn a_new_tag_that_is_not_spelled_like_a_tag_is_refused() {
    for tag in ["wo rk", "", "123", "a]b", "a#b", "work/"] {
        assert!(
            matches!(
                rename_tag("#project\n", "project", tag),
                Err(RewriteError::InvalidTag(_))
            ),
            "{tag:?} should not be usable as a tag"
        );
    }
}

#[test]
fn renaming_a_tag_touches_only_the_tag_spans() {
    let source = "---\ntags: [project/mb]\n---\n\nSee #project/mb and #project.\n";
    let rewrite = rename_tag(source, "project", "work").unwrap();
    assert_eq!(
        rebuilt(source, rewrite.spans(), |replaced| retagged(
            replaced, "project", "work"
        )),
        rewrite.text(),
        "a byte outside a reported span changed"
    );
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 256, ..ProptestConfig::default() })]

    /// A rename of a canonical note always succeeds. The verification step exists to refuse
    /// a rewrite it cannot vouch for, and a refusal on an ordinary note would make the
    /// feature useless — so "it verifies" is the property, not just "it does not corrupt".
    #[test]
    fn renaming_a_link_in_a_generated_note_always_verifies(
        doc in support::document(),
        to in "[A-Z][a-z]{2,8}",
    ) {
        let source = mb_core::to_markdown(&doc);
        let rewrite = rename_link_target(&source, &from(&["a", "b", "c", "note"]), &to);
        prop_assert!(
            rewrite.is_ok(),
            "refused a rename of a canonical note\n--- source ---\n{}",
            source
        );
    }

    /// §6.6's promise, over generated notes: the diff is confined to the reported spans.
    #[test]
    fn only_the_reported_spans_change(doc in support::document(), to in "[A-Z][a-z]{2,8}") {
        let source = mb_core::to_markdown(&doc);
        let keys = ["a", "b", "c", "note"];
        let rewrite = rename_link_target(&source, &from(&keys), &to)
            .expect("a canonical note always verifies");
        for span in rewrite.spans() {
            let replaced = &source[span.start..span.end];
            prop_assert!(
                keys.iter().any(|key| names::fold_name(key) == names::fold_name(replaced)),
                "replaced {:?}, which is not a name it was given",
                replaced
            );
        }
        prop_assert_eq!(
            rebuilt(&source, rewrite.spans(), |_| to.clone()),
            rewrite.text().to_string()
        );
    }

    /// Renaming back is the identity. A rewrite that lost a byte cannot satisfy this.
    #[test]
    fn renaming_a_link_there_and_back_restores_the_note(doc in support::document()) {
        let source = mb_core::to_markdown(&doc);
        let there = rename_link_target(&source, &from(&["a", "b", "c", "note"]), "Zzz")
            .expect("a canonical note always verifies");
        if there.count() != 1 {
            // With two names collapsing onto one, the inverse is not a function.
            return Ok(());
        }
        let original = source[there.spans()[0].start..there.spans()[0].end].to_string();
        let back = rename_link_target(there.text(), &from(&["Zzz"]), &original)
            .expect("renaming back verifies too");
        prop_assert_eq!(back.text(), &source);
    }

    /// Total over arbitrary input: never panics, and either refuses or leaves the bytes
    /// outside the spans it reported exactly as it found them.
    #[test]
    fn any_string_is_either_rewritten_within_its_spans_or_refused(input in ".{0,400}") {
        if let Ok(rewrite) = rename_link_target(&input, &from(&["a", "note"]), "Zzz") {
            prop_assert_eq!(
                rebuilt(&input, rewrite.spans(), |_| "Zzz".to_string()),
                rewrite.text().to_string()
            );
        }
        if let Ok(rewrite) = rename_tag(&input, "a", "zzz") {
            prop_assert_eq!(
                rebuilt(&input, rewrite.spans(), |replaced| retagged(replaced, "a", "zzz")),
                rewrite.text().to_string()
            );
        }
    }
}
