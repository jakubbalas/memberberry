//! Obsidian vault migration reporting (`SPEC.md` §19.1).

use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

#[derive(Debug)]
struct Note {
    path: PathBuf,
    relative: String,
    source: String,
    document: mb_core::Document,
}

#[derive(Debug, Default)]
struct Inventory {
    markdown: Vec<PathBuf>,
    canvas: Vec<PathBuf>,
    escaped: Vec<PathBuf>,
}

pub(crate) fn run(root: &Path, write: bool, out: &mut dyn Write) -> Result<ExitCode, String> {
    if !root.is_dir() {
        return Err(format!(
            "Obsidian vault must be a directory: {}",
            root.display()
        ));
    }
    let inventory = inventory(root)?;
    let mut notes = Vec::with_capacity(inventory.markdown.len());
    for path in &inventory.markdown {
        let source = fs::read_to_string(path)
            .map_err(|error| format!("reading {}: {error}", path.display()))?;
        let relative = relative_path(root, path)?;
        let document = mb_core::parse(&source);
        notes.push(Note {
            path: path.clone(),
            relative,
            source,
            document,
        });
    }

    let known_names = known_names(&notes);
    let mut missing_ids = 0usize;
    let mut unresolved = 0usize;
    let mut unsupported = inventory.canvas.len();

    writeln!(
        out,
        "scanned {} Markdown note(s) and {} Canvas file(s)",
        notes.len(),
        inventory.canvas.len()
    )
    .map_err(io("writing import report"))?;

    for path in &inventory.escaped {
        writeln!(out, "unsafe path outside vault skipped: {}", path.display())
            .map_err(io("writing import report"))?;
    }
    for path in &inventory.canvas {
        writeln!(
            out,
            "unsupported Canvas file (preserved): {}",
            relative_path(root, path)?
        )
        .map_err(io("writing import report"))?;
    }

    for note in &notes {
        if note.document.frontmatter.id.is_none() {
            missing_ids += 1;
            if write {
                let id = uuid::Uuid::now_v7().to_string();
                let updated = inject_id(&note.source, &id);
                super::write_atomic(&note.path, &updated)?;
                writeln!(out, "added id: {}", note.relative)
                    .map_err(io("writing import report"))?;
            } else {
                writeln!(out, "would add id: {}", note.relative)
                    .map_err(io("writing import report"))?;
            }
        }

        for link in &mb_core::extract(&note.document).links {
            if !link.target.is_empty()
                && !known_names.contains(&mb_core::names::fold_name(&link.target))
            {
                unresolved += 1;
                writeln!(
                    out,
                    "unresolved wikilink: {} -> [[{}]]",
                    note.relative, link.target
                )
                .map_err(io("writing import report"))?;
            }
        }

        for finding in unsupported_markdown(&note.source) {
            unsupported += 1;
            writeln!(
                out,
                "unsupported {} (preserved): {}",
                finding, note.relative
            )
            .map_err(io("writing import report"))?;
        }
    }

    writeln!(
        out,
        "summary: {missing_ids} missing id(s), {unresolved} unresolved wikilink(s), \
         {unsupported} unsupported construct(s)"
    )
    .map_err(io("writing import report"))?;

    let incomplete = (!write && missing_ids > 0)
        || unresolved > 0
        || unsupported > 0
        || !inventory.escaped.is_empty();
    Ok(if incomplete {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    })
}

fn inventory(root: &Path) -> Result<Inventory, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("reading {}: {error}", root.display()))?;
    let mut result = Inventory::default();
    let mut stack = vec![root.to_path_buf()];
    let mut visited = HashSet::new();

    while let Some(directory) = stack.pop() {
        let canonical_directory = directory
            .canonicalize()
            .map_err(|error| format!("reading {}: {error}", directory.display()))?;
        if !canonical_directory.starts_with(&canonical_root) {
            result.escaped.push(directory);
            continue;
        }
        if !visited.insert(canonical_directory) {
            continue;
        }
        let entries = fs::read_dir(&directory)
            .map_err(|error| format!("reading {}: {error}", directory.display()))?;
        for entry in entries {
            let entry =
                entry.map_err(|error| format!("reading {}: {error}", directory.display()))?;
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let path = entry.path();
            let kind = entry
                .file_type()
                .map_err(|error| format!("reading {}: {error}", path.display()))?;
            if kind.is_symlink() {
                let target = path
                    .canonicalize()
                    .map_err(|error| format!("reading {}: {error}", path.display()))?;
                if !target.starts_with(&canonical_root) {
                    result.escaped.push(path);
                    continue;
                }
            }
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|extension| extension == "md") {
                result.markdown.push(path);
            } else if path
                .extension()
                .is_some_and(|extension| extension == "canvas")
            {
                result.canvas.push(path);
            }
        }
    }
    result.markdown.sort();
    result.canvas.sort();
    result.escaped.sort();
    Ok(result)
}

fn known_names(notes: &[Note]) -> HashSet<String> {
    let mut names = HashSet::new();
    for note in notes {
        names.insert(mb_core::names::fold_name(&note.relative));
        if let Some(stem) = Path::new(&note.relative)
            .file_stem()
            .and_then(|stem| stem.to_str())
        {
            names.insert(mb_core::names::fold_name(stem));
        }
        for alias in &note.document.frontmatter.aliases {
            names.insert(mb_core::names::fold_name(alias));
        }
    }
    names
}

fn unsupported_markdown(source: &str) -> Vec<&'static str> {
    let mut findings = Vec::new();
    let mut in_fence = false;
    for line in source.lines() {
        let trimmed = line.trim_start();
        let fence = trimmed
            .strip_prefix("```")
            .or_else(|| trimmed.strip_prefix("~~~"))
            .map(str::trim);
        if let Some(language) = fence {
            if !in_fence {
                match language.to_ascii_lowercase().as_str() {
                    "mermaid" => push_unique(&mut findings, "Mermaid block"),
                    "dataview" | "dataviewjs" => push_unique(&mut findings, "Dataview query"),
                    "tasks" | "button" => push_unique(&mut findings, "community-plugin block"),
                    language if language.starts_with("ad-") => {
                        push_unique(&mut findings, "community-plugin block");
                    }
                    _ => {}
                }
            }
            in_fence = !in_fence;
            continue;
        }
        if !in_fence && trimmed.contains("<%") && trimmed.contains("%>") {
            push_unique(&mut findings, "Templater expression");
        }
        if !in_fence && looks_like_dataview_field(trimmed) {
            push_unique(&mut findings, "Dataview field");
        }
    }
    findings
}

fn looks_like_dataview_field(line: &str) -> bool {
    let Some((key, _)) = line.split_once("::") else {
        return false;
    };
    let key = key.trim().trim_start_matches(['-', '*']).trim();
    !key.is_empty()
        && key.len() <= 80
        && key
            .chars()
            .all(|character| character.is_alphanumeric() || matches!(character, ' ' | '_' | '-'))
}

fn push_unique(findings: &mut Vec<&'static str>, finding: &'static str) {
    if !findings.contains(&finding) {
        findings.push(finding);
    }
}

pub(crate) fn inject_id(source: &str, id: &str) -> String {
    if mb_core::frontmatter::split(source).0.is_some() {
        let newline = source.find('\n').map_or(source.len(), |index| index + 1);
        let mut updated = String::with_capacity(source.len() + id.len() + 5);
        updated.push_str(source.get(..newline).unwrap_or(source));
        updated.push_str("id: ");
        updated.push_str(id);
        updated.push('\n');
        updated.push_str(source.get(newline..).unwrap_or(""));
        updated
    } else {
        format!("---\nid: {id}\n---\n\n{source}")
    }
}

fn relative_path(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .map_err(|error| {
            format!(
                "resolving {} below {}: {error}",
                path.display(),
                root.display()
            )
        })
}

fn io(what: &str) -> impl Fn(std::io::Error) -> String + '_ {
    move |error| format!("{what}: {error}")
}
