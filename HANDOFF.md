# Handoff

## Current state (2026-11-01)

Editor formatting shortcuts are implemented and included in this commit. SPEC §8.4 documents the
bindings and eligibility rules. Cmd/Ctrl-B, I, U and E toggle bold, italic, underline and
inline code; Shift-X and Shift-H add strikethrough and highlight. Cmd/Ctrl-K opens the
existing link fields for selected body text. Marks also toggle at a body caret for new
typing. Tooltips and aria-keyshortcuts expose the bindings. Existing title, readiness,
read-only, composition, code/namespace and CRDT undo protections remain in effect.

The shortcut handler shares the selection toolbar lifecycle and reads the current native
selection before acting. It leaves embedded controls and independent fields alone. Earlier
clipboard, folder Rename/Delete, emoji naming and dev-startup work remains committed.
The user requested this commit. No push, deployment or live-vault operation was performed.

## Verification

- 166 focused web tests pass across shortcut matching, selection menu/formatting, namespace
  and native code combinations, undo, editor shell and refresh-required handling. Includes
  Mac/other modifier matching, stale native selection, caret typing, mixed selections,
  read-only/source/waiting/composition refusal, link titles, embedded controls and teardown.
  A seeded property test exercises 40 Unicode/RTL/emoji toggle-twice round trips.
- Cmd/Ctrl-B and I regression tests failed before implementation. Removing caret formatting
  made the four caret-typing regressions fail; the original implementation was restored.
- Production frontend build and TypeScript/Svelte typecheck pass (zero typecheck errors or
  warnings). Existing dependency directive and large-chunk build warnings remain.
- Both desktop/mobile cases in format-shortcuts.spec.ts pass against a disposable vault
  on 9012. They cover every mark shortcut, link fields, undo/redo, caret typing,
  canonical Markdown on disk and reload.
- The mounted selection-controller benchmark passes at 50/500/2000 blocks before and after
  this change. Its old setup probe failed before implementation because it used ordinary
  selectionSet after document invalidation; it now uses the documented explicit select API.
  An ordinary-keydown case was added. These are host/jsdom measurements, not physical-phone
  or full performance-budget acceptance.

Logs: local/debug/format-shortcuts-{tests,typecheck,build,browser,mutation}.log and
local/debug/format-shortcuts-bench-{before,after}.log.

Full make check and local coverage measurement are deferred, not requested.
Full make e2e remains user-run and pending; no full-suite result is claimed.
No server/read path or enforcement point changed, so server/leak suites were not rerun.

## Next and open work

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
  npm --prefix web run e2e -- format-shortcuts.spec.ts --workers=1. Run one spec at a time,
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
