//! Scans Memberberry's inline extensions out of CommonMark text runs.
//!
//! CommonMark itself is handled by `pulldown-cmark`. What remains are the constructs it
//! does not know: wikilinks and embeds, `==highlight==`, `#tags`, `:shortcodes:` and
//! footnote references. These are scanned only inside `Text` events, which means they can
//! never fire inside a code span — `pulldown-cmark` has already separated those out.
//!
//! Backslash escapes are likewise already resolved by the time we see a `Text` event, so
//! the matching escaper (`serialize::escape`) is what guarantees that a literal `#tag`
//! written by the user survives a round trip. The two share their predicates via
//! [`crate::syntax`].

use crate::model::{Anchor, Inline, WikiLink};
use crate::syntax;

/// Byte offsets, within a text run, of characters that were backslash-escaped in the source.
///
/// This exists because `pulldown-cmark` resolves escapes before we see the text: `\:A:` and
/// `:A\:` both arrive as the string `:A:`, so without the source there is no way to know
/// which colon the author escaped — and the two would parse differently on successive saves.
/// Recovering the positions from the event's source range makes escaping actually work for
/// Memberberry's own syntax, not just CommonMark's.
#[derive(Debug, Clone, Default)]
pub struct Escapes(Vec<usize>);

impl Escapes {
    #[must_use]
    pub fn none() -> Self {
        Self(Vec::new())
    }

    /// Derives escape positions from a text event's source range.
    ///
    /// `pulldown-cmark` splits a text run at every backslash escape, and the escaped
    /// character always *leads* the following run — its range starts at the character, with
    /// the backslash just outside. So a backslash immediately before the range means this
    /// run's first character was escaped. Verified against `a\\#b`, `:A\\:`, `\\:A:` and
    /// double-backslash cases; see `escapes_are_detected_from_source_ranges`.
    #[must_use]
    pub fn from_source(src: &str, start: usize) -> Self {
        // Count the backslash run, not just one character. `\\[[a]]` is a *literal* backslash
        // followed by a live `[[` — an odd run escapes the next character, an even run is
        // itself escaped text and leaves the next character alone.
        let before = src.get(..start).unwrap_or("");
        let backslashes = before.chars().rev().take_while(|c| *c == '\\').count();
        if backslashes % 2 == 1 {
            Self(vec![0])
        } else {
            Self::none()
        }
    }

    /// Appends another run's escape positions, shifted by its offset in the joined text.
    pub fn push_shifted(&mut self, other: &Self, offset: usize) {
        self.0.extend(other.0.iter().map(|p| p + offset));
    }

    fn is_escaped(&self, offset: usize) -> bool {
        self.0.binary_search(&offset).is_ok()
    }

    /// True when none of `offsets` was escaped, i.e. this construct's delimiters are live.
    fn delimiters_live(&self, base: usize, offsets: &[usize]) -> bool {
        offsets.iter().all(|o| !self.is_escaped(base + o))
    }
}

/// One scanned item: either a finished inline, or a live `==` delimiter awaiting a partner.
///
/// Highlights are the one Memberberry construct that can straddle CommonMark inlines:
/// `==$x$==` arrives as three separate events, so the two `==` runs cannot be paired inside
/// a single text run. Emitting an explicit delimiter — rather than leaving a bare `==` in the
/// text — keeps the pairing decision out of band, so an *escaped* `\==` can never be mistaken
/// for a live one. Without this, `==**bold**==` silently loses its highlight on every save.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScanItem {
    Inline(Inline),
    HighlightDelim,
}

/// Expands one text run, splitting out Memberberry's extended syntax.
#[must_use]
pub fn scan(text: &str, escapes: &Escapes, math: &super::math::Table) -> Vec<ScanItem> {
    let mut out = Vec::new();
    let mut buf = String::new();
    let mut pos = 0usize;

    while pos < text.len() {
        let rest = text.get(pos..).unwrap_or("");
        // A masked span comes back first and verbatim: it was lifted out of the source
        // before CommonMark ran, so nothing here may reinterpret it (`parse::math`).
        if let Some((consumed, content)) = math.take(rest) {
            if !buf.is_empty() {
                out.push(ScanItem::Inline(Inline::Text(std::mem::take(&mut buf))));
            }
            out.push(ScanItem::Inline(Inline::Math(content.to_string())));
            pos += consumed;
            continue;
        }
        if let Some((consumed, inline)) = match_at(rest, escapes, pos) {
            if !buf.is_empty() {
                out.push(ScanItem::Inline(Inline::Text(std::mem::take(&mut buf))));
            }
            out.push(ScanItem::Inline(inline));
            pos += consumed;
            continue;
        }
        // A live `==` with no partner in this run may still pair with one in a later run.
        if rest.starts_with("==") && escapes.delimiters_live(pos, &[0, 1]) {
            if !buf.is_empty() {
                out.push(ScanItem::Inline(Inline::Text(std::mem::take(&mut buf))));
            }
            out.push(ScanItem::HighlightDelim);
            pos += 2;
            continue;
        }
        let mut chars = rest.chars();
        if let Some(c) = chars.next() {
            buf.push(c);
            pos += c.len_utf8();
        } else {
            break;
        }
    }
    if !buf.is_empty() {
        out.push(ScanItem::Inline(Inline::Text(buf)));
    }
    out
}

/// Attempts to match one extended construct at the start of `s`, whose offset in the
/// run is `base`. Returns the bytes consumed and the resulting inline.
///
/// Only a construct's own **delimiters** are checked against `escapes`. Escaped characters
/// in the *content* are fine and must not veto the match: `==he\*llo==` is a highlight
/// containing a literal asterisk, and rejecting it would break the round trip.
fn match_at(s: &str, escapes: &Escapes, base: usize) -> Option<(usize, Inline)> {
    if let Some(rest) = s.strip_prefix("![[") {
        let (len, w) = wikilink(rest, true)?;
        let close = 3 + len - 2;
        escapes
            .delimiters_live(base, &[0, 1, 2, close, close + 1])
            .then_some(())?;
        return Some((len + 3, w));
    }
    if let Some(rest) = s.strip_prefix("[[") {
        let (len, w) = wikilink(rest, false)?;
        let close = 2 + len - 2;
        escapes
            .delimiters_live(base, &[0, 1, close, close + 1])
            .then_some(())?;
        return Some((len + 2, w));
    }
    if let Some(rest) = s.strip_prefix("[^") {
        let len = syntax::scan_footnote(rest)?;
        escapes
            .delimiters_live(base, &[0, 1, 2 + len])
            .then_some(())?;
        let label = rest.get(..len)?.to_string();
        return Some((len + 3, Inline::FootnoteRef(label)));
    }
    if let Some(rest) = s.strip_prefix(':') {
        let len = syntax::scan_shortcode(rest)?;
        escapes.delimiters_live(base, &[0, 1 + len]).then_some(())?;
        let name = rest.get(..len)?.to_string();
        return Some((len + 2, Inline::Emoji(name)));
    }
    if let Some(rest) = s.strip_prefix('#') {
        let len = syntax::scan_tag(rest)?;
        escapes.delimiters_live(base, &[0]).then_some(())?;
        let tag = rest.get(..len)?.to_string();
        return Some((len + 1, Inline::Tag(tag)));
    }
    None
}

/// Parses the inside of a wikilink up to `]]`. Returns bytes consumed including `]]`.
fn wikilink(rest: &str, embed: bool) -> Option<(usize, Inline)> {
    let end = rest.find("]]")?;
    let inner = rest.get(..end)?;
    if inner.is_empty() || inner.contains('\n') || inner.contains('[') {
        return None;
    }

    let (link_part, alias) = match inner.split_once('|') {
        Some((l, a)) => (l, Some(a.to_string())),
        None => (inner, None),
    };
    let (target, anchor) = match link_part.split_once('#') {
        Some((t, a)) => {
            let anchor = match a.strip_prefix('^') {
                Some(block) => Anchor::Block(block.to_string()),
                None => Anchor::Heading(a.to_string()),
            };
            (t.to_string(), Some(anchor))
        }
        None => (link_part.to_string(), None),
    };

    Some((
        end + 2,
        Inline::WikiLink(WikiLink {
            target,
            anchor,
            alias,
            embed,
        }),
    ))
}
