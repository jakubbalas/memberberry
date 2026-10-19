# Handoff — combined editor/date release

Updated October 19, 2026. Canonical task:
../tasks/open/t-020-combine-editor-dates-and-deploy.md. Project/current status are in the
parent workflow directory. This isolated checkout is release-20261019, branch
integrate/editor-dates-20261019, baseline 2c71598.

Combines the preserved t-017 highlighting, t-018 typed numbered-list and t-019 date-mention
candidates. Scoped paths match their source candidates; shared SPEC changes coexist.
The date browser spec additionally covers dates inside a typed numbered list, date-button
activation without block selection, editing and Enter continuation. Existing source
worktrees/HEADs/indexes are preserved. No GitHub publication is requested.

324 focused tests across fourteen files pass; typecheck reports zero diagnostics, all
114 design tokens and whitespace checks pass. All four focused browser specs pass: dates 8, numbering 6, selection 7 and movement 12;
33 passes total with five inherited mouse-only mobile exclusions and zero retries. Every focused spec rebuilds first, one worker/no retries on disposable
loopback port 9020. Full make check, local coverage, full user-run manual E2E, independent
review and physical-device budgets remain pending/deferred.

The user explicitly authorized live deployment for testing. Live is currently healthy
on combined-pwa-editor-20261018 (4dd3b78e…), and no rollout has occurred yet. Fresh preflight
records five registered vaults. The new guarded runbook takes seven private writer-stopped
archives, validates saved CRDT copies, retains the old image and preserves settings/data.
No restore of old notes/CRDT, credentials reset, live fixture or Access-policy edit.

Runbook/evidence: ../integration-evidence-20261019/editor-dates/README.md. Dependencies
use existing installed packages; generated WASM matches live. The unchanged CLI is copied
from the prior verified release, SHA256 b1e75eec57ec9a0bd90ea2c610f6d980f9b9d5144b922a1789ac9955ba2ba44d.
No backend rebuild is claimed or needed for these frontend-only changes.

Next: freeze/commit source, verify the package, then perform the already-authorized
rollout and read-only live browser verification. All focused checks have passed.
Keep inherited limits from ../release-20261018/HANDOFF.md visible; acceptance belongs to Paul.
