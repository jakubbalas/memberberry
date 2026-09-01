//! # mb-wasm
//!
//! The browser's only route to the block model (`SPEC.md` §5.3).
//!
//! Everything here is a thin wrapper. That is the point: §5.2 argues that one Rust crate
//! compiled both natively and to `wasm32` is what guarantees the client and the server can
//! never disagree about what a note means. A convenience reimplemented in TypeScript would
//! be exactly the divergence this crate exists to prevent, so nothing is reimplemented —
//! the JavaScript side calls in for anything that touches Markdown.
//!
//! ## What is here for M0
//!
//! Enough to prove the pipeline: parse, canonical serialize, render, and the structured
//! facts the index is built from. `mb-crdt` and `mb-search` join later (§5.3), and the
//! surface grows with them rather than being stubbed now.

use serde::Serialize;
use wasm_bindgen::prelude::*;

/// Materializes a lib0 v1 CRDT update into canonical Markdown.
///
/// This is the source-view and copy boundary: TypeScript may handle a Yjs update, but only
/// the Rust block model may turn it into note text (SPEC.md §5.2).
///
/// # Errors
///
/// Returns a JavaScript error when the update is malformed or schema-incompatible.
#[wasm_bindgen(js_name = "markdownFromUpdate")]
pub fn markdown_from_update(update: &[u8]) -> Result<String, JsValue> {
    markdown_from_update_inner(update).map_err(|error| JsValue::from_str(&error.to_string()))
}

/// Rust-native implementation of [`markdown_from_update`], exposed for non-WASM tests.
///
/// # Errors
///
/// Returns [`mb_crdt::CrdtError`] when the update is malformed or invalid.
pub fn markdown_from_update_inner(update: &[u8]) -> Result<String, mb_crdt::CrdtError> {
    let document = mb_crdt::document_from_update_v1(update)
        .and_then(|document| mb_crdt::document_from_yrs(&document))?;
    Ok(mb_core::to_markdown(&document))
}

/// Converts Markdown into a lib0 v1 CRDT update for the editor's source mode.
///
/// The returned update is decoded by `y-prosemirror` before replacing the active editor
/// document, so both directions use exactly the same Rust parser and serializer.
///
/// # Errors
///
/// Returns a JavaScript error only when the parsed Markdown cannot be represented by the
/// shared CRDT schema.
#[wasm_bindgen(js_name = "updateFromMarkdown")]
pub fn update_from_markdown(markdown: &str) -> Result<Vec<u8>, JsValue> {
    update_from_markdown_inner(markdown).map_err(|error| JsValue::from_str(&error.to_string()))
}

/// Rust-native implementation of [`update_from_markdown`], exposed for non-WASM tests.
///
/// # Errors
///
/// Returns [`mb_crdt::CrdtError`] when the parsed document is not schema-valid.
pub fn update_from_markdown_inner(markdown: &str) -> Result<Vec<u8>, mb_crdt::CrdtError> {
    let document = mb_core::parse(markdown);
    let crdt = mb_crdt::document_to_yrs(&document)?;
    Ok(mb_crdt::encode_update_v1(&crdt))
}

/// Rewrites Markdown into its canonical form (`SPEC.md` §4.5).
///
/// The same function the server and `memberberry normalize` run, so a source view in the
/// browser shows exactly what will be written to disk.
#[wasm_bindgen]
#[must_use]
pub fn normalize(markdown: &str) -> String {
    mb_core::normalize(markdown)
}

/// Renders Markdown to an HTML fragment.
///
/// `note_prefix` and `media_prefix` are prepended to wikilink targets and relative media
/// destinations; pass empty strings for relative links. Escaping is `mb_core::html`'s, so
/// note content cannot inject markup here any more than it can on the server.
#[wasm_bindgen(js_name = "toHtml")]
#[must_use]
pub fn to_html(markdown: &str, note_prefix: &str, media_prefix: &str) -> String {
    mb_core::html::document(
        &mb_core::parse(markdown),
        &mb_core::html::Urls {
            note: note_prefix,
            media: media_prefix,
        },
    )
}

/// The note's title: its first H1, else the first heading, else the opening paragraph.
#[wasm_bindgen(js_name = "noteTitle")]
#[must_use]
pub fn note_title(markdown: &str) -> Option<String> {
    mb_core::extract::title(&mb_core::parse(markdown))
}

/// What the index is built from (`SPEC.md` §9.1), as a plain JavaScript object.
///
/// A flat, owned shape rather than a handle into wasm memory: the caller gets a value it can
/// hold, structured-clone into a worker, and compare — with no lifetime tied to this module.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Facts {
    pub title: Option<String>,
    pub links: Vec<Link>,
    pub tags: Vec<String>,
    pub emoji: Vec<String>,
    pub anchors: Vec<String>,
    pub media: Vec<String>,
    pub tasks: Vec<Task>,
    pub headings: Vec<Heading>,
    pub word_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub target: String,
    pub anchor: Option<String>,
    pub alias: Option<String>,
    pub embed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    /// `todo`, `done` or `cancelled`.
    pub status: String,
    pub text: String,
    pub due: Option<String>,
    pub anchor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Heading {
    pub level: u8,
    pub text: String,
}

/// Extracts links, tags, tasks, anchors, media and headings from Markdown.
///
/// # Errors
///
/// Returns a JavaScript error only if the result cannot be converted, which the flat shape
/// above makes impossible in practice.
#[wasm_bindgen]
pub fn extract(markdown: &str) -> Result<JsValue, JsValue> {
    // why: `serialize_missing_as_null`. By default `serde-wasm-bindgen` turns `None` into
    // `undefined`, so `facts.title` would be absent rather than null and every TypeScript
    // signature would have to say `| undefined` as well. An explicit `null` is a narrower
    // contract and matches what `web/src/notes.ts` declares. Caught by the boundary test.
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_missing_as_null(true);
    facts_of(markdown)
        .serialize(&serializer)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

/// The mapping behind [`extract`], separated from the JavaScript boundary.
///
/// Split out so it can be tested natively: `JsValue` needs a JavaScript context, but the
/// shape of what crosses the boundary is ordinary logic and deserves ordinary tests. What
/// remains in `extract` is three lines that cannot be wrong quietly.
#[must_use]
pub fn facts_of(markdown: &str) -> Facts {
    let doc = mb_core::parse(markdown);
    let facts = mb_core::extract(&doc);
    Facts {
        title: mb_core::extract::title(&doc),
        links: facts
            .links
            .iter()
            .map(|l| Link {
                target: l.target.clone(),
                anchor: l.anchor.as_ref().map(|a| match a {
                    mb_core::model::Anchor::Heading(h) => h.clone(),
                    mb_core::model::Anchor::Block(b) => b.clone(),
                }),
                alias: l.alias.clone(),
                embed: l.embed,
            })
            .collect(),
        tags: facts.tags.clone(),
        emoji: facts.emoji.clone(),
        anchors: facts.anchors.clone(),
        media: facts.media.clone(),
        tasks: facts
            .tasks
            .iter()
            .map(|t| Task {
                status: match t.task.status {
                    mb_core::task::TaskStatus::Todo => "todo",
                    mb_core::task::TaskStatus::Done => "done",
                    mb_core::task::TaskStatus::Cancelled => "cancelled",
                }
                .to_string(),
                text: t.text.clone(),
                due: t.task.meta.due.map(|d| d.to_string()),
                anchor: t.anchor.clone(),
            })
            .collect(),
        headings: facts
            .headings
            .iter()
            .map(|(level, text)| Heading {
                level: *level,
                text: text.clone(),
            })
            .collect(),
        word_count: facts.word_count,
    }
}

/// The ProseMirror schema contract (`SPEC.md` §5.6), as JSON.
///
/// M3 generates the Tiptap schema from this rather than hand-writing one, which is what
/// stops the editor and the serializer drifting apart.
#[wasm_bindgen(js_name = "schemaJson")]
#[must_use]
pub fn schema_json() -> String {
    include_str!("../../mb-core/schema.json").to_string()
}
