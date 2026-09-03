/**
 * Assembling the report, and the two things it must never do quietly: measure something no
 * budget covers, and leave a budgeted metric unmeasured while still reporting a pass.
 */

import { describe, expect, it } from "vitest";

import { parseBreaches } from "./breaches.js";
import { BUDGETS, PENDING, budget, budgetFor } from "./budgets.js";
import { buildReport, formatReport, reduce, unmeasured } from "./report.js";

const NO_BREACHES = parseBreaches({});

describe("the budget table", () => {
  it("gives every budget a unique id", () => {
    const ids = [...BUDGETS, ...PENDING].map((entry) => entry.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never budgets mobile more tightly than desktop", () => {
    // §21.2's shape: mobile is the constraint, so its allowance is equal or looser. A row
    // where mobile were stricter would be a transcription error, and this is the only place
    // that would notice.
    for (const row of BUDGETS) {
      expect(row.mobile, `${row.id} budgets mobile tighter than desktop`).toBeGreaterThanOrEqual(
        row.desktop,
      );
    }
  });

  it("looks a budget up by id and device", () => {
    expect(budgetFor("critical-bundle-gzip", "mobile")).toBe(350 * 1024);
    expect(budgetFor("keystroke-to-paint", "desktop")).toBe(16);
    expect(budgetFor("nothing-like-this", "mobile")).toBeUndefined();
    expect(budget("nothing-like-this")).toBeUndefined();
  });
});

describe("reducing samples the way a metric asks", () => {
  it("takes a median, a p95 or a max", () => {
    const samples = [1, 2, 3, 4, 100];

    expect(reduce(samples, "median")).toBe(3);
    expect(reduce(samples, "p95")).toBe(100);
    expect(reduce(samples, "max")).toBe(100);
  });
});

describe("building the report", () => {
  it("judges each measurement against its own device's budget", () => {
    const report = buildReport(
      [
        // 16 ms is the budget on both, so this passes on desktop and mobile alike.
        { id: "keystroke-to-paint", device: "desktop", value: 12, samples: 60 },
        // 90 ms is inside mobile's 200 ms INP budget but outside desktop's 100 ms.
        { id: "inp", device: "mobile", value: 90, samples: 60 },
        { id: "inp", device: "desktop", value: 120, samples: 60 },
      ],
      NO_BREACHES,
    );

    expect(report.rows.map((row) => row.verdict.status)).toEqual(["ok", "ok", "new-breach"]);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.id).toBe("inp");
    expect(report.failures[0]?.device).toBe("desktop");
  });

  it("applies a recorded breach to the device it was recorded for and no other", () => {
    const breaches = parseBreaches({
      "open-note": { recorded: { mobile: 400 }, reason: "recorded for mobile only" },
    });

    const report = buildReport(
      [
        { id: "open-note", device: "mobile", value: 390, samples: 12 },
        { id: "open-note", device: "desktop", value: 390, samples: 12 },
      ],
      breaches,
    );

    expect(report.rows[0]?.verdict.status).toBe("known");
    expect(report.rows[1]?.verdict.status).toBe("new-breach");
  });

  it("refuses a measurement no budget covers", () => {
    // The failure this prevents: a metric id typed one way in `measure.ts` and another in
    // `budgets.ts`. Skipping it would leave a metric that looks measured and is not gated.
    expect(() =>
      buildReport([{ id: "keystroke-topaint", device: "mobile", value: 1, samples: 1 }], NO_BREACHES),
    ).toThrow(/no budget for it/);
  });

  it("carries the metric's §21.2 qualifier into the row, so a p95 is labelled one", () => {
    const report = buildReport(
      [{ id: "keystroke-to-paint", device: "mobile", value: 1, samples: 1 }],
      NO_BREACHES,
    );

    expect(report.rows[0]?.metric).toContain("(p95)");
  });

  it("formats each value in its own unit", () => {
    const report = buildReport(
      [
        { id: "critical-bundle-gzip", device: "mobile", value: 350 * 1024, samples: 1 },
        { id: "open-note", device: "mobile", value: 44.4, samples: 12 },
      ],
      NO_BREACHES,
    );

    expect(report.rows[0]?.formatted).toBe("350.0 KB");
    expect(report.rows[1]?.formatted).toBe("44.4 ms");
  });
});

describe("holes in the harness", () => {
  it("names a budgeted metric that neither got measured nor is listed as pending", () => {
    const holes = unmeasured([]);

    expect(holes).toContain("cold-start-first-visit");
    // A pending metric is a known gap with a milestone, not a hole in this run.
    expect(holes).not.toContain("search");
  });

  it("counts holes per device, so a metric missing on one is not covered by the other", () => {
    // The failure this catches: `longest-task` measured on mobile and absent on desktop.
    // Pooling the rows made it look covered, and the missing half never appeared anywhere.
    const rows = buildReport(
      [{ id: "longest-task", device: "mobile", value: 20, samples: 5 }],
      NO_BREACHES,
    ).rows;

    expect(unmeasured(rows, "mobile")).not.toContain("longest-task");
    expect(unmeasured(rows, "desktop")).toContain("longest-task");
  });

  it("reports no holes once everything measurable was measured", () => {
    const rows = buildReport(
      BUDGETS.map((row) => ({ id: row.id, device: "mobile" as const, value: 1, samples: 1 })),
      NO_BREACHES,
    ).rows;

    expect(unmeasured(rows)).toEqual([]);
  });
});

describe("the printed table", () => {
  it("says out loud which budgets nothing measured and which cannot be measured yet", () => {
    const report = buildReport(
      [{ id: "open-note", device: "desktop", value: 40, samples: 12 }],
      NO_BREACHES,
      ["the server sent 1.4 MB uncompressed"],
    );

    const text = formatReport(report);

    expect(text).toContain("desktop");
    expect(text).toContain("NOT MEASURED");
    expect(text).toContain("cold-start-first-visit");
    expect(text).toContain("not measurable yet");
    // A pending metric has to carry the milestone that unblocks it, or the list is a shrug.
    expect(text).toContain("M9");
    expect(text).toContain("the server sent 1.4 MB uncompressed");
  });

  it("prints a caveat next to the number it qualifies", () => {
    const report = buildReport(
      [
        {
          id: "keystroke-to-paint",
          device: "mobile",
          value: 17,
          samples: 60,
          caveat: "double-rAF, reads one frame high",
        },
      ],
      NO_BREACHES,
    );

    expect(formatReport(report)).toContain("double-rAF, reads one frame high");
  });
});
