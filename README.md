# Memberberry

Self-hosted notes that stay plain Markdown.

A replacement for my other note taking apps I used to use: block editing, offline-first
CRDT sync, wiki-links and a knowledge graph, Slack-grade custom emoji, Excalidraw diagrams,
and media in S3-compatible storage you control.

The governing constraint is simple: **if this app dies, your notes are still readable.**
Notes live as ordinary `.md` files in a folder you own. Everything else — merge state, search
indexes, caches — is derived and disposable.

## Quickstart

Requires stable Rust (via rustup), Node.js 22 with npm, Python 3, Make, and a native C/C++
build toolchain. From the repository root:

```sh
cargo install wasm-pack --locked # once; skip if already installed
make dev
```

Open **http://127.0.0.1:9011**, create your administrator account, then choose **Create your
first vault**. The first run builds the app and installs frontend dependencies; subsequent
starts only need `make dev`. Stop with `Ctrl+C`.

### Production build

With the same prerequisites, run from the repository root:

```sh
make prod
```

This builds the frontend and optimized Rust binary, then serves the complete app at
**http://127.0.0.1:9010** by default, without Vite or hot reload. To restart without rebuilding,
run `./target/release/memberberry serve` from the same directory. `make prod` runs in the
foreground, not as an installed background service. For an always-on deployment, TLS,
and container storage, see [Deployment](docs/DEPLOYMENT.md).

### Where your notes live

Development and production use the same storage when started with the same configuration:

- By default, server state lives in the platform application-data directory: macOS uses
  `~/Library/Application Support/memberberry`, Linux uses `$XDG_DATA_HOME/memberberry` or
  `~/.local/share/memberberry`, and Windows uses `%APPDATA%/memberberry`.
- Vaults created in the browser live beside `server.toml`, under `vaults/<address>/`;
  their plain Markdown notes are in `vaults/<address>/notes/**/*.md`.
- Registered existing vaults stay at the paths listed in `server.toml`; switching to
  `make prod` does not copy or move them. Legacy vaults without a `notes/` folder keep
  notes directly in the vault root.

To override the default server-data directory:

```sh
mkdir -p "$HOME/.local/share/memberberry"
MEMBERBERRY_DATA_DIR="$HOME/.local/share/memberberry" make prod
```

Use that same environment variable on subsequent starts. It selects a different
`server.toml` location, **not a migration of existing accounts or vaults**. The binary's
`--config /absolute/path/server.toml` option overrides it. Back up your vault folders and
server state; see [Backup](docs/BACKUP.md).

## Documents

| File | What it is |
|---|---|
| [`PROJECT.md`](PROJECT.md) | The original brief |
| [`SPEC.md`](SPEC.md) | The build specification: architecture, data model, milestones, decision log |
| [`AGENTS.md`](AGENTS.md) | Working agreements: quality gates, testing floors, security rules |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Production container and MinIO setup |
| [`docs/BACKUP.md`](docs/BACKUP.md) | Checksummed backup job and restore drill |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Required deployment controls and honest limits |
| [`docs/THEMES.md`](docs/THEMES.md) | Paper, Charcoal, Pastel, and creating a colour scheme |

## Status

**M0–M18 are complete.** `memberberry
import-obsidian` provides a dry-run migration report and opt-in ID writes; `memberberry doctor`
checks cross-store integrity and applies only deterministic repairs when invoked with `--fix`.
The editor exports a note to PDF/standalone HTML, the CLI builds a permission-filtered static
site for one enabled user, three shipped themes support vault defaults plus per-device
overrides, and equivalent command-palette, quick-switcher and close-tab actions now use
remappable default bindings. The final slice adds a non-root container image, a
loopback-only Compose deployment with private MinIO, and an offline checksummed backup job.
Current details, validation and open work live in
[`HANDOFF.md`](HANDOFF.md).

You can point it at an Obsidian vault and read it in a browser — see *Running it* below.

Measured on a synthetic 10,000-note vault (39 MB) built by `make gen-vault`: generation 1.1 s,
and a full parse + canonical re-serialize + compare of every note in 3.6 s — against the
30 s reindex budget in `SPEC.md` §21.

The Markdown foundation is in `crates/mb-core` (pure, no I/O, `wasm32`-clean):

- The block model and its Markdown isomorphism (`SPEC.md` §4.4)
- Exact Unicode character classes for CommonMark's flanking rules, so emphasis never
  serializes as markup that reads back as literal text
- A canonical, deterministic serializer (§4.5)
- A total parser — never discards content
- `canonical`: the document normal form, shared by the parser and, later, the editor
- `schema.json` plus `mb_core::schema`: the ProseMirror contract M2's `yrs` walker and M3's
  Tiptap schema are both held to (§5.6), with conformance tests binding the two halves
- Task metadata in Obsidian Tasks syntax, with unknown markers preserved verbatim (§10)
- YAML frontmatter with a fixed key order and verbatim passthrough for anything exotic
- Link, tag, anchor, task and media extraction for the index (§9.1)
- `memberberry normalize` / `inspect` / `gen-vault`

`crates/mb-crdt` now maps every schema node and mark to the actual `Y.XmlElement` /
`Y.XmlText` shape used by `y-prosemirror`. It stores frontmatter in a sibling Y.Map for
per-key convergence, rejects malformed remote content before serialization, and emits or
loads standard lib0 v1 updates. Its versioned, checksummed sidecar log durably appends those
updates and atomically compacts them to one portable state update. External Markdown edits
apply as one `external` transaction: unchanged blocks retain identity and frontmatter changes
remain independently mergeable by key. The conformance fixture triple pins canonical
Markdown, ProseMirror/frontmatter JSON, and a portable lib0 v1 state for M3's TypeScript
implementation to consume.

The property suite is what makes those claims worth anything: it found roughly two dozen real
round-trip defects during M1, including one case where `pulldown-cmark`'s display-math
extension silently discards every block after a `$$` fence inside a list — data loss, which is
why math is now parsed here instead.

Fuzzing (`make fuzz`) then found eight more that the property suite had not, the worst being
that `memberberry normalize` stripped LaTeX backslash escapes out of display math — `$$\{ x \}$$`
became `$$ { x } $$` across a whole vault. Each has a named regression test.

Running `normalize` over a real 193-note Obsidian vault found five more, including empty
tasks losing their checkbox — `- [x] ` silently became `- ` — and image alt text dropping
emoji shortcodes. That vault now round-trips with tasks, wikilinks, images and task metadata
all preserved, converging in a single pass.

The round-trip suite is green at `PROPTEST_CASES=100000`, including the Unicode flanking
corner that was previously documented as open.

Inline maths is tokenised out of the source before CommonMark parses the inlines, so a body
is never reinterpreted — `$a*b$`, `$\alpha[i]$`, `$_a_$` and `$P(A|B)$` all work, where the
previous approach refused every body containing `` ` * ~ < [ ] ``.

**Three defects are open**, written up in `SPEC.md` §22.1. One is upstream:
`pulldown-cmark` 0.13.4 panics on a list item holding a link reference definition followed by
a whitespace-only line. Two are ours: a paragraph whose continuation lines become a GFM table
once the serializer lines them up needs two normalisation passes, and display math containing a
lone `-` can retain its content while losing its math-block interpretation.

## Development

In addition to the Quickstart prerequisites, install the Rust checking and coverage tools
before running `make check`:

```sh
rustup component add rustfmt clippy llvm-tools-preview
cargo install cargo-llvm-cov --locked
```

`make check` and `make coverage` require `cargo-llvm-cov`. If it is missing, the coverage
step stops with an installation message even when the preceding tests pass.
Verify installation with `cargo llvm-cov --version`; Cargo can find installed subcommands
in its home directory even when that directory is absent from the shell's `PATH`.

```
make            # list every target
make full-test  # build WASM, then make check, then desktop/mobile E2E
make check      # fmt + clippy + tests + coverage floors — before commit or on request
make test-fast  # behavioural tests only, the inner loop
make soak       # property suite at 20k cases
make coverage   # per-crate coverage report
make fuzz       # libFuzzer over the parser; needs nightly + cargo-fuzz
make wasm       # build the WebAssembly bindings into web/src/wasm
make dev        # complete app; Vite HMR on 9011 and auto-restarting Rust on 9010
make prod       # build the production bundle and run the release server on 9010
make prod-build # build production artifacts without starting the server
```

`make full-test` runs those three stages sequentially and stops at the first failure.
Building WASM first ensures `make check` can run frontend checks on a fresh checkout.
It requires the Quickstart and checking tools above, and downloads Playwright's Chromium
through `make e2e`. OS libraries must be provisioned separately; test commands do not run
the system package manager or request sudo.
Long-running soak, fuzzing and performance targets remain separate.

On supported Debian/Ubuntu installations, provision Chromium's native dependencies once
after installing frontend dependencies:

```sh
npm --prefix web install
npm --prefix web exec -- playwright install-deps chromium
```

On **Arch Linux**, do not use `install-deps` or `--with-deps`: Playwright falls back to an
Ubuntu installer that invokes `apt-get`. Use `pacman` for missing native libraries instead.
Installing [Arch's Chromium package](https://archlinux.org/packages/extra/x86_64/chromium/)
is one way to obtain Chromium's native dependencies (`sudo pacman -Syu --needed chromium`).
Tests still use Playwright's downloaded browser. Arch is not officially supported by
Playwright, so browser/library compatibility must be verified by running E2E.
See [Playwright browser setup](https://playwright.dev/docs/browsers).

Requires a stable Rust toolchain; every target is a plain `cargo` invocation. `make fuzz`
additionally needs nightly and `cargo install cargo-fuzz`, and lives outside the workspace
so the rest of the build stays on stable.

Development listeners use loopback ports `9010`-`9020`: the planned HTTP/WebSocket server
uses `9010`, and the Vite frontend uses `9011` when it runs separately. Ports `9012`-`9020`
are reserved for future supporting services. Production ports remain deployment settings.

### Running it

Start the app, then create your account and first vault in the browser:

```
make dev                                  # open http://127.0.0.1:9011
```

The welcome screen creates the first administrator account without default credentials.
Choose **Create your first vault**, enter a name and short address, then create your first note.
To add another, click the vault name in the top bar to reach **Your vaults**, and choose
**New vault**. Only server administrators see creation controls. New vaults become available
immediately and survive restarts; their Markdown lives in `vaults/<address>/notes/` beside
`server.toml`. Existing vaults are not moved or changed.

First-account setup is restricted to a loopback-bound server accessed through localhost.
Complete it locally before exposing the server through a reverse proxy or network listener.
CLI provisioning remains available for remote/container operators and importing existing
folders: `user setup` and `make vault-add SLUG=personal VAULT=~/Notes ADMIN=jtb`.
CLI `vault create` registers an existing directory; the browser creates a fresh managed one.

**macOS “Operation not permitted” for Documents.** Allow the app that launches the server
(for example iTerm2) to access Documents in **System Settings → Privacy & Security → Files
and Folders**, then restart the server. This is separate from Unix file permissions;
changing permissions with `chmod` is not a fix for macOS privacy protection. Notes are not
deleted by an access failure. The vault page offers recovery guidance and a link back to
your other vaults, without exposing filesystem paths to unauthorized visitors.

Notes are read from `<vault>/notes/` when that directory exists (`SPEC.md` §4.1) and from the
vault root when it does not, so an existing Obsidian folder works unchanged.
When a new vault has no `access.toml`, registration creates one granting the authenticated
creator `owner`; an existing access policy is preserved byte for byte (`SPEC.md` §6.10).

**Starting from an empty vault.** Open `http://127.0.0.1:9011`, sign in, pick the vault, and
use the *New note* form on its page — with no notes there is nothing to click into, so that
form is the way in. From then on the palette's "New note…" (`Ctrl`/`Cmd`+`Shift`+`P`) creates
one beside whatever is open. Every note is a plain `.md` file you can also just write by hand.

Daily notes default to `Daily/%Y-%m-%d.md`; weekly notes to `Weekly/%G-W%V.md`; monthly
notes to `Monthly/%Y-%m.md`. Their command-palette actions open the current note or create it
from `Templates/Daily.md`, `Templates/Weekly.md`, or `Templates/Monthly.md` when that template
is readable. `SPEC.md` §15.1 lists the per-vault `.memberberry/config.toml` overrides.

Theme selection follows the operating system by default. Set `theme = "memberberry-light"`
(Paper), `theme = "memberberry-dark"` (Charcoal), or `theme = "memberberry-pastel"` (Pastel)
in a vault's `.memberberry/config.toml` to choose its default; the **Theme** control in the
top bar can override that choice per device and per vault.

Every content route requires a signed session cookie or a vault-scoped API token and is
filtered by `access.toml`. The server remains loopback-only by default. `make dev` runs both
processes: Vite serves authenticated backend pages with HMR on `127.0.0.1:9011`, proxies API and
WebSocket traffic to Rust on `127.0.0.1:9010`, and rebuilds WASM plus restarts Rust when relevant
Rust sources change. Stop both with one `Ctrl+C`.

The Markdown core also runs **in the browser**, compiled to WebAssembly — the same parser,
canonical serializer and renderer, so the client and the server cannot disagree about what a
note means (`SPEC.md` §5.2):

```
make web        # frontend-only local editor on http://127.0.0.1:9011
make web-test   # frontend tests, including the wasm boundary against real WebAssembly
```

Use the hosts exactly as shown: the Vite frontend may listen on IPv6 `localhost` (`::1`),
while the Rust server listens on `127.0.0.1`.

The CLI does the rest:

```
make vaults                                 # show the registry
make vault-check VAULT=~/ObsidianVault      # read-only: what is not canonical?
make vault-inspect VAULT=some/note.md       # what did the parser see?
make vault-normalize VAULT=~/ObsidianVault  # REWRITES FILES — commit first
cargo run -p mb-cli -- import-obsidian ~/ObsidianVault         # dry-run migration report
cargo run -p mb-cli -- import-obsidian --write ~/ObsidianVault # add missing UUIDv7 IDs
cargo run -p mb-cli -- doctor --config ~/.config/memberberry/config.toml
cargo run -p mb-cli -- doctor --fix --config ~/.config/memberberry/config.toml
cargo run -p mb-cli -- export --static-site ./site --slug personal --username alice \
  --config ~/.config/memberberry/config.toml
```

## Licence

AGPL-3.0-or-later.
