# Handoff

Where things stand right now. Durable contracts and decisions live in `SPEC.md` (editor
redesign: §8.4; inline `mb-` style grammar: §4.4). Rewrite this file — never append.
History is in `git log`; detailed evidence for past runs is in `~/.hermes/cache/scratch/`.

## Current state (2026-10-14)

`main` is `1339b53` (PR #4 merged with a merge commit): editor styling revision 3 plus
Paul's PR #3, which therefore landed too.

**Work is in flight on `feat/editor-next`** (committed, not pushed, no PR yet — see Next).
The working tree is clean.

The user's editor redesign (SPEC §8.4): namespace formatting, a Notion-like selection
popup, block-type conversion and block rearrangement, all in plain `.md`. On `main`:
- **Styling revision 3** (SPEC §4.4): `mb-style` underline / colour / background / size
  with server + browser schema admission and refresh-required on revision mismatch.
- **Selection popup:** native marks, link, an "A" button opening a labelled colour /
  background / size panel, and **Turn into** Text ↔ Heading 1–4 behind the single-editor
  gate (`single-editor.ts`, shared with block movement).
- **From PR #3:** list Enter/Tab/Shift-Tab, backtick inline code, undo history owned by
  the session's Y.Doc, `[[` inserting Markdown links, perf readiness wait.

`main` verification: `make check` green (`local/debug/make-check-20261008-214030.log`), web
unit 2045/2045, overlapping browser specs 54/54 desktop + mobile, style-host acceptance
(`web/scripts/test-md-style-hosts.mjs`) pass. **Not run:** full `make e2e`, physical-device
performance. GitHub CI results on PR #4 were not checked from here.

## Next

`feat/editor-next` adds on top of `main`:
- Popup first-frame / Move labels / swatch fixes.
- Turn into → lists, to-dos, quote, callout, code, equation.
- Block-move fixes (nested atom selection, undo/redo caret); block handles wired with gated
  More moves, slim ⋯ then grip on one row, 12px clear of the text, in a
  compact desktop gutter (hover there resolves by pointer row, so the handles no longer
  vanish crossing to them), none on touch; `e2e/block-move.spec.ts`.
- Clipper HTML `<` text-loss fix plus import tests.
- Toggles as foldable callouts; Mod-Enter folds from anywhere inside one.
- Shift+Enter adds a line in the same block (Markdown hard break) in any
  paragraph, including list items, quotes, callout and toggle bodies; headings and summaries
  stay single-line (SPEC §8.4).

Verified on the branch: editor/shell unit 1858, web typecheck, mb-core / clipper Rust tests,
clippy, wasm-check; browser specs single-worker on both layouts — selection-menu, block-move,
editor, toggles, tables, and line-break (×3 each layout, plus a probe that it fails with the
feature unplugged). **Not run on this branch:** `make check`, full `make e2e`, coverage.

Open items:
- **Line break:** no touch route (soft keyboards rarely send Shift+Enter). Headings are
  tested (unit + browser) to ignore Shift+Enter; toggle summaries take the same fall-through
  path but have no test of their own.
- **Toggles:** folding is per-view and not remembered across reloads; no UI to change a
  toggle's `+`/`-` default (edit source); arrow glyph size may want tuning.
- **Unwrap** containers (list/quote/callout → Text) in Turn into: not implemented.
- **Long-press handles on touch** (§8.2): not implemented; touch uses More → Move.
- **Coverage:** `mb-core` was 95.13% vs a 95% floor before the clipper tests; re-measure.
- **Load-sensitive e2e:** under heavy machine load, parallel workers time out mounting the
  editor and `editor.spec.ts` "bootstrap identifies the note" once hit 30 s (0.5 s normally).
  Use `--workers=1` when the machine is busy; not a product defect so far.

## Gotchas

- **Install ProseMirror plugins at editor construction.** Late registration rebuilds plugin
  views; y-prosemirror's stock undo plugin then destroyed its UndoManager. Undo now survives
  that (`durableUndoPlugin`, history owned by the Y.Doc), but table handles and other
  plugins still assume construction-time install.
- The installed y-prosemirror binding **mutates/deletes** unknown nodes/marks when loading
  an old-schema doc. That is why admission preflights state before binding (SPEC §8.4).
- Playwright can press a key before `selectionchange` reaches ProseMirror, so a shortcut
  right after a click or arrow key runs at the old caret (flaky ~1 in 3). Poll the model
  caret first — Tiptap exposes the editor as `root.editor` (see `e2e/line-break.spec.ts`).
- `tables.spec.ts` fails under `--repeat-each` (2 tests, from the second repeat, on `HEAD`
  too): it is not repeat-safe. A single run passes; don't read repeat failures as regressions.
- Native typing in Playwright: Tiptap focuses on a deferred RAF; wait on a synchronous
  native+model caret/focus predicate, not on `focus` alone.
- After keyboard selection, `editor.state.selection` can trail the native range until
  `selectionchange` fires — and never catches up if focus leaves first. Code reacting to
  focus leaving the editor must read the native range (see `selection-menu.ts`).
- Ports 9010/9011 are the user's running dev services — never stop or reuse them as
  test fixtures. E2E uses 9012.
- `~/.hermes/cache/scratch/memberberry-r3-mixed-diagnostic-o5qcg3iy/delivery` has a
  file-mode mismatch (REPORT.md 0644 vs declared 0444); a fix was denied at runtime.
  Don't call it verified; don't reseal without user consent.

## Local development

- `make dev`: app on 9011, server on 9010. Disposable E2E server on 9012.
- `make check` also writes `local/debug/make-check-<time>.log` (`make-check-latest.log` links
  the newest); read that instead of re-running the gate.
- Rebuild before each focused browser run:
  `npm --prefix web run build && npm --prefix web run e2e -- <name>.spec.ts`.
  Run specs serially (shared fixture).
- Use stable Rust (1.90 is too old for current `yrs`; don't downgrade the dependency).
- `make wasm` = no-opt dev WASM; bundle-budget measurements need `make wasm-ci`.
- Never delete vault state or browser replicas to pick up UI changes; close all app tabs /
  installed-app windows and reopen so the new service worker activates.
- `local/` is gitignored (feedback in `local/debug/`); never stage it.

## Open safety / verification items (pre-existing)

- `sync registry lock poisoned` panic: unreproduced, unfixed. Capture the first backtrace
  if it recurs; don't clear poison or delete replicas.
- False-conflict callouts are not auto-removed.
- Real-browser IndexedDB cap eviction and cross-tab eviction unverified.
- Previously failing on main, unverified since:
  `onboarding_failed_config_write_removes_the_unpublished_vault_and_allows_retry`,
  `unreadable_vault_shows_recovery_guidance_only_to_its_member`.
- Linux Chromium crashes, mobile cold-start / quick-switcher perf breaches
  (`web/perf/breaches.json`). Laptop/jsdom benchmarks are not Android evidence.
- `npm audit`: 13 advisories (1 low, 10 moderate, 2 high) last seen, not re-triaged.
- Clippy on server tests has 30 inherited errors (not green).
- Known codec limits: native marks on atomic images can be lost; adversarial unmatched
  CommonMark brackets are slow.

## Carried-forward feature limits

- Tables: no offscreen drag autoscroll; no multi-client browser coverage; no column
  delete/resize or headerless tables.
- Inbox: no offline filtered query, live refresh, remembered filters, timezone-aware dates.
- Creation: no folder-row create / template picker; creation not audited (§6.10).
- Unlinked mentions: silent 50-block cap; no conversion/highlight/live refresh.
- Offline bodies/pins: caps not configurable; eviction per visible vault; pins device-local;
  no folder pins.
- Shell/PWA: reconnect delay up to 30s without `online` event; shared precache across users
  of one browser profile; no skipWaiting; limited tablet/gesture coverage.
- Graphs: not persistent tabs; no live update; global nodes not draggable; local labels
  overlap; duplicate titles indistinguishable.
- Rename/folder move: open clients/bookmarks not updated; partial writes not rolled back;
  O(vault) cost.
- Outline/tags/transclusion: limited drag/cross-pane coverage; tags don't poll; embeds
  don't live-refresh; unavailable placeholders never name hidden targets (by design).
- Index/backlinks: no conditional 304; audit timestamps are Unix seconds, not RFC3339.
