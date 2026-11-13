"""Keep the desktop-package workflow manual, secret-free and covering every platform (A49)."""

from pathlib import Path
import json
import re
import unittest


ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github/workflows/desktop.yml"


class DesktopWorkflowTests(unittest.TestCase):
    def test_packages_are_only_built_on_request(self) -> None:
        workflow = WORKFLOW.read_text()
        trigger = workflow.split("\non:\n", 1)[1].split("\n\n", 1)[0]
        self.assertEqual(trigger.strip(), "workflow_dispatch:")

    def test_unsigned_by_decision_so_no_secrets_are_read(self) -> None:
        # A49: no certificates or Apple credentials. A secret appearing here is a reversal of
        # that decision and should arrive with a SPEC change, not quietly.
        self.assertNotIn("secrets.", WORKFLOW.read_text())

    def test_every_platform_builds_and_uploads_its_package(self) -> None:
        workflow = WORKFLOW.read_text()
        for target in ["universal-apple-darwin", "x86_64-unknown-linux-gnu", "x86_64-pc-windows-msvc"]:
            self.assertIn(f"target: {target}", workflow)
        for package in ["dmg/*.dmg", "deb/*.deb", "appimage/*.AppImage", "msi/*.msi"]:
            self.assertIn(package, workflow)
        self.assertIn("if-no-files-found: error", workflow)

    def test_each_platform_config_names_its_installable_package(self) -> None:
        def targets(name: str) -> list[str]:
            return json.loads((ROOT / "desktop" / name).read_text())["bundle"]["targets"]

        self.assertIn("dmg", targets("tauri.macos.conf.json"))
        self.assertEqual(set(targets("tauri.linux.conf.json")), {"deb", "appimage"})
        self.assertEqual(targets("tauri.windows.conf.json"), ["msi"])

    def test_macos_bundle_is_ad_hoc_signed_with_no_identity(self) -> None:
        # why: Apple silicon will not launch a bundle without a valid signature; an ad-hoc one
        # gives the ordinary "unverified developer" approval instead of "damaged".
        config = json.loads((ROOT / "desktop/tauri.macos.conf.json").read_text())
        self.assertEqual(config["bundle"]["macOS"]["signingIdentity"], "-")

    def test_automatic_ci_does_not_build_packages(self) -> None:
        self.assertIsNone(re.search(r"cargo tauri build", (ROOT / ".github/workflows/ci.yml").read_text()))


if __name__ == "__main__":
    unittest.main()
