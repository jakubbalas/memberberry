//! Obsidian-compatible Excalidraw Markdown storage (`SPEC.md` §13).

use serde::{Deserialize, Serialize};
use serde_json::Value;

const FENCE_NAMES: [&str; 2] = ["compressed-json", "json"];

/// The scene data extracted from an Excalidraw Markdown file.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Drawing {
    /// The complete source, retained so a save can preserve Obsidian's surrounding text.
    pub markdown: String,
    /// The Excalidraw scene JSON from the drawing fence.
    pub scene: Value,
    /// SHA-256 of the complete Markdown source used for optimistic concurrency.
    pub revision: String,
}

/// JSON request used to replace an Excalidraw Markdown source.
#[derive(Debug, Deserialize)]
pub struct SaveDrawing {
    /// Complete Obsidian-compatible Markdown, including the scene fence.
    pub markdown: String,
    /// Revision returned by the last read, when replacing an existing drawing.
    #[serde(default)]
    pub base: Option<String>,
}

/// Export files generated from the same scene save.
#[derive(Debug, Deserialize)]
pub struct SaveExports {
    /// SVG source, written next to the Markdown file.
    pub svg: String,
    /// PNG data URL, decoded before it is written.
    pub png: String,
    /// Revision of the Markdown source the derivatives represent.
    #[serde(default)]
    pub base: Option<String>,
}

/// Why a drawing could not be read or written.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// No supported scene fence was present.
    #[error("drawing has no JSON scene fence")]
    MissingScene,
    /// The scene fence did not contain valid JSON.
    #[error("drawing scene is not valid JSON: {0}")]
    InvalidJson(#[from] serde_json::Error),
    /// The decoded value was not an Excalidraw scene.
    #[error("drawing scene must be an Excalidraw object")]
    InvalidScene,
    /// The derived export payload was not a safe SVG/PNG pair.
    #[error("drawing export is not valid SVG and PNG data")]
    InvalidExport,
    /// The file operation failed.
    #[error("drawing file operation failed: {0}")]
    Io(String),
}

/// Parses an Obsidian Excalidraw Markdown source.
pub fn parse(markdown: String) -> Result<Drawing, Error> {
    let mut lines = markdown.lines();
    while let Some(line) = lines.next() {
        let Some(language) = line.strip_prefix("```").map(str::trim) else {
            continue;
        };
        if !FENCE_NAMES.contains(&language) {
            continue;
        }
        let mut json = String::new();
        for line in &mut lines {
            if line.trim() == "```" {
                let scene: Value = serde_json::from_str(json.trim())?;
                validate_scene(&scene)?;
                return Ok(Drawing {
                    markdown,
                    scene,
                    revision: String::new(),
                });
            }
            if !json.is_empty() {
                json.push('\n');
            }
            json.push_str(line);
        }
        return Err(Error::MissingScene);
    }
    Err(Error::MissingScene)
}

fn validate_scene(scene: &Value) -> Result<(), Error> {
    if scene.get("type").and_then(Value::as_str) == Some("excalidraw")
        && scene.get("elements").is_some_and(Value::is_array)
    {
        Ok(())
    } else {
        Err(Error::InvalidScene)
    }
}

/// Reads and parses one already-authorized drawing path.
pub fn read(path: &std::path::Path) -> Result<Drawing, Error> {
    let markdown = std::fs::read_to_string(path).map_err(|error| Error::Io(error.to_string()))?;
    let mut drawing = parse(markdown.clone())?;
    drawing.revision = revision(&markdown);
    Ok(drawing)
}

/// Replaces a drawing source atomically after validating its scene.
pub fn write(path: &std::path::Path, markdown: String) -> Result<Drawing, Error> {
    let mut drawing = parse(markdown)?;
    let parent = path
        .parent()
        .ok_or_else(|| Error::Io("drawing has no parent directory".to_string()))?;
    std::fs::create_dir_all(parent).map_err(|error| Error::Io(error.to_string()))?;
    let temporary = path.with_extension("excalidraw.md.tmp");
    std::fs::write(&temporary, drawing.markdown.as_bytes())
        .map_err(|error| Error::Io(error.to_string()))?;
    if let Err(error) = std::fs::rename(&temporary, path) {
        drop(std::fs::remove_file(&temporary));
        return Err(Error::Io(error.to_string()));
    }
    drawing.revision = revision(&drawing.markdown);
    Ok(drawing)
}

/// Writes validated SVG and PNG derivatives beside an authorized source file.
pub fn write_exports(path: &std::path::Path, exports: SaveExports) -> Result<(), Error> {
    if !exports.svg.trim_start().starts_with("<svg") {
        return Err(Error::InvalidExport);
    }
    let encoded = exports
        .png
        .strip_prefix("data:image/png;base64,")
        .ok_or(Error::InvalidExport)?;
    let png = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded)
        .map_err(|_| Error::InvalidExport)?;
    if png.len() < 8 || png.get(..8) != Some(b"\x89PNG\r\n\x1a\n") {
        return Err(Error::InvalidExport);
    }
    std::fs::write(path.with_extension("svg"), exports.svg)
        .map_err(|error| Error::Io(error.to_string()))?;
    std::fs::write(path.with_extension("png"), png)
        .map_err(|error| Error::Io(error.to_string()))?;
    Ok(())
}

/// Returns the stable content revision used by drawing last-write-wins saves.
#[must_use]
pub fn revision(markdown: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(markdown.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, clippy::indexing_slicing)]

    use super::{Error, parse};

    fn source(scene: &str) -> String {
        format!(
            "---\nexcalidraw-plugin: parsed\n---\n\n# Drawing\n```compressed-json\n{scene}\n```\n"
        )
    }

    #[test]
    fn parses_the_obsidian_scene_fence() {
        let drawing = parse(source(r#"{"type":"excalidraw","elements":[]}"#)).expect("scene");
        assert_eq!(drawing.scene["type"], "excalidraw");
        assert_eq!(drawing.scene["elements"], serde_json::json!([]));
    }

    #[test]
    fn rejects_missing_and_invalid_scenes() {
        assert!(matches!(
            parse("# Drawing\n".to_string()),
            Err(Error::MissingScene)
        ));
        assert!(matches!(
            parse(source("not json")),
            Err(Error::InvalidJson(_))
        ));
        assert!(matches!(
            parse(source(r#"{"type":"other","elements":[]}"#)),
            Err(Error::InvalidScene)
        ));
    }
}
