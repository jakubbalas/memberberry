# Handoff

**Last updated:** CI failure follow-up, 2026-09-15.

The default server data directory now follows the host platform instead of living beside
the checkout: macOS uses `~/Library/Application Support/memberberry`, Linux uses
`$XDG_DATA_HOME/memberberry` or `~/.local/share/memberberry`, and Windows uses
`%APPDATA%/memberberry`. The existing macOS `server.toml`, `auth.db`, `audit.log`, and
`bookmarks/` state were moved there; the repository root no longer owns those files.

The media E2E assertion now matches the specified 2560px default. Concurrent identical media
uploads use unique staging filenames, and an uploader may edit a freshly uploaded source
before the index catches up because its temporary upload grant authorizes that operation.
Focused server, media, and mentions checks pass; the reported full-suite Mac result was not
rerun after these fixes.

The media editor E2E save assertion allows up to 15 seconds for edited PNG encoding/upload,
which covers slower parallel runs without masking a failed save. Mobile Home and both media
projects pass locally; the full Arch suite still needs confirmation.

The web CI races now wait on observable state instead of fixed microtask counts. The image
editor is lazy-loaded, and CI uses `make wasm-ci` with a size-optimized release profile so
the critical bundle stays below the recorded ceiling. Focused web tests and bundle checks
pass locally; full `make check` and the complete E2E suite remain deferred.

Media handling now constrains editor images to the available column and the running server
prunes unreferenced media after the five-minute upload grant expires, preserving active grants
through the note-save/index cycle. Focused media/editor tests pass; the new browser regression
still needs the local server and Playwright E2E environment. Full `make check`, coverage, and
full E2E remain deferred.

CI frontend jobs now run `make wasm-ci`, which generates both the main and emoji WASM packages
with a size-optimized release profile; local development keeps the no-opt `make wasm` path.
The previous CI failure came from the missing emoji package, then from unoptimized WASM
exceeding the bundle ceiling. The latest focused web tests, optimized bundle check, Clippy,
server build with `-D warnings`, and media/home Playwright specs pass locally.

Image editing now has a selectable-image modal with derived-display resize, center crop
presets, rotation, brightness/contrast/saturation, and “Use original”. Save
uploads a new PNG display object and updates the Markdown reference only after success; the
retained original remains unchanged. Focused browser validation still requires the local
server and Playwright E2E environment.

Rendered media now loads the bounded display object directly instead of invoking server-side
thumbnail generation on every image render, removing avoidable decode/re-encode latency.
Image editor controls reset to their defaults on each open; saving without a new adjustment
now closes without uploading another display object. Preview zoom was removed because it did
not provide useful behavior.

Local media cleanup now removes empty fan-out directories after orphaned files are pruned,
including stale nested directories left by earlier uploads.

Home navigation now opens a selected note even when that note is already the active tab in
the restored hidden workspace. The regression is covered by the focused Workspace DOM suite;
typecheck, production build, and diff hygiene pass.

Removed the automatic pre-commit `make check` requirement from `AGENTS.md` and `SPEC.md`.
Full checks and local coverage measurement now require an explicit request; commit requests
continue with focused verification. CI and manual full E2E ownership are unchanged.
Development still automatically runs relevant test suites, including focused browser
verification for UI changes; those checks require no separate user request.
This documentation-only change was reviewed by diff; application checks were not run.

`PROJECT.md`, `SPEC.md`, and `README.md` now describe editing, navigation, keybindings,
graph links, page layouts, database views, and theming directly instead of using product
comparisons as design influences. Named Obsidian import and file-format compatibility
references remain. The edited A2 and A16 answers are explicitly marked as paraphrased;
feature scope, keybindings, import functionality, and decisions are unchanged.

The four documents were removed from all prior commits on `main` and the local
`first-working-baseline` tag, then restored together as cleaned files. All 61 rewritten
commits were checked to preserve every other file and directory exactly. The local recovery
bundle is `local/debug/history-before-scrub.bundle`; it intentionally retains the old history.
The user's original cleaned copies remain in `local/debug/`. Other clones should be freshly
cloned after publication rather than merging the old history back. Remote caches and other
copies are not erased by rewriting Git refs.

`make check` passes, including Rust tests, coverage floors, frontend tests, types and lint.
Log: `/tmp/memberberry-history-check.log`. Full E2E remains user-run and was not executed;
the platform failures below remain unresolved. Next: continue platform validation. Older
statements below calling prior fixes uncommitted are stale; those fixes are in the baseline.
The untracked root `bookmarks/` remains local user state.

The latest user runs on both Arch and macOS report 263 passed, 44 skipped and one mobile
bookmark failure, before removal on Arch and after reload on Mac. The Mac trace confirms
`isVisible()` returned false before the Show Navigation button mounted; the test skipped
opening the drawer, and its final snapshot still offered Show Navigation. Both test entry
points now use the known mobile project to click the button with Playwright's automatic
waiting. The final remaining-note assertion is strengthened from attached to visible.
The production frontend rebuild and both desktop/mobile bookmark cases pass (6.5 seconds,
two workers). Logs: `/tmp/memberberry-bookmarks-{build,e2e}.log`; original artifacts:
`local/debug/e2e-bookmarks-mobile-20260914/`. Full checks/E2E were not rerun, and Arch
confirmation is pending. This test fix is uncommitted. No application behavior changed.

The latest Mac run failed mobile light/dark theme comparisons because the expected editor
text captured a transient `alice` presence label from another test reading the same note;
the label was absent after reload. Each theme/viewport now gets its own notebook scratch
fixture, retaining the exact content-preservation assertion. The shared notebook remains
available to navigation tests. Frontend production build, all ten desktop/mobile theme
cases (two workers, 12.4 seconds), and diff hygiene pass. Logs are in
`/tmp/memberberry-theme-{build,e2e}.log`. Full checks and full E2E were not rerun.

The third reported failure, mobile topbar panels, was `browser.newContext` failing after
Chromium signal 11 `SEGV_ACCERR`, before the test body ran, matching the earlier outline
crash. No browser-crash fix has been established. Original artifacts were preserved under
`local/debug/e2e-mac-theme-topbar-20260914/`. Theme and earlier workspace shortcut fixes are
uncommitted. Arch mentions/graph details and full platform validation remain pending.

The user reports Arch E2E: 259 passed, 44 skipped, five failures (desktop mentions, three
desktop workspace split/resize/reload cases, mobile graph navigation). The three workspace
cases hard-coded Meta+backslash even though Linux binds Mod to Control. They now use
Playwright's ControlOrMeta. Production frontend rebuild and all three focused desktop
cases pass on this Mac (7.3 seconds, two workers); Arch confirmation remains pending.
The first local attempt was blocked by sandbox loopback binding; the permitted focused run
succeeded. No full gate or full E2E was run for this change. Fix remains uncommitted.

The user's Mac full run: 263 passed, 44 skipped, one mobile outline failure. Its saved
error context showed `browser.newContext` failing after Chromium received signal 11
`SEGV_ACCERR`, before the outline test body ran. The Crashpad numeric warning was secondary
crash output, not evidence of an outline assertion failure. The browser crash remains open.
Arch mentions and graph failure names alone do not identify causes; their detailed errors
or traces have been requested. Do not mark either platform fully green or relax these tests.

The user's Arch `make full-test` reached browser setup but failed because Playwright's
`--with-deps` fallback invoked missing `apt-get`. Local `make e2e` now downloads Chromium
without OS-package installation; README separates Debian/Ubuntu and Arch provisioning.
Existing Ubuntu CI still installs its system dependencies explicitly. Native libraries on
Arch remain a prerequisite, and the user's browser suite has not yet been confirmed to run.
The new regression failed on the old install command and now passes with the other two
orchestration tests. Diff hygiene passes. Full checks and E2E were not run for this change;
it is not yet committed or pushed. Next: run `make e2e` on Arch to resume after the build/check
stages, then use `make full-test` for subsequent complete runs.

`make full-test` builds WASM, runs `make check`, then runs `make e2e` sequentially, stopping
on any failure even when invoked with parallel Make. README and the workflow/spec documents
describe prerequisites and scope; soak, fuzzing and performance runs remain separate.
The orchestration regression uses a recording child-Make substitute, so it verifies phase
ordering and error propagation without launching application suites. It failed before the
target existed and now passes both tests; diff hygiene also passes. CI now runs it.
The combined suite itself was not requested to run and
has not been executed. Next: the user can run `make full-test` on Linux.

The user's Linux run reached the coverage gate after tests but reported `cargo-llvm-cov`
missing despite Cargo reporting it installed. The shell-only prerequisite lookup has a
reproduced false negative: Cargo finds subcommands in its home even without them on PATH.
Both coverage targets now check `$(CARGO) llvm-cov --version`. The regression executes the
actual prerequisite commands with empty PATH and an absolute Cargo path; both failed before
the change. README Development includes tool installation and version verification.
Linux confirmation is pending; the user's exact environment has not been inspected.
The focused prerequisite regression now passes for both targets, and diff hygiene passes.
Full checks/E2E were not run for that change; the prerequisite fix is now in the baseline.

The next Linux warning was `chunks_exact_to_as_chunks` in `mb-search/src/lib.rs`.
Digest parsing now uses `as_chunks::<2>()` and destructures byte pairs, preserving length
and hexadecimal validation. No other constant-sized `chunks_exact` calls were found in
the crates. Search Clippy on local 1.95, eight format tests, two codec property tests,
and diff hygiene pass. The search compatibility fix was committed and pushed as `885e271`.

The Linux checkpoint check stopped before tests on Clippy 1.98's `question_mark` lint in
`mb-core/src/canonical.rs`. Table canonicalization now propagates `None` with `?`, preserving
the existing behavior. This Mac has Rust/Clippy 1.95, so local verification cannot establish
that the complete workspace passes 1.98. The next Linux run must check for further warnings.
Focused verification passes: `cargo clippy -p mb-core --all-targets -- -D warnings`,
four Markdown table tests, all 11 round-trip property tests, and diff hygiene. Full
`make check` and E2E were not run. The earlier canonicalization fix is now committed in
`5cde5c8`; its remote publication was not verified here.

The user explicitly requested committing the current work without `make check` or E2E so
they can pull it on Linux. This is an unverified checkpoint, not a full-gate green. Only
diff hygiene was checked for this commit; earlier focused verification is recorded below.
Next: run `make check` and manually run `make e2e` on Linux, keeping the known browser
failures below visible. The untracked root `bookmarks/` directory is local user state and
is excluded from the checkpoint.

macOS startup investigation reproduced a 14.05-second delay before a freshly built test
printed anything, versus 0.004 seconds on reuse. Process sampling showed `_dyld_start`;
the exact executable's XProtect scan completion coincided with startup. Live logs later
confirmed scans for multiple suites and a further roughly seven-second Developer Tools
permission check, even though iTerm2 was granted access. No OS-level fix or Linux timing
has been verified. This explains why test harness durations understate local wall time.

`make coverage` and `make coverage-gate` now use `scripts/coverage-run.py`. Unchanged inputs
reuse a successful isolated coverage build, but every invocation clears profiles and runs
the tests again. Changed source/configuration/environment/tool versions/options or a prior
failure force workspace coverage cleanup. Concurrent helper runs share a lock. The first
run builds the new cache at `target/coverage-run/build`; subsequent unchanged runs reuse it.
Ordinary Rust tests and doctests remain in `make check`. Compilation progress is visible and
the gate consumes summary JSON with pipeline failure propagation. CI runs the reuse regression.

Focused validation: `python3 scripts/coverage-run-test.py` exercises real Rust compilation,
identical repeat coverage without binary modification, changed-source failures, recovery,
deleted source and renamed tests with changed compiler flags, and compilation failure.
Mutation probes proved the test fails on accumulated execution counts when profile cleanup
is skipped, and on deleted source appearing in coverage when input invalidation is disabled.
Full `make check`, workspace coverage measurement and full E2E are deferred; no UI changed.
Next: run the full gate on Linux and compare two unchanged runs. No end-to-end gate
speedup has been measured yet. Preserve the outstanding browser issues and local state below.

Commit workflow uses focused verification. Run `make check` only on explicit request;
full `make e2e` remains user-run unless explicitly delegated. Focused browser verification
during UI development and CI remain unchanged.

The user's seven reported failures included stale title/breadcrumb expectations and shared
fixture interference. Home now seeds isolated per-project vaults and checks exact root/nested
labels, absent duplicate filenames, the eight-row limit, and total count. Bookmark removal
also uses isolated per-project vaults so parallel tests cannot overwrite its saved list.
Keyboard navigation checks the note title and path tooltip; note-location coverage verifies
the tooltip and the intentionally absent breadcrumbs. Rename checks the new H1 in both the
editor and Markdown while retaining body and inbound-link assertions.

The saved mobile Escape failure occurred at browser-context creation, before the test ran.
Its unchanged dialog behavior passes focused verification; a full-load Chromium startup
problem has not been ruled out by these focused runs.

Rebuilt before each focused browser run, with two workers: Home 6 passed; bookmarks 2 passed;
workspace keyboard/path/Escape 3 passed with 3 existing viewport exclusions; rename 2 passed.
Logs: `/tmp/memberberry-{home,bookmarks,workspace,rename}-updated-e2e.log`.
No application behavior changed in this iteration. Full checks and coverage are deferred;
the user owns the next full `make e2e` run. No commit was created.

The last full `make check` passed (`/tmp/memberberry-final-check.log`). The earlier full
browser run also reported mobile offline fallback and presence-sensitive theme assertions;
those were not in the user's latest seven failures and were not changed or rerun here.
Do not treat focused passes as a full-suite green. Keep the untracked root `bookmarks/`
directory out of the commit: it is local user state, not source code.

Title protection was rejecting conflict insertion and ordinary edits in legacy notes without
a leading H1. It now protects only an existing leading H1. The conflict tests also mount the
real title-protection extension. Browser verification exposed a second issue: a remotely loaded
title was treated as a local edit, triggering a rename and disrupting sync. Remote transactions
now update the committed-title baseline; local edits still rename, and legacy body text does not.
Both new regressions failed before their fixes. All 1533 frontend tests, type checks, and
coverage floors pass through `make web-check`; all four desktop/mobile conflict browser tests
pass after rebuilding. Logs: `/tmp/memberberry-conflict-web-check.log` and
`/tmp/memberberry-conflict-e2e.log`.

Bookmark rows now have one leading star: a labelled removal button with a touch-sized target.
The redundant trailing star is gone; clicking the note name still navigates. The star uses
the existing bookmark toggle/save path without opening or deleting the note. The single-star
DOM regression failed before the adjustment; all 27 NoteTree DOM tests
pass. Focused desktop keyboard/mobile click browser tests verify removal, server persistence,
reload, and the note's continued presence. Production build, token-check, and diff check pass;
full gates and coverage remain deferred.

Home's Your notes list displays a muted `Folder/Subfolder / ` before the title when nested,
without a separate filename line. Root notes have no prefix, and missing titles use the
filename stem without duplicating folders. Five DOM cases pass, including nested paths,
title fallback, and opening the original path; folder cases failed before the change.
Production build, token-check, diff check, and focused desktop/mobile Home browser tests
pass. Desktop screenshot reviewed; full gates and coverage remain deferred.

README's Quickstart covers development and `make prod`, restart without rebuilding,
foreground operation, default and configurable storage, and preservation of existing vault
paths. Commands and paths were checked against the Makefile, CLI configuration resolution,
and browser vault creation code; documentation diff review only, with
application tests and full gates deferred for this documentation-only change.

Inline editor tags now use rounded accent-tinted backgrounds, bold accent text, and compact
padding from existing theme tokens. Light desktop and dark mobile screenshots were visually
reviewed. The focused badge browser regression failed on plain text before the change and
passes its styling assertions in both themes on desktop/mobile. The full tag browser spec
now passes following the sync-title fix above. The in-app browser bridge was
unavailable, so verification used the repository's Playwright runner.

The reported missing tag was reproduced in the user's actual `untitled 2.md`: the file
contained `\#hello`. Rich-text input lacked a tag conversion rule, so plain text was
correctly escaped by the serializer and never indexed as a tag. The editor now converts
space- or Enter-terminated hashtags through the Rust/WASM parser. Enter completes the tag
and splits the paragraph in one keypress, rather than inserting a space. The regression
failed before the fix; it now verifies both an empty next paragraph and preservation of
text after the cursor. The user's specific `hello` was
repaired in their vault; a read-only query confirms `untitled 2.md|hello` in the live index.
Other escaped text is deliberately untouched. New editor tests prove typing → CRDT →
Markdown → tag extraction, including nesting and literal/numeric negatives; removing the
rule makes all four positive cases fail. The Enter fix's 26 focused tag, command, schema,
and source tests and the production build pass. Desktop/mobile browser single-Enter,
next-paragraph typing, tag creation, endpoint, and visible-row assertions pass,
with the automatic-title-rename HTTP 400 addressed by the fix above; the full browser gate
remains outstanding.
The new tag parser microbenchmark runs with `cd web && npx vitest bench --run
src/editor/tags.bench.ts`; this laptop measured about 0.0016 ms per completed candidate,
not an Android performance claim.

Home no longer repeats the vault name or introductory guidance, and its heading spacing is
compact. The left note tree suppresses the saved note highlight while Home is showing. The tree
also lets users drag readable notes into inferred or empty folders, or drop them on the tree root
to move them out. Moves reuse the audited rename endpoint, preserve titled notes, update open tabs,
and refresh the catalog and empty-folder list. Focused DOM tests and frontend typecheck pass; the
focused navigation browser smoke test remains blocked by the E2E fixture server reporting a
missing `server.toml` after startup.

Note navigation now reuses the active tab for ordinary clicks from the note tree and other
note-list surfaces. Cmd/Ctrl-click and the new “Open in new tab” context-menu action create a
fresh tab; note and tab context menus share the action. Focused DOM tests, typecheck, and the
production frontend build pass. The in-app browser bridge could not run in this session.

The note tree and tabs now suppress the browser context menu and offer Rename through a shared
custom menu. The duplicate in-pane breadcrumb/name row was removed. Focused frontend tests,
typecheck, production build, and diff checks pass; the in-app browser bridge is unavailable.

Renaming a note also rewrites its first H1 to the destination filename stem. Legacy notes
without a title receive a non-empty H1 during rename; inbound links and self-links remain
consistent. Editing the protected first H1 now debounces a server rename, updates every open
tab, refreshes the catalog, and normalizes filesystem-only characters while preserving the
displayed emoji/title. Core and server rename regression suites pass.

Right-clicking a note or bookmark now offers Delete. It confirms with the user, moves the
note to the existing server-owned recoverable trash, closes matching open tabs, and refreshes
the note catalog and trash view.

Opening a title-only note now creates an empty body paragraph and places the caret there; notes
whose body arrives after opening do the same once their first H1 is available. Title edits stay
local while the caret remains in the H1 and commit on leaving that line or blurring the editor,
so renaming never remounts the note mid-edit.
The H1 may be temporarily empty during editing; committing an empty title restores `untitled`
or the next available numbered variant in the same folder.

The editor now accepts desktop-dragged media when the browser supplies an empty MIME type,
using the safe filename extension as a fallback. File drops are consumed even when unsupported
so they cannot navigate away from the note. Focused unit tests, typecheck, production build,
and the desktop/mobile media E2E regression pass; full gates remain deferred.

## Editor padding feedback

The user's latest console screenshot confirms resizing works: the viewport shrank from
1537px to 1002px and the editor from 1273px to 738px. The concern was the purple focus
rectangle losing its side padding. The note's editor surface now reserves padding for
the outline offset plus its stroke on all sides, keeping the complete ring inside the
scrolling pane even when the column fills its available width. The 96rem maximum remains.
The in-app browser bridge is unavailable; isolated Playwright works with sandbox escalation.
Full gates remain deferred.

## Current state

The latest user-visible change adds resident-note links to the offline `/` fallback. The
service worker reads the permission-filtered IndexedDB replica and renders escaped links to
note bodies already present on this device. Direct note URLs still load the cached shell;
`/login` remains generic and does not list cached note names.

Focused validation for this change passes:

- `npm --prefix web test -- --run src/offline/offline-page.test.ts src/offline/available-notes.test.ts src/offline/db.test.ts`
- `npm --prefix web run typecheck`
- `npm --prefix web run build`
- `npm --prefix web run e2e -- e2e/offline.spec.ts` — 12 passed, 2 expected mobile skips

The full `make check` gate remains deferred until explicit request. The existing
open items and baseline notes below remain unchanged.

The user's latest screenshot in `local/debug/` showed the standalone vault library, not a
collapsed workspace. The vault route now loads the workspace with Home in the center and the
file/folder tree on the left. Desktop Home opens navigation even if it was previously hidden,
and starts with Context closed. Mobile retains the initial closed drawer.

The latest feedback removes the tall sidebar action list. Memberberry's existing book mark
and wordmark now link to the current vault's Home from the top bar (mark-only on mobile).
Search stays in the existing icon selector and quick-find button. New note and New folder
are compact icon buttons beside the sticky Notes heading, with labels, tooltips and touch
targets. The vault chooser still leads to the account's vault list. New note
uses the existing dialog and creates at the root (a typed `Folder/Note` path creates inside
that folder). The command palette's creation command still defaults beside the active note.
New folder creates a real empty directory. Home retains saved tabs without mounting editors
until a note opens, including when that note was already the active saved tab.

The new folder endpoints use E28 (`SPEC.md` §6.4); empty directory names are filtered at the
repository boundary, and creation authorizes before checking the filesystem. Symlinks and
hidden directories do not enter the listing. No note content moved out of Markdown.

The full `local/` directory is now gitignored. `AGENTS.md` §8 records `local/debug/` as the
user's screenshot/debug inbox. Check the latest relevant file when responding to feedback.

The `first-working-baseline` checkpoint includes the accumulated account/vault setup,
redesign, themes, import/export and deployment tooling, plus the Home and navigation work.
It is a development baseline, not a claim that the open items below are resolved.

## Verification and next steps

- This compact-navigation iteration: the new Home-link unit test failed before implementation;
  77 focused unit tests and 4 desktop/mobile Home browser cases pass. Types and tokens pass.
  Logs: `/tmp/mb-chrome-unit.log`, `/tmp/mb-chrome-browser.log`, `/tmp/mb-chrome-types.log`.
- Full `make check` passes for this checkpoint, including coverage floors, strict clippy,
  frontend types, tokens and 1,501 frontend tests. Log: `/tmp/mb-baseline-check.log`.
- Full `make e2e` passes: 252 passed, 44 existing conditional skips, across desktop and
  mobile. Log: `/tmp/mb-baseline-e2e-final.log`.
- The editor browser regression now opens Welcome through the Home note tree, rather than
  the removed standalone library link, regardless of its bookmark state. The onboarding
  filesystem-error test navigates away
  before removing permissions so background Home requests cannot race the error scenario.
  Both specs pass across desktop and mobile (22 cases).

- The new Home browser regression failed on the old vault library before implementation.
- Focused frontend tests cover bootstrap validation, offline user persistence, preserved
  saved tabs, creation actions, folder responses and tree merging.
- Focused Rust tests pass for Home authorization, folder HTTP authorization, private-folder
  filtering, traversal/symlink protection, editor bootstrap and mismatched frontend builds.
- Focused browser checks pass for Home and empty-folder creation (4 cases), note creation
  (10 cases) and onboarding (2 cases), across desktop and mobile. Onboarding's old vault-title
  expectations were updated to Home and the correct vault URL; behavior checks remain.
- Frontend types and the design-token contract pass. Screenshots inspected:
  `/tmp/memberberry-home-desktop.png` and `/tmp/memberberry-home-mobile.png`.
- Logs: `/tmp/mb-home-unit.log`, `/tmp/mb-home-state.log`,
  `/tmp/mb-home-http.log`, `/tmp/mb-folder-http.log`, `/tmp/mb-folder-leaks.log`,
  `/tmp/mb-home-folders-browser.log`, `/tmp/mb-home-create-browser.log`,
  `/tmp/mb-home-onboarding-browser.log`.
- Future feedback iterations and commits use focused verification; `make check` requires
  an explicit request and full E2E remains user-run. New folder checks have not had separate
  source-mutation probes.
- New folder currently starts at the root; there is no selected-folder creation shortcut.
  Empty-folder lists are not available offline. A path-only grant still needs a readable
  note to discover a vault, as recorded in the spec.
- No performance budgets were remeasured. Existing bundle/runtime breaches remain in
  `SPEC.md` §21.6 and `web/perf/breaches.json`.
- The in-app browser connection was unavailable earlier in this session; repository
  Playwright provides the real-browser checks.

## Local operation and environment

- Start with `make dev` and open http://127.0.0.1:9011. Server-rendered changes need the
  backend rebuilt and restarted; `make dev` watches it.
- New installations need no CLI account/vault provisioning. Existing accounts sign in and
  use the vault name in the top bar → New vault.
- The launching app previously lacked macOS Documents-folder permission. If it recurs, grant
  that app Files and Folders access and restart.
- Browser tests use disposable fixture vaults on ephemeral or 9012 ports; none touches the
  user's own vault.
- Theme tests use the read-only `Themes/Notebook.md` fixture. Wait for loaded note content,
  since other editor tests mutate `Welcome.md`.
- Permission and browser suites require sandbox escalation for local sockets and Chromium.
- Avoid running the dev rebuild supervisor alongside `make e2e`: regenerating the emoji
  catalog triggers another WASM build writing the same outputs, which can fail with an
  optimizer-stage "No such file or directory". The checkpoint gate pauses the supervisor
  and restores it afterward; production optimization remains enabled.

## Open items

### From the container deployment

- **The production image was not built locally.** The installed Podman client has no running
  machine/socket, and Docker/Compose are unavailable. `deployment-check` validates shell syntax,
  security-critical Compose declarations, and the real archive/checksum/overwrite behaviour;
  the first deployment still needs `docker compose build` and `docker compose config` on a host
  with Docker.
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
- **The icon carries two literal colours.**
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
- **Four budgets are over**, recorded in `web/perf/breaches.json`.
- **The untried bundle levers are in §21.1.**
- **`make check` does not open a browser.**

**Known absent:** the address bar following the active tab. Note deletion and restoration
are available under Context → Deleted notes.

### Where user feedback arrives

**`USERFEEDBACK.md` at the repo root is a real inbox.** Check it at the start of a session.
Its one entry so far (M7's sign-in padding) is addressed.

## Running it locally

```
export MEMBERBERRY_DATA_DIR=/tmp/mb-dev
printf 'your-password\n' | memberberry user setup --username alice --password-stdin
printf 'your-password\n' | memberberry vault create --slug personal --path /path/to/vault \
    --actor alice --password-stdin
make dev                                          # open http://127.0.0.1:9011
```

`make dev` builds WASM, starts Vite on 9011, starts Rust on 9010, proxies authenticated pages,
API calls and WebSockets through Vite, hot-reloads frontend edits, and rebuilds WASM/restarts
Rust after Rust source changes. One `Ctrl+C` stops both. `make prod` builds both production
artifacts and runs the release server; `make prod-build` only builds them.

Without `--password-stdin` these commands prompt on `/dev/tty` and cannot be piped.
**Top-level keys in `server.toml` go above the first `[[vaults]]` table.**

**`memberberry serve` prints `index ready in N ms` before it accepts a request.**

**The service worker only exists in a built bundle served by `mb-server`.** `npm run dev`
does not register one.

**A rebuild does not strand a browser on old assets.** The routing rule is membership of the
*installed* build's precache list.

**The graph, embeds and renaming all need a server and an index.**

`make e2e` provisions its own throwaway server on 9012 under `target/e2e/`. **When to run it,
and when one spec is enough, is `AGENTS.md` §5.2** — rebuild first, every time. Run from the
*repo root*; `npx playwright test` from elsewhere writes a stray `test-results/`.

**After changing `e2e/environment.ts`, kill 9012** or the new fixtures are not there
(`reuseExistingServer` is on locally).

`make perf` uses 9013 and a 10k-note vault under `target/perf/vault`.

## Read this before trusting a green test run

The general rules are `AGENTS.md` §2.3 and the history is `SPEC.md` §22.6. Short version:

- **A wait that matches the empty state is not a wait.**
- **`locator.all()` does not auto-wait.**
- **`toHaveCount` counts hidden elements.** Assert visibility or box size for UI claims.
- **A generator that biases small never generates the crowded case.**
- **A property that fails on one seed in ten is a flaky test, not a good one.**
- **A probe that survives is a branch that is not doing anything.**
- **`toBeVisible` on a container passes with `display: none` on its content.**
- **jsdom applies no stylesheet, and it does not lay anything out.**
- **A failing build looks exactly like a passing test.** Rebuild first; check it succeeded.
- **An effect that reads a value and writes it runs forever.**
