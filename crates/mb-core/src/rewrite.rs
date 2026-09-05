//! Renaming a note or a tag by rewriting **only the link spans** (`SPEC.md` §6.6).
//!
//! ## Why this is not `parse` → change → `serialize`
//!
//! That would be four lines and it would be wrong. §6.6 rewrites inbound links in notes the
//! actor may not even be able to *read*, which is only defensible because the rewrite is
//! surgical: it changes the name inside a `[[…]]` and nothing else. Round-tripping through
//! the model re-canonicalizes the whole file, so a note somebody wrote in Obsidian would
//! come back with its bullets, its emphasis delimiters and its table pipes rewritten. A
//! rename is not permission to reformat somebody's note.
//!
//! So the rewrite is done on the **source text**, splicing new names into the exact byte
//! ranges the old ones occupied, and everything between those ranges is copied verbatim.
//!
//! ## What makes the surgical version trustworthy
//!
//! A text scanner that decides for itself what a link is would eventually rewrite something
//! inside a code fence. So it does not get the last word: every rewrite is **verified
//! against the block model** before it is returned.
//!
//! 1. The source is parsed, the rename is applied to the *model* — where a `[[…]]` inside a
//!    code block is a string and not a link, so it cannot be touched — and the result is
//!    canonicalized. That is the oracle: exactly the document the rewrite must produce.
//! 2. The text rewrite is spliced.
//! 3. The spliced text is parsed, and refused unless it equals the oracle.
//!
//! Step 3 catches both failure directions at once. Touching something that is not a link
//! makes the documents differ; *missing* a link makes them differ too, because the oracle
//! renamed it. So the scanner's fidelity is a question of whether a rename succeeds, never
//! of whether it corrupts — the same bargain `parse::math` strikes with its masker.
//!
//! A refusal is fail-closed and total: the caller writes nothing, for any note. What is
//! known to trigger one is a new name carrying a character that pairs with one already in
//! the note — splicing a name containing `$` into a note that has another `$` on the line
//! turns the span between them into maths, so the link stops being a link. The name is
//! checked against the parser on its own before any of that ([`validate_name`]), which
//! leaves only the cases that depend on the note it lands in.

use core::ops::Range;
use std::collections::BTreeSet;
use std::fmt;

use pulldown_cmark::{Event, Parser, Tag, TagEnd};

use crate::model::{Block, BlockKind, Document, Inline};
use crate::{frontmatter, names, parse, syntax};

/// A byte range of the **source** that a rewrite replaced.
///
/// Recorded so a caller can state what it changed rather than assert it: §6.6 requires the
/// diff to touch only link spans, and these are them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

/// One note's source, rewritten.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rewrite {
    text: String,
    spans: Vec<Span>,
}

impl Rewrite {
    /// The rewritten source, byte-identical to the original outside [`Rewrite::spans`].
    #[must_use]
    pub fn text(&self) -> &str {
        &self.text
    }

    /// The source ranges that were replaced, in ascending order.
    #[must_use]
    pub fn spans(&self) -> &[Span] {
        &self.spans
    }

    /// How many names were rewritten.
    #[must_use]
    pub fn count(&self) -> usize {
        self.spans.len()
    }

    /// Whether anything changed. A note with no inbound reference is not rewritten at all.
    #[must_use]
    pub fn changed(&self) -> bool {
        !self.spans.is_empty()
    }

    fn unchanged(source: &str) -> Self {
        Self {
            text: source.to_string(),
            spans: Vec::new(),
        }
    }
}

/// Why a rewrite was refused. Every variant means nothing was written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RewriteError {
    /// The new note name could be read as markup, or as more than a name.
    InvalidName(String),
    /// The new tag is not spelled the way [`syntax::scan_tag`] spells a tag.
    InvalidTag(String),
    /// The spliced text did not parse back to the renamed document.
    ///
    /// The note is named by the caller, never by this crate — it is pure and holds no
    /// paths — and a caller must be careful where it repeats the name: a note the actor
    /// cannot read must not be named to them (§6.5).
    Unverified,
}

impl fmt::Display for RewriteError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidName(name) => write!(formatter, "`{name}` is not a usable note name"),
            Self::InvalidTag(tag) => write!(formatter, "`{tag}` is not a usable tag"),
            Self::Unverified => formatter.write_str(
                "the rewritten note did not parse back to the renamed document, so it was \
                 discarded",
            ),
        }
    }
}

impl std::error::Error for RewriteError {}

/// Points every wikilink naming one of `from` at `to`, and changes nothing else.
///
/// `from` holds the spellings that currently resolve to the note being renamed — the caller
/// decides that, because resolution is §4.3's nearest-path rule and needs the whole vault.
/// They are matched folded ([`names::fold_name`]), so `[[roadmap]]` and `[[Roadmap]]` are
/// one name. An anchor and an alias are preserved: `[[Roadmap#Q3|the plan]]` keeps both.
///
/// # Errors
///
/// [`RewriteError::InvalidName`] if `to` could be read as anything but a name, and
/// [`RewriteError::Unverified`] if the result did not survive the check described above.
pub fn rename_link_target(
    source: &str,
    from: &[String],
    to: &str,
) -> Result<Rewrite, RewriteError> {
    validate_name(to)?;
    let keys: BTreeSet<String> = from
        .iter()
        .map(|name| names::fold_name(name))
        .filter(|key| !key.is_empty())
        .collect();
    if keys.is_empty() {
        return Ok(Rewrite::unchanged(source));
    }
    let expected = retargeted(source, &keys, to);
    let (body, base, scan) = scannable(source);
    let mut edits: Vec<(Range<usize>, String)> = Vec::new();
    walk(body, &scan, |target, name| {
        if keys.contains(&names::fold_name(name)) {
            edits.push((base + target.start..base + target.end, to.to_string()));
        }
    });
    finish(source, edits, &expected)
}

/// Renames a tag and every tag nested under it, and changes nothing else (§9.3).
///
/// `#project` renamed to `#work` makes `#project/memberberry` into `#work/memberberry`: a
/// nested tag is one tag with a path, so renaming a prefix renames the subtree, which is
/// what the tag pane's tree shows and therefore what a reader expects to have happened.
/// Frontmatter `tags:` are rewritten alongside inline ones, because §9.3 unifies them.
///
/// Matching is folded and by whole segment, so `#Project` is renamed and `#projection`
/// is not.
///
/// # Errors
///
/// [`RewriteError::InvalidTag`] if `to` is not spelled like a tag, and
/// [`RewriteError::Unverified`] if the result did not survive verification.
pub fn rename_tag(source: &str, from: &str, to: &str) -> Result<Rewrite, RewriteError> {
    let from = from.trim().trim_start_matches('#');
    let to = to.trim().trim_start_matches('#');
    validate_tag(to)?;
    if names::fold_tag(from).is_empty() {
        return Ok(Rewrite::unchanged(source));
    }
    let expected = retagged(source, from, to);
    let (body, base, scan) = scannable(source);
    let mut edits: Vec<(Range<usize>, String)> = frontmatter_tag_edits(source, from, to);
    walk_tags(body, &scan, |tag, name| {
        if let Some(renamed) = renamed_tag(name, from, to) {
            edits.push((base + tag.start..base + tag.end, renamed));
        }
    });
    edits.sort_by_key(|(range, _)| range.start);
    finish(source, edits, &expected)
}

/// Splices the edits and refuses the result unless it parses back to `expected`.
fn finish(
    source: &str,
    edits: Vec<(Range<usize>, String)>,
    expected: &Document,
) -> Result<Rewrite, RewriteError> {
    let rewrite = splice(source, edits);
    if crate::parse(rewrite.text()) == *expected {
        Ok(rewrite)
    } else {
        Err(RewriteError::Unverified)
    }
}

/// Whether `to` is usable as the target of a wikilink.
///
/// Exposed so a caller can refuse a rename *before* it reads a vault's worth of notes, and
/// report which name was the problem — [`rename_link_target`] applies the same check.
///
/// # Errors
///
/// [`RewriteError::InvalidName`] with the name that failed.
pub fn validate_link_name(to: &str) -> Result<(), RewriteError> {
    validate_name(to)
}

/// Whether `to` is usable as a tag. The same bargain as [`validate_link_name`].
///
/// # Errors
///
/// [`RewriteError::InvalidTag`] with the tag that failed.
pub fn validate_tag_name(to: &str) -> Result<(), RewriteError> {
    validate_tag(to.trim().trim_start_matches('#'))
}

/// A new note name may be a name and nothing else.
///
/// The characters refused are the ones that would turn a splice into markup — `]]` closes
/// the link early, `|` invents an alias, `#` invents an anchor, `[` and a newline stop it
/// being a wikilink at all. Refusing them here rather than escaping them is deliberate: a
/// note whose name needs escaping inside a link is a note nobody can link to by hand, and
/// the failure belongs at the rename rather than in every file it touched.
fn validate_name(to: &str) -> Result<(), RewriteError> {
    let invalid = to.is_empty()
        || to.trim() != to
        || to.contains(['[', ']', '|', '#', '^', '\\'])
        || to.chars().any(char::is_control)
        // Asked of the parser rather than of a longer character list. A name holding a
        // paired `*`, a backtick or a `$` is not structurally dangerous, it just stops
        // being a link target once CommonMark has had it — and the parser is the only
        // thing that knows which of those pair and which do not.
        || crate::parse(&format!("[[{to}]]")).blocks != vec![Block::new(BlockKind::Paragraph(
            vec![Inline::WikiLink(crate::model::WikiLink {
                target: to.to_string(),
                anchor: None,
                alias: None,
                embed: false,
            })],
        ))];
    if invalid {
        return Err(RewriteError::InvalidName(to.to_string()));
    }
    Ok(())
}

/// A new tag must be exactly what the parser would read back as one tag.
///
/// Asked of [`syntax::scan_tag`] rather than of a character list here, because the escaper
/// and the parser already share that predicate and a third opinion is how `#a_` becomes an
/// emphasis delimiter on somebody's next save.
fn validate_tag(to: &str) -> Result<(), RewriteError> {
    if syntax::scan_tag(to) == Some(to.len()) && !to.is_empty() {
        Ok(())
    } else {
        Err(RewriteError::InvalidTag(to.to_string()))
    }
}

/// The document the rewrite has to produce: the same note with its link targets renamed.
fn retargeted(source: &str, keys: &BTreeSet<String>, to: &str) -> Document {
    let mut doc = crate::parse(source);
    map_blocks(&mut doc.blocks, &mut |inline| {
        if let Inline::WikiLink(link) = inline
            && keys.contains(&names::fold_name(&link.target))
        {
            link.target = to.to_string();
        }
    });
    crate::canonicalize(doc)
}

/// The same, for a tag rename — frontmatter included, because §9.3 unifies the two.
fn retagged(source: &str, from: &str, to: &str) -> Document {
    let mut doc = crate::parse(source);
    for tag in &mut doc.frontmatter.tags {
        if let Some(renamed) = renamed_tag(tag, from, to) {
            *tag = renamed;
        }
    }
    map_blocks(&mut doc.blocks, &mut |inline| {
        if let Inline::Tag(tag) = inline
            && let Some(renamed) = renamed_tag(tag, from, to)
        {
            *tag = renamed;
        }
    });
    crate::canonicalize(doc)
}

/// `tag` renamed when it is `from` or nested under it, keeping the segments below.
///
/// Segment-wise rather than by byte length: folding normalizes to NFC, so a decomposed
/// `Café` and a composed one fold to the same key while occupying a different number of
/// bytes, and slicing by the prefix's length would cut a character in half.
fn renamed_tag(tag: &str, from: &str, to: &str) -> Option<String> {
    if !names::tag_is_under(tag, from) {
        return None;
    }
    let depth = from.split('/').count();
    let kept: Vec<&str> = tag.split('/').skip(depth).collect();
    if kept.is_empty() {
        Some(to.to_string())
    } else {
        Some(format!("{to}/{}", kept.join("/")))
    }
}

fn map_blocks(blocks: &mut [Block], f: &mut impl FnMut(&mut Inline)) {
    for block in blocks {
        match &mut block.kind {
            BlockKind::Paragraph(content) | BlockKind::Heading { content, .. } => {
                map_inlines(content, f);
            }
            BlockKind::List(list) => {
                for item in &mut list.items {
                    map_blocks(&mut item.content, f);
                }
            }
            BlockKind::Blockquote(inner) => map_blocks(inner, f),
            BlockKind::Callout(callout) => {
                map_inlines(&mut callout.title, f);
                map_blocks(&mut callout.content, f);
            }
            BlockKind::Table(table) => {
                for cell in table.head.iter_mut().chain(table.rows.iter_mut().flatten()) {
                    map_inlines(cell, f);
                }
            }
            BlockKind::CodeBlock { .. } | BlockKind::MathBlock(_) | BlockKind::Divider => {}
        }
    }
}

fn map_inlines(items: &mut [Inline], f: &mut impl FnMut(&mut Inline)) {
    for item in items {
        f(item);
        match item {
            Inline::Emphasis(content)
            | Inline::Strong(content)
            | Inline::Strikethrough(content)
            | Inline::Highlight(content)
            | Inline::Link { content, .. } => map_inlines(content, f),
            _ => {}
        }
    }
}

/// Where in a note's body Memberberry's inline syntax may legally be found.
///
/// The parser scans its extensions out of CommonMark `Text` events and nowhere else, so
/// this is that set: every byte inside a text event, minus code-block bodies (which arrive
/// as text events too), image alt text (which the parser flattens rather than scans), and
/// inline maths (which is lifted out before CommonMark ever sees it).
struct Scan {
    /// One flag per byte of the body. A construct is only matched where every byte is set.
    inside: Vec<bool>,
    /// Offsets whose character a backslash escaped, so `\#tag` is text and not a tag.
    escaped: BTreeSet<usize>,
}

impl Scan {
    fn all(&self, range: Range<usize>) -> bool {
        !range.is_empty()
            && self
                .inside
                .get(range)
                .is_some_and(|bytes| bytes.iter().all(|b| *b))
    }
}

/// Splits `source` into its body, that body's offset, and where the scanner may look.
fn scannable(source: &str) -> (&str, usize, Scan) {
    let (_, body) = frontmatter::split(source);
    let base = source.len().saturating_sub(body.len());
    let options = parse::options();
    let mut inside = vec![false; body.len()];
    let mut escaped = BTreeSet::new();
    let mut code = 0usize;
    let mut image = 0usize;
    for (event, range) in Parser::new_ext(body, options).into_offset_iter() {
        match event {
            Event::Start(Tag::CodeBlock(_)) => code += 1,
            Event::End(TagEnd::CodeBlock) => code = code.saturating_sub(1),
            Event::Start(Tag::Image { .. }) => image += 1,
            Event::End(TagEnd::Image) => image = image.saturating_sub(1),
            Event::Text(_) if code == 0 && image == 0 => {
                // why: from the source rather than from the event's own text. A text event
                // whose content was unescaped is shorter than the source it came from, and
                // every offset here is a source offset.
                if let Some(flags) = inside.get_mut(range.clone()) {
                    flags.fill(true);
                }
                if backslashes_before(body, range.start) % 2 == 1 {
                    escaped.insert(range.start);
                }
            }
            _ => {}
        }
    }
    for span in parse::math::spans(body, options) {
        if let Some(flags) = inside.get_mut(span) {
            flags.fill(false);
        }
    }
    (body, base, Scan { inside, escaped })
}

fn backslashes_before(body: &str, at: usize) -> usize {
    body.get(..at)
        .unwrap_or("")
        .chars()
        .rev()
        .take_while(|c| *c == '\\')
        .count()
}

/// A stretch of body text as the parser sees it: escapes applied, code and maths excluded.
///
/// Escapes have to be *applied* rather than avoided, because the parser applies them and
/// then reads its own syntax out of the result. In a table cell the serializer writes
/// `[[Note\|alias]]`, and a scanner that stopped at the backslash would decide that link
/// does not exist — which is a refused rename for every note that links from a table.
struct Resolved {
    /// The characters, escapes resolved. This is what the parser matched its syntax on.
    text: String,
    /// Source offset of the character occupying each byte of [`Resolved::text`].
    source: Vec<usize>,
    /// Source offset just past that character. Not `source + 1`: the two differ for a
    /// multi-byte character, and the *start* excludes an escape's backslash while the end
    /// must not reach across it, or replacing `a` in `[[a\|x]]` would eat the escape.
    ends: Vec<usize>,
    /// Where the resolved text began in the source.
    start: usize,
    /// Source offset just past the last resolved character.
    end: usize,
}

impl Resolved {
    /// Source offset of the character at byte `at` of the resolved text.
    fn source_of(&self, at: usize) -> usize {
        self.source.get(at).copied().unwrap_or(self.end)
    }

    /// Source offset just past the character *before* byte `at` — the end of a prefix.
    fn end_before(&self, at: usize) -> usize {
        match at.checked_sub(1) {
            None => self.start,
            Some(last) => self.ends.get(last).copied().unwrap_or(self.end),
        }
    }
}

/// Resolves forward from `at` until the text stops being scannable, or the line ends.
///
/// Stopping at a line end costs nothing and bounds the work: neither a wikilink nor a tag
/// may contain a newline, so nothing beyond one could have been matched anyway.
fn resolve(body: &str, scan: &Scan, at: usize) -> Resolved {
    let mut out = Resolved {
        text: String::new(),
        source: Vec::new(),
        ends: Vec::new(),
        start: at,
        end: at,
    };
    let mut i = at;
    while let Some(rest) = body.get(i..).filter(|rest| !rest.is_empty()) {
        let Some(mut c) = rest.chars().next() else {
            break;
        };
        let mut char_at = i;
        if !scan.all(i..i + c.len_utf8()) {
            // The one thing outside a text run that is still part of it: the backslash of
            // an escape, which the parser consumed before handing the character over.
            let escape = c == '\\'
                && rest
                    .get(1..)
                    .and_then(|rest| rest.chars().next())
                    .is_some_and(|next| {
                        scan.escaped.contains(&(i + 1)) && scan.all(i + 1..i + 1 + next.len_utf8())
                    });
            if !escape {
                break;
            }
            char_at = i + 1;
            c = rest.chars().nth(1).unwrap_or(c);
        }
        if c == '\n' {
            break;
        }
        i = char_at + c.len_utf8();
        for _ in 0..c.len_utf8() {
            out.source.push(char_at);
            out.ends.push(i);
        }
        out.text.push(c);
        out.end = i;
    }
    out
}

/// Calls `on_target` with the source range of every wikilink target in the body.
fn walk(body: &str, scan: &Scan, mut on_target: impl FnMut(Range<usize>, &str)) {
    let mut at = 0usize;
    while let Some(step) = advance(body, scan, at, &mut on_target, &mut |_, _| {}) {
        at = step;
    }
}

/// The same walk, reporting tag bodies instead — it must skip wikilinks, because the `#`
/// in `[[Note#Heading]]` is an anchor and renaming a tag must not touch it.
fn walk_tags(body: &str, scan: &Scan, mut on_tag: impl FnMut(Range<usize>, &str)) {
    let mut at = 0usize;
    while let Some(step) = advance(body, scan, at, &mut |_, _| {}, &mut on_tag) {
        at = step;
    }
}

/// Advances past one construct or one character, reporting what it was. `None` at the end.
fn advance(
    body: &str,
    scan: &Scan,
    at: usize,
    on_target: &mut impl FnMut(Range<usize>, &str),
    on_tag: &mut impl FnMut(Range<usize>, &str),
) -> Option<usize> {
    let rest = body.get(at..).filter(|rest| !rest.is_empty())?;
    let char_len = rest.chars().next().map_or(1, char::len_utf8);
    if !scan.all(at..at + char_len) || scan.escaped.contains(&at) {
        return Some(at + char_len);
    }
    if let Some(link) = wikilink_at(body, scan, at) {
        on_target(link.target, &link.name);
        return Some(link.end);
    }
    if rest.starts_with('#')
        && let Some(tag) = tag_at(body, scan, at)
    {
        on_tag(tag.body, &tag.name);
        return Some(tag.end);
    }
    Some(at + char_len)
}

/// A wikilink starting at `at`: its end, and the source range of its target.
///
/// The inner rules are `parse::inline::wikilink`'s, deliberately: a construct this reads as
/// a link that the parser does not would splice into ordinary prose. The verification step
/// turns any remaining disagreement into a refusal, but every disagreement removed here is
/// a rename that succeeds instead.
fn wikilink_at(body: &str, scan: &Scan, at: usize) -> Option<FoundLink> {
    let rest = body.get(at..)?;
    let open = if rest.starts_with("![[") {
        3
    } else if rest.starts_with("[[") {
        2
    } else {
        return None;
    };
    // The opening delimiters are the construct's own, so an escape on any of them cancels
    // it — `\[[a]]` is the text somebody wrote to show a wikilink, not a wikilink.
    if (at..at + open).any(|byte| scan.escaped.contains(&byte)) || !scan.all(at..at + open) {
        return None;
    }
    let inner_start = at + open;
    let resolved = resolve(body, scan, inner_start);
    let close = resolved.text.find("]]")?;
    // An escaped `]` does not close a link, and the parser looks no further for one that
    // would, so a link whose first `]]` is escaped is not a link at all.
    let first = resolved.source_of(close);
    let second = resolved.source_of(close + 1);
    if scan.escaped.contains(&first) || scan.escaped.contains(&second) {
        return None;
    }
    let inner = resolved.text.get(..close)?;
    if inner.is_empty() || inner.contains('[') {
        return None;
    }
    // The target is everything before the anchor or the alias, *including* any space
    // hugging it: `[[ Roadmap ]]` names the same note, and replacing only the trimmed part
    // would leave `[[Plan ]]` — a different target from the one the model was given.
    let target_len = inner.find(['#', '|']).unwrap_or(inner.len());
    Some(FoundLink {
        end: second + 1,
        target: inner_start..resolved.end_before(target_len),
        name: inner.get(..target_len).unwrap_or("").to_string(),
    })
}

/// One matched construct: where it ends, which bytes of the source name it, and what that
/// name resolves to. The resolved name is what a match is decided on, because the source
/// may spell it with escapes the parser has already applied.
struct FoundLink {
    end: usize,
    target: Range<usize>,
    name: String,
}

/// A tag starting at the `#` at `at`: its end, and the source range of its body.
fn tag_at(body: &str, scan: &Scan, at: usize) -> Option<FoundTag> {
    let resolved = resolve(body, scan, at + 1);
    let len = syntax::scan_tag(&resolved.text)?;
    let end = resolved.end_before(len);
    Some(FoundTag {
        end,
        body: at + 1..end,
        name: resolved.text.get(..len).unwrap_or("").to_string(),
    })
}

/// One matched tag: the same three answers [`FoundLink`] gives, for `#tag` rather than a link.
struct FoundTag {
    end: usize,
    body: Range<usize>,
    name: String,
}

/// Tag edits inside the frontmatter's `tags:` value (§9.3 unifies inline and frontmatter).
///
/// Hand-rolled against the same shapes `frontmatter::parse` accepts — a flow list, a block
/// list, or a bare scalar — because the frontmatter parser returns values and this needs
/// their offsets. A key it does not recognise is left alone, and the verification step is
/// what turns "left alone when it should not have been" into a refusal rather than a
/// silently stale tag.
fn frontmatter_tag_edits(source: &str, from: &str, to: &str) -> Vec<(Range<usize>, String)> {
    let (Some(body), _) = frontmatter::split(source) else {
        return Vec::new();
    };
    // The body starts after the opening `---` line, which is all `split` removed.
    let base = source.find(body).unwrap_or(0);
    let mut edits = Vec::new();
    let mut offset = 0usize;
    let mut in_tags = false;
    for line in body.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\n', '\r']);
        let starts_key = !trimmed.starts_with([' ', '\t', '-']) && trimmed.contains(':');
        if starts_key {
            in_tags = trimmed
                .split_once(':')
                .is_some_and(|(key, _)| key.trim() == "tags");
            if in_tags {
                let value_at = trimmed.find(':').map_or(trimmed.len(), |at| at + 1);
                collect_tag_items(
                    trimmed.get(value_at..).unwrap_or(""),
                    base + offset + value_at,
                    from,
                    to,
                    &mut edits,
                );
            }
        } else if in_tags && trimmed.trim_start().starts_with('-') {
            let dash = trimmed.find('-').map_or(0, |at| at + 1);
            collect_tag_items(
                trimmed.get(dash..).unwrap_or(""),
                base + offset + dash,
                from,
                to,
                &mut edits,
            );
        }
        offset += line.len();
    }
    edits
}

/// Reports every renamable tag in one frontmatter value, at its offset in the source.
fn collect_tag_items(
    value: &str,
    at: usize,
    from: &str,
    to: &str,
    edits: &mut Vec<(Range<usize>, String)>,
) {
    let (value, at) = match value.trim_start().strip_prefix('[') {
        // A flow list's brackets are not part of any item.
        Some(inner) => {
            let open = value.len() - inner.len();
            (inner.strip_suffix(']').unwrap_or(inner), at + open)
        }
        None => (value, at),
    };
    let mut cursor = 0usize;
    for item in value.split([',', ' ', '\t']) {
        let start = cursor;
        cursor += item.len() + 1;
        let trimmed = item.trim();
        if trimmed.is_empty() {
            continue;
        }
        let lead = item.len() - item.trim_start().len();
        let (text, quote) = match unquoted(trimmed) {
            Some(inner) => (inner, 1),
            None => (trimmed, 0),
        };
        // Matched verbatim, exactly as `frontmatter::parse` reads it. A `tags: ["#project"]`
        // is a tag whose name begins with a `#` as far as the model is concerned, so
        // stripping one here would rename something the oracle left alone — and the
        // verification would refuse the whole rewrite for it.
        let Some(renamed) = renamed_tag(text, from, to) else {
            continue;
        };
        let begin = at + start + lead + quote;
        edits.push((begin..begin + text.len(), renamed));
    }
}

/// The inside of a quoted YAML scalar, if it is one.
fn unquoted(value: &str) -> Option<&str> {
    for quote in ['"', '\''] {
        if value.len() >= 2 && value.starts_with(quote) && value.ends_with(quote) {
            return value.get(1..value.len() - 1);
        }
    }
    None
}

/// Copies `source`, replacing each edit's range. Everything between them is verbatim.
fn splice(source: &str, edits: Vec<(Range<usize>, String)>) -> Rewrite {
    if edits.is_empty() {
        return Rewrite::unchanged(source);
    }
    let mut text = String::with_capacity(source.len());
    let mut spans = Vec::with_capacity(edits.len());
    let mut cursor = 0usize;
    for (range, replacement) in edits {
        // An overlapping edit would corrupt the file, so it is dropped rather than applied.
        // The verification step then refuses the whole rewrite, because a link it expected
        // to be renamed was not.
        if range.start < cursor {
            continue;
        }
        text.push_str(source.get(cursor..range.start).unwrap_or(""));
        text.push_str(&replacement);
        spans.push(Span {
            start: range.start,
            end: range.end,
        });
        cursor = range.end;
    }
    text.push_str(source.get(cursor..).unwrap_or(""));
    Rewrite { text, spans }
}
