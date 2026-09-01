//! Shared scanners for Memberberry's non-CommonMark inline syntax.
//!
//! The serializer's escaper and the parser's scanner **must** agree exactly on what counts
//! as a tag, a shortcode, an anchor or a footnote reference. If they disagree, escaping is
//! either too narrow (text silently becomes markup on the next save — data corruption) or
//! too wide (files fill with backslashes). One source of truth removes that failure mode
//! entirely, which is why these predicates live here rather than in either module.

/// Length in bytes of a tag body following `#`, or `None` if this is not a tag.
///
/// Tags are `#word`, `#nested/tag`, `#with-dashes`. A tag must contain at least one
/// non-digit so that `#1` and `#404` stay ordinary text.
#[must_use]
pub fn scan_tag(after_hash: &str) -> Option<usize> {
    let mut len = 0usize;
    let mut has_alpha = false;
    for c in after_hash.chars() {
        match c {
            'a'..='z' | 'A'..='Z' => {
                has_alpha = true;
                len += c.len_utf8();
            }
            '0'..='9' | '_' | '-' | '/' => len += c.len_utf8(),
            _ => break,
        }
    }
    // Trailing `/`, `-` and `_` read as punctuation rather than part of the tag. `_` matters
    // most: a tag ending in one would act as a closing emphasis delimiter, so `#a_` inside
    // `_…_` would silently re-associate.
    let body = after_hash.get(..len)?;
    let trimmed = body.trim_end_matches(['/', '-', '_']);
    if trimmed.is_empty() || !has_alpha {
        None
    } else {
        Some(trimmed.len())
    }
}

/// Length in bytes of a `:shortcode:` body, excluding both colons.
#[must_use]
pub fn scan_shortcode(after_colon: &str) -> Option<usize> {
    let mut len = 0usize;
    for c in after_colon.chars() {
        match c {
            ':' if len > 0 => return Some(len),
            'a'..='z' | 'A'..='Z' | '0'..='9' | '_' | '-' | '+' => len += c.len_utf8(),
            _ => return None,
        }
    }
    None
}

/// Length in bytes of a footnote label following `[^`, or `None`.
#[must_use]
pub fn scan_footnote(after_caret: &str) -> Option<usize> {
    let mut len = 0usize;
    for c in after_caret.chars() {
        match c {
            ']' if len > 0 => return Some(len),
            c if c.is_alphanumeric() || c == '-' || c == '_' => len += c.len_utf8(),
            _ => return None,
        }
    }
    None
}

/// True when `rest` is a bare identifier running to the end of the text, meaning a
/// preceding `^` would be read as a block anchor (`^block-id`).
#[must_use]
pub fn is_anchor_tail(rest: &str) -> bool {
    !rest.is_empty()
        && rest
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Splits a trailing ` ^anchor` off a block's final text, if present.
#[must_use]
pub fn split_anchor(text: &str) -> Option<(String, String)> {
    let (head, tail) = text.rsplit_once(" ^")?;
    if is_anchor_tail(tail) {
        Some((head.to_string(), tail.to_string()))
    } else {
        None
    }
}
