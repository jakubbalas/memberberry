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

// why: observations belong to the actual parser, never to oracle/reparse calls.
macro_rules! observe {
    ($field:ident, $value:expr) => {
        #[cfg(test)]
        $crate::parse::contract_checks::observe(|o| o.$field += $value);
    };
}
pub mod inline;
pub mod math;
mod style;

use core::ops::Range;
use std::collections::HashSet;

use pulldown_cmark::{
    CodeBlockKind, Event, HeadingLevel as CmarkHeading, LinkType, Options, Parser, Tag, TagEnd,
};

use crate::frontmatter;
use crate::model::{
    Alignment, Block, BlockKind, Callout, Document, Fold, HeadingLevel, Inline, List, ListItem,
    Table,
};
use crate::syntax;
use crate::task::{self, TaskStatus};

#[cfg(test)]
#[path = "parser_contract_checks.rs"]
mod contract_checks;

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

/// Original-source namespace ownership for the separate surgical rename policy.
pub(crate) struct StyleRewriteScope {
    pub(crate) whole: Range<usize>,
    pub(crate) label: Option<Range<usize>>,
    pub(crate) literal_gaps: Vec<Range<usize>>,
}

/// Reuses whole-note accepted native usage ownership, never a local reference resolver.
pub(crate) fn style_rewrite_scopes(src: &str, options: Options) -> Vec<StyleRewriteScope> {
    let scopes = style::rewrite_scopes(src, options);
    if scopes.is_empty() {
        return Vec::new();
    }
    let context = ParseContext::new(src, options);
    scopes
        .into_iter()
        .map(|(whole, mut label)| {
            let start = context
                .owner_max_ends
                .partition_point(|end| *end <= whole.start);
            let end = context
                .owners
                .partition_point(|owner| owner.usage.bytes.start < whole.end);
            let mut at = whole.start;
            let mut literal_gaps = Vec::new();
            for owner in context.owners.get(start..end).unwrap_or(&[]) {
                let usage = &owner.usage.bytes;
                if usage.start < whole.start || usage.end > whole.end {
                    label = None; // why: an enclosing/cross-boundary owner is not literal Text.
                    break;
                }
                if at < usage.start {
                    literal_gaps.push(at..usage.start);
                }
                at = at.max(usage.end);
            }
            if at < whole.end {
                literal_gaps.push(at..whole.end);
            }
            StyleRewriteScope {
                whole,
                label,
                literal_gaps,
            }
        })
        .collect()
}

/// Exact directive metadata source spans, shared with surgical rename scanning.
#[must_use]
pub fn style_metadata_spans(src: &str, options: Options) -> Vec<Range<usize>> {
    style::metadata_spans(src, options)
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
    let context = ParseContext::new(body, options);
    let mut skip: Vec<usize> = Vec::new();
    loop {
        let math = math::table_from_ranges(
            body,
            &context.math_ranges,
            &skip,
            format!("{}m:", context.token_prefix),
        );
        let Some(blocks) = context.parse_round(&math, &skip) else {
            return context.raw_blocks();
        };
        match blocks.iter().find_map(|b| leaked_start(b, &math)) {
            Some(start) if !skip.contains(&start) => skip.push(start),
            Some(_) => return context.raw_blocks(),
            None => return blocks,
        }
    }
}

// Original-body authority: later views cannot consume reference fuel again.
type OwnedEvent = (Event<'static>, Range<usize>);
#[derive(Clone)]
struct ContextId(std::rc::Rc<()>);
impl std::fmt::Debug for ContextId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ContextId({:p})", std::rc::Rc::as_ptr(&self.0))
    }
}
impl PartialEq for ContextId {
    fn eq(&self, other: &Self) -> bool {
        std::rc::Rc::ptr_eq(&self.0, &other.0)
    }
}
impl Eq for ContextId {}
#[derive(Clone, Debug)]
struct OriginalRange {
    context: ContextId,
    bytes: Range<usize>,
}
#[derive(Clone, Debug)]
enum AtomKind {
    Math(usize),
    Style(usize),
    Native(usize),
}
#[derive(Clone, Debug)]
enum GuardEdge {
    Open,
    Close,
}
#[derive(Clone, Debug)]
enum ViewOrigin {
    Source(OriginalRange),
    Atom(OriginalRange, AtomKind),
    Guard(usize, GuardEdge),
}
#[derive(Clone, Debug)]
struct ViewPiece {
    view: Range<usize>,
    origin: ViewOrigin,
}
#[derive(Debug)]
struct SourceView {
    context: ContextId,
    text: String,
    pieces: Vec<ViewPiece>,
}
impl SourceView {
    fn tracked(self) -> Self {
        #[cfg(test)]
        contract_checks::observe(|o| {
            o.map_segments += self.pieces.len();
            o.live_view_bytes += self.text.capacity();
            o.live_map_bytes += self.pieces.capacity() * std::mem::size_of::<ViewPiece>();
            o.peak_view_bytes = o.peak_view_bytes.max(o.live_view_bytes);
            o.peak_map_bytes = o.peak_map_bytes.max(o.live_map_bytes);
        });
        self
    }
    fn valid(&self, context: &ParseContext<'_>) -> bool {
        if self.context != context.id() {
            return false;
        }
        let mut cursor = 0;
        for piece in &self.pieces {
            if piece.view.start != cursor
                || piece.view.end < cursor
                || self.text.get(piece.view.clone()).is_none()
            {
                return false;
            }
            match &piece.origin {
                ViewOrigin::Source(r) | ViewOrigin::Atom(r, _)
                    if r.context != self.context || context.body.get(r.bytes.clone()).is_none() =>
                {
                    return false;
                }
                ViewOrigin::Source(r) if r.bytes.len() != piece.view.len() => return false,
                ViewOrigin::Atom(r, kind) if !context.checked_atom(r, kind) => return false,
                ViewOrigin::Guard(id, edge)
                    if self.text.get(piece.view.clone())
                        != Some(context.guard_token(*id, edge).as_str()) =>
                {
                    return false;
                }
                _ => {}
            }
            cursor = piece.view.end;
        }
        cursor == self.text.len()
    }
    fn identity(context: &ParseContext<'_>, range: Range<usize>) -> Option<Self> {
        let source = context.original_range(range)?;
        let text = context.body.get(source.bytes.clone())?.to_string();
        let piece = ViewPiece {
            view: 0..text.len(),
            origin: ViewOrigin::Source(source),
        };
        Some(
            Self {
                context: context.id(),
                text,
                pieces: vec![piece],
            }
            .tracked(),
        )
    }
    fn original_scope(
        &self,
        context: &ParseContext<'_>,
        range: Range<usize>,
    ) -> Option<OriginalRange> {
        if !self.valid(context)
            || range.start > range.end
            || !self.text.is_char_boundary(range.start)
            || !self.text.is_char_boundary(range.end)
        {
            return None;
        }
        let boundary = |at, ending| {
            self.pieces.iter().find_map(|piece| {
                if at < piece.view.start
                    || at > piece.view.end
                    || (ending && at == piece.view.start && at != piece.view.end)
                {
                    return None;
                }
                match &piece.origin {
                    ViewOrigin::Source(original) => {
                        Some(original.bytes.start + at - piece.view.start)
                    }
                    ViewOrigin::Atom(original, _) if at == piece.view.start => {
                        Some(original.bytes.start)
                    }
                    ViewOrigin::Atom(original, _) if at == piece.view.end => {
                        Some(original.bytes.end)
                    }
                    _ => None,
                }
            })
        };
        context.original_range(boundary(range.start, false)?..boundary(range.end, true)?)
    }
    fn exact_source(
        &self,
        context: &ParseContext<'_>,
        range: Range<usize>,
    ) -> Option<OriginalRange> {
        let original = self.original_scope(context, range.clone())?;
        let mut cursor = range.start;
        let mut source_cursor = original.bytes.start;
        for piece in self
            .pieces
            .iter()
            .filter(|p| p.view.start < range.end && p.view.end > range.start)
        {
            let ViewOrigin::Source(source) = &piece.origin else {
                return None;
            };
            let start = range.start.max(piece.view.start);
            let end = range.end.min(piece.view.end);
            if start != cursor || source.bytes.start + start - piece.view.start != source_cursor {
                return None;
            }
            cursor = end;
            source_cursor += end - start;
        }
        (cursor == range.end && source_cursor == original.bytes.end).then_some(original)
    }
    fn replace(
        &self,
        context: &ParseContext<'_>,
        edits: &[(Range<usize>, String, AtomKind)],
    ) -> Option<Self> {
        let mut text = String::new();
        let mut pieces = Vec::new();
        let mut cursor = 0;
        let append = |range: Range<usize>,
                      text: &mut String,
                      pieces: &mut Vec<ViewPiece>|
         -> Option<()> {
            let base = text.len();
            text.push_str(self.text.get(range.clone())?);
            for piece in self
                .pieces
                .iter()
                .filter(|p| p.view.start < range.end && p.view.end > range.start)
            {
                let start = range.start.max(piece.view.start);
                let end = range.end.min(piece.view.end);
                let origin = match &piece.origin {
                    ViewOrigin::Source(r) => ViewOrigin::Source(context.original_range(
                        r.bytes.start + start - piece.view.start
                            ..r.bytes.start + end - piece.view.start,
                    )?),
                    other if start == piece.view.start && end == piece.view.end => other.clone(),
                    _ => return None,
                };
                pieces.push(ViewPiece {
                    view: base + start - range.start..base + end - range.start,
                    origin,
                });
            }
            Some(())
        };
        for (range, token, kind) in edits {
            if range.start < cursor {
                return None;
            }
            append(cursor..range.start, &mut text, &mut pieces)?;
            let original = self.original_scope(context, range.clone())?;
            let start = text.len();
            text.push_str(token);
            pieces.push(ViewPiece {
                view: start..text.len(),
                origin: ViewOrigin::Atom(original, kind.clone()),
            });
            cursor = range.end;
        }
        append(cursor..self.text.len(), &mut text, &mut pieces)?;
        let result = Self {
            context: self.context.clone(),
            text,
            pieces,
        }
        .tracked();
        result.valid(context).then_some(result)
    }
    fn guarded(&self, context: &ParseContext<'_>) -> (Self, String, String) {
        let id = context.next_scope.get();
        context.next_scope.set(id + 1);
        let open = context.guard_token(id, &GuardEdge::Open);
        let close = context.guard_token(id, &GuardEdge::Close);
        let mut pieces = vec![ViewPiece {
            view: 0..open.len(),
            origin: ViewOrigin::Guard(id, GuardEdge::Open),
        }];
        pieces.extend(self.pieces.iter().map(|p| ViewPiece {
            view: p.view.start + open.len()..p.view.end + open.len(),
            origin: p.origin.clone(),
        }));
        let end = open.len() + self.text.len();
        pieces.push(ViewPiece {
            view: end..end + close.len(),
            origin: ViewOrigin::Guard(id, GuardEdge::Close),
        });
        (
            Self {
                context: self.context.clone(),
                text: format!("{open}{}{close}", self.text),
                pieces,
            }
            .tracked(),
            open,
            close,
        )
    }
}
#[cfg(test)]
impl Drop for SourceView {
    fn drop(&mut self) {
        contract_checks::observe(|o| {
            o.live_view_bytes -= self.text.capacity();
            o.live_map_bytes -= self.pieces.capacity() * std::mem::size_of::<ViewPiece>();
        });
    }
}
struct DefinitionSnapshot {
    span: Range<usize>,
}
struct AcceptedOwner {
    event_range: OriginalRange,
    usage: OriginalRange,
    content: Option<OriginalRange>,
    first: usize,
    last: usize,
    title: Option<String>,
}
struct ParseContext<'a> {
    identity: std::rc::Rc<()>,
    body: &'a str,
    options: Options,
    events: Vec<OwnedEvent>,
    owners: Vec<AcceptedOwner>,
    empty_titles: HashSet<usize>,
    math_ranges: Vec<Range<usize>>,
    candidates: Vec<style::Candidate>,
    refused_styles: Vec<Range<usize>>,
    token_prefix: String,
    next_scope: std::cell::Cell<usize>,
    definitions: Vec<DefinitionSnapshot>,
    owner_max_ends: Vec<usize>,
    owner_by_event: Vec<Option<usize>>,
    inline_events: Vec<usize>,
    inline_max_ends: Vec<usize>,
    content_cache: ContentCache,
}
/// An owner's first event, nesting depth, whether styles apply, and the skip-list length.
type ContentKey = (usize, usize, bool, usize);
/// Materialized inline content per [`ContentKey`], reset when a parse round's skips change.
type ContentCache = std::cell::RefCell<std::collections::HashMap<ContentKey, Vec<Inline>>>;
impl<'a> ParseContext<'a> {
    fn id(&self) -> ContextId {
        ContextId(std::rc::Rc::clone(&self.identity))
    }
    fn guard_token(&self, id: usize, edge: &GuardEdge) -> String {
        format!(
            "{}g{id}{}%",
            self.token_prefix,
            match edge {
                GuardEdge::Open => "o",
                GuardEdge::Close => "c",
            }
        )
    }
    fn checked_atom(&self, r: &OriginalRange, kind: &AtomKind) -> bool {
        if r.context != self.id() {
            return false;
        }
        match kind {
            AtomKind::Math(start) => {
                let i = self.math_ranges.partition_point(|r| r.start < *start);
                self.math_ranges.get(i) == Some(&r.bytes)
            }
            AtomKind::Style(start) => {
                let i = self.candidates.partition_point(|c| c.start < *start);
                self.candidates
                    .get(i)
                    .is_some_and(|c| c.start == r.bytes.start && c.end == r.bytes.end)
            }
            AtomKind::Native(first) => {
                self.events.get(*first).is_some_and(|(e, bytes)| {
                    matches!(e, Event::Start(Tag::Link { .. } | Tag::Image { .. }))
                        && bytes.start == r.bytes.start
                }) && self
                    .owner_by_event
                    .get(*first)
                    .copied()
                    .flatten()
                    .and_then(|i| self.owners.get(i))
                    .is_some_and(|o| o.usage.bytes == r.bytes)
            }
        }
    }
    fn original_range(&self, bytes: Range<usize>) -> Option<OriginalRange> {
        (bytes.start <= bytes.end && self.body.get(bytes.clone()).is_some()).then(|| {
            OriginalRange {
                context: self.id(),
                bytes,
            }
        })
    }
    fn new(body: &'a str, options: Options) -> Self {
        observe!(contexts, 1);
        observe!(authority_passes, 1);
        observe!(authority_bytes, body.len());
        let mut parser = Parser::new_ext(body, options).into_offset_iter();
        let events: Vec<OwnedEvent> = parser.by_ref().map(|(e, r)| (e.into_static(), r)).collect();
        observe!(authority_events, events.len());
        let mut empty_titles = empty_inline_titles(body, &events, options);
        let definitions: Vec<_> = parser
            .reference_definitions()
            .iter()
            .map(|(_, d)| DefinitionSnapshot {
                span: d.span.clone(),
            })
            .collect();
        observe!(
            definition_snapshot_bytes,
            definitions.capacity() * std::mem::size_of::<DefinitionSnapshot>()
        );
        observe!(definition_destination_bytes, 0); // span-only snapshot has no URL payload to retain.
        for (i, (event, _)) in events.iter().enumerate() {
            if let Event::Start(Tag::Link {
                link_type,
                title,
                id,
                ..
            }) = event
                && title.is_empty()
                && matches!(
                    link_type,
                    LinkType::Reference | LinkType::Collapsed | LinkType::Shortcut
                )
                && parser
                    .reference_definitions()
                    .get(id)
                    .is_some_and(|d| d.title.is_some())
            {
                empty_titles.insert(i);
            }
        }
        let math_ranges = math::spans_from_events(body, &events);
        // why: entities/escapes can split a generated-looking prefix over adjacent
        // Text events. Inspect the joined decoded authority as well as raw bytes once.
        let decoded = events
            .iter()
            .filter_map(|(e, _)| match e {
                Event::Text(t) | Event::Code(t) | Event::Html(t) | Event::InlineHtml(t) => {
                    Some(t.as_ref())
                }
                _ => None,
            })
            .collect::<String>();
        let base = "%\u{2}mbregistry";
        let mut used = std::collections::BTreeSet::<usize>::new();
        for source in [body, decoded.as_str()] {
            for (at, _) in source.match_indices(base) {
                if let Some(rest) = source.get(at + base.len()..) {
                    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
                    if rest.as_bytes().get(digits) == Some(&b'q')
                        && let Some(id) = rest.get(..digits).and_then(|s| s.parse().ok())
                    {
                        used.insert(id);
                    }
                }
            }
        }
        let mut id = 0;
        while used.contains(&id) {
            id += 1;
        }
        let token_prefix = format!("{base}{id}q");
        observe!(prefix_builds, 1);
        let mut context = Self {
            identity: std::rc::Rc::new(()),
            body,
            options,
            events,
            owners: Vec::new(),
            empty_titles,
            math_ranges,
            candidates: Vec::new(),
            refused_styles: Vec::new(),
            token_prefix,
            next_scope: std::cell::Cell::new(0),
            definitions,
            owner_max_ends: Vec::new(),
            owner_by_event: Vec::new(),
            inline_events: Vec::new(),
            inline_max_ends: Vec::new(),
            content_cache: std::cell::RefCell::new(std::collections::HashMap::new()),
        };
        let mut stack = Vec::<(usize, TagEnd)>::new();
        for (index, (event, range)) in context.events.iter().enumerate() {
            match event {
                Event::Start(tag) => stack.push((index, tag.to_end())),
                Event::End(end) => {
                    let Some((first, expected)) = stack.pop() else {
                        continue;
                    };
                    if expected != *end {
                        continue;
                    }
                    let Some((start, event_bytes)) = context.events.get(first) else {
                        continue;
                    };
                    let (kind, title, id) = match start {
                        Event::Start(
                            Tag::Link {
                                link_type,
                                title,
                                id,
                                ..
                            }
                            | Tag::Image {
                                link_type,
                                title,
                                id,
                                ..
                            },
                        ) => (*link_type, title, id),
                        _ => continue,
                    };
                    if range != event_bytes {
                        continue;
                    }
                    let Some(event_range) = context.original_range(event_bytes.clone()) else {
                        continue;
                    };
                    let mut usage = event_range.clone();
                    if kind == LinkType::Collapsed
                        && let Some(end) = usage
                            .bytes
                            .end
                            .checked_add(2)
                            .filter(|e| body.get(usage.bytes.end..*e) == Some("[]"))
                    {
                        usage.bytes.end = end;
                    }
                    let mut content_usage = usage.bytes.clone();
                    if matches!(start, Event::Start(Tag::Image { .. })) {
                        content_usage.start += 1;
                    }
                    let content = context
                        .events
                        .get(first + 1..index)
                        .and_then(|children| {
                            checked_link_content(body, &content_usage, kind, children)
                        })
                        .and_then(|r| context.original_range(r));
                    let title = if matches!(
                        kind,
                        LinkType::Reference | LinkType::Collapsed | LinkType::Shortcut
                    ) {
                        parser
                            .reference_definitions()
                            .get(id)
                            .and_then(|d| d.title.as_ref())
                            .map(ToString::to_string)
                    } else {
                        (!title.is_empty() || context.empty_titles.contains(&first))
                            .then(|| title.to_string())
                    };
                    context.owners.push(AcceptedOwner {
                        event_range,
                        usage,
                        content,
                        first,
                        last: index,
                        title,
                    });
                }
                _ => {}
            }
        }
        context.owners.sort_by_key(|o| o.usage.bytes.start);
        let mut max_end = 0;
        context.owner_max_ends = context
            .owners
            .iter()
            .map(|o| {
                max_end = max_end.max(o.usage.bytes.end);
                max_end
            })
            .collect();
        context.owner_by_event = vec![None; context.events.len()];
        for (index, owner) in context.owners.iter().enumerate() {
            if let Some(slot) = context.owner_by_event.get_mut(owner.first) {
                *slot = Some(index);
            }
        }
        context.inline_events = context
            .events
            .iter()
            .enumerate()
            .filter_map(|(i, (e, _))| {
                matches!(
                    e,
                    Event::Text(_)
                        | Event::Code(_)
                        | Event::InlineHtml(_)
                        | Event::SoftBreak
                        | Event::HardBreak
                        | Event::Start(Tag::Emphasis | Tag::Strong | Tag::Strikethrough)
                        | Event::End(TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough)
                )
                .then_some(i)
            })
            .collect();
        context
            .inline_events
            .sort_by_key(|i| context.events.get(*i).map(|(_, r)| r.start));
        let mut max_end = 0;
        context.inline_max_ends = context
            .inline_events
            .iter()
            .filter_map(|i| context.events.get(*i))
            .map(|(_, r)| {
                max_end = max_end.max(r.end);
                max_end
            })
            .collect();
        let (candidates, mut refused) = style::context_candidates(&context);
        // why: establish original-coordinate refusal domains BEFORE owner-content
        // recursion; a skipped overlapping declaration must not admit descendants.
        for candidate in &candidates {
            let start = context
                .owner_max_ends
                .partition_point(|end| *end <= candidate.start);
            let end = context
                .owners
                .partition_point(|o| o.usage.bytes.start < candidate.end);
            if context
                .owners
                .get(start..end)
                .unwrap_or(&[])
                .iter()
                .any(|o| {
                    o.usage.bytes.start < candidate.end
                        && o.usage.bytes.end > candidate.start
                        && !(o.usage.bytes.start >= candidate.label.start
                            && o.usage.bytes.end <= candidate.label.end)
                        && !o.content.as_ref().is_some_and(|r| {
                            candidate.start >= r.bytes.start && candidate.end <= r.bytes.end
                        })
                })
            {
                refused.push(candidate.start..candidate.end);
            }
        }
        refused.sort_by_key(|r| r.start);
        for range in refused {
            if let Some(last) = context
                .refused_styles
                .last_mut()
                .filter(|last| range.start <= last.end)
            {
                last.end = last.end.max(range.end);
            } else {
                context.refused_styles.push(range);
            }
        }
        context.candidates = candidates;
        observe!(
            retained_destination_bytes,
            context
                .events
                .iter()
                .filter_map(|(e, _)| match e {
                    Event::Start(Tag::Link { dest_url, .. } | Tag::Image { dest_url, .. }) =>
                        Some(dest_url.len()),
                    _ => None,
                })
                .sum::<usize>()
        );
        context
    }
    // why: structured ambiguity refuses namespace composition using the immutable
    // authority stream. It never grants new masked/local acceptance or reruns titles.
    fn raw_blocks(&self) -> Vec<Block> {
        let mut cursor = Cursor {
            empty_link_titles: self.empty_titles.clone(),
            src: self.body,
            ev: self
                .events
                .iter()
                .map(|(e, r)| (borrow_event(e), r.clone()))
                .collect(),
            i: 0,
            math: math::Table::default(),
            styles: style::Table::default(),
            in_table_cell: false,
        };
        cursor.blocks(None)
    }
    fn original_owner(
        &self,
        view: &SourceView,
        event: &Event<'_>,
        range: Range<usize>,
    ) -> Option<&AcceptedOwner> {
        let mapped = view.exact_source(self, range)?;
        let (kind, dest, image) = match event {
            Event::Start(Tag::Link {
                link_type,
                dest_url,
                ..
            }) => (*link_type, dest_url, false),
            Event::Start(Tag::Image {
                link_type,
                dest_url,
                ..
            }) => (*link_type, dest_url, true),
            _ => return None,
        };
        let at = self
            .owners
            .partition_point(|o| o.event_range.bytes.start < mapped.bytes.start);
        self.owners
            .iter()
            .skip(at)
            .take_while(|o| o.event_range.bytes.start == mapped.bytes.start)
            .find(|o| {
                o.event_range.bytes == mapped.bytes
                    && match &self.events.get(o.first).map(|x| &x.0) {
                        Some(Event::Start(Tag::Link {
                            link_type,
                            dest_url,
                            ..
                        })) => !image && *link_type == kind && dest_url == dest,
                        Some(Event::Start(Tag::Image {
                            link_type,
                            dest_url,
                            ..
                        })) => image && *link_type == kind && dest_url == dest,
                        _ => false,
                    }
            })
    }
    // why: a fresh parser may recognize a reference the raw engine refused. Restore
    // the original bounded inline events, not its fresh destination/child interpretation.
    fn gate_events<'b>(
        &'b self,
        view: &'b SourceView,
        events: Vec<(Event<'b>, Range<usize>)>,
    ) -> Option<Vec<(Event<'b>, Range<usize>)>> {
        let mut ends = vec![None; events.len()];
        let mut stack = Vec::new();
        for (i, (event, _)) in events.iter().enumerate() {
            match event {
                Event::Start(tag) => stack.push((i, tag.to_end())),
                Event::End(end) => {
                    let (first, expected) = stack.pop()?;
                    if expected != *end {
                        return None;
                    }
                    *ends.get_mut(first)? = Some(i);
                }
                _ => {}
            }
        }
        if !stack.is_empty() {
            return None;
        }
        let mut out = Vec::new();
        let mut i = 0;
        while let Some((event, range)) = events.get(i) {
            if matches!(event, Event::Start(Tag::Link { .. } | Tag::Image { .. }))
                && self.original_owner(view, event, range.clone()).is_none()
            {
                let original = view.exact_source(self, range.clone())?;
                let mut restored = Vec::new();
                let start = self
                    .inline_max_ends
                    .partition_point(|end| *end <= original.bytes.start);
                let end = self.inline_events.partition_point(|i| {
                    self.events
                        .get(*i)
                        .is_some_and(|(_, r)| r.start < original.bytes.end)
                });
                let mut hits = self.inline_events.get(start..end)?.to_vec();
                hits.sort_unstable();
                observe!(owner_queries, 1);
                for index in hits {
                    let (raw, r) = self.events.get(index)?;
                    if r.end <= original.bytes.start || r.start >= original.bytes.end {
                        continue;
                    }
                    if !matches!(
                        raw,
                        Event::Text(_)
                            | Event::Code(_)
                            | Event::InlineHtml(_)
                            | Event::SoftBreak
                            | Event::HardBreak
                            | Event::Start(Tag::Emphasis | Tag::Strong | Tag::Strikethrough)
                            | Event::End(TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough)
                    ) {
                        continue;
                    }
                    let a = r.start.max(original.bytes.start);
                    let b = r.end.min(original.bytes.end);
                    let event = if a == r.start && b == r.end {
                        borrow_event(raw)
                    } else {
                        let Event::Text(decoded) = raw else {
                            return None;
                        };
                        if self.body.get(r.clone())? != decoded.as_ref() {
                            return None;
                        }
                        Event::Text(pulldown_cmark::CowStr::Borrowed(self.body.get(a..b)?))
                    };
                    restored.push((
                        event,
                        range.start + a - original.bytes.start
                            ..range.start + b - original.bytes.start,
                    ));
                }
                if restored.is_empty() {
                    return None;
                }
                let mut balance = Vec::new();
                for (event, _) in &restored {
                    match event {
                        Event::Start(tag) => balance.push(tag.to_end()),
                        Event::End(end) if balance.pop() != Some(*end) => return None,
                        _ => {}
                    }
                }
                if !balance.is_empty() {
                    return None;
                }
                out.extend(restored);
                i = ends.get(i).copied().flatten()?.checked_add(1)?;
            } else {
                out.push((event.clone(), range.clone()));
                i += 1;
            }
        }
        Some(out)
    }
    fn mapped_titles(
        &self,
        view: &SourceView,
        events: &[(Event<'_>, Range<usize>)],
    ) -> HashSet<usize> {
        events
            .iter()
            .enumerate()
            .filter_map(|(i, (e, r))| {
                self.original_owner(view, e, r.clone())
                    .filter(|o| {
                        matches!(e, Event::Start(Tag::Link { .. }))
                            && o.title.as_deref() == Some("")
                    })
                    .map(|_| i)
            })
            .collect()
    }
}
// Verify label/suffix boundaries only for an already accepted native usage.
fn checked_link_content(
    body: &str,
    usage: &Range<usize>,
    kind: LinkType,
    children: &[OwnedEvent],
) -> Option<Range<usize>> {
    let source = body.get(usage.clone())?;
    if matches!(kind, LinkType::Autolink | LinkType::Email) {
        return source
            .strip_prefix('<')?
            .strip_suffix('>')
            .map(|_| usage.start + 1..usage.end - 1);
    }
    source.strip_prefix('[')?;
    let mut found = None;
    for (at, ch) in source.char_indices() {
        if ch != ']' || style::escaped(source, at) {
            continue;
        }
        let tail = source.get(at + 1..)?;
        let valid = match kind {
            LinkType::Inline => checked_inline_suffix(tail),
            LinkType::Shortcut => tail.is_empty(),
            LinkType::Collapsed => tail == "[]",
            LinkType::Reference => tail
                .strip_prefix('[')
                .and_then(|s| s.strip_suffix(']'))
                .is_some_and(|inside| {
                    !inside
                        .char_indices()
                        .any(|(i, c)| c == ']' && !style::escaped(inside, i))
                }),
            _ => false,
        };
        let content = usage.start + 1..usage.start + at;
        if valid
            && children
                .iter()
                .all(|(_, r)| r.start >= content.start && r.end <= content.end)
        {
            if found.is_some() {
                return None;
            }
            found = Some(content);
        }
    }
    found
}
fn checked_inline_suffix(source: &str) -> bool {
    let bytes = source.as_bytes();
    if bytes.first() != Some(&b'(') {
        return false;
    }
    let mut i = 1;
    while bytes.get(i).is_some_and(u8::is_ascii_whitespace) {
        i += 1;
    }
    if bytes.get(i) == Some(&b'<') {
        i += 1;
        loop {
            match bytes.get(i) {
                Some(b'\\') => i += 2,
                Some(b'>') => {
                    i += 1;
                    break;
                }
                Some(b'\n' | b'\r' | b'<') | None => return false,
                _ => i += 1,
            }
        }
    } else {
        let mut depth = 0;
        loop {
            match bytes.get(i) {
                Some(b'\\') => i += 2,
                Some(b'(') => {
                    depth += 1;
                    i += 1;
                }
                Some(b')') if depth > 0 => {
                    depth -= 1;
                    i += 1;
                }
                Some(b')') | None => break,
                Some(b) if b.is_ascii_whitespace() => break,
                _ => i += 1,
            }
        }
        if depth != 0 {
            return false;
        }
    }
    let at = i;
    while bytes.get(i).is_some_and(u8::is_ascii_whitespace) {
        i += 1;
    }
    if bytes.get(i) == Some(&b')') {
        return i + 1 == bytes.len();
    }
    if i == at {
        return false;
    }
    let close = match bytes.get(i) {
        Some(b'"') => b'"',
        Some(b'\'') => b'\'',
        Some(b'(') => b')',
        _ => return false,
    };
    i += 1;
    loop {
        match bytes.get(i) {
            Some(b'\\') => i += 2,
            Some(b) if *b == close => {
                i += 1;
                break;
            }
            None => return false,
            _ => i += 1,
        }
    }
    while bytes.get(i).is_some_and(u8::is_ascii_whitespace) {
        i += 1;
    }
    bytes.get(i) == Some(&b')') && i + 1 == bytes.len()
}
// why: immutable authority payloads are borrowed; only final models own URL copies.
fn borrow_event<'a>(event: &'a Event<'static>) -> Event<'a> {
    use pulldown_cmark::CowStr;
    match event {
        Event::Start(Tag::Link {
            link_type,
            dest_url,
            title,
            id,
        }) => Event::Start(Tag::Link {
            link_type: *link_type,
            dest_url: CowStr::Borrowed(dest_url),
            title: CowStr::Borrowed(title),
            id: CowStr::Borrowed(id),
        }),
        Event::Start(Tag::Image {
            link_type,
            dest_url,
            title,
            id,
        }) => Event::Start(Tag::Image {
            link_type: *link_type,
            dest_url: CowStr::Borrowed(dest_url),
            title: CowStr::Borrowed(title),
            id: CowStr::Borrowed(id),
        }),
        Event::Text(t) => Event::Text(CowStr::Borrowed(t)),
        Event::Code(t) => Event::Code(CowStr::Borrowed(t)),
        Event::Html(t) => Event::Html(CowStr::Borrowed(t)),
        Event::InlineHtml(t) => Event::InlineHtml(CowStr::Borrowed(t)),
        other => other.clone(),
    }
}
impl ParseContext<'_> {
    fn style_refusal_at(&self, at: usize) -> Option<&Range<usize>> {
        let end = self.refused_styles.partition_point(|r| r.start <= at);
        end.checked_sub(1)
            .and_then(|i| self.refused_styles.get(i))
            .filter(|r| r.contains(&at))
    }
    fn model_from_original(&self, owner: &AcceptedOwner) -> Vec<Inline> {
        let ev = self
            .events
            .get(owner.first..=owner.last)
            .unwrap_or(&[])
            .iter()
            .map(|(e, r)| (borrow_event(e), r.clone()))
            .collect::<Vec<_>>();
        let empty_link_titles = ev
            .iter()
            .enumerate()
            .filter_map(|(i, _)| self.empty_titles.contains(&(i + owner.first)).then_some(i))
            .collect();
        let mut cursor = Cursor {
            empty_link_titles,
            src: self.body,
            ev,
            i: 0,
            math: math::Table::default(),
            styles: style::Table::default(),
            in_table_cell: false,
        };
        let mut model = cursor.inlines_until(None);
        if let Some(Inline::Link { title, .. }) = model.first_mut() {
            *title = owner.title.clone();
        }
        model
    }
    fn owner_model(
        &self,
        owner: &AcceptedOwner,
        math: &math::Table,
        skip: &[usize],
        depth: usize,
        styles_enabled: bool,
    ) -> Vec<Inline> {
        let Some((Event::Start(Tag::Link { dest_url, .. }), _)) = self.events.get(owner.first)
        else {
            return self.model_from_original(owner);
        };
        let key = (owner.first, depth, styles_enabled, skip.len());
        let cached = self.content_cache.borrow().get(&key).cloned();
        let content = if let Some(content) = cached {
            observe!(cache_hits, 1);
            content
        } else {
            observe!(cache_misses, 1);
            let content = owner
                .content
                .as_ref()
                .and_then(|range| {
                    if self
                        .style_refusal_at(range.bytes.start)
                        .is_some_and(|r| range.bytes.end <= r.end)
                    {
                        Some(self.readable_scope(range.bytes.clone(), math, skip, depth))
                    } else {
                        self.inline_scope(range.bytes.clone(), math, skip, depth, styles_enabled)
                    }
                })
                .unwrap_or_else(|| {
                    let mut raw = self.model_from_original(owner);
                    match raw.pop() {
                        Some(Inline::Link { content, .. }) => content,
                        _ => Vec::new(),
                    }
                });
            self.content_cache.borrow_mut().insert(key, content.clone());
            content
        };
        observe!(model_destination_bytes, dest_url.len());
        vec![Inline::Link {
            dest: dest_url.to_string(),
            title: owner.title.clone(),
            content,
        }]
    }
    fn readable_scope(
        &self,
        scope: Range<usize>,
        math: &math::Table,
        skip: &[usize],
        depth: usize,
    ) -> Vec<Inline> {
        let mut out = Vec::new();
        let mut cursor = scope.start;
        let start = self
            .owners
            .partition_point(|owner| owner.usage.bytes.start < scope.start);
        for owner in self
            .owners
            .iter()
            .skip(start)
            .take_while(|owner| owner.usage.bytes.start < scope.end)
        {
            if owner.usage.bytes.start < cursor || owner.usage.bytes.end > scope.end {
                continue;
            }
            if let Some(gap) = self.body.get(cursor..owner.usage.bytes.start) {
                merge_push(&mut out, Inline::Text(gap.to_string()));
            }
            for item in self.owner_model(owner, math, skip, depth, false) {
                merge_push(&mut out, item);
            }
            cursor = owner.usage.bytes.end;
        }
        if let Some(gap) = self.body.get(cursor..scope.end) {
            merge_push(&mut out, Inline::Text(gap.to_string()));
        }
        out.retain(|i| !matches!(i, Inline::Text(t) if t.is_empty()));
        out
    }
    fn prepared_scope(
        &self,
        scope: Range<usize>,
        math: &math::Table,
        skip: &[usize],
        depth: usize,
        enabled: bool,
    ) -> Option<(SourceView, style::Table)> {
        let view = SourceView::identity(self, scope.clone())?;
        let serial = self.next_scope.get();
        self.next_scope.set(serial + 1);
        let mut table = style::Table::from_prefix(format!("{}s{serial}:", self.token_prefix));
        let mut edits = Vec::<(Range<usize>, String, AtomKind)>::new();
        let candidates = if enabled {
            self.candidates.as_slice()
        } else {
            &[]
        };
        let mut cursor = scope.start;
        while cursor < scope.end {
            let mut candidate_start = candidates.partition_point(|c| c.start < cursor);
            while let Some(refused) = candidates
                .get(candidate_start)
                .and_then(|c| self.style_refusal_at(c.start))
            {
                candidate_start = candidates.partition_point(|c| c.start < refused.end);
            }
            let directive = candidates
                .get(candidate_start)
                .filter(|c| c.end <= scope.end);
            observe!(owner_queries, 1);
            let owner_start = self
                .owners
                .partition_point(|o| o.usage.bytes.start < cursor);
            let owner = self
                .owners
                .get(owner_start)
                .filter(|o| o.usage.bytes.end <= scope.end);
            let math_start = self.math_ranges.partition_point(|r| r.start < cursor);
            let math_span = self
                .math_ranges
                .iter()
                .skip(math_start)
                .take_while(|r| r.end <= scope.end)
                .find(|r| !skip.contains(&r.start));
            let next = directive
                .map(|d| d.start)
                .into_iter()
                .chain(owner.map(|o| o.usage.bytes.start))
                .chain(math_span.map(|r| r.start))
                .min();
            let Some(next) = next else {
                break;
            };
            if let Some(range) = math_span.filter(|r| r.start == next) {
                let token = math.token_at(range.start)?;
                edits.push((
                    range.start - scope.start..range.end - scope.start,
                    token,
                    AtomKind::Math(range.start),
                ));
                cursor = range.end;
                continue;
            }
            if let Some(candidate) = directive.filter(|d| d.start == next) {
                let declaration = candidate.start..candidate.end;
                // why: preflight ORIGINAL owners, before a guarded view can clip them.
                let overlap_start = self
                    .owner_max_ends
                    .partition_point(|end| *end <= candidate.start);
                let overlap_end = self
                    .owners
                    .partition_point(|o| o.usage.bytes.start < candidate.end);
                observe!(owner_queries, 1);
                let overlapping = self
                    .owners
                    .get(overlap_start..overlap_end)
                    .unwrap_or(&[])
                    .iter()
                    .any(|o| {
                        o.usage.bytes.start < candidate.end
                            && o.usage.bytes.end > candidate.start
                            && !(o.usage.bytes.start >= candidate.label.start
                                && o.usage.bytes.end <= candidate.label.end)
                            && !o.content.as_ref().is_some_and(|r| {
                                candidate.start >= r.bytes.start && candidate.end <= r.bytes.end
                            })
                    });
                if overlapping {
                    cursor = candidate.start + 1;
                    continue;
                }
                let attributes = self
                    .body
                    .get(candidate.metadata.clone())
                    .filter(|m| m.len() <= 256)
                    .and_then(style::attributes);
                let content = if candidate.over_budget
                    || depth >= crate::schema::MAX_STYLE_DEPTH
                    || attributes.is_none()
                {
                    self.readable_scope(declaration.clone(), math, skip, depth)
                } else {
                    match self.inline_scope(candidate.label.clone(), math, skip, depth + 1, true) {
                        Some(mut content) => {
                            for property in attributes.into_iter().flatten().rev() {
                                content = vec![Inline::MbStyle { property, content }];
                            }
                            content
                        }
                        None => self.readable_scope(declaration.clone(), math, skip, depth),
                    }
                };
                let token = table.insert(content);
                edits.push((
                    declaration.start - scope.start..declaration.end - scope.start,
                    token,
                    AtomKind::Style(candidate.start),
                ));
                cursor = declaration.end;
                continue;
            }
            if let Some(owner) = owner.filter(|o| o.usage.bytes.start == next) {
                observe!(owner_hits, 1);
                let content = self.owner_model(owner, math, skip, depth, enabled);
                let token = table.insert(content);
                edits.push((
                    owner.usage.bytes.start - scope.start..owner.usage.bytes.end - scope.start,
                    token,
                    AtomKind::Native(owner.first),
                ));
                cursor = owner.usage.bytes.end;
                continue;
            }
            cursor = next + 1;
        }
        let view = view.replace(self, &edits)?;
        Some((view, table))
    }
    fn inline_scope(
        &self,
        scope: Range<usize>,
        math: &math::Table,
        skip: &[usize],
        depth: usize,
        enabled: bool,
    ) -> Option<Vec<Inline>> {
        let (view, styles) = self.prepared_scope(scope, math, skip, depth, enabled)?;
        let (guarded, open, close) = view.guarded(self);
        observe!(local_parses, 1);
        observe!(local_bytes, guarded.text.len());
        let events: Vec<_> = Parser::new_ext(&guarded.text, self.options)
            .into_offset_iter()
            .filter(|(e, _)| {
                !matches!(
                    e,
                    Event::Start(Tag::Paragraph) | Event::End(TagEnd::Paragraph)
                )
            })
            .collect();
        observe!(local_events, events.len());
        if !styles.validate_events(&guarded.text, &events) {
            return None;
        }
        // No local acceptance: fresh native events require exact original authority.
        let events = self.gate_events(&guarded, events)?;
        let empty_link_titles = self.mapped_titles(&guarded, &events);
        let mut cursor = Cursor {
            empty_link_titles,
            src: &guarded.text,
            ev: events,
            i: 0,
            math: math.clone(),
            styles,
            in_table_cell: false,
        };
        let mut items = cursor.inlines_until(None);
        if cursor.i != cursor.ev.len() {
            return None;
        }
        if let Some(Inline::Text(t)) = items.first_mut() {
            *t = t.strip_prefix(&open)?.to_string();
        } else {
            return None;
        }
        if let Some(Inline::Text(t)) = items.last_mut() {
            *t = t.strip_suffix(&close)?.to_string();
        } else {
            return None;
        }
        items.retain(|i| !matches!(i, Inline::Text(t) if t.is_empty()));
        Some(items)
    }
    fn parse_round(&self, math: &math::Table, skip: &[usize]) -> Option<Vec<Block>> {
        self.content_cache
            .borrow_mut()
            .retain(|key, _| key.3 == skip.len());
        #[cfg(test)]
        contract_checks::observe(|o| {
            o.exclusions.push(skip.to_vec());
            o.context_ids.push(self.id());
        });
        let (view, styles) = self.prepared_scope(0..self.body.len(), math, skip, 0, true)?;
        observe!(structural_parses, 1);
        observe!(structural_bytes, view.text.len());
        let events: Vec<_> = Parser::new_ext(&view.text, self.options)
            .into_offset_iter()
            .collect();
        observe!(structural_events, events.len());
        if !styles.validate_events(&view.text, &events) {
            return None;
        }
        let events = self.gate_events(&view, events)?;
        let empty_link_titles = self.mapped_titles(&view, &events);
        let mut cursor = Cursor {
            empty_link_titles,
            src: &view.text,
            ev: events,
            i: 0,
            math: math.clone(),
            styles,
            in_table_cell: false,
        };
        Some(cursor.blocks(None))
    }
}

/// Probe all candidate pairs in one full-context CommonMark replay. The original parser
/// remains the authority for link spans/destinations; the replay only recovers presence.
fn empty_inline_titles(
    body: &str,
    events: &[(Event<'_>, Range<usize>)],
    options: Options,
) -> HashSet<usize> {
    let mut candidates = Vec::new();
    for (index, (event, range)) in events.iter().enumerate() {
        if let Event::Start(Tag::Link {
            link_type: LinkType::Inline,
            dest_url,
            title,
            ..
        }) = event
        {
            if !title.is_empty() {
                continue;
            }
            let Some(source) = body.get(range.clone()).and_then(|s| s.strip_suffix(')')) else {
                continue;
            };
            if let Some(pair) = ["\"\"", "''", "()"]
                .iter()
                .filter_map(|pair| source.rfind(pair))
                .max()
            {
                candidates.push((index, range, dest_url, range.start + pair + 1));
            }
        }
    }
    if candidates.is_empty() {
        return HashSet::new();
    }
    let mut inserts: Vec<usize> = candidates.iter().map(|(_, _, _, insert)| *insert).collect();
    inserts.sort_unstable();
    inserts.dedup();
    // why: inserting only plain letters/hyphens preserves delimiter balance, container
    // prefixes and link-label brackets. Destination pairs may change destinations, but
    // cannot pass the exact original-destination/title/range checks below. No authored
    // metadata is stripped or replaced, and no probe result becomes document content.
    let marker = "mb-title-presence";
    let mut probe = String::new();
    let mut previous = 0;
    for insert in &inserts {
        if let Some(part) = body.get(previous..*insert) {
            probe.push_str(part);
            probe.push_str(marker);
            previous = *insert;
        }
    }
    if let Some(part) = body.get(previous..) {
        probe.push_str(part);
    }
    let expected: std::collections::HashMap<_, _> = candidates
        .iter()
        .map(|(index, range, dest, _)| {
            let start = range.start
                + inserts.partition_point(|insert| *insert <= range.start) * marker.len();
            let end =
                range.end + inserts.partition_point(|insert| *insert < range.end) * marker.len();
            ((start, end), (*index, dest.as_ref()))
        })
        .collect();
    #[cfg(test)]
    title_probe_tests::REPLAYS.with(|count| count.set(count.get() + 1));
    Parser::new_ext(&probe, options)
        .into_offset_iter()
        .filter_map(|(event, range)| {
            let (index, dest) = expected.get(&(range.start, range.end))?;
            match event {
                Event::Start(Tag::Link {
                    link_type: LinkType::Inline,
                    dest_url,
                    title,
                    ..
                }) if dest_url.as_ref() == *dest && title.as_ref() == marker => Some(*index),
                _ => None,
            }
        })
        .collect()
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
        | Inline::MbStyle { content: c, .. }
        | Inline::Link { content: c, .. } => leaked_in_inlines(c, table),
        _ => None,
    })
}

struct Cursor<'a> {
    empty_link_titles: HashSet<usize>,
    src: &'a str,
    ev: Vec<(Event<'a>, Range<usize>)>,
    i: usize,
    math: math::Table,
    styles: style::Table,
    in_table_cell: bool,
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
                    self.in_table_cell = true;
                    cells.push(self.inlines_until(Some(TagEnd::TableCell)));
                    self.in_table_cell = false;
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
                push_text(
                    &mut out,
                    &pending,
                    &pending_escapes,
                    &self.math,
                    &self.styles,
                );
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
                    if self.in_table_cell
                        && ["<br>", "<br/>", "<br />"]
                            .iter()
                            .any(|tag| h.eq_ignore_ascii_case(tag))
                    {
                        self.bump();
                        out.push(item(Inline::HardBreak));
                        continue;
                    }
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
                    let title = (!title.is_empty() || self.empty_link_titles.contains(&self.i))
                        .then(|| title.to_string());
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
            push_text(
                &mut out,
                &pending,
                &pending_escapes,
                &self.math,
                &self.styles,
            );
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
    styles: &style::Table,
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
    out.extend(inline::scan_with_styles(text, escapes, math, styles));
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
            | Inline::MbStyle { content: c, .. }
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

#[cfg(test)]
mod title_probe_tests {
    use super::*;
    use std::cell::Cell;
    thread_local! { pub(super) static REPLAYS: Cell<usize> = const { Cell::new(0) }; }

    #[test]
    fn empty_titles_use_at_most_one_commonmark_replay_per_note() {
        for n in [100, 500, 1000] {
            let links = vec!["[`literal`](https://example.org \"\")"; n];
            for source in [
                links.join(" "),
                links
                    .iter()
                    .map(|s| format!("> {s}"))
                    .collect::<Vec<_>>()
                    .join("\n"),
                links
                    .iter()
                    .map(|s| format!("- {s}"))
                    .collect::<Vec<_>>()
                    .join("\n"),
            ] {
                REPLAYS.with(|count| count.set(0));
                let parsed = document(&source);
                let markdown = crate::to_markdown(&parsed);
                assert_eq!(markdown.matches("https://example.org \"\"").count(), n);
                assert_eq!(markdown.matches("`literal`").count(), n);
                let replays = REPLAYS.with(Cell::get);
                assert!(
                    replays <= 1,
                    "{n} links required {replays} CommonMark title replays"
                );
            }
        }
    }

    proptest::proptest! {
        #![proptest_config(proptest::test_runner::Config {
            cases: 128,
            rng_seed: proptest::test_runner::RngSeed::Fixed(0x435055303031),
            ..proptest::test_runner::Config::default()
        })]
        #[test]
        fn batched_title_presence_preserves_mixed_link_models(
            states in proptest::collection::vec((0usize..4, 0usize..4, proptest::bool::ANY), 1..32)
        ) {
            let mut content = Vec::new();
            for (state, destination, code) in states {
                if !content.is_empty() { content.push(Inline::Text(" ".into())); }
                let title = match state { 0 => None, 1 => Some(String::new()), 2 => Some("mb-title-presence".into()), _ => Some("quoted \"'()🦀".into()) };
                let dest = match destination { 0 => "https://example.org", 1 => "u()", 2 => "u\"\"", _ => "u''" };
                content.push(Inline::Link {
                    dest: dest.into(), title,
                    content: vec![if code { Inline::Code("literal () \"\" ''".into()) } else { Inline::Text("literal () \"\" ''".into()) }],
                });
            }
            let expected = crate::canonical::document(Document::new(vec![Block::new(BlockKind::Paragraph(content))]));
            let markdown = crate::to_markdown(&expected);
            proptest::prop_assert_eq!(document(&markdown), expected);
        }
    }
}

#[cfg(test)]
#[path = "styled_gate_tests.rs"]
mod styled_gate_tests;
