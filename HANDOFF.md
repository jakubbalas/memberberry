# Handoff

## Current state (2026-10-19)

The latest completed change on `main` adds note cover images (SPEC §12.5), including the
approved empty-state styling, clipboard/drop inputs and menu dismissal. No PR was created.

Authenticated note panes offer Add cover, Change cover, Remove cover and a keyboard
Reposition slider. With a cover set, an overlaid Edit cover button reveals the controls;
desktop shows it on hover/keyboard focus, touch keeps it visible. Escape closes the controls
even when a pointer click left focus outside the menu, and returns focus to the trigger.
Empty notes have a compact hover/focus target with a centered, rounded, theme-accented
`+ Add cover` button and centered source chooser, offering Choose from files and Paste from
clipboard. Menus dismiss on outside click/tap without taking focus; equal-width action
rows and helper text share a left inset. Escape still restores focus to the trigger.
Paste shortcuts on cover controls and image drops onto the cover area use the same guarded
uploader. Image drags over the note highlight the cover target;
body drops retain their inline-image behavior. Clipboard-denial feedback offers alternatives.
Covers use the existing vault media uploader and E11 media authorization.
Settings are ordinary `cover` and `cover_position` Markdown frontmatter scalars,
replicated through the existing Y.Map. Core extraction records covers as media references,
so authorization, materialized exports and garbage collection see them. No dependency,
schema revision or route was added. Viewers see covers without controls.

Previous editor work is present in this checkout: block catalogue, selection formatting,
movement/conversion gates, quotes, toggles, hard line breaks and revision-3 inline styles.
Their durable contracts remain in SPEC §8.4 and §4.4.

## Verification

- Rebuilt focused Playwright `note-cover.spec.ts`: two cases pass, desktop and mobile;
  upload, decoded image, position, persistence, reload, replacement and removal, plus
  collapsed controls, desktop hover/keyboard access, touch access, Escape dismissal,
  empty-target hover/options, highlighted cover drops, paste events and clipboard-button
  input. Browser clipboard reads use an injected external boundary so tests do not overwrite
  the user's OS clipboard; native OS clipboard permission prompting is not browser-tested.
  Screenshots reviewed; the fixture landscape PNG uses no external service.
- Focused web cover/shell/uploader tests pass: malformed inputs, read-only callers,
  stale uploads, offline resolution, cleanup and seeded Rust/WASM metadata round-trips.
  Empty-cover feedback: 95 cover/shell/uploader tests. Removing the new clipboard and drop
  listeners made all three corresponding tests fail; restored listeners pass. Focused
  evidence is in `local/debug/note-cover-input-*.log`; earlier control checks use
  `local/debug/note-cover-controls-*.log`.
  Escape regression: 87 cover/shell tests and rebuilt desktop/mobile cover browser cases
  pass. A new regression first failed with focus on the page body; document capture now
  handles Escape for the open menu, with listener teardown tested. Evidence:
  `local/debug/note-cover-escape-*.log`.
  Button styling uses a rebuilt desktop/mobile browser geometry assertion for centering;
  visual evidence and build/browser logs are in `local/debug/note-cover-style-*.log`
  and `web/test-results/`.
  Outside dismissal/alignment: 91 cover/shell tests, including regressions that first failed
  for empty and existing covers; inside-pointer behavior and listener cleanup are tested.
  Rebuilt desktop/mobile cases cover outside dismissal and stacked, equal-width action
  geometry. Evidence: `local/debug/note-cover-menu-*.log` and `web/test-results/`.
- Core extraction and round-trip suites: 40 + 11 tests pass, including seeded cover properties.
- E11 leak tests: two pass. Focused HTTP integration proves readable cover delivery
  and indistinguishable denied/missing covers. Browser runs use an updated CLI build.
- Web typecheck, design-token check and `mb-core` wasm target check pass.
- Mutation probes: removing cover extraction makes its test fail; allowing a cancelled
  upload to clear the next upload's state makes the stale-upload test fail. Both restored.
- Criterion extraction and jsdom refresh benchmarks run; laptop measurements are in
  SPEC §21.9. No physical-device performance claim.
- Evidence: `local/debug/note-cover-*.log`; screenshots in `web/test-results/`.
- Full `make check` and local coverage measurement are deferred, not requested.
  Full `make e2e` remains user-run and pending. Focused passing specs do not establish a
  passing full suite. The inherited optimized bundle gate failure has not been rechecked.

## Next and current limits

User feedback on the cover layout and manual full E2E are next.

- Cover UI decorates authenticated panes and browser print/PDF. Anonymous shares and browser
  HTML exports omit the banner. Markdown/vault exports retain the settings.
- Offline uploads retain the old cover until the new upload resolves. The note must stay
  open to attach the result; closing it requires selecting the cover again. Blob URLs
  are never saved as cover frontmatter. No stock gallery or external image URLs.
- Existing Source editing replaces body blocks, not frontmatter. View/copy/export includes
  cover metadata; edit settings with the controls or an external Markdown editor.
- Existing inline style/catalogue work increased an already-failing optimized bundle-size
  gate. Its exception was not raised; see SPEC §21. No new dependency here.
- Editor limits: container-to-Text unwrap and touch long-press block handles are absent;
  touch uses More. Toggle folding is per-view; default fold state is source-only.
- Existing multi-client/browser and physical-device performance coverage remains limited.

## Local development and gotchas

- `make dev`: frontend 9011 and backend 9010. These may be the user's live services;
  do not stop or reuse them. Focused browser fixtures use 9012 and disposable vaults.
- Rebuild before a focused browser run:
  `npm --prefix web run build && npm --prefix web run e2e -- note-cover.spec.ts --workers=1`.
  Build the Rust CLI after server changes: `cargo build -p mb-cli`.
  Listening tests need sandbox escalation in this environment.
- `make check` is explicit-request only; full E2E is manual unless explicitly delegated.
- Use current stable Rust; 1.90 is too old for the installed `yrs`.
- `make wasm` creates unoptimized WASM; use `make wasm-ci` for bundle measurements.
- Install ProseMirror plugins at editor construction. Late registration rebuilds plugin
  views; undo ownership and row-handle behavior depend on their lifecycle.
- Old-schema Yjs binding can delete unknown nodes; admission must happen before binding.
- Native and model selections can differ briefly in Playwright. Wait on the model caret
  before shortcuts; focus alone does not establish it.
- `tables.spec.ts` is not repeat-safe; repeated runs failed on unchanged HEAD.
- Heavy parallel browser load previously caused editor-mount timeouts. Use one worker.
- Never clear vault state or browser replicas to refresh the app. Close all app/PWA windows
  and reopen for service-worker activation.
- `local/` is gitignored; user feedback lives in `local/debug/`. Never stage it.

## Carried-forward open items

- Unreproduced `sync registry lock poisoned` panic: capture the first backtrace; do not
  clear poison or delete replicas. False-conflict callouts are not auto-removed.
- Browser IndexedDB cap eviction and cross-tab eviction remain unverified.
- Earlier failures still unverified: onboarding failed-config-write cleanup and unreadable
  vault recovery guidance tests. Server-test clippy had 30 inherited errors.
- Linux Chromium crashes and mobile cold-start/quick-switcher breaches were recorded in
  `web/perf/breaches.json`. Prior npm audit had 13 advisories; not re-triaged here.
- Codec limits: atomic-image native marks may be lost; adversarial unmatched CommonMark
  brackets are slow. Coverage floors remain enforced in CI; local measurement is deferred.
- Tables lack offscreen drag autoscroll, column deletion/resizing and headerless mode.
  Inbox, graph, outline/tags/transclusion, offline caches and rename retain the limits
  documented in SPEC; this change does not address them.
