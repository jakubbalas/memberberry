# Handoff

## Current state (2026-10-29)

Folder rows now offer **New note** first in their context menu, shared by right-click,
the three-dot button, Shift+F10 and ContextMenu. It opens the existing naming dialog
inside the exact targeted folder, including empty/nested folders, then opens the created
note for editing. The existing create endpoint, server authorization and Markdown storage
are reused. SPEC §6.10 and §8.2 describe the behavior. No backend or read path changed.

The folder-menu change is local. No deployment or push was performed.

The checkout on main retains the prior integration of PR #6,
including PR #5, note covers, relative dates, typed numbered lists and block selection.
The prior README rewrite is also present. The approved operational bundle ceiling and
long-term optimization target remain as documented in SPEC §21.

## Verification

- All four new folder-menu DOM cases first failed because New note was absent, then
  passed with the implementation: three-dot click, right-click, Shift+F10 and ContextMenu.
  They verify the nested destination differs from the open note, menu dismissal,
  dialog input focus and no incidental folder expansion or note navigation.
- 134 focused tests pass across NoteTree.dom.test.ts, ContextMenu.dom.test.ts,
  create.test.ts, CommandCenter.dom.test.ts, FolderNavigation.dom.test.ts and
  NavigationImprovements.dom.test.ts. Existing creation refusal, validation, folder
  navigation, keyboard navigation, dismissal and listener-cleanup tests are included.
- Production frontend build passes. Typecheck passes with zero Svelte errors/warnings.
  Build has the existing dependency directive and large-chunk warnings.
- Rebuilt folder-new-note.spec.ts passes all four desktop/mobile cases with one worker
  and no retries. Covers desktop right-click, mobile three-dot tap, keyboard creation,
  empty nested Unicode/RTL/emoji folder paths, destination/focus, editable new notes,
  and actual Markdown persistence. Desktop/mobile menu screenshots were inspected.
- The initial browser invocation could not bind loopback 9012 inside the sandbox;
  the rebuilt focused run with sandbox escalation passed. Build log:
  local/debug/folder-new-note-build.log. Screenshots: web/test-results/.

Full make check and local coverage measurement are deferred, not requested.
Full make e2e remains user-run and pending. No full-suite result is claimed.

Prior integration verification, not rerun for this frontend-only change: 322 focused
editor tests, rebuilt date/block-selection browser specs, and local bundle gate passed.
The earlier PR-head perf CI failed at its old bundle ceiling; no fresh remote CI result
is claimed after the approved budget update. Physical-device acceptance is unconfirmed.

## Next

Review the folder-menu change. Full E2E is manual: make e2e. Fresh full checks,
coverage and remote CI remain deferred until requested; no new feature work is required
for the folder-menu action.

## Local development and gotchas

- `make dev`: frontend 9011 and backend 9010. These may be live user services;
  do not stop or reuse them. Default focused browser fixtures use 9012 and disposable vaults.
- Rebuild before each focused browser spec:
  `npm --prefix web run build && npm --prefix web run e2e -- note-cover.spec.ts --workers=1`.
  Build the current Rust CLI after server changes: `cargo build -p mb-cli`.
  Listening tests require sandbox escalation in this environment.
- Use stable Rust; 1.90 is too old for the installed yrs dependency.
- `make wasm` creates unoptimized WASM; use `make wasm-ci` for bundle measurements.
- Install ProseMirror plugins at editor construction. Late registration rebuilds
  plugin views; undo ownership and row handles depend on their lifecycle.
- Preflight unknown-schema Y docs before binding; y-prosemirror can delete unknown nodes/marks.
- Browser native/model selections may disagree briefly. Poll the model caret before shortcuts.
- tables.spec.ts is historically not repeat-safe. Heavy parallel browser runs have
  caused mount timeouts; use one worker and no retries.
- Never clear vault state or browser replicas to refresh the app. Close all app/PWA
  windows and reopen, or use the explicit update flow with pending-work safeguards.
- local/ is gitignored; local/debug/ is the user's feedback inbox. Never stage it.
- The fork's production deployment and external evidence paths are not this machine's
  runtime or reproduction instructions. No live deployment has been inspected here.

## Current limits and open items

- PR #5 introduced a macOS unused-method warning for directory_path_included
  (crates/mb-server/src/vault.rs:131); its callers are Linux-only. It remains open.
- New date/block behavior has the limits in SPEC §8.4: relative words are English,
  timed ISO values are local wall-clock values without a timezone offset, plain ISO
  dates also receive relative presentation, and unsupported block ranges stay unchanged.
- Covers decorate authenticated panes and browser print/PDF; anonymous shares and
  browser HTML exports omit the banner. Markdown/vault exports retain metadata.
  Offline uploads retain the old cover until completion and require the note to
  stay open. Source editing changes body blocks, not frontmatter.
- Editor: no container-to-Text unwrap or touch long-press block handles; touch uses
  More. Toggle folding is per-view; default folding is source-only.
- Unreproduced sync registry lock poisoned panic: capture the first backtrace; do
  not clear poison or delete replicas. False-conflict callouts are not auto-removed.
- Browser IndexedDB cap eviction and cross-tab eviction remain unverified.
- Previously failing onboarding failed-config-write cleanup and unreadable-vault
  recovery-guidance tests remain unverified locally. Historical server-test Clippy
  failures were repaired in PR #5 and its CI passed; full integration Clippy is deferred.
- Linux Chromium crashes and mobile cold-start/quick-switcher performance breaches
  were recorded in web/perf/breaches.json. No physical-device claim is made.
  The last npm audit reported 13 advisories; not re-triaged here.
- Codec: native marks on atomic images may be lost; adversarial unmatched CommonMark
  brackets are slow. Existing multi-client/browser coverage remains limited.
- Tables: no offscreen drag autoscroll, column deletion/resizing or headerless mode.
- Inbox: no offline filtered query, live refresh, remembered filters or timezone-aware dates.
- Creation: no template picker; creation is not audited (§6.10).
- Unlinked mentions: silent 50-block cap; no conversion/highlight/live refresh.
- Offline: caps are not configurable; eviction is per visible vault; pins are device-local;
  no folder pins or offline media. Shared static precache across browser-profile users,
  no skipWaiting or closed-app periodic refresh. Tablet/gesture coverage is limited.
- Graphs: not persistent tabs; no live update; global nodes are not draggable;
  local labels overlap and duplicate titles are indistinguishable.
- Rename/folder move: open clients/bookmarks are not updated; partial writes are not
  rolled back; cost is O(vault).
- Outline/tags/transclusion: limited drag/cross-pane coverage; tags do not poll and embeds
  do not live-refresh. Unavailable placeholders never name hidden targets by design.
- Index/backlinks: no conditional 304; audit timestamps are Unix seconds, not RFC3339.
