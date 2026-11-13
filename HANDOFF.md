# Handoff

## Latest (2026-11-13): disconnecting a desktop server, and the picker as the server hub (A50, SPEC §7.6.11)

Not committed. The user asked for disconnect to check sync first and to delete only
with a typed "yes" when changes are unsent, and for the start page to be the place for
servers and local vaults, made to look good. Details are in the desktop bullet below
(**Disconnecting a server**).

## Earlier state (2026-11-09): Mermaid diagrams, visual Gantt editor, the index-lock sync fix, CRDT sidecar quarantine, inbox paging, zone-rebuild memory

Two branches were merged into `main` (not pushed): `mermaid-diagrams` (Mermaid diagrams,
A38, SPEC §13.2, plus the §21.10 perf fixture) and `claude/xenodochial-gagarin-43e282` (the
index lock no longer starves note sync on a 10k vault, SPEC §14.2). They were verified
separately; the merged result has had focused tests only (see the end of Verification).

### Mermaid diagrams

Mermaid diagrams are in scope (A38, SPEC §13.2). The reason is Gantt charts: the team wants
Memberberry as a Confluence replacement. A ` ```mermaid ` code block renders as a preview.
Its source shows when the caret is inside (via Edit code, or an arrow key from the adjacent
block; a click on the diagram deliberately does not open it) and hides on Done or when the caret leaves. Read-only notes
get Show code. Done after the last block once failed to hide the code (the caret search fell
back into the block). It is fixed and covered by DOM and browser tests. A note whose first
body line is a diagram now opens with the code hidden. An `appendTransaction` moves any
unrequested caret move out of diagram code, and deliberate entries carry `MERMAID_ENTER`. A
note that is only a diagram still opens showing its code, because moving the caret would mean
editing the note.

- `web/src/mermaid/`: `renderer.ts` (lazy `import("mermaid")`, strict security, serialized
  queue, LRU cache keyed by width + theme + source), `sanitize.ts` (second pass: scripts,
  handlers, external URLs, fetching CSS), `theme.ts` (tokens → `themeVariables`), `mermaid.css`.
- `web/src/editor/mermaid-view.ts`: code-block node view, editing decoration, arrow keys.
  Priority 1, so open menus keep their keys. Escape is deliberately not bound, because §8.4
  gives it to block selection.
- `mermaid` is pinned to 11.17.2 because Excalidraw's `mermaid-to-excalidraw` resolves to the
  same copy, so the PWA precache does not grow. 12.x exists; moving to it means two copies.
- `perf/bundle.ts` fails if a Mermaid chunk is statically imported by an eager chunk.
- Perf: the diagram-page fixture (`perf-fixtures/gantt.md`, skipped by `cachedNoteCount`, so
  the 10k vault is not regenerated) and three §21.10 rows are in `web/perf`. The scenario runs
  first and by navigation. `breaches.json` records mobile `diagram-longest-task` (76 ms) and
  desktop `diagram-keystroke-to-paint` (16.4 ms). These rows were measured before the sync fix
  existed, with the tab scenarios temporarily skipped (patch reverted).

Mermaid verification (on its branch): 55 unit tests (sanitizer property test seeded
20261108; renderer; theme; editor view) plus 2 perf bundle tests; full web suite (2840),
typecheck, token-check and perf-bundle passed. Mutation probes went red for event-handler
stripping, strict security, theme-listener teardown, debounce-timer teardown and arrow-key
adjacency. `e2e/mermaid.spec.ts` passed on desktop and mobile (8 runs): Gantt render, typing,
`.md` read off disk, no off-origin requests, arrow-key entry, error state, dark-theme colours.

Mermaid open items:
- Public shares (§17, no public JS) show diagram source as a code block. Server-side
  pre-rendering is undecided.
- No re-render on window resize; a chart re-lays out on its next edit or open.
- Arrow-key entry works only between sibling blocks. A diagram nested in a list or callout is
  reached with Edit code.
- `npm audit` reports 29 advisories (3 critical), the same count as before Mermaid. One
  critical advisory is in DOMPurify 3.4.15 (IN_PLACE mode), which Mermaid's strict mode uses,
  now reachable from every note. `sanitize.ts` is the independent second pass. Not triaged.
- The Confluence Cloud side (a Forge macro wrapping `mermaid`, or a Marketplace Mermaid app)
  is a separate project, not in this repo.

### Visual Gantt editor (A39, SPEC §13.3)

A drag-and-drop editor over Mermaid `gantt` text. The note still stores only the fence.
- `web/src/gantt/`: `model.ts` (parse, schedule, serialize; unedited lines kept verbatim),
  `edit.ts` (pure edits), `gantt-editor.ts` (the modal: table plus SVG timeline, drag, keyboard,
  undo), `gantt.css`. It imports nothing from the app; `model.test.ts` fails if it does.
- Phase colours can be overridden: `%% section-color <value> <name>` lines (`sectionColors`,
  `drawnPhases`, `colorHue` and `PHASE_COLOURS` in `src/gantt/colors.ts`), `setSectionColor` in
  `edit.ts` (rename carries the colour, remove drops it), a colour control on editor phase rows,
  `huesOf` for the editor timeline, and `paintPhase` in the note view.
- Phases in note charts are coloured: `PHASE_COLOURS` and per-phase rules in `GANTT_CSS`,
  `numberSectionStyles` 6, and `phaseBands`/`markPhases` adding left stripes and dividers after
  render. Screenshots are `local/debug/gantt-render/phases-*.png`.
- Chart design in notes: `ganttLayout` (left margin from the longest phase name, bar and
  font sizes), `GANTT_CSS` (token-only `themeCSS`), and `thinLabels`/`thinAxis` (hide
  overlapping date labels after render). Before and after screenshots are in
  `local/debug/gantt-render/`.
- Task row: an *Ends* control (end date, hours, days or weeks; `setEndKind`), with hours
  scheduled as fractional days. The Critical toggle is removed; existing `crit` tags are kept.
- Task colours (A40): `%% color <id> <name|#hex>` lines, `src/gantt/colors.ts` (parse, styles),
  `setColor` in `edit.ts`, the editor's Colour column, and the note view colouring Mermaid's
  `rect#<diagram id>-<task id>` after render. `colors.ts` is exempt from the lazy guard.
- Double-click (or double tap) on a Gantt chart opens the editor; the browser test uses a real
  CDP double tap on mobile.
- `web/src/editor/mermaid-view.ts`: *Edit chart* on Gantt sources in editable notes, and
  `editGanttAt`, which follows the block through collaborators' edits (plugin state) and saves
  in one transaction. The Insert menu has *Gantt chart* (`block-catalog.ts`).
- `perf/bundle.ts` keeps `src/gantt/` lazy; it loads as about 28 KB of JS and 7 KB of CSS.
- Moving tasks between phases: grip drag in the task list (auto-scrolls), vertical bar drag in
  the chart (desktop; on a phone the grip), and Alt+Up and Alt+Down. `moveTask` in `edit.ts`
  keeps every date by rewriting one-field tasks to explicit `after`, guarded by a property test.
  The dialog fits its timeline once right after `showModal()`. Leaving that to the
  ResizeObserver replaced elements a frame after opening, which raced user input and tests.
- No colour and chart style (A41): `none` is a task or phase colour (plain bar, no band). Chart
  options are `%% option <key> <value>` lines: `chartOptions` in `colors.ts`, `setOption` in
  `edit.ts`, segmented choices in the editor's *Style* panel. In the note, `ganttLayout` and `configFor`
  read `rows zoomed` and `phases row`; `markPhases` (now exported, tested in
  `src/editor/mermaid-phases.dom.test.ts` against trimmed real Mermaid output) draws name cells
  or header rows, and `phasesAsRows` shifts Mermaid's drawing to open header rows. Screenshots:
  `local/debug/gantt-render/opt-*.png`.
- Long labels: `fitText` (`src/gantt/fit-text.ts`, property-tested, exempt from the lazy guard)
  cuts a name with "…"; `shortenLabels` and `revealFullText` (`src/mermaid/labels.ts`, DOM
  tests stub `getComputedTextLength`) fit the note's task and phase names after render and
  show the full name in `.mb-mermaid-tip` on hover or tap. The editor timeline uses an
  estimated width plus an SVG `<title>`.
- Note viewer: `src/mermaid/chart-viewer.ts` (zoom steps, fit, anchored zoom, wheel and pinch,
  mouse drag, Today), mounted by `mermaid-view.ts` for Gantt charts only; `max-height` option
  sets `data-max-height` on the preview. A capped chart taller than its box gets a sticky
  `.mb-chart-dates` header copied from the axis (`src/mermaid/date-header.ts`), synced by the
  viewer after each attach and zoom. It is HTML, not SVG, so `.mb-mermaid-preview svg`
  locators still match one element. Its `top` is 1px past the padding on purpose: on a
  fractional-DPR phone a row of chart showed above it otherwise.
- Add rows: each phase in the editor's task list ends with a thin *+ Add task* row (`addRow`).
  Rows are no longer evenly spaced, so the timeline places them by `rowTops`, and the vertical
  bar drag finds its row with `rowAt`. Table striping is `data-stripe`, not `:nth-child`.
- Editor top bar: heading with Undo and Redo, then one toolbar (title, zoom and layout as
  segmented controls, *Style*, actions at the far end), wrapping on a phone. Screenshots of
  the dark theme: `local/debug/gantt-render/toolbar-dark-*.png`.
- Layout: by default the chart sits above the tasks, with a resizable divider. *Side by side*
  is the alternative, and the choice is remembered per browser. Focus links a row to its bar.
  A ResizeObserver redraws the timeline to fill its pane, but only when the width changes and
  never mid-drag. Redrawing on its first callback replaced elements under the pointer and made
  a browser test flaky.

Verification: 151 gantt unit tests and 8 note phase-layout DOM tests, with seeded property tests: any text round-trips unchanged,
random edit sequences stay valid and editable, canonical rewrites parse back. There are also 3
Mermaid-view tests, a bundle-guard test, and `e2e/gantt-editor.spec.ts` (14 tests) plus
`e2e/mermaid.spec.ts`, 40 passing runs on desktop and mobile after the chart-style change: render, drag, connector link, Insert menu, keyboard, a real touch drag, the stacked
layout and divider, and moving a task between phases (grip by mouse and touch, chart drag). Mutation
probes went red for: canonical rewrite of untouched lines (after the generator was made to vary
spacing), weekend handling, remove-pinning, ensureId, the import boundary, position tracking,
the lazy guard, the touch `pan-y` fix, and for chart style: the header shift, name-only hiding,
the picture's growth, the milestone origin, default-writes-no-line, the editor's phase fill and
tall-row CSS, and for the date header: no sync on zoom or attach, no cap or height check, no
removal for a non-Gantt diagram, unscaled positions, the header placed after the chart. The
editor, gantt, mermaid and bundle suites (1367), typecheck, token-check and perf-bundle pass;
both Gantt browser specs pass (46 runs). The full web suite, `make check` and the full
`make e2e` were not run for this change. Screenshots were inspected on desktop and mobile,
light theme only for chart style and the date header.

Open:
- The Confluence Forge macro is not built. It is a separate repo, and installing it needs a
  Confluence Cloud admin.
- The editor's own timeline is its own SVG, not Mermaid's render, so it looks close to the
  note's preview but not identical.
- A bar label's fit is estimated from name length. `excludes` other than weekends, other date
  formats and `until` open read-only.
- Tall rows: Mermaid decides whether a task name fits inside its bar, and a name that only just
  fits touches the bar's edges.
- Not yet tried on a real phone. The touch path is covered by CDP touch events in Chromium.

### "Update available" stuck on the dev server (SPEC §7.4)
- On 9011 the page is the server's HTML rewritten to load `/src/main.ts`, so it got a
  bootstrap and registered `dist/sw.js`. Every `npm run build` installed a new waiting worker,
  and since no build contains a source page's entry files, the banner never cleared.
  `isSourcePage` (`src/pwa/updates.ts`) now keeps the watcher off such a page, and `main.ts`
  calls `retireWorkers` instead of registering in dev. Unit and regression tests pass, as does
  `e2e/pwa-update.spec.ts`. Not checked signed-in on 9011 (no dev credentials here): the
  user's next reload there should clear the banner.

### Index lock no longer starves sync

Fixed: `make perf` hung at open-note on the 10k vault. The second note ("Note 777") showed
"This note has not been downloaded" while online, and the harness waited 90 s for its body.

Root cause, two defects compounding:
1. `mb_index::Index::publish` rebuilt every zone's client search segment from every note's
   text on every call, holding the vault's index mutex. That is about 6–7 s at 10k notes on
   a debug build, even when nothing changed.
2. The maintenance loop (`serve_listener`, `http.rs`) handed the index the 5 s sync recovery
   sweep's `Changes::All`, so the index ran a whole-vault reconcile and a publish every 5 s.
   `INDEX_SWEEP_INTERVAL`'s own doc says that must not happen.

Together, the lock was held about 6.5 s out of every 6.5 s (measured with a temporary tick
log). `/notes`, `/graph`, `/backlinks`, `/tags`, `/tasks` and `/search/segments` queued
behind it. Chrome allows six HTTP/1.1 connections per host, so those parked requests held
back unrelated ones: `/history` and the new note's WebSocket handshake. Normally the body
arrived 11–21 s late; on a loaded machine, past the 90 s wait. Thread samples showed idle
runtime workers, five handlers waiting on the index lock, and `maintain_index` → `reconcile`
in `mb_search::Segment::build`.

Fix:
- `Index` tracks `segments_stale`. It is set at open and by every content mutation (`upsert`
  that rewrites, `remove`, reconcile removals). `publish` is a no-op when it is clear, and it
  clears only after a successful rebuild.
- The tick's split is now the pure `tick_changes`. The index gets the watcher's report, or
  `All` only on its own 60 s sweep or a watcher overflow.

A whole-vault reconcile now takes about 140 ms. SPEC §14.2 records the rule and the remaining
limit: a real note edit still triggers a full rebuild under the lock.

### CRDT sidecars with missing dependencies are quarantined, not served

Fixed: after the lock fix, Note 777 in the cached perf vault still could not open. The
server sent a state with Yjs pending structs, and the client's schema admission showed
"Refresh required". SPEC §7.3 records the new load and recovery rule.

Cause, from the sidecar itself (written 2026-09-16 10:36, 72 records). Record 0 is a full
state written by compaction or `replace`. It already held client 693270781 at clocks 5–60
without 0–4, plus about 68 perf "x"-typing clients. Until `3c45e3d` (2026-10-08),
`apply_remote_update_as` did not check `has_missing_updates`, so a client update without its
base was accepted, appended and merged as pending. `replace` and compaction then encoded the
pending state into one record. After 10-08 the server refused every update against that doc,
so the note stayed broken. Why that client's first 5 clocks never reached the server cannot
be determined from the evidence.

A second path to the same file shape was still live and is now closed. Deleting a sidecar
under an open room made the next accepted update the first record of a new log, a delta
whose base was gone.

Fix:
- `mb_crdt::Sidecar`: `load` returns `MissingDependencies` for a pending merged state.
  `replace` and compaction refuse a pending doc. `append` refuses to start a new log with an
  update that cannot stand alone. New `quarantine()` moves the log to
  `crdt/quarantine/<name>.<n>`.
- `NoteCoordinator::open` quarantines and rebuilds from Markdown on `MissingDependencies`.
  `apply_remote_update_as` writes the full candidate state when the append would start a log.
- `crates/mb-crdt/tests/fixtures/perf-note-777-pending-from-record-0.bin` is the real broken
  sidecar, used as a regression fixture.

The cached perf vault (`target/perf/vault` in the main checkout) still holds the broken file.
The next server open quarantines it there. Nothing deleted it.

### Server memory after a zone rebuild

Cause of the 84–413 MB swing in "Server memory, idle" (SPEC §21.11): every start rebuilds the
zone segments. `Segment::build` held every note's term set at once, a 233 MB heap peak for a
5.7 MB segment. macOS then keeps the freed pages resident as "reclaimable", and `ps` RSS
counts them until memory pressure takes them. A bare server read 327 MB RSS with a 30 MB
footprint. Fix: `Segment::build`/`merge` accumulate postings per note (`Draft` in
`mb-search`), and `zones.rs` moves text instead of cloning it. The output is byte-identical
(`cmp` of the 10k zone file; the merge property test asserts merge == build). Rebuild peak is
now 56 MB, and bare-server startup RSS is 130 MB. Regression test:
`crates/mb-search/tests/peak_memory.rs` (dev-dep `peak_alloc`). It fails on the old code
(15.7x the input text against a 4x bound). Verified: mb-search and mb-index suites, clippy,
wasm32 build of mb-search, mb-server leak_suite (45). `indexing.rs:351` fails as it does on
the base commit (see below).

## Verification

- Sidecar dependency fix: two `mb-server/tests/sync.rs` regressions
  (`a_sidecar_with_missing_dependencies_is_quarantined_and_rebuilt_from_markdown`,
  `an_update_accepted_after_the_sidecar_was_deleted_starts_a_self_contained_log`) failed
  before the fix. Seven new `mb-crdt/tests/storage.rs` tests include the real perf-vault file.
  Probes went red: removing the load check (4 tests), the coordinator's full-state fallback,
  and quarantining by deletion. All mb-crdt suites pass, and so do mb-server sync, recovery,
  rename, websocket, convergence and watch. mb-crdt clippy `-D warnings` is clean.
  mb-server clippy fails only on code this change does not touch: the
  `directory_path_included` warning and `expect` in `repository/folder_delete.rs` tests.
  No browser check was run, because the change has no UI delta.

- `http::tick_tests` (5 tests). The two recovery-sweep regressions failed before the
  `tick_changes` fix.
- Regression tests in `crates/mb-index/tests/zones.rs`:
  `publishing_with_no_content_change_does_not_rebuild_zone_segments` and
  `a_stamp_only_upsert_does_not_rebuild_zone_segments`. Both failed before the fix. Four guard
  tests show that content change, removal, reconcile removal and a reopened index still rebuild.
  Probe: dropping the flag in `upsert` turned the guard and the existing E6 assembly tests red.
- All mb-index suites pass, and clippy `-D warnings` is clean. mb-server: leak_suite (45),
  watch, recovery, access, websocket, sync and rename pass. Three tests fail identically on the
  base commit without this change, all from macOS `/private/var` vs `/var` under the sandbox
  TMPDIR: the two onboarding config-write tests (http.rs:268) and
  `targeted_indexing_removes_a_note_replaced_by_a_symlink` (indexing.rs:351).
- Browser: `local/debug/sync-fix/perf-note777-loop.mts` (gitignored) loops the open-note steps against
  one perf server, logging WebSocket frames and HTTP timing. Before the fix each iteration took
  11–21 s. After: 2.6–6 s unthrottled and 9.5–13.5 s at 4x CPU throttle, with the body 0.5 s
  after the click.
- `make perf` ran every scenario on both profiles after this fix (`local/debug/sync-fix/perf-after-fix*.log`;
  desktop cold start 5712 → 312 ms). The rows it left over budget are tracked under "Next and
  open work" below with current numbers.

Merged main (2026-11-09): all mb-index suites, `http::tick_tests` (5), the Mermaid and
perf-harness vitest files (111 tests) and web typecheck pass. Full make check and local
coverage measurement are deferred, not requested. Full make e2e remains user-run and pending;
no full-suite result is claimed.

## Next and open work

- **M20 OIDC built (M20a + M20b), not committed (2026-11-11; SPEC §6.8.2, A47, E38).**
  An `[oidc]` table in `server.toml` (issuer, client_id, client_secret, redirect_url, name,
  scopes, groups_claim, password_login) puts "Sign in with <name>" on the sign-in page. Code
  + PKCE + nonce; the ID token is validated by its claims (TLS-trusted back channel, no
  JWKS); accounts link by (iss, sub) or, once, by a verified email equal to exactly one
  account's (`memberberry user set-email`); new accounts have no access and are never admin.
  **M20b:** `access.toml` accepts `group:<name>` wherever it names a user; groups come from
  the `groups` claim at each sign-in and are attached in `access_for`, so every enforcement
  point (and the search zones) honours them. Code: `crates/mb-auth/src/oidc.rs`,
  `crates/mb-server/src/http/oidc.rs`, `crates/mb-core/src/permissions.rs` (`GroupName`,
  `with_group_grants`, `vault_role`, `rule_paths`, `principals`), `crates/mb-server/src/access.rs`,
  `crates/mb-index/src/zones.rs`, CLI `user set-email`.
  - **Verified:** `mb-auth` oidc (13 + 4 unit), `mb-core` group permissions (12, including
    two properties: a group grant equals the same grant written onto the user, and groups
    change nothing for a non-member), `access` (group parsing, save round trip), `invites`
    (group grants survive an accepted invite), `mb-index` zones (a group member's search
    segments), `mb-server` `oidc` (10), leak suite E38 (forged/stale/mismatched sign-ins; groups
    grant exactly their access, honour their `none`, and lapse at the next sign-in). Mutations
    that went red: verified-email rule, nonce, audience, grant combination, group path rules,
    groups not attached in `access_for`, zones ignoring groups, invites dropping groups. **In a
    real browser** (temporary probe with a fake provider, deleted): provider sign-in round trip
    to the linked account (M20a; groups were not exercised in a browser — no UI changed).
  - **Not verified:** against a real authentik or Keycloak — the `groups` and `email_verified`
    claims are the common shapes (authentik sends `groups` in the profile scope; Keycloak needs
    a "Group Membership" mapper, and sends paths like `/family` unless "Full group path" is
    off). Try one before relying on it.
  - **Open:** the callback is not rate-limited; discovery is fetched per sign-in; there is no
    UI listing a user's groups or editing `access.toml` group grants (edit the file).
- **Desktop app: M19 slices 1, 2a, 2b and 2c built, none committed (2026-11-11).** Slice 1
  is the Tauri app over an embedded `mb-server` with E34's guard (SPEC §7.6.8); 2a device
  sign-in (§6.8.1, E36, A44); 2b the sync engine (§7.6.9, A45); **2c (§7.6.10, A46, E37)
  is what the user asked for after trying 2b:** every server vault appears in the app once
  connected and works online like the browser (the embedded server forwards the vault's
  routes and sync frames upstream with the device token); right-click → **Make available
  offline** / **Online only** on a note or folder, and the file settings menu for the whole
  vault; offline, downloaded notes work from disk and the rest are greyed. Code:
  `crates/mb-server/src/replica{.rs,/}` (`plan.rs` three-way planner, `pins.rs`, `wire.rs`,
  `upstream.rs`), `crates/mb-server/src/http/{desktop,desktop_connect,desktop_sync,
  desktop_forward,replica_local,devices}.rs`, `crates/mb-server/src/desktop.rs`
  (`CachedSecrets`: the Keychain is read once per launch), `desktop/`, and on the web side
  `web/src/shell/device-offline{.ts,.svelte.ts}` plus the tree/menu wiring in
  `NoteTree.svelte`, `ContextMenu.svelte`, `Workspace.svelte`.
  - **Verified:** `replica` (27: every structural case, pins, releases, lost pin file, I1,
    revoked device), `replica_api` (11), `desktop` (18), `desktop_connect` (23: vaults
    appear, online with nothing on disk, offline/online-only, a folder-held note refused,
    going offline lists every note), leak suite E34/E36/E37 (49 total), `--lib` (136: planner,
    wire, pins property and unit tests), web shell (91 files, 1323 tests, plus the new
    `device-offline*` and `NoteTreeOffline.dom` tests). Mutations that went red: per-frame
    device auth, shared-origin check, keep-changed-notes rule, forwarding the window's
    cookie, the offline listing merge, the menu's action slot, the Keychain cache. **In a real
    browser** (Chromium pane, temporary probe standing in for the Tauri host, deleted after):
    the server vault is in the vault list with no download; a note opens and an edit made in
    the app reaches the server's file with nothing on disk; right-click → Make available
    offline writes the file and shows the mark; with the server stopped, the vault lists
    both notes, the online-only one greyed and refusing to open with its message, and the
    downloaded one opens and an edit lands in its file.
  - **Fixed from the user's report (2026-11-11):** the workspace footer's "Log out" in the
    app only bounced back to the picker (the guard signs the window straight back in); the
    app's pages now carry `data-desktop` and the footer shows **Servers**. Tests:
    `SidebarAccount.dom.test.ts`, `bootstrap.test.ts`, `desktop` (page carries the flag),
    `http` (a normal server's does not); checked in a browser.
  - **Several servers (2026-11-11, A48) and disconnecting one (2026-11-13, SPEC §7.6.11,
    A50).** `desktop.toml` holds `[[servers]]`; each pass and forward uses only its own
    vault's server and token. **A50 replaced A48's sign-out:** there is no "keep notes"
    choice and no Servers page any more. The vault picker (`vaults_home` in `http.rs`) shows
    each server as a group (host, account, Online/Offline badge, **Disconnect**, the last pass's
    error), local vaults under **On this device**, a "N notes not synced" line on cards, and
    a **Connect another server** card. `/desktop/connect` redirects to `/` once connected.
    Disconnect (`http/desktop_disconnect.rs`): GET shows a dialog over the inert picker.
    POST holds the pass lock, runs a last pass (`desktop_sync::pass_server`, which now returns
    `Unsent`), and then either revokes, forgets the token and removes the vaults
    (`remove_server_notes`), or shows "Changes not synced" with a `confirm` field that only
    "yes" passes (checked again server-side). Kept copies from A48 (`signed_out = true`)
    still render with **Sign in again** and **Disconnect**.
    - **Two bugs found on the way.** (1) The picker was served with `form-action 'none'`, so
      no form on it could submit. A new `PagePolicy::Picker` allows `'self'`. Only the
      browser showed this. (2) Removing a vault folder failed intermittently with
      "Directory not empty" (about 1 in 4 runs in one test; the A48 remove path had it too):
      tantivy kept merging after the vault was unregistered. Fixes: `Index::close` /
      `IndexRegistry::close` wait for merges, called from `onboarding::unregister_vault`, and
      `delete_inside` retries for up to 0.5 s on `DirectoryNotEmpty`. With both fixes, 20 of
      20 runs passed.
    - **Verified:** `desktop_connect` (55: clean disconnect, the last-second edit reaches the
      server, unsent asks for yes, a wrong word gives 400 and removes nothing, " YES " works,
      unreachable with and without notes kept, A48 kept copies, picker CSP), `desktop` (19),
      leak suite (57), `mb-index` (all), summary unit tests. Mutation probes went red for:
      skipping the yes check, `is_clean` always true, ignoring an unreachable server, any
      word accepted, picker forms blocked, held notes dropped from the check. The leak suite's
      `e37_two_servers_…` posted `notes=keep`, which A50 ignores, so it removed B and passed
      without testing anything. It now writes B's A48 kept state into `desktop.toml`, and
      goes red if that state is not written. In a browser
      (a temporary two-server probe, deleted after), at desktop and phone width, in dark and
      light: the picker, both dialogs, a wrong word blocked by the field, "yes" then a clean
      disconnect.
    - **`make check` on macOS (2026-11-13).** Two pre-existing failures, both fixed. (1)
      `clippy -D warnings` failed on `main`: `vault.rs` `directory_path_included` (now
      `cfg(target_os = "linux")` like its only caller), `repository/folder_delete.rs` tests
      (module `allow(clippy::expect_used)` with a why), `mb-auth/tests/oidc.rs` (`.get`),
      `tests/leak_suite.rs` (crate allows `indexing_slicing`; a type alias). (2)
      `desktop_connect` failed with "Too many open files" in a terminal: macOS gives 256, each
      test runs two servers with indexes and watchers, and libtest runs about one test per
      core. It also fails on `main` at 256 (40 of 47). Nothing leaks: at 256 with
      `--test-threads=1` all 55 pass. The Makefile's `RAISE_FILES` raises the soft limit to
      8192 on every recipe that runs Rust tests, and from a 256 shell the suite then passes
      55/55. **A bare `cargo test` in a default macOS terminal still hits it;** run
      `ulimit -Sn 8192` first, or use the make targets.
    - **Open, not investigated:** the packaged desktop app started from Finder also gets a
      soft limit of 256 (launchd `maxfiles`) and does not raise it. One app is one server,
      not the tests' ten, but every vault holds index, database and watcher files, so many
      vaults could reach it. Not measured.
    - **Also seen:** `scripts/full-test-test.py` fails on `main` (it expects `make e2e` to
      install Chromium only; it now installs WebKit too). It is not part of `make check`.
    - **Picker CSP:** only the desktop picker carries forms, so only it gets
      `form-action 'self'` (`picker_policy`); the browser picker stays `'none'`, which
      `tests/http.rs` `every_page_carries_a_content_security_policy` asserts.
    - **macOS-only test failures fixed:** two `tests/http.rs` onboarding tests failed on
      `main` on macOS because the management root is stored canonicalized and the macOS
      temp dir `/var` is a symlink to `/private/var`; the helper now compares canonical
      paths. Same cause in `tests/indexing.rs`
      `targeted_indexing_removes_a_note_replaced_by_a_symlink`: it fed the indexer
      non-canonical paths, which it ignores as outside the vault (watcher events are
      canonical), so it failed on macOS — and its second check passed vacuously. It now
      uses canonical paths; a probe that follows symlinks in `reindex` turns it red.
      Clippy failures already on `main` (`folder_delete.rs`, `vault.rs`, `oidc.rs`,
      `leak_suite.rs`) are fixed too.
    - **Full `make e2e` (user-run, 2026-11-14): 118 failed, 731 passed.** 111 are the
      Linux-only folder specs (37 per project, as before). The other 7 each passed alone in
      the project that failed (`--retries=0`): `bookmarks` (desktop, tree focus),
      `create` "accepts typing immediately" (webkit), `date-mentions` (mobile, date dialog),
      `folder-actions` rename (mobile), and three where a workspace-state `PUT` was cut off
      mid-flight and the problem guard counted it — `branding` offline (mobile),
      `conflicts` resolve and `theme` secondary tools (webkit). None touches the desktop
      pages this change altered. **Open:** the aborted workspace `PUT` is now the commonest
      load-only failure; whether the client should stop reporting an aborted save, or the
      specs should wait for it, is not decided.
    - **Not done:** there is no Playwright
      spec for the desktop pages, because E2E has no desktop fixture; the browser checks above
      were manual. `make check` passes on macOS after these fixes (user-run, 2026-11-14). The bounded
      retry in `delete_inside` has no deterministic test.
      `held` is in memory, so the "not synced" card line appears only after the first pass
      of a run.
  - **Folder-spec servers leaked on timeout (2026-11-13), fixed.** `e2e/folder-fixture.ts`
    specs stop their server in `finally`, which never runs when a test times out, so every
    folder spec failing on macOS left a `memberberry serve` behind with no parent: 71 had
    accumulated on the user's Mac. The fixture now tracks its servers and SIGTERMs them on
    the worker's `exit`. Shown with a temporary timed-out probe (server left running before,
    gone after) and by `new-vault` + `folder-create` in three projects: 15 failed as expected
    on macOS, no new orphans. Not covered: a worker Playwright SIGKILLs. Leftover
    `$TMPDIR/memberberry-folders-*` from old runs are left for macOS to purge.
  - **"App Update Required … macOS 28" notification (2026-11-13).** macOS 27's Rosetta notice;
    it came from running the universal build's Intel slice under Rosetta as a test. Normal
    launches on Apple silicon run the arm64 slice; no app change. The Intel slice stays for
    Intel Macs (macOS 26 and earlier).
  - **macOS keychain double prompt (2026-11-13, SPEC §7.6.1, A49).** Not a code bug: the app
    reads the token once per launch. The item's ACL and partition list name the build that
    created it by cdhash, and an ad-hoc build has no stable identity, so every new version
    asks twice. The user chose to document it: README "Desktop app" tells people to choose
    Always Allow; Developer ID is their later call. Your own login keychain item was created
    by the debug build, which is why the packaged app prompts on this Mac.
  - **Installable desktop packages, unsigned (2026-11-12, SPEC §7.6.1, A49).** Per-OS
    `desktop/tauri.{macos,linux,windows}.conf.json`: DMG (ad-hoc signed, macOS 11+), .deb +
    AppImage, MSI. `make desktop-build` makes this OS's; `.github/workflows/desktop.yml`
    (manual dispatch, no secrets) builds all three, universal on macOS, from one `web/dist`.
    `scripts/desktop-workflow-test.py` runs in CI (red when a package target is dropped).
    **Checked here:** the arm64 DMG mounts with the app and an Applications link, signature
    verifies (adhoc, hardened runtime), `web/` is bundled, the packaged binary starts and
    listens on 127.0.0.1 only; `spctl` rejects it, as expected unnotarized. The universal
    build the workflow runs also built here (34 MB DMG, x86_64 + arm64), and its Intel slice
    started under Rosetta and listened on loopback.
    **Not checked:** the workflow has never run — the Linux and Windows legs (WebKitGTK and
    keyring deps, WiX for the MSI, whether the Windows build compiles at all) are unproven
    until it is dispatched; nothing was installed on a clean machine or another user account.
  - **The `block-selection` flake was an app bug, now fixed (2026-11-12, SPEC §7.4).** Every
    page load reconnected each editor's socket about 200 ms after it was admitted: `afterLoad`
    fires `WORKSPACE_REFRESH` → the workspace's `onresume` → `reconcileOfflineData` →
    `RESUME_SYNC`, and `sync.ts` `onResume` always closed and reopened the socket. The drop
    flipped the single-editor gate to "offline", which invalidates the block selection —
    so a selection made in that window vanished (the same happened on every window focus).
    §7.4 says a return keeps the selection. `onResume` now reconnects only a socket that has
    lived through a hidden page (or opened in one); the page is an injectable `page` option,
    `document` by default. Unit tests in `sync.test.ts` "resuming with a page…" (the keep and
    per-socket cases red with the guard removed, the hidden-tab case red with that rule
    removed). Measured: a page load opened 2 sockets in 12 of 15 loads before, 1 in 15 of 15
    after; `block-selection.spec` with `--repeat-each=4` across three projects went from 13
    of 96 failing to 96 of 96 passing. A wider focused set (block-catalog, autosave, offline,
    numbered-list, history-trash, block-selection): 69 passed. **Not touched and still
    intermittent, failing the same with and without this change:** `pwa-refresh` "return
    refresh updates closed pinned text…" (Chromium) and `conflicts` 98/180 in WebKit.
    `conflicts` and `pwa-refresh` reuse one note name per project, so `--repeat-each` makes
    their repeats collide; judge them on single runs.
  - **Third full `make e2e` (2026-11-12): 119 failed** — 111 the Linux-only folder specs, 6
    `block-selection` (the known flake, in all three projects), and `topbar` "quick find opens
    the switcher…" on desktop and mobile: it pressed Enter straight after typing, and under
    load the result list was still empty, so nothing opened. It now waits until the top
    result is Roadmap (9/9 across projects). Everything fixed in the two rounds below held;
    `pwa-refresh` passed this run. **So outside Linux-only specs, only `block-selection`
    remains** — flaky in every engine and on the 2026-11-09 baseline, not yet investigated.
  - **Second full `make e2e` (2026-11-12): 127 failed** — 111 the Linux-only folder specs, 16
    others. Fixed since:
    - **A real sync bug (web client, browser and app alike):** coming back online while the
      backoff's retry socket was still connecting opened a *second* socket; the first kept its
      listeners, so both sent the same offline edits and the server merged them twice —
      duplicated text and two identical conflict callouts. WebKit's timing hit it every time
      (`conflicts.spec` failed alone too). `attach` now replaces a socket only after detaching
      and closing it, and `onOnline` leaves a connecting socket alone (`sync.ts`; test
      `does not open a second socket while one is still connecting`, red without the guard).
      Conflict specs then 12/12 over three runs, WebKit + desktop.
    - The keyboard tree test's first-folder walk met an empty folder `name-emoji` creates; it
      now reaches the `Projects` fixture folder by arrows (passes with `name-emoji` first).
    - The emoji picker test clicks the picker's own buttons by exact name (a second `:tada:`
      button existed in two busy runs); 9/9 across projects.
    - `inbox`'s grouping test filters to the `Inbox` folder: in a busy shared vault the no-date
      group can pass 50 rows and push the fixture behind "Show more" (§10.3), the same cause
      `task-scroll`/`task-display` already filter for. Passes alone; a full run confirms.
    **Still open:** `pwa-refresh` (intermittent, both runs), `block-selection` (known flake),
    and `block-move` / `task-scroll` (one each, passed alone).
  - **First full `make e2e` with WebKit, on the user's MacBook (2026-11-12): 153 failed.**
    Triage (from `web/test-results/`): **111 are the Linux-only folder specs** (`folder-*`,
    `shallow-folder-*`, `new-vault`, `navigation-improvements` folder menus), 37 per project,
    failing on macOS by design (SPEC §6). Of the other 42, fixed since:
    - **Shared-vault interference, made likelier by a third project.** `block-catalog` and
      `document-links` inserted links to `Projects/Roadmap.md`, which `graph` and `backlinks`
      count the neighbours of; they now link to a per-project `Targets/Linkable-<project>.md`.
      The tree keyboard test took "first folder's first child" as a note while other tests
      create folders; it now steps down to the first note.
    - **A broken helper:** `history-trash`'s `hideMobileContext` *opened* the context sheet
      (it built a "Hide Context" locator and never used it); it passed only while the sheet
      was short. Three projects' scratch notes, all titled "Scratch", made the unlinked-mention
      list long enough to cover the editor.
    - **WebKit-specific:** `selection-menu` and `toggles` pressed Home/Shift+End (now
      `lineKey`); the global graph resized its canvas inside its `ResizeObserver` callback,
      which WebKit reports as an error — now measured in the next frame (`GlobalGraph.svelte`);
      `perf-readiness` blocks the service worker (WebKit does not route a worker's requests)
      and writes its em dash as an entity (WebKit's driver decoded the fulfilled body as
      Latin-1); the 16px favicon sample allows WebKit's wider edge blend (32 vs 12 at 16px
      only); the PWA install/update/refresh specs and the offline branding test skip WebKit
      (service-worker flows with the network off; the app has none).
    - Rerun after the fixes, each affected spec in all three projects: 127 + 26 + 18 passed,
      none failed; history-trash 3/3; selection-menu and toggles 14/14 (WebKit + desktop).
    **Still open:** `pwa-refresh` "return refresh updates closed pinned text…" is intermittent
    in Chromium (2 of 6 on mobile here; desktop and mobile in the user's run), not tied to a
    change this session; `block-selection` is the known flake in every engine; the rest of the
    42 (block-move, bookmarks, inbox, topbar, folder-actions, task-scroll, emoji picker) failed
    only in the full run and passed alone, so the full run's load is suspected, not shown.
    A second full `make e2e` is what tells.
  - **WebKit Playwright project (2026-11-12, SPEC §22.6, §7.6.1).** `webkit` project in
    `web/playwright.config.ts` (desktop size); `make e2e` installs WebKit and runs all three
    projects, `make e2e-webkit` runs WebKit alone, and the manual workflow installs it with
    `--with-deps`. Harness: `E2E_PROJECTS` in `e2e/environment.ts` drives scratch notes,
    empty vaults, drawings and a per-project bookmark note (bookmarks are per user, so the
    shared `Welcome` bookmark raced between projects — latent since mobile never ran that
    test); specs' `=== "desktop"` became `!== "mobile"`; `lineKey` in `e2e/fixtures.ts`;
    the failure fixture excuses WebKit's wording for loads cut off by navigation only.
    **Found and fixed in the app:** (1) the workspace asked every server for the desktop
    app's `/offline` state, a 404 on every load and every 3 s — this broke the whole Chromium
    E2E suite on this branch too (13 of 30 in two specs); now only the app asks
    (`CommandCenter.dom` test). (2) The image editor chunk's failed load was an unhandled
    rejection and left a dead "Edit image" button (`editor-shell-image-import.dom.test.ts`).
    (3) A failed emoji-catalog load was cached for the page's life (`emoji-catalog.retry.test.ts`).
    **Run here** (focused, not the full suite): 26 specs in WebKit — 97 passed, 19 skipped
    by design or by existing skips, 1 failed: `block-selection` Tab/Shift+Tab, the known flake,
    which failed in Chromium too when repeated. Chromium desktop+mobile over every touched
    spec: 199 passed. Web unit suite: 3171 passed. One Chromium mobile run of
    `offline.spec.ts` died inside Playwright ("browser has been closed" creating a context);
    6/6 on repeat. **Not run:** the full suite in any project (yours, `make e2e`); WebKitGTK
    on Linux; the §21 budgets on WebKit. Still open: `openGraph` in `Workspace.svelte` has the
    same unhandled-import shape (only when the graph is opened); `home.spec.ts` is not safe
    under `--repeat-each` (fixed folder name, fills an empty vault).
  - **Media sync built (2026-11-12, SPEC §7.6.10 "Media follows its note", §7.6.3, E35).**
    In `replica.rs`: `upload_media_of` runs before each `Upload` / locally changed `Exchange`
    (and in `place_recovered`), `download_media` after the notes, then
    `AppState::replica_media_prune` (the server's own `media::prune_orphaned`, sparing recent
    upload grants); `media.json` is the known-on-both-sides set. `Upstream::{media,
    upload_media}` (note: the route's parameter includes `media/`, so the URL says it twice);
    `LocalStore::write_exact` is now `pub(crate)` and checks the hash. `vault_gone` is async
    and prunes too. Tests: `replica` (+6: download, not for unkept notes, upload before the
    note and once, purge keeps shared media, recovered media never uploaded, create-again
    takes media), leak suite `e35_media_follows_the_readable_set_and_its_address_grants_nothing`.
    Mutations that went red: media route without its reference check, no prune, uploads for
    every action. **In a browser** (temporary probe, deleted): a note kept offline brought its
    image; with the server stopped the image rendered from disk. **Not covered:** an image
    inserted while offline then reconnected was tested in Rust only, not clicked through;
    PDFs and drawings follow the same path but were not tried; S3-backed servers were not
    tried (the address scheme is the same).
  - **E35 revocation purge and recovered notes built (2026-11-12, SPEC E35, §7.6.6, §7.6.7,
    A43).** The user chose that a recovered note holds **the whole note** (A43). Planner:
    `DeleteLocal` is gone; a note gone from a complete list is `Purge` (unchanged) or `Recover`
    (changed, or held by an older pass); a refused local create stays held. A pass matches a
    moved note by `id` across the whole listing, so a move out of a pinned folder is not a
    loss. `replica/recovered.rs` (bookkeeping, names, `without_id`), `replica::{recover,
    vault_gone, place_recovered}`, `AppState::{replica_create_markdown, replica_scrub}` (the
    unused `replica_delete` was removed). A vault missing from upstream's vault list is
    settled in `pass_all` (`settle_gone_vault`). `POST /api/v1/vaults/{slug}/recovered`
    (local, never forwarded) places a note; a pass lock (`SyncStatus::exclusive`) keeps a pass
    from running mid-choice; the window socket answers a recovered note's frames locally and
    the forwarded note list gains recovered notes. **Found by the leak suite and fixed:** a
    purged note's title survived in the index's SQLite WAL and its body in a Tantivy segment;
    `mb-index` now sets `secure_delete` and has `Index::scrub` (WAL truncate + segment
    merge), called after any pass that purged. Web: `RecoveredBanner.svelte`, the workspace
    line with Open/Later, `Recovery` threaded through `PaneTree`/`MobileMain` to `NotePane`.
    Tests: `replica` (+13), `desktop_connect` (+6, including the socket), leak suite (+2 E35),
    `mb-index` `rebuild` (scrub), plan unit tests and properties updated,
    `RecoveredBanner.dom` (7), `CommandCenter.dom` (+3), `device-offline` (+5). Mutations that
    went red: no `secure_delete`, no scrub after a pass, recovered notes not excluded from the
    plan, `Recover` turned into `Purge`, tab not following the note, recovered frames
    forwarded. **In a browser** (temporary probe, deleted): note edited here and deleted on
    the server → workspace line → Open → banner and text → Create the note again put it back
    on the server and the tab followed; at phone width, a note recreated upstream by someone
    else → Create again refused (only Make a new note left) → `Ideas/Hello mine` created,
    the other person's note untouched.
    **Not covered:** the web client's own recovered notes (§7.6.7 "Not desktop-only");
    backlinks, history and graph panels for a recovered note say unavailable (they are
    forwarded); a server note deleted on the server outside an index pass is noticed only
    when the server's own index catches up; secure delete and scrub also apply to ordinary
    server deletes' index rows but the server does not scrub after a delete (its trash keeps
    the body anyway).
  - **`cargo clippy --all-targets` fails on `tests/leak_suite.rs`** (`indexing_slicing`, one
    `type_complexity`): four sites in committed code (around line 1067) and seven in the
    uncommitted E36/E37/E38 tests. Not from the E35 work; the file's `#![allow]` covers
    `expect`/`unwrap`/`panic` but not indexing. Either add it there with a reason or use
    `.get()`.
  - **Everyday gaps closed (2026-11-12, SPEC §7.6.8, §7.6.10, E36).** (1) A note URL without
    `.md` opens the note: the `note` handler names a server vault's note by its path
    (`view.identity`, else `<url>.md`). (2) `target="_blank"` links and `window.open` go to
    the system browser through Tauri's `on_new_window`; the decision is
    `mb_server::desktop::link_target`, shared with `on_navigation`. (3) Bookmarks, saved
    layout and share links work through the app: `authorize_bookmarks` and
    `authorize_workspace` use `vault_user` (adds device tokens), `share_manager` takes a
    session or a device token (not an API token); the forwarder makes a created share's
    `/s/<token>` absolute on the vault's server. (4) The palette's offline command drives
    the app's pins (`noteCommand`), and `PinnedNotes` is not created in the app. (5) A
    "Offline. …" notice above the tree while the vault's server is unreachable
    (`offlineNotice`). Tests: `desktop_connect` (+5: short URL, `.md` URL, bookmarks, layout,
    share link through the app), leak suite
    `e36_a_devices_bookmarks_layout_and_shares_are_its_users_and_filtered_like_them`,
    `desktop::tests` (link targets), `desktop_forward` units (share URL),
    `device-offline.test.ts` (+6), `CommandCenter.dom.test.ts` (+4 desktop cases). Mutations
    that went red: origin prefix without a boundary, no share editor check, no share URL
    rewrite, snapshot not passed to the palette, notice hidden. **In a browser** (temporary
    probe, deleted): `/v/work/Hello` opened the server's note; stopping the server showed the
    notice in the sidebar, desktop and phone width. **Not verified:** the new-window hook in
    the real Tauri window (it compiles; clicking an external link there is the check).
  - **Vault picker redesigned (2026-11-11):** cards grouped "On <server>" (badge, Manage) and
    "On this device", with plain-language counts; checked in a browser in dark, light, phone
    width and offline. Leak suite `the_vault_picker_counts_only_notes_the_viewer_can_read`.
  - **Not verified:** anything in the real Tauri window; Windows and Linux; reconnection after
    an offline edit in a browser (the end-to-end tests cover it, the probe server could not
    come back).
  - **Found while testing, not fixed (pre-existing):** the service worker cannot register
    under the desktop server.
  - **Testing gotchas:** two servers on `127.0.0.1` in one browser overwrite each other's
    `mb_session`; the pane refuses `localhost`. `cargo test` stops at the first failing
    binary and `tests/http.rs` always fails twice (known, below), so use `--no-fail-fast` or
    run it alone. A probe/test upstream started with plain `axum::serve` has no maintenance
    loop, so its Markdown is written only when a note is closed.
  - **Open items:** held notes (view-only edits, refused creates) are only listed on the
    connected page, with no resolve action and no tree mark; the Servers page, not
    the workspace, is where sign-in state lives; view-only notes are not written read-only;
    a retained full-resolution original stays on the server (offline "view original" shows
    the display copy); a short URL naming a note by title alone in
    another folder resolves only when downloaded; first load of a server vault makes many
    forwarded requests (one client per server now, but still serial round trips); a pass's
    local file work runs on the async runtime; passes continue every 5 s after a revocation;
    ~3 s blank window at launch (FSEvents); opening an existing folder is Linux-only (E29);
    the `.app` is unsigned (each dev rebuild asks for Keychain access once); self-signed servers cannot be connected to;
    `device revoke` needs an admin password.
  - **Next:** the user asked to finalise the app. The everyday gaps and E35 are done (above).
    Media sync and the WebKit project are done too. Signing/notarization is declined for now (A49:
    unsigned packages, installed directly). Then: the §21 budgets on WebKitGTK. M19's 30-day /
    1 GB release sweep is likely moot under A46 — confirm with the user before striking it.
- A truncated, checksum-invalid or wrong-header sidecar still fails closed (SPEC §7.3), so
  that note stays unopenable until someone deletes the sidecar. Quarantine-and-rebuild could
  cover those cases too. It was left out because a truncated tail can hold accepted edits
  that were never flushed, so the trade-off needs a decision.
- A rebuilt sidecar starts a new CRDT lineage, the same as any I1 rebuild. A browser replica
  of the old lineage that reconnects with unsent edits merges as concurrent content. That
  risks duplicated blocks, not loss. This was not exercised in a browser.
- A real note edit still causes a full zone-segment rebuild under the index lock (SPEC §14.2
  honest limit). Index-backed routes also lock a `std::sync::Mutex` inline in async handlers.
  The per-note incremental delta, or moving the rebuild off the lock, is the follow-up.
- The perf vault is cached in `target/perf/vault`, including `.memberberry/` state and any
  notes the keystroke scenario edited. `cachedNoteCount` skips `perf-fixtures/`.
- **`make perf` completes on merged main** (2026-11-09, `local/debug/perf-merged-main-fixed.log`)
  after two harness fixes (`cf2970a`):
  - `web/perf/tabs.ts` (+ test): open-note picks tabs by note path, not position. The diagram
    scenario runs first and leaves its tab in front, so tab 0 was the Gantt note.
  - `diagramTypingSaved` in `measure.ts` (+ `typingSaved` test in `server.test.ts`): the
    diagram scenario waits until its 60 typed characters are in the `.md` file before the next
    scenario loads a page. Without it, mobile open-note's quick-switcher click never completed
    (Playwright stuck at "performing click action"; 4 of 4 full runs). Bisected: skipping the
    diagram typing, or waiting ~1.8 s for it to save, both fix it. **Why** leaving a page with
    unsent edits causes that is unexplained: a trace showed an idle main thread and no input
    events reaching the page, and a standalone repro (`local/debug/perf-mobile-switch.mts`,
    typing then leaving at once) never hung. Whether a real user could hit it is unknown.
- **Inbox paging (SPEC §10.3, 2026-11-09, `42cc7cd`).** Groups draw 50 rows, then
  "Show N more"; the sidebar Tasks view draws no rows while hidden or collapsed. Before/after
  `make perf` (`local/debug/perf-merged-main-fixed.log` → `perf-after-inbox-paging.log`):
  open-note desktop 156→14.9 ms, mobile 968→58 ms; INP desktop 120→16 ms, mobile 208→32 ms;
  longest task desktop 820→0 ms, mobile 3403→96 ms. Tests: `tasks.test.ts` (paging + seeded
  property test), `InboxPane.dom.test.ts` (5 new; 4 existing ones now open the Tasks view
  first, since hidden rows are no longer drawn), `e2e/inbox.spec.ts` "draws a page of a large
  group…" (desktop + mobile). Probes went red for: no cap, rows drawn while hidden, collapsed
  sidebar ignored, Show-more from below a page, page size 1000 (browser). The `task-scroll`
  and `task-display` mobile specs failed because their row was behind "Show more" in the
  shared E2E vault; they now use the inbox's Note filter (`onlyNote`).
- **`make perf` on merged main passes its gate except one stale record** (2026-11-09,
  `local/debug/perf-main-after-merges.log`). Its only failure was the `server-memory-idle`
  record, now inside budget and deleted; re-judging that run's `target/perf/report.json`
  against the updated `breaches.json` gives no failing row. Mobile longest task read 99 ms,
  mobile diagram typing 16.4 ms (both within their records). Follow-ups:
  - **Mobile longest task** (recorded at 111 ms): startup work on the main thread. A CPU
    profile (`local/debug/mobile-coldstart-*.cpuprofile`, script
    `perf-mobile-coldstart-profile.mts`) attributes it to `putNotes` (IndexedDB catalog),
    `putSearchSegment` and `mb_search::Segment` validation.
  - Mobile quick-switcher still measures nothing.
- Server memory (SPEC §21.11): the first `make perf` on merged main
  (`local/debug/perf-main-after-merges.log`) read 138.7 MB, inside the 150 MB budget, so the
  `server-memory-idle` record was deleted. It is close to the line and macOS RSS moves with
  machine memory pressure, so a later failure there needs the footprint checked first. The
  footprint-vs-RSS budget question in §21.11 is still open.

- **Full `make e2e` on macOS (2026-11-09): 93 failed.** Triage, with a baseline at `afbb2cd`
  (before the day's 15 commits) for comparison:
  - 78 were the folder fixture (`e2e/folder-fixture.ts`) binding 9012, the main E2E server's
    port, so it exited before readiness. Fixed: it now asks the OS for one free port per
    fixture. Those specs (`folder-*`, `new-vault`, `shallow-folder-*`) and
    `navigation-improvements` still fail **on macOS by design**: folder locations and the
    shallow-directory endpoint are Linux-only (SPEC §6). They need a Linux run; the
    port fix there is untested.
  - `task-display` (mobile) was a regression on main (2 of 3 runs failed, 0 of 3 on the
    baseline): after `page.reload()`, an instant `isVisible("Show Navigation")` ran before the
    shell rendered, so the drawer stayed shut. The same race was in 25 specs; all now use
    `openSidebar(page, side)` from `e2e/fixtures.ts`, which waits for the toggle in either
    state. `task-display`, `backlinks` and `graph` (mobile) then passed 3 of 3.
  - `perf-readiness` could never pass since `f50f8a8`: `timeToEditor` waited 90 s and the test
    allowed 45 s. `timeToEditor` takes a deadline; the test passes 5 s.
  - **Still flaky, and equally flaky on the baseline:** `workspace` (varying cases).
    (`block-selection` was here too; it was the reconnect-on-load bug, fixed above.) Different cases fail on each run; not caused by the
    day's work, not fixed.
  - `pwa-update` no longer races: each test copies `web/dist` into a temp directory and runs
    its own server on an OS-assigned port, so it never writes to `dist`. It passes in parallel
    (4/4 twice, 12/12 with `--repeat-each=3`).
- Settings scope deliberately omitted: no palette command for Settings, no server-admin
  editing of shared emoji from the dialog (the admin API still exists), no replacing an
  emoji's artwork, and no accent on server-rendered pages. Open windows other than the one
  that saved pick up appearance on their next load.
- An emoji rename that fails part-way through note writes leaves earlier notes rewritten.
  The old alias keeps everything rendering, but re-running the rename is refused (the old
  name is no longer canonical); finish by hand or rename back. The audit log lists touched
  files. Emoji renames scan every note file (no emoji index), so cost grows with vault size.
- Anonymous shares and CLI HTML still show readable custom shortcodes. They need their own
  rendering/authorization integration; authenticated vault image URLs must not be reused
  for anonymous shares. The authenticated app and its standalone HTML export render artwork.
- Whether “overwrite” also means replacing existing emoji artwork is awaiting clarification.
  The current change edits the filename suggestion; duplicate protection remains (SPEC §11.2).
- Run manual full E2E with make e2e. Full checks and
  coverage remain deferred until requested. Physical-device/performance acceptance and
  fresh remote CI remain unconfirmed.
- Editor formatting defaults are fixed, like existing editor undo keys. Workspace hotkey
  remapping does not yet cover editor keys; SPEC §8.4 records this unfinished requirement.
  Clear formatting remains keyboard-accessible through Alt-F10 and the toolbar.
- Open in main panel cannot load folder contents on this Mac: its shallow-directory
  endpoint is Linux-only and returns 404. Sidebar Rename/Delete has real-server browser
  verification; folder-content state transitions have DOM coverage. See SPEC §6.1.
- General external rich HTML import remains outside the clipboard scope.
- Other connected clients/bookmarks do not follow folder renames; only the initiating
  workspace updates. Other durable feature limits remain in SPEC.md.
- The macOS directory_path_included warning remains; its callers are Linux-only. Historical
  onboarding cleanup/recovery tests fail locally on the macOS /private/var vs /var
  temp-path comparison (http.rs:268); unrelated to settings, not fixed.
- Unreproduced sync registry lock-poisoned panic: capture the first backtrace; never clear
  poison or delete replicas. False-conflict callouts are not automatically removed.
- Browser IndexedDB cap/cross-tab eviction remains unverified. Existing Linux Chromium
  crashes and mobile performance breaches remain in web/perf/breaches.json. The prior
  clipboard bundle-only pass used a recorded allowance, not a clean long-term budget pass.
  The prior npm audit reported 13 advisories; not re-triaged here.

## Local development and gotchas

- The desktop app (`make desktop-dev`) uses `~/Library/Application Support/app.memberberry.desktop`
  and `~/Memberberry` unless `MEMBERBERRY_DESKTOP_DATA` / `MEMBERBERRY_NOTES_HOME` point
  elsewhere. Use the overrides for testing. `desktop/` is outside the root workspace, so
  `make check` does not build it; it has its own `Cargo.lock` and `target/`.
- make dev uses frontend 9011/backend 9010; these may be live user services. Do not stop
  or reuse them. Startup builds the backend shell; never copy web/index.html over dist.
- Rebuild before focused browser verification: npm --prefix web run build, then
  npm --prefix web run e2e -- emoji-import.spec.ts --workers=1. Run one spec at a time,
  without retries. After server changes also run cargo build -p mb-cli.
- Local listener/browser tests require sandbox escalation here. The repository Playwright
  harness provides real Chromium verification. Browser runs use disposable target/e2e vaults.
- Run editor benchmarks from web/: npm exec -- vitest bench --run src/editor/selection-menu.bench.ts.
  npm --prefix web exec from the repo root leaves fixture paths at root.
- Use stable Rust; 1.90 is too old for installed yrs. make wasm is unoptimized; use
  make wasm-ci for bundle measurements. No WASM change was required for these shortcuts.
- Never clear vault state/browser replicas to refresh. Close/reopen windows or use the
  explicit update flow. local/ is gitignored feedback/debug material.
- Install ProseMirror plugins at editor creation; late registration affects undo/handles.
  Preflight unknown-schema Y docs before binding. Poll native/model selection before keys.
- DOM attribute selectors containing astral emoji failed despite correct markup; compare
  actual aria-label strings instead. tables.spec.ts historically is not repeat-safe.
- Prefer cargo test -p mb-server --test rename for folder moves. A rename name filter misses
  folder_move cases and starts every integration-test binary unnecessarily.
