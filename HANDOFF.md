# Handoff — editor/date release deployed for testing

Updated 2026-10-19T12:42:00+02:00. Canonical task:
../tasks/open/t-020-combine-editor-dates-and-deploy.md. Project/status are in the parent
workflow directory. This checkout is `/var/home/paul/clawd/projects/memberberry/release-20261019`,
branch `integrate/editor-dates-20261019`.

## Live build and next action

Paul's requested combination is deployed and reverified healthy on
`memberberry-memberberry:editor-dates-20261019`, image
`sha256:e3c75cfc75de13ac25301f3e3e0ed98c2194f1b506087ef490ab5133c6df1935`.
Tested/frozen source is `e5f6ca3685bb7f18709c486658f86510c1e36f3b` (774 inputs),
baseline `2c71598`. Any later HANDOFF-only commit is operational documentation, not a
runtime source change. All 389 frontend files and the unchanged backend match the package.

Includes t-019 relative date mentions with hover/date-time editing, t-018 typed numbered
markers and Enter continuation, and t-017 blank-space selection across the writing pane
with handles hidden during selection. They coexist with the current vault/folder/PWA
baseline. Original source worktrees, HEADs, source bytes and staging are preserved. The
clean previous-release index received a metadata-only git-status refresh; its tree remains
HEAD. No GitHub push/PR was requested or performed; prior PR #5 remains separate.

Next: Paul closes Memberberry tabs/installed windows, reopens
https://memberberry.quantanex.space using the normal account, then tests dates, numbered
lists, purple highlighting and movement. The public URL reaches normal Cloudflare Access
sign-in (200). There was no synthetic live session or production editor write. User
acceptance and normal signed-in/device checks remain open.

## Data and runtime preservation

Five registrations, 747 Markdown files, five access policies, config, credentials, media,
mounts and runtime/environment/Compose settings match the fresh snapshot after rollout
and live browser verification. Seven fresh private writer-stopped same-disk archives are
retained. All 64 saved CRDT copies passed the unchanged-codec probe; live CRDT was never
opened by the probe. Previous `4dd3b78e…` is retained under
`memberberry-memberberry:before-editor-dates-20261019`. No old-data restore, registry/ACL
edit, credential reset, external Access-policy edit or site-data deletion occurred.
Archives are local recovery copies, not off-host backups. Do not replay deployment or
restore older notes/replicas; use the current guarded receipts and inspect state first.

## Verification and evidence

324 focused tests across fourteen files pass. Four browser specs rebuild individually,
serial/one worker/zero retries: date mentions 8, numbering 6, selection 7, movement 12;
33 passes total with five inherited mouse-only mobile exclusions. The added combined
flow edits a date inside a typed numbered list, avoids starting block selection and then
continues the list with Enter; disk/reload contents remain canonical Markdown.
TypeScript/Svelte report zero errors/warnings; 114 tokens and whitespace checks pass.
Author specification/security then quality review found no open finding. Independent
review remains pending. Full `make check`, coverage, full user-run `make e2e` and physical-
device budgets remain deferred/pending; the inherited project limits are not waived.

Actual live desktop/mobile browsers verify login rendering/CSP, eleven exact served assets
per viewport and protected entry denials, with zero POSTs/errors. Public full Chromium
reaches existing Cloudflare Access sign-in without credentials. Final guarded verification
rechecks installed bytes, protected data and runtime after the browser checks.

Current runbook and detailed receipts:
`../integration-evidence-20261019/editor-dates/README.md`. Key receipts are package.json,
source-manifest.json, verification-summary.json, backup-manifest.json,
sidecar-compatibility.json, deployment-final-verification.json, live-browser-result.json,
public-browser-result.json and source-worktrees-preserved.json. Do not use the previous
release's receipts as current identity checks.

The release CLI is the unchanged verified binary, SHA256
`b1e75eec57ec9a0bd90ea2c610f6d980f9b9d5144b922a1789ac9955ba2ba44d`; generated note-WASM
matches prior live SHA256 `a05707f0f27f38b9040cd44095183ff454442d63ec5e0e5e1d24d688d77c5108`.
No backend rebuild is claimed. Local node_modules links point to existing installed
packages. Focused fixtures own loopback 9020 and stop after verification. Other user dev
servers were not changed. Inherited limits remain in ../release-20261018/HANDOFF.md.
