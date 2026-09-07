//! The command line, end to end.
//!
//! `normalize` rewrites the user's notes in place, which makes this the code in the
//! repository most able to destroy data — and until now the least tested. Everything here
//! runs against a real temporary directory rather than a mocked filesystem, because the
//! failure modes that matter (a partial write, a skipped file, a directory walked wrongly)
//! only exist at that boundary.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicUsize, Ordering};

/// A directory under the system temp dir, removed when the test finishes.
///
/// Hand-rolled rather than pulling in `tempfile`: it is a dozen lines, and `mb-cli` is a
/// dependency-light crate on purpose. Uniqueness comes from the process id plus a counter,
/// so parallel tests within a run and concurrent runs both stay separate — no clock and no
/// RNG, which keeps it deterministic enough to debug.
struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("mb-cli-{label}-{}-{n}", std::process::id()));
        fs::create_dir_all(&path).expect("creating the temp dir");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    /// Writes a note, creating parent directories.
    fn write(&self, rel: &str, contents: &str) -> PathBuf {
        let path = self.0.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("creating parent directories");
        }
        fs::write(&path, contents).expect("writing the note");
        path
    }

    fn read(&self, rel: &str) -> String {
        fs::read_to_string(self.0.join(rel)).expect("reading the note back")
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        drop(fs::remove_dir_all(&self.0));
    }
}

/// Runs a command with no stdin, returning `(exit code, stdout)`.
fn run(args: &[&str]) -> (ExitCode, String) {
    run_with_stdin(args, "")
}

fn run_with_stdin(args: &[&str], stdin: &str) -> (ExitCode, String) {
    let owned: Vec<String> = args.iter().map(|s| (*s).to_string()).collect();
    let mut input = stdin.as_bytes();
    let mut out: Vec<u8> = Vec::new();
    let code = mb_cli::run(&owned, &mut input, &mut out).expect("the command should succeed");
    (
        code,
        String::from_utf8(out).expect("output should be UTF-8"),
    )
}

fn run_err(args: &[&str]) -> String {
    run_err_with_stdin(args, "")
}

fn run_err_with_stdin(args: &[&str], stdin: &str) -> String {
    let owned: Vec<String> = args.iter().map(|s| (*s).to_string()).collect();
    let mut input = stdin.as_bytes();
    let mut out: Vec<u8> = Vec::new();
    mb_cli::run(&owned, &mut input, &mut out).expect_err("the command should fail")
}

fn is_success(code: ExitCode) -> bool {
    format!("{code:?}") == format!("{:?}", ExitCode::SUCCESS)
}

// ---------------------------------------------------------------- dispatch

#[test]
fn no_arguments_prints_usage() {
    let (code, out) = run(&[]);
    assert!(is_success(code));
    assert!(out.contains("USAGE:"), "{out}");
    assert!(out.contains("normalize"), "{out}");
}

#[test]
fn every_help_spelling_prints_usage() {
    for flag in ["--help", "-h", "help"] {
        let (code, out) = run(&[flag]);
        assert!(is_success(code), "{flag}");
        assert!(out.contains("USAGE:"), "{flag}: {out}");
    }
}

#[test]
fn an_unknown_command_fails_and_shows_usage() {
    let message = run_err(&["frobnicate"]);
    assert!(
        message.contains("unknown command `frobnicate`"),
        "{message}"
    );
    assert!(message.contains("USAGE:"), "{message}");
}

// ---------------------------------------------------------------- users

#[test]
fn user_setup_creates_the_first_server_administrator_without_putting_the_password_in_args() {
    let dir = TempDir::new("user-setup");
    let config = config_of(&dir);
    let (code, out) = run_with_stdin(
        &[
            "user",
            "setup",
            "--username",
            "alice",
            "--display-name",
            "Alice Example",
            "--config",
            &config,
        ],
        "correct horse battery staple\n",
    );
    assert!(is_success(code));
    assert!(out.contains("created server administrator alice"), "{out}");
    assert!(dir.path().join("auth.db").exists());
}

#[test]
fn user_setup_cannot_be_run_twice() {
    let dir = TempDir::new("user-setup-twice");
    let config = config_of(&dir);
    let args = ["user", "setup", "--username", "alice", "--config", &config];
    let (code, _) = run_with_stdin(&args, "correct horse battery staple\n");
    assert!(is_success(code));

    let message = run_err_with_stdin(
        &["user", "setup", "--username", "bob", "--config", &config],
        "correct horse battery staple\n",
    );
    assert!(
        message.contains("first-run setup has already completed"),
        "{message}"
    );
}

#[test]
fn local_user_password_reset_replaces_the_credential() {
    let dir = TempDir::new("user-reset");
    let config = config_of(&dir);
    let setup = ["user", "setup", "--username", "alice", "--config", &config];
    let (code, _) = run_with_stdin(&setup, "correct horse battery staple\n");
    assert!(is_success(code));

    let (code, out) = run_with_stdin(
        &[
            "user",
            "reset-password",
            "--username",
            "alice",
            "--actor",
            "alice",
            "--config",
            &config,
        ],
        "correct horse battery staple\nanother correct horse battery staple\n",
    );
    assert!(is_success(code));
    assert!(out.contains("password reset for alice"), "{out}");
    let audit = dir.read("audit.log");
    assert!(audit.contains("\"action\":\"password_reset\""), "{audit}");
    assert!(audit.contains("\"result\":\"success\""), "{audit}");
}

#[test]
fn password_reset_rejects_a_wrong_administrator_password_and_audits_the_denial() {
    let dir = TempDir::new("user-reset-denied");
    let config = config_of(&dir);
    let setup = ["user", "setup", "--username", "alice", "--config", &config];
    let (code, _) = run_with_stdin(&setup, "correct horse battery staple\n");
    assert!(is_success(code));

    let message = run_err_with_stdin(
        &[
            "user",
            "reset-password",
            "--username",
            "alice",
            "--actor",
            "alice",
            "--config",
            &config,
        ],
        "wrong password\nanother correct horse battery staple\n",
    );
    assert!(
        message.contains("administrator authentication failed"),
        "{message}"
    );
    let audit = dir.read("audit.log");
    assert!(audit.contains("\"action\":\"password_reset\""), "{audit}");
    assert!(audit.contains("\"result\":\"denied\""), "{audit}");
}

// ---------------------------------------------------------------- normalize

#[test]
fn normalize_reads_stdin_and_writes_stdout_when_given_no_path() {
    // `*` becomes `-`, `_em_` becomes `*em*`, and the second line is a lazy continuation
    // of the item — all three are §4.5 canonical form.
    let (code, out) = run_with_stdin(&["normalize"], "* item\n_em_\n");
    assert!(is_success(code));
    assert_eq!(out, "- item\n  *em*\n");
}

#[test]
fn normalize_rewrites_a_single_file_in_place() {
    let dir = TempDir::new("single");
    dir.write("note.md", "* item\n");
    let (code, out) = run(&["normalize", dir.path().join("note.md").to_str().unwrap()]);
    assert!(is_success(code));
    assert_eq!(out, "rewrote 1 file(s)\n");
    assert_eq!(dir.read("note.md"), "- item\n");
}

#[test]
fn normalize_walks_a_directory_recursively() {
    let dir = TempDir::new("walk");
    dir.write("a.md", "* one\n");
    dir.write("sub/b.md", "* two\n");
    dir.write("sub/deeper/c.md", "* three\n");
    let (code, out) = run(&["normalize", dir.path().to_str().unwrap()]);
    assert!(is_success(code));
    assert_eq!(out, "rewrote 3 file(s)\n");
    assert_eq!(dir.read("sub/deeper/c.md"), "- three\n");
}

#[test]
fn normalize_leaves_canonical_files_untouched() {
    let dir = TempDir::new("noop");
    dir.write("canonical.md", "- item\n");
    let (code, out) = run(&["normalize", dir.path().to_str().unwrap()]);
    assert!(is_success(code));
    assert_eq!(out, "rewrote 0 file(s)\n");
}

#[test]
fn normalize_ignores_non_markdown_files() {
    // A vault holds images, PDFs and `.excalidraw` JSON. Rewriting one would corrupt it.
    let dir = TempDir::new("nonmd");
    dir.write("note.md", "* item\n");
    dir.write("data.json", "{\"not\": \"markdown\"}");
    dir.write("README.txt", "* not markdown\n");
    let (code, _) = run(&["normalize", dir.path().to_str().unwrap()]);
    assert!(is_success(code));
    assert_eq!(dir.read("data.json"), "{\"not\": \"markdown\"}");
    assert_eq!(dir.read("README.txt"), "* not markdown\n");
}

#[test]
fn normalize_skips_dotfiles_and_dot_directories() {
    // `.memberberry/` is derived state (Invariant I1) and `.obsidian/` is another app's
    // config. Rewriting either is at best meaningless and at worst destructive.
    let dir = TempDir::new("dots");
    dir.write("note.md", "* item\n");
    dir.write(".memberberry/cache.md", "* derived\n");
    dir.write(".obsidian/plugin.md", "* config\n");
    dir.write(".hidden.md", "* hidden\n");
    let (code, out) = run(&["normalize", dir.path().to_str().unwrap()]);
    assert!(is_success(code));
    assert_eq!(out, "rewrote 1 file(s)\n");
    assert_eq!(dir.read(".memberberry/cache.md"), "* derived\n");
    assert_eq!(dir.read(".obsidian/plugin.md"), "* config\n");
    assert_eq!(dir.read(".hidden.md"), "* hidden\n");
}

#[test]
fn normalize_accepts_several_paths() {
    let dir = TempDir::new("multi");
    dir.write("one/a.md", "* one\n");
    dir.write("two/b.md", "* two\n");
    let (code, out) = run(&[
        "normalize",
        dir.path().join("one").to_str().unwrap(),
        dir.path().join("two").to_str().unwrap(),
    ]);
    assert!(is_success(code));
    assert_eq!(out, "rewrote 2 file(s)\n");
}

#[test]
fn normalize_check_reports_without_writing_and_exits_nonzero() {
    let dir = TempDir::new("check");
    dir.write("note.md", "* item\n");
    let (code, out) = run(&["normalize", "--check", dir.path().to_str().unwrap()]);
    assert!(!is_success(code), "--check must fail when work remains");
    assert!(out.contains("would rewrite"), "{out}");
    assert!(out.contains("1 file(s) not in canonical form"), "{out}");
    assert_eq!(dir.read("note.md"), "* item\n", "--check must not write");
}

#[test]
fn normalize_check_succeeds_on_an_already_canonical_vault() {
    let dir = TempDir::new("check-clean");
    dir.write("note.md", "- item\n");
    let (code, out) = run(&["normalize", "--check", dir.path().to_str().unwrap()]);
    assert!(is_success(code));
    assert_eq!(out, "0 file(s) not in canonical form\n");
}

#[test]
fn normalize_leaves_no_temporary_file_behind() {
    // The write goes via `note.md.tmp` and a rename. A leftover would show up in the user's
    // vault and, worse, in their git status.
    let dir = TempDir::new("atomic");
    dir.write("note.md", "* item\n");
    run(&["normalize", dir.path().to_str().unwrap()]);
    let leftovers: Vec<_> = fs::read_dir(dir.path())
        .expect("listing")
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "temporary files left: {leftovers:?}");
}

#[test]
fn normalize_is_idempotent_over_a_directory() {
    let dir = TempDir::new("idempotent");
    dir.write("note.md", "* item\n_em_\n\n1) first\n2) second\n");
    run(&["normalize", dir.path().to_str().unwrap()]);
    let once = dir.read("note.md");
    let (_, out) = run(&["normalize", dir.path().to_str().unwrap()]);
    assert_eq!(
        out, "rewrote 0 file(s)\n",
        "second pass should change nothing"
    );
    assert_eq!(dir.read("note.md"), once);
}

#[test]
fn normalize_reports_a_missing_path() {
    let message = run_err(&["normalize", "/definitely/not/here"]);
    assert!(message.contains("/definitely/not/here"), "{message}");
}

// ---------------------------------------------------------------- inspect

#[test]
fn inspect_reads_stdin_and_reports_the_structure() {
    let (code, out) = run_with_stdin(
        &["inspect"],
        "---\ntags: [alpha]\n---\n\n# Title\n\nSee [[A]] #beta ^anchor-1\n\n- [ ] task 📅 2026-09-05\n",
    );
    assert!(is_success(code));
    assert!(out.contains("title:      Title"), "{out}");
    assert!(out.contains("links:      1"), "{out}");
    assert!(out.contains("alpha, beta"), "{out}");
    assert!(out.contains("anchors:    anchor-1"), "{out}");
    assert!(out.contains("tasks:      1"), "{out}");
    assert!(out.contains("[ ] task (due 2026-09-05)"), "{out}");
}

#[test]
fn inspect_reads_a_file_when_given_a_path() {
    let dir = TempDir::new("inspect");
    dir.write("note.md", "# From A File\n");
    let (code, out) = run(&["inspect", dir.path().join("note.md").to_str().unwrap()]);
    assert!(is_success(code));
    assert!(out.contains("title:      From A File"), "{out}");
}

#[test]
fn inspect_shows_placeholders_for_an_empty_note() {
    let (code, out) = run_with_stdin(&["inspect"], "");
    assert!(is_success(code));
    assert!(out.contains("title:      —"), "{out}");
    assert!(out.contains("tags:       —"), "{out}");
    assert!(out.contains("blocks:     0"), "{out}");
}

#[test]
fn inspect_shows_a_task_without_a_due_date() {
    let (code, out) = run_with_stdin(&["inspect"], "- [x] no date\n");
    assert!(is_success(code));
    assert!(out.contains("[x] no date (due —)"), "{out}");
}

#[test]
fn inspect_reports_a_missing_file() {
    let message = run_err(&["inspect", "/definitely/not/here.md"]);
    assert!(message.contains("/definitely/not/here.md"), "{message}");
}

// ---------------------------------------------------------------- gen-vault

#[test]
fn gen_vault_writes_the_requested_number_of_notes() {
    let dir = TempDir::new("gen");
    let (code, out) = run(&[
        "gen-vault",
        "--out",
        dir.path().to_str().unwrap(),
        "--notes",
        "7",
    ]);
    assert!(is_success(code));
    assert!(out.contains("generated 7 notes"), "{out}");
    let notes: Vec<_> = walk_md(&dir.path().join("notes"));
    assert_eq!(notes.len(), 7);
}

#[test]
fn a_generated_vault_is_already_canonical() {
    // why: otherwise every performance run would measure a normalisation pass that a real
    // vault would only pay once, and `--check` on the corpus would be noise.
    let dir = TempDir::new("gen-canonical");
    run(&[
        "gen-vault",
        "--out",
        dir.path().to_str().unwrap(),
        "--notes",
        "5",
    ]);
    let (code, out) = run(&["normalize", "--check", dir.path().to_str().unwrap()]);
    assert!(
        is_success(code),
        "generated notes should be canonical: {out}"
    );
}

#[test]
fn a_generated_vault_is_deterministic() {
    // No clock and no RNG, so a benchmark regression is a real regression.
    let a = TempDir::new("gen-det-a");
    let b = TempDir::new("gen-det-b");
    for dir in [&a, &b] {
        run(&[
            "gen-vault",
            "--out",
            dir.path().to_str().unwrap(),
            "--notes",
            "3",
        ]);
    }
    for rel in [
        "notes/folder-00/note-00000.md",
        "notes/folder-01/note-00001.md",
    ] {
        assert_eq!(a.read(rel), b.read(rel), "{rel} differs between runs");
    }
}

#[test]
fn gen_vault_needs_an_output_directory() {
    let message = run_err(&["gen-vault"]);
    assert!(message.contains("--out"), "{message}");
}

#[test]
fn gen_vault_rejects_a_non_numeric_note_count() {
    let dir = TempDir::new("gen-bad");
    let message = run_err(&[
        "gen-vault",
        "--out",
        dir.path().to_str().unwrap(),
        "--notes",
        "lots",
    ]);
    assert!(message.contains("--notes must be a number"), "{message}");
}

fn walk_md(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|e| e == "md") {
                found.push(path);
            }
        }
    }
    found
}

// ---------------------------------------------------------------- vault registry

/// The `server.toml` a registry test works against.
///
/// Passed with `--config` rather than through `MEMBERBERRY_DATA_DIR`: the workspace forbids
/// `unsafe`, so a test cannot set an environment variable, and process-wide state would
/// make these race when run in parallel. `config_path_in` unit-tests the precedence.
/// Provisions a server by spawning the real binary, the way a script or a container would.
///
/// A running server must stop when it is asked to (`SPEC.md` §6.11).
///
/// why the built binary, and why this test is worth its seconds: the bug it holds fixed was
/// invisible to every in-process test, because it was not in `serve` at all. `main` wrapped
/// its writer around `stdout.lock()`, which holds the process-wide stdout mutex for the whole
/// command; that mutex is reentrant only for the thread that took it. The server prints its
/// shutdown message from a tokio worker thread, so `Ctrl+C` arrived, the shutdown future
/// resolved, and the process then deadlocked on the *println* — leaving a server that could
/// not be stopped without `kill -9` and that kept holding its port. Only a real process with
/// a real signal can see that.
///
/// Port 0 rather than a fixed one: this test needs a server, not an address, and `AGENTS.md`
/// §5.1 reserves the fixed range for services something else has to find.
#[test]
fn the_running_server_stops_when_it_is_interrupted() {
    stops_on("-INT", "serve-sigint");
}

/// `SIGTERM` is what every process supervisor sends, and §6.11 makes it the same path.
///
/// Left on its default disposition it would kill the process outright, skipping the flush
/// that puts accepted edits into Markdown — the one thing stopping the server has to do.
#[test]
fn the_running_server_stops_when_it_is_terminated() {
    stops_on("-TERM", "serve-sigterm");
}

fn stops_on(signal: &str, label: &str) {
    use std::process::{Command, Stdio};

    let dir = TempDir::new(label);
    let vault = TempDir::new(&format!("{label}-vault"));
    let config = config_of(&dir);
    setup_admin(&dir);
    let (code, _) = run_with_stdin(
        &[
            "vault",
            "create",
            "--slug",
            "personal",
            "--path",
            &vault.path().to_string_lossy(),
            "--config",
            &config,
            "--actor",
            "alice",
        ],
        "correct horse battery staple\n",
    );
    assert!(is_success(code));
    fs::write(
        dir.path().join("server.toml"),
        format!(
            "bind = \"127.0.0.1:0\"\n{}",
            fs::read_to_string(dir.path().join("server.toml")).expect("server.toml")
        ),
    )
    .expect("pinning the bind address to an ephemeral port");

    let log = dir.path().join("serve.log");
    let mut child = Command::new(env!("CARGO_BIN_EXE_memberberry"))
        .args(["serve", "--config", &config])
        .stdin(Stdio::null())
        .stdout(Stdio::from(fs::File::create(&log).expect("log file")))
        .stderr(Stdio::null())
        .spawn()
        .expect("spawning the server");

    // Wait for it to be serving. Reading the log rather than the port, because what this
    // test needs is a process that has got as far as `axum::serve` — which is where the
    // deadlock lived.
    let started = std::time::Instant::now();
    let mut listening = false;
    while started.elapsed() < std::time::Duration::from_secs(30) {
        if fs::read_to_string(&log)
            .unwrap_or_default()
            .contains("index ready")
        {
            listening = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    assert!(
        listening,
        "the server never started: {:?}",
        fs::read_to_string(&log)
    );

    let interrupted = Command::new("kill")
        .args([signal, &child.id().to_string()])
        .status()
        .expect("sending the stop signal");
    assert!(interrupted.success());

    let deadline = std::time::Instant::now();
    loop {
        match child.try_wait().expect("polling the server") {
            Some(_) => break,
            None if deadline.elapsed() > std::time::Duration::from_secs(15) => {
                drop(child.kill());
                drop(child.wait());
                panic!(
                    "the server ignored {signal} and had to be killed; it printed: {:?}",
                    fs::read_to_string(&log)
                );
            }
            None => std::thread::sleep(std::time::Duration::from_millis(100)),
        }
    }

    // It said so on the way out, which is the line that used to deadlock.
    let output = fs::read_to_string(&log).unwrap_or_default();
    assert!(output.contains("shutting down"), "{output}");
    // And the startup report came first, rather than sitting in an unflushed buffer.
    let vault_line = output.find("vault personal").expect("the vault report");
    let listening_line = output.find("listening on").expect("the listening line");
    assert!(vault_line < listening_line, "{output}");
}

/// why: every other test in this file calls `mb_cli::run` in process with an injected
/// reader, which cannot see the difference between reading stdin and prompting on
/// `/dev/tty` — the whole point of `--password-stdin`. Only the built binary can.
#[test]
fn the_binary_provisions_a_server_from_a_pipe_with_no_terminal() {
    use std::io::Write as _;
    use std::process::{Command, Stdio};

    let dir = TempDir::new("password-stdin");
    let vault_dir = TempDir::new("password-stdin-vault");
    let config = config_of(&dir);

    let provision = |args: &[&str], stdin: &str| {
        let mut child = Command::new(env!("CARGO_BIN_EXE_memberberry"))
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawning memberberry");
        child
            .stdin
            .as_mut()
            .expect("piped stdin")
            .write_all(stdin.as_bytes())
            .expect("writing the password");
        child.wait_with_output().expect("waiting for memberberry")
    };

    let setup = provision(
        &[
            "user",
            "setup",
            "--username",
            "alice",
            "--password-stdin",
            "--config",
            &config,
        ],
        "correct horse battery staple\n",
    );
    assert!(
        setup.status.success(),
        "setup failed: {}",
        String::from_utf8_lossy(&setup.stderr)
    );
    assert!(dir.path().join("auth.db").exists());

    let vault_path = vault_dir.path().to_string_lossy().into_owned();
    let created = provision(
        &[
            "vault",
            "create",
            "--slug",
            "personal",
            "--path",
            &vault_path,
            "--actor",
            "alice",
            "--password-stdin",
            "--config",
            &config,
        ],
        "correct horse battery staple\n",
    );
    assert!(
        created.status.success(),
        "vault create failed: {}",
        String::from_utf8_lossy(&created.stderr)
    );

    let listed = provision(&["vault", "list", "--config", &config], "");
    assert!(
        String::from_utf8_lossy(&listed.stdout).contains("personal"),
        "the vault should be registered: {}",
        String::from_utf8_lossy(&listed.stdout)
    );
}

fn config_of(dir: &TempDir) -> String {
    dir.path()
        .join("server.toml")
        .to_string_lossy()
        .into_owned()
}

fn setup_admin(dir: &TempDir) {
    let config = config_of(dir);
    let (code, _) = run_with_stdin(
        &["user", "setup", "--username", "alice", "--config", &config],
        "correct horse battery staple\n",
    );
    assert!(is_success(code));
}

#[test]
fn vault_list_says_so_when_the_registry_is_empty() {
    let dir = TempDir::new("vault-empty");
    let (code, out) = run(&["vault", "list", "--config", &config_of(&dir)]);
    assert!(is_success(code));
    assert!(out.contains("no vaults registered"), "{out}");
}

#[test]
fn vault_create_registers_and_list_shows_it() {
    let dir = TempDir::new("vault-create");
    setup_admin(&dir);
    let vault = TempDir::new("vault-create-root");
    vault.write("note.md", "# A\n");
    let path = vault.path().to_string_lossy().into_owned();

    let (code, out) = run_with_stdin(
        &[
            "vault",
            "create",
            "--slug",
            "personal",
            "--name",
            "Personal",
            "--path",
            &path,
            "--config",
            &config_of(&dir),
            "--actor",
            "alice",
        ],
        "correct horse battery staple\n",
    );
    assert!(is_success(code));
    assert!(out.contains("registered `personal`"), "{out}");

    let (_, listed) = run(&["vault", "list", "--config", &config_of(&dir)]);
    assert!(listed.contains("personal"), "{listed}");
    assert!(listed.contains("Personal"), "{listed}");

    // And it landed in a server.toml the server can read back.
    let toml = fs::read_to_string(dir.path().join("server.toml")).expect("server.toml");
    assert!(toml.contains("slug = \"personal\""), "{toml}");

    let access = vault.read("access.toml");
    assert!(access.contains("user = \"alice\""), "{access}");
    assert!(access.contains("role = \"owner\""), "{access}");
}

#[test]
fn vault_create_preserves_an_existing_access_policy() {
    let dir = TempDir::new("vault-existing-access");
    setup_admin(&dir);
    let vault = TempDir::new("vault-existing-access-root");
    let existing = "[[members]]\nuser = \"bob\"\nrole = \"viewer\"\n";
    vault.write("access.toml", existing);
    let path = vault.path().to_string_lossy().into_owned();

    let (code, _) = run_with_stdin(
        &[
            "vault",
            "create",
            "--slug",
            "shared",
            "--path",
            &path,
            "--config",
            &config_of(&dir),
            "--actor",
            "alice",
        ],
        "correct horse battery staple\n",
    );

    assert!(is_success(code));
    assert_eq!(vault.read("access.toml"), existing);
}

#[test]
fn vault_create_does_not_register_when_the_initial_access_file_cannot_be_written() {
    let dir = TempDir::new("vault-access-write-failure");
    setup_admin(&dir);
    let vault = TempDir::new("vault-access-write-failure-root");
    fs::create_dir(vault.path().join(".access.toml.memberberry-tmp"))
        .expect("blocking the atomic access-file write");
    let path = vault.path().to_string_lossy().into_owned();

    let message = run_err_with_stdin(
        &[
            "vault",
            "create",
            "--slug",
            "blocked",
            "--path",
            &path,
            "--config",
            &config_of(&dir),
            "--actor",
            "alice",
        ],
        "correct horse battery staple\n",
    );

    assert!(message.contains("access.toml.memberberry-tmp"), "{message}");
    assert!(!dir.path().join("server.toml").exists());
    assert!(!vault.path().join("access.toml").exists());
}

#[test]
fn vault_create_defaults_the_name_to_the_slug() {
    let dir = TempDir::new("vault-noname");
    setup_admin(&dir);
    let vault = TempDir::new("vault-noname-root");
    let path = vault.path().to_string_lossy().into_owned();
    run_with_stdin(
        &[
            "vault",
            "create",
            "--slug",
            "work",
            "--path",
            &path,
            "--config",
            &config_of(&dir),
            "--actor",
            "alice",
        ],
        "correct horse battery staple\n",
    );
    let (_, listed) = run(&["vault", "list", "--config", &config_of(&dir)]);
    assert!(listed.contains("work"), "{listed}");
}

#[test]
fn vault_create_refuses_a_slug_that_is_not_url_safe() {
    let dir = TempDir::new("vault-badslug");
    let vault = TempDir::new("vault-badslug-root");
    let path = vault.path().to_string_lossy().into_owned();
    let message = run_err(&[
        "vault",
        "create",
        "--slug",
        "Bad Slug",
        "--path",
        &path,
        "--config",
        &config_of(&dir),
    ]);
    assert!(message.contains("not usable in a URL"), "{message}");
    assert!(
        !dir.path().join("server.toml").exists(),
        "nothing should be written"
    );
}

#[test]
fn vault_create_refuses_a_path_that_does_not_exist() {
    // Caught now rather than at the next `serve`, when the message is further from the typo.
    let dir = TempDir::new("vault-badpath");
    let message = run_err(&[
        "vault",
        "create",
        "--slug",
        "gone",
        "--path",
        "/definitely/not/here",
        "--config",
        &config_of(&dir),
    ]);
    assert!(message.contains("/definitely/not/here"), "{message}");
    assert!(
        !dir.path().join("server.toml").exists(),
        "nothing should be written"
    );
}

#[test]
fn vault_create_refuses_a_duplicate_slug() {
    let dir = TempDir::new("vault-dupe");
    setup_admin(&dir);
    let vault = TempDir::new("vault-dupe-root");
    let path = vault.path().to_string_lossy().into_owned();
    run_with_stdin(
        &[
            "vault",
            "create",
            "--slug",
            "a",
            "--path",
            &path,
            "--config",
            &config_of(&dir),
            "--actor",
            "alice",
        ],
        "correct horse battery staple\n",
    );
    let message = run_err(&[
        "vault",
        "create",
        "--slug",
        "a",
        "--path",
        &path,
        "--config",
        &config_of(&dir),
    ]);
    assert!(message.contains("already registered"), "{message}");
}

#[test]
fn vault_create_needs_a_slug_and_a_path() {
    let dir = TempDir::new("vault-args");
    assert!(run_err(&["vault", "create", "--config", &config_of(&dir)]).contains("--slug"));
    assert!(
        run_err(&[
            "vault",
            "create",
            "--slug",
            "a",
            "--config",
            &config_of(&dir)
        ])
        .contains("--path")
    );
}

#[test]
fn vault_remove_unregisters_without_touching_the_notes() {
    // The wording matters: "remove" next to a directory of someone's notes is alarming.
    let dir = TempDir::new("vault-remove");
    setup_admin(&dir);
    let vault = TempDir::new("vault-remove-root");
    let note = vault.write("keep.md", "# Keep\n");
    let path = vault.path().to_string_lossy().into_owned();
    run_with_stdin(
        &[
            "vault",
            "create",
            "--slug",
            "gone",
            "--path",
            &path,
            "--config",
            &config_of(&dir),
            "--actor",
            "alice",
        ],
        "correct horse battery staple\n",
    );

    let (code, out) = run_with_stdin(
        &[
            "vault",
            "remove",
            "--slug",
            "gone",
            "--config",
            &config_of(&dir),
            "--actor",
            "alice",
        ],
        "correct horse battery staple\n",
    );
    assert!(is_success(code));
    assert!(
        out.contains("not touched"),
        "it must say the notes are safe: {out}"
    );
    assert!(note.exists(), "the notes must still be on disk");

    let (_, listed) = run(&["vault", "list", "--config", &config_of(&dir)]);
    assert!(listed.contains("no vaults registered"), "{listed}");
}

#[test]
fn vault_remove_reports_an_unknown_slug() {
    let dir = TempDir::new("vault-remove-missing");
    let message = run_err(&[
        "vault",
        "remove",
        "--slug",
        "nope",
        "--config",
        &config_of(&dir),
    ]);
    assert!(message.contains("no vault registered"), "{message}");
}

#[test]
fn vault_registration_requires_an_authenticated_server_administrator_and_audits_denial() {
    let dir = TempDir::new("vault-admin-denied");
    setup_admin(&dir);
    let vault = TempDir::new("vault-admin-denied-root");
    let path = vault.path().to_string_lossy().into_owned();

    let message = run_err_with_stdin(
        &[
            "vault",
            "create",
            "--slug",
            "private",
            "--path",
            &path,
            "--actor",
            "alice",
            "--config",
            &config_of(&dir),
        ],
        "wrong password\n",
    );
    assert!(
        message.contains("server administrator authentication failed"),
        "{message}"
    );
    assert!(!dir.path().join("server.toml").exists());
    let audit = dir.read("audit.log");
    assert!(audit.contains("\"action\":\"vault_created\""), "{audit}");
    assert!(audit.contains("\"result\":\"denied\""), "{audit}");
}

#[test]
fn vault_needs_a_known_subcommand() {
    let dir = TempDir::new("vault-sub");
    assert!(run_err(&["vault", "--config", &config_of(&dir)]).contains("list, create or remove"));
    assert!(
        run_err(&["vault", "frobnicate", "--config", &config_of(&dir)])
            .contains("unknown vault command")
    );
}

#[test]
fn the_config_file_is_created_where_the_flag_points() {
    // The registry must land exactly where it was asked to, including in a directory that
    // does not exist yet — otherwise a first run against a fresh data dir fails.
    let parent = TempDir::new("cfg-parent");
    let vault = TempDir::new("cfg-vault");
    let path = vault.path().to_string_lossy().into_owned();
    let config = parent.path().join("nested/dir/server.toml");
    fs::create_dir_all(config.parent().expect("config parent")).expect("creating config parent");
    let config_text = config.to_str().expect("utf-8 path");
    let (setup_code, _) = run_with_stdin(
        &[
            "user",
            "setup",
            "--username",
            "alice",
            "--config",
            config_text,
        ],
        "correct horse battery staple\n",
    );
    assert!(is_success(setup_code));

    let (code, _) = run_with_stdin(
        &[
            "vault",
            "create",
            "--slug",
            "here",
            "--path",
            &path,
            "--config",
            config_text,
            "--actor",
            "alice",
        ],
        "correct horse battery staple\n",
    );
    assert!(is_success(code));
    assert!(
        config.exists(),
        "the config should be created at the flagged path"
    );

    let (_, listed) = run(&["vault", "list", "--config", config.to_str().expect("utf-8")]);
    assert!(listed.contains("here"), "{listed}");
}

// ---------------------------------------------------------------- serve

#[test]
fn serve_reports_a_broken_config_instead_of_starting() {
    let dir = TempDir::new("serve-badcfg");
    fs::write(dir.path().join("server.toml"), "this is not toml {{{").expect("write");
    let message = run_err(&["serve", "--config", &config_of(&dir)]);
    assert!(message.contains("server.toml"), "{message}");
}

#[test]
fn serve_reports_a_vault_it_cannot_open_instead_of_starting() {
    // Half a registry is worse than a clear failure: you would not notice the missing vault
    // until you went looking for a note that was never being served.
    let dir = TempDir::new("serve-badvault");
    fs::write(
        dir.path().join("server.toml"),
        "[[vaults]]\nslug = \"gone\"\npath = \"/definitely/not/here\"\n",
    )
    .expect("write");
    let message = run_err(&["serve", "--config", &config_of(&dir)]);
    assert!(message.contains("/definitely/not/here"), "{message}");
}

#[test]
fn serve_reports_a_bad_bind_address_instead_of_starting() {
    let dir = TempDir::new("serve-badbind");
    fs::write(
        dir.path().join("server.toml"),
        "bind = \"not an address\"\n",
    )
    .expect("write");
    let message = run_err(&["serve", "--config", &config_of(&dir)]);
    assert!(message.contains("bind"), "{message}");
}

#[test]
fn the_usage_text_documents_the_new_commands() {
    let (_, out) = run(&["--help"]);
    for expected in [
        "serve",
        "vault list",
        "vault create",
        "vault remove",
        "--config",
    ] {
        assert!(
            out.contains(expected),
            "usage is missing {expected:?}: {out}"
        );
    }
    assert!(
        out.contains("127.0.0.1:9010"),
        "usage should say where it binds and why: {out}"
    );
}

// ---------------------------------------------------------------- reindex

/// A `server.toml` registering one vault at `path`.
fn config_for(dir: &TempDir, vault: &Path) -> PathBuf {
    dir.write(
        "server.toml",
        &format!(
            "[[vaults]]\nslug = \"personal\"\nname = \"Personal\"\npath = {:?}\n",
            vault.to_str().unwrap()
        ),
    )
}

#[test]
fn reindex_builds_the_index_from_the_notes() {
    let dir = TempDir::new("reindex");
    let vault = dir.path().join("vault");
    fs::create_dir_all(&vault).unwrap();
    fs::write(vault.join("A.md"), "# A\n").unwrap();
    fs::write(vault.join("B.md"), "see [[A]]\n").unwrap();
    let config = config_for(&dir, &vault);

    let (code, out) = run(&["reindex", "--config", config.to_str().unwrap()]);
    assert!(is_success(code), "{out}");
    assert!(out.contains("indexed 2 notes"), "{out}");
    assert!(vault.join(".memberberry/index/graph.sqlite").is_file());
}

#[test]
fn reindex_starts_from_nothing_rather_than_from_the_last_run() {
    // The reason to run this command at all is a stale index, so the one thing it must not
    // do is keep whatever was there. A note removed while the server was down is the case:
    // its rows have to be gone even though no reconcile ever saw it leave.
    let dir = TempDir::new("reindex-stale");
    let vault = dir.path().join("vault");
    fs::create_dir_all(&vault).unwrap();
    fs::write(vault.join("A.md"), "# A\n").unwrap();
    let config = config_for(&dir, &vault);
    run(&["reindex", "--config", config.to_str().unwrap()]);
    let first = fs::metadata(vault.join(".memberberry/index/graph.sqlite"))
        .unwrap()
        .len();

    fs::write(vault.join("B.md"), "see [[A]]\n").unwrap();
    let (code, out) = run(&["reindex", "--config", config.to_str().unwrap()]);
    assert!(is_success(code), "{out}");
    assert!(out.contains("indexed 2 notes"), "{out}");
    assert!(
        fs::metadata(vault.join(".memberberry/index/graph.sqlite"))
            .unwrap()
            .len()
            >= first,
        "the database was not rebuilt"
    );
}

#[test]
fn reindex_can_name_one_vault() {
    let dir = TempDir::new("reindex-slug");
    let first = dir.path().join("one");
    let second = dir.path().join("two");
    fs::create_dir_all(&first).unwrap();
    fs::create_dir_all(&second).unwrap();
    fs::write(first.join("A.md"), "# A\n").unwrap();
    fs::write(second.join("B.md"), "# B\n").unwrap();
    let config = dir.write(
        "server.toml",
        &format!(
            "[[vaults]]\nslug = \"one\"\nname = \"One\"\npath = {:?}\n\n\
             [[vaults]]\nslug = \"two\"\nname = \"Two\"\npath = {:?}\n",
            first.to_str().unwrap(),
            second.to_str().unwrap()
        ),
    );

    let (code, out) = run(&[
        "reindex",
        "--config",
        config.to_str().unwrap(),
        "--slug",
        "two",
    ]);
    assert!(is_success(code), "{out}");
    assert!(out.contains("vault two"), "{out}");
    assert!(!out.contains("vault one"), "{out}");
    assert!(second.join(".memberberry/index/graph.sqlite").is_file());
    assert!(
        !first.join(".memberberry").exists(),
        "a vault that was not named must not be touched"
    );
}

#[test]
fn reindex_reports_an_unknown_slug_rather_than_indexing_everything() {
    let dir = TempDir::new("reindex-unknown");
    let vault = dir.path().join("vault");
    fs::create_dir_all(&vault).unwrap();
    let config = config_for(&dir, &vault);
    let message = run_err(&[
        "reindex",
        "--config",
        config.to_str().unwrap(),
        "--slug",
        "nope",
    ]);
    assert!(message.contains("nope"), "{message}");
    assert!(!vault.join(".memberberry").exists());
}

#[test]
fn reindex_reports_an_empty_registry() {
    let dir = TempDir::new("reindex-empty");
    let config = dir.write("server.toml", "");
    let message = run_err(&["reindex", "--config", config.to_str().unwrap()]);
    assert!(message.contains("no vaults registered"), "{message}");
}
