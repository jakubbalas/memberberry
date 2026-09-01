//! Structured extraction: links, tags, anchors, tasks, media references.
//!
//! This is what `mb-index` will write into SQLite (`SPEC.md` §9.1) and what the client
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
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRef {
    pub task: Task,
    /// Plain text of the task line, for task views (§10.3).
    pub text: String,
    pub anchor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Extracted {
    pub links: Vec<LinkRef>,
    /// Inline `#tags` and frontmatter `tags:`, unified (§9.3).
    pub tags: Vec<String>,
    pub emoji: Vec<String>,
    /// Every `^block-id` defined in the note.
    pub anchors: Vec<String>,
    pub tasks: Vec<TaskRef>,
    /// Destinations of images and links into `media/`, backing `media_refs` (E11).
    pub media: Vec<String>,
    pub headings: Vec<(u8, String)>,
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
    walk_blocks(&doc.blocks, &mut out);
    out
}

fn walk_blocks(blocks: &[Block], out: &mut Extracted) {
    for block in blocks {
        if let Some(anchor) = &block.anchor {
            push_unique(&mut out.anchors, anchor.clone());
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
    }
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
                record_media(dest, out);
                walk_inlines(content, out);
            }
            Inline::Image { dest, alt } => {
                record_media(dest, out);
                out.word_count += count_words(alt);
            }
            Inline::WikiLink(w) => {
                out.links.push(LinkRef {
                    target: w.target.clone(),
                    anchor: w.anchor.clone(),
                    alias: w.alias.clone(),
                    embed: w.embed,
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
fn record_media(dest: &str, out: &mut Extracted) {
    if dest.starts_with("media/") || dest.starts_with("./media/") {
        push_unique(&mut out.media, dest.trim_start_matches("./").to_string());
    }
}

fn push_unique(list: &mut Vec<String>, value: String) {
    if !list.contains(&value) {
        list.push(value);
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
