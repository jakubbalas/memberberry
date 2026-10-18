# Handoff — combined release candidate

Canonical workflow: ../PROJECT.md, ../project-status.md and
../tasks/open/t-015-combine-completed-work-and-deploy.md.

Worktree release-20261018, branch integrate/completed-work-20261018. Paul directly
requested combining all completed work and deploying it for live testing on October 18.
This branch preserves the deployed vault/folder/individual-movement baseline and adds
purple block selection/group moves, numbered-list Return and the installable PWA.
Original source worktrees and indexes are preserved; integration uses verified snapshots.
Older Tasks/editor refs already occur in upstream history; no unfinished Tasks changes
are included. Latest fetched origin/main is 123d8e4. No GitHub push/PR is requested.

Current state: integration and focused validation in progress. Live remains on
ignore-folders-20261018 (90585f1e…) until the matched build is verified. No deployment
or backup claim is made at this checkpoint. Evidence and deployment tooling live in
../integration-evidence-20261018/combined-release/. Never replay older rollout receipts.

The approved rollout preserves all live registrations, note/policy bytes, credentials,
media, runtime and mount settings. Fresh writer-stopped backups and previous image are
required. Saved CRDT compatibility is checked on copies. Never restore stale notes or
clear browser replicas. Paul performs normal-login/device acceptance afterward.

Source/security self-review precedes quality review; combined verification must cover
folder filters, permission boundaries, selection plus numbered Return, PWA refresh,
search and guarded cross-window updates. Full make check, coverage, full user-run manual
E2E, independent approval and physical-device budgets remain deferred/unwaived. No
speedup/phone performance claim; inherited optimized bundle failure remains open.

Durable behavior is in SPEC §6.1/6.4, §7.4, §8.4 and §14.2. The matching server and
frontend must deploy together. Offline media and closed-app periodic refresh are deferred.
The new app uses explicit reload; the waiting worker changes offline build only when
old controlled windows close. A remembered path grants no server authority.

The isolated build and exact reproduction commands are recorded in the evidence runbook.
Do not overlap browser fixtures or Rust builders; each browser spec requires a rebuild,
one worker and no retries. Use installed stable Rust (1.90 fails existing yrs code).

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
- Clippy on server tests has 30 inherited errors (not green).
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
