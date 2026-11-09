#!/usr/bin/env python3
"""Run the Rust server and Vite together, restarting Rust when its sources change."""

from __future__ import annotations

import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
from typing import Callable


ROOT = Path(__file__).resolve().parent.parent
POLL_SECONDS = 0.4


def files_under(*roots: Path) -> list[Path]:
    files: list[Path] = []
    for root in roots:
        if root.is_file():
            files.append(root)
        elif root.is_dir():
            files.extend(path for path in root.rglob("*") if path.is_file())
    return files


def snapshot(paths: list[Path]) -> tuple[tuple[str, int, int], ...]:
    result: list[tuple[str, int, int]] = []
    for path in paths:
        try:
            stat = path.stat()
        except FileNotFoundError:
            continue
        result.append((str(path), stat.st_mtime_ns, stat.st_size))
    return tuple(sorted(result))


def rust_sources() -> list[Path]:
    return files_under(
        ROOT / "Cargo.toml",
        ROOT / "Cargo.lock",
        ROOT / "rust-toolchain.toml",
        ROOT / "crates",
    )


def wasm_sources() -> list[Path]:
    return files_under(
        ROOT / "crates/mb-core",
        ROOT / "crates/mb-wasm",
        ROOT / "crates/mb-emoji-wasm",
        ROOT / "vendor/emojibase",
        ROOT / "scripts/generate-emoji-catalog.mjs",
    )


def vite_configuration() -> list[Path]:
    return files_under(
        ROOT / "web/package.json",
        ROOT / "web/package-lock.json",
        ROOT / "web/vite.config.ts",
        ROOT / "web/svelte.config.js",
        ROOT / "web/tsconfig.json",
    )


def start(command: list[str]) -> subprocess.Popen[bytes]:
    return subprocess.Popen(command, cwd=ROOT, start_new_session=True)


def stop(process: subprocess.Popen[bytes] | None) -> None:
    if process is None or process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGINT)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()


Snapshot = tuple[tuple[str, int, int], ...]


def restart_frontend(
    frontend: subprocess.Popen[bytes],
    install: Callable[[], None],
    launch: Callable[[], subprocess.Popen[bytes]],
    watched: Callable[[], list[Path]],
) -> tuple[subprocess.Popen[bytes], Snapshot]:
    """Stops Vite, reinstalls, starts it again, and returns it with the configuration's state."""
    stop(frontend)
    install()
    # why: taken after the install, which rewrites package-lock.json even when nothing in it
    # changed. Taken before, every restart looked like a new change and Vite restarted forever.
    state = snapshot(watched())
    return launch(), state


def install_frontend() -> None:
    subprocess.run(["npm", "--prefix", "web", "install", "--silent"], cwd=ROOT, check=True)


def launch_frontend() -> subprocess.Popen[bytes]:
    return start(["npm", "--prefix", "web", "run", "dev", "--", "--host", "127.0.0.1"])


def prepare_frontend() -> None:
    subprocess.run(["make", "wasm"], cwd=ROOT, check=True)
    subprocess.run(["npm", "--prefix", "web", "install", "--silent"], cwd=ROOT, check=True)
    # why: 9010 serves dist directly; source HTML points at TypeScript URLs it cannot serve.
    # Vite on 9011 rewrites this compiled shell to use HMR without corrupting the build.
    subprocess.run(["npm", "--prefix", "web", "run", "build"], cwd=ROOT, check=True)


def backend_command() -> list[str]:
    return [os.environ.get("CARGO", "cargo"), "run", "-p", "mb-cli", "--", "serve"]


def self_test() -> None:
    with subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(30)"], start_new_session=True
    ) as process:
        stop(process)
        if process.poll() is None:
            raise SystemExit("dev-check: the supervisor did not stop its child")
    if ROOT / "Cargo.toml" not in rust_sources():
        raise SystemExit("dev-check: Cargo.toml is not watched")
    if ROOT / "web/package.json" not in vite_configuration():
        raise SystemExit("dev-check: package.json is not watched")
    restart_settles()
    print("dev-check: ok")


def restart_settles() -> None:
    """npm install rewrites package-lock.json even when nothing changed. A restart must not
    see its own install as a change, or Vite restarts forever."""
    with tempfile.TemporaryDirectory() as directory:
        lock = Path(directory) / "package-lock.json"
        lock.write_text("{}")

        def install() -> None:
            time.sleep(0.01)
            lock.write_text("{}")

        idle = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], start_new_session=True)
        process, state = restart_frontend(
            idle,
            install,
            lambda: subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], start_new_session=True),
            lambda: [lock],
        )
        stop(process)
        if snapshot([lock]) != state:
            raise SystemExit("dev-check: a Vite restart sees its own npm install as a change")


def run() -> int:
    prepare_frontend()
    backend = start(backend_command())
    frontend = launch_frontend()
    rust_state = snapshot(rust_sources())
    wasm_state = snapshot(wasm_sources())
    vite_state = snapshot(vite_configuration())
    print("dev: application with HMR at http://127.0.0.1:9011", flush=True)
    print("dev: Rust server at http://127.0.0.1:9010", flush=True)

    try:
        while True:
            time.sleep(POLL_SECONDS)
            if frontend.poll() is not None:
                return frontend.returncode or 1

            current_vite = snapshot(vite_configuration())
            if current_vite != vite_state:
                frontend, vite_state = restart_frontend(
                    frontend, install_frontend, launch_frontend, vite_configuration
                )

            current_rust = snapshot(rust_sources())
            if current_rust == rust_state:
                continue
            stop(backend)
            current_wasm = snapshot(wasm_sources())
            if current_wasm != wasm_state:
                subprocess.run(["make", "wasm"], cwd=ROOT, check=False)
                wasm_state = snapshot(wasm_sources())
            backend = start(backend_command())
            rust_state = snapshot(rust_sources())
    except KeyboardInterrupt:
        return 0
    finally:
        stop(frontend)
        stop(backend)


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        self_test()
        raise SystemExit(0)
    if sys.argv[1:]:
        raise SystemExit("usage: scripts/dev.py [--self-test]")
    raise SystemExit(run())
