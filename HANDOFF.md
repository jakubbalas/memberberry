# Handoff

## Current state (2026-11-02)

Inline emoji suggestions now open after one character following a colon, such as :t, at
the start of a text block or after whitespace. A bare colon stays closed; deleting back to
the bare colon closes suggestions. SPEC §11.4 and A35 record the user's final preference.
The shared empty-query helper still serves immediate-colon name dialogs without ranking
the whole catalog. Escape yields to the inline chooser before block selection can consume
it; a second Escape still performs normal block selection. The popup is kept within the
viewport, flips above the caret when needed and scrolls when height is limited.

The same change includes manual shortcode selection: every valid image import prompts
with a filename-derived suggestion (custom-emoji for Unicode/punctuation-only names).
Cancellation, invalid names and existing shortcode/alias collisions upload nothing.
SPEC §11.2/A34 records it. Replacing existing artwork remains unconfirmed.

Single-image import and pack-UI removal are committed as 60d7b20. Existing storage,
artwork, resolution, authorization and administrative API remain compatible. No server/read
path changed, and no push, deployment or live-vault operation was performed here.

## Verification

- 145 focused tests pass across commands, block handles, emoji import/picker and name
  prompts. They cover bare-colon suppression, one-letter queries, whitespace, Unicode/RTL
  context,
  glyph insertion, empty-query order/limit properties, first/second Escape ownership,
  manual shortcode selection, validation, failure/retry and teardown.
- The latest bare-colon suppression regression failed against the immediately-opening
  implementation before setting the one-character threshold. The mounted Escape regression
  failed when the block-selection capture handler stole the key. The
  mobile bounds regression first measured the popup extending to x=431px in a 412px viewport.
- Existing seeded Unicode normalization and byte-encoding properties remain green. The
  new empty-query prefix/order property uses seed 20261102 (100 cases).
- The rebuilt focused browser spec passes all six desktop/mobile cases. It checks
  bare-colon suppression, opening on one character, closing after deleting back to a colon,
  Escape without deleting/selecting text, viewport bounds and literal glyph persistence, alongside
  manual image shortcode import and toolbar dismissal. The initial runs found the Escape
  and mobile clipping bugs. A later test assumption about the ambiguous fuzzy query tad
  was corrected to the full tada shortcode; explicit bare-colon/one-letter checks remain.
  Final desktop/mobile screenshots were visually inspected; the menu is fully visible.
- Host benchmarks run over all 1,814 vendored entries, including one-character ranking.
  The shared empty-query shortcut retains before/after measurements from the prior iteration.
  Logs exclude DOM/layout and device input-to-paint;
  they do not establish SPEC §21's physical-device budgets.
- Production frontend build, TypeScript/Svelte typecheck (zero errors/warnings), token
  contract and diff checks pass. Existing dependency directive and large-chunk warnings
  remain. Browser verification uses a disposable loopback server with sandbox escalation.
- Prior quick-find verification: 55 TopBar/Workspace DOM tests, 14 desktop/mobile browser
  cases, inspected screenshots and token checks passed. Prior formatting-shortcut
  verification includes 166 focused tests, properties, browser cases and DOM benchmarks.

Fresh logs: local/debug/one-char-emoji-{before,tests,typecheck,build,browser,bench}.log.
Prior colon-emoji logs include Escape/mobile-position regressions and token checks.
Inline screenshots are the focused spec's colon-suggestions.png files in web/test-results/.
Older emoji-shortcode, single-emoji, emoji-dismiss, remove-slack, quick-find and
format-shortcuts logs remain in local/debug/. Browser test-results are overwritten by runs.

Full make check and local coverage measurement are deferred, not requested.
Full make e2e remains user-run and pending; no full-suite result is claimed.
Server/leak suites were not rerun: existing authorization and read paths are unchanged.

## Next and open work

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
- Custom emoji artwork in names remains unsupported; custom shortcodes stay textual.
  General external rich HTML import remains outside the clipboard scope.
- Other connected clients/bookmarks do not follow folder renames; only the initiating
  workspace updates. Other durable feature limits remain in SPEC.md.
- The macOS directory_path_included warning remains; its callers are Linux-only. Historical
  onboarding cleanup/recovery tests remain unverified locally.
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
