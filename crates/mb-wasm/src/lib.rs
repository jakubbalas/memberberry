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

/// Converts clipped HTML to canonical Markdown through `mb-core`.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = "htmlToMarkdown")]
pub fn html_to_markdown(html: &str) -> String {
    html_to_markdown_inner(html)
}

/// Native HTML conversion implementation, separated for boundary tests.
#[must_use]
pub fn html_to_markdown_inner(html: &str) -> String {
    mb_core::to_markdown(&mb_core::from_html(html))
}

/// Formats a daily-note path through the same contract used by the server.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = "dailyPath")]
pub fn daily_path(folder: &str, format: &str, date: &str) -> Result<String, JsValue> {
    daily_path_inner(folder, format, date).map_err(js_err)
}

/// Native daily-path implementation, testable without JavaScript values.
pub fn daily_path_inner(folder: &str, format: &str, date: &str) -> Result<String, &'static str> {
    let date = mb_core::task::Date::parse(date).ok_or("invalid date")?;
    mb_core::daily::path(folder, format, date).ok_or("invalid daily-note configuration")
}

/// Formats a daily, weekly, or monthly note path through the shared calendar contract.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = "periodicPath")]
pub fn periodic_path(
    period: &str,
    folder: &str,
    format: &str,
    date: &str,
) -> Result<String, JsValue> {
    periodic_path_inner(period, folder, format, date).map_err(js_err)
}

/// Native periodic-path implementation, testable without JavaScript values.
pub fn periodic_path_inner(
    period: &str,
    folder: &str,
    format: &str,
    date: &str,
) -> Result<String, &'static str> {
    let period = match period {
        "daily" => mb_core::daily::Period::Daily,
        "weekly" => mb_core::daily::Period::Weekly,
        "monthly" => mb_core::daily::Period::Monthly,
        _ => return Err("invalid calendar period"),
    };
    let date = mb_core::task::Date::parse(date).ok_or("invalid date")?;
    mb_core::daily::periodic_path(period, folder, format, date)
        .ok_or("invalid calendar-note configuration")
}

/// Expands a template using caller-supplied values, keeping date/time and UUID generation out
/// of the browser boundary.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = "expandTemplate")]
pub fn expand_template(
    template: &str,
    date: &str,
    time: &str,
    title: &str,
    selection: &str,
    uuid: &str,
    user: &str,
) -> Result<JsValue, JsValue> {
    let expanded = expand_template_inner(template, date, time, title, selection, uuid, user)
        .map_err(js_err)?;
    serde_wasm_bindgen::to_value(&expanded).map_err(js_err)
}

/// Native template-expansion implementation, testable without JavaScript values.
pub fn expand_template_inner(
    template: &str,
    date: &str,
    time: &str,
    title: &str,
    selection: &str,
    uuid: &str,
    user: &str,
) -> Result<ExpandedTemplate, &'static str> {
    let date = mb_core::task::Date::parse(date).ok_or("invalid date")?;
    let mut time_parts = time.split(':').map(|part| part.parse::<u8>());
    let parsed_time = (
        time_parts.next().transpose().map_err(|_| "invalid time")?,
        time_parts.next().transpose().map_err(|_| "invalid time")?,
        time_parts.next().transpose().map_err(|_| "invalid time")?,
    );
    if parsed_time.0.is_none()
        || parsed_time.1.is_none()
        || parsed_time.2.is_none()
        || time_parts.next().is_some()
        || parsed_time.0.is_some_and(|hour| hour > 23)
        || parsed_time.1.is_some_and(|minute| minute > 59)
        || parsed_time.2.is_some_and(|second| second > 59)
    {
        return Err("invalid time");
    }
    let expanded = mb_core::template::expand(
        template,
        mb_core::template::Context {
            date,
            time: (
                parsed_time.0.unwrap_or(0),
                parsed_time.1.unwrap_or(0),
                parsed_time.2.unwrap_or(0),
            ),
            title,
            selection,
            uuid,
            user,
        },
    );
    Ok(ExpandedTemplate {
        text: expanded.text,
        cursor: expanded.cursor,
    })
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ExpandedTemplate {
    /// Expanded UTF-8 template text.
    pub text: String,
    /// Byte offset for the first cursor marker.
    pub cursor: Option<usize>,
}

/// Validates a compact client-search segment before the browser persists it (§14.2, E6).
///
/// # Errors
///
/// Returns a JavaScript error when the binary is truncated, corrupt, or from an unsupported
/// format version.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = validateSearchSegment)]
pub fn validate_search_segment(bytes: &[u8]) -> Result<(), JsValue> {
    validate_search_segment_inner(bytes).map_err(js_err)
}

/// Rust-native compact-segment validation, separated so it can be tested without `JsValue`.
///
/// # Errors
///
/// Returns the compact-index validation error unchanged.
pub fn validate_search_segment_inner(bytes: &[u8]) -> Result<(), mb_search::Error> {
    mb_search::Segment::from_bytes(bytes.to_vec()).map(|_| ())
}

/// Merges an older compact segment with a newer delta for the same ACL epoch (§14.2).
///
/// # Errors
///
/// Returns a JavaScript error when either binary is invalid or their zone/ACL identities
/// differ. In particular, a revoked epoch can never be merged into its replacement.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = mergeSearchSegments)]
pub fn merge_search_segments(base: &[u8], delta: &[u8]) -> Result<Vec<u8>, JsValue> {
    merge_search_segments_inner(base, delta).map_err(js_err)
}

/// Rust-native compact segment merge, separated so it can be tested without `JsValue`.
///
/// # Errors
///
/// Returns validation or merge errors from `mb-search` unchanged.
pub fn merge_search_segments_inner(base: &[u8], delta: &[u8]) -> Result<Vec<u8>, mb_search::Error> {
    let base = mb_search::Segment::from_bytes(base.to_vec())?;
    let delta = mb_search::Segment::from_bytes(delta.to_vec())?;
    mb_search::Segment::merge(&[base, delta]).map(|segment| segment.as_bytes().to_vec())
}

/// One compact-index result sent back to the search worker.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// Vault-relative note path.
    pub path: String,
    /// Display title, possibly empty for an untitled note.
    pub title: String,
    /// The compact index's retained note context.
    pub snippet: String,
    /// Tags attached to the result note.
    pub tags: Vec<String>,
    /// Optional note icon.
    pub icon: Option<String>,
}

/// The union of a browser's permitted compact-index segments.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchSegmentResults {
    /// Matching notes, ordered by vault-relative path.
    pub hits: Vec<SearchHit>,
    /// Whether quoted phrases used the documented offline AND fallback.
    pub phrase_degraded: bool,
}

/// Queries already-authorized compact segments in the browser (§14.2).
///
/// The caller owns authorization: only bytes retained after the manifest reconciliation may
/// cross this boundary. Parsing every segment here still matters, because a worker message is
/// an untrusted boundary and no query may dereference unchecked offsets.
///
/// # Errors
///
/// Returns a query error or an error for an invalid segment.
pub fn search_segments_inner(
    query: &str,
    segments: impl IntoIterator<Item = Vec<u8>>,
) -> Result<SearchSegmentResults, mb_search::Error> {
    let query = mb_search::Query::parse(query)?;
    let mut hits = Vec::new();
    let mut phrase_degraded = false;
    for bytes in segments {
        let results = mb_search::Segment::from_bytes(bytes)?.search(&query)?;
        phrase_degraded |= results.phrase_degraded;
        hits.extend(results.hits.into_iter().map(|hit| SearchHit {
            path: hit.note.path,
            title: hit.note.title,
            snippet: hit.note.snippet,
            tags: hit.note.tags,
            icon: hit.note.icon,
        }));
    }
    hits.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(SearchSegmentResults {
        hits,
        phrase_degraded,
    })
}

/// JavaScript boundary for [`search_segments_inner`].
///
/// # Errors
///
/// Returns a JavaScript error for malformed wire values, invalid compact bytes or invalid
/// offline query syntax.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = querySearchSegments)]
pub fn query_search_segments(query: &str, segments: JsValue) -> Result<JsValue, JsValue> {
    let segments = serde_wasm_bindgen::from_value::<Vec<Vec<u8>>>(segments).map_err(js_err)?;
    let results = search_segments_inner(query, segments).map_err(js_err)?;
    results.serialize(&js_serializer()).map_err(js_err)
}

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
    markdown_from_update_inner(update).map_err(js_err)
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
    update_from_markdown_inner(markdown).map_err(js_err)
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

/// Merges an external version of a note into the local one, marking divergences (§3.5).
///
/// The client calls this when a reconnection brings a version of a note it also changed
/// while offline. Every version crosses as Markdown and the merged note comes out the same
/// way, so the block alignment and the callout it writes are `mb-core`'s — the same code the
/// server would run, which is the whole point of §5.2.
///
/// `base` is the Markdown this note had when the two sides were last in sync, and is what
/// tells a collision from an ordinary remote edit. `undefined` — a note this device has never
/// synced, or whose base was dropped with its body — degrades to the two-way comparison,
/// which keeps content and can therefore resurrect a deletion made elsewhere.
///
/// `stamp` is the caller's: `mb-core` has no clock.
#[wasm_bindgen(js_name = "mergeWithConflicts")]
#[must_use]
pub fn merge_with_conflicts(base: Option<String>, mine: &str, theirs: &str, stamp: &str) -> String {
    let base = base.map(|base| mb_core::parse(&base));
    mb_core::to_markdown(&mb_core::conflict::merge(
        base.as_ref(),
        &mb_core::parse(mine),
        &mb_core::parse(theirs),
        stamp,
    ))
}

/// How many unresolved conflict callouts a note carries (§3.5).
#[wasm_bindgen(js_name = "conflictCount")]
#[must_use]
pub fn conflict_count(markdown: &str) -> usize {
    mb_core::conflict::count(&mb_core::parse(markdown))
}

/// Resolves the `ordinal`-th unresolved conflict callout in a note (§3.5).
///
/// `ordinal` counts conflicts rather than blocks, because that is what the editor can say
/// without knowing how the note canonicalizes — see `mb_core::conflict::nth`.
///
/// `keep` is `"mine"`, `"theirs"` or `"both"`; anything else, or an ordinal past the last
/// conflict, returns the note unchanged. A reader clicks a button on a note that may have
/// moved on since it rendered, so a stale request has to be inert rather than destructive.
#[wasm_bindgen(js_name = "resolveConflict")]
#[must_use]
pub fn resolve_conflict(markdown: &str, ordinal: usize, keep: &str) -> String {
    let resolution = match keep {
        "mine" => mb_core::conflict::Resolution::Mine,
        "theirs" => mb_core::conflict::Resolution::Theirs,
        "both" => mb_core::conflict::Resolution::Both,
        _ => return markdown.to_string(),
    };
    let mut document = mb_core::parse(markdown);
    let Some(index) = mb_core::conflict::nth(&document.blocks, ordinal) else {
        return markdown.to_string();
    };
    document.blocks = mb_core::conflict::resolve(&document.blocks, index, resolution);
    mb_core::to_markdown(&document)
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
    facts_of(markdown)
        .serialize(&js_serializer())
        .map_err(js_err)
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
        // The boundary keeps anchors as bare ids: the text of an anchored block is for
        // the server index (§9.1 `blocks`), and no client surface reads it.
        anchors: facts
            .anchors
            .iter()
            .map(|block| block.anchor.clone())
            .collect(),
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

fn js_err(error: impl ToString) -> JsValue {
    JsValue::from_str(&error.to_string())
}

fn js_serializer() -> serde_wasm_bindgen::Serializer {
    serde_wasm_bindgen::Serializer::new().serialize_missing_as_null(true)
}
