import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  addSection,
  addTask,
  endAt,
  ensureId,
  isRefused,
  link,
  moveTask,
  moveTo,
  stepTarget,
  nameProblem,
  remove,
  renameLine,
  setColor,
  setEndKind,
  setOption,
  setSectionColor,
  setEnd,
  setFlag,
  setProgress,
  setStart,
  setTitle,
  type Outcome,
} from "./edit.js";
import { formatDay, parseChart, parseDay, schedule, serializeChart, type Chart, type Task } from "./model.js";

const SEED = 20261109;
const TODAY = parseDay("2026-11-01") ?? 0;
const PLAN = [
  "gantt",
  "    title Plan",
  "    dateFormat YYYY-MM-DD",
  "    section Design",
  "    Wireframes :done, wf, 2026-11-02, 5d",
  "    Visual design :vd, after wf, 8d",
  "    Review :2d",
].join("\n");

const chart = (source = PLAN): Chart => parseChart(source);
const ok = (outcome: Outcome): Chart => {
  if (isRefused(outcome)) throw new Error(outcome.refused);
  return outcome;
};
const task = (c: Chart, name: string): Task => {
  const found = c.lines.find((line): line is Task => line.kind === "task" && line.name === name);
  if (found === undefined) throw new Error(`no task ${name}`);
  return found;
};
const text = (c: Chart): string[] => serializeChart(c).split("\n");
const at = (c: Chart, name: string): [string, string] => {
  const placed = schedule(c, TODAY).get(task(c, name).key);
  return [formatDay(placed?.start ?? 0), formatDay(placed?.end ?? 0)];
};

describe("edits keep untouched lines byte-for-byte", () => {
  it("rewrites only the renamed task's line", () => {
    const c = chart();
    const before = text(c);
    const after = text(ok(renameLine(c, task(c, "Review").key, "Final review")));
    expect(after.filter((line, index) => line !== before[index])).toEqual(["    Final review :2d"]);
  });
});

describe("moveTo", () => {
  it("moves a dated task and an end date with it", () => {
    const c = chart("gantt\n  A :a, 2026-11-02, 2026-11-05");
    const moved = moveTo(c, task(c, "A").key, (parseDay("2026-11-04") ?? 0), TODAY);
    expect([text(ok(moved.chart))[1], moved.pinned]).toEqual(["    A :a, 2026-11-04, 2026-11-07", false]);
  });

  it("pins a dependent task to the new date, drops its dependency and says so", () => {
    const c = chart();
    const moved = moveTo(c, task(c, "Visual design").key, (parseDay("2026-11-10") ?? 0), TODAY);
    expect([text(ok(moved.chart))[5], moved.pinned]).toEqual(["    Visual design :vd, 2026-11-10, 8d", true]);
  });

  it("leaves the chart alone when the task does not move", () => {
    const c = chart();
    expect(moveTo(c, task(c, "Wireframes").key, (parseDay("2026-11-02") ?? 0), TODAY).chart).toBe(c);
  });
});

describe("endAt", () => {
  it("changes a length in days", () => {
    const c = chart();
    const next = ok(endAt(c, task(c, "Wireframes").key, (parseDay("2026-11-10") ?? 0), TODAY));
    expect(text(next)[4]).toBe("    Wireframes :done, wf, 2026-11-02, 8d");
  });

  it("counts only working days under excludes weekends", () => {
    const c = chart("gantt\n  excludes weekends\n  A :2026-11-06, 1d");
    const next = ok(endAt(c, task(c, "A").key, (parseDay("2026-11-11") ?? 0), TODAY));
    expect([text(next)[2], at(next, "A")]).toEqual(["  A :2026-11-06, 3d".replace("  A", "    A"), ["2026-11-06", "2026-11-11"]]);
  });

  it("never makes a task shorter than a day, and refuses a milestone", () => {
    const c = chart("gantt\n  A :2026-11-06, 4d\n  M :milestone, 2026-11-06, 0d");
    const shortened = ok(endAt(c, task(c, "A").key, (parseDay("2026-11-01") ?? 0), TODAY));
    expect([text(shortened)[1], endAt(c, task(c, "M").key, 0, TODAY)]).toEqual(["    A :2026-11-06, 1d", { refused: "A milestone has no length." }]);
  });
});

describe("link and ensureId", () => {
  it("gives the source an id and makes the target start after it", () => {
    const c = chart("gantt\n  Design work :2026-11-02, 3d\n  Build :2026-11-01, 4d");
    const next = ok(link(c, task(c, "Design work").key, task(c, "Build").key, TODAY));
    expect([text(next).slice(1), at(next, "Build")]).toEqual([
      ["    Design work :design-work, 2026-11-02, 3d", "    Build :after design-work, 4d"],
      ["2026-11-05", "2026-11-09"],
    ]);
  });

  it("gives a one-field task an explicit start after the task above before naming it", () => {
    const c = chart();
    const named = ensureId(c, task(c, "Review").key, TODAY);
    if ("refused" in named) throw new Error(named.refused);
    expect([text(named.chart)[6], at(named.chart, "Review")]).toEqual(["    Review :review, after vd, 2d", at(c, "Review")]);
  });

  it("refuses a link that would loop", () => {
    const c = chart();
    expect(link(c, task(c, "Visual design").key, task(c, "Wireframes").key, TODAY)).toEqual({ refused: "That would make the tasks depend on each other in a loop." });
  });

  it("refuses a task starting after itself", () => {
    const c = chart();
    const key = task(c, "Wireframes").key;
    expect(link(c, key, key, TODAY)).toEqual({ refused: "A task cannot start after itself." });
  });
});

describe("setStart and setEnd", () => {
  it("refuses an unknown id", () => {
    const c = chart();
    expect(setStart(c, task(c, "Review").key, { kind: "after", ids: ["nope"] })).toEqual({ refused: "No task has the id nope." });
  });

  it("refuses the one-field form for a task with an id", () => {
    const c = chart();
    expect(setStart(c, task(c, "Wireframes").key, { kind: "previous" })).toEqual({ refused: "A task with an id needs its own start." });
  });

  it("refuses a negative or fractional length", () => {
    const c = chart();
    const key = task(c, "Review").key;
    expect([setEnd(c, key, { kind: "days", count: -1 }), setEnd(c, key, { kind: "weeks", count: 1.5 })]).toEqual([
      { refused: "A length is a whole number of hours, days or weeks." },
      { refused: "A length is a whole number of hours, days or weeks." },
    ]);
  });
});

describe("tags", () => {
  it("sets progress without losing other tags", () => {
    const start = chart();
    const c = ok(setFlag(start, task(start, "Wireframes").key, "crit", true));
    const next = ok(setProgress(c, task(c, "Wireframes").key, "active"));
    expect(task(next, "Wireframes").tags).toEqual(["active", "crit"]);
  });

  it("makes a milestone zero days long and gives a day back when it stops being one", () => {
    const c = chart();
    const key = task(c, "Review").key;
    const milestone = ok(setFlag(c, key, "milestone", true));
    const back = ok(setFlag(milestone, key, "milestone", false));
    expect([text(milestone)[6], text(back)[6]]).toEqual(["    Review :milestone, 0d", "    Review :1d"]);
  });
});

describe("add and remove", () => {
  it("adds a five-day task starting where the chosen task ends", () => {
    const c = chart();
    const added = addTask(c, task(c, "Wireframes").key, TODAY);
    expect(text(added.chart)[5]).toBe("    New task :2026-11-07, 5d");
  });

  it("adds a section", () => {
    expect(text(addSection(chart(), null).chart).at(-1)).toBe("    section New section");
  });

  it("pins a task that depended on a removed one where it was", () => {
    const c = chart();
    const next = remove(c, task(c, "Wireframes").key, TODAY);
    expect([text(next)[4], at(next, "Visual design")]).toEqual(["    Visual design :vd, 2026-11-07, 8d", at(c, "Visual design")]);
  });

  it("pins the task below a removed one when it started right after it", () => {
    const c = chart();
    const next = remove(c, task(c, "Visual design").key, TODAY);
    expect([text(next)[5], at(next, "Review")]).toEqual(["    Review :2026-11-15, 2d", at(c, "Review")]);
  });
});

describe("moveTask", () => {
  const PHASES = [
    "gantt",
    "    dateFormat YYYY-MM-DD",
    "    section Design",
    "    Wireframes :wf, 2026-11-02, 5d",
    "    Mockups :3d",
    "    Review :2d",
    "    section Build",
    "    Frontend :2026-11-20, 4d",
    "    Backend :2d",
  ].join("\n");
  const key = (c: Chart, name: string) => task(c, name).key;
  const dates = (c: Chart) => Object.fromEntries(c.lines.filter((line): line is Task => line.kind === "task").map((t) => [t.name, at(c, t.name)]));

  it("moves a task into another phase without changing any date", () => {
    const c = chart(PHASES);
    const next = ok(moveTask(c, key(c, "Mockups"), key(c, "Backend"), TODAY));
    expect([text(next).slice(2), dates(next)]).toEqual([[
      "    section Design",
      "    Wireframes :wireframes, 2026-11-02, 5d".replace("wireframes, ", "wf, "),
      "    Review :after mockups, 2d",
      "    section Build",
      "    Frontend :2026-11-20, 4d",
      "    Mockups :mockups, after wf, 3d",
      "    Backend :after frontend, 2d",
    ].map((line) => line.replace("    Frontend :2026-11-20, 4d", "    Frontend :frontend, 2026-11-20, 4d")), dates(c)]);
  });

  it("moves a task to the end of the chart", () => {
    const c = chart(PHASES);
    const next = ok(moveTask(c, key(c, "Wireframes"), null, TODAY));
    expect([text(next).at(-1), dates(next)]).toEqual(["    Wireframes :wf, 2026-11-02, 5d", dates(c)]);
  });

  it("changes nothing for a move to where the task already is", () => {
    const c = chart(PHASES);
    expect(moveTask(c, key(c, "Mockups"), key(c, "Review"), TODAY)).toBe(c);
  });

  it("refuses a target row that does not exist", () => {
    const c = chart(PHASES);
    expect(moveTask(c, key(c, "Mockups"), "gone", TODAY)).toEqual({ refused: "That row no longer exists." });
  });

  it("steps a task up and down, crossing a section line into the next phase", () => {
    const c = chart(PHASES);
    const sections = c.lines.filter((line) => line.kind === "section");
    const build = sections[1]?.key;
    expect([
      stepTarget(c, key(c, "Review"), "down"),
      stepTarget(c, key(c, "Frontend"), "up"),
      stepTarget(c, key(c, "Backend"), "down"),
      stepTarget(c, key(c, "Mockups"), "up"),
    ]).toEqual([key(c, "Frontend"), build, undefined, key(c, "Wireframes")]);
  });

  it("never changes a date, whatever is moved where", () => {
    fc.assert(fc.property(fc.array(fc.tuple(fc.nat(), fc.nat()), { maxLength: 15 }), (moves) => {
      let c = chart(PHASES);
      const before = dates(c);
      for (const [from, to] of moves) {
        const tasks = c.lines.filter((line): line is Task => line.kind === "task");
        const rowsNow = c.lines.filter((line) => line.kind !== "raw");
        const mover = tasks[from % tasks.length];
        const target = to % (rowsNow.length + 1);
        if (mover === undefined) continue;
        const outcome = moveTask(c, mover.key, rowsNow[target]?.key ?? null, TODAY);
        if (!isRefused(outcome)) c = outcome;
      }
      const reparsed = parseChart(serializeChart(c));
      const errors = [...schedule(c, TODAY).values()].filter((p) => p.error !== null);
      // why: sorted, because a move reorders the lines and so the object's keys.
      const sorted = (value: Record<string, unknown>) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
      return sorted(dates(c)) === sorted(before) && reparsed.readOnly === null && errors.length === 0;
    }), { seed: SEED, numRuns: 300 });
  });
});

describe("setEndKind", () => {
  const kinds = (source: string, kind: "date" | "hours" | "days" | "weeks") => {
    const c = chart(source);
    const next = ok(setEndKind(c, task(c, "A").key, kind, TODAY));
    return [text(next)[1], at(next, "A")];
  };

  it("switches days to hours, weeks and an end date, keeping the bar", () => {
    const source = "gantt\n    A :2026-11-02, 14d";
    expect([kinds(source, "hours"), kinds(source, "weeks"), kinds(source, "date")]).toEqual([
      ["    A :2026-11-02, 336h", ["2026-11-02", "2026-11-16"]],
      ["    A :2026-11-02, 2w", ["2026-11-02", "2026-11-16"]],
      ["    A :2026-11-02, 2026-11-16", ["2026-11-02", "2026-11-16"]],
    ]);
  });

  it("rounds hours up to whole days and an end date to the next whole day", () => {
    expect([kinds("gantt\n    A :2026-11-02, 36h", "days")[0], kinds("gantt\n    A :2026-11-02, 4h", "date")[0]])
      .toEqual(["    A :2026-11-02, 2d", "    A :2026-11-02, 2026-11-03"]);
  });

  it("never makes a length shorter than one of its unit", () => {
    expect(kinds("gantt\n    A :2026-11-02, 2d", "weeks")[0]).toBe("    A :2026-11-02, 1w");
  });

  it("refuses a milestone and leaves an unchanged kind alone", () => {
    const c = chart("gantt\n    A :milestone, 2026-11-02, 0d\n    B :2026-11-02, 2d");
    expect([setEndKind(c, task(c, "A").key, "hours", TODAY), setEndKind(c, task(c, "B").key, "days", TODAY)])
      .toEqual([{ refused: "A milestone has no length." }, c]);
  });
});

describe("hours", () => {
  it("resizes an hours task in hours", () => {
    const c = chart("gantt\n    A :2026-11-02, 4h");
    expect(text(ok(endAt(c, task(c, "A").key, (parseDay("2026-11-03") ?? 0), TODAY)))[1]).toBe("    A :2026-11-02, 24h");
  });

  it("pins a task that started mid-day to the start of the day it is moved to", () => {
    const c = chart("gantt\n    A :a, 2026-11-02, 4h\n    B :after a, 1d");
    const moved = moveTo(c, task(c, "B").key, (parseDay("2026-11-04") ?? 0) + 0.5, TODAY);
    expect([text(ok(moved.chart))[2], moved.pinned]).toEqual(["    B :2026-11-04, 1d", true]);
  });
});

describe("setSectionColor", () => {
  const section = (c: Chart, name: string) => {
    const found = c.lines.find((line) => line.kind === "section" && line.name === name);
    if (found === undefined) throw new Error(`no phase ${name}`);
    return found.key;
  };

  it("writes a phase colour line with the colour lines, and returns to automatic with null", () => {
    const c = chart();
    const green = ok(setSectionColor(c, section(c, "Design"), { kind: "note", name: "green" }));
    const auto = ok(setSectionColor(green, section(green, "Design"), null));
    expect([text(green).slice(0, 5), green.sectionColors.get("Design"), auto.sectionColors.size, text(auto).some((line) => line.includes("section-color"))]).toEqual([
      ["gantt", "    title Plan", "    dateFormat YYYY-MM-DD", "    %% section-color green Design", "    section Design"],
      { kind: "note", name: "green" }, 0, false,
    ]);
  });

  it("keeps a phase's colour when it is renamed", () => {
    const base = chart();
    const c = ok(setSectionColor(base, section(base, "Design"), { kind: "hex", hex: "#3a7bd5" }));
    const renamed = ok(renameLine(c, section(c, "Design"), "Discovery"));
    expect([text(renamed).filter((line) => line.includes("section-color")), renamed.sectionColors.get("Discovery")])
      .toEqual([["    %% section-color #3a7bd5 Discovery"], { kind: "hex", hex: "#3a7bd5" }]);
  });

  it("drops a removed phase's colour", () => {
    const base = chart();
    const c = ok(setSectionColor(base, section(base, "Design"), { kind: "note", name: "green" }));
    const next = remove(c, section(c, "Design"), TODAY);
    expect([next.sectionColors.size, text(next).some((line) => line.includes("section-color"))]).toEqual([0, false]);
  });

  it("keeps task and phase colour lines together", () => {
    const base = chart();
    const tasked = ok(setColor(base, task(base, "Wireframes").key, { kind: "note", name: "red" }, TODAY));
    const both = ok(setSectionColor(tasked, section(tasked, "Design"), { kind: "note", name: "blue" }));
    expect(text(both).slice(3, 6)).toEqual(["    %% color wf red", "    %% section-color blue Design", "    section Design"]);
  });
});

describe("setColor", () => {
  it("writes a colour line after the directives and before the first section", () => {
    const c = chart();
    const next = ok(setColor(c, task(c, "Wireframes").key, { kind: "note", name: "green" }, TODAY));
    expect([text(next).slice(0, 5), next.colors.get("wf")]).toEqual([
      ["gantt", "    title Plan", "    dateFormat YYYY-MM-DD", "    %% color wf green", "    section Design"],
      { kind: "note", name: "green" },
    ]);
  });

  it("replaces a task's colour rather than adding a second line, and clears it with null", () => {
    const c = chart();
    const key = task(c, "Wireframes").key;
    const green = ok(setColor(c, key, { kind: "note", name: "green" }, TODAY));
    const hex = ok(setColor(green, key, { kind: "hex", hex: "#3a7bd5" }, TODAY));
    const cleared = ok(setColor(hex, key, null, TODAY));
    expect([text(hex).filter((line) => line.includes("%% color")), text(cleared).some((line) => line.includes("%% color")), cleared.colors.size])
      .toEqual([["    %% color wf #3a7bd5"], false, 0]);
  });

  it("gives a task without an id one before colouring it, keeping its dates", () => {
    const c = chart();
    const next = ok(setColor(c, task(c, "Review").key, { kind: "note", name: "red" }, TODAY));
    expect([text(next).filter((line) => line.includes("Review") || line.includes("%% color")), at(next, "Review")])
      .toEqual([["    %% color review red", "    Review :review, after vd, 2d"], at(c, "Review")]);
  });

  it("drops a removed task's colour", () => {
    const base = chart();
    const c = ok(setColor(base, task(base, "Wireframes").key, { kind: "note", name: "green" }, TODAY));
    const next = remove(c, task(c, "Wireframes").key, TODAY);
    expect([text(next).some((line) => line.includes("%% color")), next.colors.size]).toEqual([false, 0]);
  });

  it("keeps colours when tasks move between phases", () => {
    const base = chart();
    const c = ok(setColor(base, task(base, "Wireframes").key, { kind: "note", name: "green" }, TODAY));
    const moved = ok(moveTask(c, task(c, "Wireframes").key, null, TODAY));
    expect(parseChart(serializeChart(moved)).colors.get("wf")).toEqual({ kind: "note", name: "green" });
  });
});

describe("names and titles", () => {
  it.each([
    ["", "A name cannot be empty."],
    ["Phase: one", "A name cannot contain : # or ;."],
    ["section two", "A name cannot start with “section”."],
    ["%% hidden", "A name cannot start with %%."],
  ])("refuses the name %j", (name, problem) => {
    expect(nameProblem(name)).toBe(problem);
  });

  it("sets, replaces and removes the title line", () => {
    const added = ok(setTitle(chart("gantt\n  A :2026-11-02, 1d"), "Roadmap"));
    const removed = ok(setTitle(added, ""));
    expect([text(added)[1], text(removed)]).toEqual(["    title Roadmap", ["gantt", "  A :2026-11-02, 1d"]]);
  });
});

describe("any sequence of edits", () => {
  it("leaves text that parses back as an editable chart with the same tasks", () => {
    const op = fc.oneof(
      fc.record({ kind: fc.constant("rename" as const), at: fc.nat(), name: fc.stringMatching(/^[A-Z][a-z]{1,8}$/u) }),
      fc.record({ kind: fc.constant("move" as const), at: fc.nat(), by: fc.integer({ min: -20, max: 20 }) }),
      fc.record({ kind: fc.constant("end" as const), at: fc.nat(), by: fc.integer({ min: -20, max: 20 }) }),
      fc.record({ kind: fc.constant("link" as const), at: fc.nat(), to: fc.nat() }),
      fc.record({ kind: fc.constant("flag" as const), at: fc.nat(), on: fc.boolean() }),
      fc.record({ kind: fc.constant("unit" as const), at: fc.nat(), unit: fc.constantFrom("date" as const, "hours" as const, "days" as const, "weeks" as const) }),
      fc.record({ kind: fc.constant("add" as const), at: fc.nat() }),
      fc.record({ kind: fc.constant("remove" as const), at: fc.nat() }),
    );
    fc.assert(fc.property(fc.array(op, { maxLength: 25 }), (ops) => {
      let c = chart();
      for (const step of ops) {
        const tasks = c.lines.filter((line): line is Task => line.kind === "task");
        const pick = tasks[step.at % Math.max(1, tasks.length)];
        if (pick === undefined && step.kind !== "add") continue;
        const placed = pick === undefined ? undefined : schedule(c, TODAY).get(pick.key);
        let next: Outcome = c;
        if (step.kind === "rename" && pick !== undefined) next = renameLine(c, pick.key, step.name);
        if (step.kind === "move" && pick !== undefined && placed !== undefined) next = moveTo(c, pick.key, placed.start + step.by, TODAY).chart;
        if (step.kind === "end" && pick !== undefined && placed !== undefined) next = endAt(c, pick.key, placed.end + step.by, TODAY);
        if (step.kind === "link" && pick !== undefined) {
          const target = tasks[step.to % tasks.length];
          if (target !== undefined) next = link(c, pick.key, target.key, TODAY);
        }
        if (step.kind === "flag" && pick !== undefined) next = setFlag(c, pick.key, "milestone", step.on);
        if (step.kind === "unit" && pick !== undefined) next = setEndKind(c, pick.key, step.unit, TODAY);
        if (step.kind === "add") next = addTask(c, pick?.key ?? null, TODAY).chart;
        if (step.kind === "remove" && pick !== undefined) next = remove(c, pick.key, TODAY);
        if (!isRefused(next)) c = next;
      }
      const again = parseChart(serializeChart(c));
      const shape = (x: Chart) => x.lines.filter((line): line is Task => line.kind === "task").map((t) => [t.name, t.tags, t.id, t.start, t.end]);
      const errors = [...schedule(c, TODAY).values()].filter((p) => p.error !== null);
      return again.readOnly === null && JSON.stringify(shape(again)) === JSON.stringify(shape(c)) && errors.length === 0;
    }), { seed: SEED, numRuns: 300 });
  });
});

describe("setOption", () => {
  it("writes a chart option as a comment line and reads it back", () => {
    const next = ok(setOption(chart(), "phases", "row"));
    expect([text(next).filter((line) => line.includes("option")), next.options.phases, parseChart(serializeChart(next)).options.phases])
      .toEqual([["    %% option phases row"], "row", "row"]);
  });

  it("replaces an existing line for the same option rather than adding another", () => {
    const next = ok(setOption(ok(setOption(chart(), "rows", "zoomed")), "rows", "fixed"));
    const twice = ok(setOption(ok(setOption(chart(), "phaseFill", "name")), "phaseFill", "name"));
    expect([text(next).filter((line) => line.includes("option")), text(twice).filter((line) => line.includes("option"))])
      .toEqual([[], ["    %% option phase-fill name"]]);
  });

  it("keeps the other options and every other line untouched", () => {
    const both = ok(setOption(ok(setOption(chart(), "rows", "zoomed")), "phases", "row"));
    expect([text(both).filter((line) => !line.includes("option")), both.options]).toEqual([PLAN.split("\n"), { phases: "row", phaseFill: "whole", rows: "zoomed", height: "full" }]);
  });

  it("refuses a value the option does not have, and changes nothing", () => {
    const outcome = setOption(chart(), "rows", "huge" as never);
    expect(isRefused(outcome)).toBe(true);
  });
});
