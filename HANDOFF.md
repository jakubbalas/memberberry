# Handoff

## Current state (2026-10-19)

Local branch `integrate/pr-5` integrates PR #5 at
`2c715985e2b75c948c74c569383a98ef6d627dfc` into the note-cover main commit
`c0410f041a25df8c65b17958fc5f08411c8dd963`. The user authorized the local
merge commit; main has not moved and nothing has been pushed.

The two textual conflicts were HANDOFF.md and crates/mb-server/benches/sync.rs.
The benchmark resolution retains and registers both cover extraction and opt-in
non-writable-folder resolution benchmarks. This handoff replaces the fork's
deployment-specific instructions with the state of this checkout.

The combined source contains Markdown-backed note covers, server-folder vault
discovery/registration, shallow folder browsing/creation, grouped block selection
and movement, numbered-list Return, and PWA install/resume/refresh/update controls.
SPEC.md merged automatically and retains both contracts, including cover §12.5,
PWA §7.4 and the new permission enforcement entries. Editor-shell integration
also merged automatically; focused shell/movement/cover tests and the cover browser
regression pass on the combined source.

## Verification

Focused local integration verification passes:

- 361 frontend tests across 22 files: cover, editor shell, block movement/handles,
  PWA, admin folder/new-vault flows and folder shell components.
- All 42 macOS-enabled permission leak tests, including E11 covers and the PR's
  revoked-reader sync regression. Linux-only folder/registration leak cases are
  compiled out here; their evidence remains the PR-head Linux CI result.
- The focused HTTP cover authorization test passes (one test).
- Rebuilt note-cover.spec.ts passes on desktop and mobile (two browser cases),
  using the rebuilt combined-source CLI and a disposable server on 9012.
- Production web build and frontend typecheck pass (zero Svelte errors/warnings).
  Build output is in local/debug/pr-5-integration-build.log.
- The sync benchmark target compiles with both benchmarks retained. Focused
  rustfmt and staged whitespace checks pass.

Rust build/check emits an incoming PR warning on macOS: directory_path_included
in crates/mb-server/src/vault.rs:131 is unused because its callers are Linux-only.
Left open to keep this conflict resolution focused; a warnings-as-errors check
on macOS would need this addressed. Vite also retains its vendor directive/chunk
size warnings. No performance or bundle-budget acceptance is claimed.

PR-head GitHub CI was independently checked: check, web, perf and fuzz-build all
passed on 2c71598. This is evidence for the PR head, not for this combined branch.
The PR reports 763 focused frontend cases, 92 selected Rust cases and 31 browser
passes before publication; its later CI reports full Rust/frontend tests and
coverage floors passing. These are upstream results, not local reruns.

Main's preceding cover work passed focused cover/shell/uploader tests, seeded
metadata properties, extraction/round-trip tests, E11 leak and HTTP tests, and a
rebuilt desktop/mobile note-cover browser spec. Its mutation probes caught missing
cover extraction, stale uploads and missing clipboard/drop listeners. Local prior
evidence is in local/debug/note-cover-*.log; those results predate this integration.

Full `make check` and local coverage measurement are deferred, not requested.
Full `make e2e` remains user-run and pending. The PR's perf job enforces bundle
size but reports browser timing/memory with --report-only; green CI is not
physical-device performance acceptance. Main previously recorded an optimized
bundle-size failure; the combined branch's bundle gate has not been rechecked.

## Next

Review the local integration merge before merging into main. Manual full E2E
and user feedback remain pending.
No deployment or remote merge is authorized by the current local integration task.

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
- Creation: no folder-row note creation or template picker; creation is not audited (§6.10).
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
