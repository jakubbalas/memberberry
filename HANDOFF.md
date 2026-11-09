# Handoff

## Current state (2026-11-09): Mermaid diagrams, visual Gantt editor, the index-lock sync fix, CRDT sidecar quarantine, inbox paging, zone-rebuild memory

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
  calls `retireWorkers` instead of registering in dev. Unit and regression tests pass;
  `e2e/pwa-update.spec.ts` passes with `--workers=1`. Not checked signed-in on 9011 (no dev
  credentials here): the user's next reload there should clear the banner.
- Open: `e2e/pwa-update.spec.ts` rewrites the shared `web/dist` in place, so its tests race
  when run in parallel (`ENOTEMPTY` renaming into `dist/assets/pwa-update-test`) and leave
  `dist/pwa-update-*` staging folders behind. It also changes what a running `make dev`
  serves while it runs. Run it with `--workers=1` until it gets its own web root.

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
  - **Still flaky, and equally flaky on the baseline:** `block-selection` (Tab/Shift+Tab,
    menus), `workspace` (varying cases), `pwa-update` (including `ENOTEMPTY` renaming a
    `dist/pwa-update-*` directory under parallel workers). Different cases fail on each run;
    not caused by the day's work, not fixed.
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
