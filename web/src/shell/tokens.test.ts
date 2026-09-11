/**
 * Where the design-token contract and TypeScript both own a number.
 *
 * `scripts/token-check.py` proves every token is declared and used, which is a *structural*
 * check — it cannot notice that two files hold the same timing and disagree about its value.
 * SPEC.md §7.5 gives one number to CSS (a `transition-delay`) and one to JavaScript (a class
 * toggle), so this is where they are pinned together.
 *
 * Add a case here whenever a token's value is also written down somewhere else. Better still,
 * do not write it down twice.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DEFAULT_IDLE_TIMINGS } from "../editor/presence.js";

const CONTRACT = readFileSync(fileURLToPath(new URL("./tokens.css", import.meta.url)), "utf8");

/** The declared value of a contract token, from the `:root` block. */
function token(name: string): string {
  const match = new RegExp(`^\\s*${name}:\\s*([^;]+);`, "m").exec(CONTRACT);
  if (match?.[1] === undefined) {
    throw new Error(`${name} is not declared in tokens.css`);
  }
  return match[1].trim();
}

function theme(selector: string): Readonly<Record<string, string>> {
  const start = CONTRACT.indexOf(selector);
  const open = CONTRACT.indexOf("{", start);
  const close = CONTRACT.indexOf("}", open);
  if (start < 0 || open < 0 || close < 0) throw new Error(`${selector} is not declared`);
  return Object.fromEntries(
    [...CONTRACT.slice(open + 1, close).matchAll(/^\s*(--[\w-]+):\s*(#[\da-f]{6});/gim)]
      .map((match) => [match[1] ?? "", match[2] ?? ""]),
  );
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

function contrast(first: string, second: string): number {
  const [lighter = 0, darker = 0] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function colour(tokens: Readonly<Record<string, string>>, name: string): string {
  const value = tokens[name];
  if (value === undefined) throw new Error(`${name} is missing from a shipped theme`);
  return value;
}

describe("the design-token contract", () => {
  it("agrees with presence.ts about when a name label fades", () => {
    // §7.5: ~3s of stillness. CSS delays the fade; presence.ts decides when a caret counts
    // as idle. If these two ever disagree, a label fades while the code still calls it
    // active — visible, subtle, and nothing else in the suite would catch it.
    expect(token("--presence-label-idle")).toBe(`${DEFAULT_IDLE_TIMINGS.labelAfterMs / 1000}s`);
  });

  it("keeps the touch-target floor at the 44px SPEC §8.3 requires", () => {
    // A rem-based token is only 44px while the root font size is 16px, which is the
    // assumption every other length in the contract already makes.
    expect(token("--touch-target-min")).toBe("2.75rem");
  });

  it("uses the WCAG contrast calculation the gate claims to use", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21);
    expect(contrast("#123456", "#123456")).toBeCloseTo(1);
  });

  it.each([
    ["light", ':root[data-theme="memberberry-light"]'],
    ["dark", ':root[data-theme="memberberry-dark"]'],
    ["pastel", ':root[data-theme="memberberry-pastel"]'],
  ] as const)("keeps body text and UI labels at WCAG AA contrast in %s mode", (_name, selector) => {
    const tokens = theme(selector);
    const surfaces = ["--surface-canvas", "--surface-note", "--surface-raised", "--surface-sunken"];
    const foregrounds = [
      "--text-primary",
      "--text-muted",
      "--accent-primary",
      "--state-warning",
      "--state-danger",
      "--state-conflict",
      "--series-0",
      "--series-1",
      "--series-2",
      "--series-3",
      "--series-4",
      "--series-5",
    ];
    const failures = foregrounds.flatMap((foreground) =>
      surfaces
        .map((surface) => ({
          pair: `${foreground} on ${surface}`,
          ratio: contrast(colour(tokens, foreground), colour(tokens, surface)),
        }))
        .filter(({ ratio }) => ratio < 4.5),
    );
    expect(failures).toEqual([]);
  });

  it.each([
    ["light", ':root[data-theme="memberberry-light"]'],
    ["dark", ':root[data-theme="memberberry-dark"]'],
    ["pastel", ':root[data-theme="memberberry-pastel"]'],
  ] as const)("keeps focus chrome and presence labels visible in %s mode", (_name, selector) => {
    const tokens = theme(selector);
    const focusFailures = ["--surface-canvas", "--surface-note", "--surface-raised"]
      .map((surface) => ({
        pair: `--focus-ring on ${surface}`,
        ratio: contrast(colour(tokens, "--focus-ring"), colour(tokens, surface)),
      }))
      .filter(({ ratio }) => ratio < 3);
    const labelFailures = Array.from({ length: 6 }, (_, index) => ({
      pair: `--presence-label on --series-${index}`,
      ratio: contrast(colour(tokens, "--presence-label"), colour(tokens, `--series-${index}`)),
    })).filter(({ ratio }) => ratio < 4.5);
    expect([...focusFailures, ...labelFailures]).toEqual([]);
  });
});
