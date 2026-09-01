//! Unicode character classes for CommonMark's flanking rules.
//!
//! Its own module because it is its own concern: `mb-crdt` needs the same predicate when it
//! serializes from the CRDT, and `canonical` should not be where the definition lives.

use unicode_general_category::{GeneralCategory as G, get_general_category};

/// CommonMark's three character classes (§2.1, §6.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    Whitespace,
    Punctuation,
    Other,
}

/// Classifies a character, or the absence of one.
///
/// The categories are looked up exactly rather than approximated. Two approximations were
/// tried first and the round-trip suite rejected both: `is_ascii_punctuation` misses `¡`,
/// and "not alphanumeric, not whitespace" wrongly claims private-use characters like
/// `U+E000`. Either way `mb-core` and `pulldown-cmark` end up disagreeing about whether a
/// delimiter run can close, which shows up as a file that rewrites itself on every save.
#[must_use]
pub fn class(c: Option<char>) -> Class {
    let Some(c) = c else {
        // Absent means the start or end of a line, which flanking treats as whitespace.
        return Class::Whitespace;
    };
    // CommonMark's Unicode whitespace set: space, tab, newline, line tabulation, form feed,
    // carriage return, plus the separator categories.
    if matches!(c, ' ' | '\t' | '\n' | '\r' | '\u{b}' | '\u{c}') {
        return Class::Whitespace;
    }
    match get_general_category(c) {
        G::SpaceSeparator | G::LineSeparator | G::ParagraphSeparator => Class::Whitespace,
        // "Unicode punctuation character" is categories P* and S*.
        G::ConnectorPunctuation
        | G::DashPunctuation
        | G::OpenPunctuation
        | G::ClosePunctuation
        | G::InitialPunctuation
        | G::FinalPunctuation
        | G::OtherPunctuation
        | G::MathSymbol
        | G::CurrencySymbol
        | G::ModifierSymbol
        | G::OtherSymbol => Class::Punctuation,
        _ => Class::Other,
    }
}
