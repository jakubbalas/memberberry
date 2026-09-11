//! Permission-filtered whole-vault HTML export (`SPEC.md` §19.2).

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use mb_core::{Access, Username};
use serde::Serialize;

use crate::repository::AuthorizedVault;

#[derive(Debug, Serialize)]
struct SearchNote {
    path: String,
    title: String,
    text: String,
}

#[derive(Debug, Serialize)]
struct LinkTarget {
    source: String,
    target: String,
    output: String,
}

#[derive(Debug, Serialize)]
struct SiteData {
    notes: Vec<SearchNote>,
    links: Vec<LinkTarget>,
}

/// Writes a complete static site containing only `username`'s currently readable notes.
///
/// The destination is replaced only after the new artifact is complete, preventing content
/// from an earlier, broader ACL from surviving a later export.
///
/// # Errors
///
/// Returns an error for an unknown or disabled user, denied vault, malformed ACL, unreadable
/// media object, or filesystem failure.
pub fn write(
    vault: &crate::Vault,
    auth: &mb_auth::AuthDb,
    username: &str,
    destination: &Path,
    runtime: &tokio::runtime::Runtime,
) -> Result<usize, String> {
    let account = auth
        .user_by_username(username)
        .map_err(|error| error.to_string())?
        .filter(|user| !user.disabled)
        .ok_or_else(|| format!("unknown or disabled user `{username}`"))?;
    let user = Username::parse(&account.username).map_err(|error| error.to_string())?;
    let access = crate::AccessFile::load(vault.root()).map_err(|error| error.to_string())?;
    let view = AuthorizedVault::new(vault, access.policy(), user.clone());
    if !view.has_any_access().map_err(|error| error.to_string())? {
        return Err(format!(
            "user `{username}` cannot read vault `{}`",
            vault.slug()
        ));
    }

    let parent = destination.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)
        .map_err(|error| format!("creating {}: {error}", parent.display()))?;
    let temporary = parent.join(format!(
        ".memberberry-static-{}-{}",
        vault.slug(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_nanos()
    ));
    fs::create_dir(&temporary)
        .map_err(|error| format!("creating {}: {error}", temporary.display()))?;
    let notes = match build(vault, &view, access.policy(), &user, &temporary, runtime) {
        Ok(notes) => notes,
        Err(error) => {
            drop(fs::remove_dir_all(&temporary));
            return Err(error);
        }
    };
    if destination.exists() {
        fs::remove_dir_all(destination)
            .map_err(|error| format!("replacing {}: {error}", destination.display()))?;
    }
    fs::rename(&temporary, destination)
        .map_err(|error| format!("publishing {}: {error}", destination.display()))?;
    Ok(notes)
}

fn build(
    vault: &crate::Vault,
    view: &AuthorizedVault<'_>,
    access: &Access,
    user: &Username,
    destination: &Path,
    runtime: &tokio::runtime::Runtime,
) -> Result<usize, String> {
    let paths = view.notes().map_err(|error| error.to_string())?;
    let mut index = mb_index::Index::in_memory().map_err(|error| error.to_string())?;
    crate::indexing::reconcile(vault, &mut index)?;
    let reader = index
        .reader(access, user)
        .map_err(|error| error.to_string())?;
    let mut data = SiteData {
        notes: Vec::with_capacity(paths.len()),
        links: Vec::new(),
    };
    let mut media = BTreeSet::new();
    for path in &paths {
        let source = view.read(path).map_err(|error| error.to_string())?;
        let document = mb_core::parse(&source);
        let facts = mb_core::extract(&document);
        let title = mb_core::extract::title(&document).unwrap_or_else(|| path.clone());
        let output = note_output(path);
        let root = root_prefix(&output);
        let rendered = mb_core::html::document(
            &document,
            &mb_core::html::Urls {
                note: "",
                media: "",
                wikilinks: true,
                embeds: true,
            },
        );
        write_text(
            &destination.join(&output),
            &page(&title, path, &root, &rendered),
        )?;
        media.extend(facts.media);
        for link in facts.links {
            if let Some(target) = reader
                .resolve(path, &link.target)
                .map_err(|error| error.to_string())?
            {
                data.links.push(LinkTarget {
                    source: path.clone(),
                    target: link.target,
                    output: note_output(&target.path),
                });
            }
        }
        data.notes.push(SearchNote {
            path: path.clone(),
            title,
            text: source,
        });
    }
    copy_media(vault, destination, media, runtime)?;
    write_text(&destination.join("site.css"), SITE_CSS)?;
    write_text(&destination.join("site.js"), SITE_JS)?;
    let json = serde_json::to_string(&data).map_err(|error| error.to_string())?;
    write_text(
        &destination.join("site-data.js"),
        &format!("globalThis.MEMBERBERRY_SITE={json};\n"),
    )?;
    write_text(&destination.join("index.html"), &index_page(&data.notes))?;
    write_text(&destination.join("graph.html"), &graph_page(&data))?;
    Ok(paths.len())
}

fn copy_media(
    vault: &crate::Vault,
    destination: &Path,
    references: BTreeSet<String>,
    runtime: &tokio::runtime::Runtime,
) -> Result<(), String> {
    let store = crate::media::Store::new(vault).map_err(|error| error.to_string())?;
    for reference in references {
        let bytes = runtime
            .block_on(store.get(&reference))
            .map_err(|error| format!("reading {reference}: {error}"))?;
        let path = destination.join(&reference);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("creating {}: {error}", parent.display()))?;
        }
        fs::write(&path, bytes).map_err(|error| format!("writing {}: {error}", path.display()))?;
    }
    Ok(())
}

fn note_output(path: &str) -> String {
    format!("notes/{}.html", path.strip_suffix(".md").unwrap_or(path))
}

fn root_prefix(output: &str) -> String {
    "../".repeat(output.matches('/').count())
}

fn page(title: &str, source: &str, root: &str, rendered: &str) -> String {
    let mut escaped_title = String::new();
    mb_core::html::escape_text(title, &mut escaped_title);
    let mut escaped_source = String::new();
    mb_core::html::escape_attr(source, &mut escaped_source);
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><base href=\"{root}\"><title>{escaped_title}</title><link rel=\"stylesheet\" href=\"site.css\"><script src=\"site-data.js\" defer></script><script src=\"site.js\" defer></script></head><body data-note=\"{escaped_source}\"><header><a href=\"index.html\">Notes</a><a href=\"graph.html\">Graph</a><label>Search <input type=\"search\" data-site-search></label><ul data-search-results></ul></header><main>{rendered}</main></body></html>"
    )
}

fn index_page(notes: &[SearchNote]) -> String {
    let items = notes
        .iter()
        .map(|note| {
            let mut title = String::new();
            mb_core::html::escape_text(&note.title, &mut title);
            let mut href = String::new();
            mb_core::html::escape_attr(&note_output(&note.path), &mut href);
            format!("<li><a href=\"{href}\">{title}</a></li>")
        })
        .collect::<String>();
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Notes</title><link rel=\"stylesheet\" href=\"site.css\"><script src=\"site-data.js\" defer></script><script src=\"site.js\" defer></script></head><body><header><a href=\"index.html\">Notes</a><a href=\"graph.html\">Graph</a><label>Search <input type=\"search\" data-site-search></label><ul data-search-results></ul></header><main><h1>Notes</h1><ul>{items}</ul></main></body></html>"
    )
}

fn graph_page(data: &SiteData) -> String {
    let titles = data
        .notes
        .iter()
        .map(|note| (note.path.as_str(), note.title.as_str()))
        .collect::<BTreeMap<_, _>>();
    let edges = data
        .links
        .iter()
        .map(|link| {
            let from = titles
                .get(link.source.as_str())
                .copied()
                .unwrap_or(&link.source);
            let target_path = link.output.strip_prefix("notes/").unwrap_or(&link.output);
            let target_path = format!(
                "{}.md",
                target_path.strip_suffix(".html").unwrap_or(target_path)
            );
            let to = titles
                .get(target_path.as_str())
                .copied()
                .unwrap_or(&target_path);
            let mut label = String::new();
            mb_core::html::escape_text(&format!("{from} → {to}"), &mut label);
            let mut href = String::new();
            mb_core::html::escape_attr(&link.output, &mut href);
            format!("<li><a href=\"{href}\">{label}</a></li>")
        })
        .collect::<String>();
    let nodes = data
        .notes
        .iter()
        .map(|note| {
            let mut title = String::new();
            mb_core::html::escape_text(&note.title, &mut title);
            let mut href = String::new();
            mb_core::html::escape_attr(&note_output(&note.path), &mut href);
            format!("<li><a href=\"{href}\">{title}</a></li>")
        })
        .collect::<String>();
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Graph</title><link rel=\"stylesheet\" href=\"site.css\"></head><body><header><a href=\"index.html\">Notes</a><a href=\"graph.html\">Graph</a></header><main><h1>Graph</h1><h2>Notes</h2><ul>{nodes}</ul><h2>Connections</h2><ul>{edges}</ul></main></body></html>"
    )
}

fn write_text(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("creating {}: {error}", parent.display()))?;
    }
    fs::write(path, contents).map_err(|error| format!("writing {}: {error}", path.display()))
}

const SITE_CSS: &str = r#":root{color-scheme:light dark;font-family:system-ui,sans-serif}body{max-width:72rem;margin:auto;padding:1rem;line-height:1.6}header{display:flex;gap:1rem;align-items:center;flex-wrap:wrap;border-bottom:1px solid;padding-bottom:1rem}main{max-width:48rem}img{max-width:100%;height:auto}pre{overflow:auto;padding:1rem;background:CanvasText;color:Canvas}table{border-collapse:collapse}th,td{border:1px solid;padding:.4rem}a{color:LinkText}[data-search-results]:empty{display:none}"#;

const SITE_JS: &str = r#"(()=>{const data=globalThis.MEMBERBERRY_SITE;if(!data)return;const root=new URL('.',document.querySelector('script[src$="site.js"]').src);const source=document.body.dataset.note;for(const link of document.querySelectorAll('a.mb-wikilink,a.mb-embed')){const target=link.dataset.target;const found=data.links.find(item=>item.source===source&&item.target===target);if(found){const url=new URL(found.output,root);if(link.dataset.anchor)url.hash=link.dataset.anchor;link.href=url.href}else link.removeAttribute('href')}for(const input of document.querySelectorAll('[data-site-search]')){input.addEventListener('input',()=>{const list=input.parentElement.nextElementSibling;const query=input.value.trim().toLocaleLowerCase();list.replaceChildren();if(!query)return;for(const note of data.notes.filter(item=>(item.title+' '+item.path+' '+item.text).toLocaleLowerCase().includes(query)).slice(0,50)){const row=document.createElement('li');const anchor=document.createElement('a');anchor.href=new URL(note.path.replace(/\.md$/,'.html').replace(/^/,'notes/'),root).href;anchor.textContent=note.title;row.append(anchor);list.append(row)}})}})();"#;
