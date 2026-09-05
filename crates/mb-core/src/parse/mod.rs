//! Markdown → block model.
//!
//! CommonMark structure comes from `pulldown-cmark`; Memberberry's extensions are scanned
//! out of text runs by [`inline`]. The parser is **total**: it never panics and never
//! rejects input. Anything it cannot model is downgraded to text rather than dropped, so
//! parsing can never lose a user's content.
//!
//! Events are consumed with their source ranges. That costs a little machinery and buys
//! the ability to disambiguate constructs that are identical *after* escaping — a cancelled
//! task `[-]` versus a literal `\[-\]`, or a callout header versus a quoted `\[!note\]`.
//! Without the source, those two cases are indistinguishable and one of them must corrupt.

pub mod inline;
pub mod math;

use core::ops::Range;

use pulldown_cmark::{
    CodeBlockKind, Event, HeadingLevel as CmarkHeading, Options, Parser, Tag, TagEnd,
};

use crate::frontmatter;
use crate::model::{
    Alignment, Block, BlockKind, Callout, Document, Fold, HeadingLevel, Inline, List, ListItem,
    Table,
};
use crate::syntax;
use crate::task::{self, TaskStatus};

/// Parses a complete note, frontmatter included.
#[must_use]
pub fn document(input: &str) -> Document {
    let (fm_body, body) = frontmatter::split(input);
    let frontmatter = fm_body.map(frontmatter::parse).unwrap_or_default();
    // Canonicalizing here means the parser only has to be *correct*, not also normalising:
    // every path into the model funnels through one definition of the normal form.
    crate::canonical::document(Document {
        frontmatter,
        blocks: blocks(body),
    })
}

/// The CommonMark extensions Memberberry's parser runs with.
///
/// Shared with [`crate::rewrite`] rather than written twice: a rewriter that asked
/// `pulldown-cmark` a slightly different question would disagree with the parser about
/// where a code block ends, and the whole point of it is that it cannot.
///
/// ENABLE_MATH is deliberately absent — see [`blocks`].
#[must_use]
pub fn options() -> Options {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    options
}

/// Parses note body Markdown, without frontmatter.
#[must_use]
pub fn blocks(body: &str) -> Vec<Block> {
    let options = options();
    // ENABLE_MATH is deliberately NOT set. pulldown-cmark's display-math handling swallows
    // every block after a `$$` fence inside a list item or blockquote — silently losing user
    // content, which C2 forbids. A code fence in the same position is fine, so this is
    // specific to the math extension. Math is scanned here instead: `$…$` in
    // `parse::inline`, `$$…$$` by `as_math_block` below.

    // Lift inline `$…$` out before CommonMark can chew on it. The masked text is the same
    // length, so every source range below still points where it did (`parse::math`).
    // Lift inline `$…$` out before CommonMark parses the inlines. Where the code is comes
    // from `pulldown-cmark` itself, not from guessing at lines (`parse::math`).
    //
    // The result is then checked: a placeholder that reached the model went somewhere the
    // inline scanner never looks, so that one span is dropped and the parse repeated. Each
    // round removes a span, so this terminates; in practice it never runs twice. It makes
    // the masker's correctness a performance question rather than a data-loss one.
    let mut skip: Vec<usize> = Vec::new();
    loop {
        let (masked, math) = math::mask_except(body, options, &skip);
        if math.is_empty() {
            return parse_events(body, options, &math::Table::default());
        }
        let blocks = parse_events(&masked, options, &math);
        match blocks.iter().find_map(|b| leaked_start(b, &math)) {
            Some(start) => skip.push(start),
            None => return blocks,
        }
    }
}

fn parse_events(body: &str, options: Options, math: &math::Table) -> Vec<Block> {
    let events: Vec<(Event<'_>, Range<usize>)> =
        Parser::new_ext(body, options).into_offset_iter().collect();
    let mut p = Cursor {
        src: body,
        ev: events,
        i: 0,
        math: math.clone(),
    };
    p.blocks(None)
}

/// Source offset of a placeholder that survived into the model, if any.
fn leaked_start(block: &Block, table: &math::Table) -> Option<usize> {
    match &block.kind {
        BlockKind::Paragraph(c) | BlockKind::Heading { content: c, .. } => {
            leaked_in_inlines(c, table)
        }
        BlockKind::CodeBlock { code, lang } => table
            .leaked_start(code)
            .or_else(|| lang.as_deref().and_then(|l| table.leaked_start(l))),
        BlockKind::MathBlock(m) => table.leaked_start(m),
        BlockKind::Blockquote(inner) => inner.iter().find_map(|b| leaked_start(b, table)),
        BlockKind::Callout(c) => leaked_in_inlines(&c.title, table)
            .or_else(|| c.content.iter().find_map(|b| leaked_start(b, table))),
        BlockKind::List(l) => l
            .items
            .iter()
            .find_map(|i| i.content.iter().find_map(|b| leaked_start(b, table))),
        BlockKind::Table(t) => t
            .head
            .iter()
            .chain(t.rows.iter().flatten())
            .find_map(|cell| leaked_in_inlines(cell, table)),
        BlockKind::Divider => None,
    }
}

fn leaked_in_inlines(items: &[Inline], table: &math::Table) -> Option<usize> {
    items.iter().find_map(|i| match i {
        Inline::Text(t) | Inline::Code(t) | Inline::Math(t) => table.leaked_start(t),
        Inline::Image { alt, dest } => table.leaked_start(alt).or_else(|| table.leaked_start(dest)),
        Inline::Emphasis(c)
        | Inline::Strong(c)
        | Inline::Strikethrough(c)
        | Inline::Highlight(c)
        | Inline::Link { content: c, .. } => leaked_in_inlines(c, table),
        _ => None,
    })
}

struct Cursor<'a> {
    src: &'a str,
    ev: Vec<(Event<'a>, Range<usize>)>,
    i: usize,
    math: math::Table,
}

impl<'a> Cursor<'a> {
    fn peek(&self) -> Option<&Event<'a>> {
        self.ev.get(self.i).map(|(e, _)| e)
    }

    fn peek_range(&self) -> Option<Range<usize>> {
        self.ev.get(self.i).map(|(_, r)| r.clone())
    }

    /// End offset of the most recently consumed event, for spans with no container tag.
    fn consumed_end(&self, fallback: usize) -> usize {
        self.i
            .checked_sub(1)
            .and_then(|j| self.ev.get(j))
            .map_or(fallback, |(_, r)| r.end)
    }

    fn bump(&mut self) -> Option<Event<'a>> {
        let ev = self.ev.get(self.i).map(|(e, _)| e.clone());
        if ev.is_some() {
            self.i += 1;
        }
        ev
    }

    /// Consumes blocks until `stop` (or exhaustion) and returns them.
    fn blocks(&mut self, stop: Option<TagEnd>) -> Vec<Block> {
        let mut out: Vec<Block> = Vec::new();

        while let Some(event) = self.peek() {
            if let Event::End(end) = event {
                if stop.is_some_and(|s| s == *end) {
                    self.bump();
                    break;
                }
                // An unexpected close belongs to an enclosing frame: stop without consuming.
                break;
            }

            match event {
                // A tight list item emits its inline content with no wrapping paragraph, so
                // `Start(Link)` and friends can appear at block level. Treating one as an
                // unknown block container would silently discard the link.
                Event::Start(tag) if is_inline_tag(tag) => {
                    let start = self.peek_range().map_or(0, |r| r.start);
                    let content = self.inlines_until(None);
                    if content.is_empty() {
                        self.bump();
                    } else {
                        let range = start..self.consumed_end(start);
                        let live = anchor_is_live(self.src, &range);
                        let raw = self.src.get(range);
                        out.push(finish_text_block(BlockKind::Paragraph(content), live, raw));
                    }
                }
                Event::Start(_) => {
                    if let Some(block) = self.start_block() {
                        // A paragraph with no content has no Markdown rendering, so keeping
                        // one would break idempotence: it vanishes on the next parse.
                        if !is_empty_paragraph(&block) {
                            out.push(block);
                        }
                    }
                }
                Event::TaskListMarker(_) => {
                    self.bump();
                }
                Event::Rule => {
                    self.bump();
                    out.push(Block::new(BlockKind::Divider));
                }
                Event::Html(h) => {
                    // Raw HTML is not in the block model (SPEC 4.4). Downgrading it to text
                    // keeps the content; only its HTML semantics are lost, and the result is
                    // stable on every subsequent round trip. Embedded newlines become soft
                    // breaks so the text carries no raw newline for the serializer to re-emit.
                    let text = h.to_string();
                    self.bump();
                    out.push(Block::new(BlockKind::Paragraph(text_with_breaks(&text))));
                }
                _ => {
                    // Bare inline content at block level: a tight list item's text, which
                    // carries no `Start(Paragraph)` and so has no range of its own.
                    let start = self.peek_range().map_or(0, |r| r.start);
                    let content = self.inlines_until(None);
                    if !content.is_empty() {
                        let range = start..self.consumed_end(start);
                        let live = anchor_is_live(self.src, &range);
                        let raw = self.src.get(range);
                        out.push(finish_text_block(BlockKind::Paragraph(content), live, raw));
                    } else {
                        self.bump();
                    }
                }
            }
        }
        out
    }

    fn start_block(&mut self) -> Option<Block> {
        let range = self.peek_range()?;
        let Some(Event::Start(tag)) = self.bump() else {
            return None;
        };

        let block = match tag {
            Tag::Paragraph => {
                let content = self.inlines_until(Some(TagEnd::Paragraph));
                let live = anchor_is_live(self.src, &range);
                let raw = self.src.get(range.clone());
                finish_text_block(BlockKind::Paragraph(content), live, raw)
            }
            Tag::Heading { level, .. } => {
                let content = self.inlines_until(Some(TagEnd::Heading(level)));
                // A setext heading can span several source lines, but ATX — the canonical
                // form — cannot. Flattening breaks to spaces here keeps the model free of
                // headings that have no canonical rendering.
                let content = flatten_breaks(content);
                let live = anchor_is_live(self.src, &range);
                finish_text_block(
                    BlockKind::Heading {
                        level: heading_level(level),
                        content,
                    },
                    live,
                    None,
                )
            }
            Tag::BlockQuote(_) => {
                let inner = self.blocks(Some(TagEnd::BlockQuote(None)));
                match detect_callout(inner, self.src, &range) {
                    Ok(callout) => Block::new(BlockKind::Callout(callout)),
                    Err(inner) => Block::new(BlockKind::Blockquote(inner)),
                }
            }
            Tag::CodeBlock(kind) => {
                let lang = match kind {
                    CodeBlockKind::Fenced(l) if !l.is_empty() => Some(l.to_string()),
                    _ => None,
                };
                let mut code = String::new();
                while let Some(event) = self.peek() {
                    match event {
                        Event::End(TagEnd::CodeBlock) => {
                            self.bump();
                            break;
                        }
                        Event::Text(t) => {
                            code.push_str(t);
                            self.bump();
                        }
                        _ => {
                            self.bump();
                        }
                    }
                }
                // The fence's closing newline belongs to the fence, not the code. Keeping it
                // would make the model's representation of the same block depend on whether
                // it came from a parse or from the editor.
                let code = code.strip_suffix('\n').map(str::to_string).unwrap_or(code);
                Block::new(BlockKind::CodeBlock { lang, code })
            }
            Tag::List(start) => {
                let ordered = start.is_some();
                let items = self.list_items();
                Block::new(BlockKind::List(List {
                    ordered,
                    start: start.unwrap_or(1),
                    items,
                }))
            }
            Tag::Table(aligns) => {
                let alignments = aligns.iter().map(convert_alignment).collect();
                let (head, rows) = self.table_body();
                Block::new(BlockKind::Table(Table {
                    alignments,
                    head,
                    rows,
                }))
            }
            other => {
                // Unmodelled container (definition lists, footnote definitions, …).
                // Keep its contents rather than discarding them.
                let inner = self.blocks(Some(container_end(&other)));
                return Some(match inner.len() {
                    1 => inner
                        .into_iter()
                        .next()
                        .unwrap_or(Block::new(BlockKind::Divider)),
                    _ => Block::new(BlockKind::Blockquote(inner)),
                });
            }
        };
        Some(block)
    }

    fn list_items(&mut self) -> Vec<ListItem> {
        let mut items = Vec::new();
        while let Some(event) = self.peek() {
            match event {
                Event::End(TagEnd::List(_)) => {
                    self.bump();
                    break;
                }
                Event::Start(Tag::Item) => {
                    let range = self.peek_range().unwrap_or(0..0);
                    self.bump();
                    let mut task = self.lookahead_task_status().map(|status| task::Task {
                        status,
                        meta: task::TaskMeta::default(),
                    });
                    if task.is_none() && raw_item_is_cancelled(self.src, &range) {
                        task = Some(task::Task {
                            status: TaskStatus::Cancelled,
                            meta: task::TaskMeta::default(),
                        });
                    }
                    let mut content = self.blocks(Some(TagEnd::Item));
                    if task
                        .as_ref()
                        .is_some_and(|t| t.status == TaskStatus::Cancelled)
                    {
                        strip_cancelled_marker(&mut content);
                    }
                    if let Some(t) = &mut task {
                        t.meta = extract_task_meta(&mut content);
                    }
                    items.push(ListItem { task, content });
                }
                _ => {
                    self.bump();
                }
            }
        }
        items
    }

    /// Finds an item's task marker without consuming it.
    ///
    /// Position depends on list looseness: a tight item emits `TaskListMarker` directly
    /// after `Start(Item)`, but a **loose** item wraps its content in a paragraph first and
    /// emits the marker inside it. Checking only the tight position silently produces an
    /// empty leading paragraph and loses the task — so both are checked here.
    fn lookahead_task_status(&self) -> Option<TaskStatus> {
        let mut idx = self.i;
        if matches!(
            self.ev.get(idx).map(|(e, _)| e),
            Some(Event::Start(Tag::Paragraph))
        ) {
            idx += 1;
        }
        match self.ev.get(idx).map(|(e, _)| e) {
            Some(Event::TaskListMarker(done)) => Some(if *done {
                TaskStatus::Done
            } else {
                TaskStatus::Todo
            }),
            _ => None,
        }
    }

    fn table_body(&mut self) -> (Vec<Vec<Inline>>, Vec<Vec<Vec<Inline>>>) {
        let mut head = Vec::new();
        let mut rows = Vec::new();
        while let Some(event) = self.peek() {
            match event {
                Event::End(TagEnd::Table) => {
                    self.bump();
                    break;
                }
                Event::Start(Tag::TableHead) => {
                    self.bump();
                    head = self.table_row(TagEnd::TableHead);
                }
                Event::Start(Tag::TableRow) => {
                    self.bump();
                    rows.push(self.table_row(TagEnd::TableRow));
                }
                _ => {
                    self.bump();
                }
            }
        }
        (head, rows)
    }

    fn table_row(&mut self, stop: TagEnd) -> Vec<Vec<Inline>> {
        let mut cells = Vec::new();
        while let Some(event) = self.peek() {
            match event {
                Event::End(end) if *end == stop => {
                    self.bump();
                    break;
                }
                Event::Start(Tag::TableCell) => {
                    self.bump();
                    cells.push(self.inlines_until(Some(TagEnd::TableCell)));
                }
                _ => {
                    self.bump();
                }
            }
        }
        cells
    }

    /// Collects inline events. With `stop`, consumes the closing tag; without, stops at the
    /// first event that is not inline content.
    fn inlines_until(&mut self, stop: Option<TagEnd>) -> Vec<Inline> {
        let raw = self.scan_items_until(stop);
        finish_inlines(raw)
    }

    /// Collects raw scan items without merging, so highlight delimiters stay identifiable.
    fn scan_items_until(&mut self, stop: Option<TagEnd>) -> Vec<inline::ScanItem> {
        let mut out: Vec<inline::ScanItem> = Vec::new();
        // Consecutive `Text` events are contiguous in the source but arbitrarily split by
        // CommonMark's own tokenizer: `[[a]]` arrives as `[`, `[a]`, `]` because the parser
        // tried and failed to read a reference link. Scanning each fragment separately would
        // never see the wikilink, so they are joined first — carrying escape offsets across
        // the join so escaping still works.
        let mut pending = String::new();
        let mut pending_escapes = inline::Escapes::none();

        while let Some(event) = self.peek() {
            if let Event::End(end) = event {
                if stop.is_some_and(|s| s == *end) {
                    self.bump();
                }
                break;
            }
            if !matches!(event, Event::Text(_)) && !pending.is_empty() {
                push_text(&mut out, &pending, &pending_escapes, &self.math);
                pending.clear();
                pending_escapes = inline::Escapes::none();
            }
            match event {
                Event::Text(t) => {
                    let text = t.to_string();
                    let start = self.peek_range().map_or(0, |r| r.start);
                    let escapes = inline::Escapes::from_source(self.src, start);
                    self.bump();
                    pending_escapes.push_shifted(&escapes, pending.len());
                    pending.push_str(&text);
                }
                Event::Code(c) => {
                    let code = c.to_string();
                    self.bump();
                    out.push(item(Inline::Code(code)));
                }
                Event::TaskListMarker(_) => {
                    // Already captured by `lookahead_task_status`; not inline content.
                    self.bump();
                }
                Event::SoftBreak => {
                    self.bump();
                    out.push(item(Inline::SoftBreak));
                }
                Event::HardBreak => {
                    self.bump();
                    out.push(item(Inline::HardBreak));
                }
                Event::InlineHtml(h) => {
                    // Same rule as block HTML: keep the text, drop the HTML semantics, and
                    // never let a raw line ending survive inside a `Text` inline.
                    let text = h.to_string();
                    self.bump();
                    for inline in text_with_breaks(&text) {
                        out.push(item(inline));
                    }
                }
                Event::Start(Tag::Emphasis) => {
                    self.bump();
                    let inner = self.inlines_until(Some(TagEnd::Emphasis));
                    out.push(item(Inline::Emphasis(flatten_same(
                        inner,
                        SameKind::Emphasis,
                    ))));
                }
                Event::Start(Tag::Strong) => {
                    self.bump();
                    let inner = self.inlines_until(Some(TagEnd::Strong));
                    out.push(item(Inline::Strong(flatten_same(inner, SameKind::Strong))));
                }
                Event::Start(Tag::Strikethrough) => {
                    self.bump();
                    let inner = self.inlines_until(Some(TagEnd::Strikethrough));
                    out.push(item(Inline::Strikethrough(flatten_same(
                        inner,
                        SameKind::Strikethrough,
                    ))));
                }
                Event::Start(Tag::Link {
                    dest_url, title, ..
                }) => {
                    let dest = dest_url.to_string();
                    let title = (!title.is_empty()).then(|| title.to_string());
                    self.bump();
                    let content = self.inlines_until(Some(TagEnd::Link));
                    out.push(item(Inline::Link {
                        dest,
                        title,
                        content,
                    }));
                }
                Event::Start(Tag::Image { dest_url, .. }) => {
                    let dest = dest_url.to_string();
                    self.bump();
                    let alt = self.inlines_until(Some(TagEnd::Image));
                    out.push(item(Inline::Image {
                        dest,
                        alt: alt_text(&alt),
                    }));
                }
                _ => break,
            }
        }
        if !pending.is_empty() {
            push_text(&mut out, &pending, &pending_escapes, &self.math);
        }
        out
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SameKind {
    Emphasis,
    Strong,
    Strikethrough,
    Highlight,
}

/// Splices a same-typed child into its parent.
///
/// `Emphasis(Emphasis(x))` means exactly what `Emphasis(x)` means, and CommonMark has no
/// unambiguous rendering for it: `*a*b*c*` always reads back as two sibling emphases, never
/// as one nested in another. Flattening at parse time is semantically lossless and removes
/// an entire class of round-trip failure that no choice of delimiters can fix.
fn flatten_same(children: Vec<Inline>, kind: SameKind) -> Vec<Inline> {
    let mut out: Vec<Inline> = Vec::with_capacity(children.len());
    for child in children {
        let inner = match (&child, kind) {
            (Inline::Emphasis(i), SameKind::Emphasis)
            | (Inline::Strong(i), SameKind::Strong)
            | (Inline::Strikethrough(i), SameKind::Strikethrough)
            | (Inline::Highlight(i), SameKind::Highlight) => Some(i.clone()),
            _ => None,
        };
        match inner {
            Some(items) => {
                for item in flatten_same(items, kind) {
                    merge_push(&mut out, item);
                }
            }
            None => merge_push(&mut out, child),
        }
    }
    out
}

fn merge_push(out: &mut Vec<Inline>, item: Inline) {
    match (out.last_mut(), &item) {
        (Some(Inline::Text(prev)), Inline::Text(next)) => prev.push_str(next),
        _ => out.push(item),
    }
}

/// Replaces line breaks with spaces and merges the resulting adjacent text runs.
fn flatten_breaks(content: Vec<Inline>) -> Vec<Inline> {
    let mut out: Vec<Inline> = Vec::with_capacity(content.len());
    for item in content {
        let item = match item {
            Inline::SoftBreak | Inline::HardBreak => Inline::Text(" ".to_string()),
            other => other,
        };
        match (out.last_mut(), &item) {
            (Some(Inline::Text(prev)), Inline::Text(next)) => prev.push_str(next),
            _ => out.push(item),
        }
    }
    if let Some(Inline::Text(first)) = out.first_mut() {
        let trimmed = first.trim_start().to_string();
        if trimmed.is_empty() {
            out.remove(0);
        } else {
            *first = trimmed;
        }
    }
    if let Some(Inline::Text(last)) = out.last_mut() {
        let trimmed = last.trim_end().to_string();
        if trimmed.is_empty() {
            out.pop();
        } else {
            *last = trimmed;
        }
    }
    out
}

fn is_empty_paragraph(block: &Block) -> bool {
    matches!(&block.kind, BlockKind::Paragraph(c) if c.is_empty()) && block.anchor.is_none()
}

/// Splits multi-line literal text into inlines joined by soft breaks.
fn text_with_breaks(text: &str) -> Vec<Inline> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let trimmed = normalized.trim_end_matches('\n');
    let mut out: Vec<Inline> = Vec::new();
    for (i, line) in trimmed.split('\n').enumerate() {
        if i > 0 {
            out.push(Inline::SoftBreak);
        }
        if !line.is_empty() {
            out.push(Inline::Text(line.to_string()));
        }
    }
    out
}

/// Text runs are scanned for Memberberry syntax and merged with any adjacent literal text.
/// True for tags that mark inline content rather than a block container.
fn is_inline_tag(tag: &Tag<'_>) -> bool {
    matches!(
        tag,
        Tag::Emphasis
            | Tag::Strong
            | Tag::Strikethrough
            | Tag::Link { .. }
            | Tag::Image { .. }
            | Tag::Superscript
            | Tag::Subscript
    )
}

fn item(inline: Inline) -> inline::ScanItem {
    inline::ScanItem::Inline(inline)
}

/// Pairs highlight delimiters, then merges the result.
fn finish_inlines(raw: Vec<inline::ScanItem>) -> Vec<Inline> {
    let resolved = resolve_highlights(raw);
    let mut out: Vec<Inline> = Vec::with_capacity(resolved.len());
    for inline in resolved {
        push_inline(&mut out, inline);
    }
    out
}

/// Wraps the span between two `==` delimiters. An unpaired delimiter becomes literal text.
fn resolve_highlights(raw: Vec<inline::ScanItem>) -> Vec<Inline> {
    use inline::ScanItem;
    let mut out: Vec<Inline> = Vec::with_capacity(raw.len());
    let mut i = 0usize;

    while i < raw.len() {
        match raw.get(i) {
            Some(ScanItem::Inline(x)) => {
                out.push(x.clone());
                i += 1;
            }
            Some(ScanItem::HighlightDelim) => {
                let close = (i + 1..raw.len())
                    .find(|&j| matches!(raw.get(j), Some(ScanItem::HighlightDelim)));
                match close {
                    Some(close) => {
                        let inner: Vec<Inline> = raw
                            .get(i + 1..close)
                            .unwrap_or(&[])
                            .iter()
                            .filter_map(|s| match s {
                                ScanItem::Inline(x) => Some(x.clone()),
                                ScanItem::HighlightDelim => None,
                            })
                            .collect();
                        out.push(Inline::Highlight(flatten_same(inner, SameKind::Highlight)));
                        i = close + 1;
                    }
                    None => {
                        out.push(Inline::Text("==".to_string()));
                        i += 1;
                    }
                }
            }
            None => break,
        }
    }
    out
}

fn push_text(
    out: &mut Vec<inline::ScanItem>,
    text: &str,
    escapes: &inline::Escapes,
    math: &math::Table,
) {
    // No `Text` inline may hold a raw line ending: on the way out it would become a real
    // line break and change the document's structure. Raw-HTML blocks are the path that
    // produces them.
    if text.contains(['\r', '\n']) {
        for inline in text_with_breaks(text) {
            out.push(item(inline));
        }
        return;
    }
    out.extend(inline::scan(text, escapes, math));
}

/// Appends an inline, merging it into the previous one when the two are indistinguishable
/// once rendered.
///
/// Adjacent same-typed marks fuse in Markdown — `**a****b**` is a run of six asterisks that
/// no parser reads back as two strongs — so they are merged here instead. Adjacent text runs
/// merge for the same reason.
fn push_inline(out: &mut Vec<Inline>, item: Inline) {
    let merged = match (out.last_mut(), item) {
        (Some(Inline::Text(prev)), Inline::Text(next)) => {
            prev.push_str(&next);
            return;
        }
        (Some(Inline::Emphasis(prev)), Inline::Emphasis(next))
        | (Some(Inline::Strong(prev)), Inline::Strong(next))
        | (Some(Inline::Strikethrough(prev)), Inline::Strikethrough(next))
        | (Some(Inline::Highlight(prev)), Inline::Highlight(next)) => {
            for child in next {
                merge_push(prev, child);
            }
            return;
        }
        (_, item) => item,
    };
    out.push(merged);
}

/// Flattens an image's alt text back to the source it was written as.
///
/// Not [`plain_text`], which exists for the *index* and deliberately drops anything with no
/// prose rendering. Alt text is content the user typed and has to survive a round trip, so
/// a shortcode goes back as `:name:`, a tag as `#name`, math as `$x$`. Using the index
/// helper here silently emptied the alt of any image whose caption held one of them.
///
/// Found by normalising a real vault.
fn alt_text(items: &[Inline]) -> String {
    let mut out = String::new();
    for item in items {
        match item {
            Inline::Text(t) => out.push_str(t),
            Inline::Code(c) => {
                out.push('`');
                out.push_str(c);
                out.push('`');
            }
            Inline::Math(m) => {
                out.push('$');
                out.push_str(m);
                out.push('$');
            }
            Inline::Emoji(name) => {
                out.push(':');
                out.push_str(name);
                out.push(':');
            }
            Inline::Tag(name) => {
                out.push('#');
                out.push_str(name);
            }
            Inline::FootnoteRef(label) => {
                out.push_str("[^");
                out.push_str(label);
                out.push(']');
            }
            Inline::Emphasis(c)
            | Inline::Strong(c)
            | Inline::Strikethrough(c)
            | Inline::Highlight(c)
            | Inline::Link { content: c, .. } => out.push_str(&alt_text(c)),
            // An alt is one line, so a break is a space; a nested image or wikilink has no
            // alt-text rendering at all and CommonMark would not have produced one here.
            Inline::SoftBreak | Inline::HardBreak => out.push(' '),
            Inline::Image { alt, .. } => out.push_str(alt),
            Inline::WikiLink(w) => {
                out.push_str(w.alias.as_deref().unwrap_or(&w.target));
            }
        }
    }
    out
}

fn heading_level(level: CmarkHeading) -> HeadingLevel {
    match level {
        CmarkHeading::H1 => HeadingLevel::H1,
        CmarkHeading::H2 => HeadingLevel::H2,
        CmarkHeading::H3 => HeadingLevel::H3,
        CmarkHeading::H4 => HeadingLevel::H4,
        CmarkHeading::H5 => HeadingLevel::H5,
        CmarkHeading::H6 => HeadingLevel::H6,
    }
}

fn convert_alignment(a: &pulldown_cmark::Alignment) -> Alignment {
    match a {
        pulldown_cmark::Alignment::None => Alignment::None,
        pulldown_cmark::Alignment::Left => Alignment::Left,
        pulldown_cmark::Alignment::Center => Alignment::Center,
        pulldown_cmark::Alignment::Right => Alignment::Right,
    }
}

fn container_end(tag: &Tag<'_>) -> TagEnd {
    tag.to_end()
}

/// Splits a trailing `^anchor` off a paragraph or heading.
///
/// v1 limitation: anchors are recognised on paragraphs and headings only. Those are the
/// blocks people actually anchor, and a trailing `^id` after a table row or code fence
/// would not survive a round trip.
fn finish_text_block(kind: BlockKind, anchor_is_live: bool, raw: Option<&str>) -> Block {
    if let BlockKind::Paragraph(content) = &kind
        && let Some(raw) = raw
        && math_fences_are_live(raw)
        && let Some(resolved) = as_math_block(content)
    {
        // why: prefer the body exactly as the user typed it. `content` has been through
        // CommonMark inline processing, which resolves `\{` to `{` — and `\{`, `\%`, `\\`
        // are everyday LaTeX, so taking the resolved text would strip backslashes out of
        // real equations. Math is verbatim by nature; it has to come from the source.
        let body = math_body_from_source(raw, &resolved).unwrap_or(resolved);
        return Block::new(BlockKind::MathBlock(body));
    }
    // Only the anchor split depends on the source; everything above it does not.
    if !anchor_is_live {
        return Block::new(kind);
    }
    let content = match &kind {
        BlockKind::Paragraph(c) | BlockKind::Heading { content: c, .. } => c,
        _ => return Block::new(kind),
    };
    let Some(Inline::Text(last)) = content.last() else {
        return Block::new(kind);
    };
    let Some((head, anchor)) = syntax::split_anchor(last) else {
        return Block::new(kind);
    };

    let mut content = content.clone();
    if head.is_empty() {
        content.pop();
    } else if let Some(Inline::Text(slot)) = content.last_mut() {
        *slot = head;
    }
    let kind = match kind {
        BlockKind::Paragraph(_) => BlockKind::Paragraph(content),
        BlockKind::Heading { level, .. } => BlockKind::Heading { level, content },
        other => other,
    };
    Block::with_anchor(kind, anchor)
}

/// True when a block's source really ends in a `^anchor`, rather than an escaped `\^`.
///
/// Anchor splitting works on resolved text, where `\^a` and `^a` are the same string — so
/// without consulting the source, escaping a literal caret is impossible and the text would
/// silently become a block id.
fn anchor_is_live(src: &str, range: &Range<usize>) -> bool {
    let Some(raw) = src.get(range.clone()) else {
        return false;
    };
    let trimmed = raw.trim_end();
    let Some(caret) = trimmed.rfind(" ^") else {
        return false;
    };
    let tail = trimmed.get(caret + 2..).unwrap_or("");
    if !syntax::is_anchor_tail(tail) {
        return false;
    }
    let before = trimmed.get(..caret + 1).unwrap_or("");
    before.chars().rev().take_while(|c| *c == '\\').count() % 2 == 0
}

/// The math body as written, when that provably reproduces what CommonMark resolved.
///
/// Taking the source directly is what keeps LaTeX escapes intact, but a paragraph's source
/// range is not always just its text: inside a blockquote or a list item it carries the
/// container's `> ` or indent. Rather than reimplement that stripping — and risk corrupting
/// a body — this re-resolves the candidate and only accepts it when the two agree. Any
/// mismatch falls back to the resolved text, which is what the parser used before.
///
/// Found by `make fuzz TARGET=normalize`.
fn math_body_from_source(raw: &str, resolved: &str) -> Option<String> {
    let trimmed = raw.trim();
    let inner = trimmed.strip_prefix("$$")?.strip_suffix("$$")?;
    let candidate = trim_lines(inner.trim_matches('\n'));
    (unescape_punctuation(&candidate) == trim_lines(resolved)).then_some(candidate)
}

/// Trims each line, matching the normal form of a math body (`canonical::math_body`).
fn trim_lines(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for (i, line) in text.lines().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        out.push_str(line.trim());
    }
    out
}

/// Applies CommonMark's backslash-escape rule: `\` before ASCII punctuation yields that
/// character, and is literal before anything else.
fn unescape_punctuation(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.clone().next() {
            Some(next) if next.is_ascii_punctuation() => {
                out.push(next);
                chars.next();
            }
            _ => out.push('\\'),
        }
    }
    out
}

/// True when a paragraph's source is delimited by literal `$$`, not by escaped `\$\$`.
///
/// [`as_math_block`] matches on *resolved* text, where the two are the same string — so
/// without the source, a user who escapes dollars to write about them literally has the
/// escape eaten and their paragraph silently turned into a math block. Same reasoning as
/// [`anchor_is_live`] and [`raw_blockquote_is_callout`].
fn math_fences_are_live(raw: &str) -> bool {
    let trimmed = raw.trim();
    let Some(inner) = trimmed.strip_prefix("$$") else {
        return false;
    };
    let Some(before_close) = inner.strip_suffix("$$") else {
        return false;
    };
    // An odd run of backslashes before the closing fence escapes it.
    before_close
        .chars()
        .rev()
        .take_while(|c| *c == '\\')
        .count()
        % 2
        == 0
}

/// Recognises a paragraph that is entirely a `$$ … $$` display-math block.
///
/// Only plain text, line breaks and inline math may appear between the fences: anything
/// else means the `$$` were literal, not delimiters.
///
/// Inline math is put back as `$…$` rather than rejected because a `$` pair inside a display
/// block is routine LaTeX. The inline scanner runs first and claims it, so refusing to
/// reconstruct it would make `$$a$;$$$` a math block on one pass and a paragraph on the
/// next — a file that never settles.
fn as_math_block(content: &[Inline]) -> Option<String> {
    let mut text = String::new();
    for item in content {
        match item {
            Inline::Text(t) => text.push_str(t),
            Inline::Math(m) => {
                text.push('$');
                text.push_str(m);
                text.push('$');
            }
            Inline::SoftBreak | Inline::HardBreak => text.push('\n'),
            _ => return None,
        }
    }
    let inner = text.strip_prefix("$$")?.strip_suffix("$$")?;
    if inner.contains("$$") {
        return None;
    }
    Some(inner.trim_matches('\n').to_string())
}

/// Recognises `> [!kind]` callouts, returning the original blocks unchanged when this is an
/// ordinary blockquote. The raw source is consulted so an escaped `\[!note\]` stays a quote.
fn detect_callout(
    inner: Vec<Block>,
    src: &str,
    range: &Range<usize>,
) -> Result<Callout, Vec<Block>> {
    if !raw_blockquote_is_callout(src, range) {
        return Err(inner);
    }
    let Some(first) = inner.first() else {
        return Err(inner);
    };
    let BlockKind::Paragraph(content) = &first.kind else {
        return Err(inner);
    };
    let Some(Inline::Text(head)) = content.first() else {
        return Err(inner);
    };
    let Some(rest) = head.strip_prefix("[!") else {
        return Err(inner);
    };
    let Some(close) = rest.find(']') else {
        return Err(inner);
    };
    let Some(kind) = rest.get(..close).map(str::to_string) else {
        return Err(inner);
    };

    let after = rest.get(close + 1..).unwrap_or("");
    let (fold, after) = match after.chars().next() {
        Some('+') => (Fold::Expanded, after.get(1..).unwrap_or("")),
        Some('-') => (Fold::Collapsed, after.get(1..).unwrap_or("")),
        _ => (Fold::None, after),
    };

    // The header line runs to the first soft break; anything after it is body content.
    let split = content.iter().position(|i| matches!(i, Inline::SoftBreak));
    let (header, trailing) = match split {
        Some(idx) => (
            content.get(..idx).unwrap_or(&[]),
            content.get(idx + 1..).unwrap_or(&[]),
        ),
        None => (content.as_slice(), &[][..]),
    };

    let mut title: Vec<Inline> = header.to_vec();
    let leading = after.trim_start().to_string();
    if leading.is_empty() {
        title.remove(0);
    } else if let Some(slot) = title.first_mut() {
        *slot = Inline::Text(leading);
    }

    // why: the header line and any lazy body lines arrive as *one* paragraph, so a
    // trailing `^block-id` was already split off that paragraph before this function ran —
    // and it belongs to whichever line it was written on. Dropping it here lost the anchor
    // and its text outright: `> [!note] T\n> body ^id` round-tripped to `> body`. It is
    // also the only anchor in the model with no home of its own, because a container block
    // cannot carry one (see `finish_text_block`).
    let anchor = first.anchor.clone();
    let mut body: Vec<Block> = Vec::new();
    if !trailing.is_empty() {
        let paragraph = BlockKind::Paragraph(trailing.to_vec());
        body.push(match &anchor {
            Some(anchor) => Block::with_anchor(paragraph, anchor.clone()),
            None => Block::new(paragraph),
        });
    } else if let Some(anchor) = &anchor {
        // Written on the header line, where no block can hold it. Keeping it as title text
        // is lossless and stable — the serializer escapes the caret, so the next parse
        // reads it as the text it now is rather than splitting it off again.
        title.push(Inline::Text(format!(" ^{anchor}")));
    }
    body.extend(inner.into_iter().skip(1));

    Ok(Callout {
        kind,
        fold,
        title,
        content: body,
    })
}

fn raw_blockquote_is_callout(src: &str, range: &Range<usize>) -> bool {
    let Some(raw) = src.get(range.clone()) else {
        return false;
    };
    let Some(first) = raw.lines().next() else {
        return false;
    };
    first
        .trim_start()
        .trim_start_matches('>')
        .trim_start()
        .starts_with("[!")
}

/// True when the raw list item literally begins `[-] `, marking a cancelled task.
fn raw_item_is_cancelled(src: &str, range: &Range<usize>) -> bool {
    let Some(raw) = src.get(range.clone()) else {
        return false;
    };
    let trimmed = raw.trim_start();
    let after_marker = match trimmed.chars().next() {
        Some('-' | '*' | '+') => trimmed.get(1..).unwrap_or(""),
        Some(c) if c.is_ascii_digit() => {
            let digits: usize = trimmed.chars().take_while(char::is_ascii_digit).count();
            trimmed.get(digits + 1..).unwrap_or("")
        }
        _ => return false,
    };
    // `[-]` may be the whole item, with no text after it to separate with a space.
    match after_marker.trim_start().strip_prefix("[-]") {
        Some(rest) => rest.is_empty() || rest.starts_with([' ', '\t', '\n', '\r']),
        None => false,
    }
}

fn strip_cancelled_marker(content: &mut [Block]) {
    let Some(first) = content.first_mut() else {
        return;
    };
    let BlockKind::Paragraph(inlines) = &mut first.kind else {
        return;
    };
    let Some(Inline::Text(text)) = inlines.first_mut() else {
        return;
    };
    // The trailing space is gone by now — inline text is trimmed — so `[-] ` and a bare
    // `[-]` both have to be recognised. Missing the second left the marker in the text as
    // well as on the item, printing it twice.
    if let Some(rest) = text.strip_prefix("[-]") {
        let rest = rest.strip_prefix(' ').unwrap_or(rest);
        if rest.is_empty() {
            inlines.remove(0);
        } else {
            *text = rest.to_string();
        }
    }
}

/// Pulls trailing emoji metadata off a task's first line into structured fields.
fn extract_task_meta(content: &mut [Block]) -> task::TaskMeta {
    let Some(first) = content.first_mut() else {
        return task::TaskMeta::default();
    };
    let BlockKind::Paragraph(inlines) = &mut first.kind else {
        return task::TaskMeta::default();
    };

    // Metadata is trailing text on the first line, so only the run before any soft break
    // (or the final run) can carry it.
    let end = inlines
        .iter()
        .position(|i| matches!(i, Inline::SoftBreak))
        .unwrap_or(inlines.len());
    let Some(idx) = end.checked_sub(1) else {
        return task::TaskMeta::default();
    };
    let Some(Inline::Text(text)) = inlines.get(idx) else {
        return task::TaskMeta::default();
    };

    let (remaining, meta) = task::split_meta(text);
    if meta == task::TaskMeta::default() {
        return meta;
    }
    if remaining.is_empty() {
        inlines.remove(idx);
    } else if let Some(Inline::Text(slot)) = inlines.get_mut(idx) {
        *slot = remaining;
    }
    meta
}
