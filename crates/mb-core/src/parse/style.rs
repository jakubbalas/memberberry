//! Source-aware namespace recognition before CommonMark consumes label brackets.
//! Parser and surgical rewrites share the exact protected source ranges.
use crate::model::{Inline, MbStyleProperty};
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use std::ops::Range;

const MAX_DEPTH: usize = crate::schema::MAX_STYLE_DEPTH;

#[derive(Debug, Clone, Default)]
pub(super) struct Table {
    prefix: String,
    entries: Vec<Vec<Inline>>,
}
impl Table {
    pub(super) fn take(&self, text: &str) -> Option<(usize, &[Inline])> {
        if self.entries.is_empty() {
            return None;
        }
        let rest = text.strip_prefix(&self.prefix)?;
        let end = rest.find('%')?;
        let index = rest.get(..end)?.parse::<usize>().ok()?;
        observe!(token_restores, 1);
        Some((
            self.prefix.len() + end + 1,
            self.entries.get(index)?.as_slice(),
        ))
    }
}

#[derive(Debug)]
pub(super) struct Candidate {
    pub(super) start: usize,
    pub(super) label: Range<usize>,
    pub(super) metadata: Range<usize>,
    pub(super) end: usize,
    pub(super) over_budget: bool,
}

/// Metadata stays literal even for complete rejected declarations.
pub(super) fn metadata_spans(src: &str, options: Options) -> Vec<Range<usize>> {
    candidates(src, options, false)
        .into_iter()
        .map(|c| c.metadata.start.saturating_sub(2)..c.end)
        .collect()
}

/// Source-bound complete declarations for the separately audited rename policy.
/// Parse output and namespace acceptance are deliberately unchanged.
pub(super) fn rewrite_scopes(
    src: &str,
    options: Options,
) -> Vec<(Range<usize>, Option<Range<usize>>)> {
    let scopes = candidates(src, options, false);
    let mut enclosing_end = 0;
    scopes
        .iter()
        .enumerate()
        .map(|(index, c)| {
            // why: nested or over-budget declarations have ambiguous literal ownership;
            // rename refuses them rather than inferring a label from presentation text.
            let nested = c.start < enclosing_end
                || scopes
                    .get(index + 1)
                    .is_some_and(|next| next.start < c.label.end);
            enclosing_end = enclosing_end.max(c.label.end);
            let eligible = !c.over_budget
                && !nested
                && c.metadata.len() <= 256
                && src
                    .get(c.metadata.clone())
                    .is_some_and(|metadata| attributes(metadata).is_none());
            (c.start..c.end, eligible.then(|| c.label.clone()))
        })
        .collect()
}

fn contains(ranges: &[Range<usize>], at: usize) -> bool {
    let index = ranges.partition_point(|r| r.start <= at);
    index
        .checked_sub(1)
        .and_then(|i| ranges.get(i))
        .is_some_and(|r| r.contains(&at))
}

fn candidates(src: &str, options: Options, in_table: bool) -> Vec<Candidate> {
    // why: if no exact metadata opener exists, no directive can possibly be complete.
    // Skip the extra CommonMark scope pass for pathological unmatched bracket prose.
    if !src.contains(":mb-style[") || !src.contains("]{") {
        return Vec::new();
    }
    let mut code = Vec::<Range<usize>>::new();
    let mut text = Vec::<Range<usize>>::new();
    let mut rows = Vec::<Range<usize>>::new();
    let mut block_start = None;
    let mut links: Vec<usize> = Vec::new();
    for (event, range) in Parser::new_ext(src, options).into_offset_iter() {
        if !matches!(
            event,
            Event::Start(Tag::Link { .. }) | Event::End(TagEnd::Link)
        ) && let Some(end) = links.last_mut()
        {
            *end = (*end).max(range.end);
        }
        match event {
            Event::Start(Tag::Link { .. }) => links.push(range.start + 1),
            Event::End(TagEnd::Link) => {
                if let Some(end) = links.pop() {
                    // why: bracket characters in a native destination/title cannot close
                    // the surrounding directive label. Keep the label's own closing `]` live.
                    code.push((end + 1).min(range.end)..range.end);
                }
            }
            Event::Start(Tag::Image { .. }) => code.push(range),
            Event::Start(Tag::CodeBlock(_)) => block_start = Some(range.start),
            Event::End(TagEnd::CodeBlock) => {
                if let Some(start) = block_start.take() {
                    code.push(start..range.end);
                }
            }
            Event::Code(_) | Event::InlineHtml(_) | Event::Html(_) => code.push(range),
            Event::Start(Tag::Paragraph)
                if src
                    .get(range.clone())
                    .is_some_and(super::math_fences_are_live) =>
            {
                code.push(range)
            }
            Event::Text(_) if block_start.is_none() => text.push(range),
            Event::Start(Tag::TableHead | Tag::TableRow) => rows.push(range),
            _ => {}
        }
    }
    code.extend(super::math::spans(src, options));
    code.sort_by_key(|r| r.start);
    indexed_candidates(src, code, text, rows, in_table).0
}

fn indexed_candidates(
    src: &str,
    code: Vec<Range<usize>>,
    text: Vec<Range<usize>>,
    rows: Vec<Range<usize>>,
    in_table: bool,
) -> (Vec<Candidate>, Vec<Range<usize>>) {
    // Pair delimiters once; unmatched openers cannot repeatedly scan the note tail.
    let mut stack = Vec::new();
    let mut pairs = vec![None; src.len()];
    let mut i = 0;
    let mut protected = 0;
    let bytes = src.as_bytes();
    while i < src.len() {
        while code.get(protected).is_some_and(|r| r.end <= i) {
            protected += 1;
        }
        if let Some(r) = code.get(protected).filter(|r| r.contains(&i)) {
            i = r.end;
            continue;
        }
        match bytes.get(i) {
            Some(b'\\') => {
                i += 2;
                continue;
            }
            Some(b'\n' | b'\r') => stack.clear(),
            Some(b'|') if in_table || contains(&rows, i) => stack.clear(),
            Some(b'[') => stack.push(i),
            Some(b']') => {
                if let Some(start) = stack.pop()
                    && let Some(slot) = pairs.get_mut(start)
                {
                    *slot = Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    let mut result = Vec::new();
    let mut refused = Vec::new();
    let boundaries: Vec<usize> = src
        .match_indices(['}', '\n', '\r'])
        .map(|(at, _)| at)
        .collect();
    for (start, _) in src.match_indices(":mb-style[") {
        if escaped(src, start) || !contains(&text, start) {
            continue;
        }
        let open = start + ":mb-style".len();
        let Some(close) = pairs.get(open).copied().flatten() else {
            continue;
        };
        let metadata_start = close + 2;
        if bytes.get(close + 1) != Some(&b'{') {
            // why: native bracket ownership can move the paired close beyond the
            // intended metadata. The refused opener still owns its descendants.
            refused.push(start..close + 1);
            continue;
        }
        let index = boundaries.partition_point(|at| *at < metadata_start);
        let Some(end) = boundaries.get(index).copied() else {
            continue;
        };
        if bytes.get(end) != Some(&b'}') {
            continue;
        }
        result.push(Candidate {
            start,
            label: open + 1..close,
            metadata: metadata_start..end,
            end: end + 1,
            over_budget: false,
        });
    }
    // why: refuse the entire over-budget root, rather than applying its outer styles
    // to a literal innermost directive. No recursive parse is attempted for that root.
    let mut parents: Vec<usize> = Vec::new();
    for i in 0..result.len() {
        let start = result.get(i).map_or(0, |c| c.start);
        while parents
            .last()
            .and_then(|p| result.get(*p))
            .is_some_and(|c| c.label.end <= start)
        {
            parents.pop();
        }
        if parents.len() >= MAX_DEPTH
            && let Some(root) = parents.first().copied().and_then(|p| result.get_mut(p))
        {
            root.over_budget = true;
        }
        parents.push(i);
    }
    (result, refused)
}

pub(super) fn attributes(src: &str) -> Option<Vec<MbStyleProperty>> {
    let mut result = Vec::new();
    for attribute in src
        .split([' ', '\t'])
        .filter(|attribute| !attribute.is_empty())
    {
        let (name, quoted) = attribute.split_once('=')?;
        let value = quoted.strip_prefix('"')?.strip_suffix('"')?;
        let property = match name {
            "underline" if value == "true" => MbStyleProperty::Underline,
            "color" => MbStyleProperty::Color(crate::model::MbPalette::parse(value)?),
            "background" => MbStyleProperty::Background(crate::model::MbPalette::parse(value)?),
            "size" => MbStyleProperty::Size(crate::model::MbSize::parse(value)?),
            _ => return None,
        };
        if result
            .iter()
            .any(|p: &MbStyleProperty| p.mark_name() == property.mark_name())
        {
            return None;
        }
        result.push(property);
    }
    result.sort();
    (!result.is_empty()).then_some(result)
}
pub(super) fn escaped(src: &str, at: usize) -> bool {
    src.get(..at)
        .unwrap_or("")
        .bytes()
        .rev()
        .take_while(|b| *b == b'\\')
        .count()
        % 2
        == 1
}

impl Table {
    pub(super) fn from_prefix(prefix: String) -> Self {
        Self {
            prefix,
            entries: Vec::new(),
        }
    }
    pub(super) fn insert(&mut self, content: Vec<Inline>) -> String {
        observe!(token_inserts, 1);
        let token = format!("{}{}%", self.prefix, self.entries.len());
        self.entries.push(content);
        token
    }
    pub(super) fn validate_events(
        &self,
        source: &str,
        events: &[(Event<'_>, Range<usize>)],
    ) -> bool {
        let mut counts = vec![0usize; self.entries.len()];
        let mut pending = String::new();
        let mut ranges = Vec::new();
        let flush =
            |text: &mut String, ranges: &mut Vec<Range<usize>>, counts: &mut Vec<usize>| -> bool {
                let tokens = |input: &str| -> Option<Vec<usize>> {
                    let mut ids = Vec::new();
                    let mut cursor = 0;
                    while let Some(at) = input.get(cursor..).and_then(|t| t.find(&self.prefix)) {
                        let start = cursor + at;
                        let rest = input.get(start + self.prefix.len()..)?;
                        let end = rest.find('%')?;
                        let index = rest.get(..end)?.parse::<usize>().ok()?;
                        if index >= self.entries.len() || format!("{index}") != rest.get(..end)? {
                            return None;
                        }
                        ids.push(index);
                        cursor = start + self.prefix.len() + end + 1;
                    }
                    Some(ids)
                };
                let mut raw = String::new();
                for range in ranges.iter() {
                    let Some(part) = source.get(range.clone()) else {
                        return false;
                    };
                    raw.push_str(part);
                }
                let Some(decoded_ids) = tokens(text) else {
                    return false;
                };
                let Some(raw_ids) = tokens(&raw) else {
                    return false;
                };
                if raw_ids != decoded_ids {
                    return false;
                }
                for id in decoded_ids {
                    let Some(count) = counts.get_mut(id) else {
                        return false;
                    };
                    *count += 1;
                }
                text.clear();
                ranges.clear();
                true
            };
        for (event, range) in events {
            if let Event::Text(text) = event {
                pending.push_str(text);
                ranges.push(range.clone());
            } else if !flush(&mut pending, &mut ranges, &mut counts) {
                return false;
            }
        }
        flush(&mut pending, &mut ranges, &mut counts) && counts.iter().all(|n| *n == 1)
    }
}
pub(super) fn context_candidates(
    context: &super::ParseContext<'_>,
) -> (Vec<Candidate>, Vec<Range<usize>>) {
    observe!(candidate_builds, 1);
    let src = context.body;
    if !src.contains(":mb-style[") || !src.contains("]{") {
        return (Vec::new(), Vec::new());
    }
    let mut code = Vec::new();
    let mut text = Vec::new();
    let mut rows = Vec::new();
    let mut block_start = None;
    for (event, range) in &context.events {
        match event {
            Event::Start(Tag::CodeBlock(_)) => block_start = Some(range.start),
            Event::End(TagEnd::CodeBlock) => {
                if let Some(start) = block_start.take() {
                    code.push(start..range.end);
                }
            }
            Event::Code(_) | Event::Html(_) | Event::InlineHtml(_) => code.push(range.clone()),
            Event::Start(Tag::Image { .. }) => code.push(range.clone()),
            Event::Start(Tag::Paragraph)
                if src
                    .get(range.clone())
                    .is_some_and(super::math_fences_are_live) =>
            {
                code.push(range.clone())
            }
            Event::Text(_) if block_start.is_none() => text.push(range.clone()),
            Event::Start(Tag::TableHead | Tag::TableRow) => rows.push(range.clone()),
            _ => {}
        }
    }
    for owner in &context.owners {
        if let Some(content) = &owner.content {
            code.push(content.bytes.end + 1..owner.usage.bytes.end);
        } else {
            code.push(owner.usage.bytes.clone());
        }
    }
    code.extend(context.definitions.iter().map(|d| d.span.clone()));
    code.extend(context.math_ranges.iter().cloned());
    code.sort_by_key(|r| r.start);
    // Merge enclosing protection, so last-start lookup cannot miss an outer interval.
    let mut merged: Vec<Range<usize>> = Vec::new();
    for range in code {
        if let Some(last) = merged.last_mut().filter(|last| range.start <= last.end) {
            last.end = last.end.max(range.end);
        } else {
            merged.push(range);
        }
    }
    indexed_candidates(src, merged, text, rows, false)
}
