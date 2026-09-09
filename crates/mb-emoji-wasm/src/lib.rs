//! Lazy WASM boundary for the offline emoji catalog.

#[cfg(any(target_arch = "wasm32", test))]
use serde::Serialize;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

#[cfg(any(target_arch = "wasm32", test))]
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct EmojiEntry {
    shortcode: &'static str,
    glyph: &'static str,
    category: &'static str,
    aliases: &'static [&'static str],
    supports_skin_tone: bool,
}

#[cfg(any(target_arch = "wasm32", test))]
fn catalog_entries() -> Vec<EmojiEntry> {
    mb_core::emoji::entries()
        .iter()
        .map(|entry| EmojiEntry {
            shortcode: entry.shortcode,
            glyph: entry.glyph,
            category: entry.category,
            aliases: entry.aliases,
            supports_skin_tone: entry.supports_skin_tone,
        })
        .collect()
}

/// Returns the vendored offline Unicode emoji catalog used by autocomplete and the picker.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = "emojiCatalog")]
pub fn emoji_catalog() -> Result<JsValue, JsValue> {
    let entries = catalog_entries();
    serde_wasm_bindgen::to_value(&entries).map_err(|error| JsValue::from_str(&error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::catalog_entries;

    #[test]
    fn projects_the_complete_core_catalog_without_losing_tone_metadata() {
        let entries = catalog_entries();
        assert_eq!(entries.len(), 1_814);
        assert!(
            entries
                .iter()
                .find(|entry| entry.shortcode == "wave")
                .is_some_and(|entry| entry.supports_skin_tone)
        );
        assert!(
            entries
                .iter()
                .find(|entry| entry.shortcode == "tada")
                .is_some_and(|entry| !entry.supports_skin_tone)
        );
    }
}
