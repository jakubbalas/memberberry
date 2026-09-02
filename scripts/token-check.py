#!/usr/bin/env python3
"""Enforce the design-token contract (SPEC.md §20.1, §20.2; AGENTS.md §4.4).

Three checks, all mechanical:

1. **No undeclared token.** Every ``var(--x)`` anywhere in the codebase names a token
   declared in the contract. A typo is otherwise invisible: CSS resolves an unknown custom
   property to nothing and the element silently loses its colour.

2. **No unused token.** Every token the contract declares is referenced somewhere. This is
   the direction that is usually skipped, and it is the one that keeps the contract
   trustworthy: SPEC.md §20.2 promises theme authors that these names are a stable public
   API, which is a promise you cannot keep about a name nothing consumes.

3. **No literal colour outside the contract.** AGENTS.md §4.4 — a hard-coded colour is a
   bug, because it cannot be themed and it cannot be contrast-checked.

Run from the repository root. Exits non-zero on any violation, naming file and line.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path

CONTRACT = Path("web/src/shell/tokens.css")

# The contract's own header must say which version it is: SPEC.md §20.1 promises theme
# authors a *versioned* set, and a version nobody can read is not one.
VERSION_HEADER = re.compile(r"Memberberry design-token contract — version (\d+)")

# Where tokens may be referenced from. `web/src/wasm` is generated, `dist` is built output,
# and `*.test.*` is excluded on purpose: a token kept alive only by a test that asserts its
# own existence would pass check 2 while nothing in the product used it.
SCAN_ROOTS = (Path("web/src"), Path("crates"), Path("web/index.html"))
SCAN_SUFFIXES = {".css", ".svelte", ".ts", ".rs", ".html"}
SKIP_DIR_PARTS = {"node_modules", "target", "dist", "coverage", "wasm", "pkg"}
SKIP_NAME_PATTERNS = (".test.", ".spec.", ".dom.test.")

TOKEN_REFERENCE = re.compile(r"var\(\s*(--[a-zA-Z0-9_-]+)")
TOKEN_DECLARATION = re.compile(r"^\s*(--[a-zA-Z0-9_-]+)\s*:", re.MULTILINE)

# Stripped before scanning CSS, so prose about a token is not mistaken for a use of one —
# this file's own header explains `var(--x)`, which would otherwise read as a reference to a
# token called `--x`.
CSS_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)

# Colour literals. Hex is matched with a word boundary so a six-digit hex is not also
# reported as a three-digit one, and `oklch`/`lab`/`lch` are included because they are the
# modern way to write the same mistake.
HEX_COLOUR = re.compile(r"#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b")
COLOUR_FUNCTION = re.compile(r"\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\s*\(")
NAMED_COLOURS = re.compile(
    r"(?<![\w-])(?:white|black|red|green|blue|yellow|orange|purple|pink|brown|gr[ae]y|"
    r"silver|gold|cyan|magenta|teal|navy|olive|maroon|lime|aqua|fuchsia)(?![\w-])"
)

# Properties whose value carries colour. Used to decide whether a colour literal on a line
# of a `.rs` or `.ts` file is CSS or just data — a git SHA is not a colour, and neither is
# a byte pattern in a test fixture.
COLOUR_PROPERTY = re.compile(
    r"\b(?:color|background|background-color|border|border-\w+|outline|outline-color|"
    r"box-shadow|text-shadow|fill|stroke|caret-color|text-decoration-color|"
    r"column-rule|accent-color|--[a-zA-Z0-9_-]+)\s*:"
)

# `color-scheme: light dark` and `color-mix(in srgb, …)` are not colour literals: the first
# is a rendering hint and the second composes tokens. Both would otherwise trip check 3.
COLOUR_FALSE_POSITIVES = re.compile(r"color-scheme\s*:|color-mix\s*\(|@media|--font-|url\(")


@dataclass(frozen=True)
class Violation:
    path: str
    line: int
    message: str

    def __str__(self) -> str:
        return f"  {self.path}:{self.line}  {self.message}"


def scan_files() -> list[Path]:
    """Every file that may reference a token, in a stable order."""
    found: list[Path] = []
    for root in SCAN_ROOTS:
        if root.is_file():
            found.append(root)
            continue
        for path in sorted(root.rglob("*")):
            if not path.is_file() or path.suffix not in SCAN_SUFFIXES:
                continue
            if SKIP_DIR_PARTS & set(path.parts):
                continue
            if any(pattern in path.name for pattern in SKIP_NAME_PATTERNS):
                continue
            found.append(path)
    return found


def read_source(path: Path) -> str:
    """File contents, with CSS block comments removed from stylesheets."""
    text = path.read_text(encoding="utf-8")
    return CSS_COMMENT.sub("", text) if path.suffix in {".css", ".svelte"} else text


def read_contract() -> tuple[set[str], set[str], int | None]:
    """The tokens the contract declares at `:root`, those only a theme block declares, and
    the contract version."""
    raw = CONTRACT.read_text(encoding="utf-8")
    version_match = VERSION_HEADER.search(raw)
    text = CSS_COMMENT.sub("", raw)
    version = int(version_match.group(1)) if version_match else None

    # The `:root` block is the contract; anything after the first `@media` is an override,
    # which may only *re-declare* what the contract already has.
    override_start = text.find("@media")
    base_text = text if override_start == -1 else text[:override_start]
    override_text = "" if override_start == -1 else text[override_start:]

    base = {m.group(1) for m in TOKEN_DECLARATION.finditer(base_text)}
    overrides = {m.group(1) for m in TOKEN_DECLARATION.finditer(override_text)}
    return base, overrides, version


def collect_references(paths: list[Path]) -> tuple[set[str], list[Violation]]:
    """Referenced token names, plus a violation for each colour literal found."""
    referenced: set[str] = set()
    colour_violations: list[Violation] = []
    for path in paths:
        css_file = path.suffix in {".css", ".svelte"}
        # The contract is the one file allowed to write a colour down — that is what makes it
        # the contract. It is still scanned for references, because a token used only to
        # compose another token (`--shadow-lg` reads `--text-primary`) is genuinely used.
        contract = path.samefile(CONTRACT)
        for number, line in enumerate(read_source(path).splitlines(), start=1):
            referenced.update(m.group(1) for m in TOKEN_REFERENCE.finditer(line))
            # In CSS every line is CSS. Elsewhere a colour only counts when it sits on
            # something that looks like a CSS declaration, so data is not mistaken for style.
            if contract or not (css_file or COLOUR_PROPERTY.search(line)):
                continue
            if COLOUR_FALSE_POSITIVES.search(line):
                continue
            for pattern, kind in (
                (HEX_COLOUR, "hex colour"),
                (COLOUR_FUNCTION, "colour function"),
                (NAMED_COLOURS, "named colour"),
            ):
                match = pattern.search(line)
                if match is None:
                    continue
                colour_violations.append(
                    Violation(
                        str(path),
                        number,
                        f"literal {kind} {match.group(0)!r} — use a token from {CONTRACT}",
                    )
                )
    return referenced, colour_violations


def main() -> int:
    if not CONTRACT.is_file():
        print(f"token-check: {CONTRACT} is missing — run from the repository root")
        return 1

    declared, overrides, version = read_contract()
    paths = scan_files()
    referenced, colour_violations = collect_references(paths)

    failures: list[str] = []

    if version is None:
        failures.append(
            f"{CONTRACT} has no version header. SPEC.md §20.1 promises a versioned "
            "contract; the first line must read "
            '"Memberberry design-token contract — version <n>".'
        )

    orphan_overrides = sorted(overrides - declared)
    if orphan_overrides:
        failures.append(
            "these tokens are declared only inside a theme override, so they do not exist "
            "in the light theme at all:\n"
            + "".join(f"  {name}\n" for name in orphan_overrides)
        )

    undeclared = sorted(referenced - declared)
    if undeclared:
        located = locate(paths, undeclared)
        failures.append(
            f"referenced but not declared in {CONTRACT} — CSS resolves these to nothing:\n"
            + "".join(f"{v}\n" for v in located)
        )

    unused = sorted(declared - referenced)
    if unused:
        failures.append(
            f"declared in {CONTRACT} but referenced nowhere. Delete them, or use them: "
            "SPEC.md §20.2 makes these names a public API, which is not a promise worth "
            "making about a token nothing consumes.\n"
            + "".join(f"  {name}\n" for name in unused)
        )

    if colour_violations:
        failures.append(
            "literal colours outside the contract (AGENTS.md §4.4):\n"
            + "".join(f"{v}\n" for v in colour_violations)
        )

    if failures:
        print("token-check: FAILED\n")
        for failure in failures:
            print(failure.rstrip() + "\n")
        return 1

    print(
        f"token-check: ok — contract v{version}, {len(declared)} tokens, "
        f"all declared and all used across {len(paths)} files"
    )
    return 0


def locate(paths: list[Path], names: list[str]) -> list[Violation]:
    """First occurrence of each name, so the message points at something openable."""
    wanted = set(names)
    found: list[Violation] = []
    seen: set[str] = set()
    for path in paths:
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            for match in TOKEN_REFERENCE.finditer(line):
                name = match.group(1)
                if name in wanted and name not in seen:
                    seen.add(name)
                    found.append(Violation(str(path), number, f"unknown token {name}"))
    return found


if __name__ == "__main__":
    sys.exit(main())
