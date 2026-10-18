# Handoff

## Current PWA candidate (2026-10-18)

This is the isolated t-014 checkout, not the deployed app or the parallel editor/vault
branches. Canonical workflow records live one directory above: PROJECT.md,
project-status.md, tasks/open/t-014-installable-pwa.md and features/installable-pwa.md.
The shared status retains the other chat's t-013 focus.

- Worktree: `/var/home/paul/clawd/projects/memberberry/pwa-20261018`.
- Branch: `feat/installable-pwa-20261018`; base `123d8e4ddf01f4c1d63ccc7afa4ef1321b449e58`.
- Feature source/tests and this handoff are uncommitted. No staging, commit, merge, push,
  PR, live-data mutation or deployment. Other worktrees and their indexes are preserved.
- Scope and approved behavior: SPEC §7.4; permission ordering §6.4/E2/E3, search §14.2.

Implemented Chrome installation assets/prompt, last-vault/workspace launch (including
local offline layout), permission-first refresh on return, resident pinned-text refresh,
current offline search and explicit guarded “Reload to update.” Two freshness defects
found in browser testing are repaired: first wire snapshots import external Markdown
before returning a stale sidecar; search revisions include contentHash rather than only
ACL identity. Integrate the matching server and frontend together.

Return refresh retains the current editor/Y.Doc and workspace. Background pin readers
announce no presence. No offline media, whole-vault body downloads, closed-app periodic
refresh, push service or third-party call is introduced. Opened unpinned bodies refresh
when opened again; there is no sweep of every cached body. No schema/WASM codec revision.

## Verification and review

Focused results and exact logs: ignored `local/pwa-evidence/README.md` in this checkout.
Frontend focused suite, desktop/mobile install/return/update specs, existing offline and
branding regressions, typecheck/tokens, targeted Rust sync/WebSocket/HTTP/leak checks and
semantic red/green or compiling mutation proofs are recorded there. Browser specs run
individually after rebuilds, one worker, zero retries. Existing offline spec has two
intentional mobile exclusions; no new skipped PWA cases.

Author specification/security review precedes author quality review; reports are in the
same evidence directory. No independent approval or Paul acceptance is claimed.
Next: review the candidate, combine with the separately owned vault/editor branches,
then validate on the intended origin and devices before release. Do not transplant a new
frontend alone and claim the server freshness fixes are present.

Not run/confirmed: full `make check`, coverage, full user-run manual `make e2e`, actual
Android install/native activation, macOS Chrome, external Cloudflare Access expiry, or
physical-device performance. Full gates are deferred under AGENTS §5, not waived.
Optimized bundle budget remains an inherited failure, not rerun or relaxed here. No
speedup or Android performance claim; production build's existing large-chunk warning
remains. Existing browser-profile storage/eviction and offline-revocation limits remain.

Update behavior: a chosen online reload obtains the current app; its waiting worker does
not force takeover while older controlled windows remain. The offline build adopts the
worker after those windows close. Never delete replicas or clear storage to update.

## Reproducing focused checks

Dependencies are private copies under this checkout, not symlinks to a concurrently
edited node_modules. The matching debug CLI is target/debug/memberberry. Existing cached
WASM is schema 3; do not downgrade schema admission or regenerate codec types by hand.

- `npm --prefix web run typecheck`
- `python3 scripts/token-check.py` (host lacks make; this is make token-check's command).
- `npm --prefix web test -- src/pwa src/offline src/shell/WorkspaceRefresh.dom.test.ts src/shell/TopBar.dom.test.ts src/shell/bootstrap.test.ts src/shell/workspace-sync.test.ts src/shell/workspace-offline.test.ts src/shell/session.test.ts src/shell/note-catalog.test.ts src/editor/sync.test.ts src/editor/collaboration.test.ts --maxWorkers=1`
- Before EACH browser spec: `npm --prefix web run build`, then
  `MEMBERBERRY_E2E_PORT=9016 npm --prefix web run e2e -- --config playwright.pwa.config.ts <name>.spec.ts --workers=1`.
  Names: pwa-install, pwa-refresh, pwa-update, offline, branding. Run separately, no retries.
- Rust helper: `python3 local/pwa-evidence/run-rust.py test --offline -p mb-server --test sync`.
  It uses the existing local Docker image, private target/tmp/cache, copied stable toolchain,
  read-only registry volume, network none, one CPU/4GiB. Do not overlap builders/fixtures.

Default Playwright context is incognito and cannot establish installability; the install
spec uses a disposable persistent full-Chromium profile and requires zero diagnostic
errors. The bundled headless shell crashed once before page creation; use the dedicated
full-Chromium config, never suppress an installability error. Headless tab switching did
not reliably emit OS focus; refresh specs explicitly dispatch focus while exercising real
HTTP/WebSocket/IndexedDB. Native application activation therefore remains a device check.
Rust 1.90 fails an existing yrs dependency; installed stable toolchain is required.

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
