"""Exercise coverage reuse against a real disposable Rust workspace."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("coverage-run.py")


class CoverageReuseTests(unittest.TestCase):
    """Verify fresh profiles, source invalidation, stale targets and failure propagation."""

    def test_reuse_keeps_fresh_results_and_invalidates_changed_inputs(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mb-coverage-test-") as directory:
            root = Path(directory)
            (root / "src").mkdir()
            (root / "tests").mkdir()
            (root / "Cargo.toml").write_text(
                '[package]\nname="coverage-probe"\nversion="0.1.0"\nedition="2024"\n'
            )
            source = root / "src" / "lib.rs"
            original_source = "pub mod obsolete;\npub fn value() -> u32 { 42 }\n"
            source.write_text(original_source)
            obsolete = root / "src" / "obsolete.rs"
            obsolete.write_text("pub fn old_value() -> u32 { 7 }\n")
            test = root / "tests" / "original.rs"
            test.write_text(
                "#[test] fn value_is_current() { assert_eq!(coverage_probe::value(), 42); }\n"
                "#[test] fn old_value() { assert_eq!(coverage_probe::obsolete::old_value(), 7); }\n"
            )
            retained = root / "tests" / "retained.rs"
            retained.write_text(
                "#[test] fn retained() { assert_eq!(coverage_probe::obsolete::old_value(), 7); }\n"
            )
            subprocess.run(["cargo", "generate-lockfile", "--offline"], cwd=root, check=True)

            def collect(success: bool = True) -> tuple[dict, str]:
                environment = dict(os.environ)
                environment.pop("RUSTFLAGS", None)
                environment.pop("CARGO_ENCODED_RUSTFLAGS", None)
                result = subprocess.run(
                    ["python3", str(SCRIPT), "--json"],
                    cwd=root, env=environment, text=True, capture_output=True,
                )
                self.assertEqual(result.returncode == 0, success, result.stderr)
                return (json.loads(result.stdout) if success else {}, result.stderr)

            first, _ = collect()
            self.assertTrue(any(entry["filename"].endswith("obsolete.rs")
                                for entry in first["data"][0]["files"]))
            binaries = root / "target" / "coverage-run" / "build" / "debug" / "deps"
            before = {path.name: path.stat().st_mtime_ns for path in binaries.iterdir()}
            second, output = collect()
            self.assertIn("reusing binaries", output)
            self.assertEqual(first["data"][0]["totals"], second["data"][0]["totals"])
            self.assertEqual(first["data"][0]["files"], second["data"][0]["files"])
            self.assertEqual(before, {path.name: path.stat().st_mtime_ns for path in binaries.iterdir()})

            source.write_text(original_source.replace("42", "43"))
            _, output = collect(success=False)
            self.assertFalse((root / "target" / "coverage-run" / "inputs.sha256").exists())

            source.write_text(original_source)
            collect()

            test.unlink()
            obsolete.unlink()
            source.write_text("pub fn value() -> u32 { 42 }\n")
            retained.write_text(
                "#[test] fn retained() { assert_eq!(coverage_probe::value(), 42); }\n"
            )
            (root / ".cargo").mkdir()
            (root / ".cargo" / "config.toml").write_text('[build]\nrustflags=["--cfg=probe_v2"]\n')
            (root / "tests" / "renamed.rs").write_text(
                "#[test] fn value_is_current() { assert_eq!(coverage_probe::value(), 42); }\n"
            )
            renamed, output = collect()
            paths = [entry["filename"] for entry in renamed["data"][0]["files"]]
            self.assertFalse(any(path.endswith("obsolete.rs") for path in paths), paths)

            for options in (["--summary-only"], ["--json", "--summary-only"]):
                report = subprocess.run(
                    ["python3", str(SCRIPT), *options], cwd=root,
                    text=True, capture_output=True,
                )
                self.assertEqual(report.returncode, 0, report.stderr)
                if "--json" in options:
                    self.assertEqual(json.loads(report.stdout)["data"][0]["totals"],
                                     renamed["data"][0]["totals"])

            source.write_text("this does not compile\n")
            collect(success=False)


if __name__ == "__main__":
    unittest.main()
