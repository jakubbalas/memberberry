# Handoff

## Branch `mermaid-diagrams` (2026-11-08): Mermaid diagrams implemented

Mermaid diagrams are in scope (A38, SPEC §13.2). The reason is Gantt charts: the team wants
Memberberry as a Confluence replacement. A ` ```mermaid ` code block renders as a preview.
Its source shows when the caret is inside (via Edit source, a click on the preview, or an
arrow key from the adjacent block) and hides on Done or when the caret leaves. Read-only notes
get Show source.

- `web/src/mermaid/`: `renderer.ts` (lazy `import("mermaid")`, strict security, serialized
  queue, LRU cache keyed by width + theme + source), `sanitize.ts` (second pass: scripts,
  handlers, external URLs, fetching CSS), `theme.ts` (tokens → `themeVariables`), `mermaid.css`.
- `web/src/editor/mermaid-view.ts`: code-block node view, editing decoration, arrow keys.
  Priority 1, so open menus keep their keys. Escape is deliberately not bound, because §8.4
  gives it to block selection.
- `mermaid` is pinned to 11.17.2 because Excalidraw's `mermaid-to-excalidraw` resolves to the
  same copy, so the PWA precache does not grow. 12.x exists; moving to it means two copies.
- `perf/bundle.ts` fails if a Mermaid chunk is statically imported by an eager chunk.

Verification: 55 new unit tests (sanitizer property test seeded 20261108; renderer; theme;
editor view) plus 2 perf bundle tests. The full web suite passes (2840), as do typecheck,
token-check and perf-bundle. Mutation probes went red for: event-handler stripping, strict
security, theme-listener teardown, debounce-timer teardown and arrow-key adjacency.
Probing the bundle guard with a static import showed that the import folds into the app chunk,
which the existing bundle budget catches; the key guard covers a separate eager chunk.
Browser: `e2e/mermaid.spec.ts` passes on desktop and mobile (8). It renders a Gantt chart,
types into it and reads the `.md` off disk, checks there are no off-origin requests, covers
arrow-key entry and the error state, and checks dark-theme bar colours against tokens.
Screenshots were inspected. Full `make check` and coverage were not run (not requested).
Full `make e2e` is pending; the user runs it.

Open:
- Public shares (§17, no public JS) show diagram source as a code block. Server-side
  pre-rendering is undecided.
- No re-render on window resize; a chart re-lays out on its next edit or open.
- A38's mobile performance exception is not measured yet. SPEC §13.2 promises a diagram-page
  fixture in `make perf`; it does not exist.
- Arrow-key entry works only between sibling blocks. A diagram nested in a list or callout is
  reached by clicking or with Edit source.
- `npm audit` reports 29 advisories (3 critical), the same count as main. Mermaid adds none,
  because Excalidraw already pulls in the same tree. One critical advisory is in DOMPurify
  3.4.15 (IN_PLACE mode), which Mermaid's strict mode uses. Diagrams now reach that code from
  every note, not only from Excalidraw's import dialog. `sanitize.ts` is the independent
  second pass. The upgrade is not triaged.
- The Confluence Cloud side (a Forge macro wrapping `mermaid`, or a Marketplace Mermaid app)
  is a separate project, not in this repo.

## Current state (2026-11-02)

Vault settings are implemented and committed (SPEC §20.4, §11.2, §20.1, E33, A36/A37).
Owners get a top-bar settings button (sliders icon) opening a dialog that:
- sets the vault default theme and an optional accent colour, saved to
  `.memberberry/config.toml`. The accent is lightened or darkened per palette to keep 4.5:1
  contrast;
- lists vault emoji (shared server emoji read-only), adds one image under a chosen
  shortcode, removes aliases, deletes emoji (notes keep `:name:`) and renames them;
- renames by rewriting `:old:` to `:new:` in every note as an E14 privileged rewrite
  (`mb_core::rewrite::rename_emoji`, the `rename` route with `kind: "emoji"`) and keeps the
  old name as an alias.

New routes: `GET`/`PUT …/settings`, `DELETE …/emoji-entries/{shortcode}[/aliases/{alias}]`.
New enforcement point: E33. The bootstrap now carries `data-vault-accent` and
`data-vault-owner`. The custom emoji rendering work before this is committed as c92aebd.
No push, deployment or live-vault write was performed.

## Verification

- mb-core: 24 new emoji-rewrite tests, including seeded properties (verifies on generated
  notes, there-and-back identity, spans-only edits on arbitrary input). The existing 34
  rename tests still pass. Three mutation probes (case-folding, closing-colon escape,
  frontmatter icon) each turned a test red; the escape probe needed a new test to do so.
- mb-server: 9 emoji manifest tests, 8 settings tests (with properties), 5 HTTP integration
  tests, and leak cases e33 (owner-only routes; probe removing the owner check went red) and
  e14_an_emoji_rename. The full mb-core and mb-server suites pass apart from the two
  onboarding config-write tests below. Clippy reports nothing in changed files; the
  existing folder_delete.rs test-module expect findings remain.
- Web: all 187 vitest files (2782 tests) pass, plus svelte-check, token-check and
  wasm-check. The accent property uses seed 20261102 against every `--surface-note` in
  tokens.css. Dialog probes (collision check, delete confirmation) went red.
- Browser: settings.spec.ts passes on desktop and mobile (add, rename rewriting the file on
  disk, theme + accent saved and repainted after reload, delete). Its screenshots were
  inspected. Related theme/emoji-import/topbar/tokens specs pass (43), including the mobile
  44px touch floor with the new button. The spec uses its own `empty-<project>-settings`
  vault so vault-wide appearance changes cannot leak into other specs.
- The two failing onboarding tests (`onboarding_failed_config_write_…`,
  `onboarding_config_write_failure_…`) compare `/private/var` against `/var` temp paths
  on macOS. They are unrelated to this change; see the open item below.

Logs: local/debug/settings-rust-tests.log, local/debug/settings-clippy.log. Screenshots:
web/test-results/settings-an-owner-manages-*/settings-dialog.png (overwritten by later runs).

Full make check and local coverage measurement are deferred, not requested.
Full make e2e remains user-run and pending; no full-suite result is claimed.

## Next and open work

- Settings scope deliberately omitted: no palette command for Settings, no server-admin
  editing of shared emoji from the dialog (the admin API still exists), no replacing an
  emoji's artwork, and no accent on server-rendered pages. Open windows other than the one
  that saved pick up appearance on their next load.
- An emoji rename that fails part-way through note writes leaves earlier notes rewritten.
  The old alias keeps everything rendering, but re-running the rename is refused (the old
  name is no longer canonical); finish by hand or rename back. The audit log lists touched
  files. Emoji renames scan every note file (no emoji index), so cost grows with vault size.
- Anonymous shares and CLI HTML still show readable custom shortcodes. They need their own
  rendering/authorization integration; authenticated vault image URLs must not be reused
  for anonymous shares. The authenticated app and its standalone HTML export render artwork.
- Whether “overwrite” also means replacing existing emoji artwork is awaiting clarification.
  The current change edits the filename suggestion; duplicate protection remains (SPEC §11.2).
- Run manual full E2E with make e2e. Full checks and
  coverage remain deferred until requested. Physical-device/performance acceptance and
  fresh remote CI remain unconfirmed.
- Editor formatting defaults are fixed, like existing editor undo keys. Workspace hotkey
  remapping does not yet cover editor keys; SPEC §8.4 records this unfinished requirement.
  Clear formatting remains keyboard-accessible through Alt-F10 and the toolbar.
- Open in main panel cannot load folder contents on this Mac: its shallow-directory
  endpoint is Linux-only and returns 404. Sidebar Rename/Delete has real-server browser
  verification; folder-content state transitions have DOM coverage. See SPEC §6.1.
- General external rich HTML import remains outside the clipboard scope.
- Other connected clients/bookmarks do not follow folder renames; only the initiating
  workspace updates. Other durable feature limits remain in SPEC.md.
- The macOS directory_path_included warning remains; its callers are Linux-only. Historical
  onboarding cleanup/recovery tests fail locally on the macOS /private/var vs /var
  temp-path comparison (http.rs:268); unrelated to settings, not fixed.
- Unreproduced sync registry lock-poisoned panic: capture the first backtrace; never clear
  poison or delete replicas. False-conflict callouts are not automatically removed.
- Browser IndexedDB cap/cross-tab eviction remains unverified. Existing Linux Chromium
  crashes and mobile performance breaches remain in web/perf/breaches.json. The prior
  clipboard bundle-only pass used a recorded allowance, not a clean long-term budget pass.
  The prior npm audit reported 13 advisories; not re-triaged here.

## Local development and gotchas

- make dev uses frontend 9011/backend 9010; these may be live user services. Do not stop
  or reuse them. Startup builds the backend shell; never copy web/index.html over dist.
- Rebuild before focused browser verification: npm --prefix web run build, then
  npm --prefix web run e2e -- emoji-import.spec.ts --workers=1. Run one spec at a time,
  without retries. After server changes also run cargo build -p mb-cli.
- Local listener/browser tests require sandbox escalation here. The repository Playwright
  harness provides real Chromium verification. Browser runs use disposable target/e2e vaults.
- Run editor benchmarks from web/: npm exec -- vitest bench --run src/editor/selection-menu.bench.ts.
  npm --prefix web exec from the repo root leaves fixture paths at root.
- Use stable Rust; 1.90 is too old for installed yrs. make wasm is unoptimized; use
  make wasm-ci for bundle measurements. No WASM change was required for these shortcuts.
- Never clear vault state/browser replicas to refresh. Close/reopen windows or use the
  explicit update flow. local/ is gitignored feedback/debug material.
- Install ProseMirror plugins at editor creation; late registration affects undo/handles.
  Preflight unknown-schema Y docs before binding. Poll native/model selection before keys.
- DOM attribute selectors containing astral emoji failed despite correct markup; compare
  actual aria-label strings instead. tables.spec.ts historically is not repeat-safe.
- Prefer cargo test -p mb-server --test rename for folder moves. A rename name filter misses
  folder_move cases and starts every integration-test binary unnecessarily.
