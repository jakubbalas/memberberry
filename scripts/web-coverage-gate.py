#!/usr/bin/env python3
"""Enforce the per-directory frontend coverage floors in AGENTS.md §2.1.

The Rust side has had `coverage-gate.py` since M0; the TypeScript side declared floors in
§2.1 but nothing checked them, so `web/src/editor` sat at 78% with one module at 11% and
`make check` still passed. A floor nobody enforces is a comment.

Reads `web/coverage/coverage-summary.json` (vitest's `json-summary` reporter) and checks
each directory in §2.1 separately, because one well-covered module can otherwise carry a
neglected sibling over the line.
"""

from __future__ import annotations

import json
import pathlib
import sys

# AGENTS.md §2.1, most specific prefix wins.
FLOORS = {
    "src/public": 90,
    "src/editor": 85,
    "src/shell": 85,
}
DEFAULT_FLOOR = 80  # "Everything else" in §2.1.

SUMMARY = pathlib.Path("web/coverage/coverage-summary.json")


def floor_for(relative: str) -> tuple[str, int]:
    """Returns the (area, floor) governing a file, preferring the most specific prefix."""
    best = ("everything else", DEFAULT_FLOOR)
    longest = -1
    for prefix, floor in FLOORS.items():
        if relative.startswith(f"{prefix}/") and len(prefix) > longest:
            best, longest = (prefix, floor), len(prefix)
    return best


def main() -> int:
    if not SUMMARY.exists():
        print(f"web coverage gate: {SUMMARY} is missing — run `npm --prefix web run coverage`")
        return 1
    summary = json.loads(SUMMARY.read_text())
    root = pathlib.Path.cwd() / "web"

    covered: dict[str, list[int]] = {}
    for path, totals in summary.items():
        if path == "total":
            continue
        try:
            relative = pathlib.Path(path).resolve().relative_to(root.resolve()).as_posix()
        except ValueError:
            continue
        area, _ = floor_for(relative)
        lines = totals.get("lines", {})
        tally = covered.setdefault(area, [0, 0])
        tally[0] += lines.get("covered", 0)
        tally[1] += lines.get("total", 0)

    if not covered:
        print("web coverage gate: the summary named no files under web/ — is the path right?")
        return 1

    failures = []
    report = []
    for area in sorted(covered):
        hit, total = covered[area]
        floor = FLOORS.get(area, DEFAULT_FLOOR)
        percent = 100.0 if total == 0 else 100.0 * hit / total
        status = "ok " if percent >= floor else "LOW"
        report.append(f"  {status} {area:<24} {percent:6.2f}%  (floor {floor}%)")
        if percent < floor:
            failures.append(f"  {area} at {percent:.2f}% is below its {floor}% floor")

    if failures:
        print("web coverage gate failed (AGENTS.md §2.1):")
        print("\n".join(failures))
    print("\n".join(report))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
