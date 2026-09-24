# Handoff

**Last updated:** Search result rendering, 2026-09-24.

## Current work

Fixed disappearing search results when the server returns multiple matching blocks from
one note. `SearchPane.svelte` keyed results by note path, which is not unique for block
matches. The regression reproduced an empty result list and Svelte's `each_key_duplicate`
error before the fix. Rendering now retains every returned block, including identical
contexts, in server order; SPEC §14.3 makes that contract explicit.

Focused unit/DOM verification passes (7 tests), including successive queries, repeated
paths and contexts, opening each result, and existing denied/offline search behavior.
The frontend build and TypeScript/Svelte checks pass. The focused browser regression
creates a real multi-block Fedora note and searches `fe`, `fed`, `fedora`, then `fe`.
All four focused browser tests pass on desktop/mobile after rebuilding. The initial
sandbox run could not bind port 9012; execution with socket permission succeeded. The new
test uses isolated vaults because broad `fe` matches in the shared fixture hit the server's
100-result cap and excluded the test note before it reached the UI.
Full `make check` and local coverage are deferred; full E2E is pending manual validation.
Next: deploy the rebuilt frontend and confirm the friend's affected note renders correctly.

## Unresolved sync panic

The user reports creation/editing works again after restart guidance. Their earlier
undownloaded-note placeholder accompanied `memberberry maintenance: sync registry lock
poisoned`: an earlier Rust panic blocked subscriptions and maintenance. The original panic
log is gone, so its cause is not fixed. If it recurs, capture the first panic using
`RUST_BACKTRACE=1 make dev` (stop the old dev process first). Do not clear poison or browser
replicas to work around it. The in-app browser bridge was unavailable; disposable browser
tests do not establish a fix for that server panic. Immediate-typing creation regressions
for sidebar, palette and empty vault passed on both viewports before this folder change.

Earlier focused `create.spec.ts` result: 10 passed, 2 failed. Both failures are the existing vault-home
navigation test waiting for the exact treeitem name `Projects`; folder move controls now
contribute to that accessible name. This selector failure is outside the editing diagnosis
and remains unfixed. The rebuilt frontend passed TypeScript compilation. Full checks and
coverage are deferred; full E2E remains pending manual validation. The table implementation
is committed as `6d52240`; the reported server panic remains a separate unresolved issue.

## Table baseline

The editor has a Table button, an editable header above every column, contextual row/column insertion,
mouse/touch row dragging and keyboard-accessible Row up/down actions. Cell line breaks now
use `<br>` within plain Markdown pipe rows; the CRDT schema is unchanged. Details and scope
are in SPEC §4.4.

Enter and Shift+Enter insert line breaks inside the selected cell, including empty cells.
Backspace in an empty non-first cell now moves to the end of its left neighbor. In the
first cell it is inert if another cell has content, and deletes a wholly empty body row.
Deleting the last body row now removes the entire table and leaves a blank paragraph with
the caret ready to type; row-menu deletion and empty-row Backspace use the same behavior.
Table creation focuses synchronously, and clicking an empty cell explicitly positions
the caret there. Browser verification caught empty-cell typing landing in the header;
both focus and empty-cell selection regressions were observed failing before correction.
Cmd+Enter / Ctrl+Enter now adds a full row below and focuses its first cell. The shortcut
test failed before implementation; browser coverage saves and reloads its new row.
Leading and repeated empty lines survive Markdown persistence and reload. Bare break tags
are recognized only within cells; other HTML remains literal. Backspace still deletes a
wholly empty body row at its first cell, without joining rows. Column widths remain stable;
the row grip opens insertion/deletion actions and header editing targets the selected column.

Focused verification: 75 DOM/unit/property tests pass across tables, editor shell, commands
and exports. The table browser spec verifies creation, header editing, expansion, row
buttons, native desktop dragging, touch dragging, disk Markdown and reload on both
viewports; all six rebuilt browser tests passed, including multiline-cell disk persistence.
133 core tests passed across Markdown, HTML, round-trip properties and table breaks.
Core Clippy, WASM build, typechecking and the diff whitespace check passed.
The native-drag pointer-cancellation regression was observed red before its fix; header
focus was also observed red before correction. A 100-row typing benchmark was run with
and without controls in laptop jsdom, alongside 100-row multiline normalization through
WASM; these do not establish physical-phone budgets.
Full `make check`, local coverage and device performance checks remain deferred; full
`make e2e` remains pending user-run manual validation. Broader known failures remain below.

Next: user validation in the deployed app. This change is not deployed. Rebuild the
Compose image and recreate the container after transferring changes. Rebuild both frontend
WASM and server: both need the updated Markdown parser/serializer for cell line breaks.

Open for this slice: no drag auto-scroll for offscreen rows; use Row up/down for those.
No simultaneous multi-client table-edit browser test was added. Column deletion and manual
column resizing remain outside scope. Headerless tables need a separate format decision.

## Other unresolved verification

- The watcher CPU-loop fix passed seven watcher integration tests, formatting and focused
  Clippy. A real two-vault release deployment under one CPU/1 GiB was healthy during the
  recorded idle measurement. The wider server run had 175 passes and two unrelated failures:
  `onboarding_failed_config_write_removes_the_unpublished_vault_and_allows_retry` and
  `unreadable_vault_shows_recovery_guidance_only_to_its_member`; both reproduced on clean
  `origin/main`. They remain open, outside branding scope.
- Latest supplied Linux CI evidence still has Chromium headless-shell 1234 crashes.
  A previous run recorded 31 failures, 40 skips, 241 passes and 31 browser SIGSEGV exits.
  Mac focused passes do not establish a Linux fix. Full E2E is manually dispatched through
  `E2E (manual)`, not an automatic push/PR gate.
- Runtime perf can time out waiting for a visible, editable editor during mobile cold start.
  Diagnostic logging is implemented; obtain a failing CI artifact to identify the gate.
  Local report-only completion does not prove budgets pass. Mobile quick-switcher sampling
  and recorded budget breaches remain unresolved.
- Emoji picker loading no longer blocks editor startup. Its focused browser/unit checks
  passed, but this does not resolve every cause of the CI perf timeout.
- These items are carried forward rather than investigated as part of folder dragging.

## Local operation

Use `make dev` (http://127.0.0.1:9011) or `make prod` (9010).
Server state uses the platform application-data directory; on this Mac that is
`~/Library/Application Support/memberberry`. Existing vaults stay at their configured paths.
Container provisioning and backups are in `docs/DEPLOYMENT.md` and `docs/BACKUP.md`.

Focused browser verification rebuilds first:
`npm --prefix web run build && npm --prefix web run e2e -- search.spec.ts --workers 2`.
Also rebuild `cargo build -p mb-cli` after server changes. Browser tests use
disposable vaults on 9012; the sandbox requires escalation for localhost sockets/Chromium.
Avoid concurrent WASM builds from the dev supervisor and test setup.
New feedback belongs in the gitignored `local/debug/` directory.

## Open items

### From the container deployment

- The user reports the Compose deployment is running on their server. Docker is unavailable
  in this workspace, so application updates still need an image rebuild and rollout there.
- **The backup wrapper intentionally causes downtime.** A coordinated offline snapshot is safer
  than independently copying SQLite, CRDT, and MinIO while they are being written.
- **Retention and backup encryption remain operator responsibilities.** The job never deletes an
  older backup and the archives contain plaintext content and credentials.

### From the JavaScript dependency audit

- **`npm install` currently reports 13 advisories: 1 low, 10 moderate, and 2 high.** No dependency
  changed in this workflow slice. The sandbox correctly refused `npm audit` because it would send
  the private dependency manifest to an external advisory service, so whether those findings are
  production-reachable remains unclassified and must be reviewed before a public release.

Written down so they are not rediscovered as surprises. None blocks a milestone.

### From the inbox pane (§10.3)

- **Inbox edits use the live editor after the source note is opened.** A stale index ordinal
  is inert if the source has changed before the editor applies it.
- **Filtered offline inbox queries are unavailable.** The replicated task rows support the
  unfiltered inbox; tags and server-side query filters are not replicated.
- **The inbox does not refresh while open.** Same shape as tags / backlinks / graph: the
  watcher tells the server, not the browser. Completing a task in the editor leaves the inbox
  stale until a filter change or remount.
- **Filters are not remembered.** Closing the sidebar forgets them; nothing in the URL shares
  a filtered view.
- **"This week" follows the client's local calendar date** and ISO week boundaries. A traveller
  near midnight UTC can disagree with another device about overdue vs today; due dates have no
  timezone by design (§10.1).

### From note creation (§6.10)

- **The Notes-header New note action creates at the root.** There is still no "new note here"
  on a folder row; type a folder-relative path in the dialog instead.
- **The vault index form always creates at the vault root.**
- **General note creation offers no template picker.** M13 adds calendar-note templates and
  explicit template insertion, but the ordinary “New note…” prompt still creates a heading.
- **The tree updates on the next catalog refresh**, exactly like the conflict badge.
- **A creation is not audited**, argued in §6.10.

### From unlinked mentions (§9.5)

- **A common word is a useless section, and nothing mitigates it.**
- **The 50-block cap is silent.**
- **A mention cannot be turned into a link.**
- **The matched text is not highlighted in the sentence.**
- **A mention is not refreshed while the note is open.**
- **`unlinked_mentions` is two SQLite queries plus a Tantivy query per note opened.**
- **Nothing tests a mention of a note with no title and no aliases.**
- **A note that mentions itself in a different block is still excluded.**

### From the resident-body cap (M6)

- **The caps are not configurable**, and §7.2 says they should be.
- **Nothing has evicted anything in a browser.**
- **A note evicted while open is not re-recorded as resident.**
- **The size is measured on teardown only.**
- **Eviction is per vault, and only the vault in front.**

### From the pinned tier (M6)

- **A pin cannot be set on a note that is not open.**
- **Folders cannot be pinned**, and §7.2 asks for them.
- **The sweep runs once, at startup.**
- **Nothing shows which notes are pinned** except the wording of the command.
- **The sweep opens a socket per note, sequentially.**
- **A pin is per device and never synced.**

### From the replication work (M6)

- **The metadata replica is refreshed only when something asks for the note list.**
- **Reconciliation is per vault, and only the vault the page is showing.**
- **A body is dropped by deleting its database, and that can be refused.**
- **`isResident` reads every resident record for the vault to answer one question.**
- **The "body not downloaded" state cannot show a snippet** from §14.2 yet in that UI.
- **Nothing tests two panes over the same undownloaded note.**

### From the application shell (M6)

- **The pending count is per open note, not per workspace.**
- **A reconnection can wait up to thirty seconds** when the browser never fires `online`.
- **Nothing tests two panes over one note reconnecting together.**
- **A `read_only` refusal is still silent on reconnect.**
- **The offline page declares no colour at all.**
- **A second user on one browser profile shares the precache** and the remembered display name.
- **Nothing tests two builds in one browser.**
- **The worker never calls `skipWaiting`.**
- **`/app.html` is served to anyone.**
- **The latest mobile quick-switcher run had zero surviving samples.**

### From the global graph

- **It is not a tab, so it does not survive a reload and cannot sit beside a note.**
- **The picture does not refresh while it is on screen.**
- **The filters are not remembered.**
- **The mobile cap is decided when the graph is first opened.**
- **`preserveDrawingBuffer` is on, and nothing has measured what it costs.**
- **Nothing tests two graphs at once.**
- **A node cannot be dragged.**
- **The label pass scans every node per frame.**
- **The E2E fixture vault is small.**
- **`readVaultGraph` reads whole triples only.**
- **Nothing asserts that the hit test's pruning prunes.**

### From the local graph

- **A node's tap target does not meet §8.3's 44px floor on a crowded ring, and cannot.**
- **The picture does not refresh while it is on screen.**
- **Nothing tests the panel against a graph at the cap.**
- **Labels are not elided and can overlap.**
- **A ghost is selectable and does nothing when activated.**
- **Two notes with the same title are two dots with the same label.**
- **The `hops` query parameter is refused rather than clamped when it is not a number.**
- **Renaming or deleting a note does not update an open graph.**
- **`graph.proptest-regressions` was deleted rather than committed.**

### From the rename work

- Folder moves also leave saved bookmarks unchanged. Hidden files, non-Markdown files and
  symlinks inside source folders are refused. Partial sidecar/link writes after the directory
  move are not rolled back; concurrent filesystem changes retain rename's existing limits.
- **A client with the note open is not told it moved.**
- **A failure part-way through the writes leaves the note moved and some links stale.**
- **The refusal for an unsafe rewrite cannot name the note.**
- **A note whose rewrite would change something else is refused, and so is the whole rename.**
- **The tag rename does not touch a `tags: ["#project"]` in frontmatter.**
- **The reindex *after* a rename fails quietly.**
- **Renaming is O(vault) twice.**
- **Nothing tests two renames racing each other.**

### From the outline pane

- **The drag has no browser test; the keyboard equivalent does.**
- **A reorder is not undoable as one step from the outline.**
- **Nothing tests two panes showing the same note.**
- **The outline is announced on every document change, whole.**
- **The active section is measured from the scroller**, so a short note never highlights
  below the first heading.

### From the tag pane

- **The `JOIN v_notes` in `Reader::tagged` is defence in depth.**
- **The tag tree refreshes on opening Tags and after a rename, but does not poll while open.**
- **The pane shows every tag, with no cap.**
- **Selecting a tag lists notes; it does not search.** The text index can answer `tag:` now.
- **Nothing tests the pane against a tag whose name needs escaping.**

### From the transclusion work

- **The repository read in `resolve_reference` is defence in depth.**
- **The unavailable placeholder cannot name the reference.**
- **A missing embed target logs a 404 in the browser console.**
- **On a phone the editor's control strip overlays the last line of a note.**
- **Nothing tests two embeds of the same note on one page.**
- **The embed bar adds two tab stops per embed.**
- **An embed does not follow an edit to the target while it is on screen.**

### From the index and backlinks work

- **The readable-set filters are individually sufficient**, held by the structural scan.
- **The unit suite stayed green with the backlinks panel at `display: none`.**
- **`%2F` in the note path routes exactly as `/` does.**
- **Nothing tests the index against a vault being written *while* it indexes.**
- **The index holds rows nothing reads yet** — `blocks`, `media_refs` (tasks now have a query).
- **`Reader` resolves the readable set per reader, with no cache.**
- **A `304` still cannot happen.**

### From the compression work

- **The WebSocket upgrade does not depend on any guard in `compress.rs`.**
- **The Rust HTTP test client sends no `Accept-Encoding`.**

### From the task and control-strip work

- **A chip for `created`, `done`, or a §10.4 preserved marker does nothing when clicked.**
- **`showPicker()` is best-effort.**
- **The mobile long-press block menu has a unit test but no E2E.**
- **Only `bullet_list`/`ordered_list` children get the task node view.**

### Carried from earlier

- **The audit log stamps Unix seconds, not RFC 3339.**
- **A viewer is served the full editor** and only learns they are read-only when a frame comes
  back `read_only`.
- **Only Chromium is installed for E2E.**
- **No tablet E2E project.**
- **Back/forward are buttons on mobile, not gestures.**
- **Unknown component props are not type-checked.**
- **A stray file drop is unguarded.**
- **The URL does not follow the active tab.**
- **Performance budgets remain over**, recorded in `web/perf/breaches.json`.
- **The untried bundle levers are in §21.1.**
- **`make check` does not open a browser.**

**Known absent:** the address bar following the active tab. Note deletion and restoration
are available under Context → Deleted notes.
