/**
 * The gate's arithmetic.
 *
 * This is the part of the harness that decides whether the build fails, and it is the part a
 * browser run is least able to check: a passing `make perf` says the numbers were within
 * budget, not that a breach would have been caught. So the ratchet is tested here, on numbers,
 * including the cases nobody wants to discover in CI — a new breach, a known one drifting
 * worse, and a stale entry left behind after a fix.
 */

import { describe, expect, it } from "vitest";

import { TOLERANCE, ceiling, format, judge, median, percentile } from "./verdict.js";

describe("judging a measurement", () => {
  it("passes a metric at or under budget", () => {
    expect(judge({ measured: 40, budget: 50, unit: "ms" }).status).toBe("ok");
    expect(judge({ measured: 50, budget: 50, unit: "ms" }).status).toBe("ok");
  });

  it("fails a breach nothing records, and says what to do about it", () => {
    const verdict = judge({ measured: 51, budget: 50, unit: "ms" });

    expect(verdict.status).toBe("new-breach");
    expect(verdict.fails).toBe(true);
    // The message has to name both options, because "record it" is a legitimate outcome and
    // a gate that only says "fix it" gets switched off.
    expect(verdict.detail).toContain("perf/breaches.json");
    expect(verdict.detail).toContain("§21.1");
  });

  it("passes a known breach that has not moved", () => {
    const verdict = judge({ measured: 100, budget: 50, unit: "bytes", recorded: 100 });

    expect(verdict.status).toBe("known");
    expect(verdict.fails).toBe(false);
    expect(verdict.detail).toContain("100");
  });

  it("fails a known breach that got worse than its tolerance allows", () => {
    // bytes are deterministic, so the tolerance is zero: one byte over is over.
    const verdict = judge({ measured: 101, budget: 50, unit: "bytes", recorded: 100 });

    expect(verdict.status).toBe("regressed");
    expect(verdict.fails).toBe(true);
  });

  it("allows a known timing breach to drift within the tolerance", () => {
    // 20% of 100 is 120, so 119 is noise and 121 is a regression. The distinction is the
    // whole reason the tolerance is per-unit rather than a single number.
    expect(judge({ measured: 119, budget: 50, unit: "ms", recorded: 100 }).status).toBe("known");
    expect(judge({ measured: 121, budget: 50, unit: "ms", recorded: 100 }).status).toBe(
      "regressed",
    );
  });

  it("reports a fixed byte breach as fatal so the stale entry gets deleted", () => {
    const verdict = judge({ measured: 40, budget: 50, unit: "bytes", recorded: 100 });

    expect(verdict.status).toBe("improved");
    // Fatal on purpose: a recorded breach nobody removes is a permanently loosened gate, and
    // a byte count that came under budget did so deterministically.
    expect(verdict.fails).toBe(true);
    expect(verdict.detail).toContain("Delete the entry");
  });

  it("reports a fixed timing breach without failing, because one sample is not proof", () => {
    const verdict = judge({ measured: 40, budget: 50, unit: "ms", recorded: 100 });

    expect(verdict.status).toBe("improved");
    expect(verdict.fails).toBe(false);
  });

  it("puts the ceiling exactly at the recorded value for a deterministic unit", () => {
    expect(ceiling(1_000, "bytes")).toBe(1_000);
    expect(ceiling(1_000, "ms")).toBe(1_200);
    expect(TOLERANCE.bytes).toBe(0);
  });
});

describe("reducing samples", () => {
  it("takes the percentile by nearest rank, never interpolating", () => {
    // Ten samples: p95 is rank ceil(9.5) - 1 = 9, the largest. An interpolating percentile
    // would return a value none of the samples took, which is the wrong answer to "did any
    // interaction miss the frame".
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100];

    expect(percentile(samples, 95)).toBe(100);
    expect(percentile(samples, 50)).toBe(5);
    expect(percentile(samples, 100)).toBe(100);
  });

  it("does not care what order the samples arrived in", () => {
    expect(percentile([9, 1, 5, 3, 7], 50)).toBe(percentile([1, 3, 5, 7, 9], 50));
  });

  it("takes the median of an even sample count as the lower middle, by the same rule", () => {
    expect(median([1, 2, 3, 4])).toBe(2);
  });

  it("refuses to invent a number from no samples", () => {
    expect(() => percentile([], 95)).toThrow(/no samples/);
  });

  it("refuses a percentile outside (0, 100]", () => {
    expect(() => percentile([1], 0)).toThrow(/not in/);
    expect(() => percentile([1], 101)).toThrow(/not in/);
  });
});

describe("formatting", () => {
  it("reads bytes as KB below a megabyte and MB above it", () => {
    expect(format(350 * 1024, "bytes")).toBe("350.0 KB");
    expect(format(2 * 1024 * 1024, "bytes")).toBe("2.00 MB");
  });

  it("keeps a decimal on a small duration and drops it on a large one", () => {
    // A 16 ms budget is decided in tenths; a 3 000 ms one is not.
    expect(format(16.4, "ms")).toBe("16.4 ms");
    expect(format(2_940.6, "ms")).toBe("2941 ms");
  });
});
