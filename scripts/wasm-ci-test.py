"""Check that CI tools are kept outside Cargo's restored target cache."""

import os
from pathlib import Path
import subprocess
import unittest


ROOT = Path(__file__).resolve().parent.parent


class WasmCiTests(unittest.TestCase):
    def test_ci_builds_both_packages_with_tools_in_runner_temp(self) -> None:
        result = subprocess.run(
            ["make", "--no-print-directory", "-n", "wasm-ci"],
            cwd=ROOT,
            env=dict(os.environ, RUNNER_TEMP="/tmp/memberberry-runner"),
            text=True, capture_output=True, check=True,
        )
        builds = [line for line in result.stdout.splitlines() if "wasm-pack build" in line]
        self.assertEqual(len(builds), 2)
        for build in builds:
            self.assertIn('XDG_CACHE_HOME="/tmp/memberberry-runner/memberberry-wasm-cache"', build)
            self.assertIn("CARGO_PROFILE_RELEASE_OPT_LEVEL=z", build)
            self.assertNotIn("--no-opt", build)


if __name__ == "__main__":
    unittest.main()
