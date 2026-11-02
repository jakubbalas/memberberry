// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";

import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";

import { ACCENT_MIN_CONTRAST, applyAccent, contrastRatio, parseAccent, readableAccent } from "./accent.js";

// why: from the package root, because jsdom gives `import.meta.url` a non-file scheme.
const CONTRACT = readFileSync(join(process.cwd(), "src/shell/tokens.css"), "utf8");
/** Every `--surface-note` the shipped palettes declare, read from the contract itself. */
const SURFACES = [...CONTRACT.matchAll(/--surface-note:\s*(#[0-9a-f]{6});/gi)].map((match) => match[1] ?? "");
const SEED = 20_261_102;
const hexColour = fc.tuple(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }))
  .map(([r, g, b]) => `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`);

describe("accent parsing", () => {
  it("accepts only six-digit hex colours, lowercased", () => {
    expect(parseAccent("#AABBCC")).toBe("#aabbcc");
    for (const bad of ["", "#abc", "red", "#abcdefa", "#ab\"cde", "abcdef", 7, null, undefined]) {
      expect(parseAccent(bad)).toBeUndefined();
    }
  });
});

describe("readable accents", () => {
  it("finds a light and a dark surface in the contract", () => {
    expect(SURFACES.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps a colour that is already readable exactly as chosen", () => {
    expect(readableAccent("#6651a3", "#ffffff")).toBe("#6651a3");
  });

  it("lightens a dark accent for a dark surface", () => {
    const painted = readableAccent("#6651a3", "#222225") ?? "";
    expect(contrastRatio(painted, "#222225")).toBeGreaterThanOrEqual(ACCENT_MIN_CONTRAST);
    expect(contrastRatio(painted, "#000000")).toBeGreaterThan(contrastRatio("#6651a3", "#000000") ?? 0);
  });

  it("darkens a pale accent for a light surface", () => {
    const painted = readableAccent("#ffe680", "#ffffff") ?? "";
    expect(contrastRatio(painted, "#ffffff")).toBeGreaterThanOrEqual(ACCENT_MIN_CONTRAST);
  });

  it("refuses malformed input", () => {
    expect(readableAccent("purple", "#ffffff")).toBeUndefined();
    expect(readableAccent("#6651a3", "")).toBeUndefined();
  });

  it("always clears AA on every shipped surface (seeded property)", () => {
    fc.assert(fc.property(hexColour, fc.constantFrom(...SURFACES), (accent, surface) => {
      const painted = readableAccent(accent, surface);
      expect(painted).toMatch(/^#[0-9a-f]{6}$/);
      expect(contrastRatio(painted ?? "", surface)).toBeGreaterThanOrEqual(ACCENT_MIN_CONTRAST);
    }), { seed: SEED, numRuns: 500 });
  });

  it("is the identity on any accent already readable there (seeded property)", () => {
    fc.assert(fc.property(hexColour, fc.constantFrom(...SURFACES), (accent, surface) => {
      fc.pre((contrastRatio(accent, surface) ?? 0) >= ACCENT_MIN_CONTRAST);
      expect(readableAccent(accent, surface)).toBe(accent);
    }), { seed: SEED, numRuns: 300 });
  });
});

describe("applying an accent", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("style");
  });

  it("re-declares the accent and focus ring for the current surface, and removes them again", () => {
    const root = document.documentElement;
    root.style.setProperty("--surface-note", "#222225");
    applyAccent(root, "#6651a3");
    const painted = root.style.getPropertyValue("--accent-primary");
    expect(contrastRatio(painted, "#222225")).toBeGreaterThanOrEqual(ACCENT_MIN_CONTRAST);
    expect(root.style.getPropertyValue("--focus-ring")).toBe(painted);

    applyAccent(root, undefined);
    expect(root.style.getPropertyValue("--accent-primary")).toBe("");
    expect(root.style.getPropertyValue("--focus-ring")).toBe("");
  });
});
