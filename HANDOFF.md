# Current state — October 18, 2026

The New vault checkbox and graceful symbolic-link handling (t-013/t-012) are implemented
and deployed. Live memberberry-memberberry-1 is healthy on
memberberry-memberberry:ignore-folders-20261018, image sha256:90585f1efde3eaa74700bca7f5fa27a7e7794114dcbb591db6d9d81ee4efb123.
Backend SHA256 10e0f1e9d24f8a55301214f7e14b4cc4127a231ea40036c5efcca1ceb61bc99c; source manifest cfa3d26d870c6f7dfc602360189b494560ea5d4bdc5bbf3d068ba39485474d62
(731 files, operational HANDOFF excluded). All 387 frontend files and unchanged schema-3
WASM match the tested package. Four registrations, 738 Markdown files, 4 policies,
config/media/credentials/runtime settings were preserved. Six fresh writer-stopped same-disk
archives and the previous fb528f1f image are retained; 62 saved CRDT copies verified.
Never replay deploy or restore stale Markdown. Private archives are not off-host recovery.

After choosing a server folder, New vault offers the default-off checkbox
“Ignore non-writable folders from vault”. The value persists per vault. Registration,
catalog/tree, direct reads, search/indexing and native watcher enrollment omit service-ineligible
folders without repairing permissions. Root/policy/required media/index storage remain strict,
as do individual eligible Markdown files. Symbolic links are always excluded and never grant
content access. The later settings-page toggle/recheck and manual exclusion patterns are deferred.
SPEC.md §§6.1/6.4 contain the contract; no CRDT/WASM schema or dependency changes.

Nine specifically authorized workspace Markdown files received service-UID 10001 rw ACLs,
with bytes and other users' effective access preserved at repair time. Private evidence
folder permissions were not broadened. Exact receipts are in the parent evidence directory.
No real vault was registered for testing, no policy/credential reset or fabricated session.

## Verification and next action

157 focused Rust, 152 frontend and 34 unique final release-binary desktop/mobile browser cases
pass (zero retries/skips). Each browser spec followed a rebuild. Typecheck has zero errors/
warnings; token, Rustfmt and whitespace checks pass. Regression-first reds and raw logs,
native UID 65534 no-read observers/positive controls, config restart, critical-storage refusal
and watcher new-directory refresh are retained. The focused directory-resolution Criterion
benchmark is recorded with machine-specific limits; this is not Android/full budget validation.
Read-only live desktop/mobile browsers render login/CSP, verify exact app/folder assets and
anonymous denials, with zero POSTs/errors. Public origin is behind Cloudflare Access;
normal signed-in review remains pending. Full make check, coverage, user-run full make e2e,
independent review and acceptance are deferred/pending. Existing historical full-gate failures
remain unwaived in PROJECT.md; focused passes are not a full-gate claim.

Next: Paul refreshes New vault, chooses the folder, checks the option and reviews the result.
Do not create that live registration on his behalf. Keep task records open for review and
combine the parallel editor/PWA work only when separately ready and authorized.

## Source isolation and later merge

Work only in /var/home/paul/clawd/projects/memberberry/new-vault-20261018,
branch feat/unified-new-vault-20261018, HEAD 123d8e4ddf01f4c1d63ccc7afa4ef1321b449e58.
No new commit/merge/push/PR. Prerequisite integration is staged in this worktree's independent
index; t-009/t-012/t-013 are unstaged (new tests/helpers intent-to-add). Do not commit the
whole staged baseline as this feature. Preserve integration-20261017, which holds the common
Git directory and concurrent t-010 work. t-011 and t-014 remain separate. Earlier t-009 copies
exist in the shared source; avoid applying twice. Current source contains none of those later
parallel changes.

Parent integration-evidence-20261018/non-writable-folders contains final source/package,
guarded rollout and browser receipts, t013-only.patch and merge-patch-verification.json.
Its baseline.json identifies t-012 tree a6bcbbfa… and t012-base-source.tar; t012-only.patch
is relative to t-009 tree bfca5369…. Earlier new-vault evidence contains prerequisite and
t009 feature patches. Review/reconcile prerequisites first, then t009/t012/t013 and parallel
changes, particularly SPEC/HANDOFF and shared runtime code; test the final combined source.
Earlier t012 source verification is historical: its build directory was intentionally reused
for t013. Final verify-source.py checks all current frozen inputs and returns nonzero on drift.

## Development commands and environment

Use memberberry-local-dev (1CPU/4GiB), independent source/target/node_modules at
/tmp/memberberry-symlink-20261018. Do not edit /src or the earlier t009 frozen build.
Docker execution needs host access. Set PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin,
CARGO_HOME=/build-cargo, CARGO_BUILD_JOBS=1 and RUST_TEST_THREADS=1. TMPDIR must be
/tmp/memberberry-symlink-20261018/target/browser-tmp; default inherited scratch points to /src.
For browser work set XDG_CACHE_HOME to target/browser-cache, GSETTINGS_SCHEMA_DIR to
target/browser-schemas and GSETTINGS_BACKEND=memory. Chromium is installed at
/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome.

Run relevant focused Rust targets, admin tests with one worker, typecheck and tokens.
Rebuild immediately before each single focused browser spec; run-browser.py records the exact
command/environment and release binary. Do not run full gates/coverage/full E2E without the
explicit request required by AGENTS.md. Final read-only live-network helper restores the
container's exact previous networks. Raw logs and screenshots are retained in checks/.
