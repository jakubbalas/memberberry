//! `memberberry` — the command line, as a library.
//!
//! Only completed commands are exposed. Everything else belongs to later milestones and is
//! deliberately absent rather than stubbed: a command that prints "not implemented" is
//! worse than one that does not exist, because it looks like a feature in `--help`.
//!
//! The logic lives here rather than in `main.rs` so it can be tested without spawning a
//! process. Output goes to an injected [`Write`] and input comes from an injected [`Read`]
//! for the same reason — `normalize` rewrites the user's notes in place, which makes it the
//! code in this repository most able to destroy data, and it was the least tested.

use std::ffi::OsStr;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

pub const USAGE: &str = "\
memberberry — self-hosted notes that stay plain Markdown

USAGE:
    memberberry serve [--config FILE]           Serve the registered vaults, read-only
    memberberry vault list [--config FILE]      Show the registry
    memberberry vault create --slug S --path P --actor A  Register a vault (server admin)
    memberberry vault remove --slug S --actor A           Unregister a vault (server admin; never deletes notes)
    memberberry user setup --username U         Create the first server administrator
    memberberry user reset-password --username U --actor A  Replace a user's password
    memberberry normalize [--check] [PATH]...   Rewrite notes into canonical Markdown
    memberberry inspect [PATH]                  Show the parsed structure of one note
    memberberry reindex [--slug S] [--config FILE]  Rebuild a vault's index from its notes
    memberberry export --materialize-media [--slug S]  Download referenced S3 media into the vault
    memberberry doctor [--slug S] [--config FILE]   Report orphaned media objects
    memberberry gen-vault --out DIR [--notes N] Generate a synthetic vault for scale tests

With no PATH, `normalize` and `inspect` read stdin and write stdout.

    --check     Report which files would change; write nothing. Exits 1 if any would.
    --config    Path to server.toml. Defaults to $MEMBERBERRY_DATA_DIR/server.toml,
                or ./server.toml.
    --name      Display name for a vault. Defaults to the slug.
    --password-stdin
                Read the password from stdin instead of prompting on the terminal, for
                scripted provisioning. `reset-password` expects two lines: the
                administrator's password, then the new one. The password is never taken
                from an argument, where it would land in the process list.

`serve` authenticates every content route and binds to 127.0.0.1:9010 by default.
";

/// The flag that turns a terminal password prompt into a read from stdin.
///
/// why: no-echo prompting is the right default for a human, and wrong for everything else.
/// The password still never appears in `argv` — it is read from the pipe, the same way
/// `docker login --password-stdin` and `gh auth login --with-token` do it.
pub const PASSWORD_STDIN_FLAG: &str = "--password-stdin";

/// Whether this invocation needs a no-echo prompt on the controlling terminal.
///
/// Lives here rather than in `main.rs` so it can be tested: it decides whether a password is
/// read from a human or from a pipe, and getting that backwards either wedges a script
/// waiting on `/dev/tty` or silently prompts where no terminal exists.
#[must_use]
pub fn reads_password_from_terminal(args: &[String]) -> bool {
    if args.iter().any(|arg| arg == PASSWORD_STDIN_FLAG) {
        return false;
    }
    let command = args.first().map(String::as_str);
    let subcommand = args.get(1).map(String::as_str);
    matches!(
        (command, subcommand),
        (Some("user"), Some("setup" | "reset-password"))
            | (Some("vault"), Some("create" | "remove"))
    )
}

/// Runs one command.
///
/// # Errors
///
/// Returns a human-readable message for an unknown command, a bad argument, or any I/O
/// failure. The caller prints it and exits non-zero.
pub fn run(args: &[String], stdin: &mut dyn Read, out: &mut dyn Write) -> Result<ExitCode, String> {
    let rest = args.get(1..).unwrap_or(&[]);
    match args.first().map(String::as_str) {
        Some("serve") => serve(rest, out),
        Some("vault") => vault(rest, stdin, out),
        Some("user") => user(rest, stdin, out),
        Some("normalize") => normalize(rest, stdin, out),
        Some("inspect") => inspect(rest, stdin, out),
        Some("gen-vault") => gen_vault(rest, out),
        Some("reindex") => reindex(rest, out),
        Some("export") => export(rest, out),
        Some("doctor") => doctor(rest, out),
        Some("--help" | "-h" | "help") | None => {
            write!(out, "{USAGE}").map_err(io("writing usage"))?;
            Ok(ExitCode::SUCCESS)
        }
        Some(other) => Err(format!("unknown command `{other}`\n\n{USAGE}")),
    }
}

fn io(what: &str) -> impl Fn(std::io::Error) -> String + '_ {
    move |e| format!("{what}: {e}")
}

/// Locates `server.toml`.
///
/// `--config` wins, then `$MEMBERBERRY_DATA_DIR/server.toml`, then `./server.toml`. The
/// data directory is server-owned and never inside a vault (`SPEC.md` §4.1).
fn config_path(args: &[String]) -> PathBuf {
    config_path_in(args, std::env::var_os("MEMBERBERRY_DATA_DIR").as_deref())
}

/// The pure half, so the precedence can be tested without touching the environment —
/// which the workspace forbids anyway (`unsafe_code = "forbid"`), and which would make
/// parallel tests race.
pub(crate) fn config_path_in(args: &[String], data_dir: Option<&OsStr>) -> PathBuf {
    if let Some(explicit) = flag(args, "--config") {
        return PathBuf::from(explicit);
    }
    match data_dir {
        Some(dir) => Path::new(dir).join("server.toml"),
        None => PathBuf::from("server.toml"),
    }
}

/// Serves the registered vaults, read-only.
fn serve(args: &[String], out: &mut dyn Write) -> Result<ExitCode, String> {
    let path = config_path(args);
    let config = mb_server::ServerConfig::load(&path).map_err(|e| e.to_string())?;
    let vaults = config
        .open_vaults(std::env::var_os("HOME").as_deref())
        .map_err(|e| e.to_string())?;
    let addr = config.bind_addr().map_err(|e| e.to_string())?;
    let auth_path = auth_db_path(args);
    let auth = mb_auth::AuthDb::open(&auth_path).map_err(|error| error.to_string())?;
    if auth.needs_setup().map_err(|error| error.to_string())? {
        return Err(format!(
            "no server administrator exists; run `memberberry user setup --config {}` first",
            path.display()
        ));
    }

    if vaults.is_empty() {
        writeln!(
            out,
            "No vaults registered in {}. Add one with:\n  \
             memberberry vault create --slug personal --path ~/Notes",
            path.display()
        )
        .map_err(io("writing report"))?;
    } else {
        for v in &vaults {
            writeln!(out, "vault {} -> {}", v.slug(), v.notes_root().display())
                .map_err(io("writing report"))?;
        }
    }

    // Everything above is this command's own report, and it is flushed before the server
    // starts. The server prints from inside the runtime, so an unflushed buffer here would
    // put the vault list *after* "listening" — the startup output would read in an order
    // that never happened.
    out.flush().map_err(io("flushing the startup report"))?;

    // why: a multi-thread runtime built here rather than `#[tokio::main]` on `main`, so the
    // async runtime exists only for the command that needs one. Nothing else in this binary
    // is async, and `normalize` should not pay for a thread pool.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("starting the async runtime: {e}"))?;
    let data_dir = auth_path.parent().unwrap_or_else(|| Path::new("."));
    let audit = mb_server::audit::AuditLog::new(data_dir, 10 * 1024 * 1024)
        .map_err(|error| error.to_string())?;
    let web_root = config
        .web_root
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("web/dist"));
    let state = std::sync::Arc::new(
        mb_server::http::AppState::authenticated_with_audit_and_web_root(
            vaults,
            auth,
            Some(audit),
            web_root,
        )
        .map_err(|error| error.to_string())?
        .with_data_dir(data_dir.to_path_buf()),
    );
    runtime
        .block_on(mb_server::http::serve(state, addr))
        .map_err(|e| e.to_string())?;
    Ok(ExitCode::SUCCESS)
}

/// `memberberry reindex` — rebuild the derived index from the notes (`SPEC.md` §9.1).
///
/// Needs no authentication, and that is not an oversight: it reads the vault's own files and
/// writes only `.memberberry/index/`, which is exactly what the server does unprompted on
/// every start. It grants no read access to anything — the index has no unfiltered query, so
/// building one discloses nothing (E5).
///
/// Rebuilding is normally unnecessary. It exists for the two cases where it is the answer: a
/// vault whose files were replaced wholesale underneath a running server, and someone who
/// wants the index rebuilt without waiting for the sweep.
fn reindex(args: &[String], out: &mut dyn Write) -> Result<ExitCode, String> {
    let path = config_path(args);
    let config = mb_server::ServerConfig::load(&path).map_err(|error| error.to_string())?;
    let vaults = config
        .open_vaults(std::env::var_os("HOME").as_deref())
        .map_err(|error| error.to_string())?;
    let wanted = flag(args, "--slug");
    let selected: Vec<&mb_server::Vault> = vaults
        .iter()
        .filter(|vault| wanted.is_none_or(|slug| vault.slug().as_str() == slug))
        .collect();
    if selected.is_empty() {
        return Err(match wanted {
            Some(slug) => format!("no vault `{slug}` in {}", path.display()),
            None => format!("no vaults registered in {}", path.display()),
        });
    }

    let registry = mb_server::indexing::IndexRegistry::default();
    let mut failed = false;
    for vault in selected {
        // Dropped first, so the rebuild starts from nothing rather than from whatever the
        // last run left. A stale row is exactly what someone running this wants gone.
        let database = vault.root().join(".memberberry/index/graph.sqlite");
        if database.exists()
            && let Err(error) = fs::remove_file(&database)
        {
            writeln!(out, "vault {}: {error}", vault.slug()).map_err(io("writing report"))?;
            failed = true;
            continue;
        }
        let errors = registry.maintain(std::iter::once(vault), &mb_server::watch::Changes::All);
        for error in &errors {
            writeln!(out, "{error}").map_err(io("writing report"))?;
        }
        failed |= !errors.is_empty();
        let notes = vault.notes().map_or(0, |notes| notes.len());
        writeln!(out, "vault {}: indexed {notes} notes", vault.slug())
            .map_err(io("writing report"))?;
    }
    Ok(if failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    })
}

fn selected_vaults<'a>(
    args: &[String],
    config_path: &Path,
    vaults: &'a [mb_server::Vault],
) -> Result<Vec<&'a mb_server::Vault>, String> {
    let wanted = flag(args, "--slug");
    let selected: Vec<_> = vaults
        .iter()
        .filter(|vault| wanted.is_none_or(|slug| vault.slug().as_str() == slug))
        .collect();
    if selected.is_empty() {
        Err(match wanted {
            Some(slug) => format!("no vault `{slug}` in {}", config_path.display()),
            None => format!("no vaults registered in {}", config_path.display()),
        })
    } else {
        Ok(selected)
    }
}

fn media_runtime() -> Result<tokio::runtime::Runtime, String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("starting the media runtime: {error}"))
}

fn export(args: &[String], out: &mut dyn Write) -> Result<ExitCode, String> {
    if !args.iter().any(|arg| arg == "--materialize-media") {
        return Err("export currently needs --materialize-media".to_string());
    }
    let path = config_path(args);
    let config = mb_server::ServerConfig::load(&path).map_err(|error| error.to_string())?;
    let vaults = config
        .open_vaults(std::env::var_os("HOME").as_deref())
        .map_err(|error| error.to_string())?;
    let selected = selected_vaults(args, &path, &vaults)?;
    let runtime = media_runtime()?;
    for vault in selected {
        let written = runtime
            .block_on(mb_server::media::materialize(vault))
            .map_err(|error| error.to_string())?;
        writeln!(
            out,
            "vault {}: materialized {written} media objects",
            vault.slug()
        )
        .map_err(io("writing report"))?;
    }
    Ok(ExitCode::SUCCESS)
}

fn doctor(args: &[String], out: &mut dyn Write) -> Result<ExitCode, String> {
    let path = config_path(args);
    let config = mb_server::ServerConfig::load(&path).map_err(|error| error.to_string())?;
    let vaults = config
        .open_vaults(std::env::var_os("HOME").as_deref())
        .map_err(|error| error.to_string())?;
    let selected = selected_vaults(args, &path, &vaults)?;
    let runtime = media_runtime()?;
    let mut found = false;
    for vault in selected {
        for path in runtime
            .block_on(mb_server::media::orphaned(vault))
            .map_err(|error| error.to_string())?
        {
            found = true;
            writeln!(out, "vault {}: orphaned media {path}", vault.slug())
                .map_err(io("writing report"))?;
        }
    }
    if !found {
        writeln!(out, "media: no orphaned objects").map_err(io("writing report"))?;
    }
    Ok(if found {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    })
}

/// `memberberry vault {list, create, remove}` — the registry (`SPEC.md` §6.1).
fn vault(args: &[String], stdin: &mut dyn Read, out: &mut dyn Write) -> Result<ExitCode, String> {
    let path = config_path(args);
    match args.first().map(String::as_str) {
        Some("list") => vault_list(&path, out),
        Some("create") => vault_create(args, stdin, &path, out),
        Some("remove") => vault_remove(args, stdin, &path, out),
        Some(other) => Err(format!(
            "unknown vault command `{other}`: expected list, create or remove"
        )),
        None => Err("vault needs a subcommand: list, create or remove".to_string()),
    }
}

/// `memberberry user` commands backed by the server-level `auth.db` (`SPEC.md` §6.8).
fn user(args: &[String], stdin: &mut dyn Read, out: &mut dyn Write) -> Result<ExitCode, String> {
    let database = auth_db_path(args);
    match args.first().map(String::as_str) {
        Some("setup") => user_setup(args, stdin, out, &database),
        Some("reset-password") => user_reset_password(args, stdin, out, &database),
        Some(other) => Err(format!(
            "unknown user command `{other}`: expected setup or reset-password"
        )),
        None => Err("user needs a subcommand: setup or reset-password".to_string()),
    }
}

fn user_setup(
    args: &[String],
    stdin: &mut dyn Read,
    out: &mut dyn Write,
    database: &Path,
) -> Result<ExitCode, String> {
    let username = flag(args, "--username").ok_or("user setup needs --username USER")?;
    let display_name = flag(args, "--display-name").map_or(username.as_str(), String::as_str);
    let password = read_password(stdin)?;
    let mut auth = mb_auth::AuthDb::open(database).map_err(|error| error.to_string())?;
    let user = auth
        .setup_first_user(mb_auth::NewUser {
            username,
            display_name,
            password: &password,
        })
        .map_err(|error| error.to_string())?;
    writeln!(out, "created server administrator {}", user.username).map_err(io("writing"))?;
    Ok(ExitCode::SUCCESS)
}

fn user_reset_password(
    args: &[String],
    stdin: &mut dyn Read,
    out: &mut dyn Write,
    database: &Path,
) -> Result<ExitCode, String> {
    let username = flag(args, "--username").ok_or("user reset-password needs --username USER")?;
    let actor = flag(args, "--actor").ok_or("user reset-password needs --actor ADMIN")?;
    let (admin_password, password) = read_password_pair(stdin)?;
    let auth = mb_auth::AuthDb::open(database).map_err(|error| error.to_string())?;
    let admin = auth
        .authenticate(actor, &admin_password)
        .map_err(|error| error.to_string())?;
    if !admin.is_some_and(|user| user.is_admin) {
        append_audit(
            database,
            Some(actor),
            std::slice::from_ref(username),
            mb_server::audit::AuditAction::PasswordReset,
            mb_server::audit::AuditResult::Denied,
        )?;
        return Err("administrator authentication failed".to_string());
    }
    let user = auth
        .user_by_username(username)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "unknown user".to_string());
    let user = match user {
        Ok(user) => user,
        Err(error) => {
            append_audit(
                database,
                Some(actor),
                std::slice::from_ref(username),
                mb_server::audit::AuditAction::PasswordReset,
                mb_server::audit::AuditResult::Denied,
            )?;
            return Err(error);
        }
    };
    if let Err(error) = auth.reset_password(user.id, &password) {
        append_audit(
            database,
            Some(actor),
            std::slice::from_ref(&user.username),
            mb_server::audit::AuditAction::PasswordReset,
            mb_server::audit::AuditResult::Failure,
        )?;
        return Err(error.to_string());
    }
    append_audit(
        database,
        Some(actor),
        std::slice::from_ref(&user.username),
        mb_server::audit::AuditAction::PasswordReset,
        mb_server::audit::AuditResult::Success,
    )?;
    writeln!(out, "password reset for {}", user.username).map_err(io("writing"))?;
    Ok(ExitCode::SUCCESS)
}

fn append_audit(
    database: &Path,
    actor: Option<&str>,
    targets: &[String],
    action: mb_server::audit::AuditAction,
    result: mb_server::audit::AuditResult,
) -> Result<(), String> {
    let data_dir = database.parent().unwrap_or_else(|| Path::new("."));
    let audit = mb_server::audit::AuditLog::new(data_dir, 10 * 1024 * 1024)
        .map_err(|error| error.to_string())?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("reading system clock: {error}"))?
        .as_secs()
        .to_string();
    audit
        .append(&mb_server::audit::AuditEvent {
            timestamp: &timestamp,
            actor,
            source_ip: None,
            vault: None,
            action,
            targets,
            result,
        })
        .map_err(|error| error.to_string())
}

fn auth_db_path(args: &[String]) -> PathBuf {
    let config = config_path(args);
    config
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
        .join("auth.db")
}

fn read_password(stdin: &mut dyn Read) -> Result<String, String> {
    let mut password = String::new();
    stdin
        .read_to_string(&mut password)
        .map_err(io("reading password"))?;
    while password.ends_with(['\r', '\n']) {
        password.pop();
    }
    if password.is_empty() {
        return Err("password input was empty".to_string());
    }
    Ok(password)
}

fn read_password_pair(stdin: &mut dyn Read) -> Result<(String, String), String> {
    let mut input = String::new();
    stdin
        .read_to_string(&mut input)
        .map_err(io("reading passwords"))?;
    let mut lines = input.lines();
    let admin_password = lines
        .next()
        .filter(|value| !value.is_empty())
        .ok_or("administrator password input was empty")?
        .to_string();
    let password = lines
        .next()
        .filter(|value| !value.is_empty())
        .ok_or("new password input was empty")?
        .to_string();
    if lines.next().is_some() {
        return Err("password reset expects exactly two password lines".to_string());
    }
    Ok((admin_password, password))
}

fn vault_list(path: &Path, out: &mut dyn Write) -> Result<ExitCode, String> {
    let config = mb_server::ServerConfig::load(path).map_err(|e| e.to_string())?;
    if config.vaults.is_empty() {
        writeln!(out, "no vaults registered in {}", path.display()).map_err(io("writing"))?;
        return Ok(ExitCode::SUCCESS);
    }
    for entry in &config.vaults {
        let name = entry.name.as_deref().unwrap_or(&entry.slug);
        writeln!(out, "{:<16} {:<24} {}", entry.slug, name, entry.path).map_err(io("writing"))?;
    }
    Ok(ExitCode::SUCCESS)
}

fn vault_create(
    args: &[String],
    stdin: &mut dyn Read,
    path: &Path,
    out: &mut dyn Write,
) -> Result<ExitCode, String> {
    let slug = flag(args, "--slug").ok_or("vault create needs --slug NAME")?;
    let vault_path = flag(args, "--path").ok_or("vault create needs --path DIR")?;
    // Parse the slug before touching the config, so a bad one never reaches the file.
    mb_server::Slug::parse(slug).map_err(|e| e.to_string())?;

    let mut config = mb_server::ServerConfig::load(path).map_err(|e| e.to_string())?;
    if config.vaults.iter().any(|v| &v.slug == slug) {
        return Err(format!("vault `{slug}` is already registered"));
    }
    config.vaults.push(mb_server::config::VaultEntry {
        slug: slug.clone(),
        name: flag(args, "--name").cloned(),
        path: vault_path.clone(),
        media: mb_server::MediaBackendConfig::Local,
    });
    // Opening every vault before writing means a bad path is rejected now rather than at
    // the next `serve`, when the message is further from the mistake.
    let opened = config
        .open_vaults(std::env::var_os("HOME").as_deref())
        .map_err(|e| e.to_string())?;
    let actor = require_server_admin(args, stdin, "vault create")?;
    let vault = opened
        .last()
        .ok_or("vault create did not open the vault it was registering")?;
    let access_path = vault.root().join("access.toml");
    let access_exists = access_path
        .try_exists()
        .map_err(|error| format!("checking {}: {error}", access_path.display()))?;
    if !access_exists {
        let owner = mb_core::Username::parse(&actor.username).map_err(|error| error.to_string())?;
        let policy = mb_core::Access::new(
            vec![mb_core::Member {
                user: owner,
                role: mb_core::Role::Owner,
            }],
            Vec::new(),
        )
        .map_err(|error| error.to_string())?;
        mb_server::AccessFile::from_access(policy)
            .save(vault.root())
            .map_err(|error| error.to_string())?;
    }
    write_config(path, &config)?;
    append_audit(
        &auth_db_path(args),
        Some(&actor.username),
        std::slice::from_ref(slug),
        mb_server::audit::AuditAction::VaultCreated,
        mb_server::audit::AuditResult::Success,
    )?;
    writeln!(out, "registered `{slug}` -> {vault_path}").map_err(io("writing"))?;
    Ok(ExitCode::SUCCESS)
}

fn vault_remove(
    args: &[String],
    stdin: &mut dyn Read,
    path: &Path,
    out: &mut dyn Write,
) -> Result<ExitCode, String> {
    let slug = flag(args, "--slug").ok_or("vault remove needs --slug NAME")?;
    let mut config = mb_server::ServerConfig::load(path).map_err(|e| e.to_string())?;
    let before = config.vaults.len();
    config.vaults.retain(|v| &v.slug != slug);
    if config.vaults.len() == before {
        return Err(format!("no vault registered as `{slug}`"));
    }
    let actor = require_server_admin(args, stdin, "vault remove")?;
    write_config(path, &config)?;
    append_audit(
        &auth_db_path(args),
        Some(&actor.username),
        std::slice::from_ref(slug),
        mb_server::audit::AuditAction::VaultRemoved,
        mb_server::audit::AuditResult::Success,
    )?;
    // why: say it plainly. "remove" is alarming next to a directory full of one's notes.
    writeln!(
        out,
        "unregistered `{slug}` — the notes on disk were not touched"
    )
    .map_err(io("writing"))?;
    Ok(ExitCode::SUCCESS)
}

/// Authenticates a server administrator for a local management operation.
///
/// Vault registration is server administration, not a filesystem convenience: a local
/// caller must not be able to create an unaudited content surface merely by invoking the
/// CLI. The authenticated identity never bypasses a vault's own `access.toml`.
fn require_server_admin(
    args: &[String],
    stdin: &mut dyn Read,
    action: &str,
) -> Result<mb_auth::User, String> {
    let actor = flag(args, "--actor").ok_or_else(|| format!("{action} needs --actor ADMIN"))?;
    let password = read_password(stdin)?;
    let database = auth_db_path(args);
    let auth = mb_auth::AuthDb::open(&database).map_err(|error| error.to_string())?;
    match auth
        .authenticate(actor, &password)
        .map_err(|error| error.to_string())?
    {
        Some(user) if user.is_admin => Ok(user),
        _ => {
            append_audit(
                &database,
                Some(actor),
                &[],
                if action == "vault create" {
                    mb_server::audit::AuditAction::VaultCreated
                } else {
                    mb_server::audit::AuditAction::VaultRemoved
                },
                mb_server::audit::AuditResult::Denied,
            )?;
            Err("server administrator authentication failed".to_string())
        }
    }
}

fn write_config(path: &Path, config: &mb_server::ServerConfig) -> Result<(), String> {
    let text = config.to_toml().map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("creating {}: {e}", parent.display()))?;
    }
    let temp = path.with_extension("toml.tmp");
    fs::write(&temp, text).map_err(|e| format!("writing {}: {e}", temp.display()))?;
    fs::rename(&temp, path).map_err(|e| format!("renaming into {}: {e}", path.display()))
}

/// Rewrites notes into canonical form (`SPEC.md` §4.5).
///
/// `--check` exists for CI and for the "one-time git diff" migration described in the spec:
/// it tells you what a normalise would touch before you commit to it.
fn normalize(
    args: &[String],
    stdin: &mut dyn Read,
    out: &mut dyn Write,
) -> Result<ExitCode, String> {
    let check = args.iter().any(|a| a == "--check");
    let paths: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();

    if paths.is_empty() {
        let mut input = String::new();
        stdin
            .read_to_string(&mut input)
            .map_err(io("reading stdin"))?;
        out.write_all(mb_core::normalize(&input).as_bytes())
            .map_err(io("writing stdout"))?;
        return Ok(ExitCode::SUCCESS);
    }

    let mut changed = Vec::new();
    for path in paths {
        let root = expand_home(path)?;
        for file in markdown_files(&root)? {
            let original = fs::read_to_string(&file)
                .map_err(|e| format!("reading {}: {e}", file.display()))?;
            let canonical = mb_core::normalize(&original);
            if canonical == original {
                continue;
            }
            changed.push(file.clone());
            if !check {
                write_atomic(&file, &canonical)?;
            }
        }
    }

    if check {
        for file in &changed {
            writeln!(out, "would rewrite {}", file.display()).map_err(io("writing report"))?;
        }
        writeln!(out, "{} file(s) not in canonical form", changed.len())
            .map_err(io("writing report"))?;
        return Ok(if changed.is_empty() {
            ExitCode::SUCCESS
        } else {
            ExitCode::FAILURE
        });
    }
    writeln!(out, "rewrote {} file(s)", changed.len()).map_err(io("writing report"))?;
    Ok(ExitCode::SUCCESS)
}

fn inspect(args: &[String], stdin: &mut dyn Read, out: &mut dyn Write) -> Result<ExitCode, String> {
    let mut input = String::new();
    match args.iter().find(|a| !a.starts_with("--")) {
        Some(path) => {
            let path = expand_home(path)?;
            input = fs::read_to_string(&path)
                .map_err(|e| format!("reading {}: {e}", path.display()))?;
        }
        None => {
            stdin
                .read_to_string(&mut input)
                .map_err(io("reading stdin"))?;
        }
    }

    let doc = mb_core::parse(&input);
    let facts = mb_core::extract(&doc);
    let w = io("writing report");
    writeln!(
        out,
        "title:      {}",
        mb_core::extract::title(&doc).unwrap_or_else(|| "—".into())
    )
    .map_err(&w)?;
    writeln!(out, "blocks:     {}", doc.blocks.len()).map_err(&w)?;
    writeln!(out, "words:      {}", facts.word_count).map_err(&w)?;
    writeln!(out, "links:      {}", facts.links.len()).map_err(&w)?;
    writeln!(out, "tags:       {}", join(&facts.tags)).map_err(&w)?;
    writeln!(out, "emoji:      {}", join(&facts.emoji)).map_err(&w)?;
    let anchors: Vec<String> = facts
        .anchors
        .iter()
        .map(|block| block.anchor.clone())
        .collect();
    writeln!(out, "anchors:    {}", join(&anchors)).map_err(&w)?;
    writeln!(out, "media:      {}", join(&facts.media)).map_err(&w)?;
    writeln!(out, "tasks:      {}", facts.tasks.len()).map_err(&w)?;
    for task in &facts.tasks {
        let due = task
            .task
            .meta
            .due
            .map_or_else(|| "—".to_string(), |d| d.to_string());
        writeln!(
            out,
            "  [{}] {} (due {due})",
            task.task.status.marker(),
            task.text
        )
        .map_err(&w)?;
    }
    Ok(ExitCode::SUCCESS)
}

/// Builds a synthetic vault for the performance budgets in `SPEC.md` §21.
///
/// Deterministic by construction — no clock, no RNG — so a regression in a benchmark is a
/// real regression and not a different corpus.
fn gen_vault(args: &[String], out: &mut dyn Write) -> Result<ExitCode, String> {
    let dir = flag(args, "--out").ok_or("gen-vault needs --out DIR")?;
    let count: usize = flag(args, "--notes")
        .map(|n| {
            n.parse()
                .map_err(|_| "--notes must be a number".to_string())
        })
        .transpose()?
        .unwrap_or(10_000);

    let notes = expand_home(dir)?.join("notes");
    fs::create_dir_all(&notes).map_err(|e| format!("creating {}: {e}", notes.display()))?;

    for i in 0..count {
        let dir = notes.join(format!("folder-{:02}", i % 50));
        fs::create_dir_all(&dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
        let path = dir.join(format!("note-{i:05}.md"));
        write_atomic(&path, &synthetic_note(i, count))?;
    }
    writeln!(out, "generated {count} notes in {}", notes.display())
        .map_err(io("writing report"))?;
    Ok(ExitCode::SUCCESS)
}

fn synthetic_note(index: usize, total: usize) -> String {
    // A deterministic pseudo-random spread of links, so the graph has realistic structure.
    let link_a = (index * 7 + 13) % total;
    let link_b = (index * 31 + 7) % total;
    let words: String = (0..120)
        .map(|w| format!("word{} ", (index + w) % 900))
        .collect::<String>()
        .trim_end()
        .to_string();

    format!(
        "---\nid: 018f0000-0000-7000-8000-{index:012}\ncreated: 2026-01-01T00:00:00Z\n\
         updated: 2026-01-01T00:00:00Z\ntags: [folder/f{:02}, synthetic]\n---\n\n\
         # Note {index}\n\n{words}\n\n\
         See [[note-{link_a:05}]] and [[note-{link_b:05}]].\n\n\
         - [ ] Task for note {index} 📅 2026-09-05\n- [x] Done item ✅ 2026-08-28\n",
        index % 50
    )
}

fn join(items: &[String]) -> String {
    if items.is_empty() {
        "—".to_string()
    } else {
        items.join(", ")
    }
}

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a String> {
    let position = args.iter().position(|a| a == name)?;
    args.get(position + 1)
}

fn expand_home(path: &str) -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME");
    expand_home_with(path, home.as_deref())
}

pub(crate) fn expand_home_with(path: &str, home: Option<&OsStr>) -> Result<PathBuf, String> {
    let remainder = if path == "~" {
        Some("")
    } else {
        path.strip_prefix("~/")
    };
    let Some(remainder) = remainder else {
        return Ok(PathBuf::from(path));
    };
    let home = home.ok_or_else(|| format!("cannot expand `{path}` because HOME is not set"))?;
    Ok(Path::new(home).join(remainder))
}

/// Collects `.md` files, following directories. Skips dotfiles, and so `.memberberry/` —
/// that is derived state, and rewriting it would be meaningless at best.
fn markdown_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let meta = fs::metadata(root).map_err(|e| format!("reading {}: {e}", root.display()))?;
    if meta.is_file() {
        return Ok(vec![root.to_path_buf()]);
    }
    let mut found = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = fs::read_dir(&dir).map_err(|e| format!("reading {}: {e}", dir.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("reading {}: {e}", dir.display()))?;
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') {
                continue;
            }
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|e| e == "md") {
                found.push(path);
            }
        }
    }
    found.sort();
    Ok(found)
}

/// Writes via a temporary file and a rename, so a crash mid-write cannot truncate a note.
fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let temp = path.with_extension("md.tmp");
    fs::write(&temp, contents).map_err(|e| format!("writing {}: {e}", temp.display()))?;
    fs::rename(&temp, path).map_err(|e| format!("renaming into {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::expand_home_with;
    use std::ffi::OsStr;
    use std::path::PathBuf;

    fn argv(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn every_password_taking_command_prompts_on_a_terminal_by_default() {
        // Getting this wrong in either direction is a bad failure: a command that should
        // prompt but reads stdin instead silently takes whatever is piped at it, and one
        // that should read stdin but prompts blocks a script forever on /dev/tty.
        for args in [
            &["user", "setup", "--username", "alice"][..],
            &[
                "user",
                "reset-password",
                "--username",
                "alice",
                "--actor",
                "root",
            ][..],
            &["vault", "create", "--slug", "personal", "--actor", "root"][..],
            &["vault", "remove", "--slug", "personal", "--actor", "root"][..],
        ] {
            assert!(
                super::reads_password_from_terminal(&argv(args)),
                "{args:?} takes a password and must prompt for it"
            );
        }
    }

    #[test]
    fn password_stdin_turns_off_the_terminal_prompt() {
        for args in [
            &["user", "setup", "--username", "alice", "--password-stdin"][..],
            &["vault", "create", "--slug", "personal", "--password-stdin"][..],
        ] {
            assert!(!super::reads_password_from_terminal(&argv(args)));
        }
    }

    #[test]
    fn a_command_that_takes_no_password_never_prompts() {
        for args in [
            &["serve"][..],
            &["vault", "list"][..],
            &["user"][..],
            &["normalize", "--check"][..],
            &[][..],
        ] {
            assert!(!super::reads_password_from_terminal(&argv(args)));
        }
    }

    #[test]
    fn quoted_home_relative_path_expands() {
        assert_eq!(
            expand_home_with("~/Documents/ultrabrain", Some(OsStr::new("/Users/alice"))),
            Ok(PathBuf::from("/Users/alice/Documents/ultrabrain"))
        );
    }

    #[test]
    fn a_bare_tilde_expands_to_home_itself() {
        assert_eq!(
            expand_home_with("~", Some(OsStr::new("/Users/alice"))),
            Ok(PathBuf::from("/Users/alice"))
        );
    }

    #[test]
    fn path_without_home_prefix_is_unchanged() {
        assert_eq!(
            expand_home_with("notes/~archive", Some(OsStr::new("/Users/alice"))),
            Ok(PathBuf::from("notes/~archive"))
        );
    }

    #[test]
    fn config_path_prefers_the_flag_then_the_data_dir_then_the_working_directory() {
        let flagged: Vec<String> = ["--config", "/explicit/here.toml"]
            .iter()
            .map(|s| (*s).to_string())
            .collect();
        assert_eq!(
            super::config_path_in(&flagged, Some(OsStr::new("/data"))),
            PathBuf::from("/explicit/here.toml"),
            "--config must win over the environment"
        );
        assert_eq!(
            super::config_path_in(&[], Some(OsStr::new("/data"))),
            PathBuf::from("/data/server.toml")
        );
        assert_eq!(
            super::config_path_in(&[], None),
            PathBuf::from("server.toml")
        );
    }

    #[test]
    fn home_relative_path_is_unchanged_when_home_is_unavailable() {
        assert_eq!(
            expand_home_with("~/notes", None),
            Err("cannot expand `~/notes` because HOME is not set".to_string())
        );
    }
}
