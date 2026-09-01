//! Canonical Markdown serialization (`SPEC.md` §4.5).
//!
//! Canonical means **one document has exactly one rendering**. Every choice below is a
//! total function of the document, never of parse history or author style. That is what
//! makes `serialize(parse(x))` idempotent, which in turn is what lets an externally
//! authored file be normalised once and then stay stable in git.

pub mod escape;

use crate::frontmatter;
use crate::model::{Alignment, Block, BlockKind, Callout, Fold, Inline, List, Table, WikiLink};
use crate::task;

use escape::Ctx;

/// Serializes a document to canonical Markdown, always ending in exactly one newline.
#[must_use]
pub fn document(doc: &crate::model::Document) -> String {
    let mut out = frontmatter::render(&doc.frontmatter);
    if !out.is_empty() && !doc.blocks.is_empty() {
        out.push('\n');
    }
    out.push_str(&blocks(&doc.blocks));
    let trimmed = out.trim_end_matches('\n');
    if trimmed.is_empty() {
        return if out.is_empty() {
            String::new()
        } else {
            format!("{trimmed}\n")
        };
    }
    format!("{trimmed}\n")
}

/// Serializes a block sequence, separating blocks with exactly one blank line.
#[must_use]
pub fn blocks(items: &[Block]) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(items.len());
    for b in items {
        parts.push(block(b));
    }
    parts.join("\n")
}

fn block(b: &Block) -> String {
    let body = match &b.kind {
        BlockKind::Paragraph(content) => paragraph(content),
        BlockKind::Heading { level, content } => {
            let hashes = "#".repeat(level.get() as usize);
            // ATX headings are single-line by construction; a break here would split the
            // heading into a heading plus a paragraph on reparse.
            let text = inlines(content, Ctx::inline()).replace('\n', " ");
            let text = escape_closing_hashes(text.trim_end());
            if text.is_empty() {
                hashes
            } else {
                format!("{hashes} {text}")
            }
        }
        BlockKind::List(list) => render_list(list),
        BlockKind::Blockquote(inner) => prefix_lines(&blocks(inner), "> ", ">"),
        BlockKind::Callout(c) => callout(c),
        BlockKind::CodeBlock { lang, code } => {
            let lang = lang.as_deref().unwrap_or("");
            let fence = escape::block_fence(code, lang);
            let lang = escape::info_string(lang);
            // why: the newline before the closing fence belongs to the fence, and `canonical`
            // already strips it from `code`. Stripping a second one here ate a trailing blank
            // line on every save, so a code block that ended in one never settled.
            if code.is_empty() {
                format!("{fence}{lang}\n{fence}")
            } else {
                format!("{fence}{lang}\n{code}\n{fence}")
            }
        }
        // `***` rather than `---`, which is ambiguous three ways: it opens a frontmatter
        // fence at the start of a file, underlines a setext heading after a paragraph, and
        // collides with the list marker in `- ---`. `***` has none of those readings, and
        // picking one form unconditionally keeps the output canonical.
        BlockKind::Divider => "***".to_string(),
        BlockKind::Table(t) => table(t),
        BlockKind::MathBlock(m) => math_block(m),
    };
    // Some renderers (lists, callouts) already end in a newline and some (paragraphs, code
    // fences) do not. Normalising here is what keeps exactly one blank line between blocks.
    let body = body.trim_end_matches('\n');
    match &b.anchor {
        Some(a) => append_anchor(body, a),
        None => format!("{body}\n"),
    }
}

/// Escapes a trailing `#` run that CommonMark would eat as an ATX closing sequence.
///
/// `# a #` means the heading "a": the final run of `#` preceded by whitespace is an optional
/// closing sequence and is discarded. So a heading whose text genuinely *ends* in `#` loses
/// the character on the way back in, and `# #` comes back empty — the text gone entirely.
///
/// Escaping the first `#` of the run is enough: the closing sequence must be `#` all the way
/// back to the whitespace, and a backslash breaks that. `# a#`, with no space, was never a
/// closing sequence and is left alone so ordinary prose is not littered with backslashes.
///
/// Found by `make fuzz TARGET=normalize`.
fn escape_closing_hashes(text: &str) -> String {
    let run = text.len() - text.trim_end_matches('#').len();
    if run == 0 {
        return text.to_string();
    }
    let Some(before) = text.get(..text.len() - run) else {
        return text.to_string();
    };
    // A run that is the whole text is a closing sequence too: `# #` is an empty heading.
    let is_closing = before.is_empty() || before.ends_with([' ', '\t']);
    if !is_closing {
        return text.to_string();
    }
    format!("{before}\\{}", text.get(text.len() - run..).unwrap_or(""))
}

/// Renders `$$ … $$`, choosing the fenced or the single-line form.
///
/// The fenced form is canonical and is what Obsidian writes. It is not always *available*:
/// `$$` is recognised at the paragraph level (see `parse::as_math_block`), so a body that
/// CommonMark would read as a block construct once it stands on its own line — `***`, `# x`,
/// `- x` — splits the paragraph on the way back in and the fences never pair up. The file
/// then changes again on the second save, which is exactly what §4.5 promises it will not.
///
/// A single-line body always survives the single-line form, so that is the fallback. The
/// choice is a total function of the body, so the output stays canonical.
///
/// Multi-line bodies need no fallback: a body line that starts a block construct also splits
/// the *source* paragraph, so no parse can produce such a math block in the first place.
///
/// Found by `make fuzz TARGET=normalize`, on `$$$$` and then `$$****$$`.
fn math_block(body: &str) -> String {
    let body = body.trim_matches('\n');
    if body.is_empty() {
        // A blank line between the fences reads back as two paragraphs, not as math.
        return "$$\n$$".to_string();
    }
    if !body.contains('\n') && starts_a_block(body) {
        return format!("$${body}$$");
    }
    format!("$$\n{body}\n$$")
}

/// Conservatively true when a line on its own would open a CommonMark block construct.
///
/// Over-approximating is deliberate and free: a false positive only picks the single-line
/// math form where the fenced one would also have worked, which is a cosmetic difference. A
/// false negative is a file that never stops changing.
fn starts_a_block(line: &str) -> bool {
    let t = line.trim_start();
    if t.is_empty() {
        return true;
    }
    // Thematic break, setext underline, list marker, ATX heading, fence, quote, table row.
    if t.starts_with(['#', '>', '-', '+', '*', '_', '=', '~', '`', '|']) {
        return true;
    }
    // Ordered list marker: `1.`, `10)`.
    let digits = t.chars().take_while(char::is_ascii_digit).count();
    digits > 0 && t.get(digits..).is_some_and(|r| r.starts_with(['.', ')']))
}

/// `^block-id` goes at the end of the block's final line (Obsidian convention).
fn append_anchor(body: &str, anchor: &str) -> String {
    let trimmed = body.trim_end_matches('\n');
    match trimmed.rsplit_once('\n') {
        Some((head, last)) => format!("{head}\n{last} ^{anchor}\n"),
        None => format!("{trimmed} ^{anchor}\n"),
    }
}

fn paragraph(content: &[Inline]) -> String {
    inlines(content, Ctx::line_start())
}

fn callout(c: &Callout) -> String {
    let fold = match c.fold {
        Fold::None => "",
        Fold::Expanded => "+",
        Fold::Collapsed => "-",
    };
    let title = inlines(&c.title, Ctx::inline());
    let mut header = format!("[!{}]{fold}", c.kind);
    if !title.is_empty() {
        header.push(' ');
        header.push_str(&title);
    }
    let body = blocks(&c.content);
    let inner = if body.trim().is_empty() {
        header
    } else {
        format!("{header}\n\n{body}")
    };
    prefix_lines(&inner, "> ", ">")
}

/// Applies `pfx` to non-empty lines and `empty_pfx` to blank ones, so no trailing
/// whitespace is ever emitted (§4.5).
fn prefix_lines(text: &str, pfx: &str, empty_pfx: &str) -> String {
    let mut out = String::new();
    for line in text.trim_end_matches('\n').split('\n') {
        if line.is_empty() {
            out.push_str(empty_pfx);
        } else {
            out.push_str(pfx);
            out.push_str(line);
        }
        out.push('\n');
    }
    out
}

fn render_list(list: &List) -> String {
    // CommonMark looseness is a property of the whole list, not of individual items.
    // Emitting a tight list when every item is a single paragraph is what makes the
    // parse-back structurally identical.
    let loose = list.items.iter().any(|i| {
        i.content.len() > 1
            || i.content
                .iter()
                .any(|b| !matches!(b.kind, BlockKind::Paragraph(_)))
    });

    let mut out = String::new();
    for (idx, item) in list.items.iter().enumerate() {
        let marker = if list.ordered {
            let n = if idx == 0 { list.start } else { 1 };
            format!("{n}. ")
        } else {
            "- ".to_string()
        };
        // why: the space after the marker separates it from the text. With no text there is
        // nothing to separate, and emitting it would leave trailing whitespace on the line
        // (§4.5). `- [ ]` still reads back as a task.
        let empty_item = item.content.is_empty();
        let task_prefix = match (&item.task, empty_item) {
            (Some(t), false) => format!("[{}] ", t.status.marker()),
            (Some(t), true) => format!("[{}]", t.status.marker()),
            (None, _) => String::new(),
        };
        let indent = " ".repeat(marker.chars().count());

        let mut body = blocks(&item.content);
        if let Some(t) = &item.task {
            let anchor = item.content.first().and_then(|b| b.anchor.as_deref());
            body = with_task_meta(&body, &t.meta, anchor);
        }

        let mut lines = body.trim_end_matches('\n').split('\n');
        let first = lines.next().unwrap_or("");
        let line = format!("{marker}{task_prefix}{first}");
        out.push_str(line.trim_end());
        out.push('\n');
        for line in lines {
            if line.is_empty() {
                out.push('\n');
            } else {
                out.push_str(&indent);
                out.push_str(line);
                out.push('\n');
            }
        }
        if loose && idx + 1 < list.items.len() {
            out.push('\n');
        }
    }
    out
}

/// Appends task metadata to the end of the task's first line, in canonical order.
///
/// `anchor` is the `^block-id` of the item's first block, taken from the model rather than
/// recognised in the rendered text. why: the text form is ambiguous — a literal `^` at the
/// end of trailing emphasis looks exactly like an anchor, and guessing spliced the metadata
/// into the middle of the emphasis, losing it on reparse. Found at `PROPTEST_CASES=20000`.
fn with_task_meta(body: &str, meta: &task::TaskMeta, anchor: Option<&str>) -> String {
    let rendered = task::render_meta(meta);
    if rendered.is_empty() {
        return body.to_string();
    }
    let (first, rest) = match body.split_once('\n') {
        Some((first, rest)) => (first.to_string(), Some(rest.to_string())),
        None => (body.to_string(), None),
    };
    // A block anchor must stay last on its line, so metadata goes before it rather than
    // after — `a ^id 📅 …` would no longer read back as an anchor.
    let suffix = anchor.map(|a| format!(" ^{a}"));
    let first = match suffix.as_deref().and_then(|s| first.strip_suffix(s)) {
        Some(head) => format!("{head}{rendered}{}", suffix.unwrap_or_default()),
        None => format!("{first}{rendered}"),
    };
    match rest {
        Some(rest) => format!("{first}\n{rest}"),
        None => first,
    }
}

fn table(t: &Table) -> String {
    let cols = t
        .head
        .len()
        .max(t.rows.iter().map(Vec::len).max().unwrap_or(0))
        .max(t.alignments.len());
    let mut out = String::new();

    let row = |cells: &[Vec<Inline>]| {
        let mut line = String::from("|");
        for i in 0..cols {
            let content = cells
                .get(i)
                .map(|c| inlines(c, Ctx::table_cell()))
                .unwrap_or_default();
            line.push(' ');
            line.push_str(content.trim());
            line.push_str(" |");
        }
        line.push('\n');
        line
    };

    out.push_str(&row(&t.head));
    out.push('|');
    for i in 0..cols {
        let a = t.alignments.get(i).copied().unwrap_or(Alignment::None);
        out.push_str(match a {
            Alignment::None => " --- |",
            Alignment::Left => " :-- |",
            Alignment::Center => " :-: |",
            Alignment::Right => " --: |",
        });
    }
    out.push('\n');
    for r in &t.rows {
        out.push_str(&row(r));
    }
    out
}

/// Renders an inline sequence. `ctx` describes the position of the *first* character.
#[must_use]
pub fn inlines(items: &[Inline], ctx: Ctx) -> String {
    inlines_in(items, ctx, None, false)
}

/// Renders inlines knowing what surrounds them.
///
/// `enclosing_prev` and `enclosing_next_star` describe the characters the *parent* will emit
/// immediately around this sequence. Without them a nested emphasis cannot see the `**` of
/// its enclosing strong, and `Strong(Emphasis(x))` renders `***x***` — which CommonMark reads
/// back as `Emphasis(Strong(x))`, silently inverting the document.
fn inlines_in(
    items: &[Inline],
    ctx: Ctx,
    enclosing_prev: Option<char>,
    enclosing_next_star: bool,
) -> String {
    // Decided once per block and threaded down: see `Ctx::escape_dollar`.
    let ctx = if ctx.escape_dollar {
        ctx
    } else {
        ctx.with_dollar(dollar_count(items) > 1)
    };
    let mut out = String::new();
    for (i, item) in items.iter().enumerate() {
        // A soft or hard break puts the following text at a line start, where `#`, `-`,
        // `>` and ordered markers become block constructs again.
        let at_start = (out.is_empty() && ctx.at_line_start) || out.ends_with('\n');
        let cur = Ctx {
            at_line_start: at_start,
            ..ctx
        };
        // Only an *unescaped* `*` can fuse with an emphasis delimiter. `\*` is a literal
        // asterisk and is inert, so treating it as a delimiter would needlessly switch to
        // `_` — which then fails against a following word character.
        let prev_star = if out.is_empty() {
            enclosing_prev == Some('*')
        } else {
            out.ends_with('*') && !out.ends_with("\\*")
        };
        let next_star = match items.get(i + 1) {
            Some(next) => renders_leading_star(next),
            None => enclosing_next_star,
        };
        // A delimiter can pair *across* inlines: `Text(":a")` beside `Emoji("a")` renders
        // `:a:a:`, whose first three characters read back as a shortcode. Escaping the text
        // as if the neighbour's opening character were already appended makes the escaper's
        // existing rules see the completed construct, in either direction.
        let next_lead = items.get(i + 1).and_then(leading_char);
        let mut rendered = match (item, next_lead) {
            (Inline::Text(t), Some(c)) if matches!(c, ':' | '$' | '=' | '~' | '`' | '[') => {
                strip_sentinel(&escape::text(&format!("{t}{c}"), cur), c)
            }
            _ => inline(item, cur, prev_star, next_star),
        };
        // `]` immediately followed by `(` is a link destination: a wikilink beside text that
        // opens with a bracket would render `[[a]](…)` and read back as a link.
        if rendered.starts_with('(') && out.ends_with(']') && !out.ends_with("\\]") {
            rendered.insert(0, '\\');
        }
        out.push_str(&rendered);
    }
    out
}

/// Counts `$` characters a block will emit, including the delimiters of math nodes.
fn dollar_count(items: &[Inline]) -> usize {
    items
        .iter()
        .map(|item| match item {
            Inline::Text(t) => t.matches('$').count(),
            // A `$` inside a code span is *not* counted. It used to be, because maths was
            // recognised after CommonMark and a bare `$` could pair into a code span and
            // swallow the backticks. `parse::math` asks `pulldown-cmark` where the code
            // spans are and refuses to cross one, so that pairing can no longer happen —
            // and counting it made the escape decision differ between two passes over the
            // same document.
            Inline::Code(_) => 0,
            Inline::Image { alt, dest } => alt.matches('$').count() + dest.matches('$').count(),
            Inline::Math(_) => 2,
            Inline::Emphasis(c)
            | Inline::Strong(c)
            | Inline::Strikethrough(c)
            | Inline::Highlight(c) => dollar_count(c),
            Inline::Link { content, dest, .. } => dollar_count(content) + dest.matches('$').count(),
            _ => 0,
        })
        .sum()
}

/// The first character this inline will render, for fusion checks.
fn leading_char(item: &Inline) -> Option<char> {
    match item {
        Inline::Text(t) => t.chars().next(),
        Inline::Emoji(_) => Some(':'),
        Inline::Math(_) => Some('$'),
        Inline::Code(_) => Some('`'),
        Inline::Highlight(_) => Some('='),
        Inline::Strikethrough(_) => Some('~'),
        // A `[` matters because a preceding `!` would turn the link into an embed:
        // `Text("!")` beside `[[a]]` renders `![[a]]`.
        Inline::WikiLink(w) => Some(if w.embed { '!' } else { '[' }),
        Inline::Link { .. } | Inline::FootnoteRef(_) => Some('['),
        Inline::Image { .. } => Some('!'),
        _ => None,
    }
}

/// Removes a sentinel character appended before escaping, including a backslash the escaper
/// may have added in front of it.
fn strip_sentinel(escaped: &str, c: char) -> String {
    let mut out = escaped.to_string();
    if out.ends_with(c) {
        out.truncate(out.len() - c.len_utf8());
    }
    // Only an odd trailing run of backslashes belonged to the sentinel.
    let backslashes = out.chars().rev().take_while(|ch| *ch == '\\').count();
    if backslashes % 2 == 1 {
        out.truncate(out.len() - 1);
    }
    out
}

/// True when this inline will render starting with `*`, which would fuse with a preceding
/// `*` emphasis delimiter into an ambiguous run.
fn renders_leading_star(item: &Inline) -> bool {
    matches!(item, Inline::Strong(_) | Inline::Emphasis(_))
}

fn inline(item: &Inline, ctx: Ctx, prev_star: bool, next_star: bool) -> String {
    match item {
        Inline::Text(t) => escape::text(t, ctx),
        Inline::Strong(c) => {
            format!("**{}**", inlines_in(c, ctx.nested(), Some('*'), true))
        }
        Inline::Emphasis(c) => {
            // `*` is the default because, unlike `_`, it opens and closes intraword: CommonMark
            // classifies `_` by Unicode flanking rules that treat unassigned codepoints as
            // neither punctuation nor whitespace, which silently breaks emphasis. `*` has no
            // such edge.
            //
            // The one case `*` cannot handle is abutting another `*` run — `Strong(Emphasis(x))`
            // would render `***x***`, which CommonMark reads back as `Emphasis(Strong(x))`. There
            // we switch to `_`, which is safe precisely because its neighbour is punctuation.
            let mut d = match ctx.emphasis_delim {
                // Nested inside another emphasis: alternate, or the two runs fuse.
                Some('*') => '_',
                Some(_) => '*',
                // Otherwise `*` unless it would abut a neighbouring `*` run.
                None if prev_star || next_star => '_',
                None => '*',
            };
            // The body itself can end in `*` — `Emphasis([Text("A"), Strong([…])])` renders
            // `*A**…***`, whose trailing run is ambiguous. Probing the rendered body is the
            // only way to see this, since it depends on the *last* child, not the next
            // sibling.
            if d == '*' {
                let probe = inlines_in(c, ctx.nested().with_emphasis('*'), Some('*'), true);
                let fuses =
                    probe.starts_with('*') || (probe.ends_with('*') && !probe.ends_with("\\*"));
                if fuses {
                    d = '_';
                }
            }
            let body = inlines_in(c, ctx.nested().with_emphasis(d), Some(d), d == '*');
            format!("{d}{body}{d}")
        }
        Inline::Strikethrough(c) => {
            format!("~~{}~~", inlines_in(c, ctx.nested(), Some('~'), false))
        }
        Inline::Highlight(c) => {
            // `=` is the only delimiter character not escaped unconditionally in text, so a
            // highlight whose content starts or ends with one would fuse with its own
            // delimiters: `==` + `=` + `==` is five equals signs, not a highlight of "=".
            format!(
                "=={}==",
                guard_edges(&inlines_in(c, ctx.nested(), Some('='), false), '=')
            )
        }
        Inline::Code(c) => escape::code_span(c),
        Inline::Math(m) => format!("${m}$"),
        Inline::Link {
            dest,
            title,
            content,
        } => {
            let target = match title {
                Some(t) => format!("{} {}", link_dest(dest), link_title(t)),
                None => link_dest(dest),
            };
            format!(
                "[{}]({target})",
                inlines_in(content, ctx.nested(), Some('['), false)
            )
        }
        Inline::Image { dest, alt } => {
            format!("![{}]({})", escape::alt(alt), link_dest(dest))
        }
        Inline::WikiLink(w) => wikilink(w, ctx),
        Inline::Tag(t) => {
            // why: a tag name may contain `_`, and an enclosing emphasis delimited by `_`
            // would pair with it — `_#a-_a_` reads back as a literal underscore, a shorter
            // tag, and an emphasis around the rest. Escaping is confined to that case so
            // ordinary `#a-_a` stays clean; `*` emphasis needs nothing, because a tag name
            // cannot contain a `*`.
            match ctx.emphasis_delim {
                Some('_') => format!("#{}", t.replace('_', "\\_")),
                _ => format!("#{t}"),
            }
        }
        Inline::Emoji(name) => format!(":{name}:"),
        Inline::FootnoteRef(n) => format!("[^{n}]"),
        Inline::SoftBreak => "\n".to_string(),
        Inline::HardBreak => "\\\n".to_string(),
    }
}

/// Backslash-escapes a leading or trailing `c` so it cannot merge with an adjacent delimiter.
fn guard_edges(body: &str, c: char) -> String {
    let mut out = body.to_string();
    if out.ends_with(c) {
        let cut = out.len() - c.len_utf8();
        // Parity again: in `\\=` the backslash escapes the *backslash*, leaving the `=` live.
        // Only an odd run of backslashes means the character is already escaped.
        let preceding = out.get(..cut).unwrap_or("");
        let backslashes = preceding.chars().rev().take_while(|ch| *ch == '\\').count();
        if backslashes % 2 == 0 {
            out.insert(cut, '\\');
        }
    }
    if out.starts_with(c) {
        out.insert(0, '\\');
    }
    out
}

fn link_dest(dest: &str) -> String {
    // Destinations resolve backslash escapes just as text does, so a literal `\` has to be
    // doubled or it silently disappears on the next read.
    let escaped = dest.replace('\\', "\\\\");
    if escaped.is_empty() || escaped.contains([' ', '(', ')']) {
        // The angle-bracket form additionally treats `<` and `>` as delimiters.
        let inner = escaped.replace('<', "\\<").replace('>', "\\>");
        format!("<{inner}>")
    } else {
        escaped
    }
}

/// Renders a link title, always double-quoted.
///
/// CommonMark allows `"…"`, `'…'` and `(…)`; one form keeps the output canonical. A quote
/// or backslash inside is escaped, or it would close the title early.
fn link_title(title: &str) -> String {
    let escaped = title.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

fn wikilink(w: &WikiLink, ctx: Ctx) -> String {
    let mut inner = w.target.clone();
    match &w.anchor {
        Some(crate::model::Anchor::Heading(h)) => {
            inner.push('#');
            inner.push_str(h);
        }
        Some(crate::model::Anchor::Block(b)) => {
            inner.push_str("#^");
            inner.push_str(b);
        }
        None => {}
    }
    if let Some(alias) = &w.alias {
        inner.push('|');
        inner.push_str(alias);
    }
    // An alias separator is a literal `|`, which would otherwise end the table cell.
    if ctx.in_table {
        inner = inner.replace('|', "\\|");
    }
    if w.embed {
        format!("![[{inner}]]")
    } else {
        format!("[[{inner}]]")
    }
}
