//! Block model → HTML.
//!
//! Pure and `wasm32`-clean like the rest of the crate, so the same renderer serves the M0
//! read-only server, the share-link renderer of `SPEC.md` §17.2, and a client-side preview
//! without any of them being able to disagree about what a note looks like.
//!
//! # Escaping is the whole job
//!
//! Everything here renders **someone's private notes to other people**. A note is not
//! trusted input: it can contain `<script>`, an `onerror=` attribute, a `javascript:` URL
//! pasted from anywhere. There is no HTML block type in the model (`SPEC.md` §4.4) — raw
//! HTML was already downgraded to text at parse time — so this renderer never has a reason
//! to emit markup it did not construct itself, and it does not.
//!
//! Concretely: every text node goes through [`escape_text`], every attribute value through
//! [`escape_attr`], and every URL through [`safe_url`], which refuses schemes that execute.
//! `html_escaping_blocks_script_injection` and friends in `tests/html.rs` are the proof.

use crate::model::{
    Alignment, Anchor, Block, BlockKind, Callout, Document, Fold, Inline, List, ListItem, Table,
    WikiLink,
};
use crate::task::TaskStatus;

/// Where links point. The renderer is pure, so the caller supplies the routing.
///
/// The default is empty prefixes, which renders relative links — right for a fragment
/// embedded in a page that already sits at the vault root.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Urls<'a> {
    /// Prefix for a wikilink target: `/v/personal/` gives `/v/personal/Some%20Note`.
    pub note: &'a str,
    /// Prefix for a `media/…` destination.
    pub media: &'a str,
}

/// Renders a document as an HTML fragment — no `<html>`, no `<body>`.
#[must_use]
pub fn document(doc: &Document, urls: &Urls<'_>) -> String {
    let mut out = String::with_capacity(doc.blocks.len() * 64);
    blocks(&doc.blocks, urls, &mut out);
    out
}

fn blocks(items: &[Block], urls: &Urls<'_>, out: &mut String) {
    for b in items {
        block(b, urls, out);
    }
}

fn block(b: &Block, urls: &Urls<'_>, out: &mut String) {
    let anchor = b.anchor.as_deref();
    match &b.kind {
        BlockKind::Paragraph(content) => {
            open(out, "p", anchor);
            inlines(content, urls, out);
            out.push_str("</p>");
        }
        BlockKind::Heading { level, content } => {
            let tag = match level.get() {
                1 => "h1",
                2 => "h2",
                3 => "h3",
                4 => "h4",
                5 => "h5",
                _ => "h6",
            };
            open(out, tag, anchor);
            inlines(content, urls, out);
            out.push_str("</");
            out.push_str(tag);
            out.push('>');
        }
        BlockKind::List(l) => list(l, urls, anchor, out),
        BlockKind::Blockquote(inner) => {
            open(out, "blockquote", anchor);
            blocks(inner, urls, out);
            out.push_str("</blockquote>");
        }
        BlockKind::Callout(c) => callout(c, urls, anchor, out),
        BlockKind::CodeBlock { lang, code } => {
            out.push_str("<pre");
            push_anchor(out, anchor);
            out.push_str("><code");
            if let Some(lang) = lang.as_deref().filter(|l| !l.is_empty()) {
                // The `language-` convention is what every highlighter looks for.
                out.push_str(" class=\"language-");
                escape_attr(lang, out);
                out.push('"');
            }
            out.push('>');
            escape_text(code, out);
            out.push_str("</code></pre>");
        }
        BlockKind::Divider => {
            out.push_str("<hr");
            push_anchor(out, anchor);
            out.push_str(" />");
        }
        BlockKind::Table(t) => table(t, urls, anchor, out),
        BlockKind::MathBlock(m) => {
            // why: no maths typesetter runs here. The source is emitted verbatim inside a
            // marked element for a client-side renderer (KaTeX) to pick up, which keeps
            // this crate free of a rendering dependency and keeps the source recoverable
            // when no JavaScript runs at all.
            out.push_str("<div class=\"mb-math-block\"");
            push_anchor(out, anchor);
            out.push('>');
            escape_text(m, out);
            out.push_str("</div>");
        }
    }
    out.push('\n');
}

fn open(out: &mut String, tag: &str, anchor: Option<&str>) {
    out.push('<');
    out.push_str(tag);
    push_anchor(out, anchor);
    out.push('>');
}

/// A block's `^block-id` becomes its element id, so `#^anchor` links work in a browser.
fn push_anchor(out: &mut String, anchor: Option<&str>) {
    if let Some(a) = anchor {
        out.push_str(" id=\"");
        escape_attr(a, out);
        out.push('"');
    }
}

fn list(l: &List, urls: &Urls<'_>, anchor: Option<&str>, out: &mut String) {
    let tag = if l.ordered { "ol" } else { "ul" };
    out.push('<');
    out.push_str(tag);
    push_anchor(out, anchor);
    if l.ordered && l.start != 1 {
        out.push_str(" start=\"");
        out.push_str(&l.start.to_string());
        out.push('"');
    }
    // A list holding any task renders as a task list, matching Obsidian's markup hook.
    if l.items.iter().any(|i| i.task.is_some()) {
        out.push_str(" class=\"mb-task-list\"");
    }
    out.push_str(">\n");
    for item in &l.items {
        list_item(item, urls, out);
    }
    out.push_str("</");
    out.push_str(tag);
    out.push('>');
}

fn list_item(item: &ListItem, urls: &Urls<'_>, out: &mut String) {
    out.push_str("<li");
    if let Some(t) = &item.task {
        out.push_str(" class=\"mb-task mb-task-");
        out.push_str(match t.status {
            TaskStatus::Todo => "todo",
            TaskStatus::Done => "done",
            TaskStatus::Cancelled => "cancelled",
        });
        out.push('"');
    }
    out.push('>');
    if let Some(t) = &item.task {
        // why: `disabled` is not decoration. This is a read-only rendering; an enabled
        // checkbox would invite a click that changes nothing and silently loses the edit.
        out.push_str("<input type=\"checkbox\" disabled");
        if t.status == TaskStatus::Done {
            out.push_str(" checked");
        }
        out.push_str(" /> ");
    }
    blocks(&item.content, urls, out);
    out.push_str("</li>\n");
}

fn callout(c: &Callout, urls: &Urls<'_>, anchor: Option<&str>, out: &mut String) {
    out.push_str("<div class=\"mb-callout mb-callout-");
    escape_attr(&c.kind.to_lowercase(), out);
    out.push('"');
    push_anchor(out, anchor);
    if c.fold != Fold::None {
        out.push_str(" data-fold=\"");
        out.push_str(match c.fold {
            Fold::Collapsed => "collapsed",
            _ => "expanded",
        });
        out.push('"');
    }
    out.push_str(">\n<div class=\"mb-callout-title\">");
    if c.title.is_empty() {
        // Obsidian titles an untitled callout with its kind.
        escape_text(&c.kind, out);
    } else {
        inlines(&c.title, urls, out);
    }
    out.push_str("</div>\n");
    if !c.content.is_empty() {
        out.push_str("<div class=\"mb-callout-body\">\n");
        blocks(&c.content, urls, out);
        out.push_str("</div>\n");
    }
    out.push_str("</div>");
}

fn table(t: &Table, urls: &Urls<'_>, anchor: Option<&str>, out: &mut String) {
    out.push_str("<table");
    push_anchor(out, anchor);
    out.push_str(">\n<thead>\n");
    row(&t.head, &t.alignments, "th", urls, out);
    out.push_str("</thead>\n<tbody>\n");
    for r in &t.rows {
        row(r, &t.alignments, "td", urls, out);
    }
    out.push_str("</tbody>\n</table>");
}

fn row(
    cells: &[Vec<Inline>],
    alignments: &[Alignment],
    tag: &str,
    urls: &Urls<'_>,
    out: &mut String,
) {
    out.push_str("<tr>");
    for (i, cell) in cells.iter().enumerate() {
        out.push('<');
        out.push_str(tag);
        match alignments.get(i) {
            Some(Alignment::Left) => out.push_str(" style=\"text-align:left\""),
            Some(Alignment::Center) => out.push_str(" style=\"text-align:center\""),
            Some(Alignment::Right) => out.push_str(" style=\"text-align:right\""),
            _ => {}
        }
        out.push('>');
        inlines(cell, urls, out);
        out.push_str("</");
        out.push_str(tag);
        out.push('>');
    }
    out.push_str("</tr>\n");
}

fn inlines(items: &[Inline], urls: &Urls<'_>, out: &mut String) {
    for i in items {
        inline(i, urls, out);
    }
}

fn inline(i: &Inline, urls: &Urls<'_>, out: &mut String) {
    match i {
        Inline::Text(t) => escape_text(t, out),
        Inline::Emphasis(c) => wrap("em", c, urls, out),
        Inline::Strong(c) => wrap("strong", c, urls, out),
        Inline::Strikethrough(c) => wrap("del", c, urls, out),
        Inline::Highlight(c) => wrap("mark", c, urls, out),
        Inline::Code(c) => {
            out.push_str("<code>");
            escape_text(c, out);
            out.push_str("</code>");
        }
        Inline::Math(m) => {
            out.push_str("<span class=\"mb-math\">");
            escape_text(m, out);
            out.push_str("</span>");
        }
        Inline::Link {
            dest,
            title,
            content,
        } => {
            out.push_str("<a href=\"");
            escape_attr(&safe_url(dest), out);
            out.push('"');
            if let Some(title) = title {
                out.push_str(" title=\"");
                escape_attr(title, out);
                out.push('"');
            }
            if is_external(dest) {
                // why: `noopener` stops the opened page reaching back through `window.opener`;
                // `noreferrer` keeps the vault's URL out of another site's logs.
                out.push_str(" rel=\"noopener noreferrer\"");
            }
            out.push('>');
            inlines(content, urls, out);
            out.push_str("</a>");
        }
        Inline::Image { dest, alt } => {
            out.push_str("<img src=\"");
            escape_attr(&resolve_media(dest, urls), out);
            out.push_str("\" alt=\"");
            escape_attr(alt, out);
            out.push_str("\" />");
        }
        Inline::WikiLink(w) => wikilink(w, urls, out),
        Inline::Tag(t) => {
            out.push_str("<span class=\"mb-tag\">#");
            escape_text(t, out);
            out.push_str("</span>");
        }
        Inline::Emoji(name) => {
            // Custom emoji are resolved per vault (§11.2); with no pack loaded the
            // shortcode stays visible rather than vanishing.
            out.push_str("<span class=\"mb-emoji\" data-shortcode=\"");
            escape_attr(name, out);
            out.push_str("\">:");
            escape_text(name, out);
            out.push_str(":</span>");
        }
        Inline::FootnoteRef(label) => {
            out.push_str("<sup class=\"mb-footnote-ref\">");
            escape_text(label, out);
            out.push_str("</sup>");
        }
        Inline::SoftBreak => out.push('\n'),
        Inline::HardBreak => out.push_str("<br />"),
    }
}

fn wrap(tag: &str, content: &[Inline], urls: &Urls<'_>, out: &mut String) {
    out.push('<');
    out.push_str(tag);
    out.push('>');
    inlines(content, urls, out);
    out.push_str("</");
    out.push_str(tag);
    out.push('>');
}

fn wikilink(w: &WikiLink, urls: &Urls<'_>, out: &mut String) {
    let mut href = String::from(urls.note);
    percent_encode(&w.target, &mut href);
    match &w.anchor {
        Some(Anchor::Heading(h)) => {
            href.push('#');
            percent_encode(h, &mut href);
        }
        Some(Anchor::Block(b)) => {
            href.push('#');
            percent_encode(b, &mut href);
        }
        None => {}
    }

    // why: the reference travels as data attributes as well as an `href`. A client that has
    // to *act* on this link — expand a transclusion (§9.2), follow a wikilink into a tab —
    // needs the target and the anchor as the file spells them, and the `href` is a lossy
    // encoding of both: it is percent-encoded, it carries the alias nowhere, and a
    // `#^block-id` and a `#Heading` are the same `#…` fragment once written. Re-deriving
    // the reference from a URL would be parsing our own output back.
    out.push_str(if w.embed {
        "<a class=\"mb-embed\" data-embed=\"true\" href=\""
    } else {
        "<a class=\"mb-wikilink\" href=\""
    });
    escape_attr(&href, out);
    out.push_str("\" data-target=\"");
    escape_attr(&w.target, out);
    out.push('"');
    match &w.anchor {
        Some(Anchor::Heading(h)) => {
            out.push_str(" data-anchor-kind=\"heading\" data-anchor=\"");
            escape_attr(h, out);
            out.push('"');
        }
        Some(Anchor::Block(b)) => {
            out.push_str(" data-anchor-kind=\"block\" data-anchor=\"");
            escape_attr(b, out);
            out.push('"');
        }
        None => {}
    }
    out.push('>');
    let text = w.alias.as_deref().unwrap_or(&w.target);
    escape_text(text, out);
    out.push_str("</a>");
}

fn resolve_media(dest: &str, urls: &Urls<'_>) -> String {
    if is_external(dest) || dest.starts_with('/') {
        return safe_url(dest);
    }
    let mut out = String::from(urls.media);
    percent_encode(dest, &mut out);
    out
}

/// True for a URL with an explicit scheme and authority.
fn is_external(dest: &str) -> bool {
    let lower = dest.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("//")
}

/// Neutralises URL schemes that execute.
///
/// `javascript:`, `vbscript:` and `data:` in an `href` or `src` are script execution in
/// disguise, and a note can contain any of them — pasted from a page, or written by someone
/// the vault is shared with. Anything unrecognised is replaced rather than sanitised,
/// because a partial fix here is a cross-site scripting hole in an app holding private
/// notes. Leading control characters and whitespace are stripped first: browsers ignore
/// them when resolving a scheme, so `java\nscript:` would otherwise slip through.
#[must_use]
pub fn safe_url(dest: &str) -> String {
    let stripped: String = dest
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '\u{0}'..='\u{20}'))
        .collect();
    let lower = stripped.to_ascii_lowercase();
    const BLOCKED: [&str; 4] = ["javascript:", "vbscript:", "data:", "file:"];
    if BLOCKED.iter().any(|scheme| lower.starts_with(scheme)) {
        return "#blocked".to_string();
    }
    dest.to_string()
}

/// Percent-encodes the characters that would break out of a URL path or query.
fn percent_encode(text: &str, out: &mut String) {
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(byte as char);
            }
            _ => {
                out.push('%');
                out.push_str(&format!("{byte:02X}"));
            }
        }
    }
}

/// Escapes text so it cannot open an element.
pub fn escape_text(text: &str, out: &mut String) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
}

/// Escapes text so it cannot close an attribute.
///
/// Stricter than [`escape_text`]: quotes end an attribute value, and an unquoted-looking
/// break is how `onerror=` gets injected.
pub fn escape_attr(text: &str, out: &mut String) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
}
