# Handoff — selected-block keys and full combined-release verification

Updated 2026-10-19T14:53:00+02:00. Canonical task:
../tasks/open/t-021-selected-block-keys-and-full-checks.md. Checkout
`/var/home/paul/clawd/projects/memberberry/selection-keys-20261019`, branch
`fix/block-selection-keys-20261019`, baseline `22d1a75`. Includes the previously deployed
relative dates, typed numbered lists and full-pane highlighting.

## Candidate and checks

Delete/Backspace removes the full purple selection in one isolated undo step. Tab and
Shift+Tab indent/outdent supported sibling bullet, numbered and task items as a group,
including their nested children. Unsupported ranges stay unchanged; root tasks retain
metadata instead of being lifted into prose. Title, task attributes, marks, surviving
anchors/numbering, explicit separators and continued typing after whole-body deletion
are preserved. Existing readiness, single-editor and current-document checks remain.
SPEC §8.4 describes the behavior.

All requested gate stages and coverage floors pass. The first full `make check` passed
fmt/Clippy, 1,586 workspace tests, optimized search-size test, nine Rust floors and token,
deployment/dev contract checks. It exited 2 for two inherited autocomplete teardown tests
that also spied on the new date controls' persistent listeners. Scope now starts after
editor mount; exact popup callback/capture assertions remain and visual registrations
must be nonempty. All 18 tests pass; omitting cleanup makes all three viewport cases fail.
Actual autocomplete cleanup code is unchanged. Complete `make web-check` then passed:
173 files, 2,514 tests, no skips, zero type errors/Svelte warnings, fresh frontend floors.
Unchanged successful Rust/infrastructure stages were retained; no single zero-exit
`make check` rerun is claimed. Exact exits and coverage values are in the verification
summary. Floors/exclusions/retry settings are unchanged.

110 focused block tests pass, including seeded deletion/undo properties and a regression
caught during review: indentation used to lose a highlighted group when its final item
had nested children. Original keyboard regressions and that regression were observed red.

Four rebuilt browser specs run serially on disposable loopback 9020, one worker/no
retries. Dates 8, numbering 6, selection 15 and movement 12 passed: 41 passes, five inherited
mouse-only mobile exclusions, zero retries. All four specs passed. Full `make e2e` stays user-run under AGENTS §5.2 and remains pending.

## Live state and next action

Live remains the healthy `memberberry-memberberry:editor-dates-20261019` image
`sha256:e3c75cfc75de13ac25301f3e3e0ed98c2194f1b506087ef490ab5133c6df1935`.
Freeze/commit the tested source and deploy under Paul's existing authorization. Fresh runbook/evidence:
`../integration-evidence-20261019/selection-keys/`. Guarded operations require every gate
stage and all four rebuilt browser specs. Fresh preflight still matches the healthy
runtime and all five registrations. Writer-stopped backups/deployment have not run yet.
No GitHub publication, live note write or user-account/policy change is part of this task.

## Reproduction and limits

`local/selection-keys/` has focused/full gate logs and the isolated-container runners.
Full check source is `/tmp/memberberry-selection-keys-20261019` inside
`memberberry-local-dev` (one CPU/4 GiB, one worker). Scoped cargo-llvm-cov 0.9.1/matching
LLVM tools are installed. Runtime/test inputs match the host; handoff-only documentation
can differ. Browsers use installed full Chromium and `web/playwright.pwa.config.ts`;
rebuild before each spec. Local dependencies link to installed packages; container ones
are physical copies. Existing servers/source worktrees are preserved.

Rust runtime/backend/WASM sources are unchanged. Backend SHA256
`b1e75eec57ec9a0bd90ea2c610f6d980f9b9d5144b922a1789ac9955ba2ba44d` and note-WASM SHA256
`a05707f0f27f38b9040cd44095183ff454442d63ec5e0e5e1d24d688d77c5108` remain the previously
verified artifacts; no backend rebuild is claimed. Normal signed-in/device acceptance,
full manual E2E, independent review and physical-device budgets remain open. Inherited
limits remain in `../release-20261018/HANDOFF.md`.
