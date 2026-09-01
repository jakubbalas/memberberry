use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use mb_core::frontmatter::{Frontmatter, YamlValue};
use mb_core::model::{
    Alignment, Anchor, Block, BlockKind, Callout, Document, Fold, Inline, List, Table, WikiLink,
};
use mb_core::task::{Priority, Task, TaskStatus};
use yrs::types::Attrs;
use yrs::{
    Any, Doc, Map, ReadTxn, StateVector, Text, Transact, WriteTxn, Xml, XmlElementPrelim,
    XmlElementRef, XmlFragment, XmlTextPrelim,
};

use crate::decode::CrdtError;
use crate::{FRONTMATTER_ROOT, PROSEMIRROR_ROOT};

/// Creates a Y document in the exact XML shape consumed by `y-prosemirror`.
///
/// # Errors
///
/// Returns [`CrdtError::InvalidBlockDocument`] when `document` cannot be represented by
/// `schema.json`.
pub fn document_to_yrs(document: &Document) -> Result<Doc, CrdtError> {
    document_to_yrs_in(document, Doc::new())
}

pub(crate) fn document_to_yrs_in(document: &Document, doc: Doc) -> Result<Doc, CrdtError> {
    mb_core::schema::validate(document)
        .map_err(|errors| CrdtError::invalid_document(errors.as_slice()))?;

    let mut txn = doc.transact_mut();
    let fragment = txn.get_or_insert_xml_fragment(PROSEMIRROR_ROOT);
    let frontmatter = txn.get_or_insert_map(FRONTMATTER_ROOT);

    write_frontmatter(&frontmatter, &mut txn, &document.frontmatter);
    if document.blocks.is_empty() {
        fragment.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
    } else {
        write_blocks(&fragment, &mut txn, &document.blocks);
    }
    drop(txn);
    Ok(doc)
}

/// Encodes a complete document state as a lib0 v1 update, compatible with Yjs.
#[must_use]
pub fn encode_update_v1(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

fn write_frontmatter(target: &yrs::MapRef, txn: &mut yrs::TransactionMut<'_>, fm: &Frontmatter) {
    for (key, value) in frontmatter_entries(fm) {
        target.insert(txn, key, value);
    }
}

pub(crate) fn frontmatter_entries(fm: &Frontmatter) -> BTreeMap<String, Any> {
    let mut entries = BTreeMap::new();
    insert_optional(&mut entries, "id", &fm.id);
    insert_optional(&mut entries, "created", &fm.created);
    insert_optional(&mut entries, "updated", &fm.updated);
    if !fm.tags.is_empty() {
        entries.insert("tags".to_string(), string_array(&fm.tags));
    }
    if !fm.aliases.is_empty() {
        entries.insert("aliases".to_string(), string_array(&fm.aliases));
    }
    insert_optional(&mut entries, "icon", &fm.icon);

    for (key, value) in &fm.extra {
        let encoded = match value {
            YamlValue::Scalar(value) => Any::from(value.as_str()),
            YamlValue::List(values) => string_array(values),
            YamlValue::Raw(lines) => {
                let fields = HashMap::from([
                    ("$memberberry".to_string(), Any::from("raw")),
                    ("lines".to_string(), string_array(lines)),
                ]);
                Any::Map(Arc::new(fields))
            }
        };
        entries.insert(key.clone(), encoded);
    }
    entries
}

fn insert_optional(target: &mut BTreeMap<String, Any>, key: &str, value: &Option<String>) {
    if let Some(value) = value {
        target.insert(key.to_string(), Any::from(value.as_str()));
    }
}

fn string_array(values: &[String]) -> Any {
    Any::Array(
        values
            .iter()
            .map(|value| Any::from(value.as_str()))
            .collect::<Vec<_>>()
            .into(),
    )
}

fn write_blocks<P: XmlFragment>(parent: &P, txn: &mut yrs::TransactionMut<'_>, blocks: &[Block]) {
    for block in blocks {
        write_block(parent, txn, block);
    }
}

fn write_block<P: XmlFragment>(parent: &P, txn: &mut yrs::TransactionMut<'_>, block: &Block) {
    insert_block(parent, txn, parent.len(txn), block);
}

pub(crate) fn insert_block<P: XmlFragment>(
    parent: &P,
    txn: &mut yrs::TransactionMut<'_>,
    index: u32,
    block: &Block,
) {
    let element = parent.insert(
        txn,
        index,
        XmlElementPrelim::empty(mb_core::schema::block_node(&block.kind).name()),
    );
    match &block.kind {
        BlockKind::Paragraph(content) => write_inlines(&element, txn, content, Attrs::new()),
        BlockKind::Heading { level, content } => {
            element.insert_attribute(txn, "level", Any::Number(f64::from(level.get())));
            write_inlines(&element, txn, content, Attrs::new());
        }
        BlockKind::List(list) => write_list(&element, txn, list),
        BlockKind::Blockquote(content) => write_blocks(&element, txn, content),
        BlockKind::Callout(callout) => write_callout(&element, txn, callout),
        BlockKind::CodeBlock { lang, code } => {
            set_optional_attr(&element, txn, "lang", lang);
            write_plain_text(&element, txn, code);
        }
        BlockKind::Divider => {}
        BlockKind::Table(table) => write_table(&element, txn, table),
        BlockKind::MathBlock(value) => write_plain_text(&element, txn, value),
    }
    set_optional_attr(&element, txn, "anchor", &block.anchor);
}

fn write_list(parent: &XmlElementRef, txn: &mut yrs::TransactionMut<'_>, list: &List) {
    if list.ordered {
        parent.insert_attribute(txn, "start", Any::Number(list.start as f64));
    }
    for item in &list.items {
        let node = mb_core::schema::list_item_node(item);
        let element = parent.push_back(txn, XmlElementPrelim::empty(node.name()));
        if let Some(task) = &item.task {
            write_task_attrs(&element, txn, task);
        }
        write_blocks(&element, txn, &item.content);
    }
}

fn write_task_attrs(element: &XmlElementRef, txn: &mut yrs::TransactionMut<'_>, task: &Task) {
    element.insert_attribute(txn, "status", status_name(task.status));
    set_priority_attr(element, txn, task.meta.priority);
    set_date_attr(element, txn, "created", task.meta.created);
    set_date_attr(element, txn, "start", task.meta.start);
    set_date_attr(element, txn, "scheduled", task.meta.scheduled);
    set_date_attr(element, txn, "due", task.meta.due);
    set_date_attr(element, txn, "done", task.meta.done);
    set_date_attr(element, txn, "cancelled", task.meta.cancelled);
    element.insert_attribute(txn, "unknown", string_array(&task.meta.unknown));
}

fn status_name(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Todo => "todo",
        TaskStatus::Done => "done",
        TaskStatus::Cancelled => "cancelled",
    }
}

fn set_priority_attr(
    element: &XmlElementRef,
    txn: &mut yrs::TransactionMut<'_>,
    priority: Option<Priority>,
) {
    let value = priority.map(|value| match value {
        Priority::Lowest => "lowest",
        Priority::Low => "low",
        Priority::Medium => "medium",
        Priority::High => "high",
        Priority::Highest => "highest",
    });
    element.insert_attribute(txn, "priority", value.map_or(Any::Null, Any::from));
}

fn set_date_attr(
    element: &XmlElementRef,
    txn: &mut yrs::TransactionMut<'_>,
    key: &str,
    date: Option<mb_core::task::Date>,
) {
    element.insert_attribute(
        txn,
        key,
        date.map_or(Any::Null, |value| Any::from(value.to_string())),
    );
}

fn write_callout(parent: &XmlElementRef, txn: &mut yrs::TransactionMut<'_>, callout: &Callout) {
    parent.insert_attribute(txn, "kind", callout.kind.as_str());
    parent.insert_attribute(
        txn,
        "fold",
        match callout.fold {
            Fold::None => "none",
            Fold::Expanded => "expanded",
            Fold::Collapsed => "collapsed",
        },
    );
    let title = parent.push_back(txn, XmlElementPrelim::empty("callout_title"));
    write_inlines(&title, txn, &callout.title, Attrs::new());
    write_blocks(parent, txn, &callout.content);
}

fn write_table(parent: &XmlElementRef, txn: &mut yrs::TransactionMut<'_>, table: &Table) {
    parent.insert_attribute(
        txn,
        "alignments",
        Any::Array(
            table
                .alignments
                .iter()
                .map(|alignment| {
                    Any::from(match alignment {
                        Alignment::None => "none",
                        Alignment::Left => "left",
                        Alignment::Center => "center",
                        Alignment::Right => "right",
                    })
                })
                .collect::<Vec<_>>()
                .into(),
        ),
    );
    write_table_row(parent, txn, &table.head);
    for row in &table.rows {
        write_table_row(parent, txn, row);
    }
}

fn write_table_row(parent: &XmlElementRef, txn: &mut yrs::TransactionMut<'_>, row: &[Vec<Inline>]) {
    let row_element = parent.push_back(txn, XmlElementPrelim::empty("table_row"));
    for cell in row {
        let cell_element = row_element.push_back(txn, XmlElementPrelim::empty("table_cell"));
        write_inlines(&cell_element, txn, cell, Attrs::new());
    }
}

fn write_plain_text(parent: &XmlElementRef, txn: &mut yrs::TransactionMut<'_>, value: &str) {
    if !value.is_empty() {
        parent.push_back(txn, XmlTextPrelim::new(value));
    }
}

fn write_inlines<P: XmlFragment>(
    parent: &P,
    txn: &mut yrs::TransactionMut<'_>,
    inlines: &[Inline],
    attrs: Attrs,
) {
    for inline in inlines {
        write_inline(parent, txn, inline, attrs.clone());
    }
}

fn write_inline<P: XmlFragment>(
    parent: &P,
    txn: &mut yrs::TransactionMut<'_>,
    inline: &Inline,
    mut attrs: Attrs,
) {
    match inline {
        Inline::Text(value) => write_marked_text(parent, txn, value, attrs),
        Inline::Emphasis(content) => {
            attrs.insert("em".into(), empty_object());
            write_inlines(parent, txn, content, attrs);
        }
        Inline::Strong(content) => {
            attrs.insert("strong".into(), empty_object());
            write_inlines(parent, txn, content, attrs);
        }
        Inline::Strikethrough(content) => {
            attrs.insert("strikethrough".into(), empty_object());
            write_inlines(parent, txn, content, attrs);
        }
        Inline::Highlight(content) => {
            attrs.insert("highlight".into(), empty_object());
            write_inlines(parent, txn, content, attrs);
        }
        Inline::Code(value) => {
            attrs.insert("code".into(), empty_object());
            write_marked_text(parent, txn, value, attrs);
        }
        Inline::Link {
            dest,
            title,
            content,
        } => {
            let fields = HashMap::from([
                ("href".to_string(), Any::from(dest.as_str())),
                (
                    "title".to_string(),
                    title.as_deref().map_or(Any::Null, Any::from),
                ),
            ]);
            attrs.insert("link".into(), Any::Map(Arc::new(fields)));
            write_inlines(parent, txn, content, attrs);
        }
        Inline::Math(value) => write_atom(
            parent,
            txn,
            "inline_math",
            &[("value", Any::from(value.as_str()))],
        ),
        Inline::Image { dest, alt } => write_atom(
            parent,
            txn,
            "image",
            &[
                ("dest", Any::from(dest.as_str())),
                ("alt", Any::from(alt.as_str())),
            ],
        ),
        Inline::WikiLink(link) => write_wikilink(parent, txn, link),
        Inline::Tag(name) => write_atom(parent, txn, "tag", &[("name", Any::from(name.as_str()))]),
        Inline::Emoji(shortcode) => write_atom(
            parent,
            txn,
            "emoji",
            &[("shortcode", Any::from(shortcode.as_str()))],
        ),
        Inline::FootnoteRef(label) => write_atom(
            parent,
            txn,
            "footnote_ref",
            &[("label", Any::from(label.as_str()))],
        ),
        Inline::SoftBreak => write_atom(parent, txn, "soft_break", &[]),
        Inline::HardBreak => write_atom(parent, txn, "hard_break", &[]),
    }
}

fn write_marked_text<P: XmlFragment>(
    parent: &P,
    txn: &mut yrs::TransactionMut<'_>,
    value: &str,
    attrs: Attrs,
) {
    if value.is_empty() {
        return;
    }
    let text = parent.push_back(txn, XmlTextPrelim::new(""));
    if attrs.is_empty() {
        text.push(txn, value);
    } else {
        text.insert_with_attributes(txn, 0, value, attrs);
    }
}

fn empty_object() -> Any {
    Any::Map(Arc::new(HashMap::new()))
}

fn write_atom<P: XmlFragment>(
    parent: &P,
    txn: &mut yrs::TransactionMut<'_>,
    tag: &str,
    attrs: &[(&str, Any)],
) {
    let element = parent.push_back(txn, XmlElementPrelim::empty(tag));
    for (key, value) in attrs {
        element.insert_attribute(txn, *key, value.clone());
    }
}

fn write_wikilink<P: XmlFragment>(parent: &P, txn: &mut yrs::TransactionMut<'_>, link: &WikiLink) {
    let (kind, text) = match &link.anchor {
        None => ("none", None),
        Some(Anchor::Heading(value)) => ("heading", Some(value.as_str())),
        Some(Anchor::Block(value)) => ("block", Some(value.as_str())),
    };
    write_atom(
        parent,
        txn,
        "wikilink",
        &[
            ("target", Any::from(link.target.as_str())),
            ("anchor_kind", Any::from(kind)),
            ("anchor_text", text.map_or(Any::Null, Any::from)),
            ("alias", link.alias.as_deref().map_or(Any::Null, Any::from)),
            ("embed", Any::Bool(link.embed)),
        ],
    );
}

fn set_optional_attr(
    element: &XmlElementRef,
    txn: &mut yrs::TransactionMut<'_>,
    key: &str,
    value: &Option<String>,
) {
    element.insert_attribute(txn, key, value.as_deref().map_or(Any::Null, Any::from));
}
