//! Inline math, lifted out of the source before CommonMark parses the inlines.
//!
//! # Why
//!
//! `$…$` is not CommonMark. Recognising it from `pulldown-cmark`'s *output* means every
//! character of a math body has already been through CommonMark's inline parser: `$_a_$`
//! arrives with the underscores consumed as emphasis, `` $`x`$ `` as a code span. The body
//! is gone before anything looks for maths. Working around that produced five patches and a
//! rule refusing any body containing `` ` * ~ < [ ] `` — which rejects `$a*b$` and
//! `$\alpha[i]$`, both ordinary LaTeX — and still left the property suite failing.
//!
//! # How, and why this way
//!
//! Two earlier attempts failed for reasons worth stating, because they shaped this one:
//!
//! - Deciding what is code by scanning raw *lines* cannot work. A fence may open inside a
//!   list item, run to any length, and carry an info string; every miss put a placeholder
//!   inside a code block.
//! - Leaving the old output-scanner in place as a fallback cannot work either. It has
//!   different rules, so the two disagree about `$|$` and the file changes on every save.
//!
//! So the source is parsed **twice**. The first pass asks `pulldown-cmark` itself where the
//! code is — [`Event::Code`] spans and code-block ranges — and where table rows are. Maths
//! is then masked everywhere else, and the second pass sees inert placeholders in place of
//! every body. The old scanner is gone; this is the only rule.
//!
//! Placeholders need *not* be the same length as what they replace. Everything downstream
//! reads its source ranges against the masked string — it is what `pulldown-cmark` parsed
//! and what the cursor carries — so the masked text only has to be self-consistent. An
//! earlier attempt padded placeholders to preserve offsets, which meant `$y$` had no room
//! for one and single-character maths stopped being maths at all.
//!
//! Both passes are skipped entirely when the source contains no `$`.

use std::ops::Range;

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

/// Delimits a placeholder at both ends.
///
/// It must be **punctuation** in Unicode's sense, because CommonMark decides whether a
/// neighbouring `*` can open or close emphasis from the character class either side of it —
/// an earlier attempt used a control character and turned `*'*$a$` into literal text. `%` is
/// punctuation, one byte, and meaningless to CommonMark and to every extension here.
const EDGE: char = '%';
/// Marks the byte after [`EDGE`], so a literal `%…%` in a note is never mistaken for one.
const MARK: char = '\u{1}';
/// The two characters that open a placeholder.
const PREFIX: &str = "%\u{1}";

/// Spans lifted out of the source, looked up while scanning inlines.
#[derive(Debug, Clone, Default)]
pub struct Table {
    spans: Vec<Span>,
}

#[derive(Debug, Clone)]
struct Span {
    /// Where the span sat in the source, so a misplaced one can be skipped on a retry.
    start: usize,
    content: String,
}

impl Table {
    /// Reads a placeholder at the start of `text`: its byte length and original content.
    #[must_use]
    pub fn take(&self, text: &str) -> Option<(usize, &str)> {
        let rest = text.strip_prefix(EDGE)?.strip_prefix(MARK)?;
        let digits: String = rest
            .chars()
            .take_while(char::is_ascii_alphanumeric)
            .collect();
        let closed = rest.get(digits.len()..)?.starts_with(EDGE);
        let index = usize::from_str_radix(&digits, 36).ok()?;
        let span = self.spans.get(index)?;
        // Edge, marker, index, edge.
        closed.then_some((digits.len() + 3, span.content.as_str()))
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.spans.is_empty()
    }

    /// Source offset of the span behind a leaked placeholder, for [`mask_except`].
    #[must_use]
    pub fn leaked_start(&self, text: &str) -> Option<usize> {
        let at = text.find(PREFIX)?;
        let rest = text.get(at + PREFIX.len()..)?;
        let digits: String = rest
            .chars()
            .take_while(char::is_ascii_alphanumeric)
            .collect();
        let index = usize::from_str_radix(&digits, 36).ok()?;
        self.spans.get(index).map(|s| s.start)
    }
}

/// True when `text` holds an unrestored placeholder.
///
/// Matched as a pair rather than by the marker alone: a note may legitimately contain a lone
/// `\u{1}`, and treating that as a leak would send such documents down the slow path.
#[must_use]
pub fn contains_placeholder(text: &str) -> bool {
    text.contains(PREFIX)
}

/// Lifts every inline `$…$` out of `src`.
#[must_use]
pub fn mask(src: &str, options: Options) -> (String, Table) {
    mask_except(src, options, &[])
}

/// Byte ranges of `src` that are inline maths, delimiters included.
///
/// For [`crate::rewrite`], which walks the source rather than the masked string and has to
/// know which parts of it the inline scanner will never look inside. Asking here rather
/// than re-deriving it is the same rule the rest of this module lives by: one answer to
/// "where is the maths", or the two disagree and a file rewrites itself.
#[must_use]
pub fn spans(src: &str, options: Options) -> Vec<Range<usize>> {
    if !src.contains('$') {
        return Vec::new();
    }
    find_spans(src, &Structure::of(src, options))
}

/// As [`mask`], but leaves spans starting at any offset in `skip` alone.
#[must_use]
pub fn mask_except(src: &str, options: Options, skip: &[usize]) -> (String, Table) {
    if !src.contains('$') {
        return (src.to_string(), Table::default());
    }
    let structure = Structure::of(src, options);
    let found: Vec<Range<usize>> = find_spans(src, &structure)
        .into_iter()
        .filter(|r| !skip.contains(&r.start))
        .collect();
    if found.is_empty() {
        return (src.to_string(), Table::default());
    }

    let mut table = Table::default();
    let mut out = String::with_capacity(src.len());
    let mut cursor = 0usize;
    for range in &found {
        let Some(content) = src.get(range.start + 1..range.end - 1) else {
            continue;
        };
        let index = table.spans.len();
        table.spans.push(Span {
            start: range.start,
            content: content.to_string(),
        });
        out.push_str(src.get(cursor..range.start).unwrap_or(""));
        out.push(EDGE);
        out.push(MARK);
        out.push_str(&to_base36(index));
        out.push(EDGE);
        cursor = range.end;
    }
    out.push_str(src.get(cursor..).unwrap_or(""));
    (out, table)
}

fn to_base36(mut n: usize) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".to_string();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.extend(DIGITS.get(n % 36).copied());
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// Where CommonMark says the code and the table rows are.
///
/// Asked of `pulldown-cmark` rather than worked out from the text. Every attempt to decide
/// "is this line inside a fence" by looking at lines was wrong in a way that put a
/// placeholder inside someone's code.
#[derive(Debug, Default)]
struct Structure {
    /// Code blocks and inline code spans — masking must not touch these.
    code: Vec<Range<usize>>,
    /// Table rows. A span may not cross a `|` inside one, or it welds two cells together.
    rows: Vec<Range<usize>>,
}

impl Structure {
    fn of(src: &str, options: Options) -> Self {
        let mut out = Self::default();
        let mut block_start: Option<usize> = None;
        for (event, range) in Parser::new_ext(src, options).into_offset_iter() {
            match event {
                Event::Start(Tag::CodeBlock(_)) => block_start = Some(range.start),
                Event::End(TagEnd::CodeBlock) => {
                    if let Some(start) = block_start.take() {
                        out.code.push(start..range.end);
                    }
                }
                Event::Code(_) => out.code.push(range),
                Event::Start(Tag::TableRow | Tag::TableHead) => out.rows.push(range),
                _ => {}
            }
        }
        out
    }

    fn in_code(&self, at: usize) -> bool {
        self.code.iter().any(|r| r.contains(&at))
    }

    fn row_at(&self, at: usize) -> Option<&Range<usize>> {
        self.rows.iter().find(|r| r.contains(&at))
    }
}

/// Byte ranges of every inline math span, in source order.
fn find_spans(src: &str, structure: &Structure) -> Vec<Range<usize>> {
    let bytes = src.as_bytes();
    let mut spans = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes.get(i) {
            // A backslash escapes the next byte, `\$` included.
            Some(b'\\') => i += 2,
            Some(b'$') => {
                // `$$` opens display math, which stays with the block-level path. Both
                // characters are stepped over: leaving the second behind would let it open
                // an inline span that eats into the block's own closing fence.
                if bytes.get(i + 1) == Some(&b'$') {
                    i += 2;
                    continue;
                }
                if structure.in_code(i) {
                    i += 1;
                    continue;
                }
                match closing_dollar(src, structure, i) {
                    Some(end) => {
                        spans.push(i..end + 1);
                        i = end + 1;
                    }
                    None => i += 1,
                }
            }
            _ => i += 1,
        }
    }
    spans
}

/// The closing `$` of a span opening at `open`, if the body between them is usable.
fn closing_dollar(src: &str, structure: &Structure, open: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    // A span may not leave the table row it started in: reaching across a `|` would weld
    // two cells together, and the row is the only boundary that cannot be crossed.
    let row = structure.row_at(open);
    let mut i = open + 1;
    while i < bytes.len() {
        match bytes.get(i) {
            Some(b'\\') => i += 2,
            // Inline maths is single-line, as Obsidian has it.
            Some(b'\n' | b'\r') => return None,
            Some(b'|') if row.is_some() => return None,
            Some(b'$') if structure.in_code(i) => return None,
            Some(b'$') => {
                let inner = src.get(open + 1..i)?;
                return is_math_body(inner).then_some(i);
            }
            _ => i += 1,
        }
        if row.is_some_and(|r| !r.contains(&i.saturating_sub(1))) {
            return None;
        }
    }
    None
}

/// Obsidian's rule: non-empty, with no whitespace hugging the delimiters — so `costs $5 and
/// $6 more` stays prose rather than becoming maths of `5 and `.
///
/// A backtick is refused as well, and it is the only character that is. A math body is
/// written back out verbatim — escaping inside it would change the maths, since `\_` is a
/// literal underscore to LaTeX — and CommonMark parses code spans before backslash escapes,
/// so a raw backtick from a body can pair with a later one and swallow the text between
/// them. Every other character the old scanner refused (`* ~ < [ ]`) is now fine, because
/// nothing reinterprets a masked body.
fn is_math_body(inner: &str) -> bool {
    !inner.is_empty()
        && !inner.starts_with(char::is_whitespace)
        && !inner.ends_with(char::is_whitespace)
        && !inner.contains(['\n', '\r', '`'])
}
