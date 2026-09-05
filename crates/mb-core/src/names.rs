//! How a wikilink target and a tag are folded to their identity (`SPEC.md` §4.3, §9.3).
//!
//! Two names are the same name when they fold the same way. That rule has to hold in more
//! than one place — `mb-index` matches a link against a filename with it, and
//! [`crate::rewrite`] decides which links a rename touches with it — and two copies of a
//! folding rule are two answers to "is `[[roadmap]]` a link to `Roadmap.md`". So it lives
//! here, in the crate both of them already depend on, and neither writes its own.

use unicode_normalization::UnicodeNormalization;

/// Folds a note name or path into the form wikilinks are matched on.
///
/// NFC because the two sides come from different places — the target from note text, the
/// name from a filesystem path — and macOS hands back decomposed filenames, so `Ç` from a
/// wikilink and `Ç` from a directory listing are different bytes for the same character.
/// Lowercase because `[[roadmap]]` is expected to find `Roadmap.md`, as it does in Obsidian.
#[must_use]
pub fn fold_name(value: &str) -> String {
    fold_case(value.trim().trim_end_matches(".md"))
}

/// Folds a tag into the form the tag pane groups on (§9.3).
///
/// The same case rule as [`fold_name`] and deliberately *not* the same trimming: a tag is
/// not a filename, so `#notes.md` is a tag whose last three characters are part of its
/// name. One folding rule with one documented difference, rather than two rules that drift.
#[must_use]
pub fn fold_tag(value: &str) -> String {
    fold_case(value)
}

fn fold_case(value: &str) -> String {
    value.nfc().collect::<String>().to_lowercase()
}

/// Whether `tag` is `prefix` or a tag nested under it (§9.3).
///
/// Both are folded first, so the answer does not depend on how either was capitalized.
/// Nesting is by whole segment: `project/memberberry` is under `project` and `projection`
/// is not.
#[must_use]
pub fn tag_is_under(tag: &str, prefix: &str) -> bool {
    let tag = fold_tag(tag);
    let prefix = fold_tag(prefix);
    tag == prefix
        || tag
            .strip_prefix(&prefix)
            .is_some_and(|rest| rest.starts_with('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folding_ignores_case_the_md_suffix_and_surrounding_space() {
        assert_eq!(fold_name("  Roadmap.md "), "roadmap");
        assert_eq!(fold_name("Projects/Roadmap"), "projects/roadmap");
    }

    #[test]
    fn a_tag_keeps_a_trailing_md_that_a_filename_would_lose() {
        assert_eq!(fold_tag("Notes.md"), "notes.md");
        assert_eq!(fold_name("Notes.md"), "notes");
    }

    #[test]
    fn folding_composes_a_decomposed_name() {
        // "Cafe\u{301}" is what a macOS directory listing gives for a note called "Café".
        assert_eq!(fold_name("Cafe\u{301}"), fold_name("Café"));
        assert_eq!(fold_tag("Projekt/Café"), fold_tag("projekt/Cafe\u{301}"));
    }

    #[test]
    fn a_nested_tag_is_under_each_of_its_prefixes() {
        assert!(tag_is_under("project/memberberry/spec", "project"));
        assert!(tag_is_under(
            "project/memberberry/spec",
            "Project/Memberberry"
        ));
        assert!(tag_is_under("project", "project"));
    }

    #[test]
    fn nesting_is_by_segment_so_a_longer_word_is_not_a_child() {
        assert!(!tag_is_under("projection", "project"));
        assert!(!tag_is_under("project", "project/memberberry"));
    }
}
