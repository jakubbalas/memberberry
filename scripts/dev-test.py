"""Check frontend startup without installing packages or running a compiler."""

import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import dev


class DevFrontendTests(unittest.TestCase):
    """The backend must receive compiled HTML rather than Vite's source template."""

    def test_prepare_frontend_builds_the_backend_shell_after_dependencies(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mb-dev-") as directory:
            root = Path(directory)
            (root / "web/dist").mkdir(parents=True)
            (root / "web/index.html").write_text('<script src="src/main.ts"></script>')
            built = root / "web/dist/index.html"
            built.write_text('<script src="/assets/app-built.js"></script>')
            with patch.object(dev, "ROOT", root), patch.object(dev.subprocess, "run") as run:
                dev.prepare_frontend()
            self.assertEqual([call.args[0] for call in run.call_args_list], [
                ["make", "wasm"],
                ["npm", "--prefix", "web", "install", "--silent"],
                ["npm", "--prefix", "web", "run", "build"],
            ])
            self.assertEqual(built.read_text(), '<script src="/assets/app-built.js"></script>')
            for call in run.call_args_list:
                self.assertEqual(call.kwargs, {"cwd": root, "check": True})

    def test_frontend_build_failure_prevents_server_startup(self) -> None:
        with patch.object(dev.subprocess, "run", side_effect=[
            None, None, subprocess.CalledProcessError(1, "build")
        ]), patch.object(dev, "start") as start:
            with self.assertRaises(subprocess.CalledProcessError):
                dev.run()
            start.assert_not_called()


if __name__ == "__main__":
    unittest.main()
