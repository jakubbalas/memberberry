//! Canonicalization: the normal form of a document.
//!
//! Several distinct document values describe the same note. `Emphasis(Emphasis(x))` is just
//! emphasis; two adjacent `Text` runs are one run; a paragraph cannot begin with a line
//! break. Markdown can express only the normal form, so parsing always yields it — and
//! anything that *constructs* a document (the editor, the CRDT layer, a future importer)
//! must be able to reach it too, or it will emit Markdown that reads back differently.
//!
//! Running this over parser output is belt-and-braces; running it over editor output is the
//! point.

use crate::model::{Alignment, Block, BlockKind, Callout, Document, Inline, List, ListItem, Table};
use crate::unicode::{Class, class};

/// Rewrites a document into its normal form. Idempotent.
#[must_use]
pub fn document(mut doc: Document) -> Document {
    doc.blocks = blocks(doc.blocks);
    doc
}

#[must_use]
pub fn blocks(items: Vec<Block>) -> Vec<Block> {
    merge_adjacent_lists(items.into_iter().filter_map(block).collect())
}

/// Joins consecutive lists of the same kind.
///
/// Markdown separates two adjacent lists only when their markers differ, and the canonical
/// form always writes `-` for bullets and `1.` for ordered items. So two sibling lists always
/// come back as one, and keeping them apart in the model would guarantee a mismatch on the
/// very next parse.
fn merge_adjacent_lists(items: Vec<Block>) -> Vec<Block> {
    let mut out: Vec<Block> = Vec::with_capacity(items.len());
    for item in items {
        let mergeable = match (out.last(), &item.kind) {
            (Some(prev), BlockKind::List(next)) => {
                prev.anchor.is_none()
                    && item.anchor.is_none()
                    && matches!(&prev.kind, BlockKind::List(a) if a.ordered == next.ordered)
            }
            _ => false,
        };

        match (mergeable, item.kind) {
            (true, BlockKind::List(next)) => {
                if let Some(Block {
                    kind: BlockKind::List(prev),
                    ..
                }) = out.last_mut()
                {
                    prev.items.extend(next.items);
                } else {
                    out.push(Block {
                        kind: BlockKind::List(next),
                        anchor: item.anchor,
                    });
                }
            }
            (_, kind) => out.push(Block {
                kind,
                anchor: item.anchor,
            }),
        }
    }
    out
}

fn block(mut b: Block) -> Option<Block> {
    b.kind = match b.kind {
        BlockKind::Paragraph(content) => {
            let content = trim_edges(inlines(content));
            if content.is_empty() && b.anchor.is_none() {
                return None;
            }
            BlockKind::Paragraph(content)
        }
        BlockKind::Heading { level, content } => {
            // ATX headings are single-line, so breaks become spaces before trimming.
            let content = trim_edges(inlines(flatten_breaks(content)));
            BlockKind::Heading { level, content }
        }
        BlockKind::List(l) => {
            // A list with no items renders as nothing at all, so leaving one in the normal
            // form would put a block in the model that the next parse cannot return.
            if l.items.is_empty() {
                return None;
            }
            BlockKind::List(List {
                ordered: l.ordered,
                // An unordered list has no start number to preserve; keeping one would make
                // two documents differ that render identically.
                start: if l.ordered { l.start.max(1) } else { 1 },
                items: l.items.into_iter().map(list_item).collect(),
            })
        }
        BlockKind::Blockquote(inner) => BlockKind::Blockquote(blocks(inner)),
        BlockKind::Callout(c) => BlockKind::Callout(Callout {
            kind: c.kind,
            fold: c.fold,
            title: trim_edges(inlines(flatten_breaks(c.title))),
            content: blocks(c.content),
        }),
        BlockKind::CodeBlock { lang, code } => {
            // Markdown normalises line endings, so a `\r` kept here would come back as `\n`.
            let code = code.replace("\r\n", "\n").replace('\r', "\n");
            // The fence's own newline is not part of the code. All of them go, not just one:
            // `pulldown-cmark` reports `q` for both ```` ```\nq\n``` ```` and
            // ```` ```\nq\n\n``` ````, so a code body ending in a newline has no rendering
            // that reads back — keeping one would make the file change on every save.
            // Trailing blank lines inside a fence are therefore dropped, once, deterministically.
            let code = code.trim_end_matches('\n').to_string();
            BlockKind::CodeBlock { lang, code }
        }
        // The `$$` fences own their newlines, exactly as a code fence does.
        BlockKind::MathBlock(m) => BlockKind::MathBlock(math_body(&m)),
        BlockKind::Table(table_value) => BlockKind::Table(table(table_value)?),
        other => other,
    };
    Some(b)
}

/// A task marker attaches to a line of text, so a task item must lead with a paragraph.
///
/// `- [ ] # heading` has no meaning: the marker and the heading cannot share a line. No editor
/// path produces this shape, and rendering it would silently change the document on reparse,
/// so the marker is dropped rather than the heading.
/// Normalises a `$$` block body: fence newlines off, and every line trimmed.
///
/// Unlike a code fence, a `$$` block is read at the paragraph level (`parse::as_math_block`),
/// and a paragraph line comes back with its surrounding whitespace gone. So indentation
/// inside display math has no rendering that reads back, and keeping it would make the file
/// change again on the second save. LaTeX is insensitive to it; this is nonetheless a real
/// difference from Obsidian, pinned by `math_body_lines_carry_no_surrounding_whitespace`.
fn math_body(m: &str) -> String {
    let mut out = String::with_capacity(m.len());
    for (i, line) in m.trim_matches('\n').lines().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        out.push_str(line.trim());
    }
    out
}

/// Squares a table off, or drops it if it has no columns at all.
///
/// A pipe table is a rectangle: the serializer already pads short rows out to the widest
/// row, so a ragged table in the model renders as a rectangular one and reads back with
/// cells the original did not have. Padding here rather than at render time keeps the model
/// and its own output in agreement. Rows are only ever widened — never truncated — so no
/// cell content can be lost.
fn table(t: Table) -> Option<Table> {
    let cols = t
        .alignments
        .len()
        .max(t.head.len())
        .max(t.rows.iter().map(Vec::len).max().unwrap_or(0));
    if cols == 0 {
        return None;
    }
    let mut alignments = t.alignments;
    alignments.resize(cols, Alignment::default());
    let cell = |content: Vec<Inline>| {
        // why: HTML breaks in a pipe cell preserve leading, trailing and repeated empty lines.
        let mut output = Vec::new();
        let mut line = Vec::new();
        for item in content {
            if matches!(item, Inline::HardBreak | Inline::SoftBreak) {
                output.extend(trim_edges(inlines(std::mem::take(&mut line))));
                output.push(Inline::HardBreak);
            } else {
                line.push(item);
            }
        }
        output.extend(trim_edges(inlines(line)));
        output
    };
    let row = |mut r: Vec<Vec<Inline>>| {
        r.resize_with(cols, Vec::new);
        r.into_iter().map(cell).collect()
    };
    Some(Table {
        alignments,
        head: row(t.head),
        rows: t.rows.into_iter().map(row).collect(),
    })
}

fn list_item(item: ListItem) -> ListItem {
    let content = blocks(item.content);
    // A task marker has to sit on the item's first line, so an item opening with a code
    // block or a nested list cannot carry one and the marker would be lost on reparse.
    // An *empty* item is the exception: `- [ ]` is a line of its own and reads straight
    // back. Treating it like the others silently demoted every empty task in a vault to a
    // plain bullet — and deleted the tick from every empty completed one.
    let can_carry_marker = match content.first().map(|b| &b.kind) {
        None => true,
        Some(BlockKind::Paragraph(_)) => true,
        Some(_) => false,
    };
    let task = if can_carry_marker { item.task } else { None };
    ListItem { task, content }
}

/// Flattens degenerate nesting, merges what renders identically, and recurses.
#[must_use]
pub fn inlines(items: Vec<Inline>) -> Vec<Inline> {
    let mut out: Vec<Inline> = Vec::with_capacity(items.len());
    for item in items {
        push(&mut out, canonical_inline(item));
    }
    settle(out, None, None, false)
}

/// Runs [`drop_unexpressible_marks`] to a fixpoint, at this level and inside every mark.
///
/// Two passes are needed for two separate reasons. Horizontally, unwrapping one mark changes
/// the neighbouring characters that decide whether the *next* one can open or close.
/// Vertically, [`push`] merges two adjacent same-typed marks by concatenating their children —
/// and those children then sit next to neighbours they were never checked against.
///
/// Each pass strictly removes at least one mark from a finite tree, so this terminates.
fn settle(
    mut items: Vec<Inline>,
    enclosing_prev: Option<char>,
    enclosing_next: Option<char>,
    inside_emphasis: bool,
) -> Vec<Inline> {
    loop {
        let mut next = drop_unexpressible_marks(
            items.clone(),
            enclosing_prev,
            enclosing_next,
            inside_emphasis,
        );
        next = next
            .into_iter()
            .map(|i| settle_children(i, inside_emphasis))
            .collect();
        if next == items {
            return next;
        }
        items = next;
    }
}

fn settle_children(item: Inline, inside_emphasis: bool) -> Inline {
    // Inside an emphasis, a nested emphasis must alternate to `_` wherever it sits — not only
    // at the edges. The flag therefore passes *through* strong, strikethrough and highlight,
    // exactly as the serializer's `Ctx::nested` carries the delimiter through them.
    let e = inside_emphasis;
    match item {
        Inline::Emphasis(c) => Inline::Emphasis(settle(c, Some('*'), Some('*'), true)),
        Inline::Strong(c) => Inline::Strong(settle(c, Some('*'), Some('*'), e)),
        Inline::Strikethrough(c) => Inline::Strikethrough(settle(c, Some('~'), Some('~'), e)),
        Inline::Highlight(c) => Inline::Highlight(settle(c, Some('='), Some('='), e)),
        Inline::Link {
            dest,
            title,
            content,
        } => Inline::Link {
            dest,
            title,
            content: settle(content, Some('['), Some(')'), e),
        },
        other => other,
    }
}

/// Unwraps emphasis-like marks that CommonMark's flanking rules cannot express.
///
/// A delimiter cannot **open** when it follows an alphanumeric and precedes punctuation, and
/// cannot **close** in the mirror case — so `0*[*` is literal text, not emphasis, whichever
/// delimiter is chosen (`_` fails intraword too). The block model claims to be isomorphic to
/// a Markdown subset; a mark that no Markdown can express would break that claim, and writing
/// it out anyway would put visible `*` characters into the user's prose on the next save.
///
/// The mark is dropped and its text kept. Losing emphasis is a real cost, but it is far
/// smaller than corrupting the text, and this shape is rare — it needs punctuation hard
/// against a word character.
fn drop_unexpressible_marks(
    items: Vec<Inline>,
    enclosing_prev: Option<char>,
    enclosing_next: Option<char>,
    inside_emphasis: bool,
) -> Vec<Inline> {
    let mut out: Vec<Inline> = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        let Some(children) = mark_children(item) else {
            push(&mut out, item.clone());
            continue;
        };
        // At the edges of a sequence the neighbouring character comes from the *enclosing*
        // mark's delimiter — `**_0_A**` fails because the enclosing `**` forces `_`, which
        // then cannot close against `A`. Without this the edges look unconstrained.
        let prev = out.last().and_then(rendered_last_char).or(enclosing_prev);
        let next = items
            .get(i + 1)
            .and_then(rendered_first_char)
            .or(enclosing_next);
        let opens = children.first().and_then(rendered_first_char);
        let closes = children.last().and_then(rendered_last_char);

        // CommonMark's flanking rules, over a deliberately conservative classification (see
        // `underscore_safe`). Strikethrough obeys them too and has no alternate delimiter, so
        // a `~~` that cannot close must be dropped rather than written out to be misread.
        let flanked = matches!(
            item,
            Inline::Emphasis(_) | Inline::Strong(_) | Inline::Strikethrough(_)
        );
        let cannot_open = flanked && !left_flanking(prev, opens);
        let cannot_close = flanked && !right_flanking(closes, next);

        // Emphasis has two possible delimiters and can run out of both. Against a `*` it must
        // use `_`, or the runs fuse into `***`; but `_` cannot open or close against a word
        // character. Wedged between the two, it cannot be written at all.
        // `_` is forced by a `*` on either side *or* at either edge of the body: `*` there
        // would fuse into `***`, which CommonMark re-reads with the nesting inverted.
        let must_use_underscore = matches!(item, Inline::Emphasis(_))
            && (inside_emphasis
                || prev == Some('*')
                || next == Some('*')
                || opens == Some('*')
                || closes == Some('*'));
        let no_delimiter_left =
            must_use_underscore && !(underscore_safe(prev) && underscore_safe(next));

        if cannot_open || cannot_close || no_delimiter_left {
            for child in children.clone() {
                push(&mut out, child);
            }
        } else {
            push(&mut out, item.clone());
        }
    }
    out
}

fn mark_children(item: &Inline) -> Option<&Vec<Inline>> {
    match item {
        Inline::Emphasis(c)
        | Inline::Strong(c)
        | Inline::Strikethrough(c)
        | Inline::Highlight(c) => Some(c),
        _ => None,
    }
}

/// Whether `_` can open or close against this neighbouring character.
///
/// CommonMark decides with flanking rules over Unicode whitespace and punctuation
/// *categories*, which the standard library does not expose — and the disagreements land
/// exactly on the exotic characters (vertical tab, private-use, vulgar fractions) that make
/// this go wrong. Rather than approximate the categories, this is deliberately conservative:
/// only characters certain to be safe are accepted. A false negative costs one dropped
/// emphasis in a rare document; a false positive corrupts the text on save.
fn underscore_safe(c: Option<char>) -> bool {
    match c {
        None => true,
        // CommonMark's whitespace set, which is *not* `char::is_whitespace`.
        Some(' ' | '\t' | '\n' | '\r' | '\u{c}') => true,
        Some(c) => c.is_ascii_punctuation(),
    }
}

/// A delimiter run can open when it is left-flanking: not followed by whitespace, and either
/// not followed by punctuation or preceded by whitespace or punctuation.
fn left_flanking(before: Option<char>, after: Option<char>) -> bool {
    match class(after) {
        Class::Whitespace => false,
        Class::Other => true,
        Class::Punctuation => matches!(class(before), Class::Whitespace | Class::Punctuation),
    }
}

/// The mirror image: a run can close when it is right-flanking.
fn right_flanking(before: Option<char>, after: Option<char>) -> bool {
    match class(before) {
        Class::Whitespace => false,
        Class::Other => true,
        Class::Punctuation => matches!(class(after), Class::Whitespace | Class::Punctuation),
    }
}

/// The first character this inline will render.
///
/// Accuracy matters: the flanking rules turn on whether the neighbouring character is
/// alphanumeric, and most inlines open with punctuation but `Tag` does not *close* with it —
/// `#a` ends in a letter. Approximating either edge as punctuation silently disables the
/// check for exactly the cases it exists to catch.
fn rendered_first_char(item: &Inline) -> Option<char> {
    match item {
        Inline::Text(t) => t.chars().next(),
        Inline::SoftBreak | Inline::HardBreak => None,
        Inline::Tag(_) => Some('#'),
        Inline::Emoji(_) => Some(':'),
        Inline::Code(_) => Some('`'),
        Inline::Math(_) => Some('$'),
        Inline::Image { .. } => Some('!'),
        Inline::WikiLink(w) if w.embed => Some('!'),
        Inline::WikiLink(_) | Inline::Link { .. } | Inline::FootnoteRef(_) => Some('['),
        // Emphasis, strong, strikethrough, highlight: all open with punctuation.
        _ => Some('*'),
    }
}

fn rendered_last_char(item: &Inline) -> Option<char> {
    match item {
        Inline::Text(t) => t.chars().next_back(),
        Inline::SoftBreak | Inline::HardBreak => None,
        // `#a` ends in the tag body, which is alphanumeric.
        Inline::Tag(t) => t.chars().next_back(),
        Inline::Emoji(_) => Some(':'),
        Inline::Code(_) => Some('`'),
        Inline::Math(_) => Some('$'),
        Inline::WikiLink(_) => Some(']'),
        Inline::FootnoteRef(_) => Some(']'),
        Inline::Image { dest, .. } | Inline::Link { dest, .. } => {
            Some(if dest.is_empty() || dest.contains([' ', '(', ')']) {
                '>'
            } else {
                ')'
            })
        }
        _ => Some('*'),
    }
}

fn canonical_inline(item: Inline) -> Inline {
    fn finish(c: Vec<Inline>, kind: Same, d: char) -> Vec<Inline> {
        settle(
            unwrap_same(inlines(c), kind),
            Some(d),
            Some(d),
            kind == Same::Emphasis,
        )
    }
    match item {
        Inline::Emphasis(c) => Inline::Emphasis(finish(c, Same::Emphasis, '*')),
        Inline::Strong(c) => Inline::Strong(finish(c, Same::Strong, '*')),
        Inline::Strikethrough(c) => Inline::Strikethrough(finish(c, Same::Strikethrough, '~')),
        Inline::Highlight(c) => Inline::Highlight(finish(c, Same::Highlight, '=')),
        Inline::Link {
            dest,
            title,
            content,
        } => Inline::Link {
            dest,
            title,
            content: inlines(content),
        },
        other => other,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Same {
    Emphasis,
    Strong,
    Strikethrough,
    Highlight,
}

/// Splices same-typed children into the parent: `Strong(Strong(x))` means `Strong(x)`, and
/// `**a****b**` is a run of asterisks no parser reads back as two strongs.
fn unwrap_same(children: Vec<Inline>, kind: Same) -> Vec<Inline> {
    let mut out: Vec<Inline> = Vec::with_capacity(children.len());
    for child in children {
        let inner = match (&child, kind) {
            (Inline::Emphasis(i), Same::Emphasis)
            | (Inline::Strong(i), Same::Strong)
            | (Inline::Strikethrough(i), Same::Strikethrough)
            | (Inline::Highlight(i), Same::Highlight) => Some(i.clone()),
            _ => None,
        };
        match inner {
            Some(items) => {
                for item in unwrap_same(items, kind) {
                    push(&mut out, item);
                }
            }
            None => push(&mut out, child),
        }
    }
    out
}

/// Appends, merging with the previous item when the two render indistinguishably.
pub(crate) fn push(out: &mut Vec<Inline>, item: Inline) {
    // An empty text run renders as nothing, so it can never come back from a parse.
    if matches!(&item, Inline::Text(t) if t.is_empty()) {
        return;
    }
    // Markdown discards whitespace on both sides of a line break, so carrying it in the
    // model guarantees a mismatch on the next parse. Trailing tabs from raw-HTML blocks are
    // the usual source.
    if matches!(item, Inline::SoftBreak | Inline::HardBreak)
        && let Some(Inline::Text(prev)) = out.last_mut()
    {
        let trimmed = prev.trim_end().to_string();
        if trimmed.is_empty() {
            out.pop();
        } else {
            *prev = trimmed;
        }
    }
    let item = match (out.last(), item) {
        (Some(Inline::SoftBreak | Inline::HardBreak), Inline::Text(t)) => {
            Inline::Text(t.trim_start().to_string())
        }
        (_, item) => item,
    };

    // Two consecutive breaks render as a blank line, which splits the paragraph in two on
    // reparse. A hard break outranks a soft one.
    if matches!(item, Inline::SoftBreak | Inline::HardBreak)
        && matches!(out.last(), Some(Inline::SoftBreak | Inline::HardBreak))
    {
        if matches!(item, Inline::HardBreak) {
            out.pop();
            out.push(Inline::HardBreak);
        }
        return;
    }
    // A tag cannot end in `_`: that character would act as a closing emphasis delimiter, so
    // it is split off into text where it is escaped normally.
    if let Inline::Tag(t) = &item
        && let Some(stripped) = t.strip_suffix('_')
    {
        let (name, rest) = (stripped.to_string(), "_".to_string());
        if name.is_empty() {
            push(out, Inline::Text(format!("#{rest}")));
        } else {
            push(out, Inline::Tag(name));
            push(out, Inline::Text(rest));
        }
        return;
    }

    // A tag has no closing delimiter, so `Tag("a")` followed by `Text("A")` renders `#aA` —
    // which reads back as one tag. The normal form absorbs as much of the text as the tag
    // scanner would have taken, so both sides agree.
    if let (Some(Inline::Tag(tag)), Inline::Text(text)) = (out.last(), &item) {
        let combined = format!("{tag}{text}");
        if let Some(len) = crate::syntax::scan_tag(&combined)
            && len > tag.len()
        {
            {
                let (taken, rest) = combined.split_at(len);
                let taken = taken.to_string();
                let rest = rest.to_string();
                out.pop();
                out.push(Inline::Tag(taken));
                if !rest.is_empty() {
                    out.push(Inline::Text(rest));
                }
                return;
            }
        }
    }
    match (out.last_mut(), item) {
        (Some(Inline::Text(prev)), Inline::Text(next)) => prev.push_str(&next),
        // Two adjacent code spans fuse: `` `a``a` `` is one span whose content is ``a``a``,
        // not two spans. Merging is the only expressible form.
        (Some(Inline::Code(prev)), Inline::Code(next)) => prev.push_str(&next),
        // ...and two adjacent inline maths, for exactly the same reason: `$a$$b$` reads
        // back as literal text, so keeping them apart guarantees a file that rewrites
        // itself on the next save.
        (Some(Inline::Math(prev)), Inline::Math(next)) => prev.push_str(&next),
        (Some(Inline::Emphasis(prev)), Inline::Emphasis(next))
        | (Some(Inline::Strong(prev)), Inline::Strong(next))
        | (Some(Inline::Strikethrough(prev)), Inline::Strikethrough(next))
        | (Some(Inline::Highlight(prev)), Inline::Highlight(next)) => {
            for child in next {
                push(prev, child);
            }
        }
        (_, item) => out.push(item),
    }
}

/// Replaces line breaks with spaces, for contexts that are single-line by construction.
///
/// Recurses: a break nested inside emphasis is just as unrepresentable in an ATX heading as
/// one at the top level, and leaving it there makes the model disagree with its own output.
pub(crate) fn flatten_breaks(content: Vec<Inline>) -> Vec<Inline> {
    let mut out: Vec<Inline> = Vec::with_capacity(content.len());
    for item in content {
        let item = match item {
            Inline::SoftBreak | Inline::HardBreak => Inline::Text(" ".to_string()),
            Inline::Emphasis(c) => Inline::Emphasis(flatten_breaks(c)),
            Inline::Strong(c) => Inline::Strong(flatten_breaks(c)),
            Inline::Strikethrough(c) => Inline::Strikethrough(flatten_breaks(c)),
            Inline::Highlight(c) => Inline::Highlight(flatten_breaks(c)),
            Inline::Link {
                dest,
                title,
                content,
            } => Inline::Link {
                dest,
                title,
                content: flatten_breaks(content),
            },
            other => other,
        };
        push(&mut out, item);
    }
    out
}

/// Drops leading and trailing breaks and whitespace, which Markdown strips at block edges.
pub(crate) fn trim_edges(mut items: Vec<Inline>) -> Vec<Inline> {
    loop {
        let changed = trim_front(&mut items) | trim_back(&mut items);
        if !changed {
            return items;
        }
    }
}

fn trim_front(items: &mut Vec<Inline>) -> bool {
    match items.first_mut() {
        Some(Inline::SoftBreak | Inline::HardBreak) => {
            items.remove(0);
            true
        }
        Some(Inline::Text(t)) => {
            let trimmed = t.trim_start().to_string();
            if trimmed == *t {
                return false;
            }
            if trimmed.is_empty() {
                items.remove(0);
            } else {
                *t = trimmed;
            }
            true
        }
        _ => false,
    }
}

fn trim_back(items: &mut Vec<Inline>) -> bool {
    match items.last_mut() {
        Some(Inline::SoftBreak | Inline::HardBreak) => {
            items.pop();
            true
        }
        Some(Inline::Text(t)) => {
            let trimmed = t.trim_end().to_string();
            if trimmed == *t {
                return false;
            }
            if trimmed.is_empty() {
                items.pop();
            } else {
                *t = trimmed;
            }
            true
        }
        _ => false,
    }
}
