use mb_core::frontmatter::{Frontmatter, YamlValue};
use mb_core::model::{
    Alignment, Anchor, Block, BlockKind, Callout, Document, Fold, HeadingLevel, Inline, List,
    ListItem, Table, WikiLink,
};
use mb_core::task::{Date, Priority, Task, TaskMeta, TaskStatus};
use thiserror::Error;
use yrs::types::Attrs;
use yrs::updates::decoder::Decode;
use yrs::{
    Any, Doc, Map, Out, ReadTxn, Text, Transact, Update, Xml, XmlElementRef, XmlFragment, XmlOut,
};

use crate::{FRONTMATTER_ROOT, PROSEMIRROR_ROOT};

/// A malformed or schema-incompatible Y document.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum CrdtError {
    /// The source block document is wider than the ProseMirror schema.
    #[error("block document is not schema-valid: {0}")]
    InvalidBlockDocument(String),
    /// The Y document does not match `schema.json`.
    #[error("malformed CRDT content at {path}: {reason}")]
    Malformed { path: String, reason: String },
    /// A lib0 update could not be decoded or applied.
    #[error("invalid Yjs v1 update: {0}")]
    InvalidUpdate(String),
}

impl CrdtError {
    pub(crate) fn invalid_document(errors: &[mb_core::schema::SchemaError]) -> Self {
        Self::InvalidBlockDocument(
            errors
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join("; "),
        )
    }
}

/// Materializes a block document from the `prosemirror` and `frontmatter` roots.
///
/// Unknown node names and malformed attributes fail closed. The returned document is also
/// checked against `mb_core::schema`, so invalid remote content never reaches serialization.
///
/// # Errors
///
/// Returns [`CrdtError`] if a root is absent or any content violates the shared schema.
pub fn document_from_yrs(doc: &Doc) -> Result<Document, CrdtError> {
    Ok(mb_core::canonicalize(document_from_yrs_raw(doc)?))
}

pub(crate) fn document_from_yrs_raw(doc: &Doc) -> Result<Document, CrdtError> {
    let txn = doc.transact();
    let fragment = txn
        .get_xml_fragment(PROSEMIRROR_ROOT)
        .ok_or_else(|| malformed(PROSEMIRROR_ROOT, "missing Y.XmlFragment root"))?;
    let frontmatter = txn
        .get_map(FRONTMATTER_ROOT)
        .ok_or_else(|| malformed(FRONTMATTER_ROOT, "missing Y.Map root"))?;

    let blocks = read_blocks(&fragment, &txn, "prosemirror")?;
    let document = Document {
        frontmatter: read_frontmatter(&frontmatter, &txn)?,
        blocks,
    };
    mb_core::schema::validate(&document)
        .map_err(|errors| CrdtError::invalid_document(errors.as_slice()))?;
    Ok(document)
}

/// Decodes and applies a complete or incremental lib0 v1 update to a fresh Y document.
///
/// # Errors
///
/// Returns [`CrdtError::InvalidUpdate`] for malformed wire data, or a schema error when the
/// update contains a malformed ProseMirror document.
pub fn document_from_update_v1(bytes: &[u8]) -> Result<Doc, CrdtError> {
    let update =
        Update::decode_v1(bytes).map_err(|error| CrdtError::InvalidUpdate(error.to_string()))?;
    let doc = Doc::new();
    // why: declaring the root types before applying avoids Yrs materializing remote roots as
    // `UndefinedRef` when a partial update reaches this replica before its first local access.
    doc.get_or_insert_xml_fragment(PROSEMIRROR_ROOT);
    doc.get_or_insert_map(FRONTMATTER_ROOT);
    doc.transact_mut()
        .apply_update(update)
        .map_err(|error| CrdtError::InvalidUpdate(error.to_string()))?;
    document_from_yrs(&doc)?;
    Ok(doc)
}

fn malformed(path: impl Into<String>, reason: impl Into<String>) -> CrdtError {
    CrdtError::Malformed {
        path: path.into(),
        reason: reason.into(),
    }
}

fn read_frontmatter<T: ReadTxn>(map: &yrs::MapRef, txn: &T) -> Result<Frontmatter, CrdtError> {
    let mut fm = Frontmatter::default();
    for (key, value) in map.iter(txn) {
        let path = format!("frontmatter.{key}");
        let Out::Any(value) = value else {
            return Err(malformed(path, "frontmatter values must be JSON values"));
        };
        match key {
            "id" => fm.id = Some(expect_string(value, &path)?),
            "created" => fm.created = Some(expect_string(value, &path)?),
            "updated" => fm.updated = Some(expect_string(value, &path)?),
            "tags" => fm.tags = expect_string_array(value, &path)?,
            "aliases" => fm.aliases = expect_string_array(value, &path)?,
            "icon" => fm.icon = Some(expect_string(value, &path)?),
            _ => {
                fm.extra
                    .insert(key.to_string(), decode_extra(value, &path)?);
            }
        }
    }
    Ok(fm)
}

fn decode_extra(value: Any, path: &str) -> Result<YamlValue, CrdtError> {
    match value {
        Any::String(value) => Ok(YamlValue::Scalar(value.to_string())),
        Any::Array(values) => Ok(YamlValue::List(strings_from_any(&values, path)?)),
        Any::Map(fields) => {
            let kind = fields.get("$memberberry");
            let lines = fields.get("lines");
            if kind != Some(&Any::from("raw")) {
                return Err(malformed(path, "unknown frontmatter envelope"));
            }
            let Some(Any::Array(lines)) = lines else {
                return Err(malformed(path, "raw frontmatter envelope needs lines[]"));
            };
            Ok(YamlValue::Raw(strings_from_any(lines, path)?))
        }
        _ => Err(malformed(
            path,
            "frontmatter value must be a string, string[], or raw envelope",
        )),
    }
}

fn read_blocks<P: XmlFragment, T: ReadTxn>(
    parent: &P,
    txn: &T,
    path: &str,
) -> Result<Vec<Block>, CrdtError> {
    parent
        .children(txn)
        .enumerate()
        .map(|(index, child)| {
            let child_path = format!("{path}[{index}]");
            let XmlOut::Element(element) = child else {
                return Err(malformed(child_path, "block children must be Y.XmlElement"));
            };
            read_block(&element, txn, &child_path)
        })
        .collect()
}

fn read_block<T: ReadTxn>(
    element: &XmlElementRef,
    txn: &T,
    path: &str,
) -> Result<Block, CrdtError> {
    let tag = element.tag().as_ref();
    let kind = match tag {
        "paragraph" => BlockKind::Paragraph(read_inlines(element, txn, path)?),
        "heading" => {
            let level = required_u64_attr(element, txn, "level", path)?;
            let level = u8::try_from(level)
                .ok()
                .and_then(HeadingLevel::new)
                .ok_or_else(|| malformed(format!("{path}.level"), "expected integer 1..=6"))?;
            BlockKind::Heading {
                level,
                content: read_inlines(element, txn, path)?,
            }
        }
        "bullet_list" => BlockKind::List(read_list(element, txn, path, false)?),
        "ordered_list" => BlockKind::List(read_list(element, txn, path, true)?),
        "blockquote" => BlockKind::Blockquote(read_blocks(element, txn, path)?),
        "callout" => BlockKind::Callout(read_callout(element, txn, path)?),
        "code_block" => BlockKind::CodeBlock {
            lang: optional_string_attr(element, txn, "lang", path)?,
            code: read_plain_text(element, txn, path)?,
        },
        "divider" => {
            ensure_no_children(element, txn, path)?;
            BlockKind::Divider
        }
        "table" => BlockKind::Table(read_table(element, txn, path)?),
        "math_block" => BlockKind::MathBlock(read_plain_text(element, txn, path)?),
        _ => return Err(malformed(path, format!("unknown block node `{tag}`"))),
    };
    Ok(Block {
        kind,
        anchor: optional_string_attr(element, txn, "anchor", path)?,
    })
}

fn read_list<T: ReadTxn>(
    element: &XmlElementRef,
    txn: &T,
    path: &str,
    ordered: bool,
) -> Result<List, CrdtError> {
    let start = if ordered {
        required_u64_attr(element, txn, "start", path)?
    } else {
        1
    };
    let items = element
        .children(txn)
        .enumerate()
        .map(|(index, child)| {
            let item_path = format!("{path}.items[{index}]");
            let XmlOut::Element(item) = child else {
                return Err(malformed(item_path, "list children must be elements"));
            };
            let task = match item.tag().as_ref() {
                "list_item" => None,
                "task_item" => Some(read_task(&item, txn, &item_path)?),
                tag => {
                    return Err(malformed(
                        item_path,
                        format!("unexpected list child `{tag}`"),
                    ));
                }
            };
            Ok(ListItem {
                task,
                content: read_blocks(&item, txn, &item_path)?,
            })
        })
        .collect::<Result<Vec<_>, CrdtError>>()?;
    Ok(List {
        ordered,
        start,
        items,
    })
}

fn read_task<T: ReadTxn>(element: &XmlElementRef, txn: &T, path: &str) -> Result<Task, CrdtError> {
    let status = match required_string_attr(element, txn, "status", path)?.as_str() {
        "todo" => TaskStatus::Todo,
        "done" => TaskStatus::Done,
        "cancelled" => TaskStatus::Cancelled,
        value => {
            return Err(malformed(
                format!("{path}.status"),
                format!("unknown status `{value}`"),
            ));
        }
    };
    let priority = match optional_string_attr(element, txn, "priority", path)?.as_deref() {
        None => None,
        Some("lowest") => Some(Priority::Lowest),
        Some("low") => Some(Priority::Low),
        Some("medium") => Some(Priority::Medium),
        Some("high") => Some(Priority::High),
        Some("highest") => Some(Priority::Highest),
        Some(value) => {
            return Err(malformed(
                format!("{path}.priority"),
                format!("unknown priority `{value}`"),
            ));
        }
    };
    Ok(Task {
        status,
        meta: TaskMeta {
            created: optional_date_attr(element, txn, "created", path)?,
            start: optional_date_attr(element, txn, "start", path)?,
            scheduled: optional_date_attr(element, txn, "scheduled", path)?,
            due: optional_date_attr(element, txn, "due", path)?,
            done: optional_date_attr(element, txn, "done", path)?,
            cancelled: optional_date_attr(element, txn, "cancelled", path)?,
            priority,
            unknown: string_array_attr(element, txn, "unknown", path)?.unwrap_or_default(),
        },
    })
}

fn optional_date_attr<T: ReadTxn>(
    element: &XmlElementRef,
    txn: &T,
    key: &str,
    path: &str,
) -> Result<Option<Date>, CrdtError> {
    optional_string_attr(element, txn, key, path)?
        .map(|value| {
            Date::parse(&value)
                .ok_or_else(|| malformed(format!("{path}.{key}"), "expected YYYY-MM-DD"))
        })
        .transpose()
}

fn read_callout<T: ReadTxn>(
    element: &XmlElementRef,
    txn: &T,
    path: &str,
) -> Result<Callout, CrdtError> {
    let kind = required_string_attr(element, txn, "kind", path)?;
    let fold = match required_string_attr(element, txn, "fold", path)?.as_str() {
        "none" => Fold::None,
        "expanded" => Fold::Expanded,
        "collapsed" => Fold::Collapsed,
        value => {
            return Err(malformed(
                format!("{path}.fold"),
                format!("unknown fold `{value}`"),
            ));
        }
    };
    let mut children = element.children(txn).enumerate();
    let Some((_, XmlOut::Element(title))) = children.next() else {
        return Err(malformed(path, "callout must begin with callout_title"));
    };
    if title.tag().as_ref() != "callout_title" {
        return Err(malformed(path, "callout must begin with callout_title"));
    }
    let title_content = read_inlines(&title, txn, &format!("{path}.title"))?;
    let mut content = Vec::new();
    for (index, child) in children {
        let child_path = format!("{path}.content[{}]", index.saturating_sub(1));
        let XmlOut::Element(child) = child else {
            return Err(malformed(
                child_path,
                "callout content must be block elements",
            ));
        };
        content.push(read_block(&child, txn, &child_path)?);
    }
    Ok(Callout {
        kind,
        fold,
        title: title_content,
        content,
    })
}

fn read_table<T: ReadTxn>(
    element: &XmlElementRef,
    txn: &T,
    path: &str,
) -> Result<Table, CrdtError> {
    let values = string_array_attr(element, txn, "alignments", path)?
        .ok_or_else(|| malformed(format!("{path}.alignments"), "missing attribute"))?;
    let alignments = values
        .into_iter()
        .map(|value| match value.as_str() {
            "none" => Ok(Alignment::None),
            "left" => Ok(Alignment::Left),
            "center" => Ok(Alignment::Center),
            "right" => Ok(Alignment::Right),
            _ => Err(malformed(
                format!("{path}.alignments"),
                format!("unknown alignment `{value}`"),
            )),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut rows = element
        .children(txn)
        .enumerate()
        .map(|(index, child)| read_table_row(child, txn, &format!("{path}.rows[{index}]")));
    let head = rows
        .next()
        .transpose()?
        .ok_or_else(|| malformed(path, "table needs a header row"))?;
    Ok(Table {
        alignments,
        head,
        rows: rows.collect::<Result<Vec<_>, _>>()?,
    })
}

fn read_table_row<T: ReadTxn>(
    child: XmlOut,
    txn: &T,
    path: &str,
) -> Result<Vec<Vec<Inline>>, CrdtError> {
    let XmlOut::Element(row) = child else {
        return Err(malformed(path, "table row must be an element"));
    };
    if row.tag().as_ref() != "table_row" {
        return Err(malformed(path, "expected table_row"));
    }
    row.children(txn)
        .enumerate()
        .map(|(index, child)| {
            let cell_path = format!("{path}.cells[{index}]");
            let XmlOut::Element(cell) = child else {
                return Err(malformed(cell_path, "table cell must be an element"));
            };
            if cell.tag().as_ref() != "table_cell" {
                return Err(malformed(cell_path, "expected table_cell"));
            }
            read_inlines(&cell, txn, &cell_path)
        })
        .collect()
}

fn read_plain_text<T: ReadTxn>(
    element: &XmlElementRef,
    txn: &T,
    path: &str,
) -> Result<String, CrdtError> {
    let mut output = String::new();
    for child in element.children(txn) {
        let XmlOut::Text(text) = child else {
            return Err(malformed(path, "code content must contain only Y.XmlText"));
        };
        for chunk in text.diff(txn, |_| ()) {
            if chunk
                .attributes
                .as_ref()
                .is_some_and(|attrs| !attrs.is_empty())
            {
                return Err(malformed(path, "code text cannot carry marks"));
            }
            let Out::Any(Any::String(value)) = chunk.insert else {
                return Err(malformed(path, "code content must be strings"));
            };
            output.push_str(&value);
        }
    }
    Ok(output)
}

fn read_inlines<P: XmlFragment, T: ReadTxn>(
    parent: &P,
    txn: &T,
    path: &str,
) -> Result<Vec<Inline>, CrdtError> {
    let mut output = Vec::new();
    for (index, child) in parent.children(txn).enumerate() {
        let child_path = format!("{path}.inline[{index}]");
        match child {
            XmlOut::Text(text) => {
                for chunk in text.diff(txn, |_| ()) {
                    let Out::Any(Any::String(value)) = chunk.insert else {
                        return Err(malformed(
                            &child_path,
                            "inline text embeds are not supported",
                        ));
                    };
                    output.push(apply_marks(
                        value.to_string(),
                        chunk.attributes.as_deref(),
                        &child_path,
                    )?);
                }
            }
            XmlOut::Element(element) => output.push(read_atom(&element, txn, &child_path)?),
            XmlOut::Fragment(_) => {
                return Err(malformed(
                    child_path,
                    "nested XML fragments are not schema nodes",
                ));
            }
        }
    }
    Ok(output)
}

fn apply_marks(value: String, attrs: Option<&Attrs>, path: &str) -> Result<Inline, CrdtError> {
    let attrs = attrs.cloned().unwrap_or_default();
    for name in attrs.keys() {
        if !matches!(
            name.as_ref(),
            "strong" | "em" | "strikethrough" | "highlight" | "code" | "link"
        ) {
            return Err(malformed(path, format!("unknown mark `{name}`")));
        }
    }
    let mut inline = if attrs.contains_key("code") {
        Inline::Code(value)
    } else {
        Inline::Text(value)
    };
    for name in ["link", "highlight", "strikethrough", "em", "strong"] {
        let Some(mark) = attrs.get(name) else {
            continue;
        };
        inline = match name {
            "strong" => Inline::Strong(vec![inline]),
            "em" => Inline::Emphasis(vec![inline]),
            "strikethrough" => Inline::Strikethrough(vec![inline]),
            "highlight" => Inline::Highlight(vec![inline]),
            "link" => {
                let Any::Map(fields) = mark else {
                    return Err(malformed(path, "link mark attributes must be an object"));
                };
                let href = fields
                    .get("href")
                    .cloned()
                    .ok_or_else(|| malformed(path, "link mark needs href"))?;
                let title = fields.get("title").cloned().unwrap_or(Any::Null);
                Inline::Link {
                    dest: expect_string(href, path)?,
                    title: optional_string(title, path)?,
                    content: vec![inline],
                }
            }
            _ => return Err(malformed(path, "unreachable mark")),
        };
    }
    Ok(inline)
}

fn read_atom<T: ReadTxn>(
    element: &XmlElementRef,
    txn: &T,
    path: &str,
) -> Result<Inline, CrdtError> {
    ensure_no_children(element, txn, path)?;
    match element.tag().as_ref() {
        "soft_break" => Ok(Inline::SoftBreak),
        "hard_break" => Ok(Inline::HardBreak),
        "image" => Ok(Inline::Image {
            dest: required_string_attr(element, txn, "dest", path)?,
            alt: required_string_attr(element, txn, "alt", path)?,
        }),
        "wikilink" => read_wikilink(element, txn, path).map(Inline::WikiLink),
        "tag" => required_string_attr(element, txn, "name", path).map(Inline::Tag),
        "emoji" => required_string_attr(element, txn, "shortcode", path).map(Inline::Emoji),
        "inline_math" => required_string_attr(element, txn, "value", path).map(Inline::Math),
        "footnote_ref" => {
            required_string_attr(element, txn, "label", path).map(Inline::FootnoteRef)
        }
        tag => Err(malformed(path, format!("unknown inline node `{tag}`"))),
    }
}

fn read_wikilink<T: ReadTxn>(
    element: &XmlElementRef,
    txn: &T,
    path: &str,
) -> Result<WikiLink, CrdtError> {
    let text = optional_string_attr(element, txn, "anchor_text", path)?;
    let anchor = match required_string_attr(element, txn, "anchor_kind", path)?.as_str() {
        "none" if text.is_none() => None,
        "heading" => Some(Anchor::Heading(text.ok_or_else(|| {
            malformed(format!("{path}.anchor_text"), "heading anchor needs text")
        })?)),
        "block" => Some(Anchor::Block(text.ok_or_else(|| {
            malformed(format!("{path}.anchor_text"), "block anchor needs text")
        })?)),
        "none" => {
            return Err(malformed(
                format!("{path}.anchor_text"),
                "none anchor must not have text",
            ));
        }
        value => {
            return Err(malformed(
                format!("{path}.anchor_kind"),
                format!("unknown anchor kind `{value}`"),
            ));
        }
    };
    Ok(WikiLink {
        target: required_string_attr(element, txn, "target", path)?,
        anchor,
        alias: optional_string_attr(element, txn, "alias", path)?,
        embed: required_bool_attr(element, txn, "embed", path)?,
    })
}

fn ensure_no_children<T: ReadTxn>(
    element: &XmlElementRef,
    txn: &T,
    path: &str,
) -> Result<(), CrdtError> {
    if element.children(txn).next().is_some() {
        Err(malformed(path, "atom node cannot have children"))
    } else {
        Ok(())
    }
}

fn optional_string_attr<T: ReadTxn>(
    element: &XmlElementRef,
    txn: &T,
    key: &str,
    path: &str,
) -> Result<Option<String>, CrdtError> {
    let Some(value) = any_attr(element, txn, key, path)? else {
        return Ok(None);
    };
    optional_string(value, &format!("{path}.{key}"))
}

fn required_string_attr<T: ReadTxn>(
    element: &XmlElementRef,
    txn: &T,
    key: &str,
    path: &str,
) -> Result<String, CrdtError> {
    let value = any_attr(element, txn, key, path)?
        .ok_or_else(|| malformed(format!("{path}.{key}"), "missing attribute"))?;
    expect_string(value, &format!("{path}.{key}"))
}

fn required_u64_attr<T: ReadTxn>(
    element: &XmlElementRef,
    txn: &T,
    key: &str,
    path: &str,
) -> Result<u64, CrdtError> {
    let value = any_attr(element, txn, key, path)?
        .ok_or_else(|| malformed(format!("{path}.{key}"), "missing attribute"))?;
    match value {
        Any::Number(value) if value.is_finite() && value.fract() == 0.0 && value >= 0.0 => {
            Ok(value as u64)
        }
        Any::BigInt(value) if value >= 0 => Ok(value as u64),
        _ => Err(malformed(
            format!("{path}.{key}"),
            "expected unsigned integer",
        )),
    }
}

fn required_bool_attr<T: ReadTxn>(
    element: &XmlElementRef,
    txn: &T,
    key: &str,
    path: &str,
) -> Result<bool, CrdtError> {
    match any_attr(element, txn, key, path)? {
        Some(Any::Bool(value)) => Ok(value),
        Some(_) => Err(malformed(format!("{path}.{key}"), "expected boolean")),
        None => Err(malformed(format!("{path}.{key}"), "missing attribute")),
    }
}

fn string_array_attr<T: ReadTxn>(
    element: &XmlElementRef,
    txn: &T,
    key: &str,
    path: &str,
) -> Result<Option<Vec<String>>, CrdtError> {
    let Some(value) = any_attr(element, txn, key, path)? else {
        return Ok(None);
    };
    expect_string_array(value, &format!("{path}.{key}")).map(Some)
}

fn any_attr<T: ReadTxn>(
    element: &XmlElementRef,
    txn: &T,
    key: &str,
    path: &str,
) -> Result<Option<Any>, CrdtError> {
    match element.get_attribute(txn, key) {
        None => Ok(None),
        Some(Out::Any(value)) => Ok(Some(value)),
        Some(_) => Err(malformed(
            format!("{path}.{key}"),
            "node attributes must be JSON values",
        )),
    }
}

fn optional_string(value: Any, path: &str) -> Result<Option<String>, CrdtError> {
    match value {
        Any::Null | Any::Undefined => Ok(None),
        value => expect_string(value, path).map(Some),
    }
}

fn expect_string(value: Any, path: &str) -> Result<String, CrdtError> {
    match value {
        Any::String(value) => Ok(value.to_string()),
        _ => Err(malformed(path, "expected string")),
    }
}

fn expect_string_array(value: Any, path: &str) -> Result<Vec<String>, CrdtError> {
    match value {
        Any::Array(values) => strings_from_any(&values, path),
        _ => Err(malformed(path, "expected string[]")),
    }
}

fn strings_from_any(values: &[Any], path: &str) -> Result<Vec<String>, CrdtError> {
    values
        .iter()
        .cloned()
        .enumerate()
        .map(|(index, value)| expect_string(value, &format!("{path}[{index}]")))
        .collect()
}
