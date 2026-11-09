# Handoff

## Current state (2026-11-09): main has Mermaid diagrams and the index-lock sync fix

Two branches were merged into `main` (not pushed): `mermaid-diagrams` (Mermaid diagrams,
A38, SPEC §13.2, plus the §21.10 perf fixture) and `claude/xenodochial-gagarin-43e282` (the
index lock no longer starves note sync on a 10k vault, SPEC §14.2). They were verified
separately; the merged result has had focused tests only (see the end of Verification).

### Mermaid diagrams

Mermaid diagrams are in scope (A38, SPEC §13.2). The reason is Gantt charts: the team wants
Memberberry as a Confluence replacement. A ` ```mermaid ` code block renders as a preview.
Its source shows when the caret is inside (via Edit source, a click on the preview, or an
arrow key from the adjacent block) and hides on Done or when the caret leaves. Read-only notes
get Show source.

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
  reached by clicking or with Edit source.
- `npm audit` reports 29 advisories (3 critical), the same count as before Mermaid. One
  critical advisory is in DOMPurify 3.4.15 (IN_PLACE mode), which Mermaid's strict mode uses,
  now reachable from every note. `sanitize.ts` is the independent second pass. Not triaged.
- The Confluence Cloud side (a Forge macro wrapping `mermaid`, or a Marketplace Mermaid app)
  is a separate project, not in this repo.

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

## Verification

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
- Browser: `local/debug/perf-note777-loop.mts` (gitignored) loops the open-note steps against
  one perf server, logging WebSocket frames and HTTP timing. Before the fix each iteration took
  11–21 s. After: 2.6–6 s unthrottled and 9.5–13.5 s at 4x CPU throttle, with the body 0.5 s
  after the click.
- `make perf` ran every scenario on both profiles after this fix (`local/debug/perf-after-fix*.log`;
  desktop cold start 5712 → 312 ms). The rows it left over budget are tracked under "Next and
  open work" below with current numbers.

Merged main (2026-11-09): all mb-index suites, `http::tick_tests` (5), the Mermaid and
perf-harness vitest files (111 tests) and web typecheck pass. Full make check and local
coverage measurement are deferred, not requested. Full make e2e remains user-run and pending;
no full-suite result is claimed.

## Next and open work

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
- **`make perf` breaches are all recorded** (SPEC §21.4 "Measured, merged main"). The final
  run (`local/debug/perf-final.log`) failed only on the three rows since recorded in
  `web/perf/breaches.json`. Re-judging its `target/perf/report.json` against the new file gives
  no failing row; a fresh `make perf` has not been run since recording. Follow-ups:
  - **Server memory** (recorded at 413 MB): 83.7 / 277.8 / 412.9 MB across runs, and stable
    once read, so not in-flight work. The cause is unknown and needs a heap investigation.
    A "wait until settled" reading was tried and removed: it settled at once and explained
    nothing.
  - **Mobile longest task** (recorded at 111 ms): startup work on the main thread. A CPU
    profile (`local/debug/mobile-coldstart-*.cpuprofile`, script
    `perf-mobile-coldstart-profile.mts`) attributes it to `putNotes` (IndexedDB catalog),
    `putSearchSegment` and `mb_search::Segment` validation.
  - Mobile quick-switcher still measures nothing.
- **A note can become permanently unopenable — fix on branch `claude/busy-rubin-112b0f` (`06edea1`), not merged into main or reviewed here.**
- Server memory follow-up: branch `claude/quirky-lumiere-325cc1` (`5920960`, not merged or reviewed here) cuts the zone-segment rebuild peak 233 → 56 MB and bare-server startup 327 → 130 MB; after a perf run it still reads 173–197 MB, so the `server-memory-idle` record stays. The perf vault cached
  in this checkout had a server CRDT sidecar for Note 777 (written 2026-09-16) whose *first*
  record already has missing dependencies (Yjs pending structs). The server sends it on
  subscribe; the client's schema admission correctly refuses it, so every client shows
  "Refresh required" for that note. A fresh vault does not produce it. How the server
  persisted such a record, and why load does not detect it (Invariant I1 says a rebuild from
  Markdown must work), is uninvestigated. Evidence kept at
  `local/debug/perf-vault-broken-note777/` (`.memberberry/crdt/b29b635c….bin`) and the
  captured payload `local/debug/note777-sync-payload.bin`.

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
