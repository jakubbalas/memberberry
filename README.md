# Memberberry

**Your notes, your server, plain Markdown.**

Memberberry is a self-hosted note-taking app that combines a rich block editor with
the simplicity of a Markdown vault. Write in your browser, connect ideas with wiki-links,
work offline, and sync across devices when you reconnect.

The idea is simple: **if the app disappears, your notes should still be readable.**
Your notes live as ordinary `.md` files in a folder you own. Open them in a text editor,
search them with command-line tools, or keep them in Git. Search indexes and merge history
support the app; they never replace the Markdown files.

Memberberry runs on your own infrastructure, with no required cloud service, telemetry,
analytics, or update checks.

## Features

- **Rich Markdown editing.** Blocks, tables, code, math, callouts, task checkboxes, and
  source editing, with keyboard commands and a workspace that adapts to mobile.
- **Connected notes.** Wiki-links, backlinks, note and block embeds, nested tags, and
  local and vault-wide knowledge graphs.
- **Offline work and sync.** An installable web app with local note replicas, offline
  search and editing, and CRDT-based synchronization across devices. Notes must be
  available on the device before editing offline; media is not cached for offline use.
- **Multiple vaults and sharing.** Folder-level roles, server-side permission filtering,
  collaborative editing, and revocable public share links. Server administration alone
  grants no access to vault contents.
- **Everyday organization.** Full-text search, a task inbox, daily/weekly/monthly notes,
  templates, and a command palette with remappable shortcuts.
- **Visual expression.** Excalidraw diagrams, custom emoji, note covers, and images and
  attachments in S3-compatible storage you control.
- **Capture and recovery.** Web clipping, note history and restore, PDF and HTML note
  exports, and permission-filtered static-site export through the CLI.
- **Familiar vault conventions.** Obsidian-style wiki-links, YAML frontmatter, block IDs,
  callouts, and task metadata, plus a dry-run Obsidian migration tool.
- **Personal themes.** Paper, Charcoal, and Pastel, with vault defaults and per-device
  overrides.

## Run locally

Requires a current stable Rust toolchain installed through rustup, Node.js 22 with npm,
Python 3, Make, and a native C/C++ build toolchain. From a checkout of this repository:

```sh
cargo install wasm-pack --locked # once; skip if already installed
make dev
```

Open **http://127.0.0.1:9011**, create your administrator account, and choose
**Create your first vault**. Give it a name and short address, then create your first note.
You can add more vaults from **Your vaults** in the vault menu.

The first start builds WebAssembly and installs frontend dependencies. `make dev` runs
the Rust server on `127.0.0.1:9010` and Vite with hot reload on `127.0.0.1:9011`;
it restarts the backend as Rust sources change. Stop both with `Ctrl+C`.

First-account setup requires a loopback-bound server accessed through localhost.
Complete it locally before exposing the app through a reverse proxy. Container and
remote operators can provision the account through the CLI; see
[Deployment](docs/DEPLOYMENT.md).

### Production

With the same prerequisites:

```sh
make prod
```

This builds the frontend and optimized Rust binary, then serves the complete app at
**http://127.0.0.1:9010**. To restart without rebuilding:

```sh
./target/release/memberberry serve
```

The process runs in the foreground. For an always-on deployment, the repository includes
a non-root container image and a Compose setup with private MinIO storage. Follow the
[deployment guide](docs/DEPLOYMENT.md) for account provisioning, persistent volumes,
and an HTTPS reverse proxy.

### Your files and configuration

New vaults store notes in `<vault>/notes/**/*.md`, with permissions in the vault's
`access.toml`. Browser-created vaults live under `vaults/<address>/` beside `server.toml`.
Existing vaults registered through the CLI stay at their original paths; legacy vaults
without a `notes/` directory use the vault root.

Server state lives in the platform application-data directory by default:

| Platform | Default directory |
|---|---|
| macOS | `~/Library/Application Support/memberberry` |
| Linux | `$XDG_DATA_HOME/memberberry` or `~/.local/share/memberberry` |
| Windows | `%APPDATA%/memberberry` |

To choose a server-data directory:

```sh
mkdir -p "$HOME/.local/share/memberberry"
MEMBERBERRY_DATA_DIR="$HOME/.local/share/memberberry" make prod
```

Use the same setting on subsequent starts. It selects a configuration location; it
does not migrate existing accounts or vaults. The binary's `--config /absolute/path/server.toml`
option takes precedence. Development and production use the same data when started
with the same configuration.

Back up both your vaults and server state using the [backup guide](docs/BACKUP.md).
Markdown portability does not mean encryption: filesystem access can read the notes,
Git history retains older content, and revocation cannot erase an offline copy someone
already received. See [Security](docs/SECURITY.md) for the full boundary.

### Bring an existing vault

After creating your administrator account, register an existing folder:

```sh
make vault-add SLUG=personal VAULT=~/Notes ADMIN=alice
```

Replace `alice` with your administrator username. Registration creates an owner policy
if `access.toml` is missing and preserves an existing policy.

For an Obsidian vault, preview migration before choosing to add missing note IDs:

```sh
cargo run -p mb-cli -- import-obsidian ~/ObsidianVault
cargo run -p mb-cli -- import-obsidian --write ~/ObsidianVault
```

The first command is a dry run; the second writes missing UUIDv7 IDs. Back up your vault
before migration. The [specification](SPEC.md) documents supported conventions and limits.

On macOS, an “Operation not permitted” error for Documents may require granting the
terminal app access in **System Settings → Privacy & Security → Files and Folders**,
then restarting the server.

## Development

The backend is Rust; the frontend uses Svelte and Tiptap/ProseMirror. The browser and
server share the Rust Markdown parser and serializer through WebAssembly. Yjs/yrs handles
sync, while SQLite and Tantivy provide derived indexes.

```sh
make             # list available commands
make dev         # complete app with hot reload
make test-fast   # Markdown behavioural tests
make web-test    # frontend tests, including the real WASM boundary
make test-props  # Markdown round-trip property tests
make prod-build  # build production artifacts without starting the server
```

For the full non-browser gate, install the additional checking tools:

```sh
rustup component add rustfmt clippy llvm-tools-preview
cargo install cargo-llvm-cov --locked
make wasm
make check
```

Run `make e2e` separately for desktop/mobile Playwright tests, or `make full-test` for
WASM setup, the full gate, and E2E in sequence. E2E downloads Chromium; its native OS
dependencies must be provisioned separately. On supported Debian/Ubuntu installations,
use `npm --prefix web exec -- playwright install-deps chromium` after installing frontend
dependencies. On Arch Linux, install native libraries through `pacman` instead;
Playwright's dependency installer uses an Ubuntu fallback.

CI runs check, web, perf, and fuzz-build on pushes to `main` and pull requests.
Full browser E2E runs through the manually dispatched **E2E (manual)** workflow.
Read [AGENTS.md](AGENTS.md) for contribution rules and verification expectations.

## Documentation

| Document | Contents |
|---|---|
| [Deployment](docs/DEPLOYMENT.md) | Containers, MinIO, persistent storage, and TLS |
| [Backup and restore](docs/BACKUP.md) | Checksummed backups and restore drills |
| [Security](docs/SECURITY.md) | Deployment controls and permission boundaries |
| [Themes](docs/THEMES.md) | Shipped themes and creating a colour scheme |
| [Specification](SPEC.md) | Product behavior, architecture, decisions, and known limits |
| [Original brief](PROJECT.md) | The idea behind Memberberry |
| [Working agreements](AGENTS.md) | Code quality, testing, and security rules |

## Licence

AGPL-3.0-or-later.
