//! Canonical text-only namespace marks. Native Markdown wrappers stay native.
use crate::model::{Inline, MbStyleProperty};

/// Projects styles onto eligible text, with inner same-property declarations winning.
/// Fixed ordered chains merge adjacent equally styled ranges and cannot exceed the
/// finite property inventory, even for deeply nested constructed input.
pub(crate) fn normalize(items: Vec<Inline>) -> Vec<Inline> {
    if !items.iter().any(has_style) {
        return items;
    }
    let mut out = Vec::new();
    collect(items, &[], &[], &mut out);
    out
}

/// Rejoins adjacent links with one destination and title, at every depth.
///
/// why: distribution wraps every leaf in its own copy of the native wrappers, so one source
/// link can leave as several — directly, or once canonical settling drops an inexpressible
/// wrapper between them. Y.Text keeps one link mark over the whole run, and this form must
/// equal what materialization reads back (SPEC §5.6). Run it after settling, not before.
pub(crate) fn join_links(items: Vec<Inline>) -> Vec<Inline> {
    let mut out: Vec<Inline> = Vec::with_capacity(items.len());
    for item in items {
        let item = match item {
            Inline::Emphasis(c) => Inline::Emphasis(join_links(c)),
            Inline::Strong(c) => Inline::Strong(join_links(c)),
            Inline::Strikethrough(c) => Inline::Strikethrough(join_links(c)),
            Inline::Highlight(c) => Inline::Highlight(join_links(c)),
            Inline::MbStyle { property, content } => Inline::MbStyle {
                property,
                content: join_links(content),
            },
            Inline::Link {
                dest,
                title,
                content,
            } => Inline::Link {
                dest,
                title,
                content: join_links(content),
            },
            other => other,
        };
        match (out.last_mut(), item) {
            (
                Some(Inline::Link {
                    dest: a,
                    title: x,
                    content: prev,
                }),
                Inline::Link {
                    dest: b,
                    title: y,
                    content: next,
                },
            ) if *a == b && *x == y => {
                for child in next {
                    crate::canonical::push(prev, child);
                }
            }
            (_, item) => out.push(item),
        }
    }
    out
}

pub(crate) fn has_style(item: &Inline) -> bool {
    match item {
        Inline::MbStyle { .. } => true,
        Inline::Emphasis(c)
        | Inline::Strong(c)
        | Inline::Strikethrough(c)
        | Inline::Highlight(c)
        | Inline::Link { content: c, .. } => c.iter().any(has_style),
        _ => false,
    }
}

fn collect(
    items: Vec<Inline>,
    active: &[MbStyleProperty],
    native: &[Inline],
    out: &mut Vec<Inline>,
) {
    // why: distributing styles to leaves wraps each leaf in its own copy of every native
    // wrapper. Two sibling text runs of one link would become two adjacent links, which
    // Markdown keeps apart but a Y.Text mark joins. Merge siblings first, as `push` would.
    let mut merged = Vec::with_capacity(items.len());
    for item in items {
        crate::canonical::push(&mut merged, item);
    }
    for item in merged {
        match item {
            Inline::MbStyle { property, content } => {
                let mut next = active.to_vec();
                next.retain(|p| p.mark_name() != property.mark_name());
                next.push(property);
                next.sort();
                collect(content, &next, native, out);
            }
            Inline::Emphasis(c) => descend(c, Inline::Emphasis(vec![]), active, native, out),
            Inline::Strong(c) => descend(c, Inline::Strong(vec![]), active, native, out),
            Inline::Strikethrough(c) => {
                descend(c, Inline::Strikethrough(vec![]), active, native, out)
            }
            Inline::Highlight(c) => descend(c, Inline::Highlight(vec![]), active, native, out),
            Inline::Link {
                dest,
                title,
                content,
            } => descend(
                content,
                Inline::Link {
                    dest,
                    title,
                    content: vec![],
                },
                active,
                native,
                out,
            ),
            leaf => {
                // why: inline-label edge guards can leave empty Text. It has no Y.Text
                // marked run, so never promote it to an empty durable declaration.
                if matches!(&leaf, Inline::Text(t) if t.is_empty()) {
                    continue;
                }
                let eligible = matches!(leaf, Inline::Text(_));
                let mut item = leaf;
                // why: Y.Text marks are a set. Styled text needs one fixed native order
                // too, otherwise materialization changes the canonical directive spelling.
                let ordered;
                let wrappers = if eligible && !active.is_empty() {
                    ordered = ordered_native(native);
                    ordered.as_slice()
                } else {
                    native
                };
                for wrapper in wrappers.iter().rev() {
                    item = wrap_native(wrapper, vec![item]);
                }
                if eligible {
                    for property in active.iter().rev() {
                        item = Inline::MbStyle {
                            property: *property,
                            content: vec![item],
                        };
                    }
                }
                crate::canonical::push(out, item);
            }
        }
    }
}

fn descend(
    content: Vec<Inline>,
    wrapper: Inline,
    active: &[MbStyleProperty],
    native: &[Inline],
    out: &mut Vec<Inline>,
) {
    let mut next = native.to_vec();
    next.push(wrapper);
    collect(content, active, &next, out);
}

fn ordered_native(native: &[Inline]) -> Vec<Inline> {
    let rank = |item: &Inline| match item {
        Inline::Strong(_) => 0,
        Inline::Emphasis(_) => 1,
        Inline::Strikethrough(_) => 2,
        Inline::Highlight(_) => 3,
        Inline::Link { .. } => 4,
        _ => 5,
    };
    let mut result = Vec::new();
    // Inner repeated link metadata wins, just like a Y.Text single-key mark value.
    for item in native.iter().rev() {
        if !result.iter().any(|prev| rank(prev) == rank(item)) {
            result.push(item.clone());
        }
    }
    result.sort_by_key(rank);
    result
}

fn wrap_native(wrapper: &Inline, content: Vec<Inline>) -> Inline {
    match wrapper {
        Inline::Emphasis(_) => Inline::Emphasis(content),
        Inline::Strong(_) => Inline::Strong(content),
        Inline::Strikethrough(_) => Inline::Strikethrough(content),
        Inline::Highlight(_) => Inline::Highlight(content),
        Inline::Link { dest, title, .. } => Inline::Link {
            dest: dest.clone(),
            title: title.clone(),
            content,
        },
        _ => wrapper.clone(),
    }
}
