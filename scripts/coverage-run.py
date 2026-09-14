"""Run fresh coverage while retaining binaries only for unchanged build inputs."""

import fcntl
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys


def fingerprint(cargo: list[str], root: Path) -> str:
    """Conservatively identify local sources, configuration, environment and tools."""
    digest = hashlib.sha256()

    def record(value: bytes) -> None:
        digest.update(len(value).to_bytes(8, "big"))
        digest.update(value)

    metadata = subprocess.check_output(
        [*cargo, "metadata", "--format-version=1", "--no-deps"], cwd=root
    )
    record(metadata)
    for command in ([*cargo, "--version"], [*cargo, "llvm-cov", "--version"],
                    ["rustc", "--version", "--verbose"]):
        record(subprocess.check_output(command, cwd=root))
    record(json.dumps(dict(sorted(os.environ.items()))).encode())
    files = set()
    for package in json.loads(metadata)["packages"]:
        if package["source"] is None:
            package_root = Path(package["manifest_path"]).parent
            for directory, children, names in os.walk(package_root):
                children[:] = sorted(name for name in children if name not in {"target", ".git"})
                files.update(Path(directory) / name for name in names)
    files.update(root / name for name in (
        "Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml"
    ))
    for parent in (root, *root.parents):
        files.update(parent / ".cargo" / name for name in ("config", "config.toml"))
    cargo_home = Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo"))
    files.update(cargo_home / name for name in ("config", "config.toml"))
    files.add(Path(__file__).resolve())
    for path in sorted(files):
        record(str(path).encode())
        record(path.read_bytes() if path.is_file() else b"missing")
    return digest.hexdigest()


def run(cargo: list[str], root: Path, arguments: list[str]) -> None:
    """Always execute tests; reuse only a previously successful matching build."""
    cache = root / "target" / "coverage-run"
    cache.mkdir(parents=True, exist_ok=True)
    os.environ["CARGO_LLVM_COV_TARGET_DIR"] = str(cache / "build")
    with (cache / "lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        run_locked(cargo, root, arguments, cache)


def run_locked(cargo: list[str], root: Path, arguments: list[str], cache: Path) -> None:
    """Serialize cleanup and collection so concurrent runs cannot mix profiles."""
    stamp = cache / "inputs.sha256"
    signature = fingerprint(cargo, root) + json.dumps(arguments)
    reusable = stamp.is_file() and stamp.read_text() == signature
    stamp.unlink(missing_ok=True)
    print("Coverage: reusing binaries; clearing profiles" if reusable else
          "Coverage: inputs changed; cleaning coverage build", file=sys.stderr, flush=True)
    subprocess.run(
        [*cargo, "llvm-cov", "clean", "--profraw-only" if reusable else "--workspace"],
        cwd=root, check=True,
    )
    for profile in (cache / "build").glob("*.profdata"):
        profile.unlink()
    subprocess.run(
        [*cargo, "llvm-cov", "--workspace", "--no-clean", *arguments], cwd=root, check=True
    )
    if fingerprint(cargo, root) + json.dumps(arguments) == signature:
        stamp.write_text(signature)


if __name__ == "__main__":
    try:
        run(shlex.split(os.environ.get("CARGO", "cargo")), Path.cwd(), sys.argv[1:])
    except (OSError, subprocess.CalledProcessError) as error:
        print(f"coverage-run: {error}", file=sys.stderr)
        sys.exit(1)
