# Handoff

## Current state (2026-11-01)

The latest completed work fixes the blank development page and emoji naming. make dev previously copied source
HTML over web/dist/index.html, so the backend requested /src/main.ts and /src/shell/app.css
and returned 404 for both. A real browser reproduced the empty app. Startup now builds the
frontend after WASM/dependencies and aborts if the build fails. Vite continues rewriting the
compiled shell to source URLs for HMR. The running dev installation was repaired by rebuilding
its frontend; no running service was stopped and no vault data/configuration was changed.
SPEC §22.6 records the startup contract.

The user confirmed the development page now works after the rebuild. Unsigned requests
to /v/personal still return the existing neutral 404; / provides sign-in.

Emoji naming fixes are included in this commit. New note/folder dialogs now offer the offline
Unicode catalog from the first colon, including after a nested-path separator. Keyboard,
pointer and touch selection insert literal glyphs; Enter selects without submitting, and
Escape dismisses suggestions before closing the dialog. Exact-name deletion confirmations
and tag prompts do not autocomplete. Folder labels in the tree and contents view resolve
base-pack shortcodes/aliases while preserving literal directory paths. Unknown/custom
shortcodes remain textual. SPEC §11.4 records this behavior. No backend, permission boundary,
note format or dependency changed for the emoji fix.

Earlier uncommitted work remains intact:

- Clipboard: Cmd/Ctrl-X cuts purple multi-block selections only after every clipboard
  format was written. Copy retains selection. A versioned ProseMirror slice preserves rich
  cross-note paste; Rust admission validates the candidate before changing the replica.
  Failure retains the source; invalid rich payloads leave the destination unchanged.
  SPEC §8.4 records the transient format and limits.
- Folder Rename/Delete: exact-name confirmation for nonempty folders, direct empty deletion,
  E32 permission-checked trashing, and initiating workspace tab/view updates. SPEC §6.4,
  §8.2 and §22.5 document it.

This commit contains only the emoji naming and development-startup changes. Earlier
clipboard and folder rename/delete changes remain uncommitted. Nothing was pushed or
deployed, and no live-vault operation was performed.

## Verification

The exact staged source was exported to an isolated checkout before committing. It passed
145 focused shell/picker/editor-command tests, typecheck (zero Svelte errors/warnings),
make dev-check (two startup regressions plus supervisor self-test), production build and
all eight desktop/mobile cases across name-emoji.spec.ts and dev-shell.spec.ts, run one spec
at a time. The count excludes the unrelated uncommitted folder-action tests.
Logs: local/debug/commit-emoji-dev-build.log, commit-emoji-browser.log and
commit-dev-shell-browser.log. The user also confirmed their dev page now works.

Development-page verification:

- Two startup regressions first failed, then passed. make dev-check now includes them and
  passes its process-supervision self-test. Build failure prevents server startup.
- The live public shell on 9010 and isolated Vite source page on 9011 both rendered a real
  editor without console errors or HTTP failures after rebuilding.
- All four desktop/mobile dev-shell.spec.ts cases pass: compiled public shell and signed-in
  disposable-vault home, with browser console/HTTP failures enforced. Build passes.
  Logs: local/debug/dev-shell-build.log and local/debug/dev-shell-browser.log.

Emoji verification:

- Regressions first failed on missing suggestions and literal folder shortcode labels.
- 154 focused DOM/unit tests pass (149 shell/picker cases plus five editor-command cases).
  They cover naming, folder tree/contents/navigation/create/actions,
  command center, shared emoji picker, caret replacement, aliases, Unicode, unknown names,
  exact-name confirmations, catalog failures/retry and destruction during loading.
  Logs: local/debug/name-emoji-unit.log and local/debug/name-emoji-typecheck.log.
- Production build and typecheck pass; Svelte reports zero errors/warnings. Existing
  dependency directive and large-chunk build warnings remain.
- All four rebuilt name-emoji.spec.ts cases pass on desktop and mobile: first-colon suggestions,
  Escape, keyboard/touch insertion, note/folder creation and reload, plus existing shortcode
  folder labels retaining literal paths when targeting note creation.
  Logs: local/debug/name-emoji-browser.log and local/debug/name-emoji-build.log.
- No new read path: existing permission-filtered folder lists are the only source of names.
  Folder denial-removal tests remain in the focused run.
- In-app Browser bridge was unavailable. The repository Playwright harness supplied real
  Chromium verification. Its disposable loopback listener required sandbox escalation.

Earlier verification, not rerun in full during the emoji fix:

- Clipboard: 253 focused editor tests, seeded property tests and four desktop/mobile browser
  cases passed. Mutation of admission checks failed the refusal tests as expected.
  Logs: local/debug/clipboard-admission-mutation.log, clipboard-cut-build.log,
  clipboard-bench.log. Benchmarks are local DOM measurements, not physical-phone acceptance.
- Folder actions: 170 focused web tests, four browser cases, four repository tests,
  43 leak tests, 25 rename tests and three folder-delete HTTP cases passed.
- Server Clippy retains the macOS unused-method warning. The earlier clipboard bundle-only
  pass used its recorded allowance and was not a clean long-term performance-budget pass.

Full make check and local coverage measurement remain deferred, not requested.
Full make e2e remains user-run and pending; no full-suite result is claimed.

## Next

Review the still-uncommitted clipboard work and folder actions. Run manual full E2E with make e2e.
Full checks, coverage and remote CI remain deferred until requested. Physical-device
acceptance remains unconfirmed.

## Local development and gotchas

- make dev uses frontend 9011/backend 9010; these may be live user services. Do not stop
  or reuse them. Focused browser fixtures use disposable vaults on 9012. Startup builds
  the backend shell before listening; never replace dist/index.html with web/index.html.
- Rebuild before focused browser verification:
  npm --prefix web run build && npm --prefix web run e2e -- name-emoji.spec.ts --workers=1
  After server changes also build cargo build -p mb-cli before browser testing.
- Listener tests need sandbox escalation here. Sandboxed bind refusals are environmental.
- The DOM selector engine failed to match an astral emoji in an attribute selector despite
  correct markup. Folder-content assertions compare the actual aria-label string instead.
- Run the clipboard benchmark from web/: npm exec -- vitest bench --run src/editor/clipboard.bench.ts.
  Running npm --prefix web exec from the root leaves benchmark fixture paths at root.
- Use stable Rust; 1.90 is too old for installed yrs. make wasm is unoptimized; use
  make wasm-ci for bundle measurements. No WASM rebuild was needed for the emoji fix.
- Never clear vault state/browser replicas to refresh. Close/reopen app windows or use the
  explicit update flow. local/ is gitignored feedback/debug material.
- Install ProseMirror plugins at editor creation; late registration affects undo/handles.
  Preflight unknown-schema Y docs before binding. Poll model selection before shortcuts.
- tables.spec.ts historically is not repeat-safe; use one browser worker and no retries.

## Open items

- Open in main panel cannot load folder contents on this Mac: its shallow-directory
  endpoint is compiled only on Linux and returns 404 here. Folder-content rendering and
  state transitions have DOM coverage; sidebar browser cases use the real server.
  This remains documented in SPEC §6.1.
- Custom emoji artwork in names is not implemented; names retain literal custom shortcodes.
- General external rich HTML import remains outside the clipboard fix.
- The directory_path_included macOS warning remains; its callers are Linux-only.
- Full E2E, physical-device acceptance and fresh remote CI remain unconfirmed. Historical
  onboarding cleanup/recovery tests remain unverified locally.
- Unreproduced sync registry lock-poisoned panic: capture the first backtrace; never clear
  poison or delete replicas. False-conflict callouts are not automatically removed.
- Browser IndexedDB cap/cross-tab eviction remains unverified. Existing Linux Chromium
  crashes and mobile performance breaches remain in web/perf/breaches.json.
- The prior npm audit reported 13 advisories; not re-triaged here.
- Other feature limits remain in SPEC.md. Other connected clients/bookmarks do not follow
  folder renames; this change updates only the initiating workspace.
