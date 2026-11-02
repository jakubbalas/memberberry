//! Vault appearance settings in `.memberberry/config.toml` (`SPEC.md` §20.1, §20.4).
//!
//! The vault owner chooses a default theme and an optional accent colour. Both are parsed
//! into validated values here, at the boundary, so the bootstrap that places them in the
//! editor page can never carry anything but a shipped theme name or a `#rrggbb` literal.

use std::path::{Path, PathBuf};

/// The shipped palettes a vault may name (§20.1). `system` follows the operating system.
pub const THEMES: [&str; 4] = [
    "system",
    "memberberry-light",
    "memberberry-dark",
    "memberberry-pastel",
];

/// Narrows an untrusted string to a shipped theme name.
#[must_use]
pub fn parse_theme(value: &str) -> Option<&'static str> {
    THEMES.iter().copied().find(|theme| *theme == value)
}

/// A validated accent colour: exactly `#` and six lowercase hexadecimal digits.
///
/// Deliberately narrower than CSS: no names, no functions, no alpha. The value is written
/// into a page attribute and then a custom property, and a type that can only hold seven
/// known characters cannot carry markup or a second declaration into either.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Accent(String);

impl Accent {
    /// Parses `#rrggbb`, case-insensitively, into its lowercase form.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        let digits = value.strip_prefix('#')?;
        (digits.len() == 6 && digits.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .then(|| Self(format!("#{}", digits.to_ascii_lowercase())))
    }

    /// The canonical `#rrggbb` text.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// What the vault owner chose. `None` accent means "use the theme's own".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Appearance {
    /// One of [`THEMES`].
    pub theme: &'static str,
    /// The accent override, if any.
    pub accent: Option<Accent>,
}

/// Why appearance could not be saved.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The existing file is not valid TOML. It is left untouched rather than replaced, so a
    /// hand-edited file with a typo is never silently discarded.
    #[error("{0} is not valid TOML; fix or remove it before changing settings")]
    Malformed(PathBuf),
    /// Reading or writing the file failed.
    #[error("writing {path}: {message}")]
    Io {
        /// The file involved.
        path: PathBuf,
        /// What went wrong.
        message: String,
    },
}

/// Writes `appearance` into `<vault>/.memberberry/config.toml`, keeping every other key.
///
/// The default theme and an absent accent are stored by removing their keys, so a vault
/// that never changed a setting keeps a file with nothing in it about appearance. TOML
/// comments in the file are not preserved: the serializer does not round-trip them.
///
/// # Errors
///
/// [`Error::Malformed`] when the existing file does not parse, [`Error::Io`] otherwise.
pub fn write(vault_root: &Path, appearance: &Appearance) -> Result<(), Error> {
    let directory = vault_root.join(".memberberry");
    let path = directory.join("config.toml");
    let mut table = match std::fs::read_to_string(&path) {
        Ok(source) => source
            .parse::<toml::Table>()
            .map_err(|_| Error::Malformed(path.clone()))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => toml::Table::new(),
        Err(error) => {
            return Err(Error::Io {
                path,
                message: error.to_string(),
            });
        }
    };
    if appearance.theme == "system" {
        table.remove("theme");
    } else {
        table.insert(
            "theme".to_string(),
            toml::Value::String(appearance.theme.to_string()),
        );
    }
    match &appearance.accent {
        Some(accent) => {
            table.insert(
                "accent".to_string(),
                toml::Value::String(accent.as_str().to_string()),
            );
        }
        None => {
            table.remove("accent");
        }
    }
    let text = toml::to_string(&table).map_err(|error| Error::Io {
        path: path.clone(),
        message: error.to_string(),
    })?;
    std::fs::create_dir_all(&directory).map_err(|error| Error::Io {
        path: directory.clone(),
        message: error.to_string(),
    })?;
    crate::sync::atomic_write(&path, text.as_bytes()).map_err(|error| Error::Io {
        path,
        message: error.to_string(),
    })
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::{Accent, Appearance, Error, parse_theme, write};
    use proptest::prelude::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn an_accent_is_normalized_to_lowercase() {
        assert_eq!(
            Accent::parse("#AbCdEf").map(|accent| accent.as_str().to_string()),
            Some("#abcdef".to_string())
        );
    }

    #[test]
    fn anything_but_a_six_digit_hex_colour_is_refused() {
        for bad in [
            "",
            "#",
            "abcdef",
            "#abc",
            "#abcdeg",
            "#abcdef0",
            "red",
            "#ab\"cd",
            "#12345\n",
            "#ａｂｃｄｅｆ",
            "#abcde\u{301}",
        ] {
            assert_eq!(Accent::parse(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn only_shipped_themes_parse() {
        assert_eq!(parse_theme("memberberry-dark"), Some("memberberry-dark"));
        assert_eq!(parse_theme("custom"), None);
        assert_eq!(parse_theme("MEMBERBERRY-DARK"), None);
    }

    #[test]
    fn writing_keeps_unrelated_keys_and_removes_defaults() {
        let root = tempdir().expect("root");
        fs::create_dir_all(root.path().join(".memberberry")).expect("dir");
        fs::write(
            root.path().join(".memberberry/config.toml"),
            "daily_note_folder = \"Journal\"\ntheme = \"memberberry-dark\"\naccent = \"#000000\"\n",
        )
        .expect("config");
        write(
            root.path(),
            &Appearance {
                theme: "system",
                accent: None,
            },
        )
        .expect("write");
        let table: toml::Table = fs::read_to_string(root.path().join(".memberberry/config.toml"))
            .expect("read")
            .parse()
            .expect("toml");
        assert_eq!(table.len(), 1);
        assert_eq!(
            table.get("daily_note_folder").and_then(toml::Value::as_str),
            Some("Journal")
        );
    }

    #[test]
    fn writing_creates_the_file_when_absent() {
        let root = tempdir().expect("root");
        write(
            root.path(),
            &Appearance {
                theme: "memberberry-pastel",
                accent: Accent::parse("#336699"),
            },
        )
        .expect("write");
        let text = fs::read_to_string(root.path().join(".memberberry/config.toml")).expect("read");
        let table: toml::Table = text.parse().expect("toml");
        assert_eq!(
            table.get("theme").and_then(toml::Value::as_str),
            Some("memberberry-pastel")
        );
        assert_eq!(
            table.get("accent").and_then(toml::Value::as_str),
            Some("#336699")
        );
    }

    #[test]
    fn a_malformed_file_is_refused_and_left_untouched() {
        let root = tempdir().expect("root");
        fs::create_dir_all(root.path().join(".memberberry")).expect("dir");
        let path = root.path().join(".memberberry/config.toml");
        fs::write(&path, "theme = = broken").expect("config");
        let result = write(
            root.path(),
            &Appearance {
                theme: "memberberry-dark",
                accent: None,
            },
        );
        assert!(matches!(result, Err(Error::Malformed(_))));
        assert_eq!(fs::read_to_string(&path).expect("read"), "theme = = broken");
    }

    proptest! {
        #[test]
        fn a_parsed_accent_is_always_seven_safe_characters(value in ".{0,12}") {
            if let Some(accent) = Accent::parse(&value) {
                prop_assert_eq!(accent.as_str().len(), 7);
                prop_assert!(accent.as_str().bytes().skip(1).all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
            }
        }

        #[test]
        fn every_six_digit_hex_colour_round_trips(digits in "[0-9a-fA-F]{6}") {
            let accent = Accent::parse(&format!("#{digits}")).expect("valid");
            prop_assert_eq!(accent.as_str(), format!("#{}", digits.to_ascii_lowercase()));
        }
    }
}
