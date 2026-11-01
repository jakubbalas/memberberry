# Handoff

## Current state (2026-11-01)

The emoji picker now offers only single-image import. Pack management, folder/ZIP import,
pack-name prompts, bulk-import helpers and their CSS are removed. The unused fflate
package is removed from package.json and the lockfile. Filenames supply shortcodes; name
collisions still ask for a unique replacement or cancellation. SPEC §11.2 and A33 record
this scope.

Each image uses the existing authorized upload endpoint with a generated internal storage
ID. Existing manifests, artwork, shared/vault resolution and administrative API remain
compatible. No server or read path changed. Pending file reads cannot upload after teardown;
active requests are aborted and late results cannot update a destroyed picker.

Picker outside/Escape dismissal and Slack importer removal are committed as 79a7217.
PNG chooser and quick-find fixes are in 65db429; formatting shortcuts are in 83d5e42.
No push, deployment or live-vault operation was performed for the current change.

## Verification

- 49 focused emoji-import/picker tests pass. They cover the single-file chooser, no
  pack-name prompt, successive imports with distinct storage IDs, supported formats,
  cancelled/multiple/empty/unsupported selections, collisions with existing aliases,
  replacement cancellation/validation, HTTP 403/409/500 and network/read failures,
  retry, teardown and late responses. Dismissal/focus behavior remains covered.
- Encoding properties use seed 20261101 (100 cases), plus a 65,537-byte chunk-boundary
  case. Tests for removed pack-management and bulk-import behavior were removed.
  The new single-import UI regressions failed against the previous controls first.
- Rebuilt emoji-import.spec.ts passes all four desktop/mobile cases against the real,
  disposable server. It verifies single-file selection, no management/bulk buttons or
  pack-name prompt, PNG decoding, reload from storage, Markdown shortcode persistence,
  outside mouse click/mobile tap, Escape inside/outside and toggle keyboard activation.
  Chromium verifies chooser configuration; it does not operate the native macOS dialog.
- Production frontend build, TypeScript/Svelte typecheck (zero errors/warnings),
  make token-check and diff checks pass. Existing dependency directive and large-chunk
  build warnings remain. Browser verification uses an escalated loopback test server.
- Prior quick-find verification: 55 TopBar/Workspace DOM tests, 14 desktop/mobile browser
  cases, inspected screenshots and token checks passed. Prior formatting-shortcut
  verification includes 166 focused tests, properties, browser cases and DOM benchmarks.

Fresh logs: local/debug/single-emoji-{before,tests,typecheck,build,browser,tokens}.log.
Screenshots: web/test-results/emoji-import-an-individual-be562-ted-as-a-Markdown-shortcode-{desktop,mobile}/png-imported.png.
Older logs remain under local/debug/emoji-dismiss-*, remove-slack-*, quick-find-* and
format-shortcuts-*. Browser test-results are overwritten by subsequent runs.

Full make check and local coverage measurement are deferred, not requested.
Full make e2e remains user-run and pending; no full-suite result is claimed.
Server/leak suites were not rerun: existing authorization and read paths are unchanged.

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
