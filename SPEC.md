# Memberberry — Implementation Specification

> Status: **v0.3 — architecture locked, scope agreed.**
> Requirements: `PROJECT.md` + the decision log in §24.
> Audience: the implementing agent. Decisions carry rationale so they are not
> re-litigated mid-build. Working agreements live in `AGENTS.md`.

---

## 1. Product in one paragraph

Memberberry is a self-hosted, offline-capable, browser-first note application that
combines Markdown-vault workflows with rich block-based editing. Notes are stored as plain Markdown
files that remain readable and useful if Memberberry disappears entirely. Editing is
block-based and mobile-friendly. Multiple devices converge automatically via CRDT sync,
including after extended offline periods. Wiki-style links and transclusion produce a
navigable, visualisable knowledge graph. Multiple vaults are supported, each with
folder-level permissions so notes can be shared with other people. Emoji shortcodes are
Slack-grade, including user-uploaded custom emoji. Diagrams are Excalidraw. Media lives
in S3-compatible storage the user controls.

## 2. Non-negotiable constraints

These come from the brief and override convenience at every decision point.

| # | Constraint | Consequence |
|---|---|---|
| C1 | **I must own my data.** | No cloud dependency, no proprietary container, no phone-home, no telemetry. Self-hosted only. |
| C2 | **If the app dies, my notes are still readable.** | A folder of `.md` files is the durable artifact. Everything else is derived or disposable. |
| C3 | **Works without internet.** | Local replica of permitted metadata + search, offline editing, deferred sync, PWA-installable. |
| C4 | **Mobile-friendly.** | Block editing with touch affordances; adaptive shell, not a shrunken desktop app. |
| C5 | **Obsidian migration must be plausible.** | Vault-compatible conventions where cheap: wikilinks, frontmatter, `^block-ids`, callouts, task emoji syntax, `.excalidraw.md`. |
| C6 | **Fast is a feature.** | Responsiveness is a headline requirement, not polish. Budgets in §21 are CI gates. Reference device is a mid-range Android phone (§21.1). |
| C7 | **Permissions must not leak.** | Multi-user means every read path is authorization-filtered, server-side, deny-by-default (§6). |

A change that violates C1 or C2 is not a trade-off to be weighed. It is out of scope.

---

## 3. The central architectural problem

The three chosen pillars are in tension:

- **Plain Markdown files as truth** wants a flat, lossy, human text format.
- **A block editor** wants a rich structured document model.
- **CRDT offline sync** wants an append-only operation history with stable identities.

A `.md` file can represent none of the CRDT history and only a subset of a rich block
model. Pretending otherwise is how this class of project fails.

### 3.1 Resolution — the layered truth model

Three layers. Each layer below the one above is **derivable or disposable**, and the
degradation from losing it is stated explicitly.

```
Layer 1  <vault>/notes/**/*.md            DURABLE ARTIFACT
         + <vault>/access.toml            (permissions — see §6.2)
         Human-readable Markdown. Git-friendly. Greppable.
         Openable in any text editor on a dead laptop.
         >>> This is what C2 promises. It is never optional. <<<

Layer 2  <vault>/.memberberry/crdt/*.bin  MERGE STATE
         Yjs/yrs update log per note, named by the hash of the note's
         canonical vault-relative path. Beside each, a *.last-write
         holding the SHA-256 of the Markdown that note last had written
         to it, so a restart can tell its own unflushed state from a
         file edited while the server was down (§3.3).
         Enables offline editing and multi-device convergence.
         LOSING IT COSTS: merge ability, not content. On loss, the .md
         file is re-imported and a fresh CRDT doc is seeded from it.
         Concurrent unsynced edits on other devices then conflict
         manually rather than merging. Recoverable, annoying, not fatal.

Layer 3  <vault>/.memberberry/index/      DERIVED CACHE
         SQLite (links, tags, tasks, media refs) + Tantivy +
         the per-zone client index segments.
         LOSING IT COSTS: a reindex. Nothing else.
         MUST be reconstructible from Layer 1 alone.
```

**Invariant I1:** deleting `.memberberry/` entirely and restarting the server must yield
a working application over the same notes, **with permissions intact**, losing only merge
history and version history. This is why `access.toml` lives in the vault root and not in
`.memberberry/`. Enforced by an integration test (§22.4).

### 3.2 Why the block editor can still exist

The block editor's document model is constrained to be **isomorphic to a Markdown AST
subset**. Every block type has exactly one canonical Markdown rendering and exactly one
parse back. Features Markdown cannot express are encoded as *readable degradations*
(fenced blocks, callout syntax, wikilink embeds, task emoji), never as opaque blobs.

This is the price of C2 and it is the right price. Memberberry will never have a block
type that renders as gibberish in a text editor.

### 3.3 The write path

```
user types in block editor
   -> ProseMirror transaction
   -> y-prosemirror maps it to a Yjs update          (Layer 2, instantly, local)
   -> IndexedDB persists the update                  (survives tab close, offline)
   -> [when online] update streams to server over WebSocket
   -> server AUTHORIZES the frame (§6.4) then applies to its yrs doc
   -> debounced ~800ms after last edit:
        serialize Y doc -> canonical Markdown
        write notes/<path>.md atomically (temp + rename)   (Layer 1)
        update SQLite + Tantivy + affected client-index zone segment
        snapshot to history if content hash changed        (§18)
```

Markdown is written on a debounce, not per keystroke. Layer 2 is the crash-safe layer;
Layer 1 is the durable-artifact layer. Both matter, at different timescales.

An update is durable when it is **accepted**, not when the debounce fires: the sidecar
append is `fsync`ed before the frame is acknowledged. That is the 3.8 ms floor measured in
§21.6 and the reason a restart can recover.

**On restart**, a coordinator compares the file on disk against its `.last-write` marker:

- **matches** — the file is exactly what this server wrote, so anything the sidecar holds
  beyond it is an accepted, already-broadcast edit the debounce never reached. The sidecar
  wins and the note is re-materialized.
- **differs** — the file changed while the server was down. That is a real external edit and
  goes through §3.4.
- **no marker** (I1: `.memberberry/` was deleted) — rebuild the CRDT from the Markdown.

Without the marker the first inspection after a restart reads the stale file as an incoming
edit and silently reverts acknowledged updates. A graceful shutdown also flushes every open
note, so stopping the server leaves Layer 1 current for git, backups and external editors.

### 3.4 The external-change path (text-editor edit, `git pull`, `scp`)

```
file watcher (notify) sees notes/foo.md mtime change
   -> is this our own write? (compare content hash to last-written) -> ignore
   -> parse foo.md into a block document
   -> materialize the current Yjs doc into a block document
   -> structural diff the two
   -> apply the difference as one Yjs transaction (origin: "external")
   -> update propagates to permitted connected clients as a normal CRDT update
```

External edits are first-class: editing a note in another editor while Memberberry runs works,
and the change appears live in open clients.

**The watcher is a hint, never the authority.** Platforms coalesce events, drop them under
load, and report a rescan instead of a path — a large `git checkout` is exactly the case that
overflows a kernel queue. So the watcher answers "which files might have changed since you
last asked?" and is allowed to answer "I don't know, check everything". A rescan, an
unmappable path or a watcher error degrades to a full sweep, and a periodic sweep runs
regardless, so a lost event is a delay rather than a permanently wrong note. Content hashing
decides what actually changed, which is also what keeps the server's own atomic write from
looping back as an external edit.

The structural diff matches exact unchanged top-level blocks with a linear-memory LCS,
after trimming the common prefix and suffix. Those blocks retain their Yjs identities;
changed spans are deleted and inserted in one transaction with origin `external`. This is
deliberately block-granular: a concurrent edit to the same block produces the divergent
versions described in §3.5 rather than attempting an unsafe character merge without shared
operation history. Frontmatter is diffed and updated per key, preserving A25's convergence
for unrelated metadata edits. A semantic no-op emits no Yjs transaction.

### 3.5 Conflict markers (A24)

An external edit landing while a device is offline with conflicting local edits merges at
block granularity, which can duplicate paragraphs rather than merge words. This is the
inherent "a text file has no operation history" problem and is not solvable in v1. It is
made **visible inline**, never silently merged.

The local version stays in place. The divergent version is inserted immediately after it
as a **callout block**:

```markdown
The layered truth model has three levels.

> [!conflict] Conflicting version — external edit, 2026-08-28T22:41:07Z
> The layered truth model has four levels.
```

A callout rather than git-style `<<<<<<<` markers because it is **already Markdown**: it
round-trips through the canonical serializer with no new block type, renders as a distinct
block in the editor, and degrades in a text editor to an obviously-labelled quote. Git
markers would be readable but are not valid Markdown structure and would need a special
case in the parser.

- The callout carries `Keep mine` / `Keep theirs` / `Keep both` actions that perform an
  ordinary edit through the CRDT — so resolution syncs and is undoable.
- Unresolved conflicts are indexed and surfaced: a badge in the note tree, a count in the
  status bar, and a `memberberry doctor` check.
- Conflict callouts never nest. A second conflict on an already-conflicted block appends a
  sibling callout rather than wrapping.

---

## 4. Data model

### 4.1 On-disk layout

```
<data-dir>/                        # server-owned, never inside a vault
  server.toml                      # bind address, vault registry, storage config
  auth.db                          # users, credentials, sessions, API tokens, share links
                                   # SECRET. Never committed. Never inside a vault.

<vault>/                           # one per vault (§6.1)
  access.toml                      # membership + folder ACL rules — DURABLE (§6.2)
  notes/
    .trash/<opaque-id>.md           # deleted note bodies; still plain Markdown
    Projects/Memberberry.md
    Daily/2026-08-28.md
    Templates/meeting.md
    inbox.md
  drawings/system-diagram.excalidraw.md
  media/a3/f9/a3f91c…e2.png
  .memberberry/
    config.toml                    # vault-local settings (theme, daily-note format…)
    index/
      graph.sqlite
      search/                      # tantivy
      zones/<zone-id>.idx          # per-ACL-zone client index segments (§14.2)
    crdt/<note-uuid>.bin
    history/<note-uuid>/<unix-seconds>-<sha256>.md.zst
    emoji/packs/…
    themes/<name>.css
    trash/                         # metadata only; deleted Markdown stays under notes/.trash/
    workspace/<device-id>.json
```

Unless overridden with `MEMBERBERRY_DATA_DIR` or `--config`, `<data-dir>` is the platform
application-data directory: `~/Library/Application Support/memberberry` on macOS,
`$XDG_DATA_HOME/memberberry` or `~/.local/share/memberberry` on Linux, and
`%APPDATA%/memberberry` on Windows.

**One note = one file** (A2). Folders are ordinary folders, not note containers. A note
with children is simply a note whose links point into a folder of the same name — no
special semantics, no folder-as-note magic.

`.memberberry/` is a single directory so it is trivially `.gitignore`-able. A vault
committed to git contains exactly the human-meaningful artifacts, plus `access.toml`,
which is *intentionally* reviewable in version control.

**Backup contract.** A complete server backup is a coordinated snapshot of the server data
directory, every full vault root, and every configured object store. The server stops cleanly
first so accepted CRDT updates reach Markdown; object-store writers stop before their snapshot.
The supplied Compose job mounts all three stores read-only, writes SHA-256 manifests, and only
publishes a completed backup directory by atomic rename. Backups are secret-bearing plaintext
and require operator-managed encryption, off-host copies, retention, and restore drills.

### 4.2 Note file format

```markdown
---
id: 018f2c4e-7b3a-7000-9c1e-4d5f6a7b8c9d
created: 2026-08-28T21:14:03Z
updated: 2026-08-28T23:02:41Z
tags: [architecture, project/memberberry]
aliases: [MB Architecture]
icon: 🧠
---

# Architecture

The layered truth model has three levels. ^layer-model

- [ ] Write the serializer property tests 📅 2026-09-05 ⏫
- [x] Decide on note identity ✅ 2026-08-28

See [[Memberberry]], embed ![[Memberberry#Goals]], and ![[system-diagram.excalidraw]].
```

`icon` accepts a Unicode glyph or a custom `:shortcode:` and reuses the emoji system
(§11). It renders in the note tree, tabs, title, and graph nodes.

### 4.3 Note identity — stable IDs, human-readable links

- **Identity** is the frontmatter `id` (UUIDv7 — sortable by creation time, better index
  locality than v4). CRDT sidecars, graph edges, history folders, share links and block
  references key on this.
- **Amended in M8: index rows key on the note's vault-relative path, and record the
  frontmatter `id` alongside it.** C2 is why. A note created by an external editor, by a template or
  by `printf > note.md` has no `id:`, and requiring one would mean the indexer *writes to
  the user's files* before it can index them — a rewrite of every note in an imported vault
  as a side effect of opening it. The path is also the identity the rest of the server
  already uses (`CanonicalNote::identity`, the sync room key, the ACL path), so keying on it
  means one notion of "which note" rather than two. The cost is that a rename is a delete
  and an insert to the index, which is correct anyway: M8's rename rewrites the inbound
  links in the same operation.
- **Links in file text are written by human-readable name** — `[[Memberberry]]`, never
  `[[018f2c4e-…]]`. Raw files stay meaningful, preserving C2 and C5.
- The index maintains `name -> id` and `id -> current path`. On rename, every inbound
  wikilink is rewritten vault-wide in one transaction, flowing through the CRDT layer so
  open clients update live. See §6.6 for how this interacts with permissions.
- Name collisions resolve by nearest-path, then by disambiguating on write
  (`[[Projects/Memberberry]]`).
- **Links do not cross vaults in v1.** A `[[…]]` resolves within its own vault only.
  Cross-vault linking would entangle identity resolution with authorization; deferred.
- **Deletion leaves links intact.** Deleting a note moves its Markdown body to the hidden
  `<notes-root>/.trash/` directory for 30 days, while opaque metadata stays under
  `.memberberry/trash/`; inbound wikilinks are **not** rewritten or removed. They become unresolved links
  and render as ghost nodes (§9.1), exactly as if the note had never been written. Silently editing other people's notes because you
  deleted yours is worse than a dangling link, and restoring from trash re-resolves every
  link automatically. `memberberry doctor` reports links pointing into trash.

### 4.4 Block model

Every block type maps 1:1 to canonical Markdown.

> **The authoritative inventory is `mb-core/schema.json`**, which carries the exact node
> names, attributes and content expressions (§5.6). This table is the readable summary; the
> two are held together by `mb-core/tests/schema.rs`, so they cannot drift.

| Block node | Markdown |
|---|---|
| `paragraph` | text |
| `heading` (1–6) | `# ` … `###### ` (ATX only) |
| `bullet_list` > `list_item` | `- ` |
| `ordered_list` > `list_item` | `1. ` (lazy numbering — always `1.`, renderer counts) |
| `task_item` | `- [ ] ` / `- [x] ` plus optional metadata (§10) |
| `blockquote` | `> ` |
| `code_block` | fenced, ` ```lang ` |
| `divider` | `***` |
| `table` > `table_row` > `table_cell` | GFM pipe table |
| `callout` > `callout_title` | `> [!note] Title` / `> [!warning]-` (collapsed) / `> [!conflict]` (§3.5) — Obsidian syntax |
| `math_block` | `$$ … $$` |

**Orderedness belongs to the list, not the item.** An earlier revision of this table named
`bullet_item` and `ordered_item`; that shape cannot represent `1. [ ] x`, a task
inside an ordered list, which this parser accepts. So the list node carries
`ordered`, and `task_item` appears under either list kind.

**`image` and `embed` are inline, not block.** They were listed as blocks here before
implementation; in Markdown both occur mid-sentence, so they are inline nodes and a
"standalone image" is a paragraph containing one. Nothing about their Markdown changes:
`![alt](media/…)` and `![[Note]]` / `![[Note#Heading]]` / `![[Note#^block-id]]` /
`![[x.excalidraw]]`.

**Inline content** splits into ProseMirror marks and atom nodes, because a mark spans a
range of text and an atom does not:

- Marks: `strong` (`**x**`), `em` (`*x*`), `strikethrough` (`~~x~~`), `highlight` (`==x==`),
  `code` (`` `x` ``), `link` — which carries an optional `title`, written back in the
  canonical double-quoted form whichever of CommonMark's three the author used. Named for ProseMirror's convention rather than
  `bold`/`italic`, since the schema *is* a ProseMirror schema.
- Atom nodes: `wikilink`, `image`, `tag` (`#tag`, `#nested/tag`), `emoji` (`:name:`),
  `inline_math` (`$x$`), `footnote_ref`, `soft_break`, `hard_break`.

Block anchors: `^block-id` at end of a block, auto-generated on first reference.
Every block-level node carries the attribute, so any block can be an anchor
target.

**The parser recognises one only on a paragraph or a heading**, which are the blocks a
trailing `^id` can be written on unambiguously — after a table row or a code fence it is
content. A container block therefore never carries one in practice, and a `#^anchor`
reference resolves to the innermost text block that does (§9.2). One consequence is worth
naming because it cost a data-loss bug: a callout's header line and its lazy body lines
arrive as *one* Markdown paragraph, so an anchor written on either is split off that
paragraph before the callout exists. It belongs to the body block when there is one, and
stays as title text when there is not — a callout has no anchor of its own to hold it.
Before M8 it was dropped outright, and `> [!note] T\n> body ^id` round-tripped to
`> body`. Every form is now in a table-driven test
(`every_block_that_can_carry_an_anchor_keeps_it_through_a_round_trip`), because the loss
happened *inside* `parse` — the model that reached the serializer never had the anchor, so
the round-trip and idempotence properties in §22.1 were both satisfied by the broken code.

**Deliberately excluded from v1.** Each would break Markdown isomorphism or balloon
scope. Do not add these without an explicit decision:
- Multi-column page layouts, synced blocks, database/table views with formulas
- Arbitrary HTML blocks, coloured text
- **Mermaid diagrams** — explicitly declined in A9; not an oversight
- **Freeform canvas workspaces** — explicitly declined in A9; Excalidraw covers the need
- **Task recurrence (`🔁`)** — deferred; see §10.4

### 4.5 Canonical serialization

The serializer is **canonical and deterministic**: one document has exactly one Markdown
rendering.

- Bullets `-` always; bold `**`, italic `_`
- ATX headings, no closing hashes
- Backtick fences, minimum 3, extended to exceed any inner run
- 2-space list continuation indent
- Minimal-but-sufficient escaping: escape only what would otherwise reparse
- Task metadata emitted in fixed order (§10.1), single-spaced, after the task text
- Trailing whitespace stripped; file ends with exactly one `\n`
- Frontmatter keys in fixed order: `id, created, updated, tags, aliases, icon`, then user
  keys alphabetically

**Consequence to document for the user:** the first Memberberry edit of an externally
authored non-canonical file normalises it, producing a one-time git diff. This is correct
behaviour, not a bug. `memberberry normalize` does the whole vault up front in one commit.

---

## 5. Technology stack

**Rust core (native + WASM) + Svelte 5 UI shell.**

### 5.1 UI framework — Svelte 5 (A1: performance wins)

Svelte 5 with runes. No virtual DOM, compiled reactivity, materially smaller bundles and
faster cold start than React — exactly what A1, A15 and C6 ask for.

Excalidraw is a React component. Rather than making the whole shell React for one island,
**React + Excalidraw are a lazily-loaded chunk** fetched only when a drawing is opened.
React never enters the critical path, cold start never pays for it, and given A1's note
that diagrams are not heavily used, this is the right allocation.

Tiptap's core is framework-agnostic vanilla JS (`@tiptap/core` over ProseMirror); the
React/Vue wrappers are conveniences we do not need.

**Adopted in M7.** Svelte 5.57 with `runes: true` set in `svelte.config.js` rather than left
to default, so a component written in the Svelte 4 store style fails to compile instead of
working slightly differently from every component beside it. **No SvelteKit**: `mb-server`
already serves the pages and the assets, and a meta-framework would add a second router and
a second build to a project that has both.

- **`@sveltejs/vite-plugin-svelte@6`**, not 7. Version 7 requires Vite 8; this project is on
  Vite 6, and `--force`-ing the peer range is the "widen it until the error goes away" that
  AGENTS.md §7 rules out. `vite` is declared `^6.3.0` — the plugin's real floor — so a fresh
  `npm ci` cannot resolve a Vite the plugin refuses.
- **`svelte-check` runs in `npm run typecheck`.** `tsc` does not look inside a `.svelte`
  file, so without it AGENTS.md §4.3 would simply not apply to components.
- **Components are tested with Svelte's own `mount`/`unmount`** in jsdom, with no testing
  library: what is needed is opening and closing a component, and a dependency for that is a
  framework for one use case (§4.1). Vitest needs `resolve.conditions: ["browser"]` under
  `VITEST` or `mount()` gets Svelte's server entry and throws.
- **The measured cost is ~13 KB gzipped.** See §21.1: the critical-path budget is breached,
  and Svelte is not why.

The bootstrap moved with it. `web/index.html` carries
`<div id="app" data-vault="" data-note="" data-user=""></div>`, which `mb-server` replaces
with the same element carrying escaped values (§3.3). **A build without that element is a
`500`, not a page**: `str::replace` on an absent marker is a no-op, so a mismatched
`web_root` would otherwise serve a page whose bootstrap is empty — and the editor would
quietly run against a local-only replica instead of syncing, while looking like working
software.

### 5.2 The honest WASM assessment

**Where WASM does NOT belong:** driving the DOM for a rich-text editor. ProseMirror
encodes ~15 years of knowledge about contenteditable, IME composition, mobile virtual
keyboards, and selection edge cases. Reimplementing it in Rust would consume the project
and produce something worse. The editor view layer is TypeScript.

**Where WASM genuinely earns its place:**

1. **The Markdown parser/serializer must be byte-identical on client and server.** Two
   implementations drift, and drift here means the file on disk disagrees with what the
   user sees. One Rust crate compiled both ways eliminates the class of bug.
2. **The compact client-side search index (§14.2)** is built, queried and incrementally
   merged in Rust. A5 makes this a headline feature and it is the strongest WASM case in
   the project — an FST + postings engine is exactly what JS is bad at and Rust excels at.
3. **`yrs`** is the Rust Yjs implementation, wire-compatible with JS Yjs, so the server
   speaks CRDT natively.
4. **HTML → block-document conversion for the web clipper (§16)** reuses the canonical
   block model rather than growing a second, divergent converter.
5. **Task metadata parsing (§10)** is shared by editor chips, index, and query views.
6. **A future Tauri desktop client** reuses the core natively, with no WASM boundary.

**Where WASM is weaker than I would like, stated so it is not a surprise:** the browser
cannot write your filesystem, so client-side Markdown serialization serves source-view,
copy-as-markdown and export — not the primary write path. If the toolchain becomes a drag,
the fallback is server-only serialization plus a JS renderer, and the project survives.
The search index is the part that would genuinely hurt to lose.

### 5.3 Crate / package layout

```
crates/
  mb-core/        Block model, Markdown parse + canonical serialize, wikilink/tag/
                  anchor extraction, task metadata, emoji resolution, HTML->blocks,
                  blocks->HTML, template expansion, ACL resolution.
                  NO I/O. NO async. Pure. Compiles to native and wasm32.
  mb-crdt/        yrs integration. Y-doc <-> block document in the y-prosemirror
                  shape. Structural diff for the external-change path.
  mb-search/      Compact index: FST term dictionary + delta-varint postings +
                  snippets. Build, query, merge, zone segmentation. native + wasm32.
  mb-wasm/        wasm-bindgen surface over mb-core / mb-crdt / mb-search.
  mb-index/       SQLite (rusqlite) graph/link/tag/task/media store + Tantivy.
                  M8: the store, the incremental reconcile and the permission-filtered
                  reader. Tantivy arrives with M9. Native only — it is the one crate that
                  owns a database file.
  mb-auth/        Users, sessions, API tokens, share links, permission enforcement.
  mb-server/      Axum. HTTP + WebSocket, vault registry, file watcher, indexer,
                  media, sync coordinator, history, sharing.
  mb-cli/         memberberry {serve, vault, user, normalize, reindex,
                  import-obsidian, export, doctor, gen-vault, inspect}
web/
  src/editor/     Tiptap schema (generated from schema.json) + y-prosemirror
  src/shell/      Svelte 5 workspace: panes, tabs, sidebars, adaptive layout
  src/excalidraw/ React island, lazily chunked
  src/wasm/       generated bindings from mb-wasm
  (public shares are server-only self-contained HTML in mb-server; see §17)
clipper/          Browser extension (MV3 + Firefox), shares mb-wasm
```

**`blocks->HTML` lives here, added in M0.** It is pure string building, and three
surfaces have to agree on it: the M0 read-only server, the anonymous share-link renderer
(§17.2), and a client-side preview. One renderer in the shared crate is what stops them
drifting, exactly as one parser does. It carries its escaping rules with it — every text
node, every attribute, and a URL scheme allowlist — because that is a property of rendering
untrusted note content rather than of any one caller.

### 5.4 Key dependencies

| Concern | Choice | Note |
|---|---|---|
| HTTP/WS server | `axum` + `tokio` | |
| CRDT | `yrs` (server) / `yjs` (client) | wire-compatible |
| Editor | ProseMirror via **Tiptap v3 core** | §5.5 |
| CRDT↔editor | `y-prosemirror` | most battle-tested binding in existence |
| Client persistence | `y-indexeddb` | |
| Markdown | `pulldown-cmark` events + custom canonical serializer | off-the-shelf serializers are not canonical enough |
| Client index | `fst` + custom postings codec | §14.2 |
| Server search | `tantivy` | |
| Graph/task store | `rusqlite` (bundled SQLite) | |
| File watching | `notify` | |
| Object storage | `object_store` | S3/MinIO + local filesystem backends |
| Compression | `zstd` | history snapshots |
| HTTP compression | `flate2` (`miniz_oxide`, pure Rust) | §21.7; ninety lines beat `tower-http` here |
| Password hashing | `argon2` (argon2id) | |
| Drawing | `@excalidraw/excalidraw` | lazy React chunk |
| Graph render | WebGL, `sigma.js` or custom | worker layout, LOD; §9.4 |
| Article extraction | `@mozilla/readability` | clipper only |

### 5.5 Editor library — Tiptap, not BlockNote

BlockNote is the obvious block-editor pick and is rejected deliberately: it owns its
schema and its Markdown export is lossy. Under C2 the schema *is* the contract with the
file format, so it must be ours. Tiptap gives block UX over a custom ProseMirror schema
defined to be Markdown-isomorphic.

### 5.6 The y-prosemirror shape constraint — read before writing `mb-crdt`

`y-prosemirror` stores the document as a `Y.XmlFragment` mirroring the ProseMirror
schema. `mb-crdt` on the server must walk **that exact shape** to serialize Markdown.

> **The ProseMirror schema is a cross-language contract.** It is defined once, in
> `mb-core/schema.json`. The TypeScript schema and the Rust walker are both generated
> from — or validated against — that file. A schema change is a breaking change that moves
> both sides together, with a fixture update.

This is the single most likely source of subtle bugs in the project. It gets a dedicated
conformance suite (§22.2).

Frontmatter is a sibling `Y.Map` named `frontmatter`, alongside the `Y.XmlFragment` named
`prosemirror` (A25). Known scalar keys are Yjs strings and `tags` / `aliases` are string
arrays, so concurrent changes to different keys merge independently. User scalar and list
values use those same native values. Raw YAML blocks use the JSON envelope
`{ "$memberberry": "raw", "lines": [...] }`, preserving every source line without putting
frontmatter into the prose schema. This root pair is part of the cross-language contract.

**Rust side, as built in M1.** `mb_core::schema` holds the vocabulary as types (`Node`,
`Mark`) and maps the block model onto it with exhaustive matches, so a new `BlockKind` or
`Inline` variant stops compiling until it is given a schema node. `mb_core::schema::validate`
covers the constraints a content expression cannot state — a table's rows matching its
column count — and is what the M2 sync boundary uses to reject a malformed client document.
`mb-core/tests/schema.rs` asserts the two agree with `schema.json` field by field, and that
every node in the file is reachable from a real parse.

The model is deliberately narrower than a content expression where the type system can do
the work instead: `HeadingLevel` cannot hold a level outside `1..=6`, and `Option<Anchor>`
cannot hold an anchor kind without its text. Every rule that moves from `validate` into a
type is one fewer thing to remember.

---

## 6. Vaults, users, and permissions

New in v0.3 from decisions A13, A14, A17, A18. This is the largest single addition to
the design and the one most able to produce security bugs, so it is specified tightly.

### 6.1 Vaults (A13)

A **vault** is the unit of: file root, index, CRDT store, history, emoji packs, themes,
and permissions. One server hosts several.

- Registered in `<data-dir>/server.toml` with a slug, display name, and path.
- Routes: `/v/<slug>/…` in the UI, `/api/v1/vaults/<slug>/…` in the API.
- CRDT document IDs are namespaced `<vault-id>:<note-id>`; a single WebSocket carries
  subscriptions across vaults the user can reach.
- Workspace state is per `(device, vault)` (§8.1).
- Search defaults to the current vault, with an opt-in "all vaults I can read".
- Links, transclusion and the graph are **vault-scoped** (§4.3).
- The browser's **Your vaults** page provides first-vault guidance and **New vault** for
  enabled server administrators. `/vaults/new` accepts a display name and validated slug,
  creates `<config-directory>/vaults/<slug>/notes/`, and atomically persists `server.toml`.
  The live registry updates without restart and its managed parent directory is watched.
  Creation refuses existing directories (including symlinks); it never imports, adopts,
  overwrites or moves an existing folder. No arbitrary server path is accepted from a browser.
  `memberberry vault {list, create, remove}` remains available for operators and existing-folder
  registration. Do not concurrently edit the registry with the CLI or an external editor.
  An unreadable vault page gives already-authorized members recovery guidance without naming
  server paths; unknown or unauthorized vault requests retain the neutral refusal.
- Registering a vault whose root has no `access.toml` writes one explicit `owner` membership
  for the authenticated server administrator performing the registration. An existing policy
  is never changed. This is durable authorization, not an admin bypass: after creation the
  same `access.toml` is the only source of content access (§6.2).

Building this now rather than retrofitting is exactly right: vault-scoping every index
query, route, and doc ID later would touch every file in the project.

### 6.2 Where permissions live — `<vault>/access.toml`

Permissions are part of the **durable artifact** (Layer 1), not the disposable index.
They must survive Invariant I1, be reviewable in git, and be hand-editable in an
emergency.

```toml
# Vault-wide baseline
[[members]]
user = "jtb"
role = "owner"

[[members]]
user = "alice"
role = "viewer"

# Folder rules cascade to descendants
[[rules]]
path  = "Projects/Shared"
grant = { alice = "editor" }

# Per-note override beats the folder rule
[[rules]]
path  = "Projects/Shared/Salary Review.md"
grant = { alice = "none" }
```

**Credentials never live here.** Usernames are references; password hashes, sessions and
tokens live in the server-level `auth.db`, which is secret and outside every vault. If
`auth.db` is lost, ACL rules survive and users are re-invited — consistent with I1.

The authenticated vault list and browser shell expose a `Log out` control. It revokes the
current signed session server-side, expires the `mb_session` cookie, and redirects to the
sign-in page; repeating logout is harmless.

### 6.3 Resolution algorithm (A18: folder inheritance + per-note override)

`mb-core` exposes a pure, exhaustively-tested function:

```
effective_role(user, note_path) -> owner | editor | viewer | none
```

1. Start from the member's vault-wide `role` (absent member ⇒ `none`).
2. Walk `rules` matching the note path, from shortest path to longest.
3. Longer (more specific) path wins. A note-level rule beats any folder rule.
4. An explicit `none` beats any inherited grant — denial is expressible at any level.
5. Ties are impossible: paths are normalized and duplicates rejected at load with an error.

Roles: `owner` (read, write, manage ACLs, delete vault), `editor` (read, write, create,
delete notes), `viewer` (read only), `none` (as if the note does not exist).

Being pure and I/O-free, this is unit-testable to exhaustion — and it is, with property
tests asserting monotonicity (a longer rule never grants less than intended), that `none`
is absorbing, and that resolution is order-independent.

### 6.4 Enforcement points — the complete list

Deny by default. Every one of these is a place a permission bug can hide, so each is
enumerated, each is tested, and `AGENTS.md` requires a new one to be added here before it
ships.

| # | Surface | Rule |
|---|---|---|
| E1 | HTTP routes | Every route resolves `(user, vault, path) → role` before doing anything. |
| E2 | **WebSocket doc subscription** | A client may subscribe only to docs it can read. A document's room is keyed by the note's *canonical identity*, never by the name the client sent: one file is one room and therefore one writer. |
| E3 | **WebSocket update frames** | Every incoming update is authorized *per frame*, not once per connection — and so is every **outgoing** one. A room admits a peer once; each broadcast re-asks whether that recipient may still read the document, and drops it from the room if not. A viewer's frames are **rejected with an error**, never silently dropped — the client must know it is read-only. A caller who cannot read the note at all gets the neutral denial below instead, because `read_only` would confirm the note exists. |
| E4 | Awareness / presence | Broadcast only to users who can read that document, re-checked per frame exactly as E3 is. |
| E5 | Index queries | Every SQLite/Tantivy query carries a readable-set or path-prefix predicate. There is no unfiltered query helper in the codebase. **M8:** `mb-index` exposes no connection; queries live on a `Reader` that cannot exist without a user and an ACL, and read every content table through a view that joins a per-reader readable set. Two tests hold it: one fails if a read path names a base table, one fails if a view stops joining the set — because the filters are individually sufficient for today's queries, so no behavioural test can see the second one go. |
| E6 | Client search index | Assembled per user from permitted zone segments (§14.2). The client never receives data it may not read, so it never filters. **M9:** every indexed note is assigned to its deepest matching maximal zone and one binary-v1 segment is published under `.memberberry/index/zones/` per zone. `Reader::client_segments` is the only assembly surface: it captures the permitted `(zone_id, acl_hash)` pairs from the live ACL and returns bytes only when both still match the published snapshot. `GET /search/segments` carries that manifest; the binary endpoint repeats both checks, so a stale manifest cannot retrieve a changed epoch. The browser transactionally removes absent or changed epochs before fetching, validates every binary through `mb-search` in WASM, and refuses a late response whose manifest entry was revoked. A partial rebuild, stale permission epoch, non-member or malformed persisted zone fails closed to no bytes. |
| E7 | Transclusion | Resolved against the requesting user's readable set; unavailable targets render as "unavailable" (§9.2). **M8:** three filters on `…/embed/{target}` and `…/resolve/{target}`, in order — membership plus a readable *source* note, because `from` steers §4.3's nearest-path tie-break; resolution against this caller's readable set, so an unreadable target is not a candidate (E9); and the read back through the repository, because the index says *which* note and never that it may be read. A missing target and an unreadable one are the same empty-handed reply, so the placeholder cannot say which. The second filter is defence in depth and **no behavioural test can observe it** — see `HANDOFF.md`. |
| E8 | Backlinks & unlinked mentions | Filtered by readable set — titles leak otherwise. **M8:** a backlink from a note the caller cannot read is absent, and an unreadable *target* has no backlinks because it does not exist for them (§6.5); the route answers a denial exactly as it answers an unknown vault. **M9 adds unlinked mentions to the same response and the same three filters**, with the readable set entering the Tantivy query as a required exact-path clause rather than filtering its results (E5). A mention discloses more than a backlink if the filter is lost — a backlink row leaks a title and the block a link sits in, whereas a mention has no link to have been found by, so what puts it on screen is only that a private note happens to use a word, and the row then quotes that note's prose. It is a second code path (Tantivy, not SQLite) to the same data, so it has its own leak-suite case. |
| E9 | Graph | Nodes and edges filtered by readable set; edges into unreadable notes are dropped entirely. **M8:** link resolution draws candidates from the filtered view, so an edge into an unreadable note is never formed — which also means one link can resolve differently for two users (§9.1). The local-graph route (§9.4) is the same three filters as `backlinks`: membership plus a readable *origin* through `AuthorizedVault` (E1), a `Reader` built from the live ACL so every node comes from the readable set (E5), and resolution against readable candidates only. What is left is a **ghost** — an unreadable target and one nobody has written are one node, one shape, one label taken from the source note's own text, because §6.5 does not allow the picture to tell them apart. An unreadable origin answers exactly as a missing one does. **M8, the whole-vault route** (`GET /api/v1/vaults/{slug}/graph`) has no origin to resolve, so its filters are membership on the vault and the readable set — every readable note is a node and nothing else is. Two things it discloses that the neighbourhood does not, and both are filtered: a node carries the note's **tags** and its **word count**, and the reply carries a **total** so a capped picture can say "showing 2,000 of 10,431". The total is counted over the readable set, because a count of the whole vault is a way of asking how many notes exist (§6.5). |
| E10 | History & versions | Same role as the note. |
| E11 | **Media** | Content addressing is *not* authorization. `media_refs(note_id, path, original_name)` backs the check: a user may fetch a blob only if it is referenced by a note they can read. The sole pre-reference exception is a five-minute grant scoped to the authenticated editor who uploaded those same bytes, bridging the upload and the note's indexed save; it never grants another user access. Easy to miss; it is a real leak if missed. |
| E12 | Tasks & task views | Filtered by readable set. |
| E13 | Share links | A separate anonymous path with its own rules (§17). The authenticated management routes authorize the exact note before creation and scope listing/revocation to the creator; bearer tokens are never returned by list. The `/s/<token>` renderer re-authenticates the opaque token, then re-checks the link creator's current enabled account and readable set before reading the note. Its media route requires the signed share-session cookie, re-checks the same creator-readable set, and permits only media referenced by the shared note. Expiry, revocation and password failures are neutral unavailable responses. Anonymous share and media requests are bounded independently by token and by the trusted peer IP supplied by the server connection layer; forwarded headers are not trusted. |
| E14 | **Rename / link rewrite** | §6.6. **M8:** the one operation that reads outside the caller's readable set, on purpose — a link left broken in a note they cannot see is worse. What contains it: the note being renamed is resolved through the *caller's* `AuthorizedVault`, so an unreadable one answers exactly as a missing one; both ends need `editor` or better, and a tag rename needs vault-wide `owner`; the privileged read is an ordinary index `Reader` holding a synthetic `owner` ACL, so E5 is untouched; and the reply counts only notes the caller can read, with the full list going to the audit log (§6.9). Shape checks on the new name run *before* authorization, existence checks after, so a rename cannot be used to probe for notes. |
| E15 | **Workspace layouts and bookmarks** (§8.1, §8.2) | A layout is one user's list of open notes, which is the same class of data as presence — E4 filters awareness precisely because it reveals which note a person is reading. The file is keyed by the **authenticated** user, and there is no route parameter naming whose layout it is, so there is nothing to substitute. Requires vault membership, not note-level access: a layout is not a note. The device id is parsed into a validated type before it can become a filename. **Bookmarks are additionally filtered on read**: they outlive the permission that created them, so a revoked note must leave the list rather than keep showing its name. |

| E16 | **Tag pane** (§9.3) | Both the tree and the per-node counts come from the readable set. A tag is a claim about notes: one carried only by notes the caller cannot read has no node, and a shared tag's count names only the notes they may see (§6.5). Membership is checked for the vault rather than per note — there is no path in the request — so a non-member gets the same empty-handed reply as an unknown vault rather than an empty tag list. |
| E17 | **Note creation** (§6.10) | The first write path asked about a path that does not exist yet, which is the shape that leaks: "you may not" and "that is already there" are different answers about a note the caller may not know exists. Three rules contain it. **Ordering**: the name's shape is checked lexically first (it reveals nothing — the caller sent it), then authorization against the live ACL, and the filesystem only last, so creation cannot be used to probe for notes. **Scope**: `editor` or better *for the path being created*, so §6.2's per-folder grants bound where a member may create exactly as they bound editing. **One refusal**: a non-member, a viewer, and a member writing outside their grant get the identical denial whether or not a note sits at that path. Both entry points — the JSON route the workspace uses and the fallback form on the server-rendered vault index — call one `CreateNote`, so there is one enforcement point and not two. |
| E18 | **Task inbox** (§10.3) | An inbox row names a source note and quotes its task text, so it is a content-bearing read. Vault membership is checked before the index opens; `Reader::tasks` reads only `v_tasks`, `v_notes`, and `v_tags`, each joined to the live readable set. Filtering happens before rows are returned, so a task in an unreadable note is indistinguishable from no task. |
| E19 | **Templates** (§15.2) | Templates are ordinary Markdown notes under the configurable folder (default `Templates/`). Both the list and body routes pass through `AuthorizedVault`; a caller cannot use template insertion to name or read a note outside their readable set. |
| E20 | **Calendar-note metadata** (§15.1) | Daily, weekly and monthly metadata lists only paths returned by `AuthorizedVault::notes`; a private calendar note contributes neither its period nor its path. Calendar-note creation still uses E17's single `CreateNote` enforcement point. |
| E21 | **Excalidraw drawings** (§13) | Drawing reads and writes are restricted to `drawings/*.excalidraw.md`; reads require the caller's readable set and writes require editor access at the exact path. Scene JSON is parsed only after authorization, and invalid or absent drawings never reveal whether a protected path exists. |
| E22 | **Custom emoji packs** (§11.2) | Pack manifests and image bytes are exposed only through a readable vault route and carry `Cache-Control: no-store`, so a cached response cannot outlive a revocation. Resolution layers vault-local packs over shared server packs; invalid manifests, missing files, traversal and unreadable vaults all fail closed without naming a pack. Pack listing/deletion requires vault owner access for local packs or server-admin access for shared packs. |
| E23 | **Web clipper** (§16.3) | The clip route authenticates before fetching, applies both the live ACL and any scoped token role to the exact destination path, then permits only editor or owner access. Remote work starts only after authorization and a per-user/per-vault rate check. Each hostname is resolved and pinned before every request and redirect; private results fail closed. Scheme, credentials, redirects, response sizes and total clip duration are bounded. Staged media grants are rechecked for the authenticated uploader. SSRF refusals and network failures are intentionally neutral. |
| E24 | **Trash and deleted-note restoration** (§4.3, §18.2) | Delete and restore require the current editor-or-owner role for the original path. Deleted bodies remain plain Markdown under `<notes-root>/.trash/`; only opaque metadata lives in `.memberberry/trash/`. Trash listing filters entries through that same readable set, never accepts a client-supplied actor, and purges Markdown, metadata, sidecars and history only after the configured retention window. A restore refuses to overwrite a newly-created note at the original path. |
| E25 | **Whole-vault static export** (§19.2) | The CLI requires an existing enabled account and constructs an `AuthorizedVault` from the live `access.toml` before reading any note. Pages, search data, graph edges and copied media are all derived exclusively from that readable view. Export is built in a temporary directory and published only after it is complete; a successful run replaces the whole prior output, so tightening an ACL cannot leave a stale private page from an earlier run. |
| E26 | **Browser vault creation** (§6.1) | Only an enabled server administrator authenticated by a signed session may create a vault. Scoped API tokens do not grant server administration. Authorization and same-origin checks precede filesystem access; validated slugs cannot traverse out of the managed root. New vaults receive an explicit owner ACL for the creator, with no change to any existing vault's access. |
| E27 | **Browser first-account setup** (§6.8) | Only an uninitialized, loopback-bound server with a trusted loopback peer and localhost Host accepts the setup form. Origin validation rejects cross-site claims; forwarded headers cannot supply the peer. The auth transaction permits exactly one initial administrator. Once initialized, GET and POST both return a neutral not-found response. |
| E28 | **Empty folders** (§8.2) | `GET /api/v1/vaults/{slug}/folders` requires vault discovery access and returns only physically empty directories the caller can read, through `AuthorizedVault::empty_folders`. Hidden directories and symlinks are excluded. Nonempty folders remain inferred from readable notes, so a folder containing only denied notes remains invisible. `POST` requires editor-or-owner on the requested folder path before any filesystem lookup, validates containment, and refuses existing paths without overwriting. A denied existing and absent path give the same response. |

**Every sync-frame denial is one reply.** An unknown vault, a path that does not resolve,
a missing ACL and a role of `none` all return the same `not_found` error frame. Sending
*nothing* is also a distinguishable answer, so no denial is silent: a caller who times out
on one probe and gets an error on another has learned which notes exist.

**ACLs are live.** `access.toml` is re-read whenever its size or modification time changes,
on the maintenance tick, so a grant or revocation — including one `invites.rs` writes
itself — takes effect on the next frame rather than the next restart. A reload that fails to
parse installs a deny-all policy for that vault and logs loudly, per §3.1: malformed input
denies everything. This is what makes E3 and E4's per-frame re-checks load-bearing rather
than structural.

**Sync connections are bounded.** A frame is capped at 512 KiB and a connection at 240
frames/second, because awareness carries opaque client JSON that is rebroadcast to a whole
room. A room is released — coordinator flushed and dropped — when its last subscriber
leaves, so a note nobody has open costs no memory and no file watching.

### 6.5 The invisibility rule (A17)

**A note a user cannot read does not exist for that user.** No graph node, no backlink
row, no search hit, no quick-switcher entry, no title anywhere. Transclusions of it render
as a neutral "content unavailable" placeholder that does not reveal the target's name.

Chosen because it is the only rule that is *simple enough to actually hold*: one filter
applied at the index layer, rather than a per-feature leak audit that will eventually be
forgotten. The cost — a shared note may contain a link that dead-ends with no explanation
— is real and accepted.

**Consequence:** the readable-set filter must be applied at the **index/query layer**, not
sprinkled through feature code. Features query an already-filtered view.

### 6.6 Rename and link integrity under ACLs

Renaming a note rewrites inbound wikilinks in notes the actor may not be able to write.
Leaving them broken is worse than the alternative, so:

- The rewrite runs as a **privileged system operation**, justified by the actor's right to
  rename the target.
- It is **audit-logged** with actor, time, and every file touched.
- It rewrites **only the link text**, never any other content — enforced by asserting the
  diff touches only link spans, and tested.
- Same mechanism for tag renames (§9.3).

**Implemented, M8.** `POST /api/v1/vaults/{slug}/rename` takes `{kind, from, to}` where
`kind` is `note` or `tag`. Seven decisions, each of which had a plausible alternative:

- **The rewrite is surgical, not a re-serialization.** Parsing a note, changing the target
  and serializing it back is four lines and would rewrite the whole file into canonical
  form — bullets, emphasis delimiters, table pipes and all. Doing that to a note the actor
  cannot even read is not a rename, it is a reformat, so `mb_core::rewrite` splices new
  names into the exact byte ranges the old ones occupied and copies everything between them
  verbatim. The renamed note itself also has its first level-one heading rewritten to the new
  filename stem; a legacy note without one receives that heading before its existing body.
- **What makes the surgical version safe is a model-level oracle.** The rename is applied to
  the parsed *document* as well, and the spliced text is refused unless it parses back to
  exactly that document. That catches both directions at once — touching something that is
  not a link, and missing a link — so the text scanner's fidelity decides whether a rename
  *succeeds*, never whether it corrupts. A refusal is total: nothing is written for any
  note. The known trigger is a new name carrying a character that pairs with one already in
  the note, such as a `$` that turns the span into maths.
- **The privileged read is a named principal, not a bypass.** The operation resolves inbound
  links through an ordinary `mb-index` `Reader` holding a synthetic vault-wide `owner` ACL
  for `memberberry-system`. E5 keeps its property — there is still no unfiltered query and
  no exposed connection — and §4.3's resolution rule stays the one in `readable.rs` instead
  of being written a second time. A link that resolves to a *different* note of the same
  name is therefore not touched.
- **A tag rename requires vault-wide `owner`.** A note rename is justified by the actor's
  right to rename that note; a tag is a name spread across notes with different ACLs, so
  there is no equivalent target to point at. `owner` is the narrowest existing role that
  already implies authority over the whole vault. Renaming a prefix moves the whole subtree,
  and frontmatter `tags:` are rewritten alongside inline ones (§9.3).
- **The reply counts only what the actor can read.** "47 notes updated" answers "how many
  notes link to this one", which §6.5 makes a way of asking how many notes exist — the same
  argument as E16's tag counts. The full list of files touched goes to the audit log, which
  has no UI (§6.9). A note that cannot be rewritten is likewise not named in the refusal.
- **Links are rewritten to the new bare filename when it is unique in the vault, and to the
  full path when it is not.** A bare name is what a human writes and survives the next move;
  a path is the only spelling §4.3 guarantees cannot resolve to the wrong note.
- **Order matters, and the failure mode is stated rather than hidden.** Every rewrite is
  computed in memory first; then the note's sync room is flushed and closed (a coordinator
  holding the old path would otherwise recreate the file at its old name on the next
  debounced write); then the file moves and its CRDT sidecar moves with it, so the editing
  history survives and no later note created at the old path inherits it. Only then are the
  rewrites written, and the index swept again. A failure during those writes leaves the note
  moved and some links stale — recorded in the audit log and fixed by re-running the rename.
  The reverse order would instead point every link at a note that does not exist yet. The
  *second* sweep is the one allowed to fail quietly: the files have already moved, the index
  is derived state, and the maintenance tick reconciles it anyway — reporting it as a failed
  rename would be reporting the wrong thing.

**Implemented.** Editing the protected first H1 uses the same rename endpoint as the context
menu, so the filename, sidebar title, and open tabs stay synchronized. Filename-only
normalization maps emoji shortcodes and filesystem-reserved characters to safe segments while
the Markdown H1 retains the title the user typed.
Title protection applies only when the current note already starts with an H1. Legacy
Markdown without a leading H1 remains editable, including conflict insertion and resolution;
the editor does not reject those transactions merely because the note has no title block.
Titles received through sync update the editor's title baseline without initiating a rename;
only a local title change commits a rename when the user leaves the title. Body text in a
note without a leading H1 is never treated as its title for automatic renaming.

**Not covered.** A client with the note open is not told it moved; there is no "renamed"
sync frame and inventing one is §7.1's business. It receives the same neutral `not_found`
a deleted note gives, and the client that asked for the rename reopens it itself.

### 6.7 The honest limits of this model

Stated plainly so no one assumes more than is delivered:

- **ACLs are application-level, not encryption.** Anyone with filesystem access to the
  vault — SSH, a backup, the host machine — reads everything regardless of `access.toml`.
  This follows directly from C2: readable files cannot also be secret files. Memberberry
  is for sharing with people you trust, not for keeping secrets from your sysadmin. This
  must appear in user-facing docs, not just here.
- **Revocation is not retroactive for offline clients.** A user whose access is revoked
  while offline keeps whatever they already replicated until they reconnect, at which
  point the server instructs the client to drop the affected zone segments and note
  bodies. Unavoidable in an offline-first system; documented rather than pretended away.
- **Git history leaks.** If the vault is in git, a note's earlier content survives in
  history even after an ACL tightens. Note it in the docs.

### 6.8 Authentication

- Users in `auth.db`: id, username, display name, argon2id hash, created, disabled,
  **`is_admin`**.
- First-run setup creates the first user as admin interactively; no default credentials, ever.
  `serve` starts even before an account exists. `/` directs first-time visitors to `/setup`,
  then to first-vault creation after their account is created and signed in. Browser account
  setup is single-use, requires a loopback listener, a trusted loopback peer and a localhost
  Host header; forwarded IP headers cannot enable it. Complete it locally before exposing
  a reverse proxy. Remote/container provisioning can continue using the CLI. Setup and vault
  creation POSTs require a matching Origin and reject cross-site requests, with 8 KiB bodies.
  `user setup`, `user reset-password`, `vault create` and `vault remove` prompt for passwords
  on `/dev/tty` via `rpassword`, so nothing is echoed and nothing lands in `argv`.
- **`--password-stdin`** (resolved in M7; this was a known gap through M5) reads the password
  from stdin instead of prompting, which is what makes scripted and containerized
  provisioning possible — previously it needed a pty (`expect`, `script`). `reset-password`
  expects two lines: the administrator's password, then the new one. The password still never
  appears in an argument, where it would be visible in the process list. `mb-cli`'s
  `the_binary_provisions_a_server_from_a_pipe_with_no_terminal` spawns the real binary to
  prove it, because an in-process test with an injected reader cannot tell stdin from a tty —
  which is how the gap survived as long as it did. M18's docker-compose depends on this, and
  so does the M7 E2E suite, which has to provision a server before it can open a browser.
- **Server admin** is a flag, not a vault role. It is required for the few operations that
  exist above any single vault: creating and removing vaults, managing the shared emoji
  packs (§11.2), and resetting passwords. Admin does **not** implicitly grant read access
  to vault contents — an admin who is not a member of a vault sees nothing in it, and the
  invisibility rule (§6.5) applies to them unchanged. Admin is about server administration,
  not omniscience; granting content access requires editing that vault's `access.toml`,
  which is itself audit-logged.
- **The sign-in page is server-rendered and self-contained** — no external assets and no
  JavaScript, so it works when the bundle does not. Fields are stacked, labelled by `id` and
  at least 44px tall (§20.3). A refused attempt re-renders **the form**, with the reason
  above it in `role="alert"` and the username kept, under the same `form-action 'self'` as
  the first attempt. Both halves of that are failures the project has already had or nearly
  had: a page that carries a form and forbids submitting it is the M5 outage (§22.6), and a
  page that carries the reason and *no* form is a dead end whose only exit is the address
  bar. The password is never reflected back into the page; the username is, escaped — this
  is the one place a server-rendered page echoes unauthenticated input.
- Sessions: signed, HTTP-only, SameSite=Lax cookies with a rotating secret.
- Invites: an owner generates a single-use, expiring invite link. Accepting it creates a
  new credential-bearing user and grants that new user the invite's scoped vault role; it
  never attaches to an already authenticated account.
- **Scoped API tokens** for the clipper and future integrations — per-vault, per-role,
  revocable, listed in settings with last-used timestamps.
- Rate limiting and constant-time comparison on every auth path.
- No password reset by email (there is no mail server) — an owner resets via
  `memberberry user reset-password`.
- Optional TOTP 2FA is post-v1.

### 6.9 Audit log (A23)

Privileged and security-relevant operations append to a structured log at
`<data-dir>/audit.log` (JSON Lines, size-rotated).

Recorded: timestamp, actor, source IP, vault, action, targets, result. Actions include
login success and failure, ACL changes, privileged link and tag rewrites (§6.6), vault
create/remove, share-link create/revoke/access, API token issue/revoke, and password reset.

**No UI in v1** (A23) — a server-side file is enough. It is written in a format that is
greppable by hand and machine-parseable later, so adding a viewer is additive. The log
contains no note content and no secrets, only identifiers.

### 6.10 Creating a note (E17)

Every other write path in this system writes to a note that already exists — the sync path
opens a file, materializes a CRDT from it and debounces updates back. This is the one that
brings a file into being, and it exists because without it a vault with no notes could not
be used at all. The workspace now also opens at the vault home (§8.2), including empty vaults.

**What is created.** A file at a vault-relative path ending in `.md`, containing its own
name as a level-one heading and nothing else. Intermediate folders are created. Not an empty
file: the name is the one thing the person has already supplied, and a note whose first line
is its title is what every other note looks like — it gives the tree, the catalog and the
backlink panel a title to show, all of which read it from the Markdown rather than from a
database (C2).

**Two entry points, one enforcement point.** `POST /api/v1/vaults/{slug}/notes` is what the
workspace calls, including the pinned New note action and empty-vault home.
`POST /v/{slug}/new` remains the no-bundle server-rendered fallback form.
It answers `303` to the new note, so the browser lands on it with a `GET` and a
reload does not re-post. Both call the same `CreateNote`; neither has a permission rule of
its own.

**Authorization** is `editor` or better *for the path being created*, resolved through the
live ACL by §6.3, so a per-folder grant bounds where a member may create exactly as it bounds
where they may edit. The order of the three checks is load-bearing and is the whole of E17:

1. the name's **shape**, purely lexically — it reveals nothing, because the caller sent it;
2. **authorization**, against the ACL;
3. the **filesystem**, last.

"That already exists" is an answer about a path. Asked before authorization, it would let
anyone who can reach the route map a private vault by trying to create over it. So a caller
who may not write there gets one refusal whether or not a note occupies the path, and the two
are indistinguishable (§6.5). Because `owner` and `editor` both imply read, a caller who can
reach the `Exists` refusal could already have read that note.

**The name is reserved atomically** (`create_new`), not checked and then written. The
check-then-write version is a race two clients creating the same name can both win, and the
loser silently truncates the winner's note.

**Not audited.** Creating a note is an ordinary editor action, no more privileged than typing
into one; §6.9's log is for administration and for the one operation that reads outside the
actor's readable set (§6.6), which this is not.

**Registration writes the first policy.** Related, and the other half of the same first-run
failure: `memberberry vault create` writes an `access.toml` granting the authenticated
administrator who registers the vault `owner`, when and only when the vault root has none. An
existing policy is never touched. This is durable authorization rather than an admin bypass —
after registration that file is the only source of content access (§6.2), and §6.4's rule
that `is_admin` grants no read access is unchanged.

### 6.11 Stopping the server

`SIGINT` (`Ctrl+C`) or `SIGTERM` stops the server, and stopping it is part of the durability
contract rather than an afterthought: the run stops accepting connections, cancels the
maintenance timer, releases the file watcher, and then **flushes every open note's CRDT to
Markdown**. That last step is what makes §3.1's promise true across a restart — stopping the
server leaves Layer 1 current for git, backups and external editors, with nothing stranded in a
sidecar.

**A server that cannot be stopped is a bug of the same severity as one that loses an edit**,
because the recovery for it is `kill -9`, which is exactly the path that skips the flush. One
has already shipped: `main` held `stdout.lock()` — the process-wide stdout mutex, reentrant
only for the thread holding it — for the whole command, while the server prints its shutdown
message from a tokio worker thread. The signal arrived, the shutdown future resolved, and the
process deadlocked on the `println!`. The rule this leaves behind is narrow and worth stating:
**nothing may hold the stdout lock across the running of a command**, because a command may
print from a thread that is not the one that took it. `crates/mb-cli/tests/cli.rs` holds it
with a real process and a real signal, which is the only way to see it.

---

## 7. Sync and offline

### 7.1 Protocol

Yjs update-based sync over one authenticated WebSocket per client.

```
client connects, authenticates (session cookie or API token)
client -> server : subscribe(doc ids)          [E2: authorized]
client -> server : sync-step-1 (state vectors)
server -> client : sync-step-2 (missing updates)
client -> server : sync-step-1 reply
then: bidirectional update frames [E3: authorized per frame] + awareness [E4]
```

A viewer's client puts the editor in read-only mode locally *and* the server rejects its
frames. Both, because client-side enforcement is a UX affordance and never a security
boundary.

**Frame encoding (M5).** A contract between `crates/mb-server/src/sync.rs` and
`web/src/editor/sync.ts`; change it in both or the editor goes quiet.

CRDT payloads are **binary**:

```
byte 0      tag: 0x01 sync (full state), 0x02 update (incremental)
bytes 1..3  u16 big-endian: vault slug length in bytes
bytes 3..5  u16 big-endian: note path length in bytes
then        vault slug, note path, lib0 v1 payload
```

Everything else is **JSON text**: `subscribe`, `unsubscribe`, `awareness` (which carries the
opaque `y-protocols` update plus the awareness client ids it speaks for), `departed`, and
`error`. Control frames are rare and much easier to debug as text; payload frames are on the
keystroke path, where encoding bytes as a JSON number array costs 200-350× more (§21.6).

Every peer is addressed by the note name **it** subscribed with, not the server's canonical
one, so a client that reached a document through an alias still matches its own frames.

**Denials are uniform.** Unknown vault, unresolvable path, missing ACL, denied role, revoked
token — every one returns `{"type":"error","code":"not_found"}`. Returning *nothing* is also
a distinguishable answer, so no denial is silent (§6.5).

**Limits.** 512 KiB per frame; 240 frames/second per connection. A room is released — its
coordinator flushed and dropped — when its last subscriber leaves.

### 7.2 Replication scope — calibrated for 10k+ notes (A8) and permissions (A14)

Full-vault body replication is wrong at this scale (10k notes ≈ 30MB of text, worse on a
phone). Tiered, and always intersected with the user's readable set:

| Tier | Content | When |
|---|---|---|
| **Always** | Metadata for readable notes: id, title, path, tags, aliases, icon, links, mtime, open task rows | Eager. ~10k × 200B ≈ 2MB, plus task metadata. |
| **Always** | Permitted client index zone segments + snippets (§14.2) | Eager. ~8MB at 10k notes. |
| **On demand** | Note body (Y doc) | On first open; stays resident and syncs thereafter. |
| **Pinned** | Note body | Forced eager for notes/folders marked "available offline". |
| **Opt-in** | Everything readable | `offline.replicate_all = true` for small vaults. |

Consequence, stated honestly in the UI rather than hidden: offline you can **search
everything you may read and see snippets**, navigate the graph, and **open anything you
have opened before or pinned**. Opening a never-before-seen note offline shows its
metadata and snippet with a clear "body not downloaded" state.

A resident-body LRU cap (default 500 notes / 50MB, configurable) bounds phone memory;
eviction never touches pinned notes or notes with unsynced changes.

**The cap (M6).** `web/src/offline/eviction.ts`, swept when a note opens — the moment a new
body has just been added. Least recently opened first, and the two exemptions are the whole
of the risk: evicting a note with unsent changes deletes the only copy of somebody's writing,
and evicting a pinned one breaks the promise the pin made. Both still *count* towards the
caps, so a device whose exempt notes alone exceed them evicts everything else and stays over.
That is the honest outcome; the alternative is deleting something the user asked to keep.

- **"Has unsent changes" is written the moment there are any**, from the transport's own
  count, not when the pane closes. A tab is usually closed by being closed, so a flag written
  only on teardown would be missing from exactly the session that produced it.
- **The size is measured on teardown**, because it costs a serialization of the document.
  A note that was never measured reads as zero bytes, which the note half of the cap catches.
- **A record written before those fields existed reads as dirty.** It might hold unsent
  changes and nothing can tell; refusing to evict it costs one note's worth of quota.
- **The caps are not configurable yet**, though §7.2 says they should be: there is nowhere
  for a client-side preference to live — the workspace layout is per device and the vault
  config is server-side.

**Pinning (M6).** A note is kept offline by a command in the palette, `note.pinOffline`,
which toggles — one command whose wording is the state, because two would mean reading the
list to know which one to look for. The pin is a row in the store, not a flag on the body
record: a pinned note may never have been opened, which is the whole point of the eager tier.

- **Pinned notes are fetched on every start**, one at a time, by opening the document and its
  transport with no editor attached and closing them again once the server has sent the state
  — `y-indexeddb` keeps whatever arrived. No awareness and no presence: a background fetch
  must not put this user's cursor into a room they are not looking at (§7.5).
- **The sweep gives up after two consecutive failures.** Without that, a pinned set of two
  hundred notes on a device with no network is two hundred sockets each waiting out its own
  timeout. Two in a row distinguishes "this note is gone" from "there is no server".
- **A pin for a note that left the readable set is dropped** with the body, in the same
  reconciliation. A standing instruction to fetch something this user may no longer read is
  worse than a stale copy of it: it keeps asking.
- **Folders cannot be pinned yet.** §7.2 says "notes/folders"; what exists is notes. A folder
  pin is a prefix that has to be re-expanded whenever the vault changes, which is a different
  thing from a list of paths.

**How it is stored (M6).** `web/src/offline/db.ts` is one IndexedDB database holding two
things: the metadata for each vault, and a record of which note bodies this device has. The
bodies themselves are not in it — each is a Y document in its own `y-indexeddb` database,
which is what the editor binds to — so this store is the bookkeeping *beside* them. The
decisions:

- **A note is "downloaded" when the server has sent its state**, not when the browser thinks
  it is online. `ConnectionState.synced` latches on the first sync frame (§7.4), and that is
  what records residency. `navigator.onLine` answers a different question and answers it
  badly: a server refusing connections, an expired session and a tab woken before its socket
  reconnected all read as online.
- **A note whose body is not here is covered, not opened empty.** The editor is mounted
  underneath — so nothing is rebuilt when the body lands — and hidden, because a hidden
  `contenteditable` cannot be focused. An empty document that *could* be typed into would
  merge those words with the body that arrives on reconnect, and the note would look
  destroyed. The notice is delayed half a second, because every first open is a note this
  device does not hold yet and each would otherwise flash it for a round trip.
- **It shows the title**, which is the entire argument for the eager metadata tier. A state
  that could only say "not available" would need none of it.
- **The cover is `visibility`, not `display`.** Taking the surface out of layout makes every
  rectangle in it zero, and §9.5's outline decides which section is current by measuring
  headings against the scroller — so `display: none` here quietly made a note's first section
  current before its body had arrived. Found by the E2E outline test, which is the only thing
  that measures layout (§22.6).

### 7.3 CRDT storage growth

- **Server:** compacts a doc's sidecar past ~500 updates or nightly — load, merge to a
  single state, rewrite. Version history is *not* carried by the CRDT log; it lives in
  Markdown snapshots (§18), so compaction is lossless with respect to history.
- **Sidecar format:** version 1 starts with the eight-byte header `MBCRDT\0\x01`, followed
  by append-only records containing a little-endian `u32` payload length, a little-endian
  CRC32, and one lib0 v1 update. Updates are capped at 64 MiB before allocation. A malformed,
  truncated, or checksum-invalid sidecar fails closed rather than materializing partial
  state; a missing sidecar is rebuilt from its Markdown note (I1).
- **Durability:** the server serializes appends per note and syncs each append. Compaction
  writes and syncs a complete state to a sibling temporary file, atomically renames it over
  the sidecar, then syncs the parent directory. Cross-process writers are unsupported; the
  note's sync coordinator is the single server-side writer.
- **Client:** Yjs GC enabled, aggressive compaction, no local history (A7).

### 7.4 PWA

Service worker precaches the app shell and WASM bundle. IndexedDB holds Y docs, the
pending-update queue, and the client search index. Media for pinned notes is cached via
the Cache API. Offline uploads and clips queue and flush on reconnect. The app must be
fully functional after a cold start with no network.

On reconnect the client reconciles permissions first: the server sends the current zone
list, and the client **drops any segment or body it is no longer permitted** before doing
anything else (§6.7).

**Reconciling the note replica (M6).** The zone list belongs to M9's client index; what
exists now is the same rule over §7.2's metadata tier, in `web/src/offline/replica.ts`. It
turns on a three-way answer from the note index — the list, a refusal, or no answer at all —
because collapsing the last two is a choice between two bugs: fall back to the stored copy on
a refusal and a revoked user goes on reading titles they lost; discard it on a network blip
and a tunnel wipes the offline replica of a 10 000-note vault. So:

| The server said | The client uses | The client keeps |
|---|---|---|
| a list | that list | the bodies it names; **every other body is deleted** |
| a refusal (404/401/403) | nothing | nothing — metadata and every body, dropped |
| nothing (offline, 5xx, unparseable) | the stored copy | everything |

A note leaves the readable set because an ACL tightened, because it was deleted, or because
it was renamed, and this cannot tell them apart. Dropping the local body is right for all
three: under §6.5 a note the server will not list does not exist for this reader.

**The shell (M6).** `web/src/offline/` holds the worker; `web/scripts/build-sw.ts` builds it
as a second, library-mode Vite build after the application build, because a worker has to
land at a fixed root-scoped URL — `/sw.js`, never `/assets/sw-a1b2c3.js` — and has to be one
self-contained file. `mb-server` serves it, the manifest and the icon from the build root.
The decisions worth arguing:

- **The precache list is injected into the worker's source, not fetched by it.** A browser
  installs a new worker only when the script's bytes differ, so a worker that read its list
  from a file would never notice a new build and would serve the previous one from cache
  indefinitely. Injecting the list makes the worker change whenever the build does, which is
  what retires the old cache. The cache is named for a fingerprint of the list, and
  `activate` deletes every other cache with this application's prefix — by prefix, because
  cache storage is shared with whatever else the origin does.
- **Everything under `assets/` is precached, including the lazy chunks.** §21.2's bundle
  budget deliberately excludes a chunk behind a command, because a first paint does not
  download it. Offline is the opposite question: a graph that cannot open on a train is a
  feature that does not work offline. The whole build is ~1.6 MB, and it is fetched *after*
  the load event so it never competes with the critical path.
- **An offline navigation is answered with an unbootstrapped shell, `/app.html`.** Not with
  the cached note page it asked for. Caching the server's answer would put one user's vault,
  note path and display name into a cache the next user of that browser profile shares, and
  would only work for notes already visited. One shell carries no vault data at all, works
  for every note URL, and is servable without a session — which matters, because the worker
  fetches it during install and an expired session would otherwise leave a browser with no
  offline shell and no way to notice.
- **The client then works out which note it is.** The vault and note come from the URL; the
  display name comes from `localStorage`, written on every load the server did bootstrap.
  That name is a label and never an authorization: it names a caret, and every request the
  page makes is still authenticated by the session cookie and filtered server-side (§6.4). A
  browser that has never completed a load here has no remembered name, and gets a local-only
  replica rather than a workspace claiming to be someone.
- **Nothing under `/api/` is ever cached, and no navigation is either.** Those answers are
  permission-filtered for the user who asked, so a cached copy is a filter replayed after it
  changed — the offline half of the revocation limit §6.7 already admits to. What a client
  keeps offline is replicated deliberately through IndexedDB (§7.2), where reconnect can drop
  what it may no longer read. An HTTP cache has no such hook, so it gets nothing.
- **Only a network *error* falls back.** A 404 or a 500 is the server saying something, and
  in this application a 404 is frequently a permission denial (§6.5) — papering over one with
  a cached page would be the invisibility rule failing in the client's favour.
- **A new build is served immediately, even while the previous worker is still in charge.**
  The routing rule is membership of *this* build's precache list, not a `/assets/` prefix, so
  a hashed filename the old worker has never seen goes straight to the network — and the
  navigation that named it was network-first anyway. The worker does not `skipWaiting`: an
  updated worker that claimed a running page would retire the chunks that page is still
  lazily importing. The only thing that lags a build is the *offline* copy, until every tab
  of the old one is gone.
- **A route that needs a server says so.** `/` and `/login` are server-rendered and have no
  offline form, so they get a page that says the connection is required rather than the
  shell, which would render an editor over a URL that has never been one. The offline `/`
  page also lists links to resident note bodies from the local replica, so a user can reach
  notes without already knowing their URLs. `/login` remains generic and never lists cached
  note names.

**Reconnecting, and the flush (M6).** `web/src/editor/sync.ts`. Through M5 the transport
connected once: a socket that closed stayed closed until the page was reloaded, and an update
produced while it was closed was applied locally, persisted to IndexedDB and **never sent**.
The note stayed correct on that device and wrong everywhere else, silently. Four things fix
it:

- **The client sends what the server is missing, on every connection.** §7.1's handshake is
  written as two directions and only one was implemented — the server answered `subscribe`
  with its whole state and nothing ever carried this client's back. It now computes the state
  vector *of the server's own frame* and sends exactly the difference, which is also what
  makes a first connection correct: the local replica is restored from IndexedDB before the
  socket opens, so a note edited offline and then reloaded has changes the server has never
  seen. An empty difference is not sent at all.
- **Unsent changes are counted, not queued.** The document is the queue — every update is
  already in the Y doc and, a moment later, in IndexedDB — so keeping the bytes as well would
  be a second copy that can disagree with the first. What reconnecting sends is the
  difference, which is exact however many updates went unsent. The count is what the note
  header reports: "Offline — 3 unsent changes, saved on this device". Not *unsaved*: it is
  saved, on this device, and the thing that is true is that it is nowhere else.
- **Reconnection is exponential with equal jitter**, 1 s doubling to a 30 s cap, retried
  forever. A closed socket is the normal state of an offline-first application rather than an
  error; the cap is what makes "forever" affordable, and the jitter is what stops a hundred
  tabs that lost the same Wi-Fi returning in the same millisecond. No attempt is immediate,
  because the likeliest reason a server closed a connection is §7.1's frame-rate limit.
- **The browser's own network events short-circuit both ends of that.** `online` reconnects
  at once rather than waiting out a window a sleeping laptop woke up in the middle of.
  `offline` **closes the socket deliberately**, which is the subtler half: a socket does not
  notice a network that has gone away, so every `send` succeeds into nowhere while the UI
  reports itself connected — the one state where this transport loses edits *and* says it is
  fine. `navigator.onLine` is imprecise (a captive portal reads as online), and the cost of
  believing it wrongly is bounded: a working socket is closed and immediately reopened.

**Remaining limits:** the pending count is per open note rather than per workspace.
The undownloaded-body state, note pinning and resident-body eviction are implemented in
§7.2; folder pins and configurable caps remain deferred there. Conflict handling is complete
as specified in §3.5.

### 7.5 Real-time collaboration (A20 — surfaced properly)

Two people editing one note works the moment A14 lands, whether or not the UI admits it.
A20 says to surface it properly, so it is designed rather than left as an accident.

- **Remote cursors and selections** via `y-prosemirror`'s cursor plugin, rendered as
  ProseMirror decorations — never a document re-render.
- **Stable per-user colour**, derived deterministically from the user id so the same person
  is the same colour on every device and every session. Colours are drawn from a palette
  checked for contrast against both shipped themes (§20.3).
- **Name labels** on the remote caret, fading after ~3s of stillness and reappearing on
  movement. Full labels on hover.
- **Presence avatars** in the note header showing who is currently in the document, and a
  subtle indicator in the note tree and tab for "someone else is here".
- **Idle handling:** a cursor with no activity for 60s fades; a disconnected client's
  presence is removed immediately on socket close, and within 30s on a silent drop.
  Immediate removal needs the server's help: an awareness frame carries the client ids it
  speaks for, and on close the server sends a `departed` frame naming them. Without it a
  closed tab leaves a ghost cursor until `y-protocols` times it out.
- **Mobile:** presence avatars yes, inline caret labels suppressed below 768px — labels
  over a phone-width editor obscure the text they annotate. Remote selections still render.

**Constraints:**
- Awareness is broadcast **only to users who can read the document** (E4). Presence reveals
  which note a person is in, which is expected in a collaboration tool but is still a read
  of vault structure — it follows the same permission filter as everything else.
- Awareness is **throttled to ~50ms** and never written to disk. It is ephemeral state, not
  part of the CRDT document.
- Presence has no offline representation: offline you are alone, and the UI says so rather
  than showing stale avatars.

---

## 8. Workspace and navigation shell (A10 — adaptive)

One state model, two layouts.

### 8.1 State model

```
Workspace(vault)
  └── SplitNode (horizontal | vertical, ratio)  ── recursive
        └── TabGroup
              └── Tab { note_id, mode: edit|read, scroll, selection, history[] }
```

Persisted per `(user, device, vault)` at `.memberberry/workspace/<user>/<device-id>.json`.
**Not synced** — devices legitimately differ, and syncing layout between a phone and a
32" monitor is user-hostile.

**Corrected in M7: the path now includes the user.** It read `<device-id>.json` through M5,
which is a leak. A workspace file is a list of note paths someone has open, so it is the same
kind of data as presence — §6.4 E4 already permission-filters awareness because it reveals
which note a person is reading, and a layout file reveals exactly that, durably, to any other
member of the vault. Worse, it may name a note the *reader* of the file cannot access, which
§6.5 says must not exist for them at all. A per-user directory, readable and writable only by
its owner, is the smallest fix; the alternative of keeping layouts outside the vault was
rejected because they are derived state and belong under `.memberberry/` with everything else
Invariant I1 says is disposable.

Two consequences, both implemented in `web/src/shell/workspace-storage.ts`:

- **A layout is pruned against the current ACL on load.** Access may have been revoked
  between sessions, and restoring the tab anyway would put an unreadable path in the tab bar
  — a title leak from a file the user's own client wrote. A pane that loses every tab
  collapses, exactly as closing its last tab would.
- **A layout stored for another vault is rejected without naming it**, for the same reason a
  denial elsewhere is neutral.

**`scroll` was recorded and restored from the wrong element until M8**, and two things had to
change together. The handler sat on the element Tiptap mounts into, which has no `overflow`
and therefore never scrolls; it now sits on the pane, which does. And because the store is
immutable, recording a scroll hands the pane a *new* `Tab` object — so the effect that owns
the editor must depend on the tab's **id and note as values**, not on the prop, or it tears
the editor down on every scroll event, the rebuild restores the offset, the restore scrolls,
and the loop mounts editors until the scrolling stops. Both are pinned: a unit test that
scrolls and counts editors, and a browser test that switches tabs and comes back.

**Implemented, M7.** `web/src/shell/workspace.ts` is the model: pure operations returning new
workspaces, with the invariants stated once in `workspaceProblems` and a property test that
applies random operation sequences and asserts they hold. That test is what established the
collapse rules — an empty pane stranded inside a split is reachable by sequences nobody would
write by hand. Two rules worth stating because they are not obvious:

- **An empty group cannot be split.** A split of nothing is two dead panes. A split always
  opens a note: the one asked for, or a second view of what the pane was already showing.
- **Closing the active tab activates the one to its right**, falling back to the left. Not
  "the first tab" — closing a run of tabs left to right should walk forward through them.

**The endpoint, M7.** `GET`/`PUT /api/v1/vaults/{slug}/workspace/{device}`, backed by
`mb-server/src/workspace.rs`. This is enforcement point **E15**.

- The user segment comes from the session. There is no route parameter naming whose layout
  it is, so there is nothing for a caller to substitute.
- **Vault membership is the check, not note-level access** — a layout is not a note. A
  non-member gets the same reply as an unknown vault and as "nothing saved", because
  distinguishing them lets a prober map the vaults on a server (§6.5).
- The layout is **opaque to the server**, which checks only that it is JSON and under 256 KB.
  The shape belongs to `workspace-storage.ts`; mirroring that recursive model in Rust would
  be a second definition of well-formed, free to drift from the first. The bytes come back
  unchanged, so a load never looks like an edit to the client.
- `no-store`, because a layout names notes and no intermediary should keep a copy.

**Not yet wired: pruning on load.** `pruneUnreadable` exists and is tested, but it needs the
set of notes the user may currently read, and there is no API that returns one until the
index lands in M8. Until then a tab on a revoked note simply fails to open, which is correct
but less tidy than closing it. This is the *only* case where a layout can name an unreadable
path, and it is not a disclosure: the note is one the user themselves had open, so its
existence is not news to them (§6.5 is about notes a user was never allowed to see).

### 8.2 Desktop layout (≥ 1024px)

**Vault home (2026-09-11).** `/v/{slug}` and its trailing-slash form load the authenticated
workspace, including when the vault has no notes. An explicit `data-home="true"` bootstrap
marks the home route; it names the authorized vault and user, with no note path or body.
The center opens a compact Home with a create action and up to eight notes from the
permission-filtered catalog; it does not repeat the vault name or introductory guidance text.
Each note shows its title without a separate filename line, prefixed with a muted folder
path and ` / ` when nested. Untitled notes fall back to their filename without `.md`,
with the folder prefix shown only once. Root notes have no prefix.
Saved tabs are retained but no editor mounts until the user opens a note. On desktop
the left panel opens on arrival even if it was previously collapsed; the context panel starts
closed on Home, and no note is highlighted in the left tree. Mobile keeps its initially closed
navigation drawer.

The top bar's Memberberry book mark and wordmark link to the current vault's Home; on mobile
only the mark is drawn, with the same accessible name. The separate vault chooser remains
beside it. The redundant Home and Search notes sidebar rows are removed; search remains in
the view selector and the top bar. New note and New folder are always-visible icon buttons
beside the Notes heading, with tooltips and accessible names. That heading sticks while the
file list scrolls. Controls are 32px on desktop and at least 44px on touch devices, and are
shown only in the Notes view. New note opens the existing creation dialog
at the vault root; typing `Folder/Note` creates inside that folder. The palette's existing
New note command still creates beside the active note. New folder creates an ordinary empty
directory, including nested paths, and refreshes the tree. Empty folders are listed through
E28 and are not cached for offline use. A path-only grant still requires an existing readable
note to discover a vault (§6.1); empty directories alone do not broaden discovery.
The fallback HTML library and creation form remain available when no frontend bundle is
installed. The account's vault chooser at `/` remains separate.

The server-rendered pages were restyled with the shell (2026-09-11) without changing that
structure: they carry the same `--topbar-height` header the application does, with a drawn
product mark in place of an uppercase wordmark; sign-in and onboarding centre their single
card; and the vault list at `/` uses the library's row shape — a mark, the vault's name, the
address it lives at, and an arrow — so "somewhere to go" looks the same in both listings.
A vault row's accessible name therefore contains its address as well as its name, which is
what tells two vaults with the same display name apart.

A thin top bar, left sidebar (note tree, search, tags, tasks, bookmarks),
main area with recursive splits and tab groups, right sidebar (backlinks, outline, local
graph). Sidebars collapsible; splits drag-resizable; tabs draggable between groups.
Cmd/Ctrl-click a link opens it in a new tab; Cmd/Ctrl-Alt-click opens in a split.

**Implemented, M7.** `Workspace.svelte` over `PaneTree.svelte`, which is recursive because the
model is. The frame is a labelled, collapsible, keyboard-reachable region whose collapse state
is remembered. Its *contents* arrive with the milestone that owns them: the note tree and
bookmarks in M7, **backlinks, the tag pane, the outline and the local graph in M8** (§9.5,
§9.3, §9.4), search in M9, the task inbox in M14. A region with nothing in it yet says which
milestone fills it, rather than "coming soon" — a reader should be able to tell unfinished
from broken. The *global* graph is not in a sidebar at all: it opens over the workspace
(§9.4).

Four decisions worth recording:

- **Only the active tab of a pane holds an editor.** An inactive tab is a row in the strip and
  a scroll offset in the model. Four open panes cost four editors, not four times the number
  of tabs — §21.2 budgets 250 MB for a whole 10k-note vault on a phone.
- **Every pointer gesture has a keyboard equivalent, and they are separate features.** Native
  drag-and-drop is not keyboard-operable at all, so "tabs are draggable" and "tabs move with
  Cmd-Shift-arrow" are two implementations and two tests. The split divider is a focusable
  `separator` carrying `aria-valuenow`, resized with the arrow keys, Home and End.
- **`Cmd/Ctrl-B` is deliberately not a shortcut here.** It is bold, in an application whose
  main content is a rich text editor. The sidebars are toggled by focusable buttons, which is
  what §8.4 actually requires — a *shortcut* is a convenience. The shell claims only
  `Cmd/Ctrl-\` (split) and `Cmd/Ctrl-W` (close tab), neither of which the editor wants.
- **Below the §8.3 breakpoint the sidebars become overlays and start closed**, and only the
  panel overlays — never the top bar, which holds the toggle that closes it again. The
  original version floated the whole frame, which put a 44px strip on top of the tab strip
  where it silently ate taps meant for the first tab.

**The top bar and the document surface (2026-09-11).** The shell had no bar. What a bar
holds was instead scattered through the panels it sits above: each sidebar began with a
full-width text button reading "Hide Navigation" or "Hide Context", the vault link was a
two-line caption inside the navigation panel, and the appearance control was a bordered form
card inside the context panel — so three unrelated concerns each invented their own chrome,
the window had no anchor, and closing a panel left a dead 44px strip where its toggle had
been. `TopBar.svelte` is one `--topbar-height` strip spanning the window, holding the four
things that are about the *session* rather than about a note: the two panel toggles, the
vault switcher, quick find, and appearance.

- **It is a grid row, not an overlay.** `.workspace-shell` is a named-area grid — `topbar`
  across the top, then `left main right` — because a bar added to a `100dvh` layout without a
  row for it makes the page itself scroll, and one that floats over the content re-creates
  the tap-eating bug the bullet above records. `e2e/topbar.spec.ts` measures both.
- **Nothing that acts on a note lives in it.** Editor controls stay with the document
  (§8.4's control strip), which is what keeps the bar the same height and shape in every
  state the application can be in.
- **The toggles are still outside the region they collapse**, which is the accessibility
  requirement they always had: a control *inside* a collapsible panel disappears with it and
  traps a keyboard user. Their accessible names are unchanged — `Show Navigation`,
  `Hide Context` — because a name is what a person reads out to describe what they pressed.
- **Quick find is the §8.4 command, not a second implementation.** The button dispatches
  `memberberry:palette` (`palette.ts`) and `CommandCenter` opens the quick switcher on it, so
  the keystroke and the control are one command. The bar writes the keystroke the way this
  platform writes it.
- **Two surfaces, and that is the whole depth model.** Chrome is `--surface-canvas` and the
  document is `--surface-note`. The note was a card — a bordered, rounded, shadowed panel
  inside a pane that is already a frame — so a split drew four nested rectangles before a
  word of the note. The reading column is now full-bleed on the document surface, measured
  by `--editor-measure`, with the active tab meeting it edge to edge.
- **The chrome's marks are drawn, not typed.** `icons.ts` holds the paths and `Icon.svelte`
  strokes them with `currentColor`; the tree's twisties were `▾`/`▸`, a note with no
  frontmatter icon was a `·`, and a tab's close control was a `×`. A character standing in
  for a control renders at whatever size and weight the platform font gives it, and cannot
  be rotated when a folder opens.

**Navigation views (2026-09-11).** The navigation sidebar presents Notes, Search, Tags,
Tasks and Calendar one at a time, selected through a pinned strip of labelled icon buttons.
Notes is the initial view on each workspace load, with bookmarks and the existing sharing
disclosure. The strip remains visible while the body scrolls; every selector has a 44px
minimum hit area, an accessible name, a tooltip and a pressed state. Native buttons support
Tab and Enter/Space on desktop and the same controls sit inside the mobile drawer.
Inactive views remain mounted but hidden, preserving search text, filters, calendar month
and tree expansion when switching. Selection is session-local and is not persisted.
Existing permission-filtered loaders and their lifecycles are unchanged; hiding a view is
presentation, never authorization. `e2e/navigation.spec.ts` checks actual visibility,
keyboard activation, target sizes and retained search state in both viewports.

**The note tree, bookmarks and note actions, M7.**

- **The tree is built from the note index the quick switcher already fetches**
  (`note-catalog.svelte.ts`), so there is one answer to "which notes exist". It arrives
  permission-filtered. Nonempty folders are inferred from readable notes; authorized empty
  folders come from E28. Neither list can reveal a folder holding only denied notes.
- **One tab stop for the whole tree**, with `aria-activedescendant` naming the current row. A
  list where Tab walks through four hundred notes is not navigable by anyone. Arrow keys do
  what the `tree` role promises: Right opens a closed folder or steps into an open one, Left
  closes or steps out to the parent.
- **Notes and tabs have a custom context menu** with a Rename action. It opens the shared rename
  prompt, which validates the destination and rewrites inbound links through §6.6.
- **Notes can be dragged into an inferred or empty folder, or back to the vault root.** The
  gesture calls the same audited note-rename endpoint as the context menu; the server checks
  write access to both paths, and the client never moves a note without that response.
- **Bookmarks live in the server's data directory**, at
  `<data-dir>/bookmarks/<user>/<vault>.json` — see `bookmarks.rs` for why not `.memberberry/`
  (Invariant I1 says that holds nothing irreplaceable) and why not the vault (§4.1 says a vault
  holds human-meaningful artifacts, and one person's shortlist is not one). They are **filtered
  on read**, so a note whose access was revoked leaves the sidebar instead of sitting there as
  a name the user may no longer see. A bookmark outlives the permission that created it, which
  a short-lived pane layout does not.
  Each bookmark row's single leading star is a labelled, keyboard-accessible remove button
  with a touch-sized target; there is no trailing star. It removes only that bookmark,
  without opening or deleting the note, and persists
  through the same bookmark save path as the file-tree toggle.

**Following a link, M8.** A wikilink click navigates the tab, Cmd/Ctrl-click opens a tab in
the same pane, and Cmd/Ctrl-Alt-click splits it — the same direction `Mod+\` takes. Three
things are worth recording:

- **The editor asks and the shell decides.** A click becomes one DOM event
  (`memberberry:open-note`) which the shell listens for, because the editor is mounted with
  no access to the workspace store, the §8.3 split rules are facts about the viewport, and an
  embed's jump-to-source is nested inside a node view that no prop chain reaches.
- **The event carries a reference, not a path** — except from an embed, which carries the
  identity the server already resolved and says so. Re-resolving a path from a different note
  can land on a different note, because §4.3 resolves relative to where the reference is read.
- **A split the layout has no room for opens a tab instead** (§8.3 caps panes on a phone). A
  modified click that silently did nothing would read as broken rather than adapted.

Still to come: a URL that follows the active tab, so a reload lands on the same note without
relying on the restored layout.

### 8.3 Mobile layout (< 768px)

Single active document. The same tree exists in state but only the active leaf renders.
- Sidebars become swipe-in drawers.
- Back/forward gestures traverse the tab's navigation history.
- Tab switcher as a bottom sheet.
- Editor toolbar docks above the virtual keyboard using `VisualViewport`, so it never
  hides behind it — the most commonly botched thing in mobile editors, and it gets an
  explicit test.
- Block drag handles are long-press activated with 44px touch targets.

Tablet (768–1024px) gets desktop layout with at most one split.

**Implemented, M7.** `MobileMain.svelte` and `TabSheet.svelte`, chosen by `layout.ts` — the
one place the breakpoints are written down, so the components and the media queries in
`app.css` cannot disagree about them. That module also owns the split limits: a tablet gets
one, and **mobile gets none**, because a second pane there would be invisible and an
invisible pane still holds an editor, a Y.Doc and a socket. The limit applies to *adding*
panes only; a layout built on a laptop keeps its panes when opened on a phone.

- **The tab switcher is a real `<dialog>`**, opened with `showModal()`. Focus trapping,
  Escape, an inert page behind it and the announced role are the browser's rather than ours,
  and each is routinely reimplemented wrongly. It lists every tab in every pane, because on
  mobile it is the *only* route to a tab in a pane this layout is not drawing.
- **The edge-swipe recogniser (`gestures.ts`) is mostly rejections.** The surface being
  swiped is a text editor, so a gesture must start within 24px of the screen edge, be
  clearly more horizontal than vertical, travel 48px, and be a single touch that is not a
  mouse. A recogniser that is even slightly too eager steals scrolls and selection drags, and
  that failure is intermittent and near-impossible to report usefully.
- **The editor's own mobile rules now share this breakpoint.** They switched at 640px, so
  between 640 and 768 the editor's toolbar floated as if on a phone while the desktop shell
  was showing. The toolbar also clears the workspace's bottom bar via `--bottom-chrome`:
  both want the bottom of the screen, and the toolbar was winning and swallowing every tap
  meant for the tab switcher.
- **The drawers hang from the bottom of the top bar (2026-09-11)**, so the bar is never
  covered — the control that closes a drawer is in it. This replaced a 44px toggle strip at
  each screen edge, which cost the document 88px of width on a 412px phone and was the only
  visible affordance for a gesture (§8.4: the swipe is the convenience, the button is the
  requirement).
- **The appearance control becomes its own icon at this width.** Its widest option reads
  "Vault default (System)", and a `<select>` narrow enough to sit beside four other controls
  renders that as "Vault defa…", which reads as broken rather than as compact. The native
  control keeps its box and its accessible name and is what a tap opens — the operating
  system draws the list at full width — and only its own rendering is transparent. Its focus
  ring moves to the box the eye can see.

**Deviation, deliberate: back and forward are buttons, not gestures.** §8.3 asks for
back/forward *gestures*, and they are not implemented as such. Both screen edges are taken by
the drawers — which is what "sidebars become swipe-in drawers" requires — and a horizontal
swipe over the body of the pane is a swipe over a text editor, where it competes with
selection. So the tab's navigation history is walked by two buttons in the bottom bar, which
§8.4 is satisfied by. If the gesture is wanted, the honest options are to move the drawers to
a different affordance or to accept the conflict with selection; neither should be decided by
whoever implements it next without saying so.

The `VisualViewport` toolbar docking has the explicit test this section asks for, in
`editor-shell.dom.test.ts`. It shipped in M3 with nothing checking it; the tests cover the
arithmetic term by term, because the botched version is not "no code" but code that computes
the offset once, or from the wrong viewport, and leaves the toolbar under the keyboard on
exactly the devices nobody tried.

### 8.4 Keyboard and commands

- Command palette (Cmd/Ctrl-P) over every registered command.
- Quick switcher (Cmd/Ctrl-O) — fuzzy over titles, aliases, headings, recent notes.
- Vault switcher (Cmd/Ctrl-Shift-V).
- Fully remappable hotkeys, with the defaults documented in §8.4.
- Every action reachable by keyboard. No mouse-only feature ships.

**Implemented, M7.** One `Palette.svelte` serves all three switchers — they differ only in
what fills the list and what Enter does, and three near-identical overlays is three places for
the keyboard handling to be subtly wrong. `CommandCenter.svelte` owns them, because exactly one
may be open at a time.

- **The palette is a combobox driving a listbox with `aria-activedescendant`**, not roving
  focus. Focus has to stay in the input — the user is still typing — so the *virtual* cursor
  moves through the options instead.
- **The command registry (`commands.ts`) is the single list.** A command that exists only as a
  keyboard handler cannot appear in the palette, and one that exists only in the palette
  cannot be bound; both are how an application ends up with actions nobody can find. A
  disabled command still *consumes* its keystroke — passing it through fires the browser's
  binding instead, and for `Mod+W` that closes the browser tab.
- **Bindings are stored with `Mod`** and resolved per platform, because writing `Ctrl+O` on a
  Mac is wrong in a way users notice immediately. `parseBinding` and `serialiseBinding` are
  exact inverses (property-tested): a binding that does not survive a round trip is a hotkey
  that stops working after a restart.
- **A bare key never reaches the shell while a text surface has focus.** Otherwise typing `p`
  in a note opens the command palette. `Mod` chords still do, which is the point of them.
- **`navigator.userAgent` is not the platform signal.** The question is which physical key
  is on the keyboard, and a UA string is the least reliable answer — `userAgentData.platform`
  first, then `navigator.platform`, then the UA. This was not theoretical: Playwright's
  `Desktop Chrome` descriptor sets a Windows UA, so a suite on a Mac had the shell expecting
  Ctrl while the host sent Cmd, and every shortcut silently did nothing.

**Fuzzy matching (`fuzzy.ts`)** is greedy forward, then tightened backward. The forward pass
alone takes the left-most alignment — typing `road` against "Product roadmap" matches the `ro`
of "Product" — and the backward pass slides each position right, landing on "road". Better
highlighting, and a better score, since the run is then adjacent and at a word start. The
§21.2 budget is why it is not cleverer than that: 80 ms over 10 000 notes on a mid-range phone
rules out anything that allocates per candidate.

**Defaults**, all remappable: `Mod+P` command palette, `Mod+O` quick switcher,
`Mod+Shift+V` vault switcher, `Mod+\` and `Mod+Shift+\` split, `Mod+W` close note. **`Mod+B`
is deliberately unbound** — see §8.2.

**Default keymap, audited in M18.** `Mod+P` opens the command palette, `Mod+O` opens the
quick switcher and `Mod+W` closes the current tab. These bindings live together in
`default-keymap.ts`, so future changes receive one explicit review rather than changing
scattered literals. A browser owns `Mod+N` for creating a window and does not reliably let a page intercept
it; “New note…” therefore remains palette-only by default and remappable to an available chord.
The vault switcher, splits, daily note and graph defaults are also defined in that keymap.

**The editor's control strip, M7 follow-up.** The strip above a note is a toolbar, a slash
menu and the §10.2 task inspector. Through M7 all three were *permanently* visible — about
380px above every note and twice that in a split — because the latter two were built always-on
for M3's convenience. The slash menu belongs to a `/` being typed and the inspector to a task
being selected; neither is a property of having a note open, and both are now conditional.

- **The slash menu opens on a `/` that starts a word**, and closes on the space that ends the
  command or when nothing matches what has been typed. "Any slash anywhere in the block"
  opened it over a URL or a date written `9/3`. The stricter rule answers *should this be
  visible*; a separate permissive read answers *what did the user type*, because `/due
  tomorrow` contains a space and is still one command.
- **It is positioned rather than in flow.** A menu that took space in the column would shove
  the note — and the line being typed — down the screen on the keystroke that opened it.
- **One switch, not two.** The mobile long-press (§8.3) used to add a class that a stylesheet
  turned into a `display: flex`, which is a second way of deciding whether the menu is open
  and one that could not agree with `hidden`. It calls the same `show()` now.
- **The inspector reads the selected task.** It was previously not only always visible but
  always blank, so selecting a task due on the 30th showed an empty date field and invited
  overwriting it with nothing. It no longer writes into a control that currently has focus,
  because every keystroke is a transaction and re-seeding a date input mid-entry fights
  whoever is typing in it.

Still to come: the quick switcher matches titles and paths, not **aliases or headings**. Those
need the index of §9.1, which is M8. `titles.rs` is a title cache and says so; it is not that
index, and a half-built one would be worse than an honest cache.

---

## 9. Links, transclusion, tags, graph

### 9.1 Index schema

One SQLite database per vault at `<vault>/.memberberry/index/graph.sqlite`, built in **M8**.

```sql
notes(id, path, uuid, title, icon, created, updated, content_hash, word_count, stamp)
note_names(note_id, name, key, kind, path)  -- kind: path|stem|alias — what a wikilink matches
links(id, source_id, source_path, target_raw, target_key, anchor_kind, anchor, kind,
      source_block, context, ordinal)
      -- anchor_kind: none|heading|block ;  kind: link|embed
tags(note_id, tag, tag_prefix, prefix_key)  -- prefix rows enable nested-tag queries
blocks(note_id, block_id, text)     -- only blocks carrying a ^block-id
tasks(note_id, block_id, status, due, scheduled, start, created, done, priority, text, ordinal)
media_refs(note_id, path, original_name) -- E11 plus Markdown display metadata
zones(zone_id, path_prefix, acl_hash)
    -- maximal ACL subtrees for §14.2; empty path_prefix is the vault root
```

Every read of these tables goes through a permission-filtered view (E5). There is no
unfiltered query helper — `mb-index` exposes no connection, queries live only on a `Reader`
that cannot be built without a user and an ACL, and `tests/no_unfiltered_query.rs` fails if a
query in a read path names a base table or if a view stops joining the readable set.

**The index is derived state, and that decides almost everything about it.** Every row can
be rebuilt from the Markdown files, which is Invariant I1 (§22.4). So there are **no
migrations**: the schema version lives in SQLite's `user_version`, and a database stamped
with any other version — or one that will not open, or one whose file was truncated — is
dropped and rebuilt. `memberberry reindex [--slug S]` does the same on demand.

Seven differences from the original sketch above it, each with a reason:

- **`notes.id` is an internal row id; `notes.uuid` carries §4.3's frontmatter identity when
  the note has one.** It is nullable because C2 makes it so: a note written by an external editor, a
  template or `printf > note.md` has no `id:`, and the index answers to the files rather
  than requiring them to be rewritten before they can be indexed. §4.3 is amended to match.
- **`links` does not store a resolved `target_id`.** Resolution happens at query time
  against `note_names`, which is what makes a ghost link resolve itself the moment the note
  it names appears — no relink pass, and no rows to invalidate when a note is added. It is
  also what makes resolution *per user*: candidates come from the filtered view.
- **`aliases(note_id, alias)` is subsumed by `note_names`** (`kind = 'alias'`). One table,
  because resolution and display want the same list and two lists can disagree.
- **`unresolved(source_id, target_raw)` is not a table.** With query-time resolution it is a
  link whose target resolves to NULL, which is a row in the `v_resolved` view rather than
  state to maintain. Ghost nodes read it when the graph lands.
- **`media_refs` records the vault-relative reference as written, not a separate content
  hash.** M11's path already contains that hash. `original_name` comes from the image alt
  text or media-link label, keeping the display name derived from Markdown rather than from
  an object-store sidecar.
- **`zones(zone_id, path_prefix, acl_hash)` arrived in M9.** The empty prefix is the vault
  root; a rule path gets a row only when its complete effective user/role mapping differs
  from its containing zone, so redundant rules do not fragment the client index. `zone_id`
  is SHA-256 over a versioned domain and the normalized prefix, stable across permission
  edits; `acl_hash` is SHA-256 over the sorted effective non-`none` username/role pairs.
- **`tags` carries `prefix_key` beside `tag_prefix`.** The key is the prefix folded to NFC
  and lowercase and is the tag's *identity*; the spelling is kept for display (§9.3). Folded
  at write time by the same rule links are, rather than with SQLite's `lower()`, which is
  ASCII-only and would make `#Café` and `#café` two tags on a decomposing filesystem.

**Incremental reindex, two cadences** (`mb-server/src/indexing.rs`). A cheap per-file stamp —
length plus modification time — decides which notes to *read*; the content hash decides
whether any row changes, so a `touch`, a same-content save and a `git checkout` that restores
a file all cost a stat and nothing more. The watcher's named paths are re-read immediately;
the whole vault is reconciled on a slower sweep, which is also what notices a deletion and
what makes the index correct with no watcher at all (§3.4). Measured in §21.8.

**Link resolution is per user, so one link can resolve differently for two people.** §4.3
resolves a name collision by nearest path, and the candidates are the notes the asking user
may read (E9). A reader denied `Private/Roadmap.md` sees `[[Roadmap]]` resolve to
`Archive/Roadmap.md`; someone who can read both sees it resolve to the nearer one. That is
§6.5 rather than a bug: resolving first and dropping the edge afterwards would leave a dead
link exactly where an unreadable note exists, which tells the reader it is there.

### 9.2 Transclusion (A9)

`![[Note]]`, `![[Note#Heading]]`, `![[Note#^block-id]]`.

- Resolved at **render time**, never at storage time — the file stores the reference, not
  a copy. No CRDT complexity, no divergence risk.
- Heading transclusion includes the heading and everything until the next heading of equal
  or higher level.
- Rendered inline, visually distinguished, collapsible, with a jump-to-source affordance.
- **Cycle handling is mandatory:** maintain a resolution stack; on revisit, or beyond depth
  3, render as a plain link with a "circular embed" affordance. A cycle must never hang or
  crash the renderer — explicitly tested.
- Unreadable targets render as a neutral "content unavailable" placeholder that does not
  reveal the name (E7, §6.5).
- Editing inside a transclusion is not supported in v1; click through to the source.

**Implemented, M8.** Three pieces, and which piece owns what is the whole design:

- **`mb_core::transclude::slice` says which blocks a reference names** — pure, and property
  tested: every heading in any document names a section, a section is a contiguous window of
  the note containing no heading of equal or higher level, and slicing a section by its own
  heading again changes nothing. A heading is matched on its *visible text*, folded to NFC
  and lowercase, because the anchor was typed into a wikilink and the heading into the
  target note, possibly on a machine that decomposes. A block id is matched exactly: it is
  an identifier, not prose.
- **`GET /api/v1/vaults/{slug}/embed/{target}?from=…` resolves and renders one reference.**
  E7 lives here (§6.4), and so does §4.3: `from` is the note the reference was written in,
  which breaks a name collision by nearest path — so it is itself permission-checked rather
  than a free parameter for asking what a name means inside a folder the caller has no
  access to. The response is the canonical identity, the title, and the slice as an HTML
  fragment from `mb-core`'s renderer, which is the same one the share-link path uses and the
  reason it is safe to insert as markup. `GET …/resolve/{target}?from=…` is the same
  resolution without the content, for following a plain wikilink (§8.2).
- **The resolution stack is the client's**, because the client is what recurses: the route
  answers for one reference, and an embed inside an embed is a second request made by the
  view that mounted the first. So a crafted note cannot make the server loop, and the depth
  limit is checked *before* a request rather than after. The comparison is against the
  identity the server resolved, not the name the reference was written by — two notes may
  share a name, so `![[Roadmap]]` inside `Archive/Roadmap.md` is not necessarily a cycle.

**Absent and unreadable are one answer, and that has a visible cost.** A reference to a note
that does not exist and one to a note the reader may not see both get the empty-handed 404,
so the placeholder cannot say which it is looking at — which also means the editor cannot
offer to *create* a missing embed target. That is §6.5 rather than an
oversight, and the alternative is a UI that reports the existence of every note a reader
cannot read.

**A readable note with no such section is a third state**, not an "unavailable". The note
resolved and the reader may see it; it simply has no heading of that name. Reporting a typo
in a reference as a permission boundary would be a claim nobody checked, so the placeholder
names the missing section and still offers the jump to the note.

**The ids are stripped out of the fragment.** An embed is a *copy* of the target's blocks on
a page that may already hold the original, or a second embed of the same note, and a
duplicated `^block-id` makes every `#^anchor` ambiguous.

### 9.3 Nested tags (A9)

In the rich-text editor, typing a hashtag followed by a space or Enter creates a `tag` node.
Enter also starts the next paragraph in the same keypress, without inserting a space.
Inline tags appear as rounded, accent-tinted badges with bold accent text, using theme
tokens; long nested tags wrap within the note rather than overflowing it.
The Rust/WASM parser validates the candidate; numeric-only and explicitly escaped
hashtags remain text, and code blocks and inline code do not convert. Source Markdown
continues to use the same Rust parser directly. Opening Tags refreshes its server-filtered
counts. Previously typed hashtags that were saved as escaped text are not automatically
reinterpreted: intentional literal text must remain literal.

`#project/memberberry/spec` is one tag with three prefixes. The tag pane shows a
collapsible tree with per-node counts; selecting a node searches that prefix. Tags come
from both inline `#tag` and frontmatter `tags:` and are unified. Renaming a tag node
rewrites all descendants vault-wide through the same privileged, audit-logged path as note
rename (§6.6).

**Implemented, M8**, the rename included — it runs through §6.6's privileged, audit-logged
path and needs vault-wide `owner`, because a tag has no owner of its own the way a note
does. Renaming `#project` to `#work` moves `#project/memberberry` with it: a nested tag is
one tag with a path, so the subtree travels together, and frontmatter `tags:` are rewritten
alongside inline ones exactly as this section unifies them. Five decisions worth recording:

- **A count is permission-filtered, and that is enforcement point E16.** "How many notes
  carry `#salary`" is a way of asking how many notes exist, so the counts come from the
  index `Reader` and name only this user's readable set: a tag carried solely by notes they
  cannot read has no node at all, and a shared tag counts the notes they can see. The leak
  suite asserts the arithmetic, not just the names — a route test that checks which strings
  came back cannot see a count that is one too high.
- **Case is not identity, and the commonest spelling wins.** `#Project` and `#project` are
  one tag with one count, because a tag typed at the start of a sentence is the same tag.
  The label is the spelling the most notes use, ties broken alphabetically — deterministic,
  and it does not change when a note the reader cannot see is added. `prefix_key` (§9.1) is
  what makes that one query rather than a scan.
- **Selecting a node lists the notes; it does not search.** §14.1's text index arrives with
  M9, and listing the readable notes under a prefix is the part of "searches that prefix"
  the graph index can already keep. `GET /api/v1/vaults/{slug}/tags` answers the tree and
  `…/tags/{prefix}` the notes under one; a prefix names a whole subtree, so `project`
  answers for `#project/memberberry/spec`.
- **The twisty is a control of its own, separate from the row.** Selecting a tag and opening
  its children are two intentions, and a row that did both would make either impossible to
  do alone. The keyboard reaches both without it — Right and Left open and close, Enter
  selects — which is where the tag tree differs from the note tree, where Enter *toggles* a
  folder. A tag pane that inherited that would leave every parent tag unselectable (§8.4).

### 9.4 Graph view

- **Local graph:** n-hop neighbourhood of the current note, n adjustable 1–3, right sidebar.
- **Global graph:** whole readable vault, WebGL, force-directed layout in a Web Worker.
- At 10k nodes: level-of-detail rendering (labels above a zoom threshold), quadtree hit
  testing, Barnes-Hut layout, cached and incrementally updated rather than recomputed.
- Node size by degree or word count; colour by folder or tag; icons on nodes above a zoom
  threshold.
- Filters: tag include/exclude, path glob, orphans only, ghost nodes on/off, link vs embed
  edges, creation-date scrubber (free, given UUIDv7).
- **Mobile is capped honestly:** a mid-range Android will not render 10k nodes at 30fps.
  Mobile shows the local graph by default, and the global graph capped to the top N nodes
  by degree with a visible "showing 2,000 of 10,431" indicator. Budgets in §21.

**The local graph is implemented, M8.** `GET /api/v1/vaults/{slug}/graph/{note}?hops=N`
answers the neighbourhood and the right sidebar draws it. Seven decisions:

- **Rings, not springs.** A force-directed layout is what §9.4 asks for at *global* scale,
  where the question is what the shape of a whole vault looks like. The local graph answers
  a different question — how far is this from that — and one ring per hop answers it
  directly: the distance from the centre **is** the hop count, which a spring layout only
  approximates. It is also pure, deterministic and costs no worker, no animation frame and
  no settling time, so the panel never competes with the keystroke path (§21.2). The order
  around a ring is the one piece of art: a node is placed near the neighbours it already has
  on the ring inside it, which takes out most of the crossings a force layout was earning
  its keep by avoiding.
- **The walk is undirected and the edges are not.** A note that links *to* this one is as
  much a neighbour as one it links to, so both are within a hop; which way each link points
  is kept, because that is what a reader is looking at the picture to learn. Several links
  between one pair are one edge — three parallel lines between the same dots say nothing a
  reader can use, and the backlinks panel (§9.5) is where the individual links are listed.
- **Every link between two notes the graph shows is an edge the graph shows.** That costs a
  second query: the outermost ring's links to *each other* are found by expanding it, which
  is exactly what the hop limit stops, so a walk that collected edges as it went would draw
  the outer ring as unconnected dots. The second pass adds no node, so `hops` still means
  what it says.
- **An unresolved link is a ghost node**, drawn hollow and carrying the name the source note
  spells. That is §6.5 rather than a feature with a permission caveat: a link into a note
  the reader cannot see and one into a note nobody has written **must** be the same shape,
  and the name is text the reader can already see, since a note they cannot read has no node
  from which to link. Ghosts are leaves — nothing resolves to them, so nothing links out of
  them.
- **The node cap is 200 and it is visible.** A three-hop walk out of a hub note is most of a
  vault, and a sidebar that tries to draw ten thousand dots is a frozen tab. The reply says
  it was truncated and the panel says so on screen — the same honesty §9.4 requires of the
  mobile cap, for the same reason.
- **What takes a click is a transparent circle, not the dot.** A drawn dot is 3–8 units
  across in a 200-unit picture, which on a phone is a target of a couple of millimetres. Each
  node carries a hit circle widened to half the distance to its nearest neighbour — the
  largest value that cannot reach another node, because an overlap means one tap belongs to
  two notes. §8.3's 44px floor is **not** met on a crowded ring and cannot be without that
  overlap; this is the honest maximum rather than a number that reads well.
- **One tab stop, arrows to move, Enter to open** (§8.4), the same shape as the note tree
  and the tag pane. A graph of two hundred nodes must not be two hundred stops, and a
  picture only a pointer can use does not ship.

**The whole-vault query and its route are implemented, M8.**
`GET /api/v1/vaults/{slug}/graph?limit=N` answers with every readable note as a node, every
link between two of them as an edge, and a `total` the picture prints beside the cap. Six
decisions:

- **No origin, so no hop — and the cap is by degree.** A neighbourhood is bounded by a
  distance; a vault is bounded by nothing, so what decides which nodes survive is how
  connected they are. That is §9.4's mobile cap ("the top N nodes by degree") applied at the
  only layer that can compute it, and it is reported rather than silent: `total` is the node
  count before the cap and `truncated` says it bit.
- **A degree is the vault's, not the picture's.** A node capped down to six neighbours still
  reports the forty it has, because that is what §9.4 sizes a node by and because a degree
  counted after the cap would rank a hub by how much of it survived.
- **Two ceilings, one honest.** `limit` is the client's, because which device is asking is
  not something a server should infer from a header. `MAX_VAULT_GRAPH` (10 000) is the
  server's, matching §21.2's desktop budget: a picture larger than any budget covers is one
  no reader can take in either.
- **The creation date comes from the note or from its `id`.** Frontmatter `created` wins,
  because a person or a template wrote it; failing that, the 48-bit timestamp inside a
  UUIDv7 `id` (§4.3) is what makes the scrubber "free". A note with neither — the
  `printf > note.md` case C2 requires to work — is **undated**, which is a state the scrubber
  has to show rather than a note to hide.
- **Tags travel whole, not per prefix.** §9.3 indexes one row per prefix so a tag query needs
  no scan; the graph wants the other end of that, so a node carries `project/mb/spec` and the
  client's include/exclude filter is a string prefix — the same nesting rule, a third of the
  payload.
- **Edges are index triples, not objects.** `[source, target, embed]` into the node array,
  flat. At ten thousand notes the objects-naming-keys encoding is megabytes of repeated
  paths; this is a few hundred kilobytes that the client reads into a `Uint32Array` and
  transfers to the layout worker without allocating per edge. It is the one payload in the
  project written for size over legibility, so the client validates it rather than trusting
  it — an index out of range would otherwise be read as an edge to whichever node landed
  there.

**The global graph is implemented, M8.** WebGL for the picture, a force layout in a Web
Worker, quadtree hit testing, level of detail above a zoom threshold, and the six filters
above. It opens from the command palette (`Mod+Shift+G`) over the workspace. Nine decisions:

- **A view over the panes, not a tab in one.** §8.1's workspace model holds *notes* in tabs,
  and a graph is a view of the vault rather than a note. Making it a tab would mean a second
  kind of tab in the model, in its persistence (E15), in the tab strip and in the mobile
  layout — a change to a finished subsystem for one feature. The cost is real and recorded
  below: the graph is not one of two things on screen at once, and it does not survive a
  reload the way an open note does.
- **Loaded on demand, as its own chunk.** The renderer, the layout, the quadtree and the
  filters are about 15 KB gzipped and most sessions never open the graph, so §21.1's
  already-breached bundle budget does not pay for them: `Workspace.svelte` reaches the pane
  through `import()`. What is on the critical path is the command and the wiring, measured
  at 1,295 bytes. The layout worker is a chunk of its own for the same reason.
- **Barnes-Hut, and one quadtree for both of §9.4's uses.** The layout's all-pairs repulsion
  and the pointer's hit testing are the same structure asked two questions, so there is one
  implementation, rebuilt per tick from flat typed arrays. Its opening angle is 0.9 —
  d3-force's default, and about a fifth out on the worst pair of masses, which is what an
  approximation is. A quad at maximum depth chains coincident points rather than subdividing
  further; without that, two notes on the same coordinate hang the worker.
- **Deterministic, with no `Math.random` anywhere.** Starting positions are a phyllotaxis
  spiral and the tie-breaking jiggle is a hash of the node index, so the same vault draws the
  same picture every time it is opened. That is the difference between a graph a reader can
  build a memory of and a decoration that rearranges itself — and it is what makes the layout
  testable at all.
- **The worker's batch is a deadline, not a tick count**, so the picture updates at a steady
  rate whatever the vault's size. It does not make the result depend on the machine: the
  *sequence* of ticks is the same either way, so a phone settles on the picture a laptop
  settles on, only later. When no worker can be created the same code runs on animation
  frames on this thread — a browser that will not give us one is still a browser we have to
  draw in.
- **Labels and icons are a 2D canvas over the WebGL one**, not a glyph atlas. Text in WebGL
  is a large amount of machinery whose advantage only appears above the zoom threshold, where
  §9.4 caps the labels at a couple of hundred anyway. Two stacked canvases cost one composite
  and keep the browser's own text quality, including for scripts an atlas would get wrong. A
  third element, transparent and on top, takes every event: a `<canvas>` cannot carry a role,
  and one hit surface cannot disagree with itself.
- **`preserveDrawingBuffer` is on, and it is not free.** Without it the drawing buffer is
  cleared as soon as the frame is composited, and *nothing* can read the picture back — which
  means no test can tell "the graph rendered" from "the graph mounted". §22.6 records two
  releases where a green suite shipped a blank page; a renderer whose output nothing can see
  would be the third. The cost is a buffer the driver keeps rather than discards.
- **The filters run on the client, over a picture the server already filtered.** A scrubber
  is a control you drag, and a round trip per frame would make the vault's shape over time
  something you request rather than something you watch. This is not client-side permission
  filtering (`AGENTS.md` §3.1): the readable set decides what the browser is *sent*, and
  these decide what a reader wants to look at within it.
- **One tab stop, and an arrow means the nearest node that way.** §8.4 does not allow a
  mouse-only feature, and a list order over a force layout is an order nobody can see — so
  the arrows walk the picture spatially, within a 45° cone, and Enter opens what is selected.
  `+`, `-` and `0` zoom and fit. A ghost is selectable and opening one does nothing, which is
  the same inert-but-present shape the local graph gives it.

**What is honestly not there.** The picture does not refresh while it is on screen; it is not
a tab, so it does not survive a reload; and there is no pan-and-zoom-preserving reopen. The
mobile cap is applied from the layout mode at the moment the graph is first opened, so a
tablet rotated after that keeps the cap it was given. Each is in `HANDOFF.md` with what it
would take.

### 9.5 Backlinks and outline panes

- **Backlinks (M8):** inbound links grouped by source note, each showing the block the link
  sits in, filtered by readable set (E8). The right sidebar's panel follows the note in the
  focused pane; a row opens the linking note. `GET /api/v1/vaults/{slug}/backlinks/{note}`
  answers for the canonical identity the requested reference resolves to, so a request for
  `Roadmap` gets an answer about `Projects/Roadmap.md` and is told so.
  - An embed is marked as one: a transclusion is an inbound link *and* a copy of this note
    on that page, which a reader deciding whether to follow it needs to know.
  - "Nothing links here" and "the server would not answer" are **different states on
    screen**. Reporting a refusal as an empty list is a claim nobody checked.
- **Unlinked mentions (M9):** notes whose *text* names this one without linking to it, in a
  second section of the same panel, below the links. They arrive on the same response as the
  backlinks and under the same three filters (E8): the readable set enters the Tantivy query
  as a required clause rather than filtering its results.
  - **What counts as a name:** every name a wikilink could have used — path, filename stem
    and each alias (§4.3) — plus the note's own title, which §4.3 deliberately does *not*
    make a link target. So a mention is text somebody could have wrapped in brackets, or the
    heading they meant when they did not.
  - **Whole tokens in sequence, no prefix and no fuzziness**, unlike the search box (§14.1),
    where the user is typing and wants forgiveness. `Roadmap` is not found in a note that
    only says "roadmaps".
  - **A note that links here is a backlink and never also a mention.** The server puts each
    note in one list or the other, so the client does no de-duplication.
  - **Bounded at 50 mentioning blocks**, and the cap is a cap rather than a page: a note
    called `Notes` matches a large fraction of a vault, and the honest answer to that is a
    bounded list plus §14.3's search pane, not a sidebar to scroll.
  - **Ordered by path, then by position in the mentioning note** — the same order the links
    above use. Relevance order would interleave two notes' blocks and make a group's contents
    depend on how many other notes matched.
  - **No section at all when nothing mentions the note**, unlike "nothing links here yet":
    an empty list would answer a question the reader has not asked.
  - Deciding this needed the text index, which is why it moved out of M8. The alternatives
    were both worse: a `LIKE` scan over 10 000 notes per note opened misses the §21.2 budget
    by orders of magnitude, and storing every block's text in SQLite duplicates the search
    index a milestone early.
- **Outline (A9):** headings of the current note as a live tree; click to scroll, current
  section highlighted, drag to reorder sections (which moves the underlying blocks).

**The outline is implemented, M8**, and unlike every other panel it fetches nothing: the
headings are in the open document, so they arrive from the editor and change as the note is
typed into. Five decisions:

- **The work is in the editor, and the panel only renders it.** Reordering sections *moves
  blocks*, which is a ProseMirror transaction on a CRDT-backed document — only code holding
  the editor can make that as an edit rather than as a rewrite. `mountOutline` announces the
  outline as a DOM event and answers two requests sent back at the element that announced, so
  a split with two editors cannot cross its wires. Same shape as §8.2's link handler, in the
  other direction.
- **A section is the same span a transclusion of that heading would show** — to the next
  heading of equal or higher level (§9.2). One definition, so what an outline row moves is
  what `![[Note#Heading]]` renders.
- **A move is two steps, an insert and a delete, never a whole-document replace.** A replace
  reaches the other replicas as "everything was deleted and rewritten", which loses every
  concurrent edit's intent and inflates the update log for a change that moved three blocks
  (§5.6).
- **Levels are the user's.** Dragging a `##` above a `#` moves the blocks and promotes
  nothing: the heading text is theirs, and rewriting it is a bigger claim than the gesture
  makes. Alt-arrow moves a section past its next *sibling* rather than into the subsection
  travelling with it, so a keypress is never silently refused.
- **The current section is the last heading at or above the top of the viewport**, and
  "above the first heading" is a real state that highlights nothing — a note usually opens
  with a paragraph, and the editor's control strip sits above the first heading inside the
  scrolled box. Offsets are measured per frame while scrolling rather than cached: a pane
  resize, a split drag or a late font changes them without changing the document.

---

## 10. Tasks (A12)

`PROJECT.md` asks for basic task checkboxes. A12 raises that to due dates
and priorities, which also makes the eventual gonnadoit integration worth doing.

### 10.1 Syntax — Obsidian Tasks compatible

Stored in the Markdown file, as emoji markers, in this fixed serialization order:

```markdown
- [ ] Write the serializer property tests ➕ 2026-08-28 🛫 2026-09-01 ⏳ 2026-09-03 📅 2026-09-05 ⏫
- [x] Decide on note identity ✅ 2026-08-28
- [-] Abandoned idea ❌ 2026-08-20
```

| Field | Marker | Notes |
|---|---|---|
| created | `➕` | set automatically on task creation, optional |
| start | `🛫` | |
| scheduled | `⏳` | |
| due | `📅` | |
| done | `✅` | written on completion |
| cancelled | `❌` | status `[-]` |
| priority | `🔺 ⏫ 🔼 🔽 ⏬` | highest → lowest; absent means none |

Emoji markers rather than a cleaner syntax like `[due:: 2026-09-05]` **because of C5**:
this is the de facto standard across the Obsidian Tasks ecosystem, so tasks round-trip
with the tooling already in use. It is slightly ugly in raw text but self-evidently
readable, which is what C2 actually requires.

Dates are `YYYY-MM-DD`, no times in v1. Parsing lives in `mb-core`, is shared by editor,
index and clipper, and is property-tested for round-tripping.

### 10.2 Editing

Metadata renders as inline chips, not raw emoji. Click a chip for a date picker or
priority menu. `/due tomorrow`, `/priority high` slash commands with natural-language date
parsing (`tomorrow`, `next friday`, `in 3 days`). Completing a task writes `✅` with
today's date. Toggling in a transcluded or query view edits the source note.

**The inline view, M7 follow-up.** M3 ticked "task metadata chips" for a toolbar inspector;
nothing rendered inline, so through M7 a task drew as a plain bullet with no checkbox and no
due date. The data was never the problem — the attributes were on the `li` and round-tripped
to disk correctly — which is exactly why nothing caught it: every assertion in the repository
was about the document, and the document was right. It was a missing view.

`web/src/editor/task-view.ts`, a ProseMirror node view. Four decisions worth recording:

- **A node view rather than a `renderHTML` rule.** `renderHTML` produces static DOM, so a
  checkbox drawn there could show state but never take a click. Keeping it out of `schema.ts`
  also keeps that module what it claims to be — a generator over the Rust-owned contract with
  no special case in it. The contract governs the *document*; how a task looks is not part of
  it, and anything mounting the bare extensions still gets the plain `li`.
- **The checkbox is not in the tab order, and that is not a mouse-only feature.** `Tab` inside
  a document belongs to the editor, and a note with a hundred tasks would otherwise be a
  hundred tab stops. The keyboard route to the same change is the toolbar's task inspector,
  which appears when a task is selected — §8.2's rule that a pointer gesture and its keyboard
  equivalent are two features and two tests, applied here.
- **Chips are laid out in §10.1's serialization order**, so the chips a reader sees and the
  markers in the file they would see in a text editor are the same sequence. Clicking one
  selects its task and opens the matching control in the inspector; a chip for a field the
  inspector does not edit — `created`, `done`, and §10.4's preserved markers — does nothing
  rather than opening the wrong picker.
- **Completion is one function.** `toggledTaskAttributes` in `task-metadata.ts` is shared by
  the checkbox and the inspector, because two paths that disagreed about the `✅` date would
  be two different documents on disk. Toggling only ever moves between `todo` and `done`;
  `[-]` is reached by writing it, and an existing `❌` date is left alone rather than the app
  deciding on the user's behalf that cancelling is undone by completing.

Nothing rebuilds on a keystroke: the node view re-renders only when `sameMarkup` says the
attributes changed, so typing inside a task allocates nothing (§21 and `AGENTS.md` §4.5).

**On a phone** the marker stays sized to the text it sits beside — a list of tasks should not
be a column of buttons — and its *hit* area is grown to §20.3's 44px with a pseudo-element,
so it costs the line no height. The area hangs downward from the top of its row rather than
being centred on the marker, and the row takes `min-height: var(--touch-target-min)`: together
those make "a checkbox cannot reach into the task above it" a property of the rule rather than
of the current type scale. It also stops where the text begins, so tapping the first character
of a task places the cursor instead of completing it. The task inspector is **shown** at this
width, where it used to be hidden — now that it appears only for a selected task it is also
the only keyboard route to completing one, and hiding it would make that a mouse-only feature.

### 10.3 Task views

A dedicated pane, and the query blocks that satisfy PROJECT.md's TODO requirement:

- **Inbox:** all open tasks in the readable set, grouped overdue / today / this week /
  later / no date.
- Filters: folder, tag, priority, date range, note.
- Sort: due, priority, created, path.
- Available offline for the replicated set, since task rows travel with metadata (§7.2).

**Implemented, M14 (inbox pane).** The left sidebar's Tasks panel fetches
`GET /api/v1/vaults/{slug}/tasks`, groups the answer client-side into the five buckets above,
and exposes the route's filters and sort as labelled controls. "This week" is the rest of the
current ISO week (Monday–Sunday) after today; overdue and today claim the earlier part.
Selecting a row opens the source note. Editing a task *from* the inbox (toggle, due, priority
written back into the Markdown) is implemented: the row's controls open the source note and
apply the shared task commands to its indexed task ordinal, including when the note is already
open. The note catalog carries the same permission-filtered open-task rows into the replicated
metadata tier, so an unfiltered inbox remains available offline without opening resident note
bodies. Filtered offline queries remain unavailable when the route cannot answer; the cache has
no tag rows and must not pretend to reproduce the server's tag filter.

**M14: index query and editing boundary.** `GET /api/v1/vaults/{slug}/tasks` returns only
open tasks through E18. It supports `folder`, `tag`, `priority`, inclusive `due_from` /
`due_to`, `note`, and `sort=due|priority|created|path`. Date-range filtering is over `due`;
tasks without a due date are omitted from a range and belong in the unfiltered inbox's
"no date" group. The derived `tasks` table records `created` as well as the other task
markers, because sorting a field without indexing it would make the query engine lie.

### 10.4 Deliberately deferred

**Recurrence (`🔁`)** is out of v1. It needs RRULE-ish semantics, next-instance
generation, and a completion model that decides whether completing an instance rewrites
the source line or appends a new one — a rabbit hole disproportionate to its value here.
Recurrence markers found in imported files are **preserved verbatim** and rendered as an
inert chip; they are never dropped or mangled.

---

## 11. Emoji

Slack-grade is the stated bar, so this is specified in full.

### 11.1 Base pack

The Unicode set with shortcodes from Emojibase 5.0.1 (1,814 entries and 1,923 unique
shortcodes/aliases), vendored at `vendor/emoji/emojibase-data.json` and compiled into a lazy WASM
module as a static map — no network fetch, works offline when the picker first opens. The generated
Rust source is produced by `scripts/generate-emoji-catalog.mjs`; aliases resolve to the same literal
glyph without duplicating picker tiles. Skin-tone modifiers are supported
(`:wave::skin-tone-3:`).

Picker entries, including the authorized custom-pack lookup, load on first opening the
picker rather than gating note-editor readiness. A slow custom-pack request must not hide
the note or prevent editing. The picker reports loading/failure, preserves a query entered
while loading, and cancels pending requests when its editor is destroyed. Loading failures
may be retried by explicitly closing and reopening the picker.

### 11.2 Custom emoji

**Packs are server-level and shared by every vault** (A21). Uploading a Slack collection
once makes it available everywhere, which is the whole point.

```
<data-dir>/emoji/packs/my-emoji/     # shared across all vaults — requires server admin
  pack.json
  partyparrot.gif

<vault>/.memberberry/emoji/packs/…   # optional per-vault additions
```

Resolution: a vault-local pack **overrides** a shared pack on shortcode collision — more
specific wins, consistent with ACL resolution (§6.3). Managing shared packs requires the
server admin flag (§6.8); vault owners manage their own vault's packs.

Emoji are the **only** server-shared resource. Media, S3 configuration, themes, templates
and history all remain strictly per-vault (A22).
```json
{
  "name": "my-emoji",
  "version": 1,
  "emoji": [
    { "shortcode": "partyparrot", "file": "partyparrot.gif", "aliases": ["parrot"] }
  ]
}
```

- **Bulk upload:** drag a folder or `.zip`; filenames become shortcodes
  (`party-parrot.gif` → `:party-parrot:`). Collisions prompt rename-or-overwrite.
- The management API accepts a bounded JSON upload containing the manifest and base64 image
  files: `PUT /api/v1/emoji/packs/<name>` requires server admin, while
  `PUT /api/v1/vaults/<slug>/emoji/packs/<name>` requires vault owner. Pack names and files are
  validated before an atomic install; existing packs return conflict rather than being silently
  replaced. Folder/zip import remains a picker/CLI convenience on top of this format.
- **Slack export importer** — that is where an existing custom emoji collection lives.
- Image bytes are stored beside `pack.json` in the pack directory shown above and served only
  through E22's authorized vault route. They are not note media and do not enter a note's
  content-addressed media namespace (§12).
- **C2 consequence:** shared pack images live outside the vault, so a vault copied
  elsewhere loses its custom emoji artwork. The text still reads `:partyparrot:`, which is
  the readable degradation C2 asks for — but `memberberry export --materialize-emoji`
  copies every referenced pack into the vault, mirroring the media rule in §12.3. It runs
  as part of a full export by default.

### 11.3 Representation and degradation

In the file, **always** `:shortcode:` for custom emoji — never an `<img>` tag, never
base64. A dead app leaves `:partyparrot:` in the text: exactly what Slack leaves, and
perfectly readable.

Unicode emoji **store the literal glyph** (🎉), not the shortcode, because a glyph renders
everywhere including in a plain text editor — better under C2. Typing `:tada:`
autocompletes to 🎉; `:partyparrot:` stays textual. Both are picker-inserted identically.

### 11.4 Picker

Grid with search, frequently-used, category tabs, **Custom section first**, skin-tone
selector. Inline autocomplete on `:` + 2 characters, fuzzy, keyboard-navigable. Mobile:
bottom sheet.

---

## 12. Media

### 12.1 Backends

`object_store` abstraction, two backends:
- **Local filesystem** (default) — `<vault>/media/…`, zero infrastructure.
- **S3-compatible** — MinIO, Garage, Ceph, B2, AWS. Configured per vault.

The backend is server-owned configuration, never vault content. A vault selects S3 in its
`[[vaults]]` entry with `[vaults.media] backend = "s3"`, `bucket`, `region`, credentials,
and optional `endpoint`, `allow_http`, and `virtual_hosted_style`; omitting the table is local.

### 12.2 Content addressing

`sha256(bytes)` → `media/<hash[0:2]>/<hash[2:4]>/<hash>.<ext>`. Free deduplication,
immutable URLs, trivially cacheable. Original filename kept in the index for display and
in the Markdown alt text.

The object identity is cacheable, but the authenticated response is `private, no-store`:
a browser cache surviving revocation would bypass E11. Immutability removes revalidation
ambiguity; it does not outrank authorization.

Downscaled display objects and their retained originals are related by the rebuildable
`.memberberry/media-originals.json` manifest. It contains paths only, never content or
credentials. `doctor` and materialization follow that relation, so a retained original is
not misreported as orphaned and is not omitted from a self-contained export. The original is
immutable: display resize, crop, rotation and adjustments must write a new display object and
must never overwrite the retained original. Replacing the display from the original reads the
original as the source and creates another derived object.

**Content addressing is not authorization.** Serving a blob because its hash was guessed
or leaked is a permission bug. Access is gated by `media_refs` (E11): a user may fetch a
blob only if some note they can read references it. Deduplication means one blob may be
referenced from several notes at different permission levels — read access to *any one*
of them suffices, which is correct, since the bytes are identical.

### 12.3 The C2 problem with S3 — solved explicitly

If a note says `![diagram](s3://bucket/…)` then a dead app means unreachable images,
violating C2.

**Rule:** Markdown always references media by **vault-relative path**
(`media/a3/f9/a3f9….png`), never a bucket URL. With the S3 backend active the server
resolves that path to the object store at read time. `memberberry export
--materialize-media` downloads every referenced object into `<vault>/media/` so the vault
becomes fully self-contained; this also runs as a nightly job when S3 is configured.

### 12.4 Handling

Paste, including image data for screenshots currently held in the system clipboard, plus
drag-drop and file picker. Client-side downscale above a configurable dimension with
the original retained. Server-side thumbnails. Inline PDF viewer. Offline uploads queue in
IndexedDB with an optimistic blob URL, swapped for the content-addressed path on flush.
Rendered images fit the editable column while retaining their intrinsic aspect ratio. The
server prunes unreferenced media after the five-minute upload grant expires; active grants
are protected so an upload can complete its note-save/index cycle. `memberberry doctor`
still reports orphaned media for installations whose server is not running.
Selecting an image opens controls for derived-display resize, center crop presets, 90-degree
rotation, and brightness/contrast/saturation adjustments. Saving uploads a new
display object; “Use original” reloads the immutable original as the editing source. The
Markdown reference changes only after the derived upload succeeds.

Uploads accept PNG, JPEG, GIF, WebP and PDF after the server verifies that the bytes match
the filename extension. SVG is excluded: serving user-controlled active XML from the
authenticated application origin would create a script-capable same-origin document.

`media_max_dimension` in `.memberberry/config.toml` defaults to 2560 and is bounded to
256–8192. The server thumbnail route accepts `?thumbnail=N`, clamps N to 64–2048, limits
decoded dimensions and allocation, and returns WebP. PDF files remain ordinary Markdown
links and gain a read-only same-origin `<object>` preview in the editor. Queue records retain
enough identity to replace an optimistic blob URL after a page reload as well as after a
same-page reconnect.

---

## 13. Excalidraw

- Embed `@excalidraw/excalidraw` as a lazily-loaded React island (§5.1). The server exposes
  authorized scene JSON through `GET/PUT /api/v1/vaults/{slug}/drawings/{drawing}` and stores
  derived exports through the sibling `drawing-exports` route; the source remains the complete
  `.excalidraw.md` file and invalid scenes are rejected. Saves carry a SHA-256 base revision and
  return `409 Conflict` when another writer changed the source first.
- **Storage: Obsidian-plugin-compatible `.excalidraw.md`** — a Markdown file with the
  scene JSON in a fenced block plus a text-elements section. Chosen over raw `.excalidraw`
  JSON specifically for C5: drawings round-trip with Obsidian.
- Embed via `![[system-diagram.excalidraw]]`, rendering as a static SVG preview that
  expands to the full editor on click.
- SVG and PNG exported alongside the source on save, so a dead app still shows the picture.
- **Not CRDT-merged in v1.** `.excalidraw.md` is last-write-wins with conflict detection:
  if both sides changed, keep both and warn. Excalidraw has its own collab model; wiring it
  into ours is a v2 project. With multi-user editing now in scope this limitation is more
  visible than it was — surface it in the UI when two people open the same drawing.
- Drawings live under the same ACL as any other file at that path.
- Handwriting/stylus input is supported by Excalidraw natively; no extra work.

---

## 14. Search

### 14.1 Server-side

Tantivy over note bodies. Full-text, prefix, fuzzy, field-scoped (`tag:`, `path:`,
`title:`), boolean operators. Incremental updates on the write path. Every query carries
the readable-set filter (E5).

**Implemented in M9.** One Tantivy document per visible top-level block keeps result context
in model space rather than byte offsets. Title, aliases, tags and path are indexed once per
note; body text is indexed per block. A required exact-path term set, populated from the
SQLite reader's live `v_notes`, is composed into the query before Tantivy executes it, so a
denied document is never fetched and filtered afterwards. One-edit fuzzy prefix matching is
the default for plain terms; Tantivy's parser supplies field scoping and boolean operators.
The watcher path and the full recovery sweep queue replacements/deletions and publish one
commit per tick. The index lives at `.memberberry/index/search-v1`; losing it independently
clears SQLite stamps so every Markdown note is reread on the next reconcile (I1), and a
directory written under an older field layout is **rebuilt rather than refused** — the same
rule §9.1's `user_version` applies to SQLite, and the reason a schema change is not a server
that will not start. Only a schema mismatch triggers that: wiping a directory on, say, a lock
held by another process would destroy an index that is merely busy.

§9.5's unlinked mentions are the second reader on this index. They query the same required
path clause with exact whole-token phrases instead of the fuzzy prefix terms the search box
uses, and each block carries its ordinal so a mention list reads in document order.

### 14.2 Client-side compact index (A5) — full readable vault, offline

The whole readable vault is searchable offline. A real engineering artifact, so specified
concretely rather than waved at.

**Format** (`mb-search`, built server-side, queried in WASM):
```
[header]  version, note count, term count, zone id, acl hash
[fst]     term dictionary (fst crate) -> postings offset
[post]    per term: doc-id list, delta-encoded, varint, sorted
[fields]  per note: title, path, tags, icon, first-200-char snippet
[map]     dense doc-id <-> note identity (UUID when present, path fallback otherwise)
```

**Binary v1, implemented in M9.** The fixed 124-byte little-endian header is magic,
version, reserved flags, live-note / record / term counts, the 32-byte zone ID and ACL hash,
four section lengths, and a CRC-32 over the payload. The four length-delimited sections then
appear in the order above. FST keys begin with a one-byte field namespace (`any`, `body`,
`title`, `path`, `tag`); its value is a postings-relative offset. A posting is a varint count
followed by sorted doc IDs encoded as unsigned varint deltas. Field strings and tag counts are
varint-length-prefixed UTF-8. The map stores a tagged 16-byte UUID or tagged path string.

The path fallback is not optional complexity: §4.3 requires an imported note without
frontmatter `id` to be indexed without rewriting its Markdown merely because the vault was
opened. Such a note is keyed by path for delta merging, so its rename is a tombstone for the
old path plus an upsert for the new path. Notes with UUIDs keep identity across renames.
Tombstones carry an identity and no fields or postings, and survive merges so an older base
cannot resurrect a deletion. Encoding is deterministic by identity, and each segment is
validated (bounds, counts, UTF-8, FST and checksum) before it can be queried.

**Size budget at 10k notes × ~500 words:**

| Component | Estimate |
|---|---|
| FST term dictionary (~200k unique terms) | 2–4 MB |
| Postings (~1.5M distinct term-doc pairs, varint delta) | 2–3 MB |
| Snippets + fields (10k × ~250B) | 2.5 MB |
| **Total** | **~7–10 MB** |

**Hard ceiling: 15 MB at 10k notes.** If measurement exceeds it, the format is wrong —
stop and revisit rather than shipping it.

**ACL zoning — how permissions and the index compose.** Shipping one index and filtering
on the client would hand users data they may not read. Instead:

> An **ACL zone** is a maximal set of notes with identical effective permissions — a
> subtree, cut wherever a rule overrides. One index segment is built per zone. A user's
> client index is the **union of segments for zones they can read**.

The root zone uses an empty path prefix. A zone ID is a versioned SHA-256 of that normalized
prefix, so it names the same subtree across ACL edits; the separate ACL hash changes whenever
the subtree's effective permissions change. Rules that do not change the complete effective
mapping are not zone boundaries.

This composes with the LSM segment design the format already needed for incremental
updates, costs O(vault) server-side storage rather than O(vault × users), and means the
client never receives a byte it may not see (E6). Segment merging on the client is the
same code path as delta merging.

- **Incremental updates:** the server pushes a per-note delta into its zone's segment;
  clients merge in the background when delta count exceeds a threshold.
- **ACL change:** re-partitions zones, rebuilds affected segments, pushes the new zone
  list. Clients drop revoked segments immediately on receipt (§7.4).

`mb-search` implements build, query and ordered LSM merge. A merge accepts only segments with
the same zone ID **and ACL hash**; mixing permission epochs is an error rather than a chance to
retain revoked bytes. Newer upserts and tombstones win by note identity.

**Per-zone publication and reader assembly, implemented in M9.** After the SQLite and Tantivy
writers publish, `mb-index` rebuilds one complete compact segment per persisted maximal zone
under `.memberberry/index/zones/<zone-id>.idx`. Every note goes to the deepest matching prefix,
so a child override is never duplicated in its parent. Reopening an index reconstructs the
in-memory assembly from the published derived sources even when the ACL rows did not change;
stale zone files are removed. `Reader::client_segments` evaluates the live ACL and returns only
segments whose zone ID and ACL hash match that reader's permitted epoch. The previous in-memory
snapshot is cleared before a rebuild, so an interrupted rebuild withholds bytes rather than
serving a note that may have moved into a denied zone. Invalid imported frontmatter IDs use the
path identity, preserving §4.3's no-mutation rule. **Transport and browser ownership are also
implemented in M9.** `GET /search/segments` returns only the reader's `(zone_id, acl_hash)`
manifest, and `GET /search/segments/{zone}?acl_hash=…` repeats that live check before returning
binary-v1 bytes. IndexedDB stores the permitted manifest separately from segment bytes and
transactionally drops absent or changed epochs before fetching any missing bytes; a binary
refusal after a manifest is a race and clears every segment fail-closed. Each received binary
is validated by `mb-search` through WASM before persistence. Full published snapshots replace
their current epoch; the same WASM boundary exposes ordered same-epoch merge for incremental
deltas when the transport starts emitting them.

**v1 scope:** tokenized word and prefix matching, field scoping, boolean AND/OR/NOT. No
positions, therefore **no exact phrase search offline** — phrase queries fall back to
AND-matching with a clear UI indication, and run exactly when online. No stemming; prefix
matching covers most of the practical value. Both are honest v1 limits, not bugs.

### 14.3 UI

Quick switcher (Cmd/Ctrl-K) fuzzy over titles, aliases and headings. Full search pane with
matched-block context, not byte offsets, while online. Offline results show the compact
index's retained first-200-character note context: the binary has no block positions, so it
must not claim it found the matching block. Results indicate online (Tantivy, exact) vs
offline (compact index, prefix) mode rather than silently differing; quoted offline phrases
also say that they use all-word matching.

---

## 15. Daily notes and templates (A3)

### 15.1 Daily notes

- Configurable folder and filename format (default `Daily/YYYY-MM-DD.md`), per vault.
- "Open today's note" command + hotkey; creates from a template if absent.
- Previous/next-day navigation, including across gaps.
- Optional weekly/monthly periodic notes with their own formats and templates.
- Calendar view in the sidebar showing which days have notes.

**Navigation implemented in M13.** Daily-note panes show previous/next controls when the open
note is in the permission-filtered calendar. Each control opens the nearest existing note in
that direction, so missing dates do not create gaps in navigation. Non-daily notes show no
daily controls. A missing daily note uses `Templates/Daily.md`; `daily_note_template` in
`.memberberry/config.toml` overrides that path relative to the configured template folder.
The template is used only when it is readable by the caller.

**Periodic notes implemented in M13.** “Open this week’s note” uses the ISO week-numbering
year and week, so 1 January may correctly belong to the prior year’s final week. “Open this
month’s note” uses the local calendar month. Existing readable notes open directly; absent
ones are created through E17 and expand their readable template through the same engine as a
daily note. Defaults are `Weekly/%G-W%V.md` with `Templates/Weekly.md`, and
`Monthly/%Y-%m.md` with `Templates/Monthly.md`. The independent config keys are
`weekly_folder`, `weekly_note_format`, `weekly_note_template`, `monthly_folder`,
`monthly_note_format`, and `monthly_note_template`; template names remain relative to
`template_folder`. Daily formats require `%Y`, `%m`, `%d`; weekly formats require `%G`, `%V`;
monthly formats require `%Y`, `%m`. Unsafe or incomplete values fall back to their default.

### 15.2 Templates

Templates live in a configurable folder (default `Templates/`). Insertion via command
palette, a `/template` slash command, or automatically on daily-note creation.

| Variable | Meaning |
|---|---|
| `{{date}}`, `{{date:FORMAT}}` | Current date, `strftime`-style format |
| `{{time}}`, `{{time:FORMAT}}` | Current time |
| `{{title}}` | Target note title |
| `{{cursor}}` | Where the cursor lands after insertion |
| `{{selection}}` | Selected text, when converting a selection into a note |
| `{{yesterday}}`, `{{tomorrow}}`, `{{date+3d}}` | Relative dates, for daily-note links |
| `{{uuid}}` | A fresh UUIDv7 |
| `{{user}}` | Current user's display name |

Template expansion lives in `mb-core` — pure, testable, shared — **not** in the UI layer.

**No arbitrary code execution in templates.** A deliberate scope limit.
With multiple users now in scope this is also a security decision: a template
is a file an editor can write, and executable templates would be a privilege-escalation
path. Revisit only with a real sandbox design.

---

## 16. Web clipper (A11 — v1)

### 16.1 Browser extension

Chrome MV3 + Firefox from one codebase.

- Clip modes: **full page**, **selection**, **simplified article** (`@mozilla/readability`).
- HTML → block document conversion runs in **`mb-core` via WASM**, so clipped content is
  canonical Markdown identical to what the app produces — not a second, divergent path.
- Images: referenced by URL initially; a server-side job fetches and rehosts them into the
  media layer so clips survive link rot (a clip pointing at someone else's server is not
  owned data — C1).
- Frontmatter captures `source`, `clipped`, `author`, `site` automatically.
- Target selection: vault, destination folder, tags, template, with sensible defaults.
- Auth via a **scoped API token** (§6.8) — the extension never sees a password, and its
  token can be revoked without affecting sessions.
- Offline: clips queue locally and flush on reconnect.

`mb-core::html::from_html` accepts
browser HTML, selects the body when present, maps headings, paragraphs, lists, quotes, code,
links, images and inline emphasis into the shared block model, and serializes through the
existing canonical Markdown path. It is deliberately total for malformed input, drops
executable elements (`script`, `style`, `template`, `noscript`), decodes HTML character
references, and emits no raw HTML. `mb-wasm::htmlToMarkdown` exposes that same conversion to
the browser.

### 16.2 Mobile share target

The PWA registers a multipart `share_target` in its manifest so Android's share sheet can
send URLs, text and up to eight bounded images to Memberberry. The service worker stages the
payload in IndexedDB only until the authenticated share screen saves it: images then pass
through the ordinary five-minute media-upload grant, and the resulting note contains their
canonical Markdown references. Shared URLs are fetched and converted server-side; plain text
is inserted as text rather than HTML. iOS gets a Shortcut posting to the same endpoint.

### 16.3 Server endpoint

`POST /api/v1/vaults/<slug>/clip` accepts a URL, supplied HTML, plain text, staged media, or
their useful combinations — also the bookmarklet path where the extension is not installed.
Generated destinations are Markdown filenames and retry atomically on collisions rather than
overwriting. The endpoint requires `editor` on the exact target folder under both the live ACL
and any scoped API token, allows twelve clips per user and vault per minute, and bounds the
whole remote-fetch and image-rehosting operation to twenty seconds. **Server-side URL fetching
is SSRF-sensitive:** resolve and pin every hostname before every request, reject any private,
loopback, link-local or cloud-metadata result, and reapply those checks after each redirect;
also cap redirects and response sizes. This is a security control with a test, not a nicety.

---

## 17. Public sharing (A19)

Read-only links to individual notes for people without an account.

### 17.1 Model

```sql
share_links(token_hash, vault_slug, note_path, include_embeds, password_hash,
            expires_at, created_by, created_at, revoked_at,
            access_count, last_accessed_at)
```

- Token: 128 bits of CSPRNG randomness, URL-safe base64. Not derived from the note id.
- Route: `/s/<token>`. Anonymous, read-only.
- Optional password (argon2id), optional expiry (**default 30 days**; never-expire is
  allowed but warned about at creation).
- Revocable instantly; the owner sees access count and last-access time per link.
- `X-Robots-Tag: noindex` plus a `<meta name="robots">` tag; rate-limited per token and
  per IP.
- **The token never appears in a page body**, only in the URL. Not a style preference: HTTP
  responses are gzipped (§21.7), and compressing a response that mixes a secret with
  attacker-influenced text leaks the secret through its length — BREACH. That is safe today
  for a checkable reason, that no response body in this server contains a secret at all
  (session tokens travel in `Set-Cookie`, API tokens in `Authorization`, both headers, and
  headers are not compressed). A share token rendered into the page it authorizes is the
  first thing that would break it. If one has to be, `crates/mb-server/src/compress.rs` must
  exclude that route.

### 17.2 Rendering — a separate path, deliberately

The public renderer is its **own server-only entry point** in `mb-server::http`. It emits
self-contained HTML and no public JavaScript; the optional password challenge is a native
form. It does **not** use the CRDT sync path, the WebSocket, or the authenticated API.

This costs some duplication and is worth it: the anonymous surface is the highest-risk
part of the system, and giving it its own small, auditable path is far safer than adding
an anonymous branch to code that assumes an authenticated user.

### 17.3 Content rules

- Embeds and transclusions resolve **only if `include_embeds`**, and only to notes the
  **link creator** could read at access time. A share link can never grant more than its
  creator has — checked on every request, so revoking the creator's access also narrows
  the link.
- Media is served through `/s/media/<sha256(token)>/<path>`, never the authenticated media
  route. The digest is a non-secret routing scope; a path-scoped signed HttpOnly cookie carries
  authorization. Each request re-checks the creator's live access and permits only media in the
  exact rendered document graph, including authorized embeds and excluding unreadable embeds.
- Backlinks, graph, tags, tasks and search are **not exposed**. A shared note is a
  document, not a window into the vault.
- Wikilinks to non-shared notes render as plain text, not dead links — consistent with the
  invisibility rule (§6.5).

---

## 18. History and versioning (A7)

**Server keeps 90 days. Clients keep nothing.**

### 18.1 Format

Version history is stored as **compressed Markdown snapshots**, not CRDT state:

```
<vault>/.memberberry/history/<note-id>/<unix-seconds>-<sha256>.md.zst
```

Markdown rather than Y-binary because it serves C2 — `zstd -d` on a dead app yields a
readable note. It also decouples history from CRDT compaction (§7.3), so compaction stays
lossless with respect to history. `history_compression = false` in
`.memberberry/config.toml` stores the same snapshots as plain `.md` files instead.

### 18.2 Policy

- Snapshot on the debounced write path when the content hash differs from the last one.
- Minimum 5 minutes between snapshots of the same note (coalesces bursts).
- Thinning: keep **all** for 24h, **hourly** for 7d, **daily** for 90d, then delete.
- Deleted notes: full history retained for the trash retention window, then purged. The
  default is 30 days; `trash_retention_days` in `.memberberry/config.toml` accepts 1–3,650.
- Snapshots record the acting user, so multi-user history answers "who changed this".

### 18.3 UI

Version list per note with timestamps, author and size delta; word-level diff between any
two versions; restore a version — which is a normal edit through the CRDT, not a file
overwrite, so it syncs correctly and is itself undoable. Access requires the same role as
the note (E10).

---

## 19. Migration and export

### 19.1 `memberberry import-obsidian <vault>`

- Scans the vault, reports what it finds, and **runs dry by default**.
- `--write` performs the reported ID additions. A dry run exits non-zero while IDs are
  missing, and either mode exits non-zero for unresolved links, unsupported constructs, or
  paths that escape the selected vault, so the report is usable as a migration gate.
- Injects frontmatter `id` into files lacking one (the only mutation; reversible).
- Validates every wikilink and reports unresolved ones.
- Maps Obsidian callouts, block IDs, aliases, tags, task emoji metadata and
  `.excalidraw.md` through as-is.
- Reports unsupported constructs (Canvas files, Mermaid blocks, Dataview queries,
  community-plugin syntax) explicitly rather than silently mangling them. Unsupported
  fenced blocks are preserved verbatim as opaque code blocks — never destroyed.

### 19.2 Export (A9)

| Target | Mechanism |
|---|---|
| **Markdown** | The vault already is this. `export --materialize-media --materialize-emoji` makes it fully self-contained (§11.2, §12.3). |
| **PDF** | Client-side browser print with a dedicated print stylesheet — no headless-browser dependency, WYSIWYG-accurate by construction. |
| **HTML (single note)** | Client-side, from the rendered DOM, with inlined CSS and media as data URIs. |
| **HTML (whole vault)** | Server-side static site: a Rust HTML renderer over the block model in `mb-core`, with working links, graph and search. Exports only the invoking user's readable set. |

**Implemented, M18.** The editor toolbar prints only its own note panel, using the browser's
native print destination for PDF, and downloads the current rendered DOM as standalone HTML with
the active stylesheets embedded and every rendered image/PDF fetched through its already-authorized
URL and converted to a data URI. A failed media fetch fails the export rather than producing a file
that only looks self-contained.

`memberberry export --static-site <directory> --slug <vault> --username <user>` builds the whole
site in Rust. The named account must exist and be enabled; the live ACL constructs the
`AuthorizedVault` used for pages, client-side search data, graph nodes/edges and media copies
(E25). The new site replaces the prior output only after it is complete, so a later export under a
tighter ACL cannot retain an old private page. Static pages preserve resolvable wikilinks and
heading/block anchors; unresolved or unreadable targets are inert.

### 19.3 `memberberry doctor`

Integrity checks: broken links, orphaned media, notes missing IDs, duplicate IDs, CRDT
sidecars without files (and vice versa), index drift versus files, oversized history,
`access.toml` referencing unknown users, share links to deleted notes, **unresolved
conflict callouts** (§3.5), and shortcodes referencing missing emoji pack files. Reports;
fixes only with `--fix`. Missing or duplicate IDs, CRDT/index drift, excess history and dead
share links have deterministic repairs. Broken links, ACL users, conflicts and missing emoji
remain report-only. Orphaned media is normally pruned by the running server after its upload
grant window; `doctor` reports it for offline/manual cleanup.

---

## 20. Theming (A16)

**A calm notebook workspace with three easy-to-change palettes: Paper, Charcoal, and Pastel.**

### 20.1 Design-token contract

Themes are **token overrides**, not arbitrary CSS reaching into the DOM.

- A documented, versioned set of CSS custom properties: colour roles (surface, text,
  accent, border, semantic states), typography scale, spacing scale, radii, shadows,
  controls, editor-specific tokens (measure, block gap, presence hues, code theme, callout
  tints, graph node colours).
- A theme is a single CSS file setting those variables:
  `<vault>/.memberberry/themes/<name>.css`.
- Ships with `memberberry-light` (neutral Paper), `memberberry-dark` (neutral Charcoal),
  and `memberberry-pastel` (Catppuccin-inspired lavender dark), plus system following.
- Setting is per vault, with a per-device override.

**Implemented, M7.** The contract is `web/src/shell/tokens.css`, still **version 1**. It is
the only file in the repository permitted to write a colour down.

- `web/src/shell/app.css` and the server-rendered pages in `mb-server` both reference it and
  nothing else. The server pages `include_str!` it rather than holding a second copy of the
  values, so the app and the read-only fallback path cannot drift into two palettes. That
  costs a few KB of inline CSS per page, which is the right trade for pages that must render
  with no network round trips (§17.2).
- The version number tracks **removals and renames** — the changes that break a theme.
  Additions do not bump it.
- Fewer than the ~100 above, because the check in §20.2 refuses a token nothing consumes:
  **a token arrives with the component that needs it, never ahead of it.** `--state-danger`
  arrived with the first thing that renders a refusal (the sign-in page); `--text-lg`,
  `--text-xl` and the two task-marker sizes arrived with the inline task view and the
  editor's heading scale (§10.2); success and conflict tints and callout tints land with M6
  and the features that render them. The count climbs toward ~100 as the UI does, and
  `make token-check` prints it — a figure written here is only as fresh as the last person
  to read it, which is why one is no longer written here.
- **"Graph node colours" turned out to be a categorical series, not a graph token** (M8).
  The graph colours nodes by folder and presence colours carets by user, and both need the
  same thing: a handful of hues with no inherent order, each legible on the note surface and
  distinguishable under the common forms of colour blindness. Two features inventing two
  palettes is how one screen ends up with two of them, so `--series-0`…`--series-5` is
  declared once and `--presence-0`…`--presence-5` alias it. No removal and no rename, so no
  version bump: a theme that re-declares the six presence names still recolours presence and
  nothing else.
- The contract governs the design system, not every length: a one-off `max-width` measure or
  `vh` offset stays in the component. Colour has no such exemption.
- Two token values are also written down in TypeScript, because CSS and JavaScript each own
  part of the behaviour (§7.5 label fade). `web/src/shell/tokens.test.ts` pins them to the
  contract; a structural check cannot notice two files disagreeing about a number.

**Selection implemented, M18.** A vault may set `theme = "system"`,
`"memberberry-light"`, `"memberberry-dark"`, or `"memberberry-pastel"` in `.memberberry/config.toml`; absent and
unknown values fail back to `system`. The server validates that value and places only the
shipped theme name in the escaped editor bootstrap. The Appearance selector stores an optional
override under a vault-scoped local-storage key, so one device can choose differently without
changing the vault for anyone else. Selecting “Vault default” removes that override. An open
WebGL graph refreshes its cached token palette on both selector and operating-system changes.

**Notebook redesign (2026-09-10).** Neutral surfaces replace the green canvas. The shell uses
compact system typography, softly outlined tabs, quieter controls, and a centered writing sheet
with generous interior margins. Opening headings use a separate `--font-title` serif token;
note body and navigation remain sans-serif. Desktop calendar cells fit the sidebar; mobile
controls retain the 44px floor. All colours remain in `tokens.css`, including the server-rendered
fallback. System follows Paper or Charcoal; Pastel is an explicit choice. `docs/THEMES.md`
describes how to add a palette without changing component styles. Common block actions remain
in the toolbar; secondary formatting and export actions live in the keyboard-accessible More
disclosure. History, deleted notes, and share creation use expandable sidebar sections. Mobile
sidebar toggles sit in the header so the writing surface spans the available width.
Automatic loading of
vault-local theme CSS remains unimplemented; the shipped palettes work end to end.

**Shell redesign (2026-09-11).** The workspace grew a top bar and lost the card around the
note; §8.2 records what moved and why. What it cost the contract, still **version 1** —
these are additions, and additions do not bump it:

- `--topbar-height`, the one strip that spans the window. Deliberately equal to
  `--touch-target-min`, so everything in it clears §8.3's floor without a second rule.
- `--icon-size`, for the drawn chrome marks. One size, so a row of them lines up.
- `--surface-accent-soft`, the row a reader is *on* — the open note in the tree. Hover and
  selection previously resolved to the same tint, so the shell had no sense of place. Mixed
  from `--accent-primary` like `--surface-hover`, so a theme that re-declares the accent
  gets both for free and neither needs a dark counterpart.
- `--motion-quick`, one duration for chrome feedback: a hover tint, a chevron turning, a
  drawer arriving. Every use is inside a `prefers-reduced-motion` guard (§20.3) and none of
  them is on the keystroke path (§21.2).

Also: the hairline borders were softened in all three palettes, and `--font-body`/`--font-ui`
name Inter and Segoe UI Variable ahead of the older system faces — local faces only, because
C1 forbids fetching a font from anyone's CDN. **The appearance selector is in the top bar**,
where it is chrome for the window rather than a card inside a panel that can be closed. The
server-rendered pages (§17.2) were restyled against the same contract: one lockup with a
drawn mark instead of an uppercase wordmark, sign-in and onboarding centred on a single card,
and vault rows shaped like the library's note rows.

### 20.2 The DOM is not a public API

Custom CSS tied to internal DOM structure would constrain future refactoring. Memberberry
therefore exposes design tokens for theming: **the token contract is stable and documented; class names and DOM
structure are not.** A theme reaching past tokens may break on any release, and that is
stated up front rather than discovered.

Both statements are testable, and are tested. `scripts/token-check.py` runs in `make check`
and in CI, and fails on any of:

1. **An undeclared token.** A `var(--x)` naming something the contract does not declare.
   CSS resolves an unknown custom property to nothing, so a typo silently removes a colour
   rather than erroring — invisible to every other check in the repository.
2. **An unused token.** A contract token nothing references. This is the direction usually
   skipped, and the one that keeps §20.2's promise honest: a stable public API is not
   something you can promise about a name nothing consumes.
3. **A literal colour anywhere else** (AGENTS.md §4.4) — hex, `rgb()`/`hsl()`/`oklch()`, or
   a named colour. It scans the web tree *and* the Rust tree, because the server-rendered
   pages hold CSS in a string constant where a stylesheet linter would never look.

Each of the three was verified by breaking it and watching the check go red (AGENTS.md
§2.3). Tests and generated files are excluded from the scan on purpose: a token kept alive
only by a test asserting its own existence would satisfy check 2 while nothing shipped
used it.

### 20.3 Accessibility

All three shipped themes meet WCAG AA contrast for body text and UI chrome, verified in CI.
A theme failing contrast is a bug, not a style choice. Respect `prefers-reduced-motion`
throughout, including the graph view.

**Verified, M18.** `web/src/shell/tokens.test.ts` parses the three shipped override blocks and
computes WCAG relative luminance from their actual hex values. Normal text roles are held to
4.5:1 against every shipped surface; focus chrome is held to 3:1; presence labels are held to
4.5:1 against every categorical hue. The light muted-text token was darkened slightly because
the first real check found it at 4.23:1 on the canvas.

---

## 21. Performance budgets (C6, A15)

A15 asks to be *very* efficient and to push a bit further than a comfortable baseline.
Budgets are CI gates measured against a **generated 10k-note vault**
(`memberberry gen-vault`), tracked over time. A regression past budget fails the build.

**UI redesign and onboarding validation, 2026-09-10.** The current working tree measures 767,059 bytes
gzip for initial JS plus optimized WASM, above both the 358,400-byte budget and the
741,471-byte recorded exception ceiling. The bundle gate remains failing; its exception
was not raised. This measurement includes the existing uncommitted M18 work and is not
an isolated attribution to the redesign. No runtime performance claim follows from it.

### 21.1 Reference devices

| Class | Definition |
|---|---|
| **Mobile (primary)** | Mid-range Android, ~2023–24, 6–8GB RAM — Pixel 7a / Galaxy A54 class. **This is the device budgets are written against.** |
| **Desktop** | CI runner spec, fixed and recorded, for regression tracking. |

Mobile is the primary target because it is the constraint. Anything comfortable on a
mid-range Android is effortless on a laptop.

**Measured, M0.** The `mb-wasm` bundle was **464 KB, 176 KB gzipped** — `pulldown-cmark`,
the Unicode general-category tables and the block model. It is the floor for anything the
browser does with Markdown, so it belongs on the critical path budget rather than being
discovered later. `mb-crdt` and `mb-search` will add to it.

**Measured, M7 — and the §21.2 critical-path budget is currently breached.** Not by a little:

| Asset | Raw | Gzip |
|---|---|---|
| `mb_bg.wasm` | 945 KB | **355 KB** |
| `index.js` (Tiptap, Yjs, Svelte, the shell) | 470 KB | **159 KB** |
| **Total JS + WASM** | 1.39 MB | **514.5 KB against a 350 KB budget** |

The gzip total was 505 KB when this section was first written and is 514.5 KB now, measured
by `make perf` rather than by hand. The WASM came down slightly; the JS went up by 14 KB as
the M7 shell landed — the note tree, the palette, bookmarks and the mobile layout. That drift
is the argument for the harness: nobody added 14 KB on purpose, and nothing would have said
so.

Recorded here rather than quietly carried, because a budget nobody checks is a comment
(§21.3). Three things it says:

- **The WASM doubled between M0 and M7**, 176 → 360 KB gzipped, and `mb-crdt`'s `yrs` is the
  obvious suspect — it is the only large dependency added to that crate since. `mb-search`
  is still to come and will add more.
- **Svelte is not the problem.** Adopting it cost ~13 KB gzipped; without it the figure is
  ~492 KB. The framework choice (A1) is not what needs revisiting.
- **`wasm-opt` already runs** at wasm-pack's default `-O`, so this is not a missing build
  step. The untried levers are `opt-level = "s"`/`"z"` for the wasm build (the workspace
  release profile is tuned for speed, which is the wrong trade for a download), `wasm-opt
  -Oz`, and splitting `mb-crdt` out of the initial chunk so the parser can load without the
  CRDT engine behind it.

**Deliberately not fixed in the change that found it.** §21.3 and AGENTS.md §4.5 require
measuring before *and* after. The harness now exists (§21.5) and this is the first thing it
is pointed at; the figure it records is the one the ratchet holds. Guessing at `opt-level`
before that existed would have been exactly the "should be faster" those rules exclude.

**Fixed: the server now compresses.** For M0 through M7 the budget above was stated in gzip
while nothing in the serving path compressed anything, so a real cold load transferred the
**raw** figure. Both numbers were true and they answered different questions — the gzip figure
was what §21.2 budgets and what a deployment behind a compressing proxy would send, and the
raw figure was what this server sent on its own. `crates/mb-server/src/compress.rs` closes the
gap. Measured against a real server over the M7 bundle:

| Critical path, on the wire | Before | After |
|---|---|---|
| `mb_bg.wasm` | 945,129 | 360,381 |
| `index.js` | 519,399 | 164,454 |
| **JS + WASM total** | **1,464,528** | **524,835** |

**64.2% fewer bytes**, and the observed figure now sits just under the 528,249 the static
budget gates on — the two use the same gzip level and different DEFLATE implementations, and
`miniz_oxide` happens to beat `zlib` by 0.9% on the WebAssembly module. The static number
stays the gate because it is deterministic across machines; the harness prints both and the
gap between them (§21.4).

**What it does not fix.** The budget is still breached, by exactly as much as it was: §21.2 is
a gzip budget and 524.8 KB against 350 KB is the same 47% over that `breaches.json` records.
Compression closed the gap between the wire and the budget, not the gap between the budget and
the bundle. The levers listed above are still the ones that matter, and the 355 KB of WASM is
still where the budget is lost.

**How, and what it cost.** The choices are in `compress.rs`; the measurements behind them are
§21.7. Two are worth stating here because they look like defaults and are not:

- **Ninety lines against `tower-http`.** `tower_http::CompressionLayer` does this and more, at
  the cost of `tower-http` and `async-compression` on the public serving path. Its advantage is
  compressing a body as it streams, which buys nothing here: every response this server
  produces is wholly in memory before the middleware sees it. `flate2` and an explicit
  content-type allowlist keep the whole policy readable in one file.
- **Bundle assets are compressed once, not per request.** Gzipping a 945 KB WebAssembly module
  at level 9 costs **31.5 ms** of server CPU, and level 9 is only **783 bytes** better than the
  default level 6 (§21.7). Either of those alone argues for a lower level; together with a
  cache they argue for keeping the smallest body and paying for it once. Vite content-hashes
  every asset filename, so the cache is keyed on a path that changes when the content does — it
  carries a size-and-mtime stamp anyway, because `web_root` is a directory an operator can
  rebuild in place. Warm, the same request is **0.4 ms**, which is faster than serving the
  *uncompressed* file was, because that read 945 KB off disk every time.

**Measured, M8 — the graph row, and it is breached on desktop.** §21.2 asks for 30 fps over a
whole vault, which is a frame every 33.3 ms. The first measurement of that row, taken when
there was a global graph to point it at:

| Graph frame time, p95, camera moving every frame | Nodes | Measured | Budget |
|---|---|---|---|
| Desktop | 10,000 | **58.3 ms** | 33.3 ms |
| Mobile, 4× CPU throttle | 2,000 (§9.4's cap) | **17.4 ms** | 33.3 ms |

**The mobile column is inside budget**, which is what §9.4's honest cap exists for. The
desktop column is not, and it is recorded in `breaches.json` rather than carried quietly.
Three things about it:

- **It is software rasterisation.** Headless Chromium draws WebGL through ANGLE over
  SwiftShader, so every one of those 10,000 points and ~30,000 blended lines is drawn by the
  CPU. The figure is a floor, not an estimate of what a reader with a GPU sees — and closing
  it by tuning shaders would be tuning against a rasteriser nobody runs. Giving the harness a
  real GPU trades a reproducible number for a machine-dependent one, which is a decision
  worth making deliberately rather than in passing.
- **One round of work took it from 91.6 ms to 58.3 ms**, measured before and after as §21.3
  requires. The first version re-uploaded every buffer on every frame; a pan changes three
  uniforms and no geometry at all. Per-node colours and indices now survive a whole settling
  simulation, and the quadtree is rebuilt when the positions move rather than when the camera
  does.
- **It does not include the force layout**, which runs in a worker and has settled before the
  measurement starts. That is the right split: §21.2 budgets the frame rate of the picture,
  not how long it takes to arrange it.

### 21.2 Budgets

| Metric | Mobile | Desktop |
|---|---|---|
| Cold start → interactive, warm SW cache | < 1.5 s | < 0.8 s |
| Cold start → interactive, first ever visit | < 3.0 s | < 2.0 s |
| Open note ≤ 5k words, locally resident | < 150 ms | < 80 ms |
| Keystroke → paint | < 16 ms p95 | < 16 ms p95 |
| INP (Interaction to Next Paint) | < 200 ms p95, target < 100 ms | < 100 ms p95 |
| Longest main-thread task | < 50 ms | < 50 ms |
| Quick-switcher results, 10k notes | < 80 ms | < 50 ms |
| Full-text search, 10k notes, offline index | < 250 ms p95 | < 150 ms p95 |
| Scroll | 60 fps sustained | 60 fps sustained |
| Graph | ≥ 30 fps at 2k nodes (capped, §9.4) | ≥ 30 fps at 10k nodes |

**The graph row is measured as a frame *time*** — 30 fps is a frame every 33.3 ms — because
every other number in §21.2 is one where lower is better, and a harness with two comparison
directions has a branch that can be wrong about which way a budget runs. What it measures is
the p95 interval between frames while the camera moves on every one of them: an idle canvas
paints nothing and would report a perfect 16 ms whatever the renderer cost. It does **not**
include the force layout, which has settled before the measurement starts and runs in a
worker — §21.2 budgets the frame rate of the picture, not how long it takes to arrange it.
| Initial JS + WASM, gzip (excl. lazy Excalidraw) | **< 350 KB** | same |
| Client search index, 10k notes | < 10 MB typical, **< 15 MB hard ceiling** | same |
| Peak memory, 10k-note vault, index loaded | < 250 MB | < 400 MB |
| Server memory, idle, 10k notes | — | < 150 MB |
| Full reindex, 10k notes | — | < 30 s |

Notes ≥ 20k words must remain editable: the editor virtualizes block rendering above a
threshold. Virtualization must not break find-in-page, outline scroll, or transclusion.

### 21.3 Standing rules

- Anything on the keystroke path is sacred: no allocation in a loop, no synchronous layout
  thrash, no full document re-render on a single-block change.
- Long work belongs in a Web Worker. The main thread paints.
- A new dependency on the critical bundle path needs justification in the change description.
- Awareness/presence traffic is throttled to ~50ms per client and rendered as decorations
  only (§7.5). Presence must never cost a document re-render, and a room with 5 participants
  must not measurably move the keystroke-to-paint budget.
- Measure before and after. "Should be faster" is not a result.

### 21.4 The harness (M7)

`web/perf/`, run by `make perf`. The last open M0 box, and the thing that makes every number
in §21.1 and in the table below a measurement rather than an assertion.

**What it measures against.** A **generated 10 000-note vault** (`memberberry gen-vault`, 39 MB,
cached under `target/perf/vault` between runs because it is deterministic by construction), a
throwaway data directory, and the real `memberberry serve` binary on port 9013. The browser
loads the production Vite bundle, signs in through the real form, and every timing is taken
**inside the page** from `performance.now()` — a number that included the CDP round trip would
be measuring the harness.

Cold-start and note-switch timings require a visible, editable surface, not merely an
editor node or matching text in the DOM. Body-download and editor-loading visibility gates
remain part of the measured wait; completing either gate through an attribute change must
wake the measurement observer.

**Both device classes.** `desktop` at 1280×800 unthrottled, and `mobile` at 412×915 with a
touch pointer, a 2.625 device pixel ratio and the CPU throttled 4× through CDP.

**Violations are not breaches.** Alongside the ratchet the run carries a short list of
properties that fail it outright, with no number to record them at. The first is compression:
if the browser receives the critical path uncompressed, every bundle figure in the report
describes a download nobody performs, so the run fails rather than printing a note about it.
That distinction exists because it *was* a note, for two milestones (§21.1).

**The gate is a ratchet.** §21.3 says a budget nobody checks is a comment, and §21.1 records a
budget that is currently breached by 47% — so a gate that simply failed on any breach could
not be switched on at all. Instead every breach is *enumerated* in `web/perf/breaches.json`
with the value it was recorded at and the reason it is being carried, and the run fails when a
breach is **new** or when a known one gets **worse**. Fixing a breach means deleting its entry.
The tolerance is 0% for a byte count and 20% for a duration, because a gzip size is
deterministic and a timing sample is not; a 0% ratchet on a timing metric is a coin flip
dressed as a gate. The parser for that file fails closed — a typo, a missing reason or an
unknown device name throws rather than being skipped, because the failure mode of a forgiving
parser here is a gate that silently stops gating.

**In CI, in two halves.** The bundle budget is enforced: the same build gzips to the same byte
count anywhere, so it needs no baseline for the runner it lands on. The browser half runs
`--report-only` and uploads its report as an artefact. §21.1 defines the desktop class as "CI
runner spec, fixed and recorded" and nobody has recorded it; enforcing an absolute millisecond
budget on a shared runner before that would produce a flaky gate, which AGENTS.md §2.3 counts
as a failing one. Running it unenforced is still what keeps the harness itself from rotting.

#### What the numbers do not say

Written down because each one is a way to over-read a figure this harness prints.

- **"Mobile" is not a phone.** §21.1 writes the budgets against a Pixel 7a; this is Chromium
  on a developer's or a runner's machine with a 4× CPU throttle. 4× is Lighthouse's mobile
  default and a convention, not a calibration — nobody here has measured a Pixel 7a to derive
  it (`MB_PERF_CPU_THROTTLE` overrides it for anyone who has). It catches work that is cheap at
  1× and expensive at 4×, which a laptop-only measurement cannot, and it says nothing about
  the phone's GPU, memory pressure, thermal behaviour or browser version. Every mobile number
  is printed with the factor beside it.
- **Keystroke → paint reads about one frame high.** It is a double-`requestAnimationFrame`
  measurement from the `keydown`, so it includes the wait for the next vsync boundary and
  cannot separate "comfortably made the next frame" from "took a whole frame of work". Event
  Timing would give the processing duration directly, but Chromium rounds those entries to 8 ms
  — useless granularity against a 16 ms budget. What this figure reliably detects is the
  failure the budget exists to catch: a keystroke costing two or three frames instead of one.
- **INP is Event Timing**, so it is quantised to 8 ms. Fine against 100–200 ms.
- **"Open note" is a ~120-word note.** §21.2 bounds that row at 5k words, so the figure is
  comfortably inside the bound and is not the worst case the budget allows. It is measured as a
  **tab switch**, because no page load completes in 80 ms on any device and switching to a note
  the session already holds is the only reading of that budget that can be true.
- **Server memory is resident set size after the whole run**, read from `ps`, not before it.
  The stricter of the two readings of "idle", and the one that includes the title cache warmed
  by a 10 000-note index request.
- **A budget nothing measured is a hole, not a pass.** The report prints those separately from
  the metrics that are not measurable yet, and each of the latter names the milestone that
  unblocks it: full-text search and client index size (M9), peak memory (M9 — the budget is
  written for a loaded index, and reporting the JS heap under that row would look the same
  way), and sustained scroll frame rate, which needs a frame timeline rather than a mark and
  is named rather than faked. **The graph row left this list in M8**, when there was a global
  graph to point it at, and **the warm-cache cold start left it in M6**, when there was a
  service worker to warm one.

#### Measured, M6 — the warm-cache cold start

The row §21.2 pairs with the first-visit one, measurable for the first time now that there is
a service worker to warm a cache (§7.4). One browser context across the samples and a fresh
page for each: the worker, the HTTP cache and the IndexedDB replica are all warm, which is
what a returning visit is, and the note's own HTML is still fetched because a navigation is
network-first.

| Metric | Desktop | Budget | Mobile (4×) | Budget |
|---|---|---|---|---|
| Cold start → interactive, **warm SW cache** | **119 ms** | < 800 ms | **264 ms** | < 1 500 ms |
| Cold start → interactive, first visit *(same run)* | 210 ms | < 2 000 ms | 507 ms | < 3 000 ms |

Both are inside budget with an order of magnitude to spare, and the warm figure is about half
the cold one on either device — which is the shape to expect when the saving is the download
and not the work: the WASM module still has to be instantiated and the editor still has to
mount, and §21.1 says that is where the mobile long task lives.

**The harness drops these samples entirely if no worker takes control of the page**, rather
than reporting them. A page measured before the worker claimed it is measuring the network,
and a number like that is worse than a hole: the report would show a budget met by a feature
that was not running.

#### Measured, M7

One run of `make perf` on an Apple Silicon laptop, so the desktop column is a *shape* rather
than the "CI runner spec, fixed and recorded" §21.1 asks for, and the mobile column is that
laptop at a 4× CPU throttle rather than a phone. Cold start in particular varies by tens of
percent between runs — the figure below and 369 ms came out of consecutive runs — so treat a
single number as an order of magnitude, and the ratchet in `breaches.json` as the thing that
actually notices a change. Read the subsection above before quoting any of these.

| Metric | Desktop | Budget | Mobile (4×) | Budget |
|---|---|---|---|---|
| Cold start → interactive, first visit | 213 ms | < 2 000 ms | 222 ms | < 3 000 ms |
| Open note, locally resident | 16.0 ms | < 80 ms | 17.0 ms | < 150 ms |
| Keystroke → paint, p95 | **16.3 ms** | < 16 ms | **17.1 ms** | < 16 ms |
| INP, p95 | 32 ms | < 100 ms | 40 ms | < 200 ms |
| Longest main-thread task | none over 50 ms | < 50 ms | **60 ms** | < 50 ms |
| Quick-switcher re-rank, 10k notes | 9.7 ms | < 50 ms | *not measured* | < 80 ms |
| Initial JS + WASM, gzip | **515.9 KB** | < 350 KB | **515.9 KB** | < 350 KB |
| Server memory, idle, 10k notes | 25.8 MB | < 150 MB | — | — |

Three of those are over budget, and all three are recorded in `breaches.json` with a reason:

- **The bundle**, by 47%. §21.1 has the detail and the order to attack it in. It rose by
  1,399 bytes after M7 for §10.2's inline task view — measured, recorded, and small beside the
  355 KB of WASM that is where the budget is actually lost. Compression has since landed and
  did **not** move this row: it is a gzip budget, and what changed is that the server now
  sends gzip (§21.1). The wire figure went from 1.39 MB to 524.8 KB; the budget is still
  350 KB. M8 has since added 7,448 bytes across the backlinks panel, transclusion and the tag
  pane; the per-change ledger is `breaches.json`, which is where the ratchet lives, and each
  entry says what the bytes bought.
- **Keystroke → paint**, by a few tenths of a millisecond, which is a limit of the measurement
  rather than a regression: 16.4 ms *is* one 60 Hz frame, so this is "the keystroke made the
  next frame" rounded up to the frame it made. Removing that entry needs a sub-frame
  technique, not a faster keystroke.
- **The longest main-thread task on mobile**, 60–65 ms against 50 ms, and this one is real. It
  is in bootstrap — instantiating a 945 KB WASM module and mounting the editor — so it shares
  a root cause with the bundle breach and should be re-measured after that is addressed.
  Desktop records **no** long task at all and is deliberately not in `breaches.json`, so a
  desktop regression still fails the build. (The Long Tasks API only surfaces a task once it
  exceeds 50 ms, which is also this budget, so "none" means nothing crossed the line — not
  that no work happened.)

The rest have comfortable headroom, and two are worth saying out loud: a cold start is an
order of magnitude inside its budget even throttled, and the quick switcher ranks 10 000 notes
in under 10 ms — the title cache in `mb-server/src/titles.rs` and client-side ranking together
cost about a fifth of the budget.

**The mobile quick switcher is a hole, not a pass.** Only one of its twelve samples survived,
below the three the harness insists on before it will report a median, so it drops the metric
and prints it as unmeasured. §21.5 has the reason. Re-measured on M6's run: **zero** of twelve
survived — the same failure rather than a new one, and the same known cause, which is that
under a 4× throttle the rendered list transiently disagrees with its input.

**Measured, final M6 continuation.** The same full harness completed after the conflict badge
and its browser-discovered dialog-race fix. The checked-in source at the preceding commit,
rebuilt with the current WASM toolchain, measured **560,627 bytes gzip**; the completed change
measures **560,977 bytes gzip**, a **350-byte** increase for the catalog/tree conflict count,
conditional badge and dialog state marker. `breaches.json` records both the toolchain rebase
from its previous 549,268-byte absolute and this measured feature delta. The run again dropped
mobile quick-switcher (zero surviving samples), while all other non-recorded metrics stayed
inside budget; desktop graph, keystroke paint and mobile longest-task remain the explicitly
recorded breaches described above.

### 21.5 What building the harness found

None of these are performance numbers. They are things nothing had looked at, which is what a
new instrument is for.

- **The server compressed nothing.** The budget was in gzip; the server sent raw. Fixed —
  §21.1 has the before-and-after and §21.7 has what it cost. Worth keeping on this list as the
  clearest thing the instrument found: it was a 64% saving on the single largest download the
  application performs, sitting in plain sight behind a budget that had been written in the
  units of a proxy nobody had deployed.
- **The critical-path bundle had drifted 9.5 KB** since §21.1 was written by hand, all of it JS
  from the M7 shell.
- **A `Mod+O` pressed while the main thread is still saturated from a burst of typing is
  dropped.** The shell never sees it and a second press works. The harness now waits for
  `requestIdleCallback` before each scenario, which is correct regardless — a scenario that
  starts mid-way through the previous one measures the wrong thing — but whether a shortcut
  should survive a busy main thread is a real §8.4 question and is not answered here.
- **The quick switcher keeps its last query when reopened**, so a second visit starts with the
  previous search in the box. §8.4 does not say which behaviour it wants.
- **Under a 4× CPU throttle the switcher's rendered list transiently disagrees with its
  input** — it goes on showing the previous query's results after the input has changed. The
  scenario is therefore reliable on desktop and not on the throttled profile, so §21.4 records
  a desktop figure and a hole for mobile rather than a number nobody should trust.
- **Its own input is a controlled Svelte input** (`value={query}` with `oninput`, not
  `bind:value`), so a programmatic `fill` reads back correctly and is then reverted. That is
  worth knowing before writing any test that sets a query without typing it.

### 21.6 Measured: the server sync path (M5)

`make bench` (criterion, `crates/mb-server/benches/sync.rs`). Laptop numbers on an APFS
SSD — the budget target is still a mid-range phone (§21.1), so these establish *shape*, not
compliance. Recorded because the next person to touch this path should not have to
rediscover where the time goes.

| Path | 10 blocks | 2 000 blocks |
|---|---|---|
| Accept one update (validate → persist → apply) | 3.8 ms | 6.6 ms |
| Materialize to Markdown (the 800 ms debounce) | 16 ms | 22 ms |
| Frame one broadcast (binary) | 28 ns | 3.2 µs |
| Frame one broadcast (the JSON encoding this replaced) | 5.7 µs | 1.13 ms |

Two things this says out loud:

- **Accepting an update is dominated by `fsync`, not by CRDT work.** `Sidecar::append`
  calls `sync_data` per accepted update, which is the 3.8 ms floor; the growth to 6.6 ms is
  the whole-document round-trip `apply_remote_update` performs to validate a few bytes. That
  floor is the price of §3.3's promise that an update is durable when it is *accepted*
  rather than when the debounce fires, and it caps one note at roughly 250 accepted
  updates/second. It is a deliberate trade, not an oversight — batching or group-committing
  the sidecar would raise the ceiling at the cost of that guarantee, and would need to be
  decided rather than slipped in.
- **The wire format was worth changing.** Binary framing is 200-350× cheaper than encoding
  update bytes as a JSON number array, and unlike JSON it does not grow super-linearly with
  payload size. The comparison arm stays in the benchmark so a regression to JSON shows up
  as a number rather than an argument.

The UI-vault-creation follow-up adds `sync/vault_lookup` to the server benchmark: the live
registry holds its read lock only long enough to clone a shared handle. On the development
host, 10 one-second Criterion samples measured 24–34 ns for the previous immutable-map
lookup and 22–24 ns for the live lookup. These noisy host measurements are not a claimed
speedup or an Android performance result; the comparison remains in the harness.

### 21.7 Measured: response compression (M7 follow-up)

Level and cost for `mb_bg.wasm`, 945,129 bytes raw. Best of five per level, `flate2` with the
`miniz_oxide` backend, same laptop as §21.6's sync figures.

| gzip level | Bytes | Time |
|---|---|---|
| 1 | 440,959 | 3.9 ms |
| 4 | 368,510 | 9.0 ms |
| 6 (`flate2` default) | 361,164 | 21.4 ms |
| 9 (what is served) | 360,381 | 31.5 ms |

**Level 9 buys 783 bytes over level 6 for 47% more CPU.** Read on its own that is an argument
for the default, and it is why this table exists rather than a sentence asserting that the
smallest body is obviously right. What changes the answer is that these are *immutable*
content-hashed assets: compressed once and cached, the 31.5 ms is paid once per build rather
than once per visitor, and the smallest available body then costs nothing to prefer. Measured
end to end against a real server: **32.7 ms** for the first request for the WebAssembly module
and **0.4 ms** for every one after it — against **0.6 ms** for the uncompressed file, which
re-read 945 KB off disk on every request. The cache holds 530 KB for the whole M7 bundle, and
server RSS after serving all of it is 12.6 MB against the 150 MB of §21.2.

Server-side compression has no budget in §21.2, and deliberately does not get one from this:
the numbers are recorded so the next person changing the level or dropping the cache can see
what they are trading, not to make 31.5 ms a threshold. What *is* gated is that compression
happens at all — §21.4 fails the run if the browser receives the critical path uncompressed.

**Brotli is the obvious next step and is not taken here.** It would shave a further ~15% off
the WebAssembly module. It is left out so this change had one variable: §21.2 is written in
gzip, so gzip is what makes the served figure comparable to the budgeted one. Adding it means
a second cached representation and a second entry in the `Accept-Encoding` negotiation, both
of which the current shape accommodates.

### 21.8 Measured: building the index (M8)

Laptop numbers over the generated 10 000-note vault (`make gen-vault`, 39 MB), release build.
§21.2 has no budget for this — it is server work, not a frame the user waits on — so these are
recorded to establish shape and to make a regression visible.

| Operation | Time |
|---|---|
| Full build, no index present (parse and index 10 000 notes) | **955 ms** at startup, 2.4 s with a cold page cache |
| Full build, SQLite + Tantivy block index (M9) | **1.47 s** with a warm page cache |
| The same thing, **debug build** | **5.5 s** |
| Settled sweep (stat 10 000 notes, read none) | **39 ms** |
| Database size | 11–12 MB, against 39 MB of Markdown |
| Tantivy size (M9) | **6.1 MB**, beside the 11 MB SQLite index |
| Compact client segment, 10k × 500-word representative notes (M9) | **9,372,124 bytes**, under §14.2's 15 MB hard ceiling |

§21.2's "Full reindex, 10k notes" budget is < 30 s, so both builds are inside it. The harness
measures this row as of M8 — it used to be listed as unmeasurable — and **reports which build
profile it timed**, because `make perf` builds the debug binary and the harness runs the
newest one it finds. A figure that silently moves by 5.8× depending on which build is newer is
a figure nobody can compare across runs.

Three things worth knowing before changing any of it:

- **The server builds the index before it serves its first request**, and prints how long it
  took. The alternative — building it on the first maintenance tick — makes an empty
  backlinks panel mean two different things for the first second of a process's life, and
  "no backlinks yet" is indistinguishable from "no backlinks" to a reader *and* to a test.
  A second of startup an operator can see beats a window nobody can.
- **The settled sweep is why it runs every 60 s rather than at sync cadence.** 39 ms is
  cheap once a minute and absurd ten times a second, and the watcher already covers every
  change it can see within one tick (§3.4).
- **The stamp is what keeps the sweep at 39 ms.** It reads no note whose length and
  modification time are unchanged. When one *has* changed, the content hash decides whether
  any row is rewritten, so a `touch` costs a parse and no write, and a coarse filesystem
  clock costs a parse rather than a wrong answer.

---

## 22. Testing strategy

Correctness lives in a handful of places; each gets aggressive, dedicated testing.
`AGENTS.md` defines the coverage floor and definition of done.

### 22.1 Round-trip property tests (`mb-core`) — the foundation

Using `proptest`:
- `parse(serialize(doc)) == doc` for arbitrary generated block documents.
- `serialize(parse(md)) == md` for arbitrary *canonical* Markdown.
- `serialize(parse(x))` is idempotent for arbitrary Markdown (normalisation converges in
  one pass).
- Task metadata round-trips including marker order, partial fields and unknown markers.
- A corpus of real Markdown — including a copy of the actual Obsidian vault — round-trips
  without content loss: text characters, link targets, tag set, task fields and block
  structure preserved.
- Fuzzing (`cargo-fuzz`) on the parser: never panic, never infinite-loop, on any input.
  Built in M1 as `fuzz/fuzz_targets/{parse,normalize}.rs`; `make fuzz` runs them and
  `fuzz/seeds/` is a committed corpus of what it has already found.

> **Open, and not ours to fix: `pulldown-cmark` 0.13.4 panics.** `into_offset_iter` panics
> at `parse.rs:2199` on a bullet list item holding a link reference definition followed by a
> whitespace-only line of six spaces or two tabs — `"- [8]:q\n      "` — with no extensions
> enabled. 0.13.4 is the current release, so there is no version to move to.
>
> This breaks the totality promise above, and `mb-core` runs in the browser on the keystroke
> path, so it is a crashed editor with unsaved work. It needs an upstream report.
>
> Sanitising the input before parsing was tried and **rejected**: blanking whitespace-only
> lines avoids every known trigger, but a fence opened on a list-marker line — `` - - ``` ``
> — is not reliably detectable without reimplementing CommonMark block structure, and
> getting it wrong discards the whitespace inside a user's code block. Trading content loss
> for a crash fix is the wrong direction under C2. `parse_of_serialize_is_identity` caught
> the attempt within one run.

> **Closed: inline maths is now tokenised from source.** `parse::math` masks every `$…$`
> before `pulldown-cmark` parses the inlines, so a body is never reinterpreted. Where the
> code and the table rows are comes from `pulldown-cmark` itself — the source is parsed
> twice — because two earlier attempts proved that deciding it from raw lines cannot work
> (a fence may open inside a list item, run to any length, and carry an info string) and
> that leaving the old output-scanner in place as a fallback cannot work either (the two
> disagree about `$|$`, so the file changes on every save). The old scanner is deleted;
> masking is the only rule.
>
> The result is checked rather than trusted: a placeholder that reaches the model went
> somewhere the inline scanner never looks, so that span is dropped and the parse repeated.
> Each round removes a span, so it terminates.
>
> What this bought, beyond convergence: `$a*b$`, `$\alpha[i]$`, `$a<b$`, `$x~y$`, `$_a_$`
> and `$P(A|B)$` are maths for the first time. The old rule refused every body containing
> `` ` * ~ < [ ] ``. Only the backtick is still refused, and now for a reason that can be
> stated: a body is written back verbatim — escaping would change the maths, `\_` being a
> literal underscore to LaTeX — and CommonMark parses code spans before backslash escapes,
> so a raw backtick from a body can pair with a later one.
>
> **Display `$$…$$` is still on the old path**, recognised at the paragraph level. Extending
> the masker to it is the remaining piece; `math_content_that_looks_like_a_block_construct_is_preserved_but_not_recognised`
> pins what that still costs.

> **Open, and ours: a literal `_` before emphasis in a table cell.** Found by the property
> suite. A cell holding `Text("_")` then a `Tag` then an `Emphasis` renders as `_#a-_a_`,
> where the leading literal underscore pairs with the emphasis's own delimiter and the whole
> thing reads back as one emphasis wrapping a tag. The escaper decided the literal `_` was
> safe because, at the moment it looked, the emphasis had not yet chosen `_` as its
> delimiter. Not math-related; same family as the case below.

> **Open, and ours: continuation lines that re-read as a table.** `normalize` needs two passes on
>
> ```text
> - a | b |
> | :-- | --: |
> | 0 | 2 |
> ```
>
> The three lines are one paragraph inside the list item, because the first sits on the
> marker line where GFM will not start a table. Serialising indents the continuation lines
> to line up under it — and *then* they are a table, so the second pass reads a table where
> the first read a paragraph. No content is lost and it settles after two passes, but §4.5
> promises one.
>
> The blockquote form is the same defect: `> |a | b |` followed by unprefixed delimiter and
> body rows is one lazy-continuation paragraph, and prefixing every line with `> ` on the
> way out makes it a table. Found by `make fuzz TARGET=normalize`. Whatever fixes one
> fixes both — the trigger is a paragraph whose continuation lines become a table once the
> serializer lines them up.
>
> The fix is to escape a continuation line that looks like a delimiter row, in
> `serialize::escape`. Left for its own change rather than folded into the fuzzing work:
> that module is the most delicate in the crate and every other escaping rule round-trips.

### 22.2 Cross-language schema conformance

Shared fixtures of `(ProseMirror + frontmatter JSON, Y.XmlFragment binary, canonical
Markdown)` triples. Rust and TypeScript each load the binary and assert that it materializes
the same JSON structure and Markdown; each also produces a Y state from the JSON/document
and asserts the same semantic structure. CI fails on drift. Lib0 updates are deliberately
not compared byte-for-byte: embedded object key order is semantically irrelevant and is not
canonical across Rust `HashMap` and JavaScript object encoders. Adding a block type requires
adding a fixture — enforced by a test comparing schema node and mark types against fixture
coverage.

**Built through M3:** `mb-core/tests/schema.rs` pins `schema.json` against
`mb_core::schema`. `mb-crdt/fixtures/conformance` contains the versioned JSON / lib0 v1 /
Markdown triple, and the Rust suite enforces semantic round-trip plus complete node and mark
coverage. `web/src/editor/schema.test.ts` validates the generated Tiptap schema and runs the
TypeScript producer/consumer assertions against these same files.

### 22.3 Sync convergence

Simulated multi-client tests: N clients, seeded-random edit sequences, random partitions
and reconnections. Assert all replicas converge to identical state **and identical
serialized Markdown**. The external-file-edit path participates as an additional client.
Seeds are recorded so failures reproduce exactly.

### 22.4 Invariant I1

Build a vault, edit it, `rm -rf .memberberry/`, restart, assert notes, links, tags, tasks,
graph, search **and permissions** are intact.

**M6:** `mb-server/tests/recovery.rs` exercises a remote edit through the coordinator,
flushes it to Markdown, drops the original vault, coordinator and index handles, and deletes
the entire derived directory. Fresh instances must reproduce the source, extracted task
metadata, backlinks, tags and graph. A fresh CRDT must materialize the same note and accept
another edit. The permission cases retain a folder denial, keep an outsider invisible to all
read surfaces, and deny every read when `access.toml` is missing.

`i1_http_restart_rebuilds_readable_content_without_reviving_denied_notes` in
`mb-server/tests/http.rs` also stops and waits for the HTTP server's runtime before deleting
the derived directory. A fresh server must return the same note, catalog, backlinks, tags and
graphs; unreadable and absent targets must still be indistinguishable. Its caller is the
server admin with only viewer access and a folder denial, so rebuilding cannot turn server
administration into content access. These are storage and wire tests, not evidence of browser
rendering. Search recovery waits for M9's search index; task query recovery waits for the
task reader. M6 verifies their durable Markdown inputs, not APIs that do not exist yet.

**M8:** `mb-server/tests/indexing.rs` covers the index's half — deliberately across two
`IndexRegistry` instances, because an open SQLite connection keeps working from a deleted
inode and a test that reused the first registry would prove nothing. It also asserts the
things next to it that are easy to get wrong: `access.toml` survives (it is not derived
state), a database that will not open or carries a foreign schema version is replaced rather
than fatal, and a vault whose `.memberberry/` cannot be created degrades to an in-memory
index rather than to a vault with no graph.

### 22.5 Permission tests — the leak suite

Because §6.4 enumerates seventeen enforcement points, there is a dedicated suite that walks
them systematically. It is the suite most likely to catch a real security bug.

- A **matrix test** over `(role × surface × operation)` asserting every combination either
  succeeds or returns exactly the right denial.
- `effective_role` property tests: `none` is absorbing, specificity is monotone, resolution
  is order-independent, and malformed `access.toml` fails closed rather than open.
- **Invisibility assertions** (§6.5): for a note the user cannot read, assert its title
  appears in *no* response body — graph, backlinks, search, quick switcher, tag counts,
  task views, transclusion placeholders, error messages. **M8** adds the backlinks case at
  two levels: the query layer in `mb-index/tests/permissions.rs`, and a real vault with a
  real `access.toml` in the leak suite, so a filter that is right in `mb-index` and wrongly
  wired into the server still fails.
- **Client search segments** (E6, **M9**): every indexed note occurs in exactly its deepest
  zone, and assembling a reader's permitted segments contains every readable note while the
  denied note's title and body bytes are absent from the payload itself. The ACL replacement
  test starts from an epoch where the note is readable, revokes it, and proves the replacement
  snapshot no longer contains it; stale zone files are removed rather than left publishable.
  The HTTP manifest and binary routes repeat the reader's live epoch check, while browser
  tests prove revoked bytes leave IndexedDB before a replacement segment is requested and a
  manifest-to-binary authorization race clears the local segment set.
- **Transclusion** (E7, **M8**): a reference resolves only among the notes the caller may
  read, so a nearer unreadable note does not shadow a readable one and a reference naming
  only an unreadable note answers as one naming nothing does. At the query layer in
  `mb-index/tests/resolve.rs` and the leak suite; at the route in `mb-server/tests/http.rs`,
  where the two denials are asserted to be byte-identical.
- **Nothing outside the vault reaches the index** (**M8**): the containment boundary is
  `Vault::resolve`, which always refused a symlink pointing out of the vault — but the index
  is built from `Vault::notes`, which *listed* one. The title and the block text of a file
  the note route will not serve were reaching the index and coming back out as a backlink
  row's context. `Vault::notes` now applies the same rule, paying the extra `canonicalize`
  only for an entry that is actually a symlink, and both the listing and the query surface
  are asserted. Found while building transclusion, where the same listing decides what an
  `![[…]]` can name.
- **Tag counts** (E16, **M8**): the disclosure is arithmetic rather than a name, so the
  assertion is on the numbers — a tag only an unreadable note carries has no row, and one
  shared with two unreadable notes counts one. Asking for the private tag by name answers as
  asking for a tag nobody ever wrote does.
- **Privileged rename** (E14, **M8**): the seam is between doing the work and admitting to
  it, so three claims are asserted separately, and each fails on its own. A note the actor
  cannot read *is* repointed, because §6.6 says a broken link is worse. The reply counts
  only notes they can read — the same arithmetic disclosure as E16. And a note they cannot
  read cannot be renamed, with the refusal identical to the one a note that was never
  written gets, so a rename is not an oracle for which notes exist. At the route in
  `mb-server/tests/http.rs`, where four probes that differ in every way an attacker cares
  about are asserted byte-identical.
- **Media leak test** (E11): a blob referenced only by an unreadable note is not fetchable
  by hash.
- **WebSocket frame authorization** (E3): a viewer's update frame is rejected, and the
  server state is unchanged afterwards.
- **Revocation:** after an ACL change, a connected client stops receiving updates and drops
  the affected zone segments.
- **Workspace layouts** (E15): one member cannot read another's layout, including from the
  same device id; a device id cannot name a path; and an unknown vault, a non-member, a
  malformed device id and "nothing saved" are one indistinguishable reply.
- **Custom emoji packs** (E22): a readable vault receives the local-over-shared manifest and
  image bytes, while a non-member receives the same denial for the list and asset routes.
- **Web clipper** (E23): a viewer, an owner constrained by a viewer-scoped token, and a write
  outside the actor's folder grant are denied before outbound work. DNS resolution and every
  redirect are independently checked and pinned against private-address SSRF.
- **Share links** (E13, §17): expired, revoked, wrong-password, and creator-lost-access cases
  all deny; embeds never escalate beyond the creator's own access. The domain leak suite pins
  bearer-state opacity and ACL monotonicity, while real-router regressions pin neutral responses,
  live ACL revocation, private-embed omission, token-free HTML, and rendered-graph media scope.
- **SSRF** (§16.3): the clip endpoint refuses loopback, private ranges, link-local and
  cloud metadata addresses, including via redirect.

**Adding an enforcement point without adding its test is not done** (`AGENTS.md` §1).

### 22.6 End-to-end in a real browser (M7)

**Local feedback cadence (2026-09-14).** During development, automatically run the relevant
test suites for affected behavior and a relevant browser spec for visual changes; these
checks do not need a separate user request. Full `make check` and local coverage
measurement run only on explicit user request; neither is a prerequisite for committing,
and a commit request alone does not trigger them. Report them as deferred when not run. The user owns
full `make e2e` runs manually; a commit request does not trigger an assistant-run full browser
suite. The assistant runs it only when explicitly asked to do so and reports pending manual
validation and known failures honestly. Coverage requirements remain unchanged.
`AGENTS.md` §5.2 defines the workflow.

**CI cadence (2026-09-15).** E2E is excluded from automatic push and pull-request runs by
user decision. The separate `.github/workflows/e2e.yml` workflow, **E2E (manual)**, is started
with `workflow_dispatch` and runs the full desktop/mobile suite with the same build setup,
zero retries and retained failure diagnostics. Check, web, perf and fuzz-build remain
automatic. A green automatic CI run is not evidence that full E2E passed; known browser
crashes remain open even when the manual workflow has not been run.

`make full-test` is the explicit combined validation command: build WASM, run `make check`,
then run `make e2e`, sequentially and stopping at the first failure. WASM setup precedes
frontend checks on fresh checkouts. Soak, fuzzing and performance runs remain separate.
Because this command includes full E2E, it follows the same manual/explicit-run policy.
Local `make e2e` downloads the matching Playwright Chromium but does not install OS packages.
Native browser dependencies are a separate machine-setup prerequisite; Ubuntu CI provisions
them explicitly. Arch users provision native libraries through their own package manager.

Local Rust coverage preserves compiled binaries only after a successful run with identical
local package files, Cargo configuration, tool versions, environment and invocation options.
Each invocation executes the tests again with fresh profiles; changed inputs or a failed run
force workspace coverage cleanup, preventing removed or renamed tests from contaminating the
report. Coverage builds use an isolated directory and collection is serialized. The coverage
gate exports per-file summary JSON and enforces the same per-crate floors. Ordinary Rust tests
and doctests remain part of `make check`.

`web/e2e/`, Playwright, run by `make e2e` and by its own CI job. **This is the only thing in
the repository that can say a user-visible change works**, and the reason is specific: M5
shipped a bundle where every asset 404'd and a login form its own CSP blocked. Both passed
the unit suite and a `curl` smoke test, because `curl` parses no HTML, runs no JavaScript and
enforces no CSP. Both took one browser load to find. The user will not open the application
until the final milestone, so nothing else is looking.

**Two projects**, matching the §8 layouts: `desktop` at 1280×800 and `mobile` at 412×915
with touch, Pixel-7a class — the device §21.1 writes the budgets against. Tablet
(768–1024px) gets a project when §8.3's one-split rule has something to assert.

**A real server, not a dev server.** `e2e/serve.ts` provisions a throwaway data directory,
admin, vault, notes and `access.toml`, then runs the actual binary. Registration goes
through the real CLI, and `access.toml` is written explicitly — deny by default means an
unprovisioned server correctly shows nothing, and a suite that skipped it would look like it
tested a full server while testing an empty one. `e2e/environment.ts` holds the constants
separately, because a module that spawns a server on import spawns one per test worker.

**Every test fails on a browser problem it did not declare.** The `failures` fixture is
automatic: any console error, uncaught exception, failed request or response ≥ 400 fails the
test, whether or not anyone thought to assert on it. That is the generalised form of both M5
bugs, and it found a real one on its first run — the awareness rewrite in `sync.ts`
destructured `y-protocols`' `null` state for a departed client, throwing out of the socket
handler on every editor load. A unit suite with 31 passing tests never saw it.

**Verified failable** (`AGENTS.md` §2.3), by reintroducing each bug and watching it go red:
hiding `dist/assets` fails all three editor tests with the 404s named, and restoring
`form-action 'none'` on the sign-in page fails with the browser's own CSP message — on the
first attempt *and* on the refusal page, which is a second page carrying the same form.

**It also asserts the encoding the bundle arrives in**, because §21.2's budget is written in
gzip and the server sent raw for two milestones (§21.1). The check reads `Content-Encoding`
off a real page load rather than off a request the test constructs: what matters is what a
browser's own `Accept-Encoding` gets back, and no hand-written header stands in for that.
Verified failable by making the server refuse every offered encoding.

The suite also **measures layout**, not just presence. The one piece of user feedback M7
received was that the sign-in form had "no padding between fields and labels", which every
existing check was blind to: the markup was correct, the CSP was correct, the page returned
200, and the label and its input sat on the same line touching each other. So the gap
between each label and its input, and the height of every control against the 44px floor,
are read from the browser's own box model. A stylesheet assertion cannot see layout.

The suite asserts C2 directly: it types in a browser and then reads the `.md` file off disk,
which is the only way to check the promise that a note is plain Markdown a text editor can
open.

**It is also the only thing that can disconnect a browser.** `offline.spec.ts` (M6, §7.4)
takes the network away with `context.setOffline` and asserts the three answers a navigation
can then get: the note you had open, still readable out of its local replica; the shell for a
note you did not; and an honest page for a route that needs a server. Its fourth test is the
one that matters most — type with the network off, put it back, and **read the `.md` file off
disk** — because that is the whole path an offline edit takes, and every part of it was
missing through M5.

**A `display: none` in the wrong place broke a different pane.** §7.2's "body not
downloaded" state covers the editor while a note's body is on its way, and the first version
of that cover removed the surface from layout. Every rectangle inside it then measures zero,
and §9.5's outline decides which section is current by comparing heading positions against
the scroller — so a note's first section became current before its body had arrived. Two
panes, one stylesheet rule, and the only test in the repository that measures layout is what
noticed. The cover is `visibility: hidden` now, which keeps the boxes real.

**That test also found what nothing else could.** `context.setOffline(true)` does *not* close
an already-open WebSocket: the emulation refuses new connections, and the socket stays there
accepting sends that go nowhere. The first version of the test failed on the indicator still
reading "online", which is exactly the state a real network drop produces for as long as TCP
takes to notice — minutes. That is why §7.4's transport now closes its own socket on the
browser's `offline` event rather than waiting to be told. jsdom has no service
worker scope, no cache storage and no way to go offline, so every unit test around §7.4
asserts a decision rather than an outcome — and the outcome is the whole feature. The test
that the page came from the cache reads the bootstrap attributes: the server fills them in and
the precached shell has them empty, so `data-vault=""` is what distinguishes a cached page
from a served one. **Verified failable** five ways: not registering the worker, making the
fallback answer with the offline page instead of the shell, removing the URL fallback that
tells the shell which note it is, deleting the reconnect flush, and removing the `offline`
listener that closes the socket.

**Two more things it caught, after M7.** Both are recorded because neither is obvious and
both will recur:

- **An author `display` silently cancels `[hidden]`.** `.slash-menu { display: flex }` beat
  the user agent's `[hidden] { display: none }` however low its specificity, so the slash
  menu's `hidden` property read `true` in every unit test while the menu stood open above
  every note in the browser. The stylesheet now carries one `[hidden] { display: none
  !important }` rule, which closes the class rather than the instance — but the check that
  can see it is a browser measuring the strip's height.
- **`fullyParallel` plus two projects is one server and one vault.** A test that types into a
  shared note is racing the same test in the other viewport and every later test that reads
  it. That produced both a task already ticked before the test asserting it was not, and a
  stray `/` typed into a heading. A test that *changes* a note now takes one keyed by
  `(test, project)` from `environment.ts`, which throws on an unknown key rather than falling
  back to a shared note.

**Two from the shell redesign (2026-09-11).** `e2e/topbar.spec.ts` covers the bar's layout,
because every way it can go wrong is a layout claim jsdom has no engine for: a bar without a
grid row makes the page scroll, a bar that floats eats the first tab's taps, and a drawer over
the bar hides the control that closes it. Verified failable by giving the bar
`position: absolute` and by hanging the mobile drawer from the top of the window. The two
lessons:

- **Hidden text is not an accessible name.** The bar hides quick find's label and its
  keystroke hint on a phone, and `display: none` removes text from the accessible name as
  well as from the picture — so the control had no name at all at that width. The first
  browser run found it; the unit suite could not, because it does not apply a stylesheet.
  The control carries `aria-label` now, and the dom test pins it.
- **A proxy for "the stylesheet loaded" rots when the design changes.** "The note surface is
  styled, not merely present" asserted a border radius and a box shadow on the note panel.
  Those were the card the note sat in; the note is a full-bleed page now, so both assertions
  would have passed forever on an element nobody styles. It measures the reading column
  against its pane and the bar against `--topbar-height` instead — properties this design
  gives the shell and an unstyled document cannot have.

A third is a Playwright trait rather than a bug: **under mobile emulation neither `End` nor
`ControlOrMeta+End` moves the caret at all.** A test that needs the cursor somewhere puts it
there with the pointer. The symptom is a green desktop run and a red mobile one, for a reason
having nothing to do with what is being tested.

**M8 added a fourth, and it is the same shape as the slash menu.** `web/e2e/backlinks.spec.ts`
was verified failable by setting `.backlinks-panel { display: none }`: the unit suite stayed
**10/10 green** — jsdom applies no stylesheet, so the panel is in the tree and its text is
readable — while all eight browser tests failed. Nothing short of a browser can say a panel is
on screen.

**M9's unlinked mentions repeated it exactly, in the same panel, and added one detail worth
having.** `.mention-list { display: none }` left `Backlinks.dom.test.ts` **16/16 green** and
failed seven of the eleven browser tests — but the four that still passed are the informative
part: `toHaveCount` counts hidden elements, so a row's *existence* says nothing about whether
anybody can see it. What caught the hidden list was measuring the list's box and clicking a
row. **Assert on geometry or on an interaction, not on a count.**

Two smaller lessons from the same change, both worth not relearning:

- **A test may only assert an ordering the fixture actually guarantees.** Two tree tests
  named the folder that happened to sort first; adding fixture notes in a new folder broke
  both, without any behaviour changing — which `AGENTS.md` §2.3 calls a wrong test. They now
  assert the property they claim (every folder precedes every note) and navigate from
  whichever row the cursor starts on.
- **The tree and tab surfaces show the same note title**, derived from the first H1 (with the
  existing title fallbacks). The filename remains the note's path and is used only as a fallback
  when no title is available, so a note cannot appear to have two different names in the shell.

**M8's outline added a sixth, and it is the most expensive shape of green there is: a feature
that was never once exercised.** §8.1 gives every tab a scroll offset, and `NotePane` bound
its `onscroll` to the element Tiptap mounts into — which has no `overflow`, so it never
scrolls and the handler never ran. The offset was written as zero and restored as nothing for
two milestones. No unit test could see it (jsdom lays nothing out and therefore scrolls
nothing) and no browser test looked, because the suite had no test that switched tabs and
came back. `e2e/workspace.spec.ts` now does. **When a feature is a listener on an element,
ask which element actually emits the event** — and if the answer is "the one the stylesheet
makes scrollable", the test has to be in a browser.

**M8's tag pane added a fifth, and it is not about the browser at all: a version literal in a
test goes stale silently.** `a_stamped_version_with_no_schema_behind_it_is_rebuilt` stamped
`user_version = 1` by hand to prove that a database whose version *matches* but whose tables
are missing is still rebuilt. Bumping the index schema to 2 for `prefix_key` (§9.1) left the
test green while it took the version-*mismatch* path instead — the same assertion, satisfied
by the branch it was written to exclude, with nothing red anywhere. It now reads the current
version out of a database the build has just created. **A constant copied out of the code
under test is a test that stops testing on the day that constant changes**, and the schema's
no-migrations policy makes that day routine here.

### 22.7 Other required suites

- **Search:** golden queries against the generated vault; server and client results
  compared for agreement within documented limits (§14.2). Zone assembly correctness.
- **Unlinked mentions (§9.5):** `mb-index/tests/mentions.rs` for what counts as a name, the
  exclusion of links and of the note itself, whole-token matching, group ordering and both
  halves of E8. The panel is `web/src/shell/Backlinks.dom.test.ts` and the layout — that the
  section has real height and sits below the links — is **only** in
  `web/e2e/mentions.spec.ts`: the unit suite stayed fully green with the mentions list set to
  `display: none` while seven browser tests failed.
- **Outline (§9.5):** the document edits in `web/src/editor/outline.dom.test.ts`, against a
  real Tiptap document built from the schema contract — what a section covers, that a move
  carries its subsections, that it refuses a move into itself, that levels survive. The
  keyboard is `web/src/shell/outline.test.ts`. The scrolling is **only** in
  `web/e2e/outline.spec.ts`: jsdom lays nothing out, so every offset there is zero and every
  scroll assertion would pass vacuously. The reorder is asserted on the Markdown file, not on
  the panel, which would only prove the panel agrees with itself.
- **Tags (§9.3):** nesting and prefix counts in `mb-index/tests/tags.rs`, where the counting
  rules are — a parent counts a note once however many children it carries, case is not
  identity, and the displayed spelling does not depend on indexing order. The permission
  cases are in the leak suite and `mb-server/tests/http.rs`; that the pane is on screen and
  operable by keyboard and finger is `web/e2e/tags.spec.ts`, which is the only place that can
  say so.
- **Transclusion:** cycles, self-reference, depth limits, missing targets, unreadable
  targets, deep nesting. **M8:** split across the three layers that own the three questions —
  the slice in `mb-core/tests/transclude.rs` (property tested), the permission cases in
  `mb-server/tests/http.rs` and the leak suite, and the resolution stack in
  `web/src/editor/embed.test.ts`. The one claim none of those can make is that a cycle does
  not hang a *page*, which is `web/e2e/embed.spec.ts`.
- **Conflicts (§3.5):** an offline edit colliding with an external file edit produces
  exactly one conflict callout, containing both versions, that round-trips through the
  serializer unchanged; each resolution action leaves valid content and syncs; conflict
  callouts never nest.
- **Presence (§7.5):** awareness reaches only readers of the document; disconnect removes
  presence; colour assignment is stable and deterministic for a given user id; a 5-client
  room stays inside the keystroke budget.
- **Emoji resolution (§11.2):** vault packs override shared packs; a missing pack file
  degrades to literal `:shortcode:` text rather than a broken image or an error.
- **Mobile:** `VisualViewport` toolbar positioning, long-press drag, swipe navigation —
  real-device or emulated-viewport E2E, not unit tests.
- **Offline:** service-worker E2E — go offline, edit, close tab, reopen, reconnect, assert
  convergence and no data loss.
- **Performance:** §21 budgets as CI gates on both device classes.
- **Accessibility:** keyboard-only traversal of every command; automated axe checks; theme
  contrast (§20.3).

---

## 23. Roadmap

Each milestone is independently demoable. Hard-to-retrofit things — CRDT, the schema
contract, vaults, permissions, the workspace shell — come early. Multi-vault and
multi-user are foundational (A13, A14) and therefore precede everything that queries the
index.

### M0 — Skeleton
- [x] Cargo workspace + `web/` with Vite; `wasm-pack` in the dev loop
- [x] `server.toml`, vault registry, `memberberry serve` opens a vault and serves a page
- [x] CI: fmt, clippy `-D warnings`, test, coverage gate, wasm build
- [x] `memberberry gen-vault` — synthetic 10k-note vault for perf and scale work
- [x] Performance harness wired up on both device classes (§21.1) — *moved to M7 (A29)*

### M1 — Core: block model, Markdown, tasks  *(the foundation; do not rush)*
- [x] Block model types in `mb-core`; `schema.json` as the cross-language contract
- [x] Parser (`pulldown-cmark` events → block document) and canonical serializer
- [x] Task metadata parse/serialize (§10.1)
- [x] Wikilink / tag / anchor / embed extraction
- [x] Round-trip property tests + parser fuzzing — **gate: green before M2**
- [x] `memberberry normalize`

### M2 — CRDT layer
- [x] `yrs` doc ↔ block document in the y-prosemirror shape
- [x] Sidecar persistence + compaction
- [x] Structural diff for external changes
- [x] Cross-language conformance fixtures (§22.2); TypeScript assertions land with M3

### M3 — Editor
- [x] Tiptap schema generated from `schema.json`; TypeScript fixture conformance (§22.2)
- [x] `y-prosemirror` + `y-indexeddb` binding; restore-before-mount lifecycle tests
- [x] Blocks: paragraph, headings, lists, tasks, quote, code, divider, callout, table
- [x] Task metadata chips + date picker + slash commands
- [x] Slash menu; Markdown input rules (`## `, `- `, `- [ ] `, `> `, ` ``` `)
- [x] Mobile: touch drag handles, block toolbar, `VisualViewport` keyboard handling
- [x] Source view + copy-as-markdown via WASM; long-note virtualization

### M4 — Vaults, users, permissions
- [x] `auth.db`: users, sessions, argon2id, first-run setup, invites, scoped API tokens
- [x] Server admin flag; admin-only operations (§6.8)
- [x] Audit log writer + rotation (§6.9)
- [x] `access.toml` load/validate/save; fail closed on malformed input
- [x] `effective_role` in `mb-core` with property tests
- [x] Permission-filtered repository layer — no unfiltered query helper exists
- [x] Multi-vault routing, registry CLI, vault switcher plumbing
- [x] The leak suite (§22.5) for every enforcement point implemented so far

### M5 — Sync
- [x] File watcher (`notify`) with self-write suppression and a 5s recovery sweep
- [x] Debounced Y-doc → `.md` atomic write path, with crash recovery from the sidecar
- [x] WebSocket protocol; **authorization per subscription and per frame** (E2, E3)
- [x] Awareness, scoped to readers (E4)
- [x] Presence UX: remote cursors, stable colours, name labels, avatars (§7.5)
- [x] Convergence tests (§22.3)

Current state, open items and how to run a local instance live in `HANDOFF.md` (§23.1).

### 23.1 `HANDOFF.md`

One file at the repo root, always describing **where the work stands right now**: what was
last finished, what is next, what is open, and anything that would trip someone picking the
work up cold. It is rewritten, not appended to — a changelog is what `git log` is for.

It exists because `CLAUDE.md` → `AGENTS.md` → `SPEC.md` is everything a fresh session reads,
and none of those carry transient state. `AGENTS.md` §1 makes updating it part of done.

Anything durable — a file format, a protocol, a decision, a known limit — belongs in this
document instead, and should be moved here rather than left in a handoff note.

**Order below is the revised one (A29).** Milestones keep their original numbers, so `M13`
still means daily notes; only the sequence changed.

**M8 was built before M6, at the user's request** ("I prefer to go with M8 requirement"),
asked after M7 and the compression follow-up. Both are now complete. The choice unblocked
three things nothing else could: navigating a wikilink, Cmd-clicking one into a tab or split,
and `pruneUnreadable`, all of which need the readable set only an index can supply.

The workspace shell comes first because §23's own rule — hard-to-retrofit things early —
names it, and because everything after it needs somewhere to render. The user has stated
they will not use the application until the final milestone, which means automated
verification is the only verification: hence the performance harness and the E2E suite are
pulled into M7 rather than left to the end. M5 shipped a bundle that 404'd every asset and a
login form its own CSP blocked; both passed the unit suite and were found by opening a
browser. Nothing will be opening a browser here.

### M7 — Workspace shell
- [x] Split/tab/pane state model, persisted per (device, vault)
- [x] Desktop layout: sidebars, splits, draggable tabs
- [x] Mobile layout: drawers, swipe navigation, bottom-sheet tab switcher
- [x] Command palette, quick switcher, vault switcher, remappable hotkeys
- [x] Note tree, bookmarks, note context menus
- [x] **Design-token contract (§20.1)** — moved here from M18. `AGENTS.md` §4.4 forbids a
      hard-coded colour today, so every milestone from here builds against these tokens.
      Light and dark themes still ship in M18; only the contract moves.
- [x] **Performance harness on both device classes (§21.1)** — the last open M0 box. `make
      perf`, `web/perf/`, against the generated 10k-note vault. What it measures, what it
      cannot measure yet, and every way to over-read one of its numbers is §21.4; what
      building it turned up is §21.5.
- [x] **Playwright E2E, desktop and mobile viewports (§22.6)** — see the note below on why
      this is not optional under the current review model.

### M6 — Offline
- [x] PWA manifest + service worker; WASM precache (§7.4) — the app shell, the
      precache, the offline navigation fallback, and §21.2's warm-cache cold start, which
      this is what made measurable
- [x] Tiered replication (§7.2) intersected with the readable set — the eager metadata
      tier, the on-demand body tier, and the "body not downloaded" state
- [x] Resident-body LRU (§7.2) — 500 notes / 50 MB, swept when a note opens, never crossing
      a pinned note or one with unsent changes. **The caps are not configurable**: §7.2 says
      they should be and there is nowhere yet for a client preference to live
- [x] Pin-for-offline (§7.2) — a palette command, a pin store, and the sweep that fetches
      what is pinned and not resident. **Notes only**: folder pins are argued in §7.2
- [x] Offline indicator, pending-change count, reconnect flush (§7.4) — including the
      reconnect itself, which M5 never had, and the flush that sends the server what a
      client edited while it was gone
- [x] Permission reconciliation on reconnect (§7.4) — over the note replica; the zone
      segments it also names arrive with M9's client index, which is where zones exist
- [x] Conflict callouts: detection, insertion, resolution actions, status count and note-tree
      badge (§3.5) — the badge count is permission-filtered with the title, replicated for
      offline use, and checked through the real collision flow on both browser viewports
- [x] Invariant I1 test (§22.4); offline E2E — storage and HTTP restart tests cover the
      implemented surfaces; search recovery awaits M9. Conflict-specific offline collision
      and resolution E2E are part of the completed conflict-callout item above

### M8 — Links, transclusion, tags, graph
- [x] SQLite index + incremental reindex, behind the filtered repository layer (§9.1, §21.8)
- [x] Backlinks panel, with the source block as context (E8, §9.5) — **unlinked mentions
      moved to M9**, which is where the text index they need exists (§9.5)
- [x] Transclusion with cycle protection and unreadable-target placeholders (§9.2), and the
      link handler it brings with it — following a wikilink, and §8.2's Cmd-click and
      Cmd-Alt-click
- [x] Nested tags + tag pane, with permission-filtered counts (§9.3, E16) — selecting a
      node **lists** the notes under it; searching that prefix arrives with M9's text index
- [x] Outline pane: live headings, click to scroll, current section, drag *and* Alt-arrow to
      reorder sections — which moves the blocks and rewrites the file (§9.5)
- [x] Rename-with-link-rewrite for notes and tags, privileged + audit-logged (§6.6)
- [x] **Local graph** (§9.4): the n-hop neighbourhood in the right sidebar, hops adjustable
      1–3, permission-filtered with ghosts for what does not resolve (E9)
- [x] **Global graph** (§9.4): the whole readable vault in WebGL, a Barnes-Hut force layout
      in a Web Worker, quadtree hit testing, labels and icons above a zoom threshold, the six
      filters, and §9.4's honest cap — a phone asks for the top 2,000 nodes by degree and the
      picture says "showing 2,000 of 10,431"

### M9 — Search
- [x] Tantivy server index + incremental updates
- [x] Unlinked mentions (§9.5), moved from M8: title and alias matching over note text is a
      search query, and this is where there is a text index to answer it
- [x] `zones(zone_id, path_prefix, acl_hash)` in the index (§9.1), which is where §14.2
      defines what a zone is
- [x] `mb-search` compact format: build, query, merge; its 10k-note format test measures
      9,372,124 bytes against §14.2's 15 MB hard ceiling
- [x] ACL zoning (§14.2): maximal-zone computation, per-zone segment publication and
      permission-filtered reader assembly (E6)
- [x] Client index sync, segment validation/merging boundary, revocation drop (E6, §7.4,
      §14.2): manifest first, transactional IndexedDB epoch replacement, live re-check on
      binary fetch, and WASM validation before persistence
- [x] Query syntax, results UI with online block context and offline retained-note context,
      plus explicit online/offline and phrase-degradation indication

### M14 — Task views
- [x] Task index and query engine: permission-filtered open-task route, filters and sorting
- [x] Inbox pane with grouping, filters, sort
- [x] Editing tasks from query views back into source notes
- [x] Replicated open-task metadata for the unfiltered offline inbox (§7.2)

### M13 — Daily notes and templates
- [x] Pure template engine in `mb-core` with the §15.2 variable set; unknown variables are
      preserved and `{{cursor}}` returns its insertion offset
- [x] Configurable template folder, permission-filtered insertion command and `/template` slash path
- [x] Pure daily path formatting/parsing and permission-filtered calendar metadata route
- [x] Daily note creation + automatic template-backed creation
- [x] Periodic weekly/monthly notes
- [x] Previous/next daily-note navigation across gaps
- [x] Daily metadata calendar pane and “open today’s note” command

### M11 — Media
- [x] `object_store` with local + S3 backends
- [x] Content-addressed upload, dedupe, thumbnails
- [x] `media_refs` authorization (E11) with the leak test
- [x] Paste, including screenshots copied to the clipboard, / drag-drop / picker;
      client-side downscale; offline upload queue
- [x] `export --materialize-media` + nightly job

### M12 — Excalidraw
- [x] Lazy React island; `.excalidraw.md` read/write
- [x] Embedded SVG preview → full editor
- [x] SVG/PNG export on save; LWW conflict detection and warning UI

### M10 — Emoji
- [x] Base Unicode pack compiled into WASM; inline `:` autocomplete
- [x] Picker: search, recents, categories, skin tones, custom-first
- [x] Server-level shared packs + per-vault overrides, admin-gated (§11.2)
- [x] Custom pack format + bulk folder/zip upload; Slack export importer
- [x] `export --materialize-emoji`
- [x] Note icons (frontmatter → tree, tabs, title, graph)

### M15 — Web clipper
- [x] HTML → block document in `mb-core`
- [x] `POST /api/v1/vaults/<slug>/clip` + bookmarklet, with DNS-pinned SSRF controls, bounded work, rate limiting, atomic Markdown destinations, and permission tests
- [x] MV3 + Firefox extension: full page, selection, article, installable packages, persisted settings, and reconnect queue flushing
- [x] Server-side image rehosting; multipart PWA `share_target` for URLs, text, and bounded images

### M16 — Public sharing
- [x] `share_links` model, token generation, expiry, revocation, password
- [x] Separate read-only public entry point (§17.2)
- [x] Token-scoped media endpoint; embed rules that never escalate
- [x] Rate limiting, `noindex`, access audit; the share-link leak suite

### M17 — History
- [x] Snapshot-on-write with thinning policy
- [x] Version list, word-level diff viewer, restore-as-edit
- [x] Trash + restore

### M18 — Migration, export, themes, polish
- [x] `import-obsidian` with dry-run report; `memberberry doctor`
- [x] PDF / HTML / static-site export
- [x] Light and dark themes, contrast checks (the token contract itself ships in M7)
- [x] Remappable default keymap (§8.4)
- [x] Backup job; docker-compose with MinIO; deployment and security docs

### Post-v1 candidates
- Tauri desktop shell (reuses `mb-core` natively, no WASM boundary)
- gonnadoit integration over the HTTP/WS API
- Task recurrence (§10.4); TOTP 2FA; comments and mentions
- Published-site mode (folder-level public publishing)
- Excalidraw CRDT collaboration; cross-vault links
- Database views over structured note properties
- Freeform canvas workspaces, Mermaid — **only if explicitly requested; both were declined**

---

## 24. Decision log

Verbatim answers with the resulting decision, except where explicitly marked as paraphrased
to replace a product comparison with a description. Do not reverse these without asking.

| ID | Question | Answer | Decision |
|---|---|---|---|
| A1 | UI framework | *"usability and swiftness… whatever is more performant wins. Not going to have extreme amounts of excalidraw diagrams"* | **Svelte 5**; React confined to a lazy Excalidraw chunk (§5.1) |
| A2 | Nesting model | Paraphrased: one note per file | One note = one file; folders are folders (§4.1) |
| A3 | Daily notes / templates | *"Both… I want it"* | In scope, M13 (§15) |
| A4 | Plugin system | *"ignore it… cross the bridge when we come to it"* | No plugin system. HTTP/WS API exists for the app regardless |
| A5 | Offline search | *"ship compact client-side search"* | Full readable-vault compact WASM index (§14.2) |
| A6 | Encryption at rest | *"No encryption at rest, only on filesystem"* | None. Rely on disk/FS encryption (§6.7) |
| A7 | Version history | *"Server should keep versions / logs for 90 days, local should not care"* | Server: 90d Markdown snapshots. Client: GC, no history (§18) |
| A8 | Vault size | *"around 500 notes… design for 10k+"* | 10k+ is the design target; drives §7.2, §9.4, §14.2, §21 |
| A9 | Extra features | transclusion, nested tags, icons/outline/export | In scope. **Mermaid and Canvas explicitly not selected** (§4.4) |
| A10 | Workspace | adaptive | Tabs+splits desktop, single-doc mobile (§8) |
| A11 | Web clipper | v1, extension + share target | M15 (§16) |
| A12 | Tasks | *"I want due dates and priorities"* | Obsidian Tasks emoji syntax; recurrence deferred (§10) |
| A13 | Multi-vault | *"Multi Vault from the beginning so it is easier now"* | Vaults are foundational, built in M0/M4 (§6.1) |
| A14 | Multi-user | *"folders will have owners models, viewer and editor… easy, but can be granual"* | Users + folder ACLs with roles owner/editor/viewer (§6) |
| A15 | Performance baseline | *"Mid range android… be very VERY efficient"* | Mid-range Android is the primary budget target (§21) |
| A16 | Theming | *"easy to add new themes, first make 1 dark and 1 bright"*; updated 2026-09-10 (paraphrased): one dark theme, one pastel dark theme, and one clean, neutral light theme | Token contract + Paper, Charcoal, and Pastel; notebook redesign; DOM not public API (§20) |
| A17 | Unreadable notes | invisible | Invisibility rule, filtered at the index layer (§6.5) |
| A18 | ACL granularity | folder inheritance + per-note override | Longest-path-wins resolution (§6.3) |
| A19 | Public links | read-only with expiry | Separate anonymous entry point (§17) |
| A20 | Co-editing UX | *"Surface properly"* | Live cursors, stable colours, presence avatars (§7.5) |
| A21 | Emoji packs | *"Shared for the server"* | Server-level packs, vault overrides, admin-gated (§11.2) |
| A22 | Shared resources | *"Only emojis should be shared"* | Media, S3, themes, templates, history stay per-vault |
| A23 | Audit log | *"Server side file is enough"* | JSONL at `<data-dir>/audit.log`, no UI in v1 (§6.9) |
| A24 | Conflict UI | *"inline conflict marker in the note"* | `> [!conflict]` callout with resolution actions (§3.5) |
| A25 | Frontmatter in the Y.Doc | *"I take the recommendation"* | Sibling `frontmatter` Y.Map beside the `prosemirror` XmlFragment; per-key merge (§5.6) |
| A26 | Canonical ordered-list numbering | *"the file doesn't need to be that much readable, ten `1.`s in a row is not a problem when I know what it means"* | Keep lazy numbering: serialize every ordered-list item with `1.` and let the renderer count (§4.4) |
| A27 | Raw HTML in notes | *"I don't mind either at the moment. It would be nice however to be able to style my pages there somewhat."* | No change for v1: escape raw HTML as text; page styling remains the responsibility of the theme/token system (§4.4, §20) |
| A29 | Milestone order and when to review | *"I won't deliver nor use the app until the last milestone is done"* / *"at what stage should I start clicking around and start providing feedback?"* | Workspace shell (M7) first; §20's token contract and M0's performance harness move into it; Playwright E2E becomes an M7 deliverable rather than a late nicety. History (M17) stays late — the data-safety argument for moving it up assumed real usage, which there is none of. Review is by artifact (screenshots, recordings, a running instance the author drives), not by the user operating the app (§23) |
| A28 | Invite acceptance | *"it should create a new credential-bearing user"* | An accepted invite always creates a new user account with the invite's scoped role; it never attaches to an existing account (§6.8) |
| A30 | Clipboard screenshots | *"I want to also have paste from screenshots that are in clipboard"* | Media paste explicitly accepts image data for screenshots currently held in the system clipboard (§12.4, M11) |
| A31 | Browser-first vault creation | *"When I first start the app, I should be directed on how to create a new vault and I should do it over the UI"* / *"I should be able to make new Vaults from the UI too"* | First-account setup and guided vault creation live in the browser; administrators can add managed Markdown vaults without restarting. CLI registration remains optional for existing folders (§6.1, §6.8). |

---

## 25. Assumptions and status

**Every question raised during design has been answered (§24). No open question blocks any
milestone.** Implementation can begin at M0.

The following were decided without being asked, because they were needed to make an
answered decision coherent. Each is small, each is reversible, and each is listed here so
it is visible rather than buried:

| # | Assumption | Where | Why |
|---|---|---|---|
| S1 | **Server admin is a user flag**, separate from vault roles, required for vault creation and shared emoji packs — and it grants **no** content access | §6.8 | A21 made emoji server-wide, which needs someone allowed to manage a server-wide resource. Keeping admin orthogonal to content access means "can administer the server" never silently becomes "can read your journal". |
| S2 | Conflicts use a `> [!conflict]` **callout**, not git-style markers | §3.5 | Already valid Markdown; needs no new block type and round-trips through the canonical serializer unchanged. |
| S3 | A vault-local emoji pack **overrides** a shared pack on collision | §11.2 | Consistent with ACL resolution: more specific wins. |
| S4 | Deleting a note leaves inbound links dangling as ghost nodes | §4.3 | Avoids editing other users' notes as a side effect of your delete. |
| S5 | Trash retention 30 days; share-link default expiry 30 days | §4.1, §17.1 | Conventional defaults, both configurable; trash uses `trash_retention_days`. |
| S6 | Presence is suppressed on mobile below 768px (avatars kept, caret labels dropped) | §7.5 | Name labels over a phone-width editor obscure the text they annotate. |

If any of these is wrong, say so — none is load-bearing enough to be expensive to change
before the milestone that implements it.

### Deliberately out of scope for v1

Recorded so they read as decisions rather than omissions: Mermaid, freeform canvas workspaces,
multi-column page layouts and synced blocks, database views with formulas, task recurrence, cross-vault
links, plugin system, encryption at rest, TOTP 2FA, comments and mentions, published-site
mode, Excalidraw collaborative editing, native desktop and mobile apps.
