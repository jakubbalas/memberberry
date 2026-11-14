# Memberberry — Implementation Specification

> Scratch contract decision, October 7, 2026: rejected `:mb-style` declarations
> remain complete readable literal wrappers, with no styling semantics. The user's
> explicit choice is: **allow surgical tag/wiki-link renames inside rejected directive
> labels, never their metadata**. Rename eligibility is established from the existing
> Rust scanner's original UTF-8 complete label boundaries, not presentation text.
> Each requested label splice must pass the unchanged tag/wiki semantic verifier on
> that label, and complete literal-wrapper model ownership plus the final full-note
> semantic oracle must agree. Metadata, delimiters, aliases, anchors, native link
> destinations/Option titles and unrelated source bytes remain unchanged. Unknown or
> malformed attribute values do not themselves prevent an otherwise checked complete
> label rename. Unclosed, ambiguous, nested-literal or over-budget ownership is
> fail-closed/no write; no inferred delimiters, generic Text rename, parser promotion
> or metadata migration is authorized. This decision is recorded in this scratch
> candidate only; main integration remains separately gated.

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

The browser keeps an edit pending until the server echoes its accepted update, not merely
until `WebSocket.send` queues it. Refused updates remain in the local document and reconnect
reconciles the complete missing state. Closing the last subscription attempts the Markdown
flush before releasing its coordinator; a failed flush retains the room for maintenance retry
so accepted content is not stranded in a sidecar.

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

Unsent changes alone are not a conflict. Before reconnect reconciliation, the client tests
whether the received server state is already contained in its pre-merge CRDT history,
including delete sets (state-vector clocks alone do not cover deletions). An ancestor server
state means a one-sided local edit that only needs uploading; stale Markdown merge bases
must not invent a conflict with the user's own earlier saved text. Two-sided divergence
still follows the conflict-callout path.

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

**Visual tables (2026-09-22).** The editor's Table button and slash command insert two
columns with a header and two body rows, placing the caret in the header. Selecting a cell
shows Edit header (above the selected column), Add row (below the current row), Add column (to the right), Row up and
Row down. Body rows have mouse/touch drag handles; dropping on another body row moves the
source to that row's index. Clicking, tapping or keyboard-activating a handle opens a
nearby menu with New row above, New row below and Delete row. The menu targets that row
and closes on document changes, selection changes to another row, outside clicks, Escape,
scrolling or resizing. Escape restores focus to the handle. Deleting the final body row
removes the whole table, including its header, leaving a blank paragraph ready for typing.
This applies to row-menu deletion and empty-row Backspace. Inserting above or directly
deleting the header is refused.
Backspace at the start of the first cell deletes a body row only when every cell is
empty. In an empty cell with a column to its left, Backspace moves the caret to the end
of that left cell without changing content. In the first cell, other populated cells
prevent row deletion. At the start of a populated cell it leaves the structure intact
rather than joining cells or rows. Text deletion inside a cell and deletion of selected text retain their normal
behavior. The same empty-row rule applies to mobile backward-deletion input.
Columns divide the available table width equally and wrap text, so empty cells and long
content do not redistribute column widths. Keyboard and mobile users can select a row's handle and use
Row up/down. The first row is always the Markdown header and stays fixed. Empty header
cells are permitted; headerless tables and merged cells are not added.
Enter and Shift+Enter insert an in-cell hard line break, including in empty cells and
headers, without adding rows or columns. Cmd+Enter (Ctrl+Enter on Windows/Linux) inserts
a complete row below the current row and focuses its first cell; the Add row button
advertises the shortcut. Plain Markdown stores cell breaks as `<br>` on
the same physical pipe-table line; leading, trailing and repeated unmarked breaks survive
round trips. The parser recognizes bare `<br>`, `<br/>` and `<br />` case-insensitively only
inside table cells. Other raw HTML remains literal text; escaped tags and code spans stay
literal. New rows are inserted through the table controls. This extends the earlier
single-line-cell limitation without changing the CRDT schema.
Row moves preserve inline content and formatting; column insertion preserves existing
alignment. A changed document or a different destination table cancels an outstanding
drag. Controls are inert in read-only editors. Editing handles are excluded from HTML
exports and printing. Storage uses GFM pipe tables with the cell-break convention above.

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
Native Code is self-excluding, not exclusive of all marks. Strong, Emphasis,
Strikethrough, Highlight and Link may wrap its exact literal text; Code never parses
formatting inside that text. Retain link destination and optional authored title.
An explicitly authored empty title is present (`Some("")`) and stays `""` through
Markdown/native/WASM reopen; an absent title or native null/default remains absent.
This applies to inline and resolved reference links with plain or Code content.
The native schema correction is revision 2, with the same six marks and lib0 encoding;
this does not integrate the pending namespace/admission package. Unknown or hashed
mark keys and invalid mark attributes remain invalid, never stripped on write.

- Atom nodes: `wikilink`, `image`, `tag` (`#tag`, `#nested/tag`), `emoji` (`:name:`),
  `inline_math` (`$x$`), `footnote_ref`, `soft_break`, `hard_break`.

**Namespace formatting contract, requested 2026-10-04 — implementation in progress.**
Normal formatting stays ordinary Markdown. The new inline source form is
`:mb-style[label]{attributes}`, limited to properties Markdown does not already encode:

```markdown
:mb-style[underlined]{underline="true"}
:mb-style[**important** text]{color="red" background="yellow" size="large"}
```

- Supported properties are `underline="true"`, `color`, `background` and `size`. Colour
  values are `gray`, `brown`, `orange`, `yellow`, `green`, `blue`, `purple`, `pink`, `red`;
  size values are `small`, `large`. Default/normal/unset is absence of the property. These
  names are semantic presets, not arbitrary CSS, HTML, font names or numeric sizes.
- Use exact lowercase attribute names/values and double quotes. At least one supported
  attribute is required. Input attribute order may vary; canonical order is underline,
  color, background, size with one space between attributes. Reject unknown/duplicate
  attributes or unsupported values as a whole declaration, not a partly applied style.
- A label is one inline scope/physical line and uses native inline Markdown. Protect code,
  math, escapes, wikilinks, links, tags, emoji and table boundaries. Apply styles only to
  eligible text; preserve and split around atoms, code and breaks. A visual edit must not
  claim that an atom's label or literal code has received a style the CRDT cannot retain.
- Unknown, malformed, incomplete or escaped directives remain readable literal Markdown,
  including their wrapper/attribute characters. Never omit an unhandled directive or
  consume the remainder of a note as an implicitly closed container. Canonical escaping
  may normalize source spelling; do not promise arbitrary-file byte preservation.
- Bound authored style-label nesting at 16 and attribute metadata at 256 bytes before
  attribute parsing; over-budget declarations remain literal as a whole. Canonical style
  wrappers have at most the four supported property dimensions. These namespace-specific
  budgets do not establish a total CommonMark parser CPU/input-size bound.
- Use one typed style-property family in the core and independent schema/CRDT marks
  `mb_underline`, `mb_color`, `mb_background`, `mb_size`; each excludes itself. Colour,
  background and size have validated enum `value` attributes. Separate properties must
  not compete by overwriting a compound style object in one Y.Text key. Each future
  namespace mark must exclude Code, and Code must explicitly exclude itself plus
  `mb_underline mb_color mb_background mb_size` once those marks are declared. Native
  Strong/Emphasis/Strike/Highlight/Link wrappers around Code remain supported. Namespace
  styles do not apply to literal Code; native mark conventions remain ordinary Markdown.
- Native and WASM parsing/serialization, CRDT materialization, schema-conformance fixtures,
  extraction, links/rename/anchors/conflicts and rendering must agree. No TypeScript
  Markdown parser is introduced. Require canonical-model/source convergence, property
  tests, independent-dimension concurrency and actual generated-WASM binding/save proof.
- HTML uses only fixed validated classes `mb-underline`, `mb-color-{preset}`,
  `mb-background-{preset}`, `mb-size-{preset}`. Palette values belong in theme tokens;
  include the same formatting rules in editor, safe share/fallback, static export and
  standalone HTML/print. Preserve legacy native highlight; a namespace background has
  explicit visual precedence without silently deleting that stored mark.

The proposed later block extension is a `:::mb-toggle` container with a readable ordinary
text/ATX-heading summary and Markdown body, an explicit closer and view-only disclosure.
Its exact nesting/anchor grammar and schema are not implemented or certified by the
inline-style slice. Do not declare placeholder toggle types to pretend it is supported.
The current native-Code contract correction is schema revision 2. A later namespace
integration must take a separate coordinated revision; it must not reuse revision 2
for a different node/mark declaration. The compatibility prerequisite and user's
refresh-only decision are in §8.4. This section records the requested contract, not a
claim that the current deployed editor already supports it.

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
- Arbitrary HTML blocks, note-authored CSS and unbounded style values. The explicit
  bounded `mb-style` contract above is the user-requested exception for coloured text;
  it is not permission to restore general-purpose HTML storage/editing.
- ~~Mermaid diagrams~~ — declined in A9, **brought in by A38** (§13.2). They are ordinary
  ` ```mermaid ` code fences, so Markdown isomorphism is untouched
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
6. **The Tauri desktop client (§7.6)** reuses the core natively, with no WASM boundary.

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
                  `mb_server::replica` (M19, §7.6.9) is the desktop sync client: the
                  upstream link over §7.1, the three-way sync plan and its record. Planned
                  as a crate `mb-replica`; a module, because it needs the embedded
                  server's registry in-process and the server's desktop pages start it.
desktop/          (M19, §7.6) Tauri 2 host, its own cargo workspace: embeds mb-server
                  (`mb_server::desktop`) on loopback and opens web/dist in a window
web/
  src/editor/     Tiptap schema (generated from schema.json) + y-prosemirror
  src/shell/      Svelte 5 workspace: panes, tabs, sidebars, adaptive layout
  src/excalidraw/ React island, lazily chunked
  src/mermaid/    Mermaid renderer, lazily chunked (§13.2)
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
| Text diagrams | `mermaid` | lazy chunk, only on notes with a ` ```mermaid ` fence (§13.2) |
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

**Honest limit: adjacent identical links join.** A link is a Y.Text mark, and two adjacent
runs with one destination and title are one mark run. `[a](u)[b](u)` therefore reads back
from the CRDT as `[ab](u)`, styled or not; Markdown alone keeps them apart. Inside `mb-`
styles, canonicalization rejoins such links itself, because style distribution copies each
link onto every leaf and must agree with what materialization reads back
(`style::join_links`, after canonical settling). Pinned by
`adjacent_identical_links_join_into_one_link` in `mb-crdt/tests/crdt.rs`.

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

#### Unified New vault — t-009 (October 18, 2026)

This amendment supersedes the separate Add vault navigation and earlier setup-form wording
below. The home page offers **New vault** and **Log out**, with first-vault guidance separate
from the action label. `/vaults/new` combines managed creation and configured-folder adoption.
It follows Paul’s linked Penpot design: vault name, **Vault address (optional)**, **Choose a
folder (optional)**, **Choose folder**, **Create vault**, and **Back to your vaults**.
A blank address generates a valid independent-random-suffixed address without catalog probes;
an explicit address is validated after trimming surrounding whitespace and used unchanged.
No folder selection creates the existing managed `<config-directory>/vaults/<address>/notes` layout. A selected folder registers its
exact root through the existing preview/single-use register API, respecting its ACL unchanged.
The optional overlay uses the shared Memberberry token contract and form/button appearance,
current-directory heading, add-folder and parent navigation, child rows and Cancel/Use this
folder. Immediate folder creation and all existing E29/E31 containment/authorization/no-replay
requirements remain. Cancelling a selection restores the previous choice; a clear-selection
control returns to managed storage. Folder browsing/selection never registers a vault.
The former `/vaults/add` URL remains a compatibility entry to the same interface; its separate
home-page action is removed. Existing vaults, managed storage, CLI, media and in-vault browsing
are not migrated. The design is an implementation reference, not authority to expand access.

#### Project-folder vaults — backend technically accepted; interface implemented for review

The folder-based **Add vault** flow extends, rather than replaces, the managed
`/vaults/new` flow above. Paul approved choosing an existing project directory or
creating a project directory in an allowed server location and registering it in place.
Delivery is split into safe location primitives (t-001), authorized registration (t-002),
and the accessible desktop/mobile interface (t-003). The optional configuration and
syntax/discovery foundation are implemented in t-001. The bounded t-002a read-only HTTP
gates and E29 read-side assertions have been exercised and passed independent security
then quality review. The t-002b fixture-only safety prerequisite has also passed both
reviews; it adds no product behavior or registration authority. The t-002c registration
backend has passed independent SPEC/security and full-backend quality review on its frozen
source identity. The t-003 browser below is implemented for fresh review. Neither backend
technical acceptance nor interface implementation is finished-feature or release acceptance.

- Optional `[[vault_locations]]` entries in `server.toml` declare a validated stable `id`,
  display `name`, and absolute server `path`. No locations are available by default;
  old configs remain valid. Invalid/duplicate entries fail closed. Paths refer to the
  server's filesystem (for example `/projects` inside a container), not the browser's
  device. The configured location itself is browse-only, not a selectable whole-tree vault.
- **Implemented foundation:** ids follow vault-slug syntax (1–64 ASCII lowercase letters,
  digits and internal hyphens); labels must be nonblank and control-free. Config paths are
  explicit slash-separated absolute server paths: no home expansion, backslash, controls,
  empty/repeated/trailing separators (except `/`), dot or traversal components. Parsing is
  structural and does not require mounted/existing roots; actual discovery requires an
  existing directory. Config serialization retains existing vault/media values and omits
  an empty locations list. Relative browsing tokens allow the empty root only for browsing;
  selection requires a nonempty path. Directory components preserve Unicode, ordinary
  spaces, colons and percent-looking literal text exactly; `Design: notes`, `100% Complete`
  and `%2e%2e` are names, not decoded paths. Hidden/dot/traversal, blank, control, separator,
  over-255-byte and ASCII-letter-plus-colon drive-prefixed components are rejected. This
  narrow drive-syntax check does not imply a Windows filesystem backend. Tokens are never
  decoded or normalized; t-002a decodes the HTTP query boundary exactly once as specified
  below. Unrepresentable filesystem
  names (including non-UTF-8 names) are omitted rather than lossily converted into tokens.
  Directory discovery stays crate-private behind the t-002a HTTP gate and lists only immediate real
  children in exact-name sorted order without note-body reads or recursive tree scans.
  Registration states distinguish available, already-registered, inside-registered and
  containing-registered paths; the configured-root flag independently makes roots browse-only.
  Registered roots are boundaries, while their ancestors remain browsable but unselectable.
  The filesystem implementation currently targets Linux with `openat2`: pinned directory
  handles, no-follow/beneath resolution and identity rechecks reject symlink substitution
  and moved/replaced selections. Registered snapshots pin root descriptors and retain both
  their original registry paths and canonical targets; moved, unavailable, replaced or
  retargeted snapshots fail closed. Actual configured-root/selection ancestors are checked
  descriptor-relatively against registered identities, not just lexical prefixes. Snapshot,
  configured alias/anchor and relative identity checks run before enumeration and again
  immediately before status/list publication. Unsupported kernels fail closed; there is no
  filesystem discovery backend on non-Linux hosts yet. An explicitly configured root alias
  is trusted, pinned and revalidated; symlinks below it are refused. These checks are not an
  atomic filesystem namespace transaction: arbitrary external rename-and-restore or mount
  manipulation between syscalls cannot be frozen by read-only descriptors. Filesystem-level
  access remains outside the ACL protection model (§6.7); no stronger race-free snapshot or
  registration authority is claimed by the read-only foundation. t-002a holds the management
  lock and checks current disk/live registration agreement on each request; the write-side
  confirmation below revalidates state under that lock.
- Only enabled server administrators authenticated by a signed session may browse these
  locations or register folders. Scoped API tokens confer no server-administration rights.
  Authentication precedes any filesystem discovery, and writes require same-origin checks.
  Location id plus a validated relative path is the boundary: no arbitrary absolute path,
  traversal, hidden component, control character or symlink traversal below a location.
  Invalid tokens are rejected, never silently repaired or normalized into a selection.
- The t-003 browser at `/vaults/add` offers **Use an existing folder** and **Create a project folder**. It lists
  immediate visible directories in a labelled folder dialog, permits parent/child navigation,
  identifies registered boundaries, and validates storage when **Add vault** is submitted.
  It does not read note bodies merely to render a directory picker, expose private contents
  of existing vaults through administrative browsing, or chmod/chown project trees.
- Existing-folder registration preserves the selected folder and all pre-existing files
  in place. Existing `access.toml` remains unchanged; malformed policy refuses registration.
  Only an absent policy receives an explicit owner grant for the authenticated creator,
  with no anonymous access. Server administration still grants no content-reading bypass.
- New-folder creation uses a selected parent and a validated single directory name,
  refuses existing files/directories/symlinks, and never silently adopts a collision.
  It creates a root-layout project vault without implicitly adding a `notes/` directory.
  Both modes retain `Vault::open`'s existing rule: use `notes/` when present, otherwise
  root-layout Markdown. Optional collapsed **Details** explains recursive `.md` discovery and that ordinary
  dependency/build directories are not automatically excluded; non-Markdown files are
  not imported as notes. Ignore-rule changes and general file management are separate scope.
- Duplicate or ancestor/descendant-overlapping vault registrations are refused server-side.
  Registered vault roots form browsing boundaries; admin discovery cannot enumerate their
  private children. Confirmation revalidates path identity and registration state rather
  than trusting an earlier preview. Durable registry persistence is atomic; live publication,
  indexing and watching must cover an adopted folder without requiring a restart.
  Failures leave existing folders/content/policies and prior registrations intact; rollback
  may remove only artifacts created by the failed operation, never a pre-existing project.
- The controls use existing design tokens, labels and keyboard navigation, remain usable
  on mobile, preserve form context after errors, and work under the application's CSP.
  The existing managed creation and operator CLI remain available. Explicit operator
  configuration/deployment is needed to enable a location on an existing running server.

Building this now rather than retrofitting is exactly right: vault-scoping every index
query, route, and doc ID later would touch every file in the project.


##### t-002a read-only HTTP contract and conservative delivery limits

No rendered controls or registration endpoint are supplied by this slice. Linux `openat2`
remains required; missing management/configuration or unsupported platform/kernel refuses
neutrally. These routes accept GET (and Axum's bodyless HEAD), with no request body:

- `GET /api/v1/vault-locations` returns `{"locations":[{"id":"projects","name":"Projects"}]}`.
  Labels/ids are configured metadata, not filesystem availability claims; no server path is
  serialized. An empty locations list returns `{"locations":[]}`.
- `GET /api/v1/vault-locations/{id}/directories?path=<form-encoded-relative-token>` returns
  `{"path":"", "state":<state>, "children":[{"name":"Public","path":"Public","state":<state>}]}`.
  The state has `location_root`, `registration`, `selectable` and `browsable` fields.
  Registration is `available`, `already_registered`, `inside_registered_vault` or
  `contains_registered_vault`. Root is always unselectable. Registered-root entries can be
  listed as boundaries, never enumerated; their ancestors are browsable but unselectable.
- `GET /api/v1/vault-locations/{id}/status?path=<form-encoded-relative-token>` returns
  `{"path":"Public","state":<state>}` without child enumeration. A registered root's
  status can be inspected, but resolving any private descendant refuses before opening it.

The only optional query is one literal `path=` field (absent/empty means location root).
Duplicate/unknown query fields and encoded key aliases refuse. Route ids are exact literal
slug tokens, with no percent-encoded alternate spelling. Query decoding is strict UTF-8,
once only: `%25` becomes a literal `%`, `+` becomes a space, and no later primitive decodes
again. Encode literal plus as `%2B`; encode Unicode/colon/percent normally. `%252e%252e`
addresses literal `%2e%2e`, not `..`; `%252f` and `%255c` address literal `%2f` and `%5c`.
Further percent-looking text is still literal (including a genuinely named `%252e%252e`
directory), not silently repaired. Invalid percent escapes/UTF-8 refuse; actual traversal,
absolute/hidden/control/backslash/drive-prefixed components refuse after boundary decoding.

All responses are JSON and `Cache-Control: no-store`. Non-admin/anonymous, disabled/demoted,
expired/revoked/invalid sessions and unavailable/unsafe roots/registry/config return the
same `404 {"error":"not_found"}` without path/error details. An Authorization header,
including scoped Bearer tokens even alongside a cookie, cannot authorize these routes.
Authorized malformed wire inputs return `400 {"error":"invalid_request"}`; exceeded
budgets return `422 {"error":"limit_exceeded"}` with no partial list. Admission contention
or rate exhaustion returns `429 {"error":"busy"}`. No filesystem/config error details or
secrets are logged by these read routes. Authentication is checked again inside the
blocking job and before response publication; no client user/role or cached admin flag is used.

Delivery assumptions (HTTP refusal only, not changed persisted configuration syntax):

| Budget | Bound and enforcement |
|---|---|
| Request | Raw route path ≤256 bytes; raw query ≤4096 bytes before decoding/allocation; decoded relative token ≤1024 bytes and ≤16 components before filesystem work. Existing component limit remains 255 bytes. No body/Transfer-Encoding. |
| Configuration | Regular config file ≤1 MiB before parse; capped read also catches growth. Nonblocking open plus regular-file check refuses FIFO/devices. At most 32 configured locations / 128 disk and live registered roots before collecting borrowed vault references or snapshot discovery. Names/media credentials are never cloned from the live registry. Duplicate ids/slugs or disk/live path/slug disagreement refuse. |
| Metadata | Location label ≤256 UTF-8 bytes; conservatively reserved locations JSON ≤32 KiB before collection; no location path/status probes for the metadata route. |
| Server paths | Original and canonical server paths ≤4096 bytes / ≤64 components before corresponding descriptor ancestry work; relative traversal cannot expand beyond the same ceiling. |
| Directory work | At most 4096 iterator entries, including files, hidden/unrepresentable names and the kernel's dot entries. Exhaustion refuses even at exactly 4096 (no extra EOF lookahead); counter checked before stat/token allocation. At most 128 returned immediate directories, and worst-case escaped child JSON reservation ≤64 KiB before child token/vector allocation. A child token exceeding the token/depth ceiling refuses the whole listing, not omission/truncation. |
| Ancestry/revalidation | At most 100,000 charged work units per snapshot/list: registered verification/identity comparisons, ancestry steps and entry work are charged before each bounded batch. Path and registered-count ceilings additionally bound each batch and canonicalization. Units are conservative loop/syscall accounting, not a wall-clock deadline or an exact syscall count. |
| Output | Bounded JSON writer refuses before appending beyond 64 KiB; child estimation also bounds intermediate DTO allocations before serialization. No paging/partial success. |
| Admission | Global to these three routes: 60 admitted requests per fixed 60-second monotonic window; two permits at most for submitted/running blocking jobs, no waiter queue. Management and live-registry locks are try-locks. Per-user maps cannot grow because admission uses one global budget. |

Filesystem work stays on `spawn_blocking`, never the async executor. The blocking closure
owns its permit until it actually exits, including after its async waiter is cancelled;
cooperative cancellation is checked between bounded batches and before publication. A
running kernel/remote-filesystem syscall is not forcibly cancellable and has no claimed
time deadline, but cannot release its slot early or create an unbounded queued workload.
Current disk configuration and live registry are checked under management/registry locks
each request; no cached preview grants future discovery/registration authority. Existing
managed creation and persisted config syntax are unchanged. Storage writability, ACL
creation/preservation and registration/index/watch are supplied separately by t-002c below;
the UI remains a later slice. The accepted t-002a GET wire contract is unchanged.


**Project-folder registration JSON API (implemented, technically accepted backend):**
The GET contracts above are unchanged. Linux adds two POST routes in the same family:

| Route | Input | Success |
|---|---|---|
| `/api/v1/vault-locations/{id}/preview` | exact selection object below, **without** `confirmation` | 200, a short-lived receipt and explicit usability scope; no registration |
| `/api/v1/vault-locations/{id}/register` | identical selection object **plus** `confirmation` | 201 after atomic registry commit and coherent live publication |

Both require exactly one real signed-session credential **across all Cookie fields** for a
**currently enabled server admin**. Unrelated cookies may occupy the same or additional
fields; duplicate session credentials (even identical genuine tokens) refuse, and credential
bytes are not trimmed/repaired. Every `Authorization` header is refused, including alongside
a valid cookie. Registration-scoped strict same-origin checks leave managed onboarding and
GET discovery helpers unchanged: exactly one structurally valid HTTP(S) Origin and Host,
and zero or one Sec-Fetch-Site (cross-site refuses). Host is a literal authority including
bracketed IPv6 and optional numeric port; userinfo/path/query/fragment/backslash/control/
whitespace and parser-repaired spellings refuse. Raw Origin allows no path other than the
historically accepted single trailing slash; normalized dot/encoded-dot/backslash paths
refuse before URL-origin tuple comparison. Missing/cross-origin/ambiguous credentials or
unauthorized actors receive neutral 404 JSON before configuration reads,
stat/open/canonicalization or probes.
Current actor/session identity is rechecked when blocking work begins, after waiting for
management serialization, before temporary writes, and under the final auth lock at commit.
There is no client username/role authority and server admin never bypasses content ACLs.

Exactly one Content-Type field is required, with literal value `application/json`;
Transfer-Encoding is refused. Authorized absent/invalid/duplicate Content-Type is 400
before storage; credential/origin ambiguity remains neutral 404. JSON is one flat
object of string fields plus the optional t-013 boolean `ignore_non_writable_folders`;
duplicate/unknown fields, nulls, nested values, form data and any
query (including empty queries/aliases) refuse. Fields are:
- `mode`: exactly `existing` or `new`;
- `path`: **literal JSON string data**, an existing non-root selected relative directory in
  existing mode, or existing parent relative directory (empty means location root) in new mode;
- `directory`: required only in new mode, exactly one missing `DirectoryName` child;
- `slug`: existing Slug grammar, 1–64 lowercase ASCII letters/digits/internal hyphens;
- `name`: nonblank, control-free display label, at most 256 UTF-8 bytes; stored without trim;
- `confirmation`: register only, exactly 64 lowercase hexadecimal characters from preview;
- `ignore_non_writable_folders`: optional boolean, defaults to false; opt-in behavior below.

JSON escaping is decoded once as JSON; **no URL/form/recursive percent decoding or Unicode
normalization** applies to path/name values. `%2e%2e` names are literal names, not traversal.
DirectoryName/RelativeDirectoryPath reject absolute, drive, hidden, control, backslash,
empty/repeated separator and dot/dot-dot syntax without repair. An existing location root
is browse-only. New-mode parent at/inside a registered vault refuses; an ancestor containing
a registered descendant may create only an exactly nonoverlapping missing child.

| Bound | Registration/preview maximum |
|---|---|
| URI path / JSON body | 256 / 8,192 bytes |
| Relative path / component count / child name | 1,024 UTF-8 bytes / 16 / 255 bytes; final new-child path also bounded |
| Blocking admissions / retained confirmations / lifetime | 2 / 16 / 120 seconds; no admission wait queue; this pair shares a separate 12 requests per fixed 60-second budget |
| Configured locations / total resulting registered vaults | 32 / 128; exceeding bounds refuses, never truncates old configuration |
| Server config / project config / access.toml input | 1 MiB / 1 MiB / 64 KiB; regular, bounded, no symlink/special reads |
| Storage scan | 16,384 entries, 1,024 directories including selected root, depth 64 below root, relative traversal path 4,096 bytes |
| Eligible Markdown input | 4 MiB per note / 64 MiB aggregate, checked at usability scan and actual initial indexing |
| Runtime dirty paths | 16,384; overflow is explicit recovery work, not unlimited accumulation |

Filesystem/config/index preparation runs off the async executor. Checks may refuse earlier
for unavailable storage or native resource limits; these bounds do not promise universal
filesystem compatibility or a complete inventory from one root probe. Default strict adoption
fails rather than silently accepting a partial tree; t-013 explicitly permits inaccessible
child-folder omissions only when the user opts in. Metadata traversal includes hidden/dependency
subtrees and all ordinary non-Markdown files remain untouched; only visible Markdown in the
chosen notes layout is indexed. October 18 approved amendment (t-012): child symbolic links
are skipped without resolving or opening their targets, including internal/external, directory,
broken and looping links. Their entries still count toward scan limits. They do not block
adoption, appear in content catalogs/shallow folder trees, or authorize direct note reads,
subscriptions or writes. Watchers do not follow them; indexing rechecks no-link resolution
before reading bodies and drops stale rows when a real note becomes a link. A legacy Auto
vault whose notes/ becomes a link retains its namespace with no content access, rather than
falling back to root and changing ACL-relative identities. Adoption keeps the path-rule
compatibility guard for either a real or linked notes/ child, without following the link.
Root selection,
critical policy/config/storage paths and configured-root alias pinning retain existing strict
no-follow rules. Non-UTF-8 regular entries and FIFO/device/special files still refuse; no
permissions are automatically changed to make a project usable.
Depth-first metadata traversal retains the active descriptor chain, not one fd per sibling.

October 18 approved opt-in (t-013): after selecting a server folder, New vault offers an
unchecked **Ignore non-writable folders from vault** checkbox. Managed/no-JavaScript creation
keeps the default strict behavior. The folder API accepts an optional JSON boolean
`ignore_non_writable_folders` (omitted/false is strict); null, strings, numbers, duplicate
fields and compound values refuse before storage. This one boolean is the explicit exception
to the string-only request fields above. The value is part of the exact, single-use preview
selection, so changing it invalidates confirmation. A checked registration stores the boolean
in its `[[vaults]]` configuration; legacy/false values are omitted and default to false.

Checked adoption omits child directories the effective service identity cannot read, search
and write, using native access checks that honor POSIX ACLs/read-only mounts. It checks before
opening excluded directories, retains scan budgets for skipped entries/directories, and does
not inspect their descendants or repair permissions. Other I/O/resource errors still refuse.
The selected root, valid policy and required media/index/config storage remain strict; ordinary
eligible Markdown files must still pass their existing read/write checks. No arbitrary
user-supplied path exclusion or client-side permission filtering is introduced.

The persisted option is enforced by vault note lists, direct reads/writes, empty-folder and
shallow directory views, index preparation/maintenance and sync recipient rechecks. Excluded
folders cannot create navigation through deeper grants or disclose names/bodies via content
APIs. User ACL checks still precede protected reads. Permissions are reevaluated during these
operations and on restart; a newly usable folder can become eligible without data migration.
Native watchers use bounded, no-follow nonrecursive subscriptions only for eligible directories.
Directory events/full sweeps prepare replacement subscriptions off-lock before index work;
overlap preserves delivery and picks up new eligible descendants. Excluded subtrees are not
opened by watcher setup or refresh. A later vault-settings toggle/recheck UI is deferred.

Preview is **not strictly read-only**: `read_only:false` discloses operation-owned, exclusive,
random-name write/file-sync/atomic-rename/directory-sync probes, removed after checking.
Pre-existing file bytes are unchanged; directory timestamps can change. Existing-mode
scope is root, recursive note-directory traversal/write/rename, actual RDWR opening of
eligible Markdown (without reading bodies), and existing-or-nearest-ancestor media,
`.memberberry`, index/search-v1/zones directories. Hidden/non-note directories are enumerated
for safe watcher access but are not all required to be writable. New preview probes the
existing parent only, not a child it has not created. Scope strings and notes-layout metadata
are not note contents or an uncapped filesystem inventory. Service-identity failures refuse;
no chmod/chown/ACL repair is attempted, and write probes cannot guarantee future disk space
or crash/power-loss durability.

Preview success JSON is
`{confirmation, expires_in_seconds:120, mode, notes_root:"root"|"notes", read_only:false,
storage_check:"bounded_service_identity_probes", scope:"existing-parent"|"existing-project",
recursive_markdown:boolean}`. The bounded in-memory receipt stores actor/session digest,
exact selection, expiry, configuration/policy/config-file metadata and pinned directory/
registered-ancestry identity, **never note bodies**. Expired authority cannot be used;
expired retained metadata/descriptors are reaped on the next management request or teardown.
Receipts are process-local, single-use and not ongoing authority. At register, current
configuration, registry, anchors, selected existing root/new parent, notes layout, policy
state and exact parameters are re-resolved under management serialization. Expired,
replayed, other-session, mismatched or changed selections refuse. Races cannot publish
same-slug, duplicate/alias, ancestor/descendant or new-name collisions twice. The accepted
openat2/root-alias namespace limits still apply; no race-free claim against arbitrary
filesystem-owner or privileged mount manipulation is added.

Existing projects retain root layout unless a real `notes/` already exists, matching
`Vault::open`; no existing/new-mode operation creates `notes/`. A new operation uses
exclusive mkdir for only its missing child and never adopts an existing collision.
A valid existing `access.toml` remains byte-for-byte intact, even if it excludes the admin.
Malformed/unreadable/symlink policy refuses. Only genuine absence permits an exclusive
random temporary, file sync and NOREPLACE rename installing authenticated creator Owner,
with no anonymous grant; an externally appearing policy is never overwritten. The normal
fixed overwriteable AccessFile temporary is not used for adoption.

Before commit, failures clean only identity-and-current-byte-matched owned policy/probe/
config temporaries. Existing project trees are never recursively deleted. A new-root rollback
checks directory identity and uses empty-only rmdir; foreign files, replaced roots or edited
artifacts are retained and reported as unavailable/residual, not deleted. Prior configuration,
registrations, media/credential values, Markdown and non-Markdown contents remain intact.
The **commit point is successful atomic config rename** after synced preparation and final
config-parent/config-file/layout/selection/current-actor revalidation. Live registry, policy,
ready in-memory index and watcher publication follows under short publication locks; expensive
indexing holds no global auth/registry lock. HTTP waiter cancellation may abort before mutation,
but cannot strand an already committed disk registry without live publication.

New external roots enroll a real staged recursive watcher **before** final enumeration and
privileged internal initial indexing. Events collected during preparation are isolated and
then relayed to the live signal at publication, closing the enrollment/index gap. Exact-root
runtime ownership/deduplication retains external roots even when a managed-parent watcher
also exists; server watcher-lease teardown stops listeners. An inactive/unusable lifecycle
refuses registration. Create/change/remove/policy events drive normal permission-filtered
index/sync maintenance without a restart; a periodic recovery sweep is not watcher proof.
Server shutdown stops the maintenance timer and joins an in-flight blocking maintenance job
before watcher teardown and final flush; aborting only its async waiter would detach a writer.
Lifecycle/shutdown regressions use a real ephemeral HTTP listener, notify callbacks and
explicitly disabled recovery sweeps, not manually supplied watcher signals.
Initial indexing is privileged internal maintenance, never preview content rendering or an
unfiltered public query helper. No existing derived index files are overwritten precommit:
newly adopted indexes are ready in memory until normal restart reconstruction; subsequent
normal index/search APIs still enforce repository/index-layer ACLs.

Register success JSON is `{slug, committed:true, directory_synced:boolean, audit_recorded:boolean,
watched:true, index_ready:true, index_storage:"memory_until_restart"}`. `audit_recorded` is
true **only for an actual successful append**; an absent optional writer reports false,
without making an audit writer a registration prerequisite. A post-rename directory sync
or actual audit append failure still completes committed live publication and reports its
false flag; it is **not** a precommit rollback or a claim of durable crash recovery. Unexpected
postcommit failures must not delete registered storage. Errors are no-store JSON `{error:code}`:
404 `not_found` (authorization/origin/unknown location), 400 `invalid_request`, 409
`confirmation_conflict` (stale receipt/identity/policy/overlap/collision), 422 `limit_exceeded`,
429 `busy`, 503 `storage_unavailable` (including unsafe policy/lifecycle) or `cleanup_incomplete`
(ownership-safe residual failures). They contain no absolute paths, note titles/bodies,
credentials, OS diagnostics or configuration dumps. Existing managed `/vaults/new`, CLI,
legacy config/media schemas and all GET discovery contracts remain unchanged.
Authentication itself runs in the same two-permit bounded blocking budget, not on the async
executor. Unverified admission overflow is neutral 404; the separate 12/minute rate budget
is charged only after successful current-admin authentication. A revocation queued during
final atomic commit waits for coherent publication. If authority is gone at the worker's
final response check, the caller receives neutral 404 even though that commit remains live.

**Configured-folder browser, t-003 (implemented for review):** `/vaults/add` is an HTML
entry, not an additional registration API. The vault-list Add vault link and HTML handler
reuse the registration boundary's strict session/current-enabled-admin predicate. HTML
checks use a nonwaiting auth try-lock and fail closed on contention; authority is repeated
inside the blocking HTML read and before publication. A missing/unusable build returns
neutral no-store 503 HTML. The regular UTF-8 HTML bundle is capped at 256 KiB with a capped
read, nonblocking/no-follow opening on Linux. Requests lacking current authority at entry
do not look up the bundle or configured locations. Public self-hosted JS/CSS assets contain
only interface code; the bare
HTML filename is not a public route. The actual CSP permits only self scripts/connections,
self stylesheet assets and shared inline fallback tokens; no inline script, external
network, upload/copy operation, schema change or content authority is added.

**UI simplification approved by Paul on October 10, 2026; implemented for review: t-004,
amending the t-003 interface.** The main form contains the vault label, the selected folder
and, for creation, a single new folder name. A **Choose folder** button opens a Sonarr-style
folder-browser dialog: configured server location, current relative path, parent/child
navigation, plain folder-name rows, **Cancel** and **Use this folder**. Both modes use that
same selection label. The dialog stays within configured locations; a relative-path input
may navigate only validated literal paths in the selected location. It is not an arbitrary
server-root file browser. Available folders have no "Available" badge or replacement status
jargon; unavailable/registered boundaries remain disabled with a short useful explanation.
Keyboard focus is contained while open, Escape/Cancel restore opener focus, and mobile
layout/touch targets remain usable. Selecting or cancelling a folder never writes/probes.

There is no editable **Vault address** field. Memberberry still requires a route slug,
so the browser derives an internal lowercase ASCII slug from the label with a short
cryptographically random suffix, within the existing 64-character grammar. Non-ASCII-only
labels use a "vault" base; labels themselves and filesystem path/name tokens remain exact,
without trimming, normalization or repair. The suffix avoids needing an unfiltered catalog
or revealing private vaults to determine uniqueness; server collision refusal remains final.
Generate one stable slug for an unchanged form intent, freeze it with the submitted selection,
and use identical bytes for preview and register. It is not a content-access credential.

The main action is **Add vault**. Remove the technical paragraphs under the former address
field and the manual **Check storage and review**/separate confirmation stage. Submission
is explicit create/register intent: validate the form, run the existing server usability
preview automatically, validate its schema/expiry, then consume its single-use receipt in
one register request for the identical selection. Do not probe during browsing or typing.
Any preview refusal prevents registration and returns concise, sensible guidance with the
label/folder context intact. A double submission must not send duplicate preview/register
writes. Editing/changing context while validation is pending, cancellation, expiry or teardown
invalidates the pending intent and aborts/fences publication; a late response must not register
an older selection. BFCache remount cannot revive pending intent or receipts. The selected
literal path remains visible before submission; detailed Markdown-root/storage/policy facts
may be available as optional collapsed help, not a wall of prerequisite text. Recursive
Markdown/layout rules, policy preservation and service-identity temporary write probes above
are unchanged; **Add vault** authorizes those automatic validation probes as part of submission.

Successful registration distinguishes content access from registration and obtains an open
link only from the normal permission-filtered vault catalog. Independent directory-sync/audit
outcomes must not be described as rollback; secondary technical facts can be collapsed.
Network/schema loss and register 404/503 remain **possibly committed**, with visible no-retry
and exact sent folder/label intent, never an automatic or in-place register retry. Read-only
status can report the exact folder is registered, not which request completed or that content
is readable. Disposed-aware authoritative denial on every administrative read, including
outcome status, precedes ordinary generation filtering and fences newer success/failure without
hiding possibly committed state (t-003 R1/R2 invariants). Verified commit, verified precommit
refusal and never-sent preview remain distinct. Explicit precommit400/409/422/429 refusals keep
context and permit only a fresh user submission/preview. Safe return links preserve managed
New vault and CLI/media behavior. The server API, receipt, policy, storage and atomicity
contracts above are unchanged.

##### Shallow browser and simple picker — backend reviewed, UI implementation active: t-005/t-006

Paul approved both the setup picker and in-vault browser on October 11, 2026; `.txt`
support is explicitly outside this slice. Native OS watching, exclusions, periodic index/
recovery reconciliation and Tasks/search discovery are unchanged. Shallow here describes
one UI navigation request, not a new whole-app indexing policy. The following amendment
supersedes t-004's create-at-registration controls and automatic note-root selection for
**new project-folder registrations only**; old accepted/reviewed receipts remain historical.

- The setup dialog heading is the current directory basename (configured location label at
  its root). It contains **Add folder here** with a folder-plus icon/name prompt, a parent
  arrow only when an allowed parent exists, immediate child folders, **0 folders found**
  when none, **Cancel** and **Use this folder**. One configured location needs no redundant
  selector; multiple locations retain a labelled switch. No mode toggles, Available badge,
  manual review or technical Details wall. Necessary refusal/registered-boundary guidance
  remains concise. Configured location root is still browse-only; no arbitrary server path.
- **Add folder here** explicitly creates one real child immediately through
  `POST /api/v1/vault-locations/{id}/directories`, JSON exactly `{path,directory}` with no
  query. It reuses E29's strict current signed-admin and same-origin/header boundary, bounded
  work and management serialization, descriptor-relative no-follow containment/identity
  revalidation and overlap protection. Collisions never overwrite/adopt. It creates no
  vault registration, ACL or index. Success is `201 {path,created:true,directory_synced:boolean}`
  after exact created-child identity readback. Sync failure is not rollback. Failures clean
  only an owned, still-identical empty child; ambiguous post-mkdir outcomes are possibly
  created and never blindly retried. Folder creation persists when the picker is cancelled.
- **Use this folder** chooses the exact current selectable directory. The main form keeps
  vault label, folder selection/Choose folder and **Add vault**; generated internal slug,
  automatic submit-time validation, single-use receipt and all registration R1/R2/F1
  denial/no-replay/sent-uncertainty invariants remain. After immediate mkdir, registration
  is existing-folder mode against that created directory. Browsing/typing/selection do not
  mutate; only explicit folder creation and Add vault do. Sent mkdir uncertainty also
  retains its exact parent/name across remount, independent of stale read generations.
- New project-folder registrations persist `notes_layout = "root"` in their `[[vaults]]`
  entry. This typed setting makes storage checks, preview, initial index, live Vault and
  restart use the exact selected root even if `notes/` exists or is later created. Omitted
  setting retains legacy `auto` behavior (`notes/` if present, root otherwise); unknown
  setting values refuse. Existing entries, managed creation, CLI behavior and media/config
  are preserved. Files/ACLs are not moved or repaired. Markdown remains canonical on disk.
- **Permission-layout compatibility guard — approved October 11, 2026, t-005 implementation independently reviewed:**
  existing-folder adoption refuses when the exact selected root contains both a real immediate
  `notes/` directory and an existing selected-root `access.toml` with any parsed path-specific
  rules. Even an intentionally root-relative rule is conservatively refused: Memberberry must
  not guess the old policy base or let `Private.md` stop protecting physical
  `notes/Private.md`. Only the selected root's policy is authoritative; no parent/nested
  policy fallback or automatic rule translation. No policy/file move, rewrite or permission
  migration is authorised. No real `notes/` directory, no existing policy, or a valid policy
  containing only vault-wide memberships does not trigger this guard; other existing
  safety checks and malformed-policy fail-closed behavior remain unchanged.
  Validate through the existing pinned descriptors and bounded (64 KiB) policy parser,
  without descendant enumeration, note-body reads or effective-role comparison scans.
  Check before preview storage probes/receipt creation, on confirmation and at repeated
  preparation/final precommit revalidation, before any durable registry rename or live
  publication. A previously valid confirmation cannot bypass a newly added `notes/` or
  path-specific rule. The incompatibility yields a content-free `409`/no-store refusal
  after strict current administrator authorization, with concise permission-layout guidance;
  it must not disclose rule paths, principal names, note names/bodies, absolute paths or
  policy/config contents. No registration, index/policy/watcher publication or pre-existing
  file mutation follows refusal. Temporary artifacts clean up only under existing owned-only
  guarantees. Legacy registered Auto/managed/CLI entries are not reinterpreted or migrated.
  This guard is part of E29 and has permanent refusal/revalidation and permission-leak tests.
- **Current platform limit:** the shallow-directory endpoint below is compiled only on
  Linux. Other native server builds return 404, so Open in main panel cannot load folder
  contents there. Sidebar rename/delete and note editing do not use that endpoint.
- `GET /api/v1/vaults/{slug}/directory?path=<form-encoded-literal-token>` returns exactly
  `{path,folders:[{name,path}],files:[{name,path}]}` from the permission-filtered repository.
  It lists only the requested directory's immediate real visible folders and regular `.md`
  files, sorted by exact name within each array, without titles, bodies or descendant
  enumeration. Hidden, unsupported, symlinked or unrepresentable entries are omitted.
  Root uses empty path. Invalid/traversal/absolute/hidden tokens refuse; no token repair.
  Current content ACL and directory identity are checked before I/O and before publication;
  admin status grants no bypass. Folder metadata requires a readable folder path or a
  necessary existing deeper readable grant; explicit denial is absorbing and an absent
  grant target never manufactures discovery authority. Ordinary directory metadata does
  not imply permission for any descendant note. Denied/missing paths are neutral.
- Shallow listing bounds: 1024-byte/16-component relative path, at most 4096 iterator entries
  (no unbudgeted lookahead), 128 returned entries and 64 KiB JSON; overflow refuses without
  partial list. Blocking filesystem work stays off the async executor with bounded job
  admission and no unbounded queue. No listing request calls the recursive note catalog or
  empty-folder traversal merely to enumerate its directory.
- In-vault folder navigation fetches that shallow listing, folders before Markdown files;
  file activation opens the existing editor. Heading, folder-plus, conditional parent and
  **0 folders found** follow the simple browser. Folder creation uses existing exact-path
  editor/owner checks. New note from this view targets the current folder. Sidebar/catalog,
  Tasks/search, offline dirty-note preservation and existing legacy vault layout remain.
  Permission refusal clears stale names; older success/network failure cannot resurrect
  them. Every request/effect tears down, native desktop/mobile focus and keyboard behavior
  remain tested. `.txt`, general file management and exclusions/reconciliation optimisation
  are separate future work.

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
| E2 | **WebSocket doc subscription** | A client may subscribe only to docs it can read. A document's room is keyed by the note's *canonical identity*, never by the name the client sent: one file is one room and therefore one writer. A schema-admitted wire subscription imports an external Markdown change before its first full-state snapshot; any resulting update to existing peers passes E3's current recipient check. |
| E3 | **WebSocket update frames** | Every incoming update is authorized *per frame*, not once per connection — and so is every **outgoing** one. A room admits a peer once; each broadcast re-asks whether that recipient may still read the document, and drops it from the room if not. A viewer's frames are **rejected with an error**, never silently dropped — the client must know it is read-only. A caller who cannot read the note at all gets the neutral denial below instead, because `read_only` would confirm the note exists. |
| E4 | Awareness / presence | Broadcast only to users who can read that document, re-checked per frame exactly as E3 is. |
| E5 | Index queries | Every SQLite/Tantivy query carries a readable-set or path-prefix predicate. There is no unfiltered query helper in the codebase. **M8:** `mb-index` exposes no connection; queries live on a `Reader` that cannot exist without a user and an ACL, and read every content table through a view that joins a per-reader readable set. Two tests hold it: one fails if a read path names a base table, one fails if a view stops joining the set — because the filters are individually sufficient for today's queries, so no behavioural test can see the second one go. |
| E6 | Client search index | Assembled per user from permitted zone segments (§14.2). The client never receives data it may not read, so it never filters. **M9:** every indexed note is assigned to its deepest matching maximal zone and one binary-v1 segment is published under `.memberberry/index/zones/` per zone. `Reader::client_segments` is the only assembly surface: it captures the permitted `(zone_id, acl_hash)` pairs from the live ACL and returns bytes only when both still match the published snapshot. `GET /search/segments` carries that manifest; the binary endpoint repeats both checks, so a stale manifest cannot retrieve a changed epoch. The browser transactionally removes absent or changed epochs before fetching, validates every binary through `mb-search` in WASM, and refuses a late response whose manifest entry was revoked. A partial rebuild, stale permission epoch, non-member or malformed persisted zone fails closed to no bytes. |
| E7 | Transclusion | Resolved against the requesting user's readable set; unavailable targets render as "unavailable" (§9.2). **M8:** three filters on `…/embed/{target}` and `…/resolve/{target}`, in order — membership plus a readable *source* note, because `from` steers §4.3's nearest-path tie-break; resolution against this caller's readable set, so an unreadable target is not a candidate (E9); and the read back through the repository, because the index says *which* note and never that it may be read. A missing target and an unreadable one are the same empty-handed reply, so the placeholder cannot say which. The second filter is defence in depth and **no behavioural test can observe it** — see `HANDOFF.md`. |
| E8 | Backlinks & unlinked mentions | Filtered by readable set — titles leak otherwise. **M8:** a backlink from a note the caller cannot read is absent, and an unreadable *target* has no backlinks because it does not exist for them (§6.5); the route answers a denial exactly as it answers an unknown vault. **M9 adds unlinked mentions to the same response and the same three filters**, with the readable set entering the Tantivy query as a required exact-path clause rather than filtering its results (E5). A mention discloses more than a backlink if the filter is lost — a backlink row leaks a title and the block a link sits in, whereas a mention has no link to have been found by, so what puts it on screen is only that a private note happens to use a word, and the row then quotes that note's prose. It is a second code path (Tantivy, not SQLite) to the same data, so it has its own leak-suite case. |
| E9 | Graph | Nodes and edges filtered by readable set; edges into unreadable notes are dropped entirely. **M8:** link resolution draws candidates from the filtered view, so an edge into an unreadable note is never formed — which also means one link can resolve differently for two users (§9.1). The local-graph route (§9.4) is the same three filters as `backlinks`: membership plus a readable *origin* through `AuthorizedVault` (E1), a `Reader` built from the live ACL so every node comes from the readable set (E5), and resolution against readable candidates only. What is left is a **ghost** — an unreadable target and one nobody has written are one node, one shape, one label taken from the source note's own text, because §6.5 does not allow the picture to tell them apart. An unreadable origin answers exactly as a missing one does. **M8, the whole-vault route** (`GET /api/v1/vaults/{slug}/graph`) has no origin to resolve, so its filters are membership on the vault and the readable set — every readable note is a node and nothing else is. Two things it discloses that the neighbourhood does not, and both are filtered: a node carries the note's **tags** and its **word count**, and the reply carries a **total** so a capped picture can say "showing 2,000 of 10,431". The total is counted over the readable set, because a count of the whole vault is a way of asking how many notes exist (§6.5). |
| E10 | History & versions | Same role as the note. |
| E11 | **Media** | Content addressing is *not* authorization. `media_refs(note_id, path, original_name)` backs the check: a user may fetch a blob only if it is referenced by a note they can read, including a frontmatter `cover` image (§12.5). The sole pre-reference exception is a five-minute grant scoped to the authenticated editor who uploaded those same bytes, bridging the upload and the note's indexed save; it never grants another user access. Easy to miss; it is a real leak if missed. |
| E12 | Tasks & task views | Filtered by readable set. |
| E13 | Share links | A separate anonymous path with its own rules (§17). The authenticated management routes authorize the exact note before creation and scope listing/revocation to the creator; bearer tokens are never returned by list. The `/s/<token>` renderer re-authenticates the opaque token, then re-checks the link creator's current enabled account and readable set before reading the note. Its media route requires the signed share-session cookie, re-checks the same creator-readable set, and permits only media referenced by the shared note. Expiry, revocation and password failures are neutral unavailable responses. Anonymous share and media requests are bounded independently by token and by the trusted peer IP supplied by the server connection layer; forwarded headers are not trusted. |
| E14 | **Rename / link rewrite** | §6.6. **M8:** the one operation that reads outside the caller's readable set, on purpose — a link left broken in a note they cannot see is worse. What contains it: the note being renamed is resolved through the *caller's* `AuthorizedVault`, so an unreadable one answers exactly as a missing one; both ends need `editor` or better, and a tag or custom emoji rename needs vault-wide `owner`; the privileged read is an ordinary index `Reader` holding a synthetic `owner` ACL, so E5 is untouched; and the reply counts only notes the caller can read, with the full list going to the audit log (§6.9). Shape checks on the new name run *before* authorization, existence checks after, so a rename cannot be used to probe for notes. Folder moves also require write access at both paths for every descendant before mutation, with neutral denial for hidden descendants and symlinked paths; empty folders use the same checks. |
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
| E28 | **Empty folders** (§8.2) | `GET /api/v1/vaults/{slug}/folders` requires vault discovery access and returns only physically empty directories the caller can read, through `AuthorizedVault::empty_folders`. Existing readable empty folders also permit discovery for a path-only reader. Traversal prunes denied subtrees before filesystem reads, while preserving valid deeper grants under default-denied ancestors; explicit denials remain absorbing. Hidden directories and symlinks are excluded. Nonempty folders remain inferred from readable notes, so a folder containing only denied notes remains invisible. `POST` requires editor-or-owner on the requested folder path before any filesystem lookup, validates containment, and refuses existing paths without overwriting. A denied existing and absent path give the same response. |
| E29 | **Project-folder vault discovery, registration and New vault HTML** (§6.1; backend independently reviewed; t-003 interface implemented for review) | `GET /vaults/new` and compatibility `GET /vaults/add` (including bodyless HEAD) are enabled-current-signed-admin HTML entries, filtered before bundle/config/open/stat/probe work; authority is repeated in the blocking read and before publication. The New vault action is server-filtered. Neutral no-store 404 **HTML** is distinct from the existing no-store 404 **JSON** API refusal. Public content-free static JS/CSS assets do not authorize discovery, registration or content; the bare `add-vault.html` bundle is not a public HTML route. `GET /api/v1/vault-locations` and its `/{id}/{directories,status}` read routes plus JSON `/{id}/{preview,register}` POST require a current enabled signed-session server administrator before config/open/stat/canonicalization/discovery/probes. Scoped Bearer or any Authorization header, including alongside a valid cookie, never authorizes management. Both POSTs require unique session authority across all Cookie fields, unique Origin/Host/Content-Type, zero or one Sec-Fetch-Site, literal authority/raw-Origin validation, same origin and reauthentication after waiting and at commit. Identity-bound, expiring single-use confirmations and exact literal input/whole-tree budgets enforce duplicate/alias/ancestor/collision boundaries. Policy preservation includes the approved t-005 S1 compatibility guard: real immediate notes/ plus an existing selected-root ACL with any path-specific rules refuses adoption at preview and repeated confirmation/precommit checks, without policy translation or permission broadening; bounded validation and content-free authorized 409/no-store refusals are leak-tested. The t-013 opt-in is a receipt-bound persisted boolean: native effective-user permission failures on child folders may be skipped, with required root/policy/storage checks retained and excluded descendants absent from all content/index/tree paths and watcher setup/refresh. Real unprivileged no-read observers, strict-off/checked-on controls and a changed-option receipt refusal cover it. Child symbolic links are skipped during adoption without target reads; E1/E5/E30 catalogs, direct content and index reads exclude them, including aliases within the vault. Critical policy/config links still refuse. Atomic config commit, owned-only rollback and live watcher/index publication do not grant content access. E29 real-session/origin/inotify tests include authorized positive controls; no private note names/content, absolute paths or config secrets appear in denials. Registered roots stop read traversal/enumeration and existing-policy-no-admin-content stays neutral on normal filtered APIs. |
| E30 | **Shallow vault directory browsing** (§6.1; backend reviewed, t-006 UI implementation active) | Immediate folder and `.md` names are read through `AuthorizedVault` with the current caller/ACL, never through an unfiltered feature helper or admin bypass. Denied/unknown directory or vault is neutral. Permission filtering precedes filesystem reads of denied paths and response publication; no titles/bodies, descendant enumeration, symlink/hidden traversal or stale-authority publication. Necessary deeper-grant navigation cannot reopen an explicit denial or manufacture access from absent targets. The persisted t-013 native folder filter is applied after content authority and before excluded-directory reads/navigation. Bounded work/output refuses without partial disclosure. |
| E31 | **Immediate configured-location folder creation** (§6.1; backend reviewed, t-006 UI implementation active) | Strict enabled signed-session-admin and same-origin/header authority precedes config/filesystem work; repeat after waits and at mkdir/publication. One exact child under a pinned allowed parent, no-follow beneath configured root, current registry/identity checks and no collisions/overlaps. No content grant, ACL/registry creation or registration receipt. Owned-only cleanup; post-create ambiguity never implies rollback or safe replay. Readback verifies the exact child identity before success. |
| E32 | **Folder deletion** (§8.2) | `DELETE /api/v1/vaults/{slug}/folders` takes `{path, confirmation?}` with an 8 KiB body limit. `AuthorizedVault::delete_folder` requires editor/owner on the folder and every descendant before disclosing confirmation requirements or mutating. Unknown, denied, unsupported, hidden, symlinked and excluded trees receive the same neutral 404; server admin grants no bypass. Full preflight is bounded to 100,000 entries. Any actual note/subfolder requires the exact basename (409 otherwise); empty folders need no confirmation. Every sync room closes before note files move to the existing Markdown trash, followed by nonrecursive directory removal, index reconciliation and deletion auditing. I/O errors can leave partial deletion and return a generic no-store refusal; the client refreshes before retry. |
| E33 | **Vault settings and emoji management** (§20.4, §11.2) | `GET`/`PUT …/settings`, `DELETE …/emoji-entries/…` and emoji renames require vault-wide `owner`, checked per request from the live ACL. Editors, viewers, non-members and server admins who are not owners get the same 404 as an unknown vault, with no setting or emoji name in the body and nothing written. Shared server emoji answer as missing on the vault routes. Emoji renames are E14 privileged rewrites, and the reply counts only notes the owner can read. The `data-vault-owner` bootstrap flag only controls whether the dialog is offered. |
| E34 | **Desktop embedded server** (§7.6.2, §7.6.8; built, M19 slice 1) | Binds `127.0.0.1` only, on a port remembered per installation. The host opens the window at `/desktop/launch?code=<256-bit CSPRNG code>`; the code is compared in constant time and **works once**, then the window holds an `HttpOnly; SameSite=Strict` `mb_desktop` cookie (a second 256-bit secret) that every HTTP request and WebSocket upgrade must carry. `Host` must equal `127.0.0.1:<port>` and `Origin`, when present, `http://127.0.0.1:<port>`, so another local process and a DNS-rebinding page are refused. Every refusal is one identical `403`, except that a callback matching no pending attempt (§6.8.1) is told to connect again. The guard is outermost, so a refused request reaches no handler, asset or fallback. Neither secret is written to disk or logged. Only then does the guard sign the window in as the local user (S11). Tested in `tests/desktop.rs` and the leak suite. |
| E36 | **Device authorization and device tokens** (§6.8.1; built, M19 slice 2a) | The approval page and its POST require a signed session (POST also same-origin). `redirect_uri` is exactly `http://127.0.0.1:<port>/desktop/connect/callback`, checked before rendering and again on POST. Codes are stored hashed, single-use (spent by the first exchange attempt), bound to user, redirect URI and S256 challenge, valid 60 s; every exchange failure is one `400 invalid_grant`, rate-limited per address. A device token authenticates only through the content filter as its user and never as a server administrator; a disabled user's tokens fail; revoked tokens fail on the next request. As its user, a device token keeps that user's bookmarks and saved layout and manages that user's share links, behind the same membership and role checks as a browser session; a vault API token still cannot manage share links. Leak suite: a device reads exactly what its user reads, a device token on an administration route is refused, a code replayed or exchanged with the wrong verifier or redirect URI yields nothing. Leak suite `e36_a_devices_bookmarks_layout_and_shares_are_its_users_and_filtered_like_them`: none of these reaches a vault its user is not in, a view-only user's device shares nothing, and one user's layout is not another's. **On the sync socket** (built, slice 2b): a device token opens it as its user, is re-authenticated on every frame like an API token (E3), may write only where its user edits, and a revocation denies the next frame on an already-open socket — leak suite `e36_a_device_syncs_only_what_its_user_reads_and_dies_with_its_revocation`. |
| E37 | **Desktop forwarding of server vaults** (§7.6.10; built, M19 slice 2c) | The embedded server forwards only paths under a registered server vault (`/api/v1/vaults/{slug}/…`) and that vault's sync frames, only to the origin that vault was registered from and only while this device is signed in there (§7.6.11), with that origin's device token as the only credential. The request's `Cookie`, `Authorization`, `Origin` and `Host` are never forwarded; upstream's `Set-Cookie` is never returned. Local vaults, administration, desktop and device routes are never forwarded. Leak suite: a forwarded request reaches upstream without this app's cookies; a local vault's route is never forwarded; a non-registered slug is never forwarded; upstream's denial reaches the window unchanged; with two servers, each vault's requests reach only its own server with only its own token; a signed-out server's vault is never forwarded; a kept copy is never synced under another account. |
| E38 | **OIDC sign-in** (§6.8.2; built, M20a) | `state` is 256-bit, single-use, bound to a cookie, valid 10 minutes; PKCE S256 and `nonce` are required. The ID token's `iss`, `aud`/`azp`, `exp` and `nonce` are all checked, and the token only ever comes from the configured token endpoint over TLS. An account is linked only by (`iss`, `sub`) or, the first time, by an `email_verified` email equal to exactly one account's email; never by username, never by an unverified email. A provider sign-in never makes an administrator. `redirect_url` comes from configuration, not the request. With `password_login = false`, `POST /login` is refused. Leak suite: a forged or replayed `state`, a wrong `nonce`, a wrong audience, an expired token and an unverified email each yield no session; a linked account keeps its access; a new account has none. |
| E35 | **Replica revocation purge** (§7.6.6, §7.6.7; built, M19) | On every pass with a complete upstream list, a note no longer in the readable set — deleted, moved out of reach, access removed — loses its file, CRDT sidecar, metadata row, search postings, its own pin and any media no remaining note here shows, and the local index is then scrubbed (`secure_delete`, a WAL checkpoint and a search-segment merge) so no bytes of it remain. It is purged, never sent to the local trash. A note changed here first becomes a recovered note (§7.6.7) holding the whole note as this device had it, minus its frontmatter `id`; it is never uploaded without the user's choice, and its own sync frames and listing are answered by the app, never forwarded. A vault the user can no longer read at all (gone from upstream's vault list) is settled the same way note by note, then stops being a server vault: kept as a vault on this device if anything was recovered, removed with its folder if not; its record, pins and upstream listing are deleted. A note that left an incomplete list is left alone; a note created here that upstream refused is still held, not recovered. Leak suite: `e35_a_revoked_note_leaves_no_trace_and_offline_edits_stay_on_this_device`, `e35_media_follows_the_readable_set_and_its_address_grants_nothing` (a revoked note's image leaves; an image address typed into a note here fetches nothing the user cannot already see), `e35_a_vault_the_user_was_removed_from_leaves_only_their_recovered_notes` (every file in the replica scanned for the note's title and body). |

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

**Requested coordinated admission contract (development upgrade; not a claim of deployment).**
The private native-Code revision-2 correction does not integrate the separate historical
schema-2 namespace/admission candidate. Revision handshake, all-node attribute validation,
pending-state refusal and prospective browser-cache admission remain prerequisites for
that later package; keep its guards intact and rebind them to its actual schema revision.
E2 must check the actual Rust-owned editor schema revision after note authorization and
before opening/publishing CRDT bootstrap; a mismatched editor requires refresh without
receiving note state. E3 must validate the complete prospective merged document before
appending the sidecar, changing live state or broadcasting a persisted echo. Validation
includes declared node/mark names, all supplied attribute names and their schema types,
not merely successful Markdown materialization. Undeclared fields and scalar payloads for
object-valued native marks are invalid even when the decoder could ignore them. Preserve
valid optional/default attributes, authored link titles, native mark-removal semantics and
all supported finite styles; do not silently strip or normalize malformed candidate state.
An authorized current-revision writer's invalid candidate receives `invalid_update` with
live and durable state unchanged. E2/E3 permission/invisibility rules still take precedence;
shape errors must not reveal a note to a caller who cannot read it. Browser restored and
incoming state is checked prospectively before the installed binding can mutate it, with
live/view/IndexedDB bytes and pending edits retained on terminal refresh refusal. This
contract requires focused wire/permission/leak and actual Rust/WASM/browser parity tests;
a positive style/save/reopen tracer alone does not certify the boundary.

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

Folder moves use the same E14 endpoint with `kind: "folder"`. Both folder paths and every
descendant's old and new path require editor-or-owner before mutation. Hidden or symlinked
subtrees are refused; a denied existing and absent folder share the neutral refusal.
The server plans simultaneous link rewrites under the named system principal, then moves
the directory and sidecars; only readable rewrite counts reach the caller. See §8.2 for the
gesture, destination ACL inheritance and refusal behavior.

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

- **Provider groups lag the provider (M20b).** Group memberships are those of a person's latest
  sign-in. Removing them from a group at the provider removes the group's access at their next
  sign-in through it; until then, existing sessions keep it. When that cannot wait, an
  administrator disables the account (a disabled account has no groups and cannot sign in).

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

### 6.8.1 Device sign-in (A44)

**Status: built (M19 slice 2a).** How the desktop app (§7.6) gets a
credential for a user's server **without ever seeing their password**. It is the loopback
authorization-code flow with PKCE that desktop apps use against an identity provider
(RFC 8252), served by Memberberry itself. The user approves the device on their own server,
in their own browser, signed in however that server signs people in. That is why it was
built before OIDC (A44): when OIDC arrives, only the server's sign-in page changes, and the
device flow keeps working unchanged.

```
desktop app                         user's browser                    user's server
POST /desktop/connect  ──opens──▶  GET /devices/authorize ?redirect_uri&state
  (server URL; makes state,           &code_challenge&name  (signed session; sign in first
   PKCE verifier)                     if needed) ── Approve ──▶ one-time code, 60 s
GET /desktop/connect/callback ◀──303── redirect_uri?code&state
  ── POST /api/v1/devices/token {code, code_verifier, redirect_uri} ──▶ device token
```

**The server side (E36).**
- **`GET /devices/authorize`** needs a signed browser session. Without one it shows the
  sign-in form, and signing in returns to the same authorization request (the form's `next`
  accepts only a `/devices/authorize?…` path, so it cannot become an open redirect). The page
  names the device, the account and the consequence — the device can read and edit
  everything this account can, until it is revoked — with **Approve** and **Deny**.
- **`redirect_uri` must be exactly `http://127.0.0.1:<port>/desktop/connect/callback`**: the
  numeric loopback address, a port from 1 to 65535, that path, no query, no fragment.
  Anything else is refused before the page renders, because a code sent anywhere else is a
  credential handed to whoever runs that address. `code_challenge_method` must be `S256`;
  `state` and `code_challenge` are 43–128 URL-safe characters; the device name is 1–64
  characters with no control characters.
- **`POST /devices/authorize`** requires the signed session and same origin, and repeats every
  check. Approve stores a one-time code (its SHA-256, never the code), bound to the user, the
  redirect URI and the challenge, valid for 60 s, and answers `303` to
  `redirect_uri?code=…&state=…`. Deny answers `303` with `error=access_denied`.
- **`POST /api/v1/devices/token`** takes `{code, code_verifier, redirect_uri}` and needs no
  cookie. The code must exist, be unused and unexpired, its redirect URI must match, and
  `BASE64URL(SHA-256(code_verifier))` must equal the stored challenge, compared in constant
  time. The code is spent by the first attempt, success or not. Every failure is the same
  `400 {"error":"invalid_grant"}`. It is rate-limited per client address. Success returns a
  **device token** and the account's username and display name.
- **A device token** is `mbd_` plus 64 hex characters from the CSPRNG, stored as its SHA-256
  with the user, device name, creation and last-use times. Sent as `Authorization: Bearer`,
  it **acts as its user on content routes** — every vault the user can read, with the role
  they have there, through the same `AuthorizedVault` filter as a session. It is **never a
  server-administration credential**: administration authenticates only signed sessions
  (E26, E29), so a device token on an administration route is refused. A disabled user's
  devices stop working at once.
- **Revocation.** `DELETE /api/v1/devices/self` revokes the presenting token (the app's
  Disconnect). `memberberry device list <username>` and `memberberry device revoke <id>`
  revoke one from the server, for a lost device. Resetting a user's password revokes all
  their devices, as it should if the account may have been compromised. Approval and
  revocation are audited (§6.9).

**The desktop side** is §7.6.8's local server, reached from the vault picker's **Connect a server** and the workspace footer's **Servers** (several servers, §7.6.11):
- `GET /desktop/connect` shows the address form or the waiting page; once a server is
  connected and nothing is waiting, it redirects to the vault picker, which lists the
  servers. `GET /desktop/connect/new` is the address form for another server.
  The waiting page re-checks every 3 s with a `Refresh` header, since its CSP forbids
  script. Its **Open the sign-in page** button posts to `POST /desktop/connect/open`, which
  hands the live attempt's approval URL to the host's `Browser` (the default browser) and
  returns to the waiting page; it opens nothing once the attempt has expired. The window
  never navigates off its origin for this: the host cancels such a navigation, and a
  cancelled navigation also cancels the refresh, which once left the window showing an
  attempt that had long expired. `POST /desktop/connect` starts an attempt: a fresh 256-bit
  `state` and PKCE verifier, valid 10 minutes, one at a time. `POST /desktop/connect/cancel`
  abandons it; disconnecting a server (§7.6.11) revokes the token on the server first, then
  forgets it, and says so plainly when the server could not be reached.
- `GET /desktop/connect/callback` is the one path E34's guard admits without the desktop
  cookie, because the user's browser arrives there, not the window. The pending attempt's
  `state`, compared in constant time and spent on first use, admits it instead. Any other
  callback, such as an approval given after the attempt expired, gets a `403` telling the
  user to connect again from the app; the text is the same whether or not an attempt is
  pending, so it reveals nothing. It exchanges the code and keeps the token in the OS
  keychain under the server's origin (`SecretStore`), read once per run and then held in memory (`CachedSecrets`: macOS asks the user to allow every keychain read by an unsigned or development build, and the sync loop needs the token every few seconds), and the server, account and device id
  in `desktop.toml`.
- The server address must be `https`, or `http` to a loopback address; a device token never
  crosses a network unencrypted. TLS uses the bundled public roots, so a server behind a
  self-signed certificate cannot be connected to yet.
- **Not yet:** `memberberry device revoke` asks for an administrator's password, which an
  OIDC-only administrator will not have (M20). (The sync WebSocket accepts a device token
  since slice 2b; see E36.)

### 6.8.2 Sign-in through an identity provider — OIDC (A47; M20a and M20b built)

The server can delegate "who are you" to the user's own OpenID Connect provider — authentik,
Keycloak — and through it to Google and the like. C1 holds because the server only ever
talks to the provider the operator configured; it never calls Google itself.

- **Configuration** is a `[oidc]` table in `server.toml`: `issuer`, `client_id`,
  `client_secret`, `redirect_url` (this server's public `…/oidc/callback`, exactly as
  registered at the provider — never derived from the request's `Host`, which a client
  controls), `name` (the button's label, "Sign in with authentik"), `scopes` (default
  `openid profile email`), `groups_claim` (default `groups`, M20b) and `password_login`
  (default `true`). The client secret lives in `server.toml`, outside every vault
  (AGENTS.md §3.3), and is never logged or echoed.
- **The flow** is the authorization-code flow with PKCE (S256), a 256-bit `state` bound to an
  `HttpOnly; SameSite=Lax` cookie, and a `nonce`; attempts are valid 10 minutes and single
  use. The provider's endpoints come from `<issuer>/.well-known/openid-configuration`, whose
  `issuer` must equal the configured one exactly. The code is exchanged at the token
  endpoint over TLS with the client secret.
- **The ID token is validated by its claims, not its signature**: `iss` equals the issuer,
  `aud` contains the client id (and `azp`, when present, equals it), `exp` is in the future,
  `nonce` matches. OIDC Core §3.1.3.7 allows TLS server validation of the token endpoint in
  place of the signature for a token received directly from it, which is the only way this
  server receives one; this keeps a JWT and JWKS implementation out of the auth path. The
  token endpoint must therefore be `https`, except to a loopback provider in development.
- **Who the person is** — the identity is the pair (`iss`, `sub`), stored as a link on the
  account. A returning person is found by that pair alone; email and username changes at
  the provider never move them to a different account.
- **Linking existing accounts (A47: by verified email).** A first sign-in with no link is
  matched to an existing account when the token carries `email_verified: true` and that
  email equals the account's **email** (case-insensitively, exactly one account). Accounts
  gain an optional `email`, set by an administrator (`memberberry user
  set-email`); an account without one is never linked to anything. Matched, the account is
  linked and keeps its vault access. Otherwise a new account is created: username from
  `preferred_username` (or the email's local part), reduced to `[a-z0-9_-]` (a `.` becomes `-`), made unique
  with a number; display name from `name`; no password (it cannot sign in with one); not an
  administrator; no vault access until someone grants it.
- **The first administrator** is still created by the setup form or `memberberry user
  setup` (A47); OIDC is switched on afterwards. A provider sign-in never creates or
  promotes an administrator.
- **Password sign-in** stays beside the provider's button unless `password_login = false`,
  which hides the form and refuses `POST /login` for everyone. `memberberry user
  reset-password` and the CLI keep working, so an administrator is never locked out.
- **Disabled accounts and sessions** behave as for passwords: a disabled account's provider
  sign-in is refused; the session issued is the same signed cookie (§6.8).
- **Device sign-in** (§6.8.1) is unchanged: its approval page's sign-in offers the provider
  too and returns to the approval afterwards.
- **As built (M20a):** `/oidc/start` and `/oidc/callback`; the sign-in page leads with
  "Sign in with <name>" and keeps the password form below it, quieter ("Sign in with
  password"), unless `password_login = false`. Discovery is fetched per sign-in, not cached.
  The callback is not separately rate-limited (each attempt costs the person a round trip
  through the provider, and a state is single-use); add one if a provider is ever exposed
  to abuse. Provider sign-ins are audited as `login` with `oidc:created` / `oidc:linked`.
- **M20b — provider groups as vault roles (A47).** `access.toml` may name a group wherever it
  names a user, as `group:<name>`. A user's groups are the `groups_claim` values from their
  latest provider sign-in, stored on the account and replaced at each sign-in; a user who
  never signed in through the provider has none. A group grant counts exactly like a grant to
  the user, and the most specific rule still wins (§6.3). Removing someone from a group at
  the provider takes effect at their next sign-in, not before (§6.7).
  **As built:** `mb_core::Access` carries group grants beside user grants and, from the
  server, each account's latest groups; `effective_role` combines them, so every enforcement
  point honours groups without naming them. The server attaches the groups in its one policy
  read (`access_for`), so a group change applies to the account's existing sessions as well
  as new ones. `vault_role` (own membership plus groups) replaces the scans of the member
  list that discovery, write access, ownership and the search zones used; zones count group
  members as principals. Saving `access.toml` (an accepted invite) keeps group grants. Only
  valid group names from the configured claim are kept, at most 256; a disabled account has
  none. Group names are compared exactly (Keycloak's `/family` is not `family`).
- **Audited:** provider sign-ins (success, refusal and why), links, account creation from a
  provider (§6.9).

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
The file-list New note action creates inside the folder selected by pointer or keyboard,
or beside a selected note. Without a tree selection it defaults to the vault root;
the command palette defaults beside the open note. The prompt displays the destination.
The folder-row **New note** menu action defaults inside that exact folder, including
empty and nested folders, regardless of the active note or previous tree selection.
A name containing `/` remains an explicit vault-relative path and overrides that default.
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
coordinator flushed and dropped — when its last subscriber leaves and its Markdown flush
succeeds. A failed final flush retains the coordinator for the normal maintenance retry.
Pending local changes are cleared only by the durable update echo or a reconnect proving
the server already has the state. An initially disconnected transport must not clear a
restored replica's durable dirty flag before reconciliation.

### 7.2 Replication scope — calibrated for 10k+ notes (A8) and permissions (A14)

Full-vault body replication is wrong at this scale (10k notes ≈ 30MB of text, worse on a
phone). Tiered, and always intersected with the user's readable set:

| Tier | Content | When |
|---|---|---|
| **Always** | Metadata for readable notes: id, title, path, tags, aliases, icon, links, mtime, open task rows | Eager. ~10k × 200B ≈ 2MB, plus task metadata. |
| **Always** | Permitted client index zone segments + snippets (§14.2) | Eager. ~8MB at 10k notes. |
| **On demand** | Note body (Y doc) | On first open; stays resident and syncs thereafter. |
| **Pinned** | Note body | Forced eager for notes/folders marked "available offline". |
| **Opt-in** | Everything readable | `offline.replicate_all = true` for small vaults. Not built in the web client; the desktop expresses it as a folder pin on the vault root (§7.6.3). |

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
  only on teardown would be missing from exactly the session that produced it. First
  residency and the current dirty flag are committed atomically before a cap sweep; a
  pending update before body arrival must not falsely mark an unloaded body downloaded.
  Resident size, merge-base and dirty updates share an IndexedDB read/write transaction,
  so overlapping updates cannot overwrite the unsynced flag. Restored dirty state remains
  protected until server reconciliation/acknowledgement, not merely socket connection.
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
- **Missing dependencies:** a log whose merged state still has pending Yjs structs or
  deletes (an update whose base no record contains) fails to load with
  `MissingDependencies`. Serving it would make the note unopenable — every client's schema
  admission refuses it, and the server refuses every later update against it. The
  coordinator therefore moves it to `.memberberry/crdt/quarantine/<name>.bin.<n>` (numbered,
  never overwritten) and rebuilds from the Markdown note, as for a missing sidecar. A
  quarantined copy holds the note's content, so it belongs to the note. It moves with the
  sidecar on rename, trash and restore, and is deleted with it when trash retention purges the
  note; nothing else deletes it. Nothing readable is lost: the Markdown was written from what that state
  materialized. Accepted edits newer than the last Markdown write, if any, stay only in the
  quarantined file. To keep such a log from being written, `replace` and compaction refuse
  a pending document, and `append` refuses to *start* a log with an update that cannot stand
  alone. When the log vanished under an open room (I1 cleanup, a hand-run delete), the
  coordinator writes its complete, already-validated candidate state instead.
- **Durability:** the server serializes appends per note and syncs each append. Compaction
  writes and syncs a complete state to a sibling temporary file, atomically renames it over
  the sidecar, then syncs the parent directory. Cross-process writers are unsupported; the
  note's sync coordinator is the single server-side writer.
- **Client:** Yjs GC enabled, aggressive compaction, no local history (A7).

### 7.4 PWA

**Installed application follow-up (2026-10-18, t-014; approved scope, local review candidate).**
Android/Chrome and Linux/Chrome are the primary targets. The existing berry mark has
192px/512px PNG installation icons and the manifest is discoverable from private app
landing pages. Manifest links include credentials so authenticated reverse proxies can
serve the same-origin manifest. An in-app install action invokes the browser's own prompt when available.
The stable app identity remains `/`; the installed start URL `/app.html?launch=1`
resumes the last workspace route on this device, falling back to the vault list on first
use. Remembered paths grant no access; the server still authenticates every online read.
Offline launches can restore note and vault workspace shells and validated per-user,
per-vault, per-device local layouts. Authoritative layout refusal never replays that cache.

Returning to the visible app reconciles the current vault's permissions/catalog, search
segments and pinned note text, coalescing focus/visibility/network events. Current editors
retain their selection and workspace; this data refresh does not reload the application.
The same reconcile runs once after every load. It reconnects an editor's sync socket only
if the page has been hidden since that socket opened: only a suspended page can leave a
socket that claims to be open but carries nothing. Reconnecting a live socket would drop the
connection under the editor and lose the selection this paragraph promises to keep.
Opened/pinned note text and offline search are the offline scope of this delivery.
Offline images/attachments and periodic refresh while the app is closed are deferred.

Application updates download in the background and show “Update available”; only the
user's action reloads the page. The new server build is loaded through network-first
navigation. The worker keeps its existing waiting lifecycle, preserving other open
windows and lazy chunks; its offline build changes once old controlled windows close.
The reload action flushes the workspace and refuses while note writes are pending or
cannot be checked. No forced worker takeover or replica deletion is used for updating.
A page the Vite dev server loads from source (`make dev` on 9011, recognised by its
`/@vite/client` script) is never offered an update and registers no worker; it unregisters
any worker already on its origin. Its entry files are in no build, so the check above would
otherwise show "Update available" through every reload.

Service worker precaches the app shell and WASM bundle. IndexedDB holds Y docs, the
pending-update queue, and the client search index. Pinned-media caching is deferred as
stated above. Offline uploads and clips queue and flush on reconnect. Downloaded note text
and offline search must remain functional after a cold start with no network.

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
Opening editor sessions are tracked before body restoration. A newer authoritative catalog
refusal/removal invalidates them before asynchronous storage work begins, including sessions
whose first sync is buffered behind editor startup. Invalidated sessions cannot recreate
residency, dirty state or merge bases during startup or teardown; the purge also covers
not-yet-resident body databases. Buffered sync is historical content, not fresh authorization.

**The shell (M6).** `web/src/offline/` holds the worker; `web/scripts/build-sw.ts` builds it
as a second, library-mode Vite build after the application build, because a worker has to
land at a fixed root-scoped URL — `/sw.js`, never `/assets/sw-a1b2c3.js` — and has to be one
self-contained file. `mb-server` serves it, the manifest and the icon from the build root.
The application mark is a light berry with a bookmark-shaped cutout on Paper-theme purple,
shared by browser favicons and the installable app. Its standalone SVG uses the Paper
`--accent-primary` and `--surface-canvas` values and fits the maskable safe circle. The
editor and manifest use `/icon.svg?v=memory-berry`; both that URL and `/icon.svg` are
precached so the branding revision also changes the worker's cache version.
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

### 7.6 Desktop client and the local replica (A42)

**Status: slices 1, 2a and 2b built** (Tauri host, E34, local-only vaults, device sign-in,
whole-vault sync; §7.6.8, §7.6.9). The rest of replication (§7.6.3–§7.6.7: on-demand
residency and the release sweep) is specified, not built; E35's purge and recovered notes are
built (§7.6.7). Milestone M19 (§23).

An installable desktop application for macOS, Windows and Linux whose point is that notes
live **on this machine as Markdown files**, so C2 holds on the laptop as well as the
server. A desktop build that only wrapped the server's URL would add nothing over the PWA
(§7.4) and is not what this section specifies.

#### 7.6.1 Technology — Tauri 2

- **Tauri 2, not Electron.** The UI is the existing Svelte bundle, unchanged, in the
  operating system's webview (WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux).
  The host process is Rust, so `mb-core`, `mb-crdt`, `mb-search`, `mb-index` and
  `mb-server` link in natively — §5.2's sixth point — with no WASM boundary on the desktop
  path. Electron would ship a second Chromium per install and put a Node process between
  the UI and a Rust core.
- **Not a native UI toolkit.** §5.2 already declines rebuilding the editor outside
  ProseMirror; SwiftUI, Qt, egui or Flutter would each mean exactly that.
- **No updater, no crash reporter, no telemetry (C1).** Tauri's updater plugin is not
  included. A new version is installed by the user.
- **Unsigned packages (A49).** Builds are not code-signed or notarized and are not
  distributed through an app store; people install the packages directly:
  - **macOS:** a DMG (drag to Applications), universal (Apple silicon and Intel), macOS 11 or
    later. The bundle is *ad-hoc* signed (`signingIdentity: "-"`), which names no developer
    and needs no certificate: Apple silicon refuses to launch a bundle with no valid
    signature and calls it "damaged", while an ad-hoc one gets the ordinary approval —
    Gatekeeper refuses the first launch until the user chooses Open Anyway in System Settings →
    Privacy & Security (the context-menu Open route ended with macOS 15). The keychain checks two lists per item (trusted applications, then
    partition), both keyed to the exact build, so each **new version** asks twice for a
    server's token — once per version if the user chooses **Always Allow** on both, on every
    launch if they choose **Allow** (the token is read once per launch, `CachedSecrets`).
    A fresh install that signs in creates the item itself and is not asked. The README tells
    users to choose Always Allow. Only a Developer ID identity removes the prompts.
  - **Linux:** a `.deb` and an AppImage, built on Ubuntu 22.04 so they need only its glibc.
    The device token needs a running Secret Service (GNOME Keyring, KWallet) (§6.8.1).
  - **Windows:** an MSI. SmartScreen warns about an unknown publisher on first run.
  Each OS builds only its own packages (`make desktop-build`, per-OS `tauri.<os>.conf.json`);
  the manually dispatched "Desktop packages" workflow builds all three from one frontend
  build and uploads them. It reads no secrets, and a CI test keeps it that way.
- **The cost, stated:** three webview engines instead of one. The E2E suite (§22.6) runs
  Chromium and, since M19, a WebKit project, because macOS and Linux render with WebKit.
  WebKitGTK is the slowest of the three, so the §21 budgets are measured on Linux
  separately rather than assumed from macOS.
- **No native JavaScript dialogs.** wry's macOS webview implements no JavaScript panel
  delegate, so `window.confirm()` returns false, and `alert()` and `prompt()` return
  without showing anything. The user sees nothing. Before this was known, Delete on a
  note did nothing in the app. The web client asks through its own `<dialog>` (`ConfirmDialog`,
  `NamePrompt`), never `window.confirm`, `alert` or `prompt`. Playwright dismisses an
  unhandled dialog the same way, so `e2e/tree-delete.spec.ts` fails if a native one comes back.
  Known exception: the emoji picker's rename still uses `prompt`/`alert`, and so cannot
  rename in the app.

#### 7.6.2 Architecture — a replica is a vault

```
Tauri webview (the existing Svelte UI)
        │  HTTP + WebSocket, loopback only (E34)
        ▼
embedded mb-server ── serves ──▶ <replica>/notes/**/*.md + .memberberry/   (Layers 1–3, §3.1)
        │  sync client: the existing §7.1 protocol + device token (§6.8.1)
        ▼
remote mb-server (the user's own; absent for a local-only vault)
```

- **The replica folder has the vault layout of §4.1.** One folder per vault, chosen by the
  user, default `~/Memberberry/<server-host>/<vault-slug>/`. Notes are plain files a text
  editor can open while the app is closed; a change made there takes the §3.4
  external-change path in the embedded server, then syncs upstream.
- **The embedded server is `mb-server`,** not a second implementation. The webview talks to
  it exactly as the browser talks to a remote one, so the UI carries no desktop branch. The
  upstream link is `mb_server::replica` (a module, not the crate first planned; §5.3): a sync *client* speaking the §7.1 protocol and
  the existing metadata and index endpoints. Upstream sees one more client, so E1–E4 apply
  to it unchanged and the server needs no replica-specific read path.
- **Replica bookkeeping lives in `<replica>/.memberberry/replica/`.** It holds the upstream
  URL, device id, availability rules and the residency manifest (§7.6.4). **The upstream
  device token (§6.8.1) is in the OS keychain**, never in the replica folder (AGENTS.md §3.3).
- **A local-only vault is a replica with no upstream:** an ordinary vault with a one-user
  `access.toml`, served by the same embedded server. It is the default way to try the app.
  Connecting a local-only vault to a server later (uploading it) is out of scope for M19.
- **Per-device settings live in `<app data>/desktop.toml`,** beside the rest of the app's
  private state (§7.6.8). Today it holds the remembered port; the release limits of §7.6.5
  join it. This is the home §7.2 says the client caps lacked.

#### 7.6.3 Availability — one rule model for "open", "download" and "everything"

Every readable note in a replica is in exactly one of two states: **resident** (its `.md`
file and CRDT sidecar are on disk and syncing) or **not resident** (metadata and search
snippet only). What makes a note resident is a set of rules:

| Rule | Set by | Effect |
|---|---|---|
| **On demand** | Opening a note | Becomes resident; may be released by §7.6.5 |
| **Pin note** | "Keep this note downloaded" | Resident while the pin exists; never released |
| **Pin folder** | "Keep this folder downloaded" | A path-prefix rule: every readable note under it, including notes created or moved in later |
| **Full vault** | "Keep the whole vault downloaded" | A folder pin on the vault root. Not a separate mode |

- **The vault default is one of `on-demand` or `full`.** Defaults: `on-demand` for a
  replica of a server vault, `full` for a local-only vault (where nothing could be released
  anyway). Per-folder and per-note pins refine the default.
- **A folder pin is re-expanded on every metadata change**, not resolved once into a list of
  paths: a pin that silently misses notes created after it was set breaks the promise it
  made. This lifts §7.2's "folders cannot be pinned yet" for the desktop; the web client
  adopts the same rule model when it gains folder pins.
- **Removing a pin does not delete anything.** Its notes return to on-demand and age out
  under §7.6.5.
- **Pinning a note pins its media.** An attachment referenced by a resident pinned note is
  downloaded with it. A pinned note with broken images is not available offline in any
  sense a person would recognise. On-demand media is fetched when displayed and released
  with its note.
- **The eager tiers of §7.2 are unchanged:** metadata for every readable note and the
  permitted search zones are always replicated, so offline search and the graph cover the
  whole readable vault whatever is resident.

#### 7.6.4 What the folder shows, and telling eviction from deletion

**Only resident notes are files** (S7). A text editor opened on an on-demand replica sees
the notes this device holds, and that set changes as notes are released. The alternative, a
hidden cache with only pinned notes as real files, would make the folder lie in the other
direction: a note the app is showing would not be on disk.

That makes a missing file ambiguous, so the replica keeps a **residency manifest**: every
note the app made resident, and every note it released.

- **A file the app released is not a deletion.** Releases are recorded before the file is
  removed, so a crash between the two leaves a manifest entry and no file, which reads as
  released.
- **A resident file removed outside the app is a deletion** and propagates upstream as a
  delete to trash (§4.1, recoverable for `trash_retention_days`), subject to E17's editor
  requirement. C2 makes the file the truth; deleting it in a file manager means what it
  says. A viewer's deletion is refused upstream and the file is restored locally.
- **A file created outside the app** under `notes/` is a new note (§6.10) and needs editor
  rights at that path upstream. Refused, it stays local, marked "not uploaded".
- **With the manifest gone** (`rm -rf .memberberry/`, I1), no missing file can be told
  apart, so **none is treated as a deletion**. Every file present is re-imported, every
  absent one reads as not resident, and nothing propagates until the manifest is rebuilt
  from upstream. Failing towards "keep" is the only direction that cannot lose a note.
- **A note the user may only view is written read-only** (file mode 0444 or the platform
  equivalent). An edit forced through anyway stays on this device as a `> [!conflict]`
  callout (§3.5) and is never sent; the server would refuse it under E3 in any case.

#### 7.6.5 Releasing on-demand notes

The desktop has room the phone does not, so its limits are generous and time-based first.

- **A note not opened for 30 days is released**, and while resident bodies plus their media
  exceed **1 GB**, the least recently opened go first. Both are configurable per device
  (§7.6.2). The sweep runs at start and after a note becomes resident, as §7.2's does.
- **Never released:** a pinned note, a note open in any tab, and a note with changes not yet
  acknowledged upstream. "Unacknowledged" includes an external edit whose file hash differs
  from the `.last-write` sidecar (§3.1): the file was changed and the change has not reached
  the server. As in §7.2, exempt notes still count towards the cap, and a device whose exempt
  notes exceed it stays over rather than discarding writing.
- **Releasing removes the `.md` file, its CRDT sidecar and unpinned media,** after the
  manifest records it. The metadata row and search snippet remain.

#### 7.6.6 Permissions and the replica

- **The replica holds only what upstream sent, and upstream sends only the readable set.**
  No ACL decision is made locally for a server vault. The replica does not receive
  `access.toml`; it receives each note's effective role, which drives read-only files and
  the editor's read-only mode as an affordance, never as the boundary.
- **Revocation purges on reconcile (E35).** When a note leaves the readable set, its file,
  sidecar, media, metadata row and search postings are deleted on the next reconnect, pins
  included, and the local index is scrubbed so nothing of the note survives in its database,
  log or search segments. This is §6.7's documented limit (a revoked user keeps the replica
  until they reconnect) made precise, not removed.
- **What a replica does not protect against, stated in the UI:** anyone with access to this
  machine's disk reads the files (A6; ACLs are not encryption), and an unreachable server
  means a revocation has not happened yet.
- **Presence is not sent for background work.** The embedded server forwards awareness
  upstream only for notes open in the webview. Pin sweeps, folder-pin expansion and
  release carry none, as §7.2 requires of the web client.

#### 7.6.7 Unsent edits to a note that left the readable set (A43)

A device can hold edits the server has never seen for a note that, by the time it
reconnects, is no longer in the user's readable set. Four things cause that, and the device
cannot tell them apart, nor may it ask (§6.5):

1. **Permissions changed:** `access.toml` now gives this user no role on the note.
2. **Moved out of reach:** the note was renamed or moved into a folder this user cannot read.
3. **Deleted:** someone else sent it to trash.
4. **Removed from the vault:** case 1 for every note at once.

The rule is the same for all four. **The user's writing is never discarded without the user
choosing to, and nothing is sent upstream without the user choosing where.**

- **On reconcile, the edits are written out at once as a local recovered note**,
  `notes/Recovered/<title> (offline edits).md`, a plain Markdown file (C2). It is marked
  "not uploaded" and never syncs on its own. The original file, sidecar and media are then
  purged as E35 requires. The only state outside `notes/` is the bookkeeping that says which
  recovered notes are awaiting a choice.
- **What it contains is the whole note as this device had it** (A43, 2026-11-12), the user's
  own changes in context — including text others wrote. A revocation therefore does not
  remove a note this device changed: it moves it out of sync and into the user's hands.
  Its frontmatter `id` is dropped, so the copy is a new note rather than a second claim to
  the original's identity (§4.3), and its history starts fresh rather than carrying the
  original sidecar's.
- **A banner flags it.** A workspace-level banner says how many recovered notes await a
  choice and opens the first. Opening a recovered note shows a banner at its top, worded the
  same for all four causes ("This note is no longer available on the server. Your offline
  edits were kept here."), with two actions, both keyboard-reachable (§8.4):
  - **Create the note again:** a normal create (E17, §6.10) at the original path. If it
    succeeds, the recovered note moves there and syncs. If it is refused, the refusal is
    E17's uniform one, which says nothing about whether a note occupies that path, and the
    banner keeps only the second action.
  - **Make a new note:** the create prompt (§6.10), prefilled with the recovered note's
    title and the vault root, so the user picks the name and folder. The recovered note
    moves there and syncs.
- **The banner stays until the user chooses.** Dismissing it for the session is allowed;
  it returns on the next start. A user who wants the edits gone deletes the recovered note
  like any other note.
- **The original path is known only to this device.** It is the path the user could read when
  the edits were made, so showing it reveals nothing new. The server is never asked why the
  note left the readable set.
- **As built (desktop).** The recovered note is `Recovered/<name> (offline edits).md`,
  numbered when that is taken; the bookkeeping is
  `<replica>/.memberberry/replica/recovered.json` (path, original path, whether creating it
  again was refused). Losing it fails towards keeping (I1): a note named like a recovered note
  that neither upstream nor the record knows is still treated as one and never uploaded.
  While the server is online, the app answers a recovered note's sync frames itself and adds
  it to the forwarded note list, so it opens and shows in the tree. The workspace line ("1 note
  was kept from your offline edits and needs a choice.") offers **Open** and **Later**;
  **Later** lasts until the app is started again. **Make a new note** asks for a name in the
  banner itself — a path, so a folder can be given — rather than opening §6.10's create
  prompt. A choice and a pass never run at once. Deleting a recovered note ends its entry.
  For a whole vault (case 4), what was recovered stays in that vault, which becomes a vault on
  this device; its banner is not shown there, since there is no server to create a note on.
- **Not desktop-only.** The web client's IndexedDB replica (§7.2) has the same gap today:
  its dirty body is exempt from eviction, but nothing defines what reconcile does with it.
  The web client adopts this rule, with the recovered note held in its local store until a
  choice is made, since it cannot write a file.

#### 7.6.8 Slice 1 as built — the app, its sign-in and local-only vaults

`desktop/` is the Tauri host; `mb_server::desktop` holds every decision in it, so the
workspace's tests reach them without a webview. The host finds the platform directories,
starts the server, opens one window at the launch URL and stops the server on exit.

- **Where things live.** Private state is in the OS app-data directory
  (`~/Library/Application Support/app.memberberry.desktop` on macOS): `server.toml`,
  `auth.db`, `desktop.toml` and the audit log. Vaults are created in **`~/Memberberry/<vault
  address>/`**, so their notes are where the user looks for them; the New vault flow is
  §6.1's, with its managed-vault root moved there. `MEMBERBERRY_DESKTOP_DATA` and
  `MEMBERBERRY_NOTES_HOME` override both, for development and tests.
- **Automatic sign-in (S11).** First run creates the server administrator `me`, named after
  the OS account, with a random password that is never stored or shown. E34's guard signs
  the window in as that user, so no setup form or password prompt ever appears. A data
  directory whose users were created by a person is refused rather than adopted. There is
  no one to log out, so the home page and the workspace's account footer show **Your
  server** (§6.8.1) where a browser shows Log out. The server marks the app's workspace
  pages with `data-desktop="true"` for that; a normal server never does.
- **The port is remembered**, chosen by the OS on first run and reused while it is free,
  because the window's origin includes it and the webview keys its storage by origin: a new
  port per launch would forget every per-device layout and cached replica. A taken port
  falls back to a fresh one, and that launch starts with empty browser storage. Notes are
  unaffected; they are files.
- **The window stays on its origin.** A navigation anywhere else opens in the user's
  default browser (http, https and mailto only) and the window does not move. A link that
  asks for a new window (`target="_blank"`, as a note's external links do, or
  `window.open`) is decided the same way: a web or mail address goes to the browser, one
  of the app's own pages opens in the app's window, and no second window is created. Any
  other scheme goes nowhere. The rule is `mb_server::desktop::link_target`, where it is
  tested; the host applies it to both.
- **Opening an existing folder as a vault is Linux-only**, because §6.1's folder
  registration (E29) is compiled only there. On macOS and Windows the app creates new
  vaults; it cannot yet adopt an existing Obsidian or Markdown folder.
- **Measured on the development Mac:** the window shows the vault list about 3 s after
  launch. Nearly all of it is the macOS file watcher's start (`notify`'s FSEvents `watch`
  call, ~2.7 s per root, measured outside the tool sandbox); the server serves no page until
  the watcher and index are up. The regular server pays the same at start.

---

#### 7.6.9 Slice 2b — whole-vault sync (A45; built, superseded in its UI by §7.6.10)

What the first sync version does, and the rules it follows. §7.6.3–§7.6.7 remain the
target; this is the subset with a full-vault pin and nothing released.

- **Choosing vaults.** The connected page (§6.8.1) lists the upstream vaults the device's
  user can read, from `GET /api/v1/vaults` with the device token. **Download** creates the
  replica at `~/Memberberry/<server-host>/<vault-slug>/` (the host's `:` becomes `-`),
  registers it in the embedded server, and starts syncing. **Stop syncing** leaves the
  folder and its notes where they are, as an ordinary local vault.
- **The replica speaks §7.1 upstream** over one WebSocket carrying the device token (E36 on
  the sync path, authorized per frame like an API token). Locally it is an in-process peer
  of the embedded server's sync registry, so local edits, the webview and the external-edit
  path (§3.4) all reach it the way they reach any client.
- **A note's history starts from upstream's.** A note downloaded for the first time is
  written from the server's full update: its sidecar is that state, its Markdown is that
  state materialized, its last-write marker that Markdown's hash. Rebuilding it from the
  downloaded Markdown instead would give the two sides unrelated histories, and merging
  them would duplicate every block. When the histories have nonetheless diverged — the
  replica's `state vector` shares no client with upstream's, as after `rm -rf .memberberry/`
  on either side or a note renamed in a file manager — the two are never merged; S14 says
  what happens instead.
- **Edits.** Every note, open or not, is caught up by a pass every 5 s (S12); a note open in
  the app receives the pass's changes through the embedded server's room, so its editor
  updates in place. A live relay for open notes — no 5 s wait — is not built yet. A pass
  compares each note's upstream `version` and its local file's (size and modification time)
  with the sync record, and for each changed note subscribes upstream once, applies what
  upstream has that this device lacks, sends what this device has that upstream lacks, and
  waits for upstream's echo — §7.1's acknowledgement — before counting it sent. A note that
  fails keeps its old record entry and is planned again next pass.
- **Structure** — create, rename, delete — is a three-way comparison of upstream's list, the
  local folder and the **sync record** of what both held after the last pass, in
  `<replica>/.memberberry/replica/record.json`. A note is matched across a rename by its frontmatter
  `id` (§4.3); without one, a rename is a delete and a create, which loses no content.
  Changes on one side are applied to the other through the same routes a person uses
  (create, rename, delete-to-trash; E17 applies upstream). Conflicts keep both (S13):
  - changed here, deleted upstream: recovered (§7.6.7) — never uploaded on its own; unchanged
    here, deleted upstream: purged (E35);
  - deleted here, changed upstream: restored here;
  - created on both sides at one path: upstream keeps the path; this device's note is
    renamed `<name> (this device).md` and uploaded;
  - renamed on both sides: upstream's path wins, content merges.
- **What upstream had to grow for this,** all through the ordinary routes and their checks:
  the note list carries each note's frontmatter `id`, an opaque `version` that changes with
  its file, and `editable`; `POST …/notes` takes `state`, a base64 lib0 v1 history the note
  starts from (validated as a note, then written as both its sidecar and its Markdown), so
  an uploaded note does not get a second, unrelated history; `POST …/rename` takes
  `links: false` to move a note without rewriting any link or title, because the side the
  user renamed on already rewrote them and those edits sync as content. Doing either
  rewrite on both sides would merge two copies of the same insertion.
- **The app's side:** `desktop.toml` lists the replicas (local vault, upstream vault, name,
  server). 2b's Download and Stop syncing routes are gone in 2c: every server vault is
  registered automatically (§7.6.10). The connected page shows each vault's state and any
  held notes.
- **Without the sync record** (I1), nothing is treated as deleted: every local file is
  uploaded or merged, every upstream note downloaded, then the record is rebuilt.
- **View-only notes** are not yet written read-only (0444 is §7.6.4's target). An edit to one
  is never sent; upstream's changes still merge in around it, and the note is listed as
  held like the delete conflict above.
- **Not in 2b:** a live relay for open notes; read-only files for view-only notes; on-demand
  residency and release (§7.6.5); pins narrower than the vault; E35's purge and recovered
  notes (§7.6.7); media and attachments (only `.md` notes sync); presence upstream; a way to
  resolve a held note other than editing or deleting it by hand. A pass runs its local file
  work on the async runtime rather than a blocking thread, which a very large first
  download will feel.

#### 7.6.10 Slice 2c — server vaults online, notes offline one by one (A46; built)

§7.6.9's engine stays; what it syncs and how the app reaches a server vault change.

- **Every readable server vault appears** in the app's vault list once connected, with no
  download step. Each gets a local vault and folder, `~/Memberberry/<server-host>/<vault>/`,
  which holds only the notes made available offline. New upstream vaults appear on the next
  pass; the list is the server's `GET /api/v1/vaults` for the device's user.
- **Online, the app is the browser.** For a server vault, the embedded server forwards the
  vault's routes — `/api/v1/vaults/{slug}/…` and its frames on the sync socket — to the
  user's server with the device token, and renders the workspace shell itself. Upstream
  decides every permission (E36); the app adds none and filters nothing. **E37** governs the
  forwarding: only a registered server vault's routes, only to the connected origin, never
  this app's cookies or session upstream, never upstream's `Set-Cookie` back. A local slug
  that differs from upstream's (a local vault already had the address) is rewritten in the
  path and in sync frames, nowhere else.
- **Available offline** is a pin (§7.6.3) on a note, a folder or the vault root, set from the
  tree's context menu, the note palette ("Keep this note available offline") and the vault
  menu. Pins live in `<replica>/.memberberry/replica/pins.json`. The pass of §7.6.9 runs over
  the pinned notes only: a pinned note is downloaded, then kept in step both ways. A note
  created while offline is on disk, so it is uploaded and stays available offline.
- **Online only** removes a pin. The note's unsent changes are sent first; if they cannot be
  (offline, refused), it stays and says so. Then its file and sidecar are removed and its
  record entry dropped — a release, which is not a deletion and never reaches upstream's
  trash. A note under a folder or vault pin cannot be released alone; the menu says which pin
  holds it.
- **Opening a note does not keep it** (A46). On-demand residency and §7.6.5's release sweep
  are not used for server vaults.
- **Offline** — the server unreachable, decided per vault by the last pass and by a failed
  forward — the embedded server serves the vault from its folder. The note list is the last
  upstream list (kept in `<replica>/.memberberry/replica/listing.json`, titles and paths only)
  joined with the files present; a note without a file is listed with `available: false`,
  shown greyed and opening to "This note is online only. Connect to your server to open it."
  Downloaded notes edit normally against their local history, which descends from
  upstream's, so reconnecting merges without duplication (§7.6.9).
- **Indicators.** A downloaded note carries a small mark in the tree. The vault picker
  groups vaults by where they live — the connected server (with an Online/Offline badge, the
  account and Disconnect, §7.6.11) and "On this device" — as cards whose one line says how many notes there
  are and what is on this device ("12 notes · 3 available offline", "Offline · 2 notes on
  this device"). Counts come from the reader's authorized view, never the raw folder (§6.5).
  In a browser there is one group and no heading. While the server cannot be reached, the
  workspace says so above the note tree, for the vault as a whole: "Offline. Notes on this
  computer still open and save, and sync when your server is back." (or, with nothing
  downloaded, that no notes from the vault are on this computer). The editor's own
  connection line speaks only for the note open in it.
- **The note palette** acts on these pins in the app: "Keep this note available offline" /
  "Stop keeping this note offline" pin or release the open note, and the command is listed
  and refuses for a note a folder or the whole vault keeps offline. The browser's own §7.2
  store is not used in the app at all — its local vaults are already on disk.
- **What a person keeps per vault works through the app.** Bookmarks, the saved workspace
  layout and share links are forwarded like any vault route, and the server accepts the
  device token for them as its user (E36). A new share link's address comes back relative
  (`/s/<token>`); the app makes it absolute on the vault's own server, so the link copied is
  one other people can open, never the app's loopback address.
- **Media follows its note** (§7.6.3; built 2026-11-12). Media is content-addressed
  (`media/ab/cd/<sha256>.<ext>`, §12.1), so an object has one path on both sides. A pass:
  - **uploads** the media a note shows just before that note is uploaded or its local changes
    sent, so upstream never holds a note showing an image it lacks — and only for those
    notes, so an image in a note that left the readable set never leaves this device on its
    way out (E35). "Create the note again" (§7.6.7) uploads the note's media first;
  - **downloads**, after the notes, every object a note on this device shows and the disk
    lacks, through upstream's ordinary media route — which serves an object only when a note
    the device's user can read references it (E11) — and writes it only if its bytes match
    its address;
  - **removes** every local object no note here references any more (a released, purged or
    edited-away note's images), sparing objects uploaded in the last few minutes that a note
    may not have saved a reference to yet. A recovered note's media stays with it.
  Offline, the embedded server serves media from the folder like any local vault. What both
  sides are known to hold is kept in `<replica>/.memberberry/replica/media.json`; losing it
  (I1) costs one re-upload, which stores nothing new. Only display objects travel: a
  retained full-resolution original (§12.2) stays on the server, so "view original" offline
  shows the display copy.
- **A note URL without `.md`** (`/v/work/Hello`) opens the note: the workspace page names the
  note by its path (`Hello.md`), which is what the sync socket admits.
- **As built, and not yet:** held notes are listed on the connected page only, not marked in
  the tree. Forwarding reuses one HTTP client per server; each window socket opens its own
  upstream socket per server vault. Offline is decided by the last pass (every 5 s) or a
  failed forward. A short URL naming a note by title alone, in another folder, resolves only
  if the note is downloaded; otherwise it is taken as a path at the vault root.

#### 7.6.11 Several servers, and disconnecting one (A48, A50)

- **A list, not one server.** `desktop.toml` holds `[[servers]]`, each with its origin, the
  account and the device id. Each server's device token is in the keychain under its
  origin. An installation written with the single `[server]` table of §7.6.8 is read as a
  one-entry list. Every replica already names its origin, so server vaults from two servers
  live side by side: their folders are `~/Memberberry/<server-host>/<vault>/`, and a local
  address taken by another server's vault gets a suffix (`work-2`), as §7.6.10 already does
  for a local one.
- **Every pass and every forward is per server.** The sync loop runs each signed-in server's
  vaults with that server's token; a forward (E37) goes only to the origin its vault names,
  with only that origin's token. A vault whose server is not signed in is never forwarded and
  behaves as offline.
- **The vault picker is where servers are managed** (A50). Under the page's **New vault**
  and **Connect a server**, each server is a group: its host, the account signed in
  ("Signed in as Alice (alice)"), an Online/Offline badge, a **Disconnect** button, the last
  pass's error if it had one, and its vault cards. A card whose vault has notes the server
  does not have says so ("1 note not synced"), counting held and recovered notes. Local
  vaults are the **On this device** group, and a dashed card at the end connects another
  server. `/desktop/connect` redirects to the picker once a server is connected, so the
  workspace footer's **Servers** link lands there. Connecting to an origin that is already
  signed in is refused with a message.
- **Disconnecting is two dialogs over the picker** (A50). The pages run no script, so a
  dialog is the picker rendered `inert` behind a modal; Cancel and the backdrop are links
  back to `/`. The picker's CSP allows `form-action 'self'` for these forms; it shows vault
  names and counts, never note content.
  1. `GET /desktop/disconnect?server=<origin>` says what disconnecting does and changes
     nothing: Memberberry checks that every change made here has reached the server, then
     removes the connection, the server's vaults, and the notes kept offline (with how many).
     The notes on the server are not touched.
  2. `POST /desktop/disconnect` runs one last pass over the server's vaults, holding the
     pass lock until the end so nothing is written between the check and the removal. The
     notes count as **not synced** when the pass holds or fails a note, a recovered note
     (§7.6.7) remains, or the pass could not reach the server, was refused, or failed while
     notes are on this computer. A server with nothing on this computer has nothing to lose.
  3. **All synced:** the device token is revoked on the server (`DELETE
     /api/v1/devices/self`), forgotten here, the server's vaults leave the app, their
     folders under `~/Memberberry/<server-host>/` are deleted, and the server is forgotten.
     Only folders inside the notes home are ever deleted. When the server could not be
     reached to revoke the token, the page says so and how to revoke it there.
  4. **Not synced:** nothing is removed. A second dialog, "Changes not synced", lists each
     note (vault / title) and why, and says to cancel and let them sync, or type **yes** to
     delete them and disconnect. The field's `pattern` admits only "yes" (any case, spaces
     trimmed), and the handler checks again: any other word is a `400` with the dialog shown
     again. With "yes" it proceeds as in 3.
- **Closing a vault closes its index first.** A disconnected vault's search index waits for
  its background merges before the folder is deleted (`Index::close`), and the deletion
  retries for up to half a second while a reconcile that started before the vault was
  unregistered finishes writing. Without this, deletion failed as "directory not empty".
- **Kept copies from earlier versions.** Under A48 a server could be signed out with its
  notes kept (`signed_out = true` in `desktop.toml`). No version after A50 creates one, but
  one is still shown: "Signed out · notes kept for …", with **Sign in again** and
  **Disconnect**. Its edits were never sent, so disconnecting it always asks for "yes" when
  it holds notes. **A kept copy belongs to one account.** Signing in again as another
  account is refused: the new device token is revoked at once and the page says to remove
  the kept notes first. Otherwise one person's offline notes would be uploaded with another
  person's token.

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
E28 and are not cached for offline use. A path-only grant permits discovery when an existing
readable note or physically empty folder falls within it (§6.1); an absent granted path does
not make a vault discoverable.
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

**Sidebar controls (2026-10-03).** On desktop, each sidebar also has a labelled, focusable
separator supporting pointer dragging, Arrow keys and Home/End. Widths range from 248 to
560 CSS pixels, clamped to reserve at least 320 pixels for the main area; restored widths
are re-clamped on viewport changes. Below 768px, both mobile drawers fill the screen width
under the top bar; desktop and tablet widths are unchanged. The sidebar body's top padding
is zero without changing the shared spacing scale.
Widths and the affirmative **Show filenames** setting are stored locally per user and vault,
not synced. Filenames show the original basename including `.md` in the note tree and
bookmarks; the default remains the Markdown heading. Blocked or malformed local storage
falls back to usable in-memory defaults. **Show filenames** lives in the Notes heading's
three-dot menu beside New folder, not in a permanently visible row.

Every file and bookmark row exposes a three-dot menu with the same actions as desktop
right-click (and Shift+F10/ContextMenu): Open in new tab, Rename, Delete when available,
and Add/Remove bookmark. Bookmark stars are no longer separate row buttons. Tree actions
remain reachable through the tree's single-tab-stop keyboard model.

Every folder row has a three-dot menu with **New note**, **Open in main panel**,
**Move folder**, **Rename** and **Delete**; right-click and Shift+F10/ContextMenu open the same keyboard-operable menu.
New note opens the existing creation dialog targeting that folder (§6.10), then opens
the created note for editing. Rename opens a name prompt prefilled with the folder basename,
keeps its parent, and uses the E14 folder-move operation, including link updates. The current
workspace redirects open descendant tabs and an open folder contents view to their new paths.
Delete removes a physically empty folder directly. A folder containing any note or subfolder
opens a modal requiring its exact basename, case and whitespace included; Cancel/Escape
aborts and Delete stays disabled until it matches. The server repeats that requirement against
current contents (E32), including when a previously empty folder acquired contents. Notes go
to the existing Markdown trash and can be restored individually; empty directories are removed.
Folder deletion refuses hidden entries, symlinks, non-Markdown files, excluded directories and
any descendant without editor/owner access before moving any notes. This protects arbitrary
project files in root-layout vaults. A storage failure can leave some notes in trash; directory
removal is nonrecursive and never discards newly arrived files. The client refreshes catalogs
after failure and closes deleted descendant tabs after success. Opening a folder presents
its authorized immediate subfolders and notes, an empty state, parent navigation, and Close.
This is a temporary folder contents view, not a note or a new persisted tab type: no fake
Markdown is created, existing note tabs are retained, and its URL is the vault Home URL.
The view is built only from the server-filtered catalog and E28 list.

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
  platform writes it. On desktop the control is centered above the main editor area using
  the workspace's actual grid tracks, following sidebar resize/collapse without layout
  measurements in JavaScript. Narrow editor columns show the labelled search icon to avoid
  colliding with session controls; mobile retains a 44px search target between the identity
  and appearance controls. The alignment wrapper does not intercept other controls' clicks.
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
and tree expansion when switching. Navigation-view selection is session-local and is not persisted.
Folder expansion is stored locally per user and vault and restored on reload, including
nested expansion beneath a collapsed parent. Storage failures fall back to session-only
navigation. Saved paths only control expansion of the server-filtered tree; they never
introduce folders or notes into it. This preference does not sync across devices.
On window focus, visible-tab restoration and reconnection, the workspace refreshes the
shared note catalog and empty-folder list without polling. Bursts are coalesced and listeners
are removed on teardown. A catalog denial always purges the replica, even when a newer request
failed due to an unreachable server. It invalidates requests already in flight; only a request
started after that denial may restore metadata. Queued successes and offline reads cannot
resurrect the denied names, pins, merge bases or bodies.
This makes another device's newly created notes discoverable when returning to the app.
Successful note creation closes the mobile navigation drawer so it does not cover the editor.
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
- **Notes and folders can be dragged into an inferred or empty folder, or back to the vault
  root** by dropping on the Notes heading or tree background. The folder menu offers Move
  folder and F2 opens the same destination dialog; an empty destination means root.
  Self-drops, descendant drops and unchanged locations are ignored. External text drops do
  not initiate moves. The gesture calls the audited rename endpoint; refusals are visible,
  and the client updates open descendant tabs only after server success.
  Folder moves preserve nested empty folders and Markdown titles, relocate CRDT sidecars,
  and rewrite inbound links to the new full paths, including links between moved notes.
  All rewrites are verified together before filesystem changes. Write access is required
  on both folder paths and every source/destination descendant; any denial refuses the
  entire move without identifying the denied descendant (E14). Existing destinations are
  refused rather than merged. Symlinks, hidden entries and non-Markdown files in the source
  subtree are refused. ACL rules stay at their configured paths; destination inheritance
  applies after a move. As with note rename (§6.6), an I/O failure after relocation can leave
  partial sidecar/link updates; folder moves are not a filesystem transaction.
- **Bookmarks live in the server's data directory**, at
  `<data-dir>/bookmarks/<user>/<vault>.json` — see `bookmarks.rs` for why not `.memberberry/`
  (Invariant I1 says that holds nothing irreplaceable) and why not the vault (§4.1 says a vault
  holds human-meaningful artifacts, and one person's shortlist is not one). They are **filtered
  on read**, so a note whose access was revoked leaves the sidebar instead of sitting there as
  a name the user may no longer see. A bookmark outlives the permission that created it, which
  a short-lived pane layout does not.
  Each bookmark row exposes **Remove bookmark** through its three-dot/right-click menu,
  with a touch-sized trigger and keyboard support. It removes only that bookmark,
  without opening or deleting the note, and persists through the same bookmark save path
  as the file-tree menu action.

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

**Document links and lookup (2026-10-03).** Ordinary Markdown links activate in the editable
surface as well as wikilinks. Internal document destinations go through the existing
authorized resolver, retaining the tab/split modifiers. Explicit `./`, `../` and root-relative
paths are normalized within the vault; traversal above the vault is inert. Only `http`,
`https`, `mailto` and `tel` external schemes are activated, in a separate browsing context
without an opener; unsafe and obfuscated schemes are inert without rewriting the note's
stored Markdown. Sanitized core-rendered links retain `aria-disabled="true"` without an
`href`; a legitimate `#blocked` heading is not confused with the sanitizer's old placeholder.
Wikilinks are keyboard-activatable. Heading and block suffixes scroll the destination pane
after its editor is ready, including same-note jumps. Heading identity uses core-extracted
visible text, including aliases and inline atoms, folded to NFC and lowercase. Links inside
transclusions resolve relative to the embedded source note,
not its host. Pending jumps are scoped to the vault, note and tab and are discarded on
unmount. Missing anchors leave the opened note in place.

Typing `[[` opens document lookup, ranked by readable title and path with the path shown
for disambiguation. Arrow keys choose a result, Enter/Tab inserts it, Escape dismisses,
and pointer/touch selection does the same. Selection replaces the trigger with an
ordinary Markdown link such as
`[Roadmap](Projects/Roadmap.md)`, using the readable title (or filename when untitled)
as its label, or the explicitly typed `|alias` as its label. An existing heading/block
suffix is retained in the destination. Handwritten `[[wikilinks]]` and embeds keep their
§4.3 semantics; the chooser's output changes, not the parser or existing notes.
Code content does not trigger lookup. The catalog is loaded lazily through the existing
E5-filtered notes API, never through unfiltered filesystem discovery, and is not fetched
on every keystroke. This is an editor input affordance; the WASM parser remains the only
Markdown parser.

The URL follows the focused note tab, including navigation, tab switching and renames.
The shell replaces the current browser history entry; each tab's own back/forward stack
remains separate. Reload therefore reopens the focused note through its authorized route,
even if the layout save has not finished. Explicit Home navigation retains the vault Home
URL, as does closing the last note tab. Note path segments are URL-encoded.

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
- In the editable note body, Cmd/Ctrl-B toggles bold, Cmd/Ctrl-I italic,
  Cmd/Ctrl-U underline, Cmd/Ctrl-E inline code, Cmd/Ctrl-Shift-X strikethrough and
  Cmd/Ctrl-Shift-H highlight. A nonempty text selection uses the same guarded formatting
  action as the contextual toolbar; a collapsed body caret toggles the mark for subsequent
  typing without inserting placeholder content. Cmd/Ctrl-K opens the existing link editor
  for a nonempty eligible selection. Alt-F10 still opens the formatting toolbar, including
  Clear formatting. Toolbar tooltips and `aria-keyshortcuts` advertise the defaults.
  Shortcuts act only in their own rich-text editor, never source/link fields or other inputs.
  Title, literal code/math, read-only, waiting/hidden, composing and refresh-required guards
  apply at dispatch. Unsupported mark combinations refuse without dropping existing marks.
  A fresh formatting keystroke explicitly targets the current native selection, including
  when the model selection trails the visible highlight; it does not reuse an old capture.
  Selection formatting remains an isolated CRDT undo item; caret toggles separate subsequent
  typing from the preceding undo group. These editor-local defaults are currently fixed,
  like the editor undo bindings; remapping them remains unfinished under the remapping
  requirement below. The workspace command registry does not own editor formatting (§8.2).
- In the editable note body, Cmd/Ctrl-Z undoes local edits; Cmd/Ctrl-Shift-Z or
  Cmd/Ctrl-Y redoes them through the CRDT undo stack. This stack lasts for the open
  editor session and is separate from server version history (§18).
- In bulleted and numbered lists, Enter after a nonempty item starts a sibling item
  (the next number in a numbered list); Enter on an empty final item leaves the list.
  Typing a period-delimited numbered marker followed by a space at the start of a body
  paragraph (for example `1. ` or `7. `, up to nine digits) starts a numbered list at that
  number. A marker continuing the preceding list's sequence joins that list. The period
  alone, decimals, numbers within ordinary text and markers in code remain literal.
  Tab nests a bullet below its preceding sibling, and
  Shift-Tab outdents it. Other focusable controls retain their ordinary Tab behavior.
- Typing paired single backticks in ordinary text creates the inline `code` mark;
  unmatched and escaped backticks remain text. Fenced code remains a block.
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
has no workspace binding** because the editor owns Bold — see §8.2 and the editor defaults above.

**Default keymap, audited in M18.** `Mod+P` opens the command palette, `Mod+O` opens the
quick switcher and `Mod+W` closes the current tab. These bindings live together in
`default-keymap.ts`, so future changes receive one explicit review rather than changing
scattered literals. A browser owns `Mod+N` for creating a window and does not reliably let a page intercept
it; “New note…” therefore remains palette-only by default and remappable to an available chord.
The vault switcher, splits, daily note and graph defaults are also defined in that keymap.

**Editor redesign requested, 2026-10-04 — implementation in progress, not yet certified.**
The normal note editor keeps `.md` storage and uses a compact selection-triggered formatting
panel rather than an always-visible format strip. The first implementation slice uses only
existing native Markdown marks, with a real Strong/Clear → durable Markdown → independent
reopen tracer before expanding the menu. Source, export, emoji/media, slash insertion,
task inspection and table tools remain reachable; formatting presentation does not remove
those utilities.

- Show the panel for nonempty eligible body-text selections in an editable editor. Do not
  format the protected first-H1 title, literal code/math, atom-only selections, source mode,
  a waiting body, a destroyed editor or native composition. Check eligibility again at the
  action boundary, not just when drawing a button.
- Pointer and keyboard handoff retain the intended selection while focus enters the panel,
  submenus or link controls. A changed document invalidates a captured selection instead of
  applying an action to a replacement range. Its automatic mapped `selectionUpdate`, a
  geometry frame, controller refresh or retained control must not mint a new workflow;
  require fresh selection intent. After invalidation, ordinary `selectionSet`, focus,
  readiness recovery and popup/synthetic gestures are not renewal. A subsequent native
  editor selection gesture must move the observed range in an unchanged document; the
  explicit, range/eligibility-checked `controller.select({from,to})` API is deliberate
  programmatic intent, not a refresh shortcut. Valid own-format actions may retain their
  resulting eligible selection. Escape dismisses and returns focus/selection; native
  scroll and viewport changes position or safely dismiss the panel without editing.
- A destination-only link action preserves each existing selected link run's unedited
  title, whether the href is unchanged or changed. Newly linked plain text has no title;
  do not collapse differently titled runs or remove titles implicitly. Unlink and Clear
  explicitly remove the complete link mark. Reusing an unchanged destination must not
  manufacture a needless rewrite/undo entry that erases authored data.
- Use the existing CRDT transaction/undo path. One formatting action is isolated from prior
  and subsequent typing; clear formatting removes supported marks, not text, atoms, block
  anchors, list structure or task metadata. Unsafe link schemes stay inert.
- Keyboard and mobile routes are required. Use scoped, labelled controls and existing theme
  tokens, no external assets/services. Every portal/listener/frame has an idempotent disposer.
- The later block-type menu must convert existing selected content rather than inserting
  unrelated blank blocks. Vertical rearrangement must move the complete labelled unit,
  preserve protected-title boundaries and be undoable. The existing binding's move/edit
  behavior is not a stable logical-block move; its verified limitation and the user's
  single-editor scope decision follow below.

Bounded `mb-` styles and collapsible toggle containers are requested follow-up slices, not
current codec capabilities. Existing `#tags`, `[[wikilinks]]`, emoji, code and native Markdown
remain unchanged. Page/Page-in, synced blocks, comments/reactions and AI screenshot entries
are not part of this formatting request; arbitrary HTML/CSS and multi-column layouts stay
excluded. Unsupported menu actions must not appear as fake working buttons. Before adding
new wire nodes/marks, verify schema admission and restored/received-state preflight:
the installed old binding can mutate/delete unknown content during conversion even
without a user edit. The requested inline grammar is in §4.4; the toggle grammar remains
pending. The refresh-only rollout decision follows below.

**Rearrangement scope decision, 2026-10-04.** Real two-bound-editor characterization
invalidated both the existing adjacent swap and bounded delete/insert as safe collaborative
moves: pending typing can attach to another logical block, disappear, or be misplaced by
undo, despite both replicas converging. After this was disclosed, the user chose:
“No: single-editor-per-note rearrangement is enough for now; concurrent/offline multi-editor
rearrangement can be explicitly unsupported.” Implement vertical movement for that
single-editor scope; do not redesign the entire collaborative block-ordering representation
in this iteration or relabel the failing partition probes as successes.

- Documentation states that the note must not be edited in
  another tab/browser/device while rearranging, including offline edits elsewhere. Presence
  detects only known peers, not hidden offline replicas; no distributed-lock guarantee is
  implied. At the user's request (2026-10-14), the standing single-editor rearrangement
  warning is omitted from the movement menu. The refusal gates below remain enforced.
  Ordinary formatting/typing sync continues through the existing authorized path.
- Refuse movement on known peer presence, multiple mounted editors of the same note,
  disconnected/not-yet-synced routed notes or outstanding unsent updates. Refuse read-only,
  source/waiting/composing/destroyed states and stale/cross-editor drag tokens at invocation.
  Local-only synthetic fixtures are explicit controls, not proof of a routed online guard.
- Move the labelled unit, preserving body, native/style marks, anchors, task metadata,
  media, nested content and the original first-H1 title. The original root-only slice is
  extended by the user's October 17, 2026 correction: each bullet/numbered/task item moves
  individually with its nested subtree, and each explicit soft/hard-break-separated text
  line in a body paragraph moves individually. Visual wrapping alone does not split a unit.
  Nested list items reorder within their own parent list; moving the parent carries its
  descendants. Top-level items/lines can move outside their original list/paragraph;
  compatible adjacent lists merge, and split containers retain their anchor only once.
  Tables/code/quotes/other containers remain whole units; never extract a cell under a
  misleading label. Nonadjacent drop, adjacent keyboard/touch actions and one-step undo must retain
  unrelated content and separate earlier/later typing history.
- Drag handles are hover/focus contextual; labelled keyboard/touch Move up/down and an
  insertion indicator are required. No always-visible formatting strip or UI nodes inside
  serialized content. Parent integration, rebuilt desktop/mobile browser saves/reopen and
  independent review are required before declaring this slice verified.

**Implemented: movement wired (2026-10-08).** Routed notes mount the block handles
(hover/focus grip, `⋯` menu with Move up/down, pointer
drag with an insertion indicator; Alt-Shift-F10 opens the menu — plain Alt-F10 stays with
the formatting popup). On fine pointers `⋯` and the grip sit side by side on one row (`⋯` first, the
grip nearest the text) as slim 20×24px targets 4px apart — a deliberate exception to §8.2's
32px desktop controls, at the user's request, still clear of WCAG 2.2's 24px target-spacing
rule — pinned to the start of a ~62px reserved gutter, 12px clear of the text. Coarse pointers reserve no gutter and show no floating
handles; touch moves blocks through More → Move up/down. The long-press handles of §8.2
are not implemented. More's Move up/down use the same gated mover; the old ungated
adjacent swap is removed, and local-only editors show no movement. A node selection on an
atom inside the moved unit follows it, and undo/redo return the selection to its original
logical position (exact isolated document/selection states are recorded on the undo stack
item, since structural moves replace Yjs items and relative positions can land in a neighbour).
Pointer targeting follows the hovered explicit line/item, including across the gutter.
Catalogue Insert below/Turn into continue targeting the enclosing root as specified below.
Not yet: an independent
review and a physical-phone pass of drag.

**Multi-block selection (2026-10-18).** At Paul’s request, block selection is separate
from native text highlighting. On fine pointers, drag from blank space anywhere across the
writing pane, including either margin, gaps and the unused width after rendered text inside
a paragraph or list row. Vertical movement selects complete movement units by the rows crossed,
in either direction, without requiring the rectangle to cross text horizontally. A plain click
in blank space still places the caret at that row. Movement handles hide during the gesture
and return for its selected group on release; they also hide during native text highlighting.
The rectangle and selected rows use translucent
Memberberry purple tokens in every theme. A gesture beginning in text retains native text
selection. Shift-click extends an existing block selection to an endpoint.

**Selected-block keyboard actions (2026-10-19, t-021).** Delete or Backspace on a
purple block selection removes the complete captured range in one isolated undo step.
List items and explicit paragraph lines are removed with their structural separators;
unselected text, task metadata, surviving list anchors/numbering and the protected title
remain intact. Deleting the last body block leaves an empty paragraph for continued typing.
Tab nests supported selected sibling list items together under their preceding item;
Shift+Tab lifts them together. Bulleted, numbered and task items are supported where the
schema admits the whole operation. A root task is not lifted into prose, since that would
discard its status/date attributes. Mixed scopes, incompatible item types, first items
with no preceding sibling and unsupported prose ranges remain unchanged; the keys are
consumed while a block selection exists so they cannot edit only the native caret.
Successful nesting preserves the selected range for further actions. Native text
selections retain their ordinary behavior. These structural actions reuse movement's
current-document, editability, readiness and single-editor checks and collaborative undo.

**Cut/copy between notes (2026-10-31).** Cmd/Ctrl-X cuts the complete purple range;
Cmd/Ctrl-C copies it and retains the highlight. Modifier keydown preserves the range until
the browser's clipboard event. All clipboard formats must be written before deletion;
a missing or failed clipboard write leaves the source unchanged and announces the refusal.
Block cuts reuse the same gated, isolated deletion/undo operation as Delete. Native text
selections also copy/cut normally, with document/selection readiness rechecked before removal.
Both selection modes carry standard HTML/plain text plus a transient
`application/x-memberberry-slice` payload `{version, slice}` using the Rust-owned schema
revision and ProseMirror slice JSON. In-app paste preserves marks, structural containers,
explicit breaks, nested lists and task attributes without a second Markdown codec. Unknown
schema revisions, unknown attributes/types, malformed payloads, open depths outside 0–64
or payloads above 8,388,608 UTF-16 code units fail closed. Raw attributes and the prospective
inserted document pass the existing schema admission checks, including Rust/WASM
materialization of a temporary candidate before the live replica changes. This whole-note
check happens only for explicit rich paste, never ordinary typing. Ordinary external clipboard
formats retain the existing paste behavior; this does not implement general rich HTML import.
Clipboard events/listeners are scoped to each editor and removed on teardown. Content stays
in canonical Markdown; the clipboard format is neither persisted nor a vault read surface.

Escape on a collapsed body caret selects its movement unit; Shift-Up/Down extends or shrinks
the contiguous range, and Escape clears it. The block menu offers Select block, Extend
selection up/down and Clear block selection, also reached on touch through More → Block
actions (accessible name “Select or move blocks”). Touch scrolling remains native. The
first-H1 title is excluded; nested item ranges stay inside their common parent list.

The selected range shares one handle and Move up/down actions, including More’s movement
actions. Moving preserves item order, marks, metadata and nested subtrees in one isolated
undo step. Drops inside or directly beside the same range are no-ops. Source survivors keep
the original list starting number, inserted numbered items adopt the destination sequence,
and a detached subset starts a new list at 1. A whole list retains its explicit start.
HTML ordered-list counters update sequentially; Markdown retains the canonical serializer’s
existing first-start/subsequent-`1.` marker representation.

Selection overlays and status live outside note content, clip to the visible note pane clear of
its toolbar, and are omitted from print/export. Ordinary text gestures, editing, composition,
outside focus, document changes and safety refusals clear selection. The exact range from
an applied local move can wait for its own acknowledgement, with further writes refused
until sync is ready; source changes or other safety failures invalidate it. All existing
single-editor/runtime/read-only and stale-token movement guards remain in force.


**Block catalogue (2026-10-14).** The block `⋯` additionally offers **Turn into…** and
**Insert below…**. Insert below targets the complete root under the handle, including a
whole list/table/container rather than a nested item. A labelled **Insert** toolbar button
and the existing touch long-press open the same searchable, grouped catalogue. `/` at the
end of a word boundary opens it with the typed query; choosing an item removes only that
captured trigger. URLs, dates with slashes, literal code/math and the protected title do
not trigger the slash catalogue. Escape dismisses it until fresh input; pointer dismissal,
keyboard arrows/Enter and a Close menu control are supported. The menu fits the visible
viewport below the top bar, including on mobile.

The catalogue exposes Text, Heading 1–4, Bulleted list, Numbered list, To-do list, Toggle
list, Callout, Quote, Table, Divider, Image, Code, Web bookmark, Block equation, Template,
Link to note, Date, Emoji and Inline equation. It inserts existing schema nodes only:
toggles use expanded foldable note callouts; code accepts an optional single language name;
equation forms accept authored LaTeX, with inline input excluding dollar delimiters and
line breaks. No wire-schema or Markdown-format extension is introduced. Toolbar insertion
of a block goes below the current root and preserves selected content; inline items insert
at the selection's end. Insertion from the title goes below it. Table and Divider are
insertion actions, not conversions of populated content.

**Quote styling (2026-10-14).** Ordinary quote blocks in the editor and browser-generated
HTML exports have a 3px rule at the inline start, using the theme's muted-text colour,
and a one-token (`space-6`) inset. Block spacing follows the editor's normal block gap;
first/last child margins do not add empty space at the ends of the rule. Nested quotes
retain their own rule and inset. Text retains normal readability and authored formatting;
quotes do not acquire callout styling. Storage remains ordinary `>` Markdown.

**Web bookmark** inserts an ordinary labelled Markdown link; a blank label uses the entered
URL. Only complete HTTP/HTTPS URLs without credentials are accepted. No URL is fetched,
and no rich preview is stored. **Date** inserts ordinary `YYYY-MM-DD` text from a native
date picker, initially today's local date. This does not add reminders or change task
due-date metadata. **Link to note** opens the existing `[[` document chooser and its
permission-filtered catalog (E5); selecting a note inserts an ordinary Markdown link.
Image and Emoji reuse the existing upload and picker flows. Template insertion remains
reachable. File attachments, linked-note creation, TOCs, toggle headings and the other
deferred/excluded screenshot items are not added by this catalogue request.

**Relative date mentions (2026-10-19, t-019).** Typing `@now`, `@today`, `@yesterday`
or `@tomorrow` at a word boundary opens a local date chooser. Enter or Tab accepts the
selected suggestion; Space accepts an exact keyword and preserves the separator.
Arrow keys select suggestions, pointer/touch selects directly and Escape leaves the
trigger literal. Code, links, math and the protected title do not complete mentions.
Confirmation captures a fixed local calendar value, stored as ordinary `YYYY-MM-DD`
text or, for `@now`, `YYYY-MM-DD HH:mm` text. Time precision is one minute. Timed
values are local wall-clock values without a timezone offset, not portable instants.
No schema, wire revision, Markdown parser or serializer change is needed.

Valid standalone ISO dates/datetimes in rich-editor body text, including those inserted
by the existing Date command, render as muted, keyboard-focusable `@` date buttons.
Consequently an existing plain ISO date in prose also receives relative presentation;
source mode, exported content and copied document slices retain the original ISO text.
Code, math, link text, escaped dates, identifiers, timestamps with zone/seconds and the
protected title remain literal. Dates split by ordinary formatting still render once.
Today, Yesterday and Tomorrow take precedence; differences of two through seven local
calendar days, inclusive, show Last/Next weekday. Beyond that, show a localized full
month/day/year date. Optional times use the browser's local time format. Day comparisons
use calendar fields rather than elapsed hours, preserving the boundary across DST.
Labels refresh at minute boundaries and on visibility/focus return without editing note
content or generating a Yjs document update. Relative words are English; calendar and
clock formatting follow the browser locale.

Hover and the accessible name expose the absolute human-readable date and optional
time. Clicking a date, or activating its focused button with Enter/Space, opens a modal
with Date, Include time and Time fields. Save validates local calendar fields and
replaces the captured ISO text in one undoable edit. Cancel/Escape leaves it unchanged.
A document change or loss of editability invalidates the captured modal. Read-only
editors display relative dates but cannot edit them. Arrows traverse a date as a unit;
Backspace/Delete at its boundary removes the complete date. Source editing remains
the way to author literal ISO text directly. There are no reminders, relative task
metadata changes, external lookups or dependencies in this feature.

**Turn into…** reuses the existing complete-text-block conversion engine and its
single-editor gate, with a visible warning and a fresh invocation check. Mobile users can
also open it through More. Containers are not implicitly unwrapped; unsupported selections
receive an explanation. Every insertion/form captures the exact document and destination;
a changed document, read-only state, source/waiting/composing state or destroyed editor
refuses a retained action. An open insertion form prevents the refresh-required Reload
action from discarding its draft. Editing controls stay outside serialized note content.

**Structural-conversion scope decision, 2026-10-04.** Held peer typing survives ordinary
edits but can disappear during heading/list/quote/callout conversions through the current
binding, even when replicas converge; local undo does not recover that intent. After this
was disclosed separately from movement, the user selected:
“Yes—single-editor conversions, with a visible warning and refusal on known peers,
duplicate editors, disconnected/unsynced notes or pending writes.” Paragraph ↔
heading/list/task/quote/Note-callout/representable code/math conversion therefore has the
same explicit single-editor-per-note limitation as rearrangement, not a collaborative
structural-identity guarantee. Do not redesign collaborative content/order identity in
this iteration or relabel the retained concurrent-intent failures as successes.

- Before enabling structural conversions, render the single-editor warning and recheck
  actual note/editor/document identity, known peer presence, duplicate mounted note editors,
  connection/sync readiness, pending writes and ordinary editability/admission/lifetime
  conditions at both capability and invocation boundaries. Missing routed context fails
  closed; synthetic local fixtures are explicit controls, not proof of routed safety.
- Another tab/browser/device must not edit that note while converting blocks, including
  hidden offline replicas. Awareness detects known peers only and is not a distributed lock.
  Ordinary typing and inline formatting remain on their existing authorized sync path.
- Preserve selected authored content, marks/atoms, metadata, title boundaries, neighboring
  blocks and ordered local undo/redo. A portable PM/Markdown value does not prove safe undo
  for its actual imported Yjs source shape. Unsafe fragmented imports remain refused without
  hidden normalization or writes; narrowing a conversion capability must be visible and
  consistent between disabled choices and direct handlers. Never enable a destructive
  conversion merely because concurrent conversions are now explicitly unsupported.
- This is the approved target contract, not integration or runtime certification. Warning,
  guard machinery, routed wiring, actual schema-2 union, browser/server/disk reopen and
  independent review are required before enabling the resulting controls.

**Implemented: "Turn into" (2026-10-08).** The selection popup's first control is a
`Turn into` select. It acts on every complete root textblock the selection touches, in one
isolated undo step:
- Text ↔ Heading 1–4 (imported H5/H6 show as their active state). H1 is refused at the first
  root (title protection).
- Wrap into Bulleted list, Numbered list or To-do list (one item per block), Quote, or a Note
  Callout with an empty title. Each block moves in unchanged — headings stay headings, and
  marks and `^anchors` are kept.
- Code and Block equation join the blocks' text with newlines. Only plain text converts:
  marks, links or atoms are refused as `formatted` rather than silently dropped, and more
  than one block anchor is refused as `anchored` (a code block holds one).
Selections inside lists, quotes, tables or other containers hide the control rather than
flatten them; unwrapping a container back to Text is not implemented yet.

**Toggles (decided 2026-10-09: foldable callouts).** The user chose Obsidian's foldable
callout as the toggle's Markdown — `> [!note]+ Summary` (starts open) / `> [!note]- Summary`
(starts folded) — over HTML `<details>` (new raw-HTML parser support) or no toggles. No new
syntax: callouts already parse and round-trip their fold.
- Turn into → Toggle makes the first selected block the summary (its inline content, its
  `^anchor` moved to the toggle) and the rest the body; a single block gets an empty body
  with the caret in it. New toggles are written `+`.
- In the editor every foldable callout gets a ▸/▾ button (`aria-expanded`), and Mod-Enter
  inside it folds; outside a toggle Mod-Enter keeps Tiptap's default. The file's `+`/`-` is
  only the default: folding changes the reader's own view, never the note — no edit, no
  sync, works read-only — so a fold is not shared and is not remembered across reloads. To
  change the default, edit `+`/`-` in source. A caret inside a body being folded moves to
  the summary. The arrow is CSS, so the summary's text stays the file's.
- `note`-kind foldable callouts render as plain toggles (ordinary summary text, no callout
  box); foldable warnings, tips etc. keep the callout look and gain the arrow.
- Shares and exports render foldable callouts as `<details>`/`<summary>` (`open` for `+`),
  so they fold without script; plain callouts stay `<div>`.

**Line break in a block (requested 2026-10-14: Shift+Enter, not Cmd/Ctrl+Enter).** Shift+Enter
in a paragraph — top level, or inside a list item, quote, callout or toggle body — starts a
new line in the same block: a Markdown hard break, written `\` + newline. Plain Enter still
starts a new block. Headings and toggle summaries are single-line in Markdown, so Shift+Enter
there does nothing; a table cell keeps its own Enter handling (§4). A break at the very start
or end of a block is not representable and drops on the next parse; the editor keeps it
until then, so the next line can be typed. Soft keyboards rarely send Shift+Enter; there is
no on-screen route yet.

- **Single-editor gate (`single-editor.ts`).** Shared with block movement. Refuses, at both
  display and invocation: a different mounted editor for the same note key, any known
  awareness peer, a disconnected or unsynced transport, and unsent writes. Several gated
  controllers on one editor are one mount. The note key is `[vault, note path]`, so two
  editors only collide on the same path; it is not a lock and cannot see hidden offline
  replicas.
- **Fails closed without routing.** A local-only editor (no bootstrap) has no note key and
  renders no `Turn into` control.
- **Visible warning and refusal.** The choices sit in an option group labelled with the
  single-editor warning, shown wherever the list opens. A refused control is disabled and
  its visible text names the reason (e.g. "Text · Someone else has this note open").

**Style control (2026-10-08): one "A" button, not three selects.** Three unlabelled selects
that all read "Default" did not say what they changed. The popup has one `Text color,
background and size` button whose "A" is drawn in the selection's own colour and background.
It opens a panel with visible headings — Text color, Background, Size — whose choices are
rendered with the note's own `mb-` classes (Default + nine colours; Small / Normal / Large).
The current value is pressed; a mixed selection says `· Mixed` in the heading and presses
none. A choice applies at once and the panel stays open, so several dimensions can be set in
one visit; the applied range is the action's own result and becomes the new capture. Escape
closes the panel and returns focus to the "A". All choices disabled (e.g. literal Code)
disables the button.

**Compatibility decision, 2026-10-04.** Asked whether the upgrade may require editor
refreshes instead of retaining old-cache editing compatibility, the user answered:
“no need to keep anything cached, we are in development mode and there is only one other
developer using it in production and he can refresh just fine”. Use a coordinated server/
editor upgrade and an explicit refresh-required schema mismatch, rather than a backward-
compatibility or old-replica migration framework. New-schema replicas may start from the
server in a revision-isolated namespace without importing old cached/offline edits. This
is not authorization to deploy, modify real notes or proactively clear caches during
implementation. Version admission/preflight still prevents an incompatible editor from
mutating or sending unsupported content. Schema revision and lib0 wire encoding are
separate: a new editor schema does not change the existing lib0 v1 update format.

**The editor's existing control strip, M7 follow-up.** The strip above a note is a toolbar, a slash
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

**Scroll-safe task activation (2026-10-03).** Scroll offset updates cannot replay an inbox
edit: one deliberate action is consumed only once across pane updates, remounts and splits.
An unopened source defers the action until its authorized body is ready; revoked/read-only
or destroyed surfaces cannot apply queued edits. Missing task ordinals are inert, not
requests to act on a task introduced later. Native touch/pen scrolling, cancelled gestures
and ancestor scrolls do not activate checkbox or metadata controls; a new deliberate tap
and the keyboard inspector remain available. Scrolling leaves the task DOM and document
unchanged rather than repeatedly focusing or recreating controls.

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

**Drawing a large inbox (2026-11-09).** Each group draws its first 50 rows (`INBOX_PAGE_SIZE`
in `web/src/shell/tasks.ts`); a **Show N more** button under the group reveals the next 50,
labelled with how many are not shown. The group heading still counts every task, filters and
sort still apply to the whole answer, and the offline inbox is unchanged. The whole list is
still fetched; only drawing is paged. The sidebar's Tasks view draws no rows while it is
hidden (another navigation view is showing, or the left sidebar or mobile drawer is
collapsed). The main-panel inbox always draws. Expanded groups reset when the pane remounts.
Why: every row is about 17 elements, and on the 10k perf vault, with one task per note, the
always-mounted sidebar inbox drew about 170,000 hidden elements on every page.

**Task presentation and placement (2026-10-03).** The sticky Tasks heading has a right-hand
three-dot menu. **Open in main panel** opens the same filtered inbox in the main area, with
Close and existing note tabs retained, not a synthetic Markdown note or persisted tab type.
Its URL is the vault Home URL; opening/editing a source task returns to that note. On mobile,
opening the main view or a source note closes the navigation drawer. Main and sidebar inboxes
share filters, sort and display preferences, with unique HTML control/heading identities.
**Show filenames** replaces the source heading with the original basename including `.md`;
**Show file paths** independently adds the full vault-relative path. Both default off and
are stored per user/vault/device, separately from the file-tree setting. Blocked storage
leaves the in-memory controls usable. A labelled, touch-sized checkbox sits to the left of
each editable task instead of the former Toggle button; it uses the same source-editor write
path, not a separate persistence endpoint. Inbox completion is idempotent: checking a
cached row again cannot undo a task already completed in its source. Refused edits never
pretend to be saved. Due and priority controls remain available.
The heading stays visible in both the sidebar and main scrollports.

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

Artwork needed by rendered custom shortcodes or inline suggestions loads independently,
without delaying editor readiness. Active authenticated views share an ephemeral per-vault
catalog from E22; the last subscriber aborts pending work and drops that catalog. A successful
image import updates mounted views immediately and cannot be lost to an older catalog response.

### 11.2 Custom emoji

Custom emoji support **server-level sharing across vaults** (A21), with optional vault-local
additions. The picker imports individual images into the current vault (A33). Packs remain
the storage and administrative API format for compatibility with existing artwork.

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

- **Image upload:** the picker's **Import custom emoji** opens a file chooser for one PNG,
  GIF, JPEG or WebP image. Every import prompts for an editable **Emoji shortcode**,
  prefilled from the filename (`party-parrot.gif` → `party-parrot`). Names without an ASCII
  shortcode suggestion use `custom-emoji`, which the user can replace (A34). Entered names
  use the same normalization as filenames, including lowercase and optional surrounding
  colons. Cancellation, empty/invalid names and collisions with existing shortcodes or
  aliases upload nothing; invalid/duplicate names report that a unique shortcode is required.
  The picker has no pack-name prompt, pack-management
  panel, folder import or ZIP import. Cancelled, multiple, unsupported or empty selections
  upload nothing. Errors are reported without adding a picker entry, and upload can be retried.
- **Vault settings (A36, §20.4):** the vault owner lists, adds, renames and deletes the
  vault's own emoji, and removes aliases. Shared server emoji are listed read-only. Adding
  uses the same single-image upload as the picker. **Delete** removes the manifest entry,
  its image when no other entry uses it, and the pack once empty. Notes keep `:name:` as
  readable text (§11.3). **Rename** rewrites `:old:` to `:new:` in every note, including
  notes the owner cannot read, as a privileged operation under E14's rules. The rewrite is
  verified like a tag rename (`mb_core::rewrite::rename_emoji`), so code, maths and wikilink
  targets are untouched, and a frontmatter `icon: ":old:"` is renamed too. Matching is ASCII
  case-insensitive. The old name stays as an alias, so a replica that was offline during the
  rename still renders when it syncs `:old:` back. The new name may not collide with any
  local or shared name, except one of the emoji's own aliases (which swaps the two).
  Rewrites are planned before the manifest changes. A note-write failure after the manifest
  changed leaves the old name working through its alias.
- **Storage compatibility:** each image uses a generated `emoji-<UUID>` storage identifier
  and a one-entry manifest through the existing vault upload API. Pack identifiers are not
  part of the import UI. Existing manifests, artwork, authorization and export keep their
  format. Pending file reads and uploads cannot update a destroyed picker; upload requests
  are cancelled on teardown.
- The management API accepts a bounded JSON upload containing the manifest and base64 image
  files: `PUT /api/v1/emoji/packs/<name>` requires server admin, while
  `PUT /api/v1/vaults/<slug>/emoji/packs/<name>` requires vault owner. Pack names and files are
  validated before an atomic install; existing packs return conflict rather than being silently
  replaced. These administrative endpoints remain available independently of the picker.
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
everywhere including in a plain text editor — better under C2. Typing `:tada:` autocompletes
to 🎉. Custom picker selections, autocomplete selections and completed typed shortcodes
insert the existing `emoji` schema node and serialize as `:partyparrot:`, without accidental
Markdown escaping or persisted image URLs.

The authenticated app displays known custom emoji as inline artwork in note bodies/titles,
navigation and tab labels/icons, folder contents, search/home/outline labels and transclusions.
Canonical names and aliases resolve case-insensitively through E22's authorized images.
Title/outline text extraction and plain-text copying retain the shortcode rather than
dropping the image node. Unknown names, failed catalogs or image failures show the readable
shortcode. Code blocks and inline code remain literal.

Older replicas may contain plain-text shortcodes inserted by the old picker, including
escaped Markdown. They receive view-only image decorations outside code; rendering never
rewrites their CRDT or Markdown, so no concurrent migration can duplicate note content.
Changed legacy text is rescanned within affected blocks, not across the whole note per key.

Standalone HTML exported from the authenticated rendered note embeds its emoji images like
other media (§19.2). Anonymous share rendering and CLI HTML rendering currently keep the
readable shortcodes; they do not reuse authenticated vault image URLs.

### 11.4 Picker

Grid with search, frequently-used, category tabs, **Custom section first**, skin-tone
selector. Inline editor autocomplete opens on `:` plus one following character at the start
of a text block or after whitespace, showing up to eight catalog entries. A bare colon
keeps it closed; deleting the query back to just `:` closes it. Additional characters filter
by fuzzy shortcode/alias matching. Arrow keys
select, Enter or Tab inserts, and Escape dismisses without changing the typed text or
selecting its containing block. The list stays within the viewport, flips above the caret
when needed and scrolls if available height is limited. Mobile:
bottom sheet. Clicking or tapping outside the picker closes it without consuming the
outside interaction. Escape closes an open picker even after focus moves elsewhere,
returns focus to its Emoji toggle, and consumes that key so other Escape actions do not
also fire. Escape has no picker effect while it is closed. Picker controls remain usable
without dismissal, and its toggle can close or reopen it.

Inline suggestions include the authorized custom catalog when it arrives, with image
previews. Picking a custom suggestion inserts its canonical shortcode as an emoji node;
Unicode suggestions still insert literal glyphs.

Note/folder naming dialogs offer the offline Unicode catalog immediately on `:`, including
at the start of a name or after `/` in a nested path. Arrow keys select; Enter inserts the
literal glyph without submitting the form; the first Escape dismisses suggestions. Pointer
and touch selection return focus to the name field. Exact-name destructive confirmations
never autocomplete. Folder labels in the note tree and folder contents resolve recognized
Unicode shortcodes/aliases and authorized custom artwork for display without rewriting the
underlying directory path. Unknown names and unavailable artwork remain literal. Name inputs
remain plain text, and no Markdown interpretation is applied to names.

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

### 12.5 Note cover images

Authenticated note panes can display an optional wide, cropped banner above the title.
Editors use **Add cover** to upload PNG, JPEG, GIF or WebP through the existing vault media
uploader; **Change cover**, **Remove cover**, and a keyboard-operable **Reposition** slider
remain available on desktop and touch layouts. Once a cover is set, these controls are
collapsed into an **Edit cover** button over the image. On desktop the button appears when
hovering the cover or focusing its controls with the keyboard; it stays visible while the
controls are open. Touch layouts keep the button visible. Enter/Space opens the controls;
Escape closes them and returns focus to the button, including when a pointer click left
keyboard focus in the editor or on the page body. Without a cover, a compact empty
area above the title reveals a centered, rounded, theme-accented **+ Add cover** button
on hover or keyboard focus; touch keeps the button visible. Its source chooser is centered
beneath it and offers **Choose from files** and **Paste from clipboard** options.
Actions are stacked in equal-width, left-aligned rows, with the helper text aligned below
a divider. Clicking or tapping outside either cover menu dismisses it without consuming
the pointer event or moving focus away from the chosen target. Pointers inside the menu
leave it open so file selection, clipboard actions and repositioning remain usable.
Clipboard access is attempted only on request; denied or unavailable access offers the
paste shortcut or file selection, and a clipboard without an image gets an explicit message.
The paste shortcut works while a cover control has focus, including with the menu closed.
Only image bytes are accepted; clipboard text, HTML and image URLs are never fetched.
Viewers see the banner without edit controls or an empty target.
No remote image service, URL fetch or new dependency is involved.

Dragging an image over the note highlights the cover area with **Drop image to set cover**.
Only dropping onto that area assigns a cover; body drops continue through the existing
inline-image flow. Nested drag transitions retain the highlight until the drag leaves
the note, completes or is cancelled. File selection, clipboard input and cover drops
share the same upload, offline, format validation and stale-destination checks. Desktop
files with an empty MIME type are accepted by supported filename extension, with the
server still verifying their bytes. Clipboard reads in flight are discarded if the
destination changes or loses edit readiness before the read completes.

The Markdown frontmatter stores `cover: media/aa/bb/<hash>.png` and optional
`cover_position: "50"` (vertical percentage, 0–100; default 50). These are ordinary scalar
extra keys (§4.5), merged per key through the existing `frontmatter` Y.Map (§5.6); no schema
revision is needed. The image retains its intrinsic bytes; repositioning changes only the
display crop. Invalid or external paths are never fetched. Invalid positions use 50;
numeric values above 100 clamp to 100. Removing a cover removes both keys; the existing
unreferenced-media policy applies to its bytes.

Extraction indexes scalar `cover` references alongside body media for E11, exports and
garbage collection. A cover referenced only by a denied note grants no access, even if its
hash is known. Cached metadata is not rendered while the note body is waiting. Pending
uploads fail closed after a cover changes, is removed, loses edit readiness, or closes.
Offline uploads retain the previous cover until the upload finishes, and never put an
optimistic blob URL into frontmatter. A queued cover must finish while its note remains
open to be attached; a closed note needs a new selection. This avoids persisting transient
references as the only copy of an intended setting.

This first version decorates authenticated note panes and browser print/PDF. Anonymous
share rendering and browser HTML exports continue to render the note body without the
banner; vault/Markdown exports retain the frontmatter and authorized referenced media.

---

## 13. Diagrams

### 13.1 Excalidraw

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

### 13.2 Mermaid (A38)

Mermaid diagrams, Gantt charts first among them, are in scope. A38 reverses A9's exclusion. It
accepts that **pages containing Mermaid diagrams may miss the mid-range Android budgets** (§21.2).
That is a scoped exception, not a relaxed budget.

- **Storage: a plain fenced `code_block` with `lang` `mermaid`.** This adds no new block type, schema
  node or serializer path, and round-trips through the existing `code_block` rules (§4.4, §22.1).
  The source is the content (C2): it stays readable in a text editor, and Obsidian, GitHub and
  GitLab render it natively (C5). Rendered SVG is never written into the vault.
- **Rendering.** The `mermaid` package is a lazily loaded chunk. It is imported only when a note
  that contains a ` ```mermaid ` fence is opened, and each diagram renders only when it scrolls into
  view. It is **never on the critical path**. The initial-bundle budget (§21.2) excludes it.
  `make perf-bundle` fails if a Mermaid chunk is statically imported by an eager one; a static
  import folded into the app chunk itself breaks the bundle budget instead. Mermaid measures text through the DOM, so it cannot
  run in a Web Worker (§21.3). That is the honest reason this exception exists.
- **Editing.** A diagram renders as a preview. Its source is hidden until the caret is inside
  it. *Edit code*, or an arrow key from the adjacent block, puts the caret there. A click on
  the diagram does not: in the user's words, *"is there a way not to display the code on
  single click, only have a button 'Edit code' that would display it"*. The preview ignores the
  click, and its node view stops the event, because otherwise ProseMirror places the caret
  inside the block from the click itself. Moving the caret out, or *Done*, hides the source
  again. *Done* moves the caret to the next text after the diagram, else the text before it,
  else a new empty paragraph after it. A search from the end of a note otherwise ran back into
  the diagram's own code and left it open. **The caret enters a diagram's code only on
  purpose:** *Edit code*, an arrow key from the adjacent block, a newly inserted chart, or the
  Gantt editor's *Edit as text*. Each of these marks its transaction (`MERMAID_ENTER`). Any
  other way the caret lands there is moved to the nearest text outside the diagram, without
  editing the note. That covers a note opening with its first body line inside a diagram, or
  a collaborator's edit. Staying inside the same diagram (typing, a remote edit while editing)
  is left alone. Limit: a note that is *only* a diagram has no text to move to, and opening a
  note must not add one, so there the code shows. Escape keeps its §8.4 meaning (select the block). Read-only notes get *Show code*
  instead. The source is edited
  as an ordinary code block, and the preview re-renders after a debounce, never per keystroke.
  A syntax error shows the source with Mermaid's message inline. A failed render never throws,
  never blanks the block and never blocks editing.
- **Offline.** Like every lazy chunk, it is precached after the load event (§7.4), so diagrams
  render offline. Excalidraw's `mermaid-to-excalidraw` already depends on `mermaid`, and npm
  dedupes the two to one copy. So the precache does not grow, provided the version stays
  the one Excalidraw resolves to (11.x at the time of writing).
- **Security.** `securityLevel: 'strict'`, so labels are sanitized and click/callback
  directives are disabled. No network access: remote icon packs and font loading are disabled
  (C1). Diagram source comes from other vault members, so it is treated as untrusted input, and
  the inserted SVG is sanitized output. The app CSP already allows the inline `<style>` Mermaid
  emits (`style-src 'unsafe-inline'`). Scripts stay `'self'`.
- **Permissions.** Rendering is client-side over block text the client already received
  through the permission-filtered sync path. It adds no read path and no enforcement point
  (§6.4). Search indexes the source as code-block text, as before.
- **Theming.** Mermaid's `base` theme, with `themeVariables` read from the design tokens (§20.1).
  Diagrams re-render on theme or accent change. No hard-coded colours.
- **Gantt layout.** A Gantt chart is laid out at the preview's width, in 40px steps and never
  below 640px, and keeps that size rather than being scaled to fit. Below 640px its date axis
  overlaps, so a phone scrolls the chart sideways. The default axis format is a short date
  (`%e %b`, as in `2 Nov`), and a diagram's own `axisFormat` overrides it. **Design
  (2026-11-09):**
  - The left margin is sized from the longest phase name (7.4px a character plus 32px, from
    80 to 280px). Mermaid's 75px default let names run under the bars.
  - Bars are 26px with 8px gaps and rounded corners, and type is 12px for tasks and 13px bold
    for phase names.
  - **Phases are told apart by colour** (*"those phases could be handled differently, it is
    not visible enough"*). Each phase takes the next chart-series token: `--series-2`,
    `-1`, `-4`, `-3`, `-5` and `-0`, with red last so a first phase does not read as an
    alarm. Each phase's band is a light tint that the grid shows through, and its name is
    bold in that colour. Its bars are filled with a mix of it and outlined in it: stronger
    while active, faded when done, and outlined in `--state-danger` when critical. After
    drawing, the note view adds a stripe in the phase's colour down its left edge and a line
    where each later phase starts. A task's own colour (A40) still wins.
  - The grid is light and dotted, and the today line is dashed.
  - After drawing, the note view hides any date label that would overlap the one before. At a
    note's width, Mermaid's own ticks ran together.
  - **Zooming and moving around** (*"lets have the presentational part as useful as it can be
    with easy zooms and movements"*). A Gantt chart in a note has zoom controls beside
    *Edit chart*: zoom out, the current zoom (which resets to 100%), zoom in, *Fit* (the
    chart's width fills the box) and *Today* (scrolls today a third of the way in; offered only
    when the chart shows today). Zoom runs from 25% to 400% in fixed steps. Ctrl or ⌘ with the
    wheel, which is how a trackpad pinch arrives, zooms around the pointer; a two-finger pinch
    does on a touch screen. Dragging with the mouse moves around a chart bigger than its box,
    and the click ending a drag is not taken as a click. Touch scrolls natively. Zooming scales
    the drawn picture and then re-thins the date labels. It changes nothing in the note and
    lasts while the note is open, through re-renders. Other Mermaid diagrams scale to fit as
    before and have no zoom.
  - **Long names are shortened** (*"When the text it too long, shorten it and reveal on click
    or hover"*). After drawing, a task name that does not fit its bar is put inside the bar
    and cut to fit with "…". A bar under 40px keeps its name beside it, cut at the chart's
    edge. Milestone names are left to Mermaid. A phase name is cut to its name column, or to
    the chart's width when phases are rows. Cuts fall between characters, so an emoji is
    never split. Hovering the label or its bar shows the full name in a tip above it. A
    click or tap keeps the tip open until a second click or a click elsewhere in the chart.
    The full text is unchanged in the source, so *Edit code* and the editor are the keyboard
    route to it. The preview is a single image to assistive technology (`role="img"`), so
    the labels are not separately focusable. In the visual editor, a long name is cut inside
    its bar by an estimated width, and the full name is the bar's hover title and is in the
    task list.
  - All of it is `themeCSS` built from design tokens (`GANTT_CSS` in
    `web/src/mermaid/renderer.ts`), so it follows the theme. Resizing the window
  does not re-render. A diagram renders again only on its next edit, theme change or open.
- **Public shares (§17).** The public renderer ships no JavaScript, so a shared note shows
  the diagram source as a code block in v1. Server-side pre-rendering is an open question,
  not a promise.
- **Performance exception, and its limits.** The exception covers only *open note*, *longest
  main-thread task* and *INP* on a page that contains Mermaid diagrams, and only for the
  render itself. Notes without a diagram must meet every budget, and typing elsewhere on a
  diagram page must still meet keystroke → paint. In the user's words, *"Wherever possible we
  find alternatives"*: render lazily, cache SVG in memory by source hash, and reach for a
  lighter approach where one exists before leaning on the exception. `make perf` measures a
  diagram-page fixture in three rows of its own (§21.10), so the exception is measured, not
  assumed. A miss is carried in `breaches.json` at its measured value, as a ratchet.

### 13.3 Visual Gantt editor (A39)

A drag-and-drop editor for Mermaid `gantt` charts. Memberberry gets it first; a Confluence
Cloud macro reuses the same component later (A39). **It edits text and stores nothing else.**
The note still holds the ` ```mermaid ` fence of §13.2 (C2), and the note's preview is still
Mermaid's render. The editor is only a better way to write that text.

- **One self-contained component, `web/src/gantt/`.** Plain TypeScript and DOM, no Svelte, and
  no imports from the rest of the app; a test fails if it gains one. A host passes the source
  in and gets the source back. The Confluence macro imports the same files. Its stylesheet uses
  the design-token names of §20.1, which another host declares for itself. The token check
  allows no private `--ge-*` names.
- **What it understands.** `title`, `dateFormat YYYY-MM-DD`, `axisFormat`, `excludes weekends`,
  `todayMarker`, `section`, comments (`%%`), and task lines
  `Name :[tags,] [id,] start, end`. Tags are `done`, `active`, `crit` and `milestone`. *start*
  is a date or `after id [id …]`. *end* is a date or a whole number of hours, days or weeks
  (`36h`, `5d`, `2w`). Any other directive or comment line is kept verbatim, in place. A chart that uses
  something outside this set (another `dateFormat`, hours, `until`, `click`) opens **read-only**
  in the visual editor with *Edit as text*. The editor never writes a lossy version of it.
- **Round trip.** Open and Save with no change writes the source back byte-for-byte. An
  edited task is rewritten in one canonical form; untouched lines stay exactly as they were.
  Property tests cover parse → serialize → parse for every supported construct (§22.1).
- **Scheduling.** Each task's start and end come from its dates, its length and its `after`
  dependencies, in calendar days, or working days under `excludes weekends`, as Mermaid
  computes them. An hours length ends part-way through a day, and a task after it starts
  there, so positions are fractional days. A start date is always a whole day, so moving a task
  that started mid-day pins it to the start of the day it lands on. An unknown id or a dependency cycle marks the task as an error in the table.
  The task is still drawn, never silently moved.
- **Layout.** A modal dialog, full-screen below 768px (§8.3). It has a timeline and a task
  table (name, start, length or end, starts after, status). The default puts the chart above
  the tasks, with a divider between them. A task row has: a grip, name, start, *Ends* (choose
  *End date*, *Hours*, *Days* or *Weeks*, then the value), *Starts after*, colour, status and a
  Milestone toggle. Switching how a task ends keeps its bar where it is, rounded to the new
  unit and never below one of it. An end date keeps Mermaid's meaning: the bar ends at the
  start of that day. There is no Critical toggle, at the user's request (*"We can probably
  remove Critical button"*). A `crit` tag a chart already has is kept and still drawn. Drag the divider, or use Up and Down on it, to move
  it between 20% and 80%. *Side by side* puts the table beside the timeline instead, with the
  rows lined up and scrolled together. The choice is remembered per browser (`localStorage`;
  blocked storage just keeps the default). When the panes are stacked, a row and its bar no
  longer share a line, so focus in either one marks that task in both and scrolls the other
  into view. The timeline fills its pane's width, so a short chart shows more dates rather
  than empty space. On a phone the two panes are tabs. The toolbar has the chart title, zoom (days, weeks,
  months), Undo and Redo, Add task, Add section and View source. Cancel and Save sit at the
  bottom. It opens at the zoom that fits the chart: days up to three weeks, weeks up to about
  four months, then months. The timeline scrolls to today when today is in range, and keeps its
  scroll position across edits.
- **Direct manipulation.** Drag a bar to move it, or its end to change its length; both snap
  to whole days. Drag from a bar's connector to another bar to make the second start after the
  first. A milestone is a diamond and only moves. Moving a task that starts `after` another
  pins it to the new date and drops the dependency; the status line says so, and Undo restores
  it. Pointer events cover mouse, pen and touch. The timeline is `touch-action: pan-y`. A
  vertical swipe scrolls natively, and horizontal movement reaches the editor: it drags a bar,
  or pans the timeline over empty space. Chrome reads `touch-action` from the `<svg>` box, not
  from the shapes inside it, so a rule on a bar alone let the browser cancel a touch drag as a
  pan. The touch E2E test guards this.
- **Moving a task to another phase.** A task's section is only where its line sits, so
  moving between phases means moving the line. In the task list, drag a row by its grip (⠿).
  The list scrolls while you drag near its edges, and a line shows where the task will land.
  In the chart, drag a bar more than half a row up or down. Sideways movement in the same drag
  still changes its dates, and the whole drag is one undo step. On a phone a vertical swipe
  scrolls the chart, so rows move with the grip there. Alt+Up and Alt+Down move the focused
  task one row, crossing a section line into the next phase. They are not taken from a
  `<select>`, where Alt+Down opens the list. **Moving never changes a date.** Mermaid's
  one-field form (`Polish :3d`) starts a task right after the line above it. So the moved
  task, the task that was below it, and the task that ends up below it each get an explicit
  `after <id>` for the task they really followed, or a date when nothing was above. A seeded
  property test moves tasks at random and checks every date.
- **Task colours (A40).** Mermaid has no per-task colour, so a colour is a comment Mermaid
  ignores: `%% color <task id> <value>`, one line per task, kept together after the chart's
  directives. The value is a note colour name (gray, brown, orange, yellow, green, blue,
  purple, pink, red) or any `#rgb` / `#rrggbb` hex. Anything else is ignored. In the user's
  words: *"If the color starts with # and is hex - use any color. otherwise lets have
  preselected note colors and then a picker"*. A note colour uses its theme tokens, so it
  follows light and dark. A hex colour outlines the bar in exactly that colour, with a 35% mix
  of it as the fill, so task names stay readable in either theme. The value `none` is an
  explicit *No colour*: a plain bar in the surface and muted ink, rather than the phase's
  colour (A41). The editor's Colour column offers *Phase colour* (no line), *No colour*, the
  nine note colours and *Custom…*, which opens the system colour picker.
  A task gets an id when it is first coloured; removing it removes its colour line. Values are
  validated strictly before reaching a style attribute. In a note, the rendered Mermaid chart's
  bars are coloured after rendering: Mermaid names each task bar `<diagram id>-<task id>`.
  Other renderers (GitHub, Obsidian) show the chart uncoloured. `web/src/gantt/colors.ts` and
  `fit-text.ts` are the only files in `src/gantt/` the startup bundle may contain, since the
  note view needs them.
- **Phase colours.** A phase is coloured automatically, from its position in the palette
  (§13.2). In the editor's phase row it can be set to *Auto*, *No colour* (`none`: no band,
  stripe or tint, the name in the text colour, plain bars), a note colour or *Custom…* (in
  the user's words: *"select automatically a colour for a phase but allow for its change in
  the editing mode"*). A chosen colour is a comment line with the other colour lines:
  `%% section-color <value> <phase name>`. The name runs to the end of the line, so spaces are
  kept. It is keyed by name because phases have no id; renaming a phase in the editor carries
  the colour along, and removing the phase drops it. Phases that share a name share a colour.
  A phase with its own colour still counts towards the palette, so the phases after it keep
  their automatic colours. The editor's timeline shows phase colours too (tinted header,
  stripe, name and bars), so it matches the note. In the note, a phase's own colour is applied
  after rendering to its bands, stripe, name and bars, keeping each bar's state. A task's own
  colour still wins.
- **Adding a task to a phase.** Every phase in the task list ends with a thin *+ Add task* row
  (in the user's words: *"under the section as the last thing show thin section what would
  make a new row"*). So do the tasks above the first phase, when there are any. It adds a task
  as the phase's last, starting when its last task ends, and puts the cursor in its name. An
  empty phase has one too. Its accessible name says which phase it adds to. The timeline
  leaves the same room, so table and timeline rows still line up side by side. On a touch
  screen the row is a full touch target.
- **Chart style (A41).** Three chart-wide settings, each a comment line kept with the colour
  lines: `%% option <key> <value>`. A setting at its default writes no line, and unknown keys or
  values are ignored.
  - `phases column|row`: phase names in a left column (Mermaid's own layout, the default), or
    as a header row above each phase. Mermaid has no row layout, so the note rearranges the
    rendered chart: it opens a header row per phase, moves the name into it, shifts the bars,
    labels and milestones below it down, and grows the grid, today's line and the picture. The
    name column is dropped, so bars start near the left edge.
  - `phase-fill whole|name`: the phase colour fills the whole phase (bands and a stripe, the
    default), or only its name: an outlined cell behind the name in column layout, or an
    outlined header row in row layout. In the user's words: *"we would have only a header row
    or a column with color. If it is a color, there should be some "border" colored"*.
  - `rows fixed|zoomed`: the standard row height, or taller rows (36px bars) with larger text.
  - `max-height full|small|medium|large`: how tall the chart may be in a note: its full height
    (the default), or 20, 30 or 45rem, past which it scrolls inside its box (*"some config
    option to have max height in case there is a ton of tasks"*). Mermaid draws the date axis
    at the bottom, so while a capped chart is taller than its box the note view repeats the
    axis's dates in a header that stays at the top of the box as it scrolls, and scrolls
    sideways with the chart. The header copies the drawn axis (its dates, their places and
    the labels thinned out of the way), redrawn after every zoom. It is hidden from assistive
    technology, which reads the axis with the chart.
  The editor's *Style* button opens a panel that sets them (*Phase names*, *Phase colour*,
  *Row height*, *Max height*); Escape or a click elsewhere closes it. Its own timeline
  always shows phases as header rows and keeps its row height, since those are how the editor
  works; it follows the phase fill. Other renderers ignore the lines and show Mermaid's layout.
- **Keyboard (§8.4).** Nothing is pointer-only. Table cells are labelled form controls, and
  dependencies are set with the *Starts after* control. A focused bar moves a day with Left and
  Right and changes length with Shift+Left and Shift+Right. Enter in a task's name adds a task
  below it. Mod+Z and Mod+Shift+Z undo and redo inside the dialog. Escape cancels, asking first
  when there are unsaved changes.
- **In Memberberry.** An editable note's Gantt chart gets *Edit chart*, which opens the
  dialog. A double-click (a double tap on a phone) on the chart opens it too, and the pointer
  over such a chart is a hand. Other Mermaid diagrams and read-only notes ignore a
  double-click, and a single click does nothing (§13.2). Save replaces the code block's text in one transaction: one undo step in the note,
  synced like any edit. A read-only note gets no *Edit chart*. The Insert menu gets *Gantt
  chart*, which inserts a starter chart and opens the editor on it. If another member changed
  the chart while the dialog was open, Save does not overwrite it silently: it says so and
  offers *Replace theirs* or *Discard mine*.
- **Bundle.** A lazy chunk, loaded on *Edit chart* or *Gantt chart*, and never on the critical
  path. `make perf-bundle` guards it as it guards Mermaid (§13.2).
- **Security and permissions.** Task names are untrusted text and are only ever set as
  `textContent`. The editor works on block text the client already holds, so it adds no read
  path and no enforcement point (§6.4).
- **Confluence (later, not this repo).** A Forge Custom UI macro that bundles `web/src/gantt/`,
  keeps the Mermaid source in the macro's configuration and renders the view with `mermaid`.
  Installing it needs a Confluence Cloud administrator.

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
so a child override is never duplicated in its parent. The rebuild runs only when a note was
inserted, rewritten or removed since the last successful one (and once after opening, since
segments are held in memory). A publish that changed nothing is a no-op, such as a reconcile that
found every stamp current, or an upsert that only moved a stamp. A
failed rebuild leaves the segments cleared and stale, so the next publish retries it. **Honest
limit:** a rebuild is still a full one, holding the vault's index lock while it re-encodes every
note. A single real note edit in a 10k-note vault therefore stalls every index-backed route for
that long. Before the no-op rule, every reconcile did this. The 5 s sync recovery sweep also reached the
index as a whole-vault reconcile, against `INDEX_SWEEP_INTERVAL`'s stated intent. Together
they held the lock almost continuously on the 10k perf vault: about 6.5 s of rebuild every
6.5 s. The queued routes filled the browser's six connections per host, so a second note's
sync socket could not open (`make perf` open-note, 2026-11-08). Both are fixed. The index
reconciles the whole vault only on its 60 s sweep or a watcher overflow. The incremental per-note delta above is
what removes the limit. A full rebuild's **memory** is bounded rather than proportional to every
note's term set: `Segment::build` accumulates postings one note at a time and each note's text
is moved, not copied, from the Tantivy read into its zone's changes. Building the 10k perf
vault's segment peaks at about 56 MB of heap; it peaked at 233 MB before, and the server kept
that as resident memory (§21.11). Reopening an index reconstructs the
in-memory assembly from the published derived sources even when the ACL rows did not change;
stale zone files are removed. `Reader::client_segments` evaluates the live ACL and returns only
segments whose zone ID and ACL hash match that reader's permitted epoch. The previous in-memory
snapshot is cleared before a rebuild, so an interrupted rebuild withholds bytes rather than
serving a note that may have moved into a denied zone. Invalid imported frontmatter IDs use the
path identity, preserving §4.3's no-mutation rule. **Transport and browser ownership are also
implemented in M9.** `GET /search/segments` returns the reader's `(zone_id, acl_hash)`
manifest plus each segment's SHA-256 `contentHash` (t-014). `GET /search/segments/{zone}?acl_hash=…` repeats that live check before returning
binary-v1 bytes. IndexedDB stores the permitted manifest separately from segment bytes and
transactionally drops absent or changed permission/content revisions before fetching missing bytes; a binary
refusal after a manifest is a race and clears every segment fail-closed. Each received binary
is checked against its content digest and validated by `mb-search` through WASM before persistence.
Unchanged content is reused after current-manifest reconciliation; legacy manifests without
a content revision are refreshed rather than treated as permanently current. Late bytes
cannot replace a newer content revision under an unchanged ACL. Full published snapshots replace
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

Online results retain each matching block in server order, including multiple blocks from
the same note and blocks with identical context. A note path is not a unique result identity.

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
- Reports unsupported constructs (Canvas files, Dataview queries,
  community-plugin syntax) explicitly rather than silently mangling them. Unsupported
  fenced blocks are preserved verbatim as opaque code blocks — never destroyed.
  Mermaid fences pass through unchanged and render (§13.2).

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
**Accent override (A37, §20.4).** A vault may set `accent = "#rrggbb"` in
`.memberberry/config.toml`. The server accepts only six hex digits and places the lowercase
value in the editor bootstrap as `data-vault-accent`. Anything else is ignored. The client
re-declares `--accent-primary` and `--focus-ring` inline on `<html>` for the active palette.
It keeps the chosen hue and saturation and moves lightness away from `--surface-note` until
contrast reaches 4.5:1, so one colour stays readable on Paper and Charcoal. A colour that
already passes is used unchanged. Under `system`, an operating-system scheme change
repaints it. Tokens mixed from the accent follow automatically. Server-rendered pages
(sign-in, vault list, shares) keep the shipped accent.
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

### 20.4 Vault settings (A36, A37)

A **Vault settings** dialog, opened from the top bar, lets the vault-wide owner change:

- the vault default theme (`theme` in `config.toml`; devices may still override it, §20.1);
- the accent override (§20.1);
- the vault's custom emoji (§11.2).

Only owners see the control. The bootstrap carries `data-vault-owner="true"` for them, and
that flag only decides whether the control is shown. Every route re-checks ownership (E33).
A server admin who is not an owner is refused like anyone else.

Saving rewrites `config.toml` through a TOML table. Other keys are kept; comments are not.
A malformed existing file is refused (409) and left untouched rather than replaced. The
mounted workspace repaints immediately. Other open windows pick the change up on their next
page load.

Routes, all owner-only, `no-store`, and 404 for everyone else:
`GET`/`PUT /api/v1/vaults/{slug}/settings` (`{theme, accent|null}`, 8 KiB, unknown fields
rejected); `DELETE …/emoji-entries/{shortcode}`;
`DELETE …/emoji-entries/{shortcode}/aliases/{alias}`; and `POST …/rename` with
`kind: "emoji"`. The entry routes use their own prefix so they cannot collide with
`emoji/{pack}/{file}` image URLs.

## 21. Performance budgets (C6, A15)

A15 asks to be *very* efficient and to push a bit further than a comfortable baseline.
Budgets are CI gates measured against a **generated 10k-note vault**
(`memberberry gen-vault`), tracked over time. A regression past budget fails the build.

**UI redesign and onboarding validation, 2026-09-10.** The current working tree measures 767,059 bytes
gzip for initial JS plus optimized WASM, above both the 358,400-byte budget and the
741,471-byte recorded exception ceiling. The bundle gate remains failing; its exception
was not raised. This measurement includes the existing uncommitted M18 work and is not
an isolated attribution to the redesign. No runtime performance claim follows from it.

**Block catalogue validation, 2026-10-14.** With `make wasm-ci` and a rebuilt frontend,
initial JS plus WASM measures **896,671 bytes gzip**. A clean checkout of the pre-catalogue
branch HEAD, built against the same optimized WASM and installed dependencies, measures
892,830 bytes; this slice adds 3,841 bytes. Both builds already exceed the 358,400-byte
budget and the unchanged 741,471-byte exception ceiling. The bundle gate remains failing;
this feature does not rebaseline it or claim physical-device performance compliance.

**Approved operational bundle ceiling, 2026-10-19.** The user approved raising the
enforced initial JS + WASM allowance to **950 KiB (972,800 bytes)** on both device
classes for the expanded editor, covers, folder setup and PWA feature set. The
**500 KiB (512,000-byte)** target in §21.2 is the user-approved long-term optimization
goal, replacing the original 350 KiB target on the same date. This supersedes
the historical 741,471-byte exception above; it is a deliberate allowance rather
than a newly measured optimized baseline. With identical installed dependencies
and the same existing generated WASM, local main and PR #6 builds measure 916,381
and 921,198 bytes gzip, respectively: PR #6 adds 4,817 bytes (0.53%), leaving
51,602 bytes (5.6%) below the approved ceiling. These local totals do not replace
a fresh optimized CI measurement or physical-device validation. The byte tolerance
remains zero: 972,800 bytes passes and 972,801 bytes fails. Each PR must still report
its measured bundle-size change; lazy-asset exclusions and runtime budgets are unchanged.

### 21.1 Reference devices

**t-002c watcher-signal microbenchmark, 2026-10-10.** Criterion release benches in the
existing one-CPU/4-GiB local container compare literal archived accepted `watch.rs` with
current production signal code (10 samples; 0.2 s warmup/0.5 s measurement). Central
estimates: touched-and-take **29.333 ns → 35.667 ns** (extra bounded generation notification),
and 1,024 distinct paths then take **744.73 µs → 695.51 µs**. The small-sample single-signal
regression is recorded, not hidden or called an optimization. Both literal source identities,
full confidence intervals and exact restoration are in
`local/t-002c-registration/{focused-watch-bench-baseline,focused-watch-bench-restored}.log`
and `benchmark-baseline-restoration.json`. This measures only the bounded signal path;
registration scanning is off-executor/not on the keystroke path. No browser/mobile,
10k-note, filesystem latency or §21.2 compliance claim follows from this microbenchmark.

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
| Initial JS + WASM, gzip (excl. lazy Excalidraw and Mermaid) | **< 500 KiB** | same |
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

Report-only mode still fails on a broken measurement. Editor readiness retains its 30-second
deadline; a timeout reports the URL, document readiness, editor visibility/editability,
loading/body gates and displayed connection/error status. Cold-start failures identify the
device and sample, and the runner preserves collected browser errors alongside the cause.

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
  by a 10 000-note index request. On macOS RSS also counts freed pages the allocator has
  marked reusable, so it reports the run's peak more than its idle state, and it swings with
  machine-wide memory pressure (§21.11).
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

**Measured, merged main (2026-11-09).** The first complete run since the harness hung at
open-note. Paging the task inbox (§10.3) moved four rows back inside budget: open note
156 → 15 ms desktop and 968 → 57 ms mobile; INP 120 → 24 ms and 208 → 40 ms; desktop longest
task 820 → 0 ms. The sidebar inbox had been drawing every open task, about 170,000 hidden
elements on this vault. Three breaches are newly recorded in `breaches.json`, each with its
reason:

- **Mobile longest task, 111 ms** (was recorded at 65). A CPU profile shows several 75–111 ms
  tasks at startup, not one cause. They come from writing the 10,000-note catalog to
  IndexedDB, storing and validating client search segments in WASM, and mounting the app.
  Removing it means moving that storage off the main thread or chunking it.
- **Mobile diagram keystroke → paint, 16.9 ms.** The same one-frame resolution limit as
  `keystroke-to-paint` (§21.4); it measured 15.8 ms in the next run.
- **Server memory, 413 MB against 150 MB.** It reads 83.7, 277.8 and 412.9 MB in three runs
  with no code change. It is not work still in flight: two readings 1 s apart were
  identical. §21.11 has the cause: a 233 MB zone-rebuild peak (since cut to 56 MB) that
  macOS keeps resident. After that fix the next full run read **138.7 MB**, inside budget, so
  the record was deleted. It is 11 MB from the line, so a later reading over 150 MB is more
  likely macOS memory pressure (§21.11) than a regression; check the footprint before acting.

Mobile quick-switcher remains a hole (one surviving sample of twelve).

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

### 21.9 Measured: note covers

Laptop-only microbenchmarks (2026-10-19; not Android budget evidence):
`cargo bench -p mb-server --bench sync -- 'extract/covers' --sample-size 10
--measurement-time 1 --warm-up-time 1` measures pure extraction on prepared documents.
Ten paragraphs take 643–649 ns without a cover and 690–695 ns with one; 2,000 paragraphs
take 131–133 µs without and 142–152 µs with one. These compare uncovered and covered
documents in the same build, not a previous application version.
`web/src/editor/note-cover.bench.ts` measures an unchanged banner refresh at about
0.0003 ms in jsdom. Refreshes cache their displayed state and leave the banner DOM
unchanged during ordinary typing. Neither benchmark measures browser paint or device
performance; the existing §21.2 budgets remain unchanged.

### 21.10 Measured: the Mermaid diagram page (A38)

The fixture is `perf-fixtures/gantt.md` in the perf vault: a 43-task Gantt chart in six
sections, with dependencies, and a paragraph below it. `web/perf/server.ts` rewrites it every
run and keeps it out of the 10k corpus count. Each sample is a full navigation, so nothing is
memoized; the Mermaid chunk comes from the service-worker cache. Three rows, measured against
the budgets A38 relaxes (2026-11-08, this machine, mobile = Chromium at 4x CPU throttle):

| Row | Desktop | Mobile | Budget (desktop / mobile) |
|---|---|---|---|
| Editor ready → Gantt chart painted (median) | 22.2 ms | 85.5 ms | 80 / 150 ms |
| Longest task after the editor is ready | 0 ms (none over 50) | **76 ms** | 50 / 50 ms |
| Keystroke → paint below the chart (p95) | **16.4 ms** | 15.9 ms | 16 / 16 ms |

The render is well inside the Open note budget on both devices, which is better than A38
assumed. The real cost is one main-thread task of about 76 ms on the throttled phone. Mermaid
lays the chart out against the DOM, so it cannot move to a worker. That task is the A38
exception, recorded in `breaches.json` for mobile only. The desktop keystroke figure is the
same one-frame resolution limit as `keystroke-to-paint` (§21.4), not a diagram cost. Mobile
later measured 16.9 ms (2026-11-09) and is recorded for the same reason.

### 21.11 Measured: server memory after a zone rebuild

The "Server memory, idle" row read 83.7, 277.8 and 412.9 MB in three runs on an unchanged main
(2026-11-09). The cause was a transient peak plus how macOS reports memory, not a leak and not
work still in flight. Measured on an Apple Silicon laptop, debug build, the 10k perf vault:

- **The peak was ours.** Every server start rebuilds the zone segments, because segments are
  held in memory (§14.2). `Segment::build` used to collect every note's term set as a
  `BTreeSet<Vec<u8>>` (one heap allocation per term) before encoding. The corpus text was
  also held two more times in `zones.rs`. A counting allocator measured **233 MB** of live heap
  to build a **5.7 MB** segment. A bare `memberberry serve` with no client then read **327 MB**
  RSS. Its physical footprint was 30 MB.
- **macOS keeps the freed pages resident.** After the build, live heap is about 10 MB. The
  system allocator marks the freed small-region pages reusable but leaves them mapped:
  `footprint` showed 275 MB "reclaimable". `ps` counts those pages in RSS until the kernel
  takes them back under memory pressure. So the reading depended on how busy the machine
  was, not on the server. Later edits reuse those pages and do not raise the reading again.

The fix builds postings one note at a time, and moves the text instead of copying it. The
encoded bytes are identical. The rebuild now peaks at **56 MB**, and a bare server's startup
RSS is **130 MB** (footprint peak 81 MB, from 282 MB). `mb-search/tests/peak_memory.rs` gates the
build at 4x its input text. The old code measured 15.7x and the new code 2.4x.

**The first full run after the fix (2026-11-09, merged main) read 138.7 MB, inside budget**,
and the `server-memory-idle` record was deleted. Readings during runs on the fix's branch were
higher, as below, so the row stays close to its line.

**Earlier, over budget by `ps`.** During a perf run, the server's RSS sat between 173 and 197 MB
after the desktop scenarios and the start of the mobile ones. Over the same samples,
its physical footprint stayed between 31 and 58 MB. The difference is the same allocator
retention, now after legitimate transients: the startup rebuild, and the browser loading the
10k-note catalog, graph and search segment. Two levers remain. Neither has been taken, and
choosing between them is a budget decision:

- read the physical footprint instead of RSS (`footprint`/`task_info` on macOS, `Pss_Anon` or
  `RssAnon` on Linux), since that is what the OS will not take back, or
- return the pages after a rebuild (`malloc_zone_pressure_relief` on macOS, `malloc_trim` on
  glibc). That needs FFI, and the workspace forbids `unsafe` (AGENTS.md §4.2).

Linux production RSS was not measured. glibc retains freed memory differently, so the macOS
figures here are not a prediction for a Linux server.

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

Because §6.4 enumerates the enforcement points, there is a dedicated suite that walks
them systematically. It is the suite most likely to catch a real security bug.

- **Folder deletion (E32):** a hidden or read-only descendant refuses the entire operation
  before confirmation disclosure or mutation; outsider/viewer and missing/denied-path probes
  share the neutral denial. Authorized positive controls reach name confirmation and move
  all notes into Markdown trash. HTTP tests cover current emptiness, exact Unicode names,
  stale empty-folder views, unauthenticated refusal and restore; repository tests retain
  arbitrary files and reject traversal/symlinks before mutation.
- A **matrix test** over `(role × surface × operation)` asserting every combination either
  succeeds or returns exactly the right denial.
- **Project-folder management (E29):** real signed-session discovery plus JSON preview/register
  tests assert unauthorized, member, demoted/disabled/revoked, invalid, bearer and mixed-credential
  requests and missing/cross origins refuse before filesystem I/O. Inotify observers have actual
  authorized positive controls; byte/config preservation, literal inputs, unsafe ACLs, receipt
  races, unprivileged storage failures, operation-owned rollback, ready filtered initial indexes
  and dynamically enrolled external watchers have dedicated unit/HTTP regressions. F1–F3 repair
  regressions cover duplicate cookie/header cardinality, literal Host/raw Origin, and absent/
  successful/failing optional audit writers with actual audit readback and live-state checks.
  Inotify observes open/access/create/delete/rename, **not stat**; positive-controlled full-handler
  pre-filesystem-boundary observation and static ordering supplement it. Handler-only malformed
  headers are distinct from real-listener cases and transport-parser rejection. Equality
  means status/body, not constant timing or complete header equality. No browser proof is claimed.
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
  row's context. `Vault::notes` now skips all symbolic links (t-012, including aliases within the vault),
  and direct note/index reads reject symlink components. Both the listing and query surface
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
- **Vault settings** (E33): an anonymous caller, a server admin who is only an editor, a viewer
  and a non-member get 404 from every settings, emoji-entry, alias and emoji-rename route,
  with no canary name or setting in the body and every file byte-identical. The owner's
  success is asserted in the same test. An emoji rename (E14) rewrites a note the owner
  cannot read and counts only the readable one.
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

`make dev` prepares WASM and frontend dependencies, then builds the compiled frontend before
starting either server. Port 9010 serves that build directly; port 9011 rewrites its authenticated
HTML to source-module URLs for Vite HMR. Development startup never copies source HTML into
`web/dist/index.html`: the backend cannot serve TypeScript URLs. Frontend preparation failure
aborts startup rather than leaving a running server with a blank shell.

**CI cadence (2026-09-15).** E2E is excluded from automatic push and pull-request runs by
user decision. The separate `.github/workflows/e2e.yml` workflow, **E2E (manual)**, is started
with `workflow_dispatch` and runs the full desktop/mobile suite with the same build setup,
zero retries and retained failure diagnostics. Check, web, perf and fuzz-build remain
automatic. A green automatic CI run is not evidence that full E2E passed; known browser
crashes remain open even when the manual workflow has not been run.

**WebKit (M19, 2026-11-12).** A third project, `webkit`, runs the suite in Playwright's WebKit
at the desktop size — the desktop app's engine (§7.6.1); no phone runs the app, so there is no
mobile WebKit project. `make e2e` installs and runs it with the two Chromium projects;
`make e2e-webkit` runs it alone. The harness provisions every project its own scratch notes,
empty vaults and fixtures, and a spec that means "the desktop layout" asks for a project that
is not `mobile`. WebKit reports a load cut off by navigation in its own words — a request
"cancelled", a same-origin fetch "…due to access control checks", a sync socket closed while
connecting — and the failure fixture excuses exactly those, as it excuses Chromium's
`net::ERR_ABORTED`; an uncaught failed `import()` is still a failure, since the app handles a
chunk that cannot load. Line-start and line-end keys go through `lineKey`, because macOS
WebKit, like WKWebView, moves by line with Cmd+←/→ and lets `Home`/`End` scroll. **Not run in
WebKit, by design:** the browser PWA's offline mode and offline upload queue (the app's
offline mode is the embedded server, §7.6.10) and the clipboard specs (Playwright cannot
grant WebKit clipboard access). WebKitGTK on Linux is what the manual workflow runs; the §21
budgets on WebKitGTK are not yet measured.

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
- [x] Slash menu; Markdown input rules (`## `, `- `, `1. `, `- [ ] `, `> `, ` ``` `)
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
- [x] Compatible custom emoji storage + single-image upload (A33)
- [x] `export --materialize-emoji`
- [x] Note icons (frontmatter → tree, tabs, title, graph)
- [x] Owner Vault settings: list/add/rename/delete vault emoji, alias removal (A36, §20.4)

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
- [x] Vault default theme and contrast-adjusted accent from Vault settings (A37, §20.4)
- [x] Remappable default keymap (§8.4)
- [x] Backup job; docker-compose with MinIO; deployment and security docs

### M19 — Desktop client and local replica (A42, §7.6)
- [x] Tauri 2 host embedding `mb-server` on loopback, with E34's launch code and cookie (§7.6.8)
- [x] Local-only vaults: create in `~/Memberberry` with automatic sign-in. **Opening an
      existing folder is Linux-only** until E29's folder registration builds elsewhere
- [x] Device sign-in through the browser: approval page, token exchange, keychain (§6.8.1, E36)
- [x] Upstream sync over §7.1 with the keychain-held device token: whole-vault replicas,
      edits, creates, renames and deletes both ways (§7.6.9, `mb_server::replica`). Live
      relay for open notes not yet built (S12)
- [x] Server vaults online in the app with no download step; Available offline / Online only
      per note, folder or vault from the context menu; offline, downloaded notes work and the
      rest are greyed (§7.6.10, A46, E37)
- [x] Several servers at once, managed on the vault picker; disconnecting checks every
      change was sent and asks for "yes" before deleting unsynced ones (§7.6.11, A48, A50)
- [ ] Availability rules: on demand, note pin, folder pin, vault-root pin; pinned media
- [x] Media follows the notes kept offline: download, upload, removal (§7.6.10)
- [ ] Residency manifest; external delete/create propagation; I1 fails towards "keep"
- [ ] Release sweep: 30 days unopened, 1 GB cap, per-device `settings.toml`
- [x] E35 revocation purge, with recovered notes and their banner (§7.6.7)
- [x] Playwright WebKit project (§22.6)
- [ ] §21 budgets measured on WebKitGTK
- [x] Leak suite: E34 and E35
- [ ] Leak suite: I1 over a partial replica

### M20 — OIDC sign-in (A44, A47; §6.8.2, E38)
- [x] M20a: sign in with the configured provider (code + PKCE + nonce, claim-validated ID
      token), link by `(iss, sub)` or a verified email, new accounts without access,
      account email (`user set-email`), `password_login` switch, audit, leak-suite E38
- [x] M20b: `group:<name>` in `access.toml`, groups from the latest sign-in, leak suite

### Post-v1 candidates
- gonnadoit integration over the HTTP/WS API
- Task recurrence (§10.4); TOTP 2FA; comments and mentions
- Published-site mode (folder-level public publishing)
- Excalidraw CRDT collaboration; cross-vault links
- Database views over structured note properties
- Freeform canvas workspaces — **only if explicitly requested; declined** (Mermaid: in scope by A38, §13.2)

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
| A9 | Extra features | transclusion, nested tags, icons/outline/export | In scope. **Mermaid and Canvas explicitly not selected** (§4.4). Mermaid reversed by A38 (§13.2) |
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
| A32 | Slack emoji export import | *"remove \"Import Slack Export\" functionality, doesn't seem like it makes much sense to have it"* | Remove the dedicated Slack export importer; custom emoji import uses image filenames through image, folder and ZIP upload (§11.2). |
| A33 | Emoji import UI | *"remove that functinality altogether. Single emoji import is just fine"* | Remove pack management and bulk import from the picker. Import one image with a filename-derived shortcode and no pack-name prompt; preserve existing storage and authorization (§11.2). Supersedes A32's folder/ZIP UI scope. |
| A34 | Custom shortcode selection | *"I want to be able to manually select (or overwrite) the custom shortcode"* | Prompt for the shortcode on every image import, using the filename only as an editable suggestion (§11.2). Supersedes A33's automatic filename-derived shortcode. |
| A35 | Inline emoji trigger | *"lets leave it on 1 character"* | Open inline suggestions after one character following the colon, such as `:s`. A bare colon keeps them closed (§11.4). |
| A36 | Vault settings | *"a way where I can manage some aspects of the vault. One of it will be custom emojis (add, remove, modify shortcode)"*; rename choice: *"Rewrite notes"* | Owner-only Vault settings dialog (§20.4) managing vault-local emoji. Supersedes A33's "no pack-management panel" for Settings only; the picker stays single-image. Rename rewrites notes as an E14 privileged operation and keeps the old name as an alias (§11.2). |
| A37 | Vault accent colour | *"default colour"* → *"Accent colour"* | Per-vault `#rrggbb` accent, adjusted per palette for 4.5:1 contrast (§20.1). |
| A38 | Mermaid diagrams (motivated by Gantt charts for replacing Confluence; reverses A9's exclusion) | *"we should bring in mermaid and document that we accept that midrange android might experience issue with pages that do have mermaid diagrams. Wherever possible we find alternatives"* | Mermaid ` ```mermaid ` fences render via a lazy chunk (§13.2). Pages with diagrams carry a scoped exception to the §21.2 mobile budgets; every other page keeps them. |
| A39 | Visual Gantt editor | *"for both Confluence AND memberberry, I want to have some nice UI with awesome UX way how to build gantt charts"*; then: *"Full drag-and-drop now"*, *"Inside memberberry repo"*, *"Memberberry first"* | A shared drag-and-drop editor over Mermaid `gantt` text, in `web/src/gantt/`. Memberberry first; a Confluence Forge macro reuses it later (§13.3). Storage stays the §13.2 fence. |
| A41 | Gantt "no colour" and chart style | *"it should also be possible to select "no color" (even for tasks). Then we might want to have some overall chart config where we can select "style" - one of it will be if the whole section has background color or only the section name row. another if it should be more "zoomed in" or fixed height"*; then: *"we might want to have also possibility and separated config for if we want to have phase shown as a row or a column like we have now and based on that we would have only a header row or a column with color. If it is a color, there should be some "border" colored"*, and *"Row height"* | `none` as a task or phase colour; `%% option phases column\|row`, `phase-fill whole\|name`, `rows fixed\|zoomed` lines, set from the editor toolbar (§13.3). |
| A42 | Installable desktop app with local notes | *"I want to have an app I can install on my devices"*; then: *"Lets start with already thinking about running things locally. We should support both "lazy loading" where we load only things that we open locally (can have some special rules for releasing older notes) and / or we decide deliberatly to "download this note" And / or to have a support for "full local vault""*; then, on the proposed defaults: *"Yes, write the spec"* | Tauri 2 desktop client whose replica is a Markdown vault folder served by an embedded `mb-server`. On demand, note/folder pins and full vault are one rule model (§7.6). Removes "native desktop apps" from the v1 exclusions; native mobile apps stay excluded. |
| A49 | Signing and notarizing the desktop app | *"I don't need it now on stores, people can install my packages"* | Not now. Desktop packages (DMG, .deb, AppImage, MSI) ship unsigned and unnotarized, the macOS bundle ad-hoc signed only; no Apple Developer ID, Authenticode or store distribution. macOS asks the user to approve the app the first time (§7.6.1). Reversible: signing can be added to the bundle step later without changing the app. Asked again after the keychain double prompt: *"add the always allow and if needed I will do that Apple developer ID"* — install notes tell users to choose Always Allow; Developer ID is the user's later call. |
| A48 | Several servers in the desktop app; signing out of one | *"I still want to be able to "log out" from a server and be able to connect to another server from that local app if I have multiple servers"*; then, asked what happens to downloaded notes on sign-out: *"Ask each time"*, and where it lives: *"A Servers page (Recommended)"* | §7.6.11. `desktop.toml` lists servers; each vault syncs and forwards only with its own server's token. A Servers page lists them with **Sign out** and **Connect another server**. Signing out asks whether to remove that server's notes from this computer or keep them (offline, resumed on signing in again as the same account). **Superseded in part by A50:** the Servers page and the keep choice are gone. |
| A50 | Disconnecting a server from the desktop app | *"It should be possible to disconnect a server in which case there is a prompt that warns you, then it: checks if all notes were correctly synced to the server and if so it removes the connection and all local notes. If for some reason notes were not synced with the server, it produces another warning telling the user that there are local changes not synced and they either type "yes" in modal to delete or cancel and sync first."* Also: *"Local vaults stay as they are"*, and the start page should let you work with several servers *"and make it also pretty"* | §7.6.11. Replaces A48's sign-out choice: disconnecting always removes the server's vaults and notes from this computer, after a last pass confirms nothing is lost, or after the user types "yes" when something would be. The vault picker becomes where servers are managed (Disconnect per server, Connect a server); the separate Servers page is gone. Kept copies made under A48 still work and can be disconnected. |
| A47 | OIDC: link by verified email, setup form for the first admin, passwords optional, groups as roles | Asked about linking, the first administrator, password sign-in and provider groups: *"Link by verified email"*, *"Setup form as today"*, *"Both, admin can turn off"*, *"Yes, map groups to roles"* | §6.8.2. Accounts gain an optional email for the link; an administrator is never created by a provider sign-in; `password_login` hides the password form; `access.toml` accepts `group:<name>` (M20b). |
| A46 | Server vaults work online in the app; notes are downloaded or released one by one | *"When I log into my server - I don't want to have to download my vault, I want to be able to select it - but also have the option to download it - and see it and use it like I have now in the browser. Then I should be able to work on items online like in the browser, ability to download a note on right click - or release a note with Online only"*; then, asked about opened notes: *"No, stays online only"*, and about offline: *"All notes, others greyed"* | Supersedes A45's Download-a-vault flow (§7.6.10). Every vault the device's user can read appears in the app once connected and works online as in the browser. Right-click offers **Make available offline** (note, folder, or the whole vault) and **Online only**. Opening a note never keeps it. Offline, downloaded notes work and the rest are listed greyed. |
| A45 | Whole-vault sync before OIDC; the user picks vaults; everything syncs both ways | Shown the connected page's *"Syncing its vaults comes next"*: *"lets go"*; then, asked which vaults: *"I pick each"*, and how much the first version covers: *"Everything, both ways"* | Slice 2b (§7.6.9) comes before M20. The connected page lists the server's vaults, each with **Download**; a downloaded vault is a full-vault replica (§7.6.3's vault-root pin). Edits, creates, renames and deletes travel in both directions from the first version, so nothing done in the app silently stays local. On-demand residency and release (§7.6.5) follow later. |
| A44 | Device sign-in before OIDC | *"we will bring next also OIDC to the memberberry - should we do it before we continue here ? It is so I can hook it with authentik or KeyCloak and have things like login with google and similar"*; then, on approving devices in the browser first: *"Device sign-in, then OIDC"* | The desktop app signs in through the user's browser with a loopback code and PKCE (§6.8.1), so it never handles a password and keeps working when OIDC arrives. OIDC (authentik, Keycloak) is the next milestone after device sign-in and is not yet specified; Google is expected behind the identity provider, since a direct call to Google would breach C1. |
| A43 | Unsent edits to a note that left the readable set | *"When there is a problem, that should be flagged with some banner and user should have the option to select if it should create that note again or make a new  note"* | Edits are kept as a local recovered note; on what it holds the user chose, when asked on 2026-11-12, *"The whole note"* — the note as this device had it, not only this device's changes; a banner offers "Create the note again" (E17 at the original path) or "Make a new note". Same rule for permission change, move, delete and vault removal, and for the web client (§7.6.7). |
| A40 | Gantt task colours | *"Next up - I want to be able to set colours for tasks"*; then: *"lets recognise both. If the color starts with # and is hex - use any color. otherwise lets have preselected note colors and then a picker"* | `%% color <id> <value>` comment lines. A value is a note colour name or `#rgb`/`#rrggbb` hex; the editor offers the note colours and a custom picker (§13.3). |

---

## 25. Assumptions and status

**Every question raised during design has been answered (§24). No open question blocks any
milestone.**

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
| S7 | **Only resident notes are files** in a desktop replica; released notes leave the folder | §7.6.4 | A hidden cache would make the folder omit notes the app is showing. Costs a residency manifest to tell release from deletion. |
| S8 | Pinning a note downloads its media | §7.6.3 | A pinned note with broken images is not available offline. |
| S9 | Local-only vaults ship in the first desktop build; vault default is `on-demand` for server replicas and `full` for local-only | §7.6.2, §7.6.3 | Same code with no upstream, and the simplest way to try the app. |
| S10 | Desktop release limits: 30 days unopened, 1 GB cap, configurable per device | §7.6.5 | The desktop has room the phone's 500-note / 50 MB cap was sized against. |
| S11 | The desktop app signs in automatically as a local user `me` with a random, never-stored password | §7.6.8 | E34 already admits only the app's own window; a password would protect nothing more. |
| S12 | A replica learns of remote changes by polling the note list every 5 s, not by holding a sync room open per note | §7.6.9 | A room holds its document in server memory; one per note for a 10k-note vault would cost the server more than polling a list it already serves. Since 2c (§7.6.10) a note open in the app is edited live on the server while online, through forwarding; the pass only keeps downloaded copies in step, so a downloaded file trails an online edit by up to one pass. |
| S13 | Structural conflicts resolve towards keeping both: a locally changed note deleted upstream is kept and flagged; a locally deleted note changed upstream comes back; two different notes at one path keep the server's at that path and rename this device's | §7.6.9 | No resolution may lose writing (A43's rule). Which side "wins" a path is a tie-break, not a judgment. |
| S14 | A note whose two histories share no origin is never merged. If this device's file matches upstream or is unchanged, it takes upstream's history; if only this device changed it, it takes upstream's history and re-applies the file as an external edit; if both changed, both are kept | §7.6.9 | Merging two independently rebuilt histories duplicates every block. Re-applying the file is exact only when upstream still holds the last-synced text; with both changed there is no base to merge from, so keeping both is the only answer that loses nothing. |

If any of these is wrong, say so — none is load-bearing enough to be expensive to change
before the milestone that implements it.

### Deliberately out of scope for v1

Recorded so they read as decisions rather than omissions: freeform canvas workspaces,
multi-column page layouts and synced blocks, database views with formulas, task recurrence, cross-vault
links, plugin system, encryption at rest, TOTP 2FA, comments and mentions, published-site
mode, Excalidraw collaborative editing, native mobile apps. (Native desktop moved into scope by A42,
§7.6.)
