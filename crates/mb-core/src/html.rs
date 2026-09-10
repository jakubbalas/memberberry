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
    Alignment, Anchor, Block, BlockKind, Callout, Document, Fold, HeadingLevel, Inline, List,
    ListItem, Table, WikiLink,
};
use crate::task::TaskStatus;

/// Converts ordinary web HTML into the portable block model used by the clipper.
///
/// This intentionally accepts malformed HTML: browsers routinely receive it, and a clip
/// must never lose all of its text because one page omitted a closing tag. Unsupported
/// elements are transparent containers; executable elements are discarded together with
/// their contents. The result contains no raw HTML, so it can be serialized as Markdown.
#[must_use]
pub fn from_html(source: &str) -> Document {
    let root = parse_html(source);
    let mut blocks = Vec::new();
    if let Some(body) = root
        .children
        .iter()
        .find(|node| matches!(node, Node::Element(element) if element.tag == "body"))
    {
        html_blocks(body, &mut blocks);
    } else {
        for child in &root.children {
            html_blocks(child, &mut blocks);
        }
    }
    Document::new(blocks)
}

#[derive(Debug, Clone)]
struct Element {
    tag: String,
    attrs: Vec<(String, String)>,
    children: Vec<Node>,
}

#[derive(Debug, Clone)]
enum Node {
    Text(String),
    Element(Element),
}

fn parse_html(source: &str) -> Element {
    let mut root = Element {
        tag: "root".to_string(),
        attrs: Vec::new(),
        children: Vec::new(),
    };
    let mut stack = vec![root];
    let mut rest = source;
    while !rest.is_empty() {
        let Some(start) = rest.find('<') else {
            append_text(stack.last_mut(), rest);
            break;
        };
        append_text(stack.last_mut(), &rest[..start]);
        rest = &rest[start + 1..];
        if rest.starts_with("!--") {
            if let Some(end) = rest.find("-->") {
                rest = &rest[end + 3..];
            } else {
                break;
            }
            continue;
        }
        let Some(end) = rest.find('>') else { break };
        let raw = rest[..end].trim();
        rest = &rest[end + 1..];
        if raw.starts_with('!') || raw.starts_with('?') {
            continue;
        }
        if let Some(name) = raw.strip_prefix('/') {
            let name = name
                .split_whitespace()
                .next()
                .unwrap_or("")
                .to_ascii_lowercase();
            if let Some(position) = stack.iter().rposition(|element| element.tag == name) {
                while stack.len() > position {
                    let child = stack.pop().unwrap_or_else(|| Element {
                        tag: "root".to_string(),
                        attrs: Vec::new(),
                        children: Vec::new(),
                    });
                    if let Some(parent) = stack.last_mut() {
                        parent.children.push(Node::Element(child));
                    }
                }
            }
            continue;
        }
        let self_closing = raw.ends_with('/');
        let (tag, attrs) = tag_parts(raw.trim_end_matches('/').trim());
        if tag.is_empty() {
            continue;
        }
        if matches!(tag.as_str(), "script" | "style" | "template" | "noscript") {
            if !self_closing {
                let Some(end) = rest.to_ascii_lowercase().find(&format!("</{tag}")) else {
                    break;
                };
                rest = &rest[end..];
            }
            continue;
        }
        let element = Element {
            tag: tag.clone(),
            attrs,
            children: Vec::new(),
        };
        if self_closing || is_void(&tag) {
            if let Some(parent) = stack.last_mut() {
                parent.children.push(Node::Element(element));
            }
        } else {
            stack.push(element);
        }
    }
    while stack.len() > 1 {
        let child = stack.pop().unwrap_or_else(|| Element {
            tag: "root".to_string(),
            attrs: Vec::new(),
            children: Vec::new(),
        });
        if let Some(parent) = stack.last_mut() {
            parent.children.push(Node::Element(child));
        }
    }
    root = stack.pop().unwrap_or_else(|| Element {
        tag: "root".to_string(),
        attrs: Vec::new(),
        children: Vec::new(),
    });
    root
}

fn append_text(parent: Option<&mut Element>, text: &str) {
    if !text.is_empty()
        && let Some(parent) = parent
    {
        parent.children.push(Node::Text(decode_entities(text)));
    }
}

fn tag_parts(raw: &str) -> (String, Vec<(String, String)>) {
    let mut parts = raw.splitn(2, char::is_whitespace);
    let tag = parts.next().unwrap_or("").to_ascii_lowercase();
    let mut attrs = Vec::new();
    let mut rest = parts.next().unwrap_or("").trim();
    while !rest.is_empty() {
        rest = rest.trim_start();
        let Some(eq) = rest.find(|c: char| c.is_whitespace() || c == '=') else {
            attrs.push((rest.to_ascii_lowercase(), String::new()));
            break;
        };
        let name = rest[..eq].to_ascii_lowercase();
        rest = rest[eq..].trim_start();
        if let Some(value) = rest.strip_prefix('=') {
            rest = value.trim_start();
            let (value, remaining) =
                if let Some(quote) = rest.chars().next().filter(|c| *c == '\'' || *c == '"') {
                    let body = &rest[1..];
                    body.find(quote)
                        .map_or((body, ""), |end| (&body[..end], &body[end + 1..]))
                } else {
                    rest.find(char::is_whitespace)
                        .map_or((rest, ""), |end| (&rest[..end], &rest[end..]))
                };
            attrs.push((name, decode_entities(value)));
            rest = remaining;
        } else {
            attrs.push((name, String::new()));
        }
    }
    (tag, attrs)
}

fn is_void(tag: &str) -> bool {
    matches!(
        tag,
        "area"
            | "base"
            | "br"
            | "col"
            | "embed"
            | "hr"
            | "img"
            | "input"
            | "link"
            | "meta"
            | "param"
            | "source"
            | "track"
            | "wbr"
    )
}

fn html_blocks(node: &Node, out: &mut Vec<Block>) {
    let Node::Element(element) = node else { return };
    match element.tag.as_str() {
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
            let level = HeadingLevel::clamped(element.tag[1..].parse().unwrap_or(1));
            out.push(Block::new(BlockKind::Heading {
                level,
                content: html_inlines(&element.children),
            }));
        }
        "p" | "dt" | "dd" => {
            let content = html_inlines(&element.children);
            if !content.is_empty() {
                out.push(Block::new(BlockKind::Paragraph(content)));
            }
        }
        "pre" => out.push(Block::new(BlockKind::CodeBlock {
            lang: None,
            code: plain_text(&element.children),
        })),
        "hr" => out.push(Block::new(BlockKind::Divider)),
        "blockquote" => {
            let mut inner = Vec::new();
            for child in &element.children {
                html_blocks(child, &mut inner);
            }
            if !inner.is_empty() {
                out.push(Block::new(BlockKind::Blockquote(inner)));
            }
        }
        "ul" | "ol" => {
            let items = element
                .children
                .iter()
                .filter_map(|child| {
                    let Node::Element(item) = child else {
                        return None;
                    };
                    if item.tag != "li" {
                        return None;
                    }
                    let mut content = Vec::new();
                    let mut inline_run = Vec::new();
                    for child in &item.children {
                        if matches!(child, Node::Element(element) if is_block_element(&element.tag))
                        {
                            push_inline_block(&mut content, &mut inline_run);
                            html_blocks(child, &mut content);
                        } else {
                            inline_run.push(child.clone());
                        }
                    }
                    push_inline_block(&mut content, &mut inline_run);
                    Some(ListItem {
                        task: None,
                        content,
                    })
                })
                .collect();
            out.push(Block::new(BlockKind::List(List {
                ordered: element.tag == "ol",
                start: 1,
                items,
            })));
        }
        "html" | "body" | "main" | "article" | "section" | "div" | "header" | "footer" | "nav"
        | "root" => {
            for child in &element.children {
                html_blocks(child, out);
            }
        }
        "head" => {}
        _ => {
            let content = html_inlines(&element.children);
            if !content.is_empty() {
                out.push(Block::new(BlockKind::Paragraph(content)));
            }
        }
    }
}

fn is_block_element(tag: &str) -> bool {
    matches!(
        tag,
        "address"
            | "article"
            | "aside"
            | "blockquote"
            | "div"
            | "dl"
            | "fieldset"
            | "footer"
            | "form"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "header"
            | "hr"
            | "main"
            | "nav"
            | "ol"
            | "p"
            | "pre"
            | "section"
            | "table"
            | "ul"
    )
}

fn push_inline_block(content: &mut Vec<Block>, inline_run: &mut Vec<Node>) {
    let inline = html_inlines(inline_run);
    inline_run.clear();
    if !inline.is_empty() {
        content.push(Block::new(BlockKind::Paragraph(inline)));
    }
}

fn html_inlines(nodes: &[Node]) -> Vec<Inline> {
    let mut out = Vec::new();
    for node in nodes {
        match node {
            Node::Text(text) => push_text(&mut out, text),
            Node::Element(element) => match element.tag.as_str() {
                "br" => out.push(Inline::HardBreak),
                "strong" | "b" => out.push(Inline::Strong(html_inlines(&element.children))),
                "em" | "i" => out.push(Inline::Emphasis(html_inlines(&element.children))),
                "del" | "s" | "strike" => {
                    out.push(Inline::Strikethrough(html_inlines(&element.children)))
                }
                "code" => out.push(Inline::Code(plain_text(&element.children))),
                "a" => out.push(Inline::Link {
                    dest: attr(element, "href").unwrap_or_default(),
                    title: attr(element, "title"),
                    content: html_inlines(&element.children),
                }),
                "img" => out.push(Inline::Image {
                    dest: attr(element, "src").unwrap_or_default(),
                    alt: attr(element, "alt").unwrap_or_default(),
                }),
                _ => out.extend(html_inlines(&element.children)),
            },
        }
    }
    out
}

fn push_text(out: &mut Vec<Inline>, text: &str) {
    if text.is_empty() {
        return;
    }
    if let Some(Inline::Text(previous)) = out.last_mut() {
        previous.push_str(text);
    } else {
        out.push(Inline::Text(text.to_string()));
    }
}

fn plain_text(nodes: &[Node]) -> String {
    let mut out = String::new();
    for node in nodes {
        match node {
            Node::Text(text) => out.push_str(text),
            Node::Element(element) => out.push_str(&plain_text(&element.children)),
        }
    }
    out
}

fn attr(element: &Element, name: &str) -> Option<String> {
    element
        .attrs
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.clone())
}

fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        let Some(end) = rest[start..].find(';') else {
            out.push_str(&rest[start..]);
            break;
        };
        let entity = &rest[start + 1..start + end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" | "#39" => Some('\''),
            "nbsp" => Some(' '),
            _ if entity.starts_with("#x") => u32::from_str_radix(&entity[2..], 16)
                .ok()
                .and_then(char::from_u32),
            _ if entity.starts_with('#') => entity[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        };
        if let Some(decoded) = decoded {
            out.push(decoded);
            rest = &rest[start + end + 1..];
        } else {
            out.push('&');
            rest = &rest[start + 1..];
        }
    }
    out.push_str(rest);
    out
}

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
