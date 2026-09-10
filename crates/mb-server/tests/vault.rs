//! The vault boundary: slugs, config, and path containment.
//!
//! The containment tests are the point. `Vault::resolve` is the only thing between a URL
//! and the filesystem, and AGENTS.md §3.3 is explicit that traversal out of a vault root is
//! a test case rather than a theoretical concern. Symlinks get their own tests because a
//! lexical `..` check cannot see them and an Obsidian vault full of them is ordinary.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

mod support;

use std::ffi::OsStr;

use mb_server::config::{DEFAULT_BIND, ServerConfig, expand_home};
use mb_server::vault::Slug;
use mb_server::{Error, MediaBackendConfig, Vault};
use support::TempDir;

fn vault_at(dir: &TempDir) -> Vault {
    Vault::open(Slug::parse("test").expect("slug"), "Test", dir.path()).expect("open")
}

// ---------------------------------------------------------------- slugs

#[test]
fn a_usable_slug_is_accepted() {
    for good in ["personal", "work-notes", "v2", "a", "a-b-c", "1"] {
        assert!(Slug::parse(good).is_ok(), "{good:?} should be accepted");
        assert_eq!(Slug::parse(good).expect("ok").as_str(), good);
    }
}

#[test]
fn a_slug_that_could_be_read_as_a_path_or_an_escape_is_rejected() {
    // Each of these ends up in a URL and in a filesystem lookup. Narrow beats clever.
    for bad in [
        "",
        "-leading",
        "trailing-",
        "Upper", // would collide on a case-insensitive filesystem
        "with space",
        "with.dot",
        "with/slash",
        "with\\backslash",
        "..",
        "with%20escape",
        "with:colon",
        "emoji🎉",
        "with_underscore",
    ] {
        assert!(
            matches!(Slug::parse(bad), Err(Error::InvalidSlug(_))),
            "{bad:?} should be rejected"
        );
    }
}

#[test]
fn a_slug_is_length_limited() {
    assert!(Slug::parse(&"a".repeat(64)).is_ok());
    assert!(Slug::parse(&"a".repeat(65)).is_err());
}

// ---------------------------------------------------------------- config

#[test]
fn an_absent_config_file_is_an_empty_registry_not_an_error() {
    // Starting a fresh server before registering anything should work and say so.
    let dir = TempDir::new("no-config");
    let config = ServerConfig::load(&dir.path().join("server.toml")).expect("load");
    assert!(config.vaults.is_empty());
    assert_eq!(config.bind_addr().expect("addr").to_string(), DEFAULT_BIND);
}

#[test]
fn the_default_bind_is_loopback() {
    // why: there is no authentication yet. A default of 0.0.0.0 would publish someone's
    // private notes to their whole network the first time they ran it.
    assert!(DEFAULT_BIND.starts_with("127.0.0.1"), "{DEFAULT_BIND}");
    let addr = ServerConfig::default().bind_addr().expect("addr");
    assert!(addr.ip().is_loopback(), "{addr}");
    assert_eq!(addr.port(), 9010, "AGENTS.md §5.1 reserves 9010");
}

#[test]
fn a_config_parses_its_bind_and_vaults() {
    let config = ServerConfig::parse(
        "bind = \"127.0.0.1:9999\"\n\n\
         [[vaults]]\nslug = \"personal\"\nname = \"Personal\"\npath = \"/tmp/a\"\n\n\
         [[vaults]]\nslug = \"work\"\npath = \"/tmp/b\"\n",
    )
    .expect("parse");
    assert_eq!(config.bind_addr().expect("addr").port(), 9999);
    assert_eq!(config.vaults.len(), 2);
    assert_eq!(config.vaults[0].name.as_deref(), Some("Personal"));
    assert_eq!(config.vaults[1].name, None);
}

#[test]
fn an_unknown_config_key_is_an_error_rather_than_ignored() {
    // A silently ignored typo is a setting the user believes is applied and is not.
    let err = ServerConfig::parse("bnid = \"127.0.0.1:1\"\n").expect_err("should reject");
    assert!(matches!(err, Error::Config(_)), "{err}");
}

#[test]
fn malformed_toml_is_reported_as_a_config_error() {
    assert!(matches!(
        ServerConfig::parse("this is not toml {{{").expect_err("should reject"),
        Error::Config(_)
    ));
}

#[test]
fn a_bad_bind_address_is_reported() {
    let config = ServerConfig::parse("bind = \"not an address\"\n").expect("parses");
    assert!(matches!(config.bind_addr(), Err(Error::Config(_))));
}

#[test]
fn a_config_round_trips_through_toml() {
    let original = ServerConfig::parse(
        "bind = \"127.0.0.1:9010\"\n\n[[vaults]]\nslug = \"a\"\nname = \"A\"\npath = \"/tmp/a\"\n",
    )
    .expect("parse");
    let reparsed = ServerConfig::parse(&original.to_toml().expect("to_toml")).expect("reparse");
    assert_eq!(reparsed.vaults, original.vaults);
    assert_eq!(reparsed.bind, original.bind);
}

#[test]
fn a_vault_can_select_an_s3_compatible_media_backend() {
    let dir = TempDir::new("s3-config");
    let source = format!(
        "[[vaults]]\nslug = \"work\"\npath = {:?}\n\n[vaults.media]\nbackend = \"s3\"\nbucket = \"notes\"\nregion = \"us-east-1\"\nendpoint = \"http://127.0.0.1:9000\"\naccess_key_id = \"key\"\nsecret_access_key = \"secret\"\nallow_http = true\n",
        dir.path().display().to_string()
    );
    let config = ServerConfig::parse(&source).expect("parse");
    let vaults = config.open_vaults(None).expect("open");
    assert!(matches!(
        vaults[0].media_backend(),
        MediaBackendConfig::S3 { bucket, allow_http: true, .. } if bucket == "notes"
    ));
    assert!(matches!(
        mb_server::media::Store::new(&vaults[0]).expect("S3 store"),
        mb_server::media::Store::S3(_)
    ));
    let debug = format!("{:?}", vaults[0].media_backend());
    assert!(!debug.contains("\"key\""), "{debug}");
    assert!(!debug.contains("\"secret\""), "{debug}");
}

#[test]
fn calendar_note_config_has_safe_defaults_and_independent_overrides() {
    let dir = TempDir::new("calendar-config");
    let vault = vault_at(&dir);
    assert_eq!(
        vault.daily_note_config(),
        ("Daily".into(), "%Y-%m-%d.md".into())
    );
    assert_eq!(
        vault.weekly_note_config(),
        ("Weekly".into(), "%G-W%V.md".into())
    );
    assert_eq!(
        vault.monthly_note_config(),
        ("Monthly".into(), "%Y-%m.md".into())
    );

    dir.write(
        ".memberberry/config.toml",
        "weekly_folder = \"Journal/Weeks\"\nweekly_note_format = \"%G/%V.md\"\n\
         weekly_note_template = \"Periods/Week.md\"\nmonthly_folder = \"../Outside\"\n",
    );
    assert_eq!(
        vault.weekly_note_config(),
        ("Journal/Weeks".into(), "%G/%V.md".into())
    );
    assert_eq!(vault.weekly_note_template(), "Periods/Week.md");
    assert_eq!(
        vault.monthly_note_config(),
        ("Monthly".into(), "%Y-%m.md".into())
    );
}

#[test]
fn media_dimension_config_is_bounded() {
    let dir = TempDir::new("media-dimension");
    let vault = vault_at(&dir);
    assert_eq!(vault.media_max_dimension(), 2560);
    dir.write(".memberberry/config.toml", "media_max_dimension = 1440\n");
    assert_eq!(vault.media_max_dimension(), 1440);
    dir.write(".memberberry/config.toml", "media_max_dimension = 999999\n");
    assert_eq!(vault.media_max_dimension(), 2560);
}

#[test]
fn history_and_trash_policy_have_safe_configurable_defaults() {
    let dir = TempDir::new("history-trash-config");
    let vault = vault_at(&dir);
    assert!(vault.history_compression());
    assert_eq!(vault.trash_retention_seconds(), 30 * 24 * 60 * 60);

    dir.write(
        ".memberberry/config.toml",
        "history_compression = false\ntrash_retention_days = 14\n",
    );
    assert!(!vault.history_compression());
    assert_eq!(vault.trash_retention_seconds(), 14 * 24 * 60 * 60);

    dir.write(
        ".memberberry/config.toml",
        "history_compression = \"no\"\ntrash_retention_days = 0\n",
    );
    assert!(vault.history_compression());
    assert_eq!(vault.trash_retention_seconds(), 30 * 24 * 60 * 60);
}

#[test]
fn a_duplicate_slug_is_refused() {
    let dir = TempDir::new("dupe");
    let path = dir.path().to_string_lossy().into_owned();
    let config = ServerConfig::parse(&format!(
        "[[vaults]]\nslug = \"same\"\npath = \"{path}\"\n\n\
         [[vaults]]\nslug = \"same\"\npath = \"{path}\"\n"
    ))
    .expect("parse");
    assert!(matches!(
        config.open_vaults(None),
        Err(Error::DuplicateSlug(_))
    ));
}

#[test]
fn a_vault_pointing_at_nothing_fails_at_startup() {
    // Better a loud failure now than a puzzling 404 on the first request.
    let config =
        ServerConfig::parse("[[vaults]]\nslug = \"gone\"\npath = \"/definitely/not/here\"\n")
            .expect("parse");
    assert!(matches!(
        config.open_vaults(None),
        Err(Error::VaultRoot { .. })
    ));
}

#[test]
fn a_vault_pointing_at_a_file_fails_at_startup() {
    let dir = TempDir::new("file-root");
    dir.write("a-file.md", "x\n");
    let path = dir.path().join("a-file.md");
    let config = ServerConfig::parse(&format!(
        "[[vaults]]\nslug = \"f\"\npath = \"{}\"\n",
        path.to_string_lossy()
    ))
    .expect("parse");
    assert!(matches!(
        config.open_vaults(None),
        Err(Error::VaultRootNotADirectory { .. })
    ));
}

#[test]
fn a_home_relative_vault_path_is_expanded() {
    assert_eq!(
        expand_home("~/Notes", Some(OsStr::new("/Users/alice"))),
        std::path::PathBuf::from("/Users/alice/Notes")
    );
    assert_eq!(
        expand_home("~", Some(OsStr::new("/Users/alice"))),
        std::path::PathBuf::from("/Users/alice")
    );
    assert_eq!(
        expand_home("/absolute", Some(OsStr::new("/Users/alice"))),
        std::path::PathBuf::from("/absolute")
    );
    // No HOME: left literal, so the error names the `~` the user actually wrote.
    assert_eq!(
        expand_home("~/Notes", None),
        std::path::PathBuf::from("~/Notes")
    );
}

// ---------------------------------------------------------------- layout

#[test]
fn a_spec_layout_vault_serves_from_its_notes_directory() {
    let dir = TempDir::new("spec-layout");
    dir.write("notes/a.md", "# A\n");
    dir.write("outside.md", "# Outside\n");
    let vault = vault_at(&dir);
    assert_eq!(vault.notes_root(), dir.path().join("notes"));
    assert_eq!(vault.notes().expect("notes"), vec!["a.md"]);
}

#[test]
fn an_obsidian_layout_vault_serves_from_its_root() {
    // SPEC §4.1 puts notes under `notes/`; a real Obsidian vault has them at the root.
    // Refusing that would make the server useless against the only corpus anyone has.
    let dir = TempDir::new("obsidian-layout");
    dir.write("a.md", "# A\n");
    dir.write("folder/b.md", "# B\n");
    let vault = vault_at(&dir);
    assert_eq!(vault.notes_root(), dir.path());
    assert_eq!(vault.notes().expect("notes"), vec!["a.md", "folder/b.md"]);
}

#[test]
fn listing_skips_dot_directories_and_non_markdown() {
    let dir = TempDir::new("listing");
    dir.write("note.md", "x\n");
    dir.write(".obsidian/config.md", "x\n");
    dir.write(".memberberry/cache.md", "x\n");
    dir.write("image.png", "not markdown");
    dir.write("nested/deep/c.md", "x\n");
    let vault = vault_at(&dir);
    assert_eq!(
        vault.notes().expect("notes"),
        vec!["nested/deep/c.md", "note.md"]
    );
}

#[test]
fn listing_an_empty_vault_yields_nothing() {
    let dir = TempDir::new("empty");
    assert!(vault_at(&dir).notes().expect("notes").is_empty());
}

// ---------------------------------------------------------------- containment

#[test]
fn a_note_inside_the_vault_resolves() {
    let dir = TempDir::new("resolve");
    let written = dir.write("folder/note.md", "x\n");
    let vault = vault_at(&dir);
    let resolved = vault.resolve("folder/note.md").expect("should resolve");
    assert_eq!(
        resolved.canonicalize().expect("canonical"),
        written.canonicalize().expect("canonical")
    );
}

#[test]
fn a_traversal_out_of_the_vault_is_refused() {
    // AGENTS.md §3.3. The secret file exists and is readable; only containment stops it.
    //
    // Mutation-checked: deleting the lexical `..` pre-filter in `resolve` leaves every case
    // here passing, because the canonicalize-and-compare below it does the real work. The
    // symlink test is the one that pins that check.
    let outer = TempDir::new("traversal-outer");
    outer.write("secret.md", "# Secret\n");
    let dir = TempDir::new("traversal-inner");
    dir.write("ok.md", "x\n");
    let vault = vault_at(&dir);

    for attempt in [
        "../secret.md",
        "../../etc/passwd",
        "folder/../../secret.md",
        "./../secret.md",
        "/etc/passwd",
        "/",
        "..",
    ] {
        assert!(
            matches!(vault.resolve(attempt), Err(Error::NotFound)),
            "{attempt:?} should not resolve"
        );
    }
}

#[test]
fn a_symlink_pointing_out_of_the_vault_is_refused() {
    // The case a lexical `..` check cannot see. Canonicalizing and re-checking the prefix is
    // what catches it, and vaults full of symlinks are ordinary.
    let outer = TempDir::new("symlink-outer");
    let secret = outer.write("secret.md", "# Secret\n");
    let dir = TempDir::new("symlink-inner");
    let link = dir.path().join("escape.md");

    #[cfg(unix)]
    std::os::unix::fs::symlink(&secret, &link).expect("creating the symlink");
    #[cfg(not(unix))]
    {
        let _ = (&secret, &link);
        return;
    }

    let vault = vault_at(&dir);
    assert!(
        matches!(vault.resolve("escape.md"), Err(Error::NotFound)),
        "a symlink out of the vault must not resolve"
    );
}

#[test]
fn a_symlink_pointing_out_of_the_vault_is_not_listed_either() {
    // Regression, and a leak. `resolve` refused this file all along, but `notes()` listed
    // it — and `notes()` is what the index is built from, so the *content* of a file the
    // note route will not serve was being indexed: its title, its tags, and the text of any
    // block containing a link, which came back out as a backlink's context. Found while
    // building transclusion, where the same listing decides what an `![[…]]` can name.
    let outer = TempDir::new("symlink-list-outer");
    let secret = outer.write("secret.md", "# Secret Outside\n");
    let dir = TempDir::new("symlink-list-inner");
    dir.write("Real.md", "# Real\n");
    let link = dir.path().join("Escape.md");

    #[cfg(unix)]
    std::os::unix::fs::symlink(&secret, &link).expect("creating the symlink");
    #[cfg(not(unix))]
    {
        let _ = (&secret, &link);
        return;
    }

    assert_eq!(
        vault_at(&dir).notes().expect("notes"),
        vec!["Real.md".to_string()],
        "a listing that names a file the vault will not serve is a listing nothing can trust"
    );
}

#[test]
fn a_symlinked_directory_pointing_out_of_the_vault_is_not_walked() {
    let outer = TempDir::new("symlink-dir-outer");
    outer.write("inside/secret.md", "# Secret Outside\n");
    let dir = TempDir::new("symlink-dir-inner");
    dir.write("Real.md", "# Real\n");
    let link = dir.path().join("Linked");

    #[cfg(unix)]
    std::os::unix::fs::symlink(outer.path().join("inside"), &link).expect("creating the symlink");
    #[cfg(not(unix))]
    {
        let _ = &link;
        return;
    }

    assert_eq!(
        vault_at(&dir).notes().expect("notes"),
        vec!["Real.md".to_string()],
        "walking a symlinked directory indexes a whole tree from outside the vault"
    );
}

#[test]
fn a_symlink_staying_inside_the_vault_is_still_listed() {
    // Containment must not become "no symlinks at all" — vaults full of symlinks are
    // ordinary, and this is the counterpart of the resolve case below.
    let dir = TempDir::new("symlink-list-ok");
    let target = dir.write("Real.md", "# Real\n");
    let link = dir.path().join("Alias.md");

    #[cfg(unix)]
    std::os::unix::fs::symlink(&target, &link).expect("creating the symlink");
    #[cfg(not(unix))]
    {
        let _ = (&target, &link);
        return;
    }

    assert_eq!(
        vault_at(&dir).notes().expect("notes"),
        vec!["Alias.md".to_string(), "Real.md".to_string()]
    );
}

#[test]
fn a_symlink_staying_inside_the_vault_still_resolves() {
    // Containment must not become "no symlinks at all" — that would break ordinary vaults.
    let dir = TempDir::new("symlink-inside");
    let target = dir.write("real.md", "# Real\n");
    let link = dir.path().join("alias.md");

    #[cfg(unix)]
    std::os::unix::fs::symlink(&target, &link).expect("creating the symlink");
    #[cfg(not(unix))]
    {
        let _ = (&target, &link);
        return;
    }

    let vault = vault_at(&dir);
    assert!(
        vault.resolve("alias.md").is_ok(),
        "an internal symlink should resolve"
    );
}

#[test]
fn a_directory_does_not_resolve_as_a_note() {
    let dir = TempDir::new("dir-not-note");
    dir.write("folder/note.md", "x\n");
    assert!(matches!(
        vault_at(&dir).resolve("folder"),
        Err(Error::NotFound)
    ));
}

#[test]
fn a_missing_note_does_not_resolve() {
    let dir = TempDir::new("missing");
    assert!(matches!(
        vault_at(&dir).resolve("nope.md"),
        Err(Error::NotFound)
    ));
}

#[test]
fn a_dotted_path_is_not_served_even_though_it_exists() {
    // Found by pointing the server at a real Obsidian vault: `notes()` skipped dotfiles but
    // `resolve()` did not, so `.git/config` — which can hold a remote URL with credentials
    // in it — was served on request while never appearing in any listing. Listing and
    // serving have to agree, or the thing you cannot see is the thing you can still fetch.
    let dir = TempDir::new("dotfiles");
    dir.write(
        ".git/config",
        "[core]\n\turl = https://user:token@example.com\n",
    );
    dir.write(".obsidian/graph.json", "{}\n");
    dir.write(".hidden.md", "# Hidden\n");
    dir.write("visible.md", "# Visible\n");
    let vault = vault_at(&dir);

    assert_eq!(vault.notes().expect("notes"), vec!["visible.md"]);
    for hidden in [".git/config", ".obsidian/graph.json", ".hidden.md"] {
        assert!(
            matches!(vault.resolve(hidden), Err(Error::NotFound)),
            "{hidden} must not resolve"
        );
    }
    assert!(vault.resolve("visible.md").is_ok());
}

#[test]
fn only_markdown_is_served() {
    // A vault holds images, PDFs and `.excalidraw` JSON. The note route renders Markdown;
    // anything else needs its own route with its own content type, which M0 does not have.
    let dir = TempDir::new("extensions");
    dir.write("note.md", "# A\n");
    dir.write("data.json", "{}\n");
    dir.write("image.png", "not really");
    dir.write("no-extension", "x");
    let vault = vault_at(&dir);

    assert!(vault.resolve("note.md").is_ok());
    for other in ["data.json", "image.png", "no-extension"] {
        assert!(
            matches!(vault.resolve(other), Err(Error::NotFound)),
            "{other} must not resolve as a note"
        );
    }
}

#[test]
fn everything_listed_can_be_resolved() {
    // The invariant the leak broke: the listing and the serving agree.
    let dir = TempDir::new("listing-agrees");
    dir.write("a.md", "x\n");
    dir.write("folder/b.md", "x\n");
    dir.write(".git/config", "x\n");
    dir.write("image.png", "x");
    let vault = vault_at(&dir);
    for rel in vault.notes().expect("notes") {
        assert!(
            vault.resolve(&rel).is_ok(),
            "{rel} was listed but does not resolve"
        );
    }
}

// ---------------------------------------------------------------- name resolution

#[test]
fn a_wikilink_name_resolves_to_a_note_anywhere_in_the_vault() {
    // SPEC §4.3: links are written by human-readable name, and the index maintains
    // `name -> path`. `[[Daily]]` in a vault where the note lives at `todos/Daily.md` has to
    // find it — resolving by literal path alone means every wikilink in a foldered vault
    // is a dead link.
    let dir = TempDir::new("by-name");
    dir.write("todos/Daily.md", "# Daily\n");
    dir.write("projects/deep/Nested Note.md", "# Nested\n");
    let vault = vault_at(&dir);

    assert_eq!(
        vault.find_by_name("Daily").as_deref(),
        Some("todos/Daily.md")
    );
    assert_eq!(
        vault.find_by_name("Nested Note").as_deref(),
        Some("projects/deep/Nested Note.md")
    );
    // A name written with its extension, or with its path, works too.
    assert_eq!(
        vault.find_by_name("Daily.md").as_deref(),
        Some("todos/Daily.md")
    );
    assert_eq!(
        vault.find_by_name("todos/Daily").as_deref(),
        Some("todos/Daily.md")
    );
}

#[test]
fn a_name_collision_resolves_to_the_shallowest_path() {
    // §4.3 says nearest-path wins. Without the index that decides "nearest to the linking
    // note", the shallowest is the closest stand-in, and it is at least deterministic.
    let dir = TempDir::new("collision");
    dir.write("deep/deeper/Note.md", "# Deep\n");
    dir.write("Note.md", "# Shallow\n");
    let vault = vault_at(&dir);
    assert_eq!(vault.find_by_name("Note").as_deref(), Some("Note.md"));
}

#[test]
fn an_unresolvable_name_finds_nothing() {
    let dir = TempDir::new("no-name");
    dir.write("a.md", "# A\n");
    assert_eq!(vault_at(&dir).find_by_name("Nonexistent"), None);
}

#[test]
fn name_resolution_cannot_be_used_to_escape_the_vault() {
    // It searches a listing that already excludes dotfiles and traversal, but assert it:
    // a second lookup path is a second chance to get containment wrong.
    let dir = TempDir::new("name-escape");
    dir.write(".git/config", "secret\n");
    dir.write("a.md", "# A\n");
    let vault = vault_at(&dir);
    assert_eq!(vault.find_by_name("config"), None);
    assert_eq!(vault.find_by_name("../../etc/passwd"), None);
    assert_eq!(vault.find_by_name("passwd"), None);
}

#[test]
fn a_name_resolves_across_unicode_normalisation_forms() {
    // Found against a real vault on macOS. APFS stores `Çınar Fidanboy.md` decomposed
    // (NFD: `C` + a combining cedilla), while the `[[Çınar Fidanboy]]` typed into a note is
    // composed (NFC). Byte comparison says those are different names, so every note with an
    // accented title was unreachable through its own wikilink.
    let nfc = "Ç\u{131}nar Fidanboy"; // Ç as one codepoint
    let nfd = "C\u{327}\u{131}nar Fidanboy"; // C + combining cedilla

    let dir = TempDir::new("nfd");
    dir.write(&format!("people/{nfd}.md"), "# Name\n");
    let vault = vault_at(&dir);

    // Whichever way the file landed on disk, both spellings of the link must find it.
    assert!(
        vault.find_by_name(nfc).is_some(),
        "NFC link should find an NFD file"
    );
    assert!(
        vault.find_by_name(nfd).is_some(),
        "NFD link should find an NFD file"
    );

    // And the reverse, for a filesystem that stores composed names.
    let dir = TempDir::new("nfc");
    dir.write(&format!("people/{nfc}.md"), "# Name\n");
    let vault = vault_at(&dir);
    assert!(
        vault.find_by_name(nfd).is_some(),
        "NFD link should find an NFC file"
    );
    assert!(
        vault.find_by_name(nfc).is_some(),
        "NFC link should find an NFC file"
    );
}
