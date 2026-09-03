/**
 * The breach file's parser, which fails closed.
 *
 * The reason this has its own test file: every one of these cases is a way the gate could
 * stop gating without anyone noticing. A forgiving parser that skipped a malformed entry
 * would turn a typo into a silently disabled budget, which is the same class of mistake
 * AGENTS.md §3.1 refuses for permissions.
 */

import { describe, expect, it } from "vitest";

import { loadBreaches, parseBreaches, recordedFor } from "./breaches.js";

const VALID = {
  "critical-bundle-gzip": {
    recorded: { mobile: 1_000, desktop: 1_000 },
    reason: "because SPEC §21.1 says so",
  },
};

describe("parsing the breach file", () => {
  it("accepts a well-formed entry", () => {
    const breaches = parseBreaches(VALID);

    expect(recordedFor(breaches, "critical-bundle-gzip", "mobile")).toBe(1_000);
    expect(breaches["critical-bundle-gzip"]?.reason).toContain("§21.1");
  });

  it("returns nothing for a metric with no breach, and for a device the breach omits", () => {
    const breaches = parseBreaches({
      "open-note": { recorded: { mobile: 200 }, reason: "mobile only" },
    });

    expect(recordedFor(breaches, "open-note", "mobile")).toBe(200);
    // Not recorded for desktop, so desktop is still gated at the budget. This is the case
    // that makes a per-device ratchet worth having.
    expect(recordedFor(breaches, "open-note", "desktop")).toBeUndefined();
    expect(recordedFor(breaches, "quick-switcher", "mobile")).toBeUndefined();
  });

  it("refuses an entry with no reason", () => {
    expect(() => parseBreaches({ a: { recorded: { mobile: 1 } } })).toThrow(/reason/);
    expect(() => parseBreaches({ a: { recorded: { mobile: 1 }, reason: "  " } })).toThrow(
      /reason/,
    );
  });

  it("refuses an entry that records nothing, because it would gate nothing", () => {
    expect(() => parseBreaches({ a: { recorded: {}, reason: "why" } })).toThrow(/no values/);
  });

  it("refuses an unknown device class rather than ignoring it", () => {
    // A typo like `mobile:` → `moblie:` would otherwise leave mobile ungated while the file
    // looks like it covers both.
    expect(() =>
      parseBreaches({ a: { recorded: { moblie: 1 }, reason: "why" } }),
    ).toThrow(/unknown device class/);
  });

  it("refuses a value that is not a positive number", () => {
    for (const value of [0, -1, "1", null, Number.NaN]) {
      expect(() =>
        parseBreaches({ a: { recorded: { mobile: value }, reason: "why" } }),
      ).toThrow(/positive number/);
    }
  });

  it("refuses anything that is not an object of entries", () => {
    expect(() => parseBreaches([])).toThrow(/JSON object/);
    expect(() => parseBreaches(null)).toThrow(/JSON object/);
    expect(() => parseBreaches({ a: 1 })).toThrow(/must be an object/);
    expect(() => parseBreaches({ a: { reason: "why" } })).toThrow(/recorded/);
  });
});

describe("the repository's own breach file", () => {
  it("parses, so `make perf` cannot fail on its own configuration", () => {
    const breaches = loadBreaches(new URL("./breaches.json", import.meta.url).pathname);

    // The bundle breach is the one §21.1 records. If this ever becomes undefined it means
    // somebody fixed the bundle, which is good news that should arrive as a failing gate
    // asking for the entry to be deleted rather than as a quietly passing one.
    expect(recordedFor(breaches, "critical-bundle-gzip", "mobile")).toBeGreaterThan(0);
    expect(breaches["critical-bundle-gzip"]?.reason).toMatch(/wasm/i);
  });
});
