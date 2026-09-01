//! YAML frontmatter.
//!
//! Deliberately a hand-rolled minimal subset rather than a YAML dependency: `mb-core` must
//! stay pure and `wasm32`-clean (AGENTS.md §4.2), and frontmatter in practice is scalars
//! and string lists. Anything richer is preserved **verbatim** in [`Frontmatter::extra`]
//! rather than reinterpreted, so no user data is lost on a round trip.

use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Frontmatter {
    pub id: Option<String>,
    pub created: Option<String>,
    pub updated: Option<String>,
    pub tags: Vec<String>,
    pub aliases: Vec<String>,
    pub icon: Option<String>,
    /// User keys, kept in sorted order to satisfy the canonical key ordering of §4.5.
    pub extra: BTreeMap<String, YamlValue>,
}

/// The subset of YAML frontmatter values this crate understands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum YamlValue {
    Scalar(String),
    List(Vec<String>),
    /// Anything else — nested maps, multi-line blocks — kept exactly as written.
    Raw(Vec<String>),
}

impl Frontmatter {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// Splits a document into `(frontmatter_body, rest)` if it opens with a `---` fence.
#[must_use]
pub fn split(input: &str) -> (Option<&str>, &str) {
    let Some(after_open) = strip_fence_line(input) else {
        return (None, input);
    };
    let mut offset = 0usize;
    for line in after_open.split_inclusive('\n') {
        if line.trim_end() == "---" {
            let body = after_open.get(..offset).unwrap_or("");
            let rest = after_open.get(offset + line.len()..).unwrap_or("");
            return (Some(body), rest);
        }
        offset += line.len();
    }
    // Unterminated fence: not frontmatter. Treat the whole input as content.
    (None, input)
}

fn strip_fence_line(input: &str) -> Option<&str> {
    let rest = input.strip_prefix("---")?;
    let rest = rest.strip_prefix('\r').unwrap_or(rest);
    rest.strip_prefix('\n')
}

#[must_use]
pub fn parse(body: &str) -> Frontmatter {
    let mut fm = Frontmatter::default();
    let lines: Vec<&str> = body.lines().collect();
    let mut i = 0usize;

    while i < lines.len() {
        let Some(line) = lines.get(i) else { break };
        if line.trim().is_empty() {
            i += 1;
            continue;
        }
        let Some((key, value)) = split_key(line) else {
            // Not a `key: value` line at top level — preserve verbatim under a synthetic key.
            let block = collect_raw(&lines, &mut i);
            fm.extra.insert(format!("~raw{i}"), YamlValue::Raw(block));
            continue;
        };
        i += 1;

        let trimmed = value.trim();
        if trimmed.is_empty() && is_list_start(lines.get(i)) {
            let items = collect_block_list(&lines, &mut i);
            assign(&mut fm, key, YamlValue::List(items));
        } else if let Some(items) = parse_flow_list(trimmed) {
            assign(&mut fm, key, YamlValue::List(items));
        } else if (trimmed.is_empty() || is_block_scalar(trimmed)) && is_indented(lines.get(i)) {
            let mut block = vec![(*line).to_string()];
            while is_indented(lines.get(i)) {
                if let Some(l) = lines.get(i) {
                    block.push((*l).to_string());
                }
                i += 1;
            }
            fm.extra.insert(key.to_string(), YamlValue::Raw(block));
        } else {
            assign(&mut fm, key, YamlValue::Scalar(unquote(trimmed)));
        }
    }
    fm
}

fn collect_raw(lines: &[&str], i: &mut usize) -> Vec<String> {
    let mut block = Vec::new();
    while let Some(l) = lines.get(*i) {
        if *i > 0 && split_key(l).is_some() && !l.starts_with(' ') {
            break;
        }
        block.push((*l).to_string());
        *i += 1;
        if lines
            .get(*i)
            .is_some_and(|n| split_key(n).is_some() && !n.starts_with(' '))
        {
            break;
        }
    }
    block
}

/// True for a YAML block scalar header: `|`, `>`, and their chomping and indentation
/// indicators (`|-`, `>+`, `|2`).
///
/// why: the value is not `|`, it is "the indented lines that follow". Reading it as a
/// scalar quoted the indicator and orphaned the body — `description: "|"` with dangling
/// indented lines, which is not valid YAML and which Obsidian will not read back. Long
/// descriptions in frontmatter are written this way routinely.
fn is_block_scalar(value: &str) -> bool {
    let Some(rest) = value.strip_prefix(['|', '>']) else {
        return false;
    };
    rest.chars()
        .all(|c| matches!(c, '-' | '+') || c.is_ascii_digit())
}

fn is_list_start(line: Option<&&str>) -> bool {
    line.is_some_and(|l| l.trim_start().starts_with("- ") || l.trim() == "-")
}

fn is_indented(line: Option<&&str>) -> bool {
    line.is_some_and(|l| (l.starts_with(' ') || l.starts_with('\t')) && !l.trim().is_empty())
}

fn collect_block_list(lines: &[&str], i: &mut usize) -> Vec<String> {
    let mut items = Vec::new();
    while is_list_start(lines.get(*i)) {
        if let Some(l) = lines.get(*i) {
            let item = l.trim_start().trim_start_matches('-').trim();
            items.push(unquote(item));
        }
        *i += 1;
    }
    items
}

fn split_key(line: &str) -> Option<(&str, &str)> {
    if line.starts_with(' ') || line.starts_with('\t') || line.starts_with('-') {
        return None;
    }
    let idx = line.find(':')?;
    let key = line.get(..idx)?.trim();
    if key.is_empty() || key.contains(' ') {
        return None;
    }
    Some((key, line.get(idx + 1..)?))
}

fn parse_flow_list(value: &str) -> Option<Vec<String>> {
    let inner = value.strip_prefix('[')?.strip_suffix(']')?;
    if inner.trim().is_empty() {
        return Some(Vec::new());
    }
    Some(inner.split(',').map(|p| unquote(p.trim())).collect())
}

fn unquote(s: &str) -> String {
    let s = s.trim();
    for q in ['"', '\''] {
        if s.len() >= 2 && s.starts_with(q) && s.ends_with(q) {
            return s.get(1..s.len() - 1).unwrap_or("").to_string();
        }
    }
    s.to_string()
}

fn assign(fm: &mut Frontmatter, key: &str, value: YamlValue) {
    match (key, value) {
        ("id", YamlValue::Scalar(v)) => fm.id = Some(v),
        ("created", YamlValue::Scalar(v)) => fm.created = Some(v),
        ("updated", YamlValue::Scalar(v)) => fm.updated = Some(v),
        ("icon", YamlValue::Scalar(v)) => fm.icon = Some(v),
        ("tags", YamlValue::List(v)) => fm.tags = v,
        ("aliases", YamlValue::List(v)) => fm.aliases = v,
        ("tags", YamlValue::Scalar(v)) => fm.tags = split_inline_tags(&v),
        ("aliases", YamlValue::Scalar(v)) => fm.aliases = vec![v],
        (k, v) => {
            fm.extra.insert(k.to_string(), v);
        }
    }
}

fn split_inline_tags(v: &str) -> Vec<String> {
    v.split_whitespace()
        .map(|s| s.trim_matches(',').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Renders frontmatter in canonical key order (`SPEC.md` §4.5): the known keys first, in
/// a fixed sequence, then user keys alphabetically (guaranteed by `BTreeMap`).
#[must_use]
pub fn render(fm: &Frontmatter) -> String {
    if fm.is_empty() {
        return String::new();
    }
    let mut out = String::from("---\n");
    fn scalar(out: &mut String, k: &str, v: &Option<String>) {
        if let Some(value) = v {
            out.push_str(k);
            out.push_str(": ");
            out.push_str(&quote_if_needed(value));
            out.push('\n');
        }
    }
    scalar(&mut out, "id", &fm.id);
    scalar(&mut out, "created", &fm.created);
    scalar(&mut out, "updated", &fm.updated);
    if !fm.tags.is_empty() {
        out.push_str(&render_flow_list("tags", &fm.tags));
    }
    if !fm.aliases.is_empty() {
        out.push_str(&render_flow_list("aliases", &fm.aliases));
    }
    scalar(&mut out, "icon", &fm.icon);
    for (key, value) in &fm.extra {
        match value {
            YamlValue::Scalar(v) => {
                out.push_str(key);
                out.push_str(": ");
                out.push_str(&quote_if_needed(v));
                out.push('\n');
            }
            YamlValue::List(items) => out.push_str(&render_flow_list(key, items)),
            YamlValue::Raw(lines) => {
                for line in lines {
                    out.push_str(line);
                    out.push('\n');
                }
            }
        }
    }
    out.push_str("---\n");
    out
}

fn render_flow_list(key: &str, items: &[String]) -> String {
    let rendered: Vec<String> = items.iter().map(|i| quote_if_needed(i)).collect();
    format!("{key}: [{}]\n", rendered.join(", "))
}

fn quote_if_needed(v: &str) -> String {
    let needs = v.is_empty()
        || v.trim() != v
        || v.starts_with(['[', '{', '"', '\'', '&', '*', '!', '|', '>', '%', '@', '`'])
        || v.contains(": ")
        || v.contains(", ")
        || v.ends_with(':');
    if needs {
        format!("\"{}\"", v.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        v.to_string()
    }
}
