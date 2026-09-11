#!/usr/bin/env python3
"""Mechanical checks for the Compose security and backup contracts."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile


ROOT = Path(__file__).resolve().parent.parent


def require(haystack: str, needle: str, subject: str) -> None:
    if needle not in haystack:
        raise SystemExit(f"deployment-check: {subject} is missing {needle!r}")


def check_static_contract() -> None:
    compose = (ROOT / "compose.yaml").read_text()
    dockerfile = (ROOT / "Dockerfile").read_text()
    entrypoint = (ROOT / "deploy/container-entrypoint.sh").read_text()
    dockerignore = (ROOT / ".dockerignore").read_text().splitlines()
    gitignore = (ROOT / ".gitignore").read_text().splitlines()
    for pattern in ["**/vaults", ".env"]:
        if pattern not in dockerignore:
            raise SystemExit(f"deployment-check: .dockerignore must exclude {pattern}")
    if "**/vaults/" not in gitignore:
        raise SystemExit("deployment-check: .gitignore must exclude managed vaults")

    require(compose, '127.0.0.1:${MEMBERBERRY_PORT:-9010}:9010', "compose.yaml")
    require(compose, "internal: true", "compose.yaml")
    require(compose, 'profiles: ["backup"]', "compose.yaml")
    require(compose, "memberberry-data:/sources/data:ro", "compose.yaml")
    require(compose, "memberberry-vault:/sources/vault:ro", "compose.yaml")
    require(compose, "minio-data:/sources/minio:ro", "compose.yaml")
    require(compose, "MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:?", "compose.yaml")
    require(dockerfile, "USER memberberry", "Dockerfile")
    require(entrypoint, "chmod 600", "container entrypoint")

    subprocess.run(["sh", "-n", ROOT / "deploy/container-entrypoint.sh"], check=True)
    subprocess.run(["sh", "-n", ROOT / "deploy/backup-data.sh"], check=True)
    subprocess.run(["bash", "-n", ROOT / "deploy/backup.sh"], check=True)


def check_backup_job() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        sources = root / "sources"
        output = root / "output"
        expected = {
            "data": ("auth.db", b"credentials"),
            "vault": ("notes/hello.md", b"# Hello\n"),
            "minio": ("objects/blob", b"media"),
        }
        for source_name, (relative, contents) in expected.items():
            path = sources / source_name / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(contents)

        environment = os.environ.copy()
        environment.update(
            {
                "BACKUP_ROOT": str(output),
                "BACKUP_NAME": "contract-test",
                "MEMBERBERRY_DATA_SOURCE": str(sources / "data"),
                "MEMBERBERRY_VAULT_SOURCE": str(sources / "vault"),
                "MEMBERBERRY_MINIO_SOURCE": str(sources / "minio"),
            }
        )
        subprocess.run([ROOT / "deploy/backup-data.sh"], env=environment, check=True)
        backup = output / "contract-test"
        archives = {
            "server-data.tar.gz": expected["data"],
            "vault.tar.gz": expected["vault"],
            "minio.tar.gz": expected["minio"],
        }
        for archive_name, (relative, contents) in archives.items():
            with tarfile.open(backup / archive_name) as archive:
                extracted = archive.extractfile(f"./{relative}")
                if extracted is None or extracted.read() != contents:
                    raise SystemExit(f"deployment-check: {archive_name} lost {relative}")

        checksums = (backup / "SHA256SUMS").read_text().splitlines()
        if len(checksums) != len(archives):
            raise SystemExit("deployment-check: checksum manifest is incomplete")
        for line in checksums:
            digest, filename = line.split(maxsplit=1)
            archive_path = backup / filename.removeprefix("*").removeprefix("./")
            if hashlib.sha256(archive_path.read_bytes()).hexdigest() != digest:
                raise SystemExit(f"deployment-check: bad checksum for {archive_path.name}")

        repeated = subprocess.run(
            [ROOT / "deploy/backup-data.sh"], env=environment, capture_output=True
        )
        if repeated.returncode == 0:
            raise SystemExit("deployment-check: backup overwrote an existing destination")


check_static_contract()
check_backup_job()
print("deployment-check: ok")
