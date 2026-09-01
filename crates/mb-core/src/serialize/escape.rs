//! Minimal-but-sufficient escaping (`SPEC.md` §4.5).
//!
//! "Minimal" matters: escaping every punctuation character would round-trip correctly but
//! produce files full of backslashes, which fails C2 in spirit — the file must be pleasant
//! to read in a text editor, not merely parseable. So each rule below escapes a character
//! only in the positions where it would actually reparse as markup.
//!
//! Every rule here is covered by the round-trip property tests: if a rule is too narrow,
//! `parse(serialize(doc)) == doc` fails.

use crate::syntax;

/// Where the text being escaped sits, which changes what can reparse as markup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ctx {
    /// This text begins a line, so line-leading constructs (`#`, `-`, `>`, `1.`) can fire.
    pub at_line_start: bool,
    /// Inside a table cell, where `|` terminates the cell.
    pub in_table: bool,
    /// The enclosing block holds more than one `$`, so math delimiters could pair up.
    ///
    /// Math is the one construct that spans inline nodes: `$` in a text run can pair with a
    /// `$` inside a later emphasis. A per-run check cannot see that, so the decision is made
    /// once per block and threaded down. With a single `$` in the block — `costs $5` — no
    /// pairing is possible and the text is left clean.
    pub escape_dollar: bool,
    /// The delimiter used by an enclosing emphasis, if any.
    ///
    /// `*a*b*c*` is inherently ambiguous: CommonMark reads it as two sibling emphases, never
    /// as one nested inside another. So a nested emphasis must alternate to the other
    /// delimiter. This propagates through strong, strikethrough and highlight, because the
    /// ambiguity survives them.
    pub emphasis_delim: Option<char>,
}

impl Ctx {
    #[must_use]
    pub fn inline() -> Self {
        Self {
            at_line_start: false,
            in_table: false,
            escape_dollar: false,
            emphasis_delim: None,
        }
    }
    #[must_use]
    pub fn line_start() -> Self {
        Self {
            at_line_start: true,
            in_table: false,
            escape_dollar: false,
            emphasis_delim: None,
        }
    }
    #[must_use]
    pub fn table_cell() -> Self {
        Self {
            at_line_start: false,
            in_table: true,
            escape_dollar: false,
            emphasis_delim: None,
        }
    }
    /// Copies positional flags but resets `at_line_start`, for nested inline content.
    #[must_use]
    pub fn nested(self) -> Self {
        Self {
            at_line_start: false,
            ..self
        }
    }
    #[must_use]
    pub fn with_emphasis(self, delim: char) -> Self {
        Self {
            emphasis_delim: Some(delim),
            ..self
        }
    }
    #[must_use]
    pub fn with_dollar(self, escape_dollar: bool) -> Self {
        Self {
            escape_dollar,
            ..self
        }
    }
}

/// Escapes `text` so that parsing the result yields exactly `text` again.
#[must_use]
pub fn text(input: &str, ctx: Ctx) -> String {
    let mut out = String::with_capacity(input.len());
    let chars: Vec<char> = input.chars().collect();
    let mut line_start = ctx.at_line_start;
    // Tracks whether every character since the line began was a digit, which is what makes
    // a following `.` or `)` an ordered-list marker.
    let mut digits_only = true;
    let mut digit_run = 0usize;

    for (i, &c) in chars.iter().enumerate() {
        let rest: String = chars
            .get(i + 1..)
            .map(|s| s.iter().collect())
            .unwrap_or_default();
        let prev = if i == 0 {
            None
        } else {
            chars.get(i - 1).copied()
        };
        let next = chars.get(i + 1).copied();

        let pos = Pos {
            line_start,
            after_digits: digits_only && digit_run > 0,
        };
        if needs_escape(c, prev, next, &rest, pos, ctx) {
            out.push('\\');
        }
        out.push(c);

        if c == '\n' {
            line_start = true;
            digits_only = true;
            digit_run = 0;
        } else {
            line_start = false;
            if c.is_ascii_digit() && digits_only {
                digit_run += 1;
            } else {
                digits_only = false;
            }
        }
    }
    out
}

/// Position facts that decide whether a character can reparse as a block construct.
#[derive(Debug, Clone, Copy)]
struct Pos {
    line_start: bool,
    /// Everything from the line start to here was digits, so `.` or `)` opens a list.
    after_digits: bool,
}

fn needs_escape(
    c: char,
    prev: Option<char>,
    next: Option<char>,
    rest: &str,
    pos: Pos,
    ctx: Ctx,
) -> bool {
    let line_start = pos.line_start;
    let in_table = ctx.in_table;
    match c {
        // Always ambiguous: these open markup anywhere.
        // `~` joins this set because pulldown-cmark accepts *single*-tilde strikethrough,
        // so even a lone `~` can pair with another one later in the block.
        '\\' | '`' | '*' | '[' | ']' | '<' | '~' => true,

        // Emphasis with `_` only fires at a word boundary, so `snake_case` stays clean.
        '_' => !is_word(prev) || !is_word(next),

        // A `#` opens a heading at line start, and a tag anywhere.
        '#' if line_start || syntax::scan_tag(rest).is_some() => true,

        // `-`/`+` open a list only when followed by space or end of line; `-` also forms a
        // setext underline or a thematic break when the whole line is dashes.
        '-' | '+' if line_start => {
            matches!(next, None | Some(' ' | '\t' | '\n')) || rest_of_line_is(rest, c)
        }
        // A setext `=` underline turns the paragraph above into a heading. A lone `=` on its
        // own line counts, so an empty remainder must qualify too.
        '=' if line_start && rest_of_line_is_all(rest, '=') => true,

        '>' if line_start => true,

        // Escape the `.`/`)` of an ordered marker, never the digits: a backslash before a
        // digit is not a valid CommonMark escape and would survive as a literal backslash.
        '.' | ')' if pos.after_digits => matches!(next, None | Some(' ' | '\t' | '\n')),

        // Paired inline constructs: escape the opener only when a closer exists.
        '=' if next == Some('=') => true,
        '$' if ctx.escape_dollar || rest.contains('$') => true,
        ':' if syntax::scan_shortcode(rest).is_some() => true,
        '!' if next == Some('[') => true,

        // A trailing `^id` would be read as a block anchor.
        '^' if !is_word(prev) && syntax::is_anchor_tail(rest) => true,

        '|' if in_table => true,
        _ => false,
    }
}

/// True when the remainder of the current line consists solely of `c`.
fn rest_of_line_is(rest: &str, c: char) -> bool {
    let line = rest.split('\n').next().unwrap_or("");
    !line.is_empty() && line.chars().all(|ch| ch == c)
}

/// As [`rest_of_line_is`], but an empty remainder also qualifies — the character stands alone
/// on its line.
fn rest_of_line_is_all(rest: &str, c: char) -> bool {
    rest.split('\n')
        .next()
        .unwrap_or("")
        .chars()
        .all(|ch| ch == c)
}

fn is_word(c: Option<char>) -> bool {
    c.is_some_and(char::is_alphanumeric)
}

/// Chooses a backtick fence long enough to contain `code`, padding when needed.
#[must_use]
pub fn code_span(code: &str) -> String {
    let longest = longest_backtick_run(code);
    let fence = "`".repeat(longest + 1);
    let needs_pad = code.starts_with('`')
        || code.ends_with('`')
        || (code.starts_with(' ') && code.ends_with(' ') && code.trim() != "");
    if needs_pad {
        format!("{fence} {code} {fence}")
    } else {
        format!("{fence}{code}{fence}")
    }
}

#[must_use]
pub fn longest_backtick_run(s: &str) -> usize {
    longest_run_of(s, '`')
}

#[must_use]
pub fn longest_run_of(s: &str, target: char) -> usize {
    let mut longest = 0usize;
    let mut current = 0usize;
    for c in s.chars() {
        if c == target {
            current += 1;
            longest = longest.max(current);
        } else {
            current = 0;
        }
    }
    longest
}

/// Escapes an image's alt text.
///
/// Alt is stored as the source the user wrote — `parse::alt_text` puts a shortcode back as
/// `:name:`, math as `$x$` — so running it through [`text`] would escape the very markup
/// that reconstruction just rebuilt, turning `![:magic_wand:]` into `![\:magic_wand:]`.
/// Only the brackets that delimit the alt, and the backslash itself, need escaping.
#[must_use]
pub fn alt(alt: &str) -> String {
    let mut out = String::with_capacity(alt.len());
    for c in alt.chars() {
        if matches!(c, '[' | ']' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Escapes a code fence's info string.
///
/// An info string is not literal text: CommonMark resolves backslash escapes and entity
/// references inside it, so `a\-` reads back as `a-` and `&amp;` as `&`. Only those two
/// characters need escaping — everything else, `c++` included, is written as it stands so
/// ordinary notes carry no stray backslashes.
#[must_use]
pub fn info_string(lang: &str) -> String {
    let mut out = String::with_capacity(lang.len());
    for c in lang.chars() {
        if c == '\\' || c == '&' {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// The fence for a code block: at least 3 characters, always longer than any run inside.
///
/// Backticks are canonical (§4.5). A tilde fence is used only when the info string contains
/// a backtick, which CommonMark forbids on a backtick fence — it cannot tell the info string
/// from the fence — so the block would not be read back as code at all.
#[must_use]
pub fn block_fence(code: &str, lang: &str) -> String {
    let (marker, longest) = if lang.contains('`') {
        ('~', longest_run_of(code, '~'))
    } else {
        ('`', longest_backtick_run(code))
    };
    marker.to_string().repeat(longest.saturating_add(1).max(3))
}
