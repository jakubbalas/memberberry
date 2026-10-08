# Handoff

Where things stand right now. Durable contracts and decisions live in `SPEC.md` (editor
redesign: §8.4; inline `mb-` style grammar: §4.4). Rewrite this file — never append.
History is in `git log`; detailed evidence for past runs is in `~/.hermes/cache/scratch/`.

## Current work: editor redesign (SPEC §8.4)

The user asked for namespace formatting (`mb-` underline / colour / background / size), a
selection-only floating style menu (Notion-like), block-type conversion and vertical block
rearrangement, all while keeping plain `.md` files.

**Last commit:** `ca3132c` — contextual selection menu plus *unwired* block-format /
movement / handle modules.

**Committed on branch `feat/editor-styling-r3`** (not pushed, not merged): the revision-3
integration, the mixed-style fix, conversion slice 1 and everything below. Revision 3:
- Rust-owned schema revision 3: `mb_underline`, `mb_color`, `mb_background`, `mb_size`
  (finite palette / small-large), Code mutually exclusive with `mb` styles.
- Server + browser schema admission and refresh-required on revision mismatch
  (`web/src/editor/schema-admission.ts`, `schema-revision.ts`); revision-isolated replicas.
- Contiguous-text CRDT encoder (fixes the Redo extra-space bug from fragmented XmlText).
- Table-plugin lifecycle fix (`tableRowHandles` installed at editor construction — fixes
  routed undo being dead before first typing).
- Styled link-title preservation, empty-title (`""`) preservation, parser CPU fix.
- Selection-menu style controls and shared `note-format.css`.

Focused checks passed after integration: core/CRDT 217, server 77, strict admission
(35 hostile wire cases), frontend 317 tests / 19 files, TS/Svelte 0/0, native + frontend
builds, refresh-required 17. WASM was reused (hash-verified), not freshly rebuilt.
`mb-core --test styled_title_gate` re-run 2026-10-08: 46/46 pass (the earlier styled-label
reference-link defect is fixed on main).

## Fixed 2026-10-08 — mixed-style `Later word` + `s`

Cause: Chrome delivers `selectionchange` as a later task. Moving focus from the editor to a
popup control right after `Shift+Arrow` dispatches Tiptap's `blur` transaction first; the
menu's `refresh()` recaptured the not-yet-updated ProseMirror selection (8..18, or 8..8
which hid the menu and dropped focus on `<body>`), and PM then ignores the late event
because it is unfocused. Fix in `selection-menu.ts`: on the `blur` transaction only, a text
selection is captured from the native range. Two RED→GREEN regressions in
`selection-menu.dom.test.ts`.

Evidence: a mixed-only Chromium loop failed 4/8–4/12 runs before, 0/20 after. The original,
unmodified `web/scripts/test-md-style-hosts.mjs` (run after `cargo build -p mb-cli` and
`npm --prefix web run build`) passed 3/3: desktop/mobile/titles/mixed/code rows, 5/5
restarted-server reopens, all 9 CSS hosts, no page errors. `selection-menu.spec.ts` 8/8.

Same change set also repaired stale tests from the revision-3 integration (failing before
this fix too): `selection-menu.spec.ts` assumed Link was 5 keys from Home (Underline now
precedes it) and that Bold disables Inline code (SPEC §4.4 now allows native wrappers
around Code); `note-editor.test.ts` lacked the WASM preload schema admission now needs.

## Done 2026-10-08 — block conversion slice 1: "Turn into" Text ↔ H1–H4

Contract and limits: SPEC §8.4 "Implemented, first conversion slice". Pieces:
- `single-editor.ts`: shared gate (duplicate editor / known peer / offline / pending),
  counting distinct *editors* per note key. `block-move.ts` now uses it (behaviour kept).
- `selection-menu.ts`: `Turn into` select first in the popup, only when the shell passes a
  gate; `editor-shell.ts` builds the gate from new `noteKey` option; `note-surface.ts`
  passes `[vault, note]`. Local-only editors get no control.
- Tests: 7 new DOM tests in `selection-menu.dom.test.ts`, 7 in `single-editor.dom.test.ts`
  (mutation-probed: gate bypass at invocation, display, local-only, nested, per-editor
  counting all go red). Browser: new `Turn into` case in `selection-menu.spec.ts`
  (convert, disk, one-step undo, fresh-context reopen; desktop + mobile).
- Also fixed a stale `editor.spec.ts` selector (sidebar row is now named just the title).

Checks run: web `src/editor` + `src/shell` unit suites 1801/1801, typecheck 0/0, token-check,
`selection-menu.spec.ts` 10/10 and `editor.spec.ts` 20/20 (desktop + mobile).
Not run: full `make check` / `make e2e` (explicit request only), Rust (unchanged), phone perf.

## Done 2026-10-08 — user's full `make e2e` run: 17 failures triaged

Two product bugs (each with a RED→GREEN unit test):
- **More menu stayed open after inserting a block**, covering the new table (`editor-shell.ts`;
  Move up/down deliberately keep it open).
- **Tab scroll offset was lost** when a note's body synced after mount: the deferred
  `placeCursorBelowTitle` focus scrolled to the caret (`note-editor.ts`, now
  `scrollIntoView: false`; Tiptap scrolls in a later frame, so the test awaits one).

Stale tests: `reload-note`/`editor` sidebar row name; `global-graph` ambiguous `getByLabel`
(a "Links" folder now exists in the shared vault); `tables` insertion now under More;
`autosave` read the pre-revision-3 IndexedDB name (now from `offline/database-name.ts`) and
used Ctrl/Cmd+End, which Chromium's isMobile emulation ignores.

The nine affected spec files pass together (109 passed, 29 layout skips). **Not explained:**
`backlinks` (mobile) and `graph.spec.ts` failed only in the full run and pass alone and in
that nine-file run — needs the user's next full `make e2e` to confirm or reproduce.

## Done 2026-10-08 — style controls redesigned

The three "Default" selects are replaced by one "A" button + labelled panel (SPEC §8.4
"Style control"). Real-browser bug found on the way and fixed: applying a style queues a
write, the Turn-into gate heard "pending" mid-dispatch and re-synced controls with the
pre-edit capture, disabling every choice — Chromium then dropped focus to `<body>` and the
next click hid the popup. Gate re-sync now skips while applying (DOM test simulates the
mid-dispatch pending; mutation-probed). The pressed choice keeps focus after applying.
Updated: `selection-menu.dom.test.ts`, `namespace-format.dom.test.ts`,
`scripts/test-md-style-hosts.mjs` (passes: durable rows, Mixed headings, defaults, Code
refusal, restarts, all CSS hosts), new `selection-menu.spec.ts` case (12/12 both layouts).

## `make check` status (2026-10-08)

**Passes end to end** (`local/debug/make-check-20261008-184911.log`): fmt, clippy, Rust
2698 passed / 0 failed, `test-release`, every coverage floor, token/deployment/dev checks,
svelte-check 0/0, web 2028/2028. Watch `mb-core` coverage: 95.22% against a 95% floor.
The log now ends with a `make check: exit N` line.

- **Slow test handled:** `mb-search/tests/size.rs` (10k-note index: ~2 s optimized, >15 min in
  debug) is `#[ignore]`d in debug builds only and runs via `make test-release`, which is part
  of `make check` and a CI step.
- Fixed since the first run (log `make-check-20261008-172740.log`, which stopped at fmt):
  - `cargo fmt` over 20 revision-3 files; clippy clean workspace-wide (parse/mod.rs ifs +
    alias, `sync.rs` test module moved to the end, test-file `#![allow]`s with reasons).
  - **Revision-3 bug:** styled text split one link into several. `style::normalize` merges
    siblings first; `canonical::inlines` rejoins adjacent identical links after settling
    (`style::join_links`). Tests in `mb_style.rs`, mutation-probed; WASM rebuilt.
  - Property generator gives links distinct destinations, assumed on the *input* (an
    assumption on the output masked the bug — avoid). CRDT limit "adjacent identical links
    join" is in SPEC §5.6 with a pinning test.
  - `mb-server`: `strict_schema2_admission` wrote a receipt to `$INDEPENDENT_EVIDENCE_DIR`
    (scratch-harness leftover, no assertion) — removed. Two `sync.rs` tests compared a
    macOS `/var` temp path with the server's real `/private/var` path — now canonicalized.
- Verified directly: fmt, clippy, all Rust crates' tests except `size.rs` in debug (0
  failures), `size.rs` in release, web unit suite 2028/2028, `make wasm-check`.

## Integration branch `integration/r3-with-pr3` — Paul's PR #3 merged in for joint testing

PR #3 (`origin/pr/3`, Paul Hopgood, 2026-10-07, not merged upstream) adds, per its handoff:
- Enter/Tab/Shift-Tab list behaviour (new sibling, leave on empty, nest, outdent).
- Paired single backticks typed in a paragraph become inline `code` (SPEC §8.4).
- Yjs undo survives ProseMirror plugin-view reconfiguration: the undo manager now lives
  for the Y.Doc lifetime. Overlaps our fix (table plugin installed at construction) — both
  are kept; re-verify undo with both in place.
- Choosing a `[[` suggestion inserts a Markdown link `[Title](path.md)` (SPEC §8.2).
- Perf harness: bounded 90 s readiness wait for slow throttled mobile setup, unchanged
  budgets and 30 s interaction deadline.
Its open items: the four-job CI gate on its exact head had not all passed (`perf` had timed
out before the harness change); jsdom benchmarks are not device evidence; no broader
concurrent/remote undo browser tests. Only `HANDOFF.md` conflicted textually.

Joint verification on the integration branch: web unit suite 2045/2045, typecheck clean,
browser specs editor-input / undo / document-links / selection-menu / tables / editor 54/54
(desktop + mobile), style-host acceptance pass. One semantic overlap needed a test change:
undo history is now owned by the session's Y.Doc (PR #3) — our lifecycle tests observed
closure through an instance spy that cannot see `doc.destroy`; they now spy the prototype
(separate commit). Not run here: `make check`, full `make e2e`.


- Push `feat/editor-styling-r3` and open a PR when the user asks.
- Conversion slice 2: list / task / quote / callout targets. Peer-text loss for these was
  characterized (SPEC §8.4), so the gate is the safety story; container shapes need new
  `block-format.ts` prepare logic (the earlier scratch candidate is gone).
- Wire block movement handles (`block-handles.ts`, unwired) behind the same gate — but its
  last review FAILED (repeated-move undo truncates unrelated text, temporary selection
  breaks under filters/appenders, GapCursor capability misreported) and the repair was lost
  with scratch. Re-verify those findings against main before wiring.
- Toggles (collapsible containers): grammar not specified — needs a user decision.
- Popup first reveal paints before its RAF positioning — characterized, not fixed.
- The three style selects all read "Default" with no visible label (colour/background/
  size are only distinguishable by tooltip) — small UX fix worth doing.

## Gotchas

- **Never register ProseMirror plugins after the bound editor exists.** Reconfiguration
  destroys y-prosemirror's UndoManager, and history silently dies. Install everything at
  construction. (Durable — should move into SPEC.)
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
