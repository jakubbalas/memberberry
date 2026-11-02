# Handoff

## Current state (2026-11-02)

Custom emoji now render in the authenticated app instead of appearing only in the picker.
The fix covers note bodies/titles, inline suggestions, navigation/tab/folder/home/search/
outline labels and authenticated transclusions. Existing schema atoms and aliases use the
same authorized artwork as the picker. Images scale with surrounding text. This is
committed; SPEC §11.1–11.4 records behavior and remaining rendering limits.

The old picker inserted custom codes as plain text, which Rust correctly escaped. New picker
and autocomplete selections and completed typed codes use the existing emoji atom and keep
canonical Markdown shortcodes. Older escaped/text replicas get view-only decorations;
rendering never migrates or rewrites their CRDT content. Code stays literal, unavailable
artwork falls back to a readable shortcode, and title/outline extraction retains emoji names.

Artwork lookup is nonblocking and shared only while authenticated views subscribe. Accepted
imports update mounted views; last teardown aborts and drops the ephemeral catalog. Existing
E22 routes still filter the catalog/images server-side. No server route or schema format
changed and no new enforcement point was added. No live-vault write, push or deployment
was performed. The prior shortcode/autocomplete work is committed as deefe71.

## Verification

- Focused custom/editor/rendering tests (190) and related shell/schema tests (149, with
  overlap) pass. Cases cover
  canonical/legacy text, titles, aliases, unknown/failed images, code exclusion, unchanged
  JSON/content, incremental decoration updates, teardown, lookup races and malformed/denied
  catalogs. Seeded catalog URL/alias properties use seed 20261102 (100 cases).
- All six focused desktop/mobile browser cases pass and their final screenshots were
  visually reviewed. They verify a 3d-printer shortcode: existing escaped text,
  title and new picker/typed/autocomplete insertions render; legacy escaping remains intact;
  new atoms persist as unescaped canonical shortcodes; images survive reload and appear in
  navigation/tabs. The one-character trigger and outside/Escape dismissal remain covered.
- The initial browser regression failed against the old text-only renderer. A separate
  title-extraction regression failed before adding schema leaf text. Screenshot QA also
  found the general media-image CSS overriding inline artwork; it has a browser layout check.
  A separate regression proves clicking emoji artwork does not offer the media-image editor.
- Focused server checks pass: both custom_emoji_route HTTP cases (including unreadable-vault
  denial) and the E22 leak test. Frontend denial tests also reject catalog data on 403/404/500.
- Production frontend build, TypeScript/Svelte typecheck and design-token checks pass.
  Existing dependency directive and large-chunk warnings remain. Browser listeners require
  sandbox escalation and use only the disposable test vault on 9012.
- Host benchmarks compare the new rendering extension against a baseline editor over 1,000
  blocks and measure full-catalog autocomplete. They exclude layout, network and physical
  Android input-to-paint; device performance acceptance remains unconfirmed.
- Bundle-only verification accepts the existing recorded breach: this local build measures
  about 905 KB against the 500 KB target (allowance 950 KiB). This is not a clean budget pass;
  the current local WASM build is unoptimized. No allowance was changed.

Fresh logs: local/debug/custom-emoji-{before,title-before,inline-before,media-before,tests,related-tests,
http,leak,build,browser,typecheck,tokens,bench,bundle}.log. Browser screenshots are
web/test-results/emoji-import-an-individual-be562-ted-as-a-Markdown-shortcode-{desktop,mobile}/custom-emoji-in-note.png.
Old single-emoji/emoji-shortcode/one-char-emoji/colon-emoji logs remain in local/debug/.
Browser test-results are overwritten by subsequent runs.

Full make check and local coverage measurement are deferred, not requested.
Full make e2e remains user-run and pending; no full-suite result is claimed.

## Next and open work

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
  onboarding cleanup/recovery tests remain unverified locally.
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
