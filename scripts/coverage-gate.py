#!/usr/bin/env python3
"""Enforce the per-crate coverage floors in AGENTS.md §2.1.

`cargo llvm-cov --fail-under-lines` applies one number to everything, which is weaker than
the table in §2.1: a crate below its floor could hide behind a crate above it. This reads
the per-file JSON from a single workspace run and checks each crate separately.

Reads llvm-cov JSON on stdin. Exits non-zero, listing every crate below its floor, so one
run tells you the whole story rather than the first failure.
"""

from __future__ import annotations

import json
import sys

# AGENTS.md §2.1. Crates that do not exist yet are listed so the floor is already decided
# when they land, rather than negotiated the day they first fail.
FLOORS = {
    "mb-core": 95,
    "mb-auth": 95,
    "mb-crdt": 90,
    "mb-search": 90,
    "mb-index": 85,
    "mb-server": 85,
}
DEFAULT_FLOOR = 80  # "Everything else" in §2.1.

# why: a binary entry point is a shim that wires stdin/stdout to the library and cannot be
# reached without spawning a process. Counting it would measure the harness, not the code.
EXCLUDE_SUFFIXES = ("/src/main.rs",)


def crate_of(path: str) -> str | None:
    parts = path.split("/crates/")
    if len(parts) < 2:
        return None
    return parts[-1].split("/")[0]


def main() -> int:
    raw = sys.stdin.read()
    if not raw.strip():
        # why: `cargo llvm-cov --json` prints nothing when the test run fails, so an empty
        # stdin here means a failing test, not a coverage problem. Saying so beats a JSON
        # traceback that sends the reader looking in the wrong place.
        print(
            "coverage-gate: no coverage data — the test run failed.\n"
            "  Run `cargo test --workspace` to see which test.",
            file=sys.stderr,
        )
        return 2
    try:
        report = json.loads(raw)
        files = report["data"][0]["files"]
    except (json.JSONDecodeError, KeyError, IndexError) as e:
        print(f"coverage-gate: unrecognised llvm-cov output ({e})", file=sys.stderr)
        return 2

    totals: dict[str, list[int]] = {}
    for entry in files:
        path = entry["filename"]
        if path.endswith(EXCLUDE_SUFFIXES):
            continue
        crate = crate_of(path)
        if crate is None:
            continue
        summary = entry["summary"]["lines"]
        covered, count = totals.setdefault(crate, [0, 0])
        totals[crate] = [covered + summary["covered"], count + summary["count"]]

    if not totals:
        print("coverage-gate: no crate files found in the report", file=sys.stderr)
        return 2

    failures = []
    for crate in sorted(totals):
        covered, count = totals[crate]
        floor = FLOORS.get(crate, DEFAULT_FLOOR)
        pct = 100.0 * covered / count if count else 100.0
        status = "ok " if pct >= floor else "LOW"
        print(f"  {status} {crate:<12} {pct:6.2f}%  (floor {floor}%)")
        if pct < floor:
            failures.append(f"{crate} at {pct:.2f}% is below its {floor}% floor")

    if failures:
        print("\ncoverage gate failed (AGENTS.md §2.1):", file=sys.stderr)
        for line in failures:
            print(f"  {line}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
