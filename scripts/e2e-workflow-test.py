"""Keep browser E2E manually dispatched without removing its build or diagnostics."""

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parent.parent


class E2eWorkflowTests(unittest.TestCase):
    def test_automatic_ci_keeps_other_jobs_but_not_e2e(self) -> None:
        workflow = (ROOT / ".github/workflows/ci.yml").read_text()
        jobs = workflow.split("\njobs:\n", 1)[1]
        self.assertEqual(
            set(re.findall(r"^  ([\w-]+):$", jobs, re.MULTILINE)),
            {"check", "web", "perf", "fuzz-build"},
        )
        self.assertNotIn("npm run e2e", workflow)

    def test_e2e_can_only_be_dispatched_manually(self) -> None:
        workflow = (ROOT / ".github/workflows/e2e.yml").read_text()
        trigger = workflow.split("\non:\n", 1)[1].split("\n\n", 1)[0]
        self.assertEqual(trigger.strip(), "workflow_dispatch:")

    def test_manual_run_builds_and_runs_the_complete_suite(self) -> None:
        workflow = (ROOT / ".github/workflows/e2e.yml").read_text()
        commands = [
            "make wasm-ci", "npm ci", "npm run build", "cargo build -p mb-cli",
            "npx playwright install --with-deps chromium",
            "npm run e2e 2>&1 | tee e2e-output.log",
        ]
        positions = [workflow.index(command) for command in commands]
        self.assertEqual(positions, sorted(positions))
        self.assertIn("shell: bash", workflow)
        self.assertIn("DEBUG: pw:browser", workflow)
        for artifact in ["web/playwright-report/", "web/test-results/", "web/e2e-output.log"]:
            self.assertIn(artifact, workflow)
        self.assertNotIn("continue-on-error", workflow)


if __name__ == "__main__":
    unittest.main()
