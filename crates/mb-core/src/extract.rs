//! Structured extraction: links, tags, anchors, tasks, media references.
//!
//! This is what `mb-index` writes into SQLite (`SPEC.md` §9.1) and what the client
//! search index is built from. It is pure and walks the block model, never the text, so it
//! can never disagree with what the editor shows.

use crate::model::{Anchor, Block, BlockKind, Document, HeadingLevel, Inline, ListItem};
use crate::task::Task;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkRef {
    pub target: String,
    pub anchor: Option<Anchor>,
    pub alias: Option<String>,
    /// `![[…]]` embeds are indexed as `kind = embed` (§9.1) and drive transclusion.
    pub embed: bool,
    /// `^block-id` of the block the link sits in, when that block carries one.
    ///
    /// Backs `links.source_block` (§9.1): a backlink row that can name the exact block is
    /// one a reader can jump straight to.
    pub source_block: Option<String>,
    /// Visible text of the block the link sits in — the context a backlink row shows (§9.5).
    ///
    /// `None` only for a link in a block with no textual content at all, which the block
    /// model does not currently produce; it is an `Option` rather than an empty string so
    /// "no context" and "the context is empty" stay distinguishable at the index boundary.
    pub context: Option<String>,
}

/// A block carrying a `^block-id`, with its text (§9.1 `blocks`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnchoredBlock {
    /// The `^block-id`, without its caret.
    pub anchor: String,
    /// Visible text of the block, for block transclusion context and backlink rows.
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRef {
    pub task: Task,
    /// Plain text of the task line, for task views (§10.3).
    pub text: String,
    pub anchor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaRef {
    /// Vault-relative object path written in Markdown.
    pub path: String,
    /// Image alt text or media-link label used for display.
    pub original_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Extracted {
    pub links: Vec<LinkRef>,
    /// Inline `#tags` and frontmatter `tags:`, unified (§9.3).
    pub tags: Vec<String>,
    pub emoji: Vec<String>,
    /// Every `^block-id` defined in the note, with the text of the block that carries it.
    pub anchors: Vec<AnchoredBlock>,
    pub tasks: Vec<TaskRef>,
    /// Destinations of images and links into `media/`, backing `media_refs` (E11).
    pub media: Vec<String>,
    /// Display metadata for indexed media rows; Markdown remains the source of truth.
    pub media_refs: Vec<MediaRef>,
    pub headings: Vec<(u8, String)>,
    /// Visible text of each top-level block, in document order.
    ///
    /// Search indexes blocks rather than byte spans so results can show context without
    /// reparsing Markdown or maintaining a second parser in TypeScript (`SPEC.md` §14.3).
    pub text_blocks: Vec<String>,
    pub word_count: usize,
}

/// Extracts everything the index needs from a parsed note.
#[must_use]
pub fn extract(doc: &Document) -> Extracted {
    let mut out = Extracted::default();
    for tag in &doc.frontmatter.tags {
        push_unique(&mut out.tags, tag.clone());
    }
    if let Some(icon) = &doc.frontmatter.icon
        && let Some(name) = icon.strip_prefix(':').and_then(|s| s.strip_suffix(':'))
    {
        push_unique(&mut out.emoji, name.to_string());
    }
    out.text_blocks = doc.blocks.iter().map(block_text).collect();
    walk_blocks(&doc.blocks, &mut out);
    out
}

fn walk_blocks(blocks: &[Block], out: &mut Extracted) {
    for block in blocks {
        // why: links learn their context by back-patching rather than by having it handed
        // down. Building a context string for every block would allocate one plain-text
        // rendering per paragraph in the vault, and almost no paragraph contains a link;
        // this way the cost is paid only where there is something to attribute. Nested
        // blocks finish before their parent, so the innermost block wins — see
        // `attribute`.
        let first_link = out.links.len();
        if let Some(anchor) = &block.anchor {
            push_anchor(&mut out.anchors, anchor.clone(), block_text(block));
        }
        match &block.kind {
            BlockKind::Paragraph(content) => walk_inlines(content, out),
            BlockKind::Heading { level, content } => {
                walk_inlines(content, out);
                out.headings.push((level.get(), plain_text(content)));
            }
            BlockKind::List(list) => {
                for item in &list.items {
                    walk_item(item, out);
                }
            }
            BlockKind::Blockquote(inner) => walk_blocks(inner, out),
            BlockKind::Callout(c) => {
                walk_inlines(&c.title, out);
                walk_blocks(&c.content, out);
            }
            BlockKind::CodeBlock { code, .. } => out.word_count += count_words(code),
            BlockKind::Table(t) => {
                for cell in t.head.iter().chain(t.rows.iter().flatten()) {
                    walk_inlines(cell, out);
                }
            }
            BlockKind::MathBlock(_) | BlockKind::Divider => {}
        }
        attribute(out, first_link, block);
    }
}

/// Gives every link found in `block` its containing block, unless a nested block already did.
fn attribute(out: &mut Extracted, first_link: usize, block: &Block) {
    let Some(found) = out.links.get(first_link..) else {
        return;
    };
    if found.iter().all(|link| link.context.is_some()) {
        return;
    }
    let text = block_text(block);
    for link in out.links.iter_mut().skip(first_link) {
        if link.context.is_none() {
            link.source_block = block.anchor.clone();
            link.context = Some(text.clone());
        }
    }
}

/// The visible text of one block, flattened.
///
/// Container blocks include their children, so a link in a bare blockquote still gets
/// context, and an anchored callout indexes as the text a reader sees.
fn block_text(block: &Block) -> String {
    match &block.kind {
        BlockKind::Paragraph(content) | BlockKind::Heading { content, .. } => plain_text(content),
        BlockKind::CodeBlock { code, .. } | BlockKind::MathBlock(code) => code.clone(),
        BlockKind::Blockquote(inner) => joined(inner.iter().map(block_text)),
        BlockKind::Callout(c) => {
            joined(std::iter::once(plain_text(&c.title)).chain(c.content.iter().map(block_text)))
        }
        BlockKind::List(list) => joined(
            list.items
                .iter()
                .flat_map(|item| item.content.iter().map(block_text)),
        ),
        BlockKind::Table(t) => joined(
            t.head
                .iter()
                .chain(t.rows.iter().flatten())
                .map(|cell| plain_text(cell)),
        ),
        BlockKind::Divider => String::new(),
    }
}

fn joined(parts: impl Iterator<Item = String>) -> String {
    let mut out = String::new();
    for part in parts.filter(|part| !part.is_empty()) {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&part);
    }
    out
}

fn walk_item(item: &ListItem, out: &mut Extracted) {
    if let Some(task) = &item.task {
        let text = item
            .content
            .first()
            .and_then(|b| match &b.kind {
                BlockKind::Paragraph(c) => Some(plain_text(c)),
                _ => None,
            })
            .unwrap_or_default();
        let anchor = item.content.first().and_then(|b| b.anchor.clone());
        out.tasks.push(TaskRef {
            task: task.clone(),
            text,
            anchor,
        });
    }
    walk_blocks(&item.content, out);
}

fn walk_inlines(items: &[Inline], out: &mut Extracted) {
    for item in items {
        match item {
            Inline::Text(t) => out.word_count += count_words(t),
            Inline::Emphasis(c)
            | Inline::Strong(c)
            | Inline::Strikethrough(c)
            | Inline::Highlight(c) => walk_inlines(c, out),
            Inline::Link { dest, content, .. } => {
                record_media(dest, &plain_text(content), out);
                walk_inlines(content, out);
            }
            Inline::Image { dest, alt } => {
                record_media(dest, alt, out);
                out.word_count += count_words(alt);
            }
            Inline::WikiLink(w) => {
                out.links.push(LinkRef {
                    target: w.target.clone(),
                    anchor: w.anchor.clone(),
                    alias: w.alias.clone(),
                    embed: w.embed,
                    source_block: None,
                    context: None,
                });
            }
            Inline::Tag(t) => push_unique(&mut out.tags, t.clone()),
            Inline::Emoji(e) => push_unique(&mut out.emoji, e.clone()),
            Inline::Code(c) => out.word_count += count_words(c),
            Inline::Math(_) | Inline::FootnoteRef(_) | Inline::SoftBreak | Inline::HardBreak => {}
        }
    }
}

/// Media is referenced by vault-relative path so the vault stays self-contained (§12.3).
fn record_media(dest: &str, original_name: &str, out: &mut Extracted) {
    if dest.starts_with("media/") || dest.starts_with("./media/") {
        let path = dest.trim_start_matches("./").to_string();
        push_unique(&mut out.media, path.clone());
        if !out
            .media_refs
            .iter()
            .any(|reference| reference.path == path)
        {
            out.media_refs.push(MediaRef {
                path,
                original_name: original_name.to_string(),
            });
        }
    }
}

fn push_unique(list: &mut Vec<String>, value: String) {
    if !list.contains(&value) {
        list.push(value);
    }
}

/// Records an anchored block, keeping the first definition of a repeated `^block-id`.
///
/// A duplicate id is a malformed note rather than a modelled state, and the first one is
/// what a reference resolves to, so that is the one the index should hold.
fn push_anchor(list: &mut Vec<AnchoredBlock>, anchor: String, text: String) {
    if !list.iter().any(|existing| existing.anchor == anchor) {
        list.push(AnchoredBlock { anchor, text });
    }
}

fn count_words(s: &str) -> usize {
    s.split_whitespace().count()
}

/// Flattens inlines to their visible text, for titles, snippets and task lines.
#[must_use]
pub fn plain_text(items: &[Inline]) -> String {
    let mut out = String::new();
    for item in items {
        match item {
            Inline::Text(t) => out.push_str(t),
            Inline::Code(c) | Inline::Math(c) => out.push_str(c),
            Inline::Emphasis(c)
            | Inline::Strong(c)
            | Inline::Strikethrough(c)
            | Inline::Highlight(c) => out.push_str(&plain_text(c)),
            Inline::Link { content, .. } => out.push_str(&plain_text(content)),
            Inline::Image { alt, .. } => out.push_str(alt),
            Inline::WikiLink(w) => {
                out.push_str(w.alias.as_deref().unwrap_or(&w.target));
            }
            Inline::Tag(t) => {
                out.push('#');
                out.push_str(t);
            }
            Inline::Emoji(e) => {
                out.push(':');
                out.push_str(e);
                out.push(':');
            }
            Inline::FootnoteRef(_) => {}
            Inline::SoftBreak | Inline::HardBreak => out.push(' '),
        }
    }
    out
}

/// The note's title: its first H1, else the first heading, else the first line of text.
#[must_use]
pub fn title(doc: &Document) -> Option<String> {
    let mut fallback = None;
    for block in &doc.blocks {
        match &block.kind {
            BlockKind::Heading {
                level: HeadingLevel::H1,
                content,
            } => return Some(plain_text(content)),
            BlockKind::Heading { content, .. } if fallback.is_none() => {
                fallback = Some(plain_text(content));
            }
            BlockKind::Paragraph(content) if fallback.is_none() => {
                let text = plain_text(content);
                let line = text.lines().next().unwrap_or("").trim().to_string();
                if !line.is_empty() {
                    fallback = Some(line);
                }
            }
            _ => {}
        }
    }
    fallback
}
