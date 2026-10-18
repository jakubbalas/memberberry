# Handoff — combined release PR

Updated 2026-10-18T20:35:00+02:00. Canonical local workflow: ../PROJECT.md,
../project-status.md and ../tasks/open/t-016-publish-combined-release-pr.md.

Live is healthy on memberberry-memberberry:combined-pwa-editor-20261018,
image sha256:4dd3b78eef63dc06068497e7ae74d64ed07e8a3da237606d637d17298ace1b06. Tested source ccfe65b625a2b4da642489f003880640ef138f69, branch
integrate/completed-work-20261018, worktree /var/home/paul/clawd/projects/memberberry/release-20261018.
Published [PR #5](https://github.com/jakubbalas/memberberry/pull/5) from
quantanex-tech:integrate/completed-work-20261018 to jakubbalas:main. The deployed runtime
remains the frozen source above; PR follow-up repairs currently affect tests only.
Original four worktrees, HEADs and indexes remain preserved.

Includes the deployed vault/folder/individual-movement baseline, purple block selection/
group moves, numbered-list Return and the installable PWA. All older remote feature refs
are already ancestors of fetched upstream 123d8e4. No unfinished Tasks source imported.

## PR checks and next action

Paul explicitly authorized publication, CI repairs and merge on October 18. The initial
CI run is [39154343837](https://github.com/jakubbalas/memberberry/actions/runs/39154343837).
Frontend types, tests and coverage floors pass; fuzz build and the unchanged bundle ceiling
pass. Rust CI stops at Clippy. Local full-workspace Clippy now passes after consolidating
duplicate test-helper modules, replacing test JSON/vector indexing with checked access,
naming the pause-hook tuple and using an octal permission literal. All test assertions and
gate settings remain in force. All 68 registration unit cases and the real unprivileged
discovery denial regression pass. Registration HTTP and permission leak suites are running.

Next: publish the verified repair, inspect all automatic CI jobs to completion, and obtain
upstream maintainer review/merge. Authenticated user quantanex-tech has READ permission on
upstream and ADMIN on its fork; cannot approve its own PR or merge upstream. Full manual
E2E remains user-run; physical-device and normal signed-in acceptance remain pending.

## Verified rollout and live review

All 389 frontend files and backend SHA256 b1e75eec57ec9a0bd90ea2c610f6d980f9b9d5144b922a1789ac9955ba2ba44d match
the tested package. Four registrations, 739 Markdown and four policies match the fresh
writer-stopped snapshot. Config, credentials, media, mounts, runtime/environment and
Compose are preserved. Six checked private same-disk backup archives and the previous
90585f1e… image are retained under before-combined-pwa-editor-20261018. All 63 saved
CRDT copies passed the unchanged-codec compatibility probe; live state was not opened
by the probe. No data restoration, registry/ACL/credential edit or Access policy change.
Backups are not off-host recovery. Never replay older deploy or restore stale notes.

Focused combined proof: 763 frontend cases/51 files; 54 leak + 23 sync + 13 WebSocket
and two HTTP cases; typecheck/tokens/Rustfmt/whitespace pass. Seven immediately rebuilt
single specs: 31 browser passes, one inherited mouse-only mobile exclusion, no retries.
The actual optimized release binary is used. Author spec/security then quality reviews
found no remaining finding; independent approval and feature acceptance are not claimed.

Read-only actual live desktop/mobile browsers render login/CSP, verify 11 served assets
including PNG/WASM plus protected entry denials; zero POSTs/errors. Exact build/data/health
rechecked afterward. Public signed-in review, actual Android install/native activation,
macOS and Access expiry remain Paul's checks. Unauthenticated command-line public requests
returned Cloudflare 403; real public Chrome reaches the normal Cloudflare Access sign-in (200), without credentials.
Full automatic CI/coverage verification is in progress under the new authorization.
Full user-run manual E2E and physical-device budgets remain pending. The initial CI bundle
ceiling passes; the underlying SPEC size-budget exception is not waived or increased.

Next: close all Memberberry tabs/installed windows and reopen
https://memberberry.quantanex.space using the normal account. Do not clear site data.
Test install/resume, return refresh, offline text/search, selection/group moves, numbered
Return and the current New vault form. Task/feature records remain in review for acceptance.

## Evidence and reproduction

../integration-evidence-20261018/combined-release/README.md contains the current runbook,
exact frozen source manifest/archive (763 inputs), package/backup/deploy/live-browser
receipts, retained failures, public check and source/index preservation proof. Code remains
published in PR #5, awaiting CI/review/merge. The generated note-WASM was explicitly
copied from the prior verified build and byte-matches its served package; schema unchanged.

Private build: memberberry-local-dev:/tmp/memberberry-combined-20261018, stable Rust,
1CPU/4GiB, offline dependencies and copied private target/node_modules. Scripts in the
runbook run affected frontend checks or exactly one rebuilt browser spec, one worker,
zero retries. Never overlap builders/fixtures or edit the old source directories.
Missing generated-WASM/browser-cache setup failures are retained, not counted as red.

Two integration corrections are recorded: constant same-origin manifest links explicitly
send credentials for authenticated proxies (real browser cookie-gate red/green proof);
update tests finish startup worker checks and await completed installation before asserting
the prompt (four final passes). The latter changes tests only. App update behavior remains
explicit reload, with old windows retaining their waiting worker/cache. No replica deletion,
offline media, closed-app periodic refresh or new third-party service is added.

## Inherited development gotchas

- ProseMirror plugins belong at editor construction. Unknown-schema Y docs must be
  preflighted before binding: y-prosemirror can delete unknown marks/nodes.
- Playwright native/model caret and selectionchange can disagree temporarily; poll the
  actual selection before shortcuts. Tiptap focuses on a deferred RAF.
- tables.spec.ts is historically not repeat-safe; repeated-run failures are not cleared.
- 9010/9011 are user dev services; do not stop/reuse them. This fixture owns 9016 only;
  other tasks own 9014/9015, as recorded in AGENTS.md.
- `~/.hermes/cache/scratch/memberberry-r3-mixed-diagnostic-o5qcg3iy/delivery` has a
  historical REPORT.md mode mismatch, unverified. Do not reseal without user consent.
- Earlier editor follow-ups remain outside this PWA slice: no touch Shift+Enter route,
  per-view toggle folding, no container-to-Text unwrap, no touch long-press handles;
  coverage and load-sensitive editor browser limits remain unwaived.

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
- Historical server-test Clippy failures are repaired in this PR; local workspace Clippy
  passes, and the next CI run must confirm it.
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
- Shell/PWA: foreground reconnect backoff remains up to 30s without a return/online
  signal; shared static precache across users of one browser profile; no skipWaiting;
  limited tablet/gesture coverage. t-014 adds immediate socket reopening on authorized return.
- Graphs: not persistent tabs; no live update; global nodes not draggable; local labels
  overlap; duplicate titles indistinguishable.
- Rename/folder move: open clients/bookmarks not updated; partial writes not rolled back;
  O(vault) cost.
- Outline/tags/transclusion: limited drag/cross-pane coverage; tags don't poll; embeds
  don't live-refresh; unavailable placeholders never name hidden targets (by design).
- Index/backlinks: no conditional 304; audit timestamps are Unix seconds, not RFC3339.
