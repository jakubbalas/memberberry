"""Check full-test ordering and failure propagation without running the full suites."""

import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest


MAKEFILE = Path(__file__).resolve().parent.parent / "Makefile"


class FullTestTests(unittest.TestCase):
    """Exercise the real Make target with a recording substitute for child Make calls."""

    def run_target(self, failing_phase: str = "") -> subprocess.CompletedProcess[str]:
        """Record child invocations and optionally make one phase fail."""
        with tempfile.TemporaryDirectory(prefix="mb-full-test-") as directory:
            runner = Path(directory) / "phase.py"
            runner.write_text(
                "import os, sys\n"
                "print(sys.argv[1], flush=True)\n"
                "sys.exit(1 if sys.argv[1] == os.environ.get('FAIL_PHASE') else 0)\n"
            )
            return subprocess.run(
                ["make", "--no-print-directory", "-s", "-j4", "-f", str(MAKEFILE),
                 "full-test", f"MAKE={shlex.join([sys.executable, str(runner)])}"],
                cwd=directory, env=dict(os.environ, FAIL_PHASE=failing_phase),
                text=True, capture_output=True,
            )

    def test_full_test_builds_wasm_then_checks_then_e2e_even_with_parallel_make(self) -> None:
        result = self.run_target()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), ["wasm", "check", "e2e"])

    def test_full_test_stops_at_the_first_failed_phase(self) -> None:
        phases = ["wasm", "check", "e2e"]
        for index, phase in enumerate(phases):
            with self.subTest(phase=phase):
                result = self.run_target(phase)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout.splitlines(), phases[:index + 1])


if __name__ == "__main__":
    unittest.main()
