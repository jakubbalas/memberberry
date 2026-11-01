# Handoff

## Current state (2026-11-01)

The completed work adds rich clipboard transfer and sidebar folder Rename/Delete.

- Cmd/Ctrl-X cuts purple block ranges only after every clipboard format was written.
  Cmd/Ctrl-C retains the highlight. Native text and block selections preserve formatting,
  explicit lines, nested lists and task attributes when pasted into another note. The
  prospective document passes existing Rust/WASM admission before changing the replica.
  Clipboard failure retains the source; incompatible rich payloads leave the destination
  unchanged. SPEC §8.4 records the transient format and limits.
- Folder Rename keeps the parent and updates links plus initiating-workspace tabs/views.
  Delete removes physically empty folders directly; folders with any contents require their
  exact basename. E32 authorizes the complete tree before confirmation disclosure/mutation,
  closes sync rooms, moves notes into Markdown trash and removes directories nonrecursively.
  Arbitrary files, symlinks, hidden/excluded entries and denied descendants refuse deletion.
  I/O errors can leave partial deletion; the client refreshes before retry. SPEC §6.4,
  §8.2 and §22.5 carry the contract and leak-test mapping.

Emoji naming and development startup are also committed. Unicode suggestions open from the
first colon, folder labels resolve base-pack shortcodes without changing paths, and make dev
builds the backend shell instead of copying source HTML over it. The user confirmed the dev
page works. No changes were pushed/deployed and no live-vault operation was performed.

## Verification

Fresh focused verification for clipboard/folder work:

- 336 web tests pass across clipboard, block handles/movement, schema admission, undo,
  selection menu/editor shell, folder actions/navigation/tree, folder requests and naming.
  Seeded clipboard property cases and clipboard denial, stale/read-only editor, invalid
  payload/task metadata and listener teardown tests are included.
- Four folder-delete repository tests, all 43 permission-leak tests, three folder-delete
  HTTP cases and all 25 rename cases pass. Coverage includes hidden/read-only descendants,
  traversal/symlinks/arbitrary files, admin without content access, stale empty listings,
  exact Unicode confirmation, storage failure and Markdown trash/restore.
- All eight desktop/mobile browser cases pass, one spec at a time after rebuilding:
  clipboard-cut.spec.ts and folder-actions.spec.ts. They use Chromium's isolated clipboard
  and disposable notes/vaults, exercising real cut/paste, undo/redo, cross-note navigation,
  persistence/reload, keyboard/touch menus, empty deletion, confirmed deletion and restore.
- Production frontend and server builds, TypeScript/Svelte typecheck (zero errors/warnings),
  Rust formatting and diff checks pass. The existing macOS directory_path_included unused
  method warning and frontend dependency directive/large-chunk warnings remain.
- The clipboard benchmark completed for 50/500/2000 paragraphs. These are local DOM
  measurements, not physical-phone or full performance-budget acceptance. Prior clipboard
  mutation probes made admission-refusal tests fail; the original code was restored.

Logs are under local/debug/remaining-changes-*: web-tests.log, typecheck.log,
repository.log, leaks.log, http.log, folder-moves.log, server-build.log, web-build.log,
clipboard-browser.log, folder-browser.log and clipboard-bench.log.
The earlier mutation log is local/debug/clipboard-admission-mutation.log.

The emoji/dev commit was independently verified from its staged source with 145 focused
web tests, typecheck, make dev-check, production build and eight desktop/mobile browser cases
(name-emoji.spec.ts and dev-shell.spec.ts). Logs: local/debug/commit-emoji-dev-build.log,
commit-emoji-browser.log and commit-dev-shell-browser.log.

Full make check and local coverage measurement are deferred, not requested.
Full make e2e remains user-run and pending; no full-suite result is claimed.

## Next

Run manual full E2E with make e2e. Full checks, coverage and remote CI remain deferred until
requested. Physical-device/performance acceptance remains unconfirmed. No feature work is
intentionally left uncommitted by this change.

## Local development and gotchas

- make dev uses frontend 9011/backend 9010; these may be live user services. Do not stop
  or reuse them. Startup builds the backend shell; never copy web/index.html over dist.
- Rebuild before focused browser verification. After server changes also run cargo build
  -p mb-cli. The focused browser harness uses disposable vaults on 9012; run one spec at a
  time with --workers=1 and no retries.
- Local listener/browser tests require sandbox escalation here. The in-app Browser bridge
  was unavailable; the repository Playwright harness provided real Chromium verification.
- Prefer cargo test -p mb-server --test rename for folder move tests. A name filter of
  rename misses folder_move cases and starts every integration-test binary unnecessarily.
- Run clipboard benchmarks from web/: npm exec -- vitest bench --run src/editor/clipboard.bench.ts.
  Running npm --prefix web exec from the repo root leaves fixture paths at root.
- Use stable Rust; 1.90 is too old for installed yrs. make wasm is unoptimized; use
  make wasm-ci for bundle measurements. No WASM change was required for these fixes.
- Never clear vault state/browser replicas to refresh. Close/reopen windows or use the
  explicit update flow. local/ is gitignored feedback/debug material.
- Install ProseMirror plugins at editor creation; late registration affects undo/handles.
  Preflight unknown-schema Y docs before binding. Poll model selection before shortcuts.
- DOM attribute selectors containing astral emoji failed despite correct markup; compare
  actual aria-label strings instead. tables.spec.ts historically is not repeat-safe.

## Open items

- Open in main panel cannot load folder contents on this Mac: its shallow-directory
  endpoint is Linux-only and returns 404 here. Folder-content state transitions have DOM
  coverage; sidebar Rename/Delete browser flows use the real server. See SPEC §6.1.
- Custom emoji artwork in names remains unsupported; custom shortcodes stay textual.
- General external rich HTML import remains outside the clipboard scope.
- The macOS directory_path_included warning remains; its callers are Linux-only.
- Full E2E, physical-device acceptance and fresh remote CI remain unconfirmed. Historical
  onboarding cleanup/recovery tests remain unverified locally.
- Unreproduced sync registry lock-poisoned panic: capture the first backtrace; never clear
  poison or delete replicas. False-conflict callouts are not automatically removed.
- Browser IndexedDB cap/cross-tab eviction remains unverified. Existing Linux Chromium
  crashes and mobile performance breaches remain in web/perf/breaches.json. The prior
  clipboard bundle-only pass used a recorded allowance, not a clean long-term budget pass.
- The prior npm audit reported 13 advisories; not re-triaged here.
- Other connected clients/bookmarks do not follow folder renames; only the initiating
  workspace updates. Other feature limits remain in SPEC.md.
