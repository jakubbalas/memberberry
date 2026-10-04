# Handoff

**Updated:** 2026-10-03 — PR #2 CI test corrections.

## Current state / next step

Branch: `fix/local-navigation-sync-links`, published as upstream PR #2.
Paul tested the deployed application changes and authorized the PR. This correction aligns
three stale test assertions with the documented behavior and adds explicit unaliased-link
and missing-folder regressions. No production code or behavior changes in this correction.

All three original failures were reproduced locally before repair. Focused regression and
negative mutation checks passed after repair. Independent specification and code-quality
reviews both passed. Full CI verification is pending. Require fresh `check`, `web`, `perf` and
`fuzz-build` success on the corrected PR head before declaring this ready to merge.
Jakub retains upstream review/merge ownership. The newer Tasks-tab/completed-task follow-up
is separate and must not be released until this corrected PR is merged. The running app
is unchanged by these test corrections.

Machine-specific Compose mounts, networks and resource limits remain local and are not part
of the PR. Private rollout manifests, snapshots, deployment notes and debug material remain
under gitignored `local/`; they must not be staged. Local deployment instructions are saved
in `local/deployment-handoff-before-pr.md` on the operator's checkout.

## Included changes

- **Navigation and folders:** authorized empty-folder discovery, including path-only grants;
  denied subtrees are pruned before filesystem reads. Folder menus open a temporary main-panel
  contents view. Desktop sidebar widths are pointer/keyboard resizable and remembered per
  user/vault/device; filenames can replace headings. Catalogs refresh on browser resume and
  reconnect, with coalescing, listener cleanup and denial-safe response ordering.
- **Sync and offline safety:** pending edits await the durable server echo, not a socket send.
  Failed final Markdown flushes retain their coordinator for retry. One-sided reconnects do
  not invent conflicts from stale Markdown bases. Residency/dirty-state updates are atomic;
  permission reconciliation invalidates pending editor sessions before they can recreate
  revoked metadata or bodies.
- **Document links:** Markdown links and wikilinks activate through authorized resolution,
  preserving tab/split intent and heading/block anchors. Transclusions resolve relative to
  their source. Unsafe schemes remain inert, with sanitized links explicitly disabled.
  `[[` offers keyboard/pointer document lookup from the readable catalog.
- **Tasks and mobile:** immutable scroll updates no longer replay task commands. Native
  scrolling/cancellation does not activate checkboxes or metadata chips. Initial source
  edits wait for authorized sync; stale/denied actions remain rejected across remounts and
  duplicate panes. Completion-only inbox checkboxes cannot undo already-completed tasks.
- **Presentation:** mobile-only full-width drawers, zero sidebar-body top padding, a main-panel
  Tasks option, leading task checkboxes, sticky Tasks headings, independent filename/path
  preferences and three-dot menus. File/bookmark menus preserve right-click/keyboard actions;
  favorites live in the menus. Menu opener focus is restored reliably.
- **Packaging:** `local/` is excluded from Docker contexts and enforced by deployment checks.
  No dependencies or wire/schema formats were added. Behavioral contracts are in `SPEC.md`.

Independent specification and code-quality reviews were completed for the implementation;
the final task/menu review approved after all reported blockers were fixed. Those source
reviews do not substitute for the runtime verification below.

## Verification

Fresh focused precommit checks on 2026-10-03:

- **548 frontend unit/DOM/property tests across 26 files passed**, covering all new/modified
  frontend test files plus task metadata.
- Rust HTML rendering **44 passed**; server sync **20 passed**; focused empty-folder repository
  **2 passed**, folder HTTP **2 passed**, E28 leak **3 passed**, and E18 task leak **1 passed**.
- TypeScript/Svelte **0 errors, 0 warnings**; token contract, deployment/backup contract and
  whitespace checks passed. Precommit log remains local at `local/precommit-focused.log`.

Focused browser checks performed during implementation, with a rebuilt frontend and serial
spec execution: task-display **4**, task-scroll **4**, navigation-improvements **10**,
bookmarks **2**, inbox **5**, and workspace bookmark regression **1** passed. Earlier focused
autosave, document-link and creation checks also passed. Existing viewport-only exclusions
are unchanged; no new skips were added. These are focused runs, **not full E2E**.

Native mobile swipes and desktop wheel scrolling caused zero task DOM mutations and zero
document-changing transactions; deliberate taps, text editing and keyboard completion
remained functional. Repeated inbox completion preserves canonical server Markdown. Autosave
checks use canonical Markdown and a separately authenticated browser, not just a reload of
the same IndexedDB replica. Browser checks exercise real sticky geometry, breakpoint widths,
menu parity, bookmark persistence and deferred source edits.

The final production frontend build passed before deployment. Runtime file hashes, entry
assets, service worker, manifest, health and anonymous denial were checked on the running
instance. Existing vault Markdown and deployment configuration were preserved. A fresh
private backup and rollback image were retained. The login page and scratch editor loaded
without JavaScript errors. Paul subsequently confirmed the deployed changes work; this is
user acceptance feedback, not a claim that the full browser suite or performance gate ran.

**CI correction verification:** the three original failures were reproduced in the isolated
PR worktree. The corrected note-editor file passes all 6 tests; the script-injection,
malformed-rename and missing-folder HTTP regressions each pass. Eight temporary negative
mutation probes failed as intended; sources were restored and focused tests rerun green.
The exact GitHub CI jobs, including Rust/frontend coverage floors, are required for this
correction and are not yet established. Full local frontend verification passed: **1,862
tests across 130 files**, typecheck with zero errors/warnings, and the coverage gate
(editor 87.63%, shell 93.51%, other 94.68%). The complete server HTTP suite passed
**179 tests**, as did workspace formatting and the token contract. Full-test orchestration,
WASM-cache and manual E2E workflow regressions passed. The local coverage-helper regression could not run: the
development container lacks `cargo-llvm-cov` and places temporary test crates inside the
parent workspace. The GitHub workflow installs the coverage tool and remains authoritative.
Full manual `make e2e` is separate and remains user-run unless explicitly requested. Existing
performance breaches remain open; host/jsdom microbenchmarks are not physical Android FPS.
Two focused suites still emit the pre-existing ProseMirror `TextSelection` startup warning
when a heading precedes a list. Existing third-party directive/large-chunk build warnings
remain. Known unrelated failures below have not been silently counted as passing.

## Local development

- `make dev`: complete development app on 9011; server on 9010. Disposable E2E uses 9012.
- Rebuild before each focused browser run:
  `npm --prefix web run build && npm --prefix web run e2e -- <name>.spec.ts`.
- Use the repository's stable Rust toolchain; the old Rust 1.90 compiler is insufficient for
  the current `yrs` dependency. Do not downgrade the dependency as a workaround.
- The resource-limited local development container has Node, stable Rust, wasm-pack and full
  Chromium. Host headless-shell crashes were reproduced; local full-Chromium verification
  does not establish that the historical CI issue is fixed.
- Serialize browser specs; their disposable fixture is shared. `make wasm` creates no-opt
  development WASM; production bundle-budget measurements require `make wasm-ci`.
- Never delete vault state or browser replicas to update the UI. Close all application tabs
  and installed-app windows, then reopen so the updated service worker can activate.

## Open safety / verification items

- Historical `sync registry lock poisoned` panic remains **unreproduced and unfixed**. The
  original panic log is missing. Capture the first panic/backtrace if it recurs; do not clear
  poison or delete replicas. Passing new autosave tests does not establish that panic's cause.
- Existing false-conflict callouts are not automatically removed; inspect/resolve the note.
- Real-browser cap eviction and broader simultaneous cross-tab eviction remain unverified.
  Browser dirty-state checks pass; they do not by themselves exercise cap eviction.
- Prior unrelated server failures remain unverified:
  `onboarding_failed_config_write_removes_the_unpublished_vault_and_allows_retry` and
  `unreadable_vault_shows_recovery_guidance_only_to_its_member` (previously reproduced on main).
- Historical Linux Chromium crashes and mobile cold-start/quick-switcher performance failures
  remain open. `web/perf/breaches.json` records existing budget breaches. Laptop/jsdom
  microbenchmarks are not Android/input-to-paint evidence.
- Previous dependency audit reported 13 advisories (1 low, 10 moderate, 2 high). No dependency
  change here; those counts were not refreshed and production reachability is unclassified.

## Carried-forward feature limits (not expanded in this patch)

These remain outside this request; durable contracts are in SPEC, not this handoff.

- Tables: no offscreen drag autoscroll (use Row up/down); simultaneous multi-client table
  editing lacks browser coverage. Column deletion/resizing and headerless formats are separate scope.
- Inbox: edits apply through the source editor; stale ordinals are inert. No filtered offline
  query, live refresh, remembered filters or timezone-aware task dates.
- Creation: no folder-row create action/template picker; vault-home creation is root-level.
  Workspace creation uses the selected folder. Creation is not audited (§6.10).
- Unlinked mentions: silent 50-block cap, no conversion/highlight/live refresh; query cost and
  untitled/self-mention edge cases remain as previously documented.
- Offline bodies/pins: caps not configurable; size measured on teardown; eviction/reconciliation
  are per visible vault; open-body eviction re-recording and cross-pane reconnect coverage remain
  limited. No folder pins or pinning unopened notes, no pinned indicator beyond command wording;
  initial sweep fetches sequentially. Body deletion may be refused by an open IndexedDB connection.
  `isResident` scans records; undownloaded UI lacks snippet; pins are device-local.
- Shell/PWA: pending count per note, reconnect delay up to 30 seconds absent online event;
  viewer learns read-only on server refusal. Shared precache/display name across users of one
  browser profile, upgrade/two-build coverage, no skipWaiting, offline styling, unguarded file
  drops, broader mobile gestures and tablet coverage remain separate work.
- Global/local graphs: not persistent tabs, no live update/remembered filters, limited large-graph
  and multi-pane coverage. Global nodes cannot be dragged; preserveDrawingBuffer cost unmeasured.
  Local labels overlap, crowded targets miss 44px, ghosts inert, duplicate titles indistinguishable;
  graph rename/delete refresh and pruning evidence remain open.
- Rename/folder move: bookmarks and other open clients are not updated; partial link/sidecar
  writes are not rolled back; hidden/non-Markdown/symlink children refused. Unsafe rewrite errors
  cannot reveal hidden notes; frontmatter tag rewrite, reindex failures, O(vault) cost and concurrent
  rename coverage remain open.
- Outline/tags: drag browser coverage/undo grouping and cross-pane coverage limited; outline
  announcements broad and first short section may not activate. Tags do not poll, cap or search
  when selected; unusual tag-name browser coverage remains open.
- Transclusion: unavailable placeholders cannot name hidden targets; missing targets log 404;
  embedded content does not live-refresh. Mobile control-strip overlap, extra tab stops and
  repeated-embed coverage remain separate work.
- Index/backlinks/compression: active-vault indexing concurrency and metadata-query costs remain;
  backlinks visibility previously escaped unit coverage, no conditional 304, no compressed HTTP
  client coverage. Task date-chip activation, showPicker reliability and mobile long-press browser
  coverage remain limited. Audit timestamps are Unix seconds, not RFC3339.
