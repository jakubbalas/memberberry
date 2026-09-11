/**
 * The shell's icon set (`SPEC.md` §8.2, §20.1).
 *
 * These are drawn instructions, and the two ways they go wrong are both silent: a path that
 * does not begin with a move command renders nothing at all, and a path that carries its own
 * colour stops following the theme — which is the whole reason `Icon.svelte` strokes with
 * `currentColor`. Neither shows up as an error anywhere; both show up as a control with no
 * picture in it, or a picture that stays dark in a dark theme.
 */

import { describe, expect, it } from "vitest";

import { ICON_PATHS, type IconName } from "./icons.js";

const NAMES = Object.keys(ICON_PATHS) as IconName[];

describe("the icon set", () => {
  it("gives every icon at least one path", () => {
    expect(NAMES.length).toBeGreaterThan(0);
    for (const name of NAMES) {
      expect(ICON_PATHS[name].length, name).toBeGreaterThan(0);
    }
  });

  it("starts every path with a move command, without which nothing is drawn", () => {
    for (const name of NAMES) {
      for (const path of ICON_PATHS[name]) {
        expect(path.trimStart(), name).toMatch(/^[Mm]/);
      }
    }
  });

  it("keeps every glyph inside the 24-unit grid it is sized against", () => {
    // A coordinate outside the `viewBox` is clipped, so half an icon is drawn and the rest
    // silently is not. Absolute commands only: a relative segment's numbers are deltas.
    for (const name of NAMES) {
      for (const path of ICON_PATHS[name]) {
        if (/[a-z]/.test(path.replace(/[ae]/g, ""))) continue;
        for (const value of path.match(/-?\d+(?:\.\d+)?/g) ?? []) {
          expect(Number(value), `${name}: ${path}`).toBeLessThanOrEqual(24);
          expect(Number(value), `${name}: ${path}`).toBeGreaterThanOrEqual(-24);
        }
      }
    }
  });

  it("declares no colour of its own, so a theme can recolour every one of them", () => {
    // §20.1: the token contract is the only place a colour is written down, and
    // `token-check.py` cannot see inside a path string.
    for (const name of NAMES) {
      for (const path of ICON_PATHS[name]) {
        expect(path, name).not.toMatch(/#|rgb|hsl|fill|stroke/i);
      }
    }
  });
});
