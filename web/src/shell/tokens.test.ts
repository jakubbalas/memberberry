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
});
