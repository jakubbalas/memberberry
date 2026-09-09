//! Offline Unicode emoji shortcode resolution (`SPEC.md` §11.1).
//!
//! The catalog is generated from the vendored Emojibase dataset, so native rendering and the
//! browser use the same names without a network request. Custom packs are layered by the server.

include!("emoji_generated.rs");

/// One Unicode emoji shortcode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Entry {
    /// The canonical name without surrounding colons.
    pub shortcode: &'static str,
    /// The literal Unicode glyph stored in Markdown.
    pub glyph: &'static str,
    /// Picker category.
    pub category: &'static str,
    /// Additional names accepted by the catalog.
    pub aliases: &'static [&'static str],
    /// Whether this glyph accepts a Fitzpatrick skin-tone modifier.
    pub supports_skin_tone: bool,
}

/// Returns the complete offline catalog in Unicode order.
#[must_use]
pub fn entries() -> &'static [Entry] {
    ENTRIES
}

/// Resolves a shortcode without its surrounding colons.
#[must_use]
pub fn resolve(shortcode: &str) -> Option<&'static str> {
    let shortcode = shortcode.trim().to_lowercase();
    ENTRIES
        .iter()
        .find(|entry| entry.shortcode == shortcode || entry.aliases.contains(&shortcode.as_str()))
        .map(|entry| entry.glyph)
}

/// Returns catalog entries whose name, alias, or glyph contains the query.
#[must_use]
pub fn search(query: &str) -> Vec<Entry> {
    let query = query.trim().to_lowercase();
    ENTRIES
        .iter()
        .copied()
        .filter(|entry| {
            query.is_empty()
                || entry.shortcode.contains(&query)
                || entry.aliases.iter().any(|alias| alias.contains(&query))
                || entry.glyph.contains(&query)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{entries, resolve, search};
    use std::collections::BTreeSet;

    #[test]
    fn contains_the_full_vendored_catalog() {
        assert_eq!(entries().len(), 1_814);
        let shortcodes = entries()
            .iter()
            .flat_map(|entry| std::iter::once(entry.shortcode).chain(entry.aliases.iter().copied()))
            .collect::<BTreeSet<_>>();
        assert_eq!(shortcodes.len(), 1_923);
    }

    #[test]
    fn resolves_common_shortcode_and_alias_to_literal_glyph() {
        assert_eq!(resolve("tada"), Some("🎉"));
        assert_eq!(resolve("PARTY"), Some("🎉"));
        assert_eq!(resolve("missing"), None);
        assert!(
            entries()
                .iter()
                .find(|entry| entry.shortcode == "wave")
                .is_some_and(|entry| entry.supports_skin_tone)
        );
        assert!(
            entries()
                .iter()
                .find(|entry| entry.shortcode == "tada")
                .is_some_and(|entry| !entry.supports_skin_tone)
        );
    }

    #[test]
    fn search_is_case_insensitive_and_matches_aliases_and_glyphs() {
        assert!(search("TA").iter().any(|entry| entry.shortcode == "tada"));
        assert!(
            search("PARTY")
                .iter()
                .any(|entry| entry.shortcode == "tada")
        );
        assert!(search("🚀").iter().any(|entry| entry.shortcode == "rocket"));
        assert_eq!(search("").len(), entries().len());
    }
}
