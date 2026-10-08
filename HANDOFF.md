# Handoff

Where things stand right now. Durable contracts and decisions live in `SPEC.md` (editor
redesign: §8.4; inline `mb-` style grammar: §4.4). Rewrite this file — never append.
History is in `git log`; detailed evidence for past runs is in `~/.hermes/cache/scratch/`.

## Current state (2026-10-08)

`main` is `1339b53` (PR #4 merged with a merge commit): editor styling revision 3 plus
Paul's PR #3, which therefore landed too. Nothing is in flight; the working tree is clean.

The user's editor redesign (SPEC §8.4): namespace formatting, a Notion-like selection
popup, block-type conversion and block rearrangement, all in plain `.md`. On `main` now:
- **Styling revision 3** (SPEC §4.4): `mb-style` underline / colour / background / size
  with server + browser schema admission and refresh-required on revision mismatch.
- **Selection popup:** native marks, link, an "A" button opening a labelled colour /
  background / size panel, and **Turn into** Text ↔ Heading 1–4 behind the single-editor
  gate (`single-editor.ts`, shared with block movement).
- **From PR #3:** list Enter/Tab/Shift-Tab, backtick inline code, undo history owned by
  the session's Y.Doc, `[[` inserting Markdown links, perf readiness wait.

Verification on the merged code: `make check` green (`local/debug/make-check-20261008-214030.log`),
web unit 2045/2045, overlapping browser specs 54/54 desktop + mobile, style-host acceptance
(`web/scripts/test-md-style-hosts.mjs`) pass. **Not run:** full `make e2e`, physical-device
performance. GitHub CI results on PR #4 were not checked from here.

## Next

- **Full `make e2e` on `main`.** `backlinks` (mobile) and `graph.spec.ts` failed once only in
  a full run and pass alone and in smaller runs; unexplained until a full run reproduces
  or clears them.
- **Conversion slice 2:** list / task / quote / callout targets for Turn into. Peer-text loss
  for these is characterized (SPEC §8.4); the gate is the safety story. Needs new
  `block-format.ts` prepare logic (the earlier scratch candidate is gone).
- **Block movement:** wire `block-handles.ts` behind the gate — but its last review FAILED
  (repeated-move undo truncating unrelated text, temporary selection under filters /
  appenders, GapCursor capability). The repair was lost; re-verify on `main` first.
- **Toggles:** Markdown grammar not specified — needs a user decision.
- **Small UI items:** popup first reveal paints before its RAF positioning; "A" wraps to the
  toolbar's second row on mobile; the "No background" swatch outline is faint on desktop;
  Move up/down under More are announced as "Insert move up block".
- **Coverage margin:** `mb-core` is 95.22% against a 95% floor.

## Gotchas

- **Install ProseMirror plugins at editor construction.** Late registration rebuilds plugin
  views; y-prosemirror's stock undo plugin then destroyed its UndoManager. Undo now survives
  that (`durableUndoPlugin`, history owned by the Y.Doc), but table handles and other
  plugins still assume construction-time install.
- The installed y-prosemirror binding **mutates/deletes** unknown nodes/marks when loading
  an old-schema doc. That is why admission preflights state before binding (SPEC §8.4).
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
