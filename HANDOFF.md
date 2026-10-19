# Handoff

## Current state (2026-10-19)

The latest iteration rewrites README.md as the project introduction: purpose, important
features, local and production setup, storage, existing-vault registration, development,
and documentation links. The old Status section and implementation history are removed.
This is documentation-only; behavior and SPEC.md are unchanged. Documentation diff,
relative links, and commands were reviewed against the repository. No application tests
were needed; full checks, coverage, and manual full E2E remain deferred/pending below.

The existing integration state and its verification/open items remain relevant:

Local branch `integrate/pr-6` integrates PR #6 at
`af6ea5e4f08c92e64eb7785bf4ab22aba49a4c00` into main at
`69458126f4db9b46d444e3f824200713b11c9d1b`. PR #5's integration is already
on GitHub main. The user authorized the local PR #6 merge commit, including the
approved bundle budgets. Nothing has been pushed in this iteration.

Only HANDOFF.md conflicted. Application code and SPEC.md merged automatically,
retaining note covers and PR #5 alongside relative date mentions, typed numbered
list markers, full-pane block selection, Delete/Backspace and grouped Tab/Shift+Tab.
The new behavior is documented in SPEC §8.4. The fork's deployment/evidence paths
are not reproduction instructions for this machine.

The user also approved a 950 KiB (972,800-byte) operational bundle ceiling.
SPEC §21 records the allowance and comparison; the user then revised the long-term
optimization goal to 500 KiB (512,000 bytes). The operational ceiling remains 950 KiB.
The bundle gate passes on the current local build.

## Verification

Focused PR #6 integration verification:

- 322 tests pass across nine editor files: relative-date seeded round-trips,
  date controls, block handles/movement, input rules, autocomplete, note editor,
  editor shell and covers.
- Production build and frontend typecheck pass with zero Svelte errors/warnings.
- Rebuilt date-mentions.spec.ts passes all eight desktop/mobile cases, including
  readable Markdown persistence, source/code exclusions, date editing and typed lists.
- Rebuilt block-selection.spec.ts passes 15 cases; three pre-existing mouse-only
  mobile cases remain skipped. Native text selection screenshots were inspected.
  The first run had 14 passes, one failure and three exclusions: its reverse text
  drag began within the previous native highlight and invoked macOS text drag-and-drop.
  The test now collapses the caret before each direction and verifies that setup;
  the same forward/backward Alpha assertions pass. No application behavior, retry
  setting or assertion was relaxed. This is an observed red/green setup correction.
- Build logs: local/debug/pr-6-date-build.log, pr-6-selection-build.log and
  pr-6-selection-fixed-build.log. Browser screenshots/traces live in web/test-results/.
- Staged whitespace checks pass; Git reports no unresolved files.
- Bundle-gate configuration: all 50 focused breach/verdict/bundle/report tests pass.
  The 500 KiB target lookup test first failed against 350 KiB before the target changed.
  New boundary tests first failed under the old ceiling; they now prove 972,800
  passes and 972,801 fails for both device classes. The focused local bundle-only
  gate passes at 921,198 bytes; log: local/debug/pr-6-bundle-950kib.log.

Actual PR-head CI was checked: check, web and fuzz-build pass, but perf FAILS at
the Critical-path bundle budget step. Its server/browser runtime steps were skipped.
Job: https://github.com/jakubbalas/memberberry/actions/runs/39267288362/job/118110073455
That historical CI result predates the user-approved ceiling increase and has not
been rerun remotely. No bundle optimization or physical-device acceptance is claimed.

The PR author reports full Rust/frontend checks and coverage floors plus four
rebuilt browser specs (41 passes, five existing mouse-only mobile exclusions).
Those results predate this combined checkout and are not local reruns. No
single zero-exit full make check rerun is claimed by the author after repairing
two autocomplete listener assertions; the repaired complete web-check passed.

Prior local PR #5 integration verification passed 361 frontend tests, all 42
macOS-enabled leak cases, one HTTP cover-permission case and desktop/mobile cover
browser cases, plus build/typecheck and sync benchmark compilation. These results
predate PR #6; backend sources are unchanged by this PR.

Full `make check` and local coverage measurement remain deferred, not requested.
Full `make e2e` remains user-run and pending. Physical-device performance acceptance
is unconfirmed. The combined branch's local bundle gate passes with the approved
ceiling and existing generated WASM; fresh optimized CI validation remains pending.
Main previously recorded an optimized bundle-size failure. PR perf timing/memory runs
with --report-only and does not establish budget acceptance.

## Next

Review the README presentation changes alongside the local integration merge, then
obtain fresh CI for the approved bundle ceiling. Focused integration verification
passes; main and remote refs remain unchanged by this documentation iteration.

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
