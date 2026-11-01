# Handoff

## Current state (2026-11-01)

The emoji picker closes on outside pointer presses and Escape, including after focus moves
outside. Outside interactions continue normally; Escape returns focus to the Emoji toggle
and is consumed only while the picker is open. Document listeners are removed on editor
teardown. SPEC §11.4 records the behavior.

The dedicated Slack emoji export importer is removed: button, selection mode, JSON parser,
alias-import logic and its helpers. Image, folder and ZIP import still derive shortcodes
from filenames. Existing pack aliases still participate in collision detection. SPEC §11.2,
M10 and decision A32 reflect the requested scope.

PNG chooser and quick-find alignment fixes are committed as 65db429. The importer opens
individual files/ZIPs through Import custom emoji, with a separate Import emoji folder
button. Quick find follows the editor through sidebar resizing/collapse (SPEC §8.2).

Formatting shortcuts are committed as 83d5e42. Earlier clipboard, folder Rename/Delete,
emoji naming and dev-startup work is also committed. No push, deployment or live-vault
operation was performed for the current changes.

## Verification

- 26 focused emoji-import/picker tests pass, covering outside dismissal, Escape inside and
  outside, focus restoration, event propagation, closed-picker behavior, listener teardown,
  file/folder chooser switching, PNG upload, cancelled/invalid/empty selections, ZIP decoding,
  filename/alias collisions, unsupported JSON metadata and pack management. The new control-list test
  failed with the Slack button present before the removal was written. Dismissal regressions
  also failed against the old implementation. Tests for deleted Slack-only behavior were
  removed; general collision coverage is retained.
- Rebuilt emoji-import.spec.ts passes all four desktop/mobile cases against the disposable
  real server: outside mouse click/mobile tap, Escape before/after focus leaves the picker,
  focus restoration and toggle keyboard activation, native file chooser configuration, PNG
  upload and decoding, reload from the installed pack, insertion as a Markdown shortcode
  on disk, and folder/file switching.
  The updated spec also checks the absence of a Slack import button.
  Screenshots were visually inspected. Chromium verifies chooser configuration and file
  selection; the macOS native dialog itself is not driven by this test.
  The first run's extra mobile pointer-toggle check failed because the bottom sheet covers
  the toolbar toggle. The corrected test uses its keyboard action; outside mobile dismissal
  is verified with a real tap. That initial failure is in emoji-dismiss-browser-before.log.
- Production frontend build and TypeScript/Svelte typecheck (zero errors/warnings) pass.
  Existing dependency directive and large-chunk build warnings remain. Browser verification
  uses an escalated disposable loopback server.
- Prior quick-find verification: 55 TopBar/Workspace DOM tests, 14 desktop/mobile browser
  cases, inspected screenshots and make token-check passed. Its two viewport-specific
  exclusions remain: desktop drawer layout and mobile side-by-side panels.
- Prior shortcut verification remains valid: 166 focused tests, seeded Unicode properties,
  caret mutation probe, desktop/mobile shortcut browser cases and mounted DOM benchmarks.

Fresh logs: local/debug/emoji-dismiss-{before,tests,typecheck,build,browser}.log. Previous
removal logs remain at local/debug/remove-slack-*.log. Screenshots:
web/test-results/emoji-import-an-individual-be562-ted-as-a-Markdown-shortcode-{desktop,mobile}/png-imported.png.
Prior quick-find logs remain in local/debug/quick-find-*.log; shortcut logs remain under
local/debug/format-shortcuts-*.log. Browser test-results are overwritten by subsequent runs.

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
