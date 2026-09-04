import { describe, expect, it } from "vitest";

import { parseNaturalDate, taskChips, toggledTaskAttributes, todayDate } from "./task-metadata.js";

const NOW = new Date(2026, 8, 1, 14, 30);

describe("parseNaturalDate", () => {
  it("parses the documented relative date forms", () => {
    expect(parseNaturalDate("tomorrow", NOW)?.value).toBe("2026-09-02");
    expect(parseNaturalDate("next friday", NOW)?.value).toBe("2026-09-04");
    expect(parseNaturalDate("in 3 days", NOW)?.value).toBe("2026-09-04");
  });

  it("accepts canonical dates and rejects ambiguous input", () => {
    expect(parseNaturalDate("2026-12-31", NOW)?.value).toBe("2026-12-31");
    expect(parseNaturalDate("soon", NOW)).toBeNull();
    expect(parseNaturalDate("2026-99-99", NOW)).toBeNull();
  });

  it("uses the local calendar day rather than UTC", () => {
    expect(todayDate(new Date(2026, 0, 2, 0, 5))).toBe("2026-01-02");
  });
});

describe("taskChips", () => {
  it("emits the metadata in the fixed serialization order of SPEC 10.1", () => {
    // Deliberately supplied out of order: the chips a reader sees must be the same sequence
    // as the markers in the file, whatever order the attributes happen to arrive in.
    const chips = taskChips({
      priority: "high",
      due: "2026-09-05",
      created: "2026-08-28",
      scheduled: "2026-09-03",
      start: "2026-09-01",
      status: "todo",
      unknown: [],
    });

    expect(chips.map((chip) => chip.field)).toEqual([
      "created",
      "start",
      "scheduled",
      "due",
      "priority",
    ]);
  });

  it("gives every chip a value and an accessible name that stands alone", () => {
    const chips = taskChips({ due: "2026-09-05", priority: "high" });

    expect(chips[0]).toEqual({
      field: "due",
      label: "Due",
      value: "2026-09-05",
      description: "Due 2026-09-05",
    });
    expect(chips[1]).toEqual({
      field: "priority",
      label: "Priority",
      value: "High",
      description: "Priority high",
    });
  });

  it("shows a task with no metadata no chips at all", () => {
    expect(taskChips({ status: "todo", unknown: [] })).toEqual([]);
  });

  it("renders an unmodelled marker verbatim rather than dropping or guessing at it", () => {
    // SPEC 10.4: recurrence is deferred, and a `\u{1F501}` found in an imported file is
    // preserved and shown inert. Interpreting it here would be inventing the feature.
    const chips = taskChips({ status: "todo", unknown: ["\u{1F501} every week"] });

    expect(chips).toHaveLength(1);
    expect(chips[0]?.field).toBe("unknown");
    expect(chips[0]?.value).toBe("\u{1F501} every week");
    expect(chips[0]?.label).toBe("");
    expect(chips[0]?.description).toContain("not interpreted");
  });

  it("ignores attribute values that are absent, empty or the wrong shape", () => {
    // Every date attribute is optional in `schema.json`, so `null` is the normal case for
    // most of them and a chip reading "Due null" is the failure this rules out.
    expect(taskChips({ due: null, priority: undefined, unknown: null })).toEqual([]);
    expect(taskChips({ due: "", unknown: ["", 7] })).toEqual([]);
  });
});

describe("toggledTaskAttributes", () => {
  it("completes an open task and stamps today as the completion date", () => {
    expect(toggledTaskAttributes({ status: "todo" }, NOW)).toEqual({
      status: "done",
      done: "2026-09-01",
    });
  });

  it("reopens a completed task and clears the date rather than leaving a stale one", () => {
    expect(toggledTaskAttributes({ status: "done", done: "2026-08-01" }, NOW)).toEqual({
      status: "todo",
      done: null,
    });
  });

  it("completes a cancelled task without deciding what its cancellation meant", () => {
    // `[-]` is reached by writing it, not by a checkbox, so the `\u{274C}` date is the
    // user's and is left alone. Clearing it here would be silently discarding their data.
    const next = toggledTaskAttributes({ status: "cancelled", cancelled: "2026-08-20" }, NOW);

    expect(next.status).toBe("done");
    expect(next).not.toHaveProperty("cancelled");
  });
});
