# Handoff

**Updated:** 2026-10-07 — editor keyboard and document-link fixes.

## Current state / next

Five editor fixes have passed focused verification and user acceptance in an isolated preview. The next delivery step is the exact-head automatic CI check on the pull request, followed by Jakub's review. The changes are not merged upstream. The separately running Memberberry instance needs its current frontend preserved when these editor fixes are integrated; this branch alone does not contain its other unmerged UI work.

## Delivered in this branch

- Enter starts a sibling bullet, while Enter on an empty bullet leaves the list. Tab nests a bullet below the previous sibling; Shift-Tab outdents. Other controls retain normal Tab behavior.
- Paired single backticks typed in an ordinary paragraph create an inline `code` mark; unmatched/escaped backticks and code blocks stay literal. See `SPEC.md` §8.4.
- Yjs undo/redo survives ProseMirror plugin-view reconfiguration. The undo manager is retained for the Y.Doc lifetime, while per-view selection listeners detach when views rebuild. A late plugin registration previously destroyed the manager and left the shortcut with an empty stack.
- Selecting a `[[` suggestion inserts an ordinary Markdown link with a human-readable path, for example `[Roadmap](Projects/Roadmap.md)`. Aliases, anchors and following text are preserved; manually written wikilinks and embeds still work. See `SPEC.md` §8.2.

No note content moves out of Markdown, and no new endpoint, dependency, permission enforcement point, or wire/schema format is added. The chooser continues using the existing server-filtered catalog.

## Verification and limits

- Focused DOM suites: 78/78 across editor input, autocomplete, undo, commands, document links, note editor and collaboration. New behavioral tests were observed red when their corresponding behavior was disabled, then green when restored.
- Rebuilt production frontend and ran focused desktop/mobile browser tests: undo (2/2), keyboard/inline code (2/2) and autocomplete navigation with saved canonical Markdown and reload (2/2). TypeScript/Svelte typecheck passed with zero errors/warnings; `make wasm` and production web build passed.
- The single-worker jsdom keystroke benchmark runs, but its high variance cannot establish the SPEC §21 real-device performance budget.
- Full automatic CI (`check`, `web`, `perf`, `fuzz-build`) is pending on the exact PR head. Local `make check` should be reported with actual results; do not substitute focused tests for it. Full `make e2e` remains user-run/manually dispatched, not an automatic push/PR gate. The user has accepted the five behaviors in an isolated preview; this does not constitute a full E2E suite pass.
- The older `sync registry lock poisoned` panic remains unresolved. No broader concurrent/remote undo browser tests were added. Existing performance-budget exceptions and dependency-audit findings are not claimed fixed here.
- Previously reported server tests `onboarding_failed_config_write_removes_the_unpublished_vault_and_allows_retry` and `unreadable_vault_shows_recovery_guidance_only_to_its_member` were not newly investigated here; the exact-head CI check must resolve whether they pass now. Existing false-conflict callouts are not removed automatically; real-browser cross-tab cap eviction is still not covered by this editor change.

## Running locally

Use `make dev` for the complete development application on port 9011 (server on 9010); production build/serve is `make prod` on 9010. Disposable focused Playwright tests use 9012 and require a fresh `npm --prefix web run build` first. Run one spec at a time; avoid competing suites against the shared fixture vault. Consult `AGENTS.md` §5 for test cadence and explicit full-run rules. Offline replicas must not be cleared as a workaround for sync issues.

## Carried-forward limits

The following were open before this branch and remain outside these editor fixes; durable contracts live in `SPEC.md`:

- Tables: no offscreen drag autoscroll, no simultaneous multi-client table browser coverage, and no column deletion/resizing or headerless formats.
- Inbox/Tasks: source-editor edits, stale ordinal protection, but no filtered offline query, live refresh, remembered filters or timezone-aware task dates.
- Creation: no folder-row create action/template picker; creation is not audited. Unlinked mentions remain capped, without conversion or live refresh.
- Offline pins/bodies: cap configuration, teardown sizing, cross-pane eviction and reconnect coverage remain limited; an open IndexedDB connection can block body deletion. Pins are device-local.
- Shell/PWA: reconnect delays, shared precache, upgrade/two-build behavior, offline styling, file drops and broader tablet/mobile gestures need further validation. Close app tabs/windows and reopen for service worker updates, without deleting site data.
- Graphs: not persistent tabs; live refresh, large-graph usability, crowded pointer targets, overlapping labels, ghost interaction and rename/delete refresh remain limited.
- Rename/folder moves: clients/bookmarks may retain stale paths; partial writes are not rolled back, and concurrent rename, large-vault cost and frontmatter rewrite remain open.
- Outline/tags: drag/undo and cross-pane coverage remain limited, and tags do not live-poll. Transclusion does not live-refresh and mobile controls can overlap its last line.
- Index/backlinks/compression and task date chips: active-vault indexing costs, compressed HTTP client checks, browser long-press and date-picker reliability need further work.
