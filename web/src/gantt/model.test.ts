import { readdirSync, readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { formatDay, parseChart, parseDay, schedule, serializeChart, type Task } from "./model.js";

const SEED = 20261109;
const day = (text: string): number => {
  const parsed = parseDay(text);
  if (parsed === null) throw new Error(`bad test date ${text}`);
  return parsed;
};
const tasks = (source: string): Task[] => parseChart(source).lines.filter((line): line is Task => line.kind === "task");
const placedOf = (source: string, today = day("2026-01-01")) => {
  const chart = parseChart(source);
  const placed = schedule(chart, today);
  return Object.fromEntries(tasks(source).map((task, index) => {
    const at = placed.get(chart.lines.filter((line) => line.kind === "task")[index]?.key ?? "");
    return [task.name, at === undefined ? null : [formatDay(at.start), formatDay(at.end), at.error]];
  }));
};

const PLAN = [
  "gantt",
  "    title Website relaunch",
  "    dateFormat YYYY-MM-DD",
  "    %% the design stream",
  "    section Design",
  "    Wireframes :done, wf, 2026-11-02, 5d",
  "    Visual design :active, vd, after wf, 8d",
  "    section Build",
  "    Frontend :fe, after vd, 2w",
  "    Polish :3d",
  "    Launch :milestone, after fe, 0d",
].join("\n");

describe("parseChart", () => {
  it("reads sections, tasks, tags, ids, starts and ends", () => {
    expect(tasks(PLAN).map((task) => [task.name, task.tags, task.id, task.start.kind, task.end])).toEqual([
      ["Wireframes", ["done"], "wf", "date", { kind: "days", count: 5 }],
      ["Visual design", ["active"], "vd", "after", { kind: "days", count: 8 }],
      ["Frontend", [], "fe", "after", { kind: "weeks", count: 2 }],
      ["Polish", [], null, "previous", { kind: "days", count: 3 }],
      ["Launch", ["milestone"], null, "after", { kind: "days", count: 0 }],
    ]);
  });

  it("is editable for the supported subset and keeps the title", () => {
    const chart = parseChart(PLAN);
    expect([chart.readOnly, chart.title, chart.lines.filter((line) => line.kind === "section").length]).toEqual([null, "Website relaunch", 2]);
  });

  it.each([
    ["dateFormat DD-MM-YYYY", "dates use the format DD-MM-YYYY"],
    ["excludes 2026-12-25", "it excludes 2026-12-25"],
    ["inclusiveEndDates", "it uses inclusiveEndDates"],
    ["Task :2026-01-01, 30m", "\"30m\" is not a date or a whole number of hours, days or weeks"],
    ["Task :a, b, c, d", "task \"Task\" has 4 fields"],
    ["Task :t, 2026-01-01, until x", "\"until x\" is not a date or a whole number of hours, days or weeks"],
    ["Task :2026-02-30, 1d", "\"2026-02-30\" is not a YYYY-MM-DD start"],
    ["click wf href \"https://example.com\"", "it uses click"],
    ["A :1d; B :1d", "a line holds more than one statement (;)"],
  ])("opens read-only, and says why, when it meets %s", (line, reason) => {
    expect(parseChart(`gantt\n    ${line}\n`).readOnly).toBe(reason);
  });

  it("is read-only for something that is not a gantt chart", () => {
    expect(parseChart("flowchart LR\n  A --> B").readOnly).toBe("it is not a gantt chart");
  });

  it("treats a title line as the title even when it contains a colon", () => {
    expect([parseChart("gantt\n  title Plan: Q4\n").title, tasks("gantt\n  title Plan: Q4\n")]).toEqual(["Plan: Q4", []]);
  });

  it("accepts excludes weekends", () => {
    expect(parseChart("gantt\n  excludes weekends\n").excludesWeekends).toBe(true);
  });
});

describe("serializeChart", () => {
  it("gives back any text unchanged when nothing was edited", () => {
    fc.assert(fc.property(fc.string({ unit: "binary" }), (text) => serializeChart(parseChart(text)) === text), { seed: SEED, numRuns: 500 });
  });

  it("gives back generated gantt charts unchanged when nothing was edited", () => {
    fc.assert(fc.property(chartText(), (text) => serializeChart(parseChart(text)) === text), { seed: SEED });
  });

  it("writes an edited task in one canonical form that parses back to the same task", () => {
    fc.assert(fc.property(chartText(), (text) => {
      const chart = parseChart(text);
      const rewritten = { ...chart, lines: chart.lines.map((line) => (line.kind === "raw" ? line : { ...line, original: null })) };
      const again = parseChart(serializeChart(rewritten));
      const shape = (lines: typeof chart.lines) => lines.filter((line) => line.kind !== "raw")
        .map((line) => line.kind === "task" ? [line.name, line.tags, line.id, line.start, line.end] : [line.name]);
      return again.readOnly === null && JSON.stringify(shape(again.lines)) === JSON.stringify(shape(chart.lines));
    }), { seed: SEED });
  });
});

describe("schedule", () => {
  it("follows dates, lengths, after and the line above, as Mermaid does", () => {
    expect(placedOf(PLAN)).toEqual({
      Wireframes: ["2026-11-02", "2026-11-07", null],
      "Visual design": ["2026-11-07", "2026-11-15", null],
      Frontend: ["2026-11-15", "2026-11-29", null],
      Polish: ["2026-11-29", "2026-12-02", null],
      Launch: ["2026-11-29", "2026-11-29", null],
    });
  });

  it("ends an hours-long task part-way through a day, and starts the next one there", () => {
    const chart = parseChart("gantt\n  A :a, 2026-11-02, 4h\n  B :after a, 1d");
    const placed = schedule(chart, 0);
    const [a, b] = chart.lines.filter((line) => line.kind === "task").map((line) => placed.get(line.key));
    const day = parseDay("2026-11-02") ?? 0;
    expect([a?.start, a?.end, b?.start, b?.end]).toEqual([day, day + 4 / 24, day + 4 / 24, day + 1 + 4 / 24]);
  });

  it("starts after the latest of several tasks", () => {
    expect(placedOf("gantt\n  A :a, 2026-01-01, 2d\n  B :b, 2026-01-01, 9d\n  C :after a b, 1d")["C"]).toEqual(["2026-01-10", "2026-01-11", null]);
  });

  it("pushes a length past weekends under excludes weekends, but never an end date", () => {
    // 2026-11-06 is a Friday: three working days are Fri, Mon, Tue, so it ends Wednesday.
    expect(placedOf("gantt\n  excludes weekends\n  A :2026-11-06, 3d\n  B :2026-11-06, 2026-11-09")).toEqual({
      A: ["2026-11-06", "2026-11-11", null],
      B: ["2026-11-06", "2026-11-09", null],
    });
  });

  it("marks an unknown id and a cycle as errors, and still places the task", () => {
    const placed = placedOf("gantt\n  A :a, after b, 1d\n  B :b, after a, 1d\n  C :after nope, 2d");
    expect([placed["A"]?.[2], placed["B"]?.[2], placed["C"]]).toEqual([
      "its dependencies form a cycle",
      "its dependencies form a cycle",
      ["2026-01-01", "2026-01-03", "no task has the id nope"],
    ]);
  });

  it("marks a first task that starts after the line above as an error", () => {
    expect(placedOf("gantt\n  A :3d")["A"]?.[2]).toBe("it starts after the task above, and there is none");
  });
});

describe("parseDay", () => {
  it("round-trips every day in range through formatDay", () => {
    fc.assert(fc.property(fc.integer({ min: -100_000, max: 100_000 }), (n) => parseDay(formatDay(n)) === n), { seed: SEED });
  });

  it("rejects impossible dates", () => {
    expect([parseDay("2026-02-29"), parseDay("2026-13-01"), parseDay("26-01-01")]).toEqual([null, null, null]);
  });
});

describe("the gantt component boundary (SPEC §13.3)", () => {
  it("imports nothing from outside web/src/gantt, so the Confluence macro can bundle it", () => {
    const directory = new URL(".", import.meta.url);
    const outside = readdirSync(directory)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .flatMap((file) => [...readFileSync(new URL(file, directory), "utf8").matchAll(/^\s*(?:import\s+(?:[^;]*?\sfrom\s+)?|export\s[^;]*?\sfrom\s+)"([^"]+)";/gmu)]
        .map((match) => match[1] ?? "")
        .filter((specifier) => !specifier.startsWith("./"))
        .map((specifier) => `${file}: ${specifier}`));
    expect(outside).toEqual([]);
  });
});

/** Generated Mermaid gantt text inside the supported subset, with raw lines mixed in. */
function chartText(): fc.Arbitrary<string> {
  const name = fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{0,12}[A-Za-z0-9]$/u)
    .filter((text) => !/^(gantt|section|title|dateFormat|axisFormat|tickInterval|excludes|includes|todayMarker|inclusiveEndDates|topAxis|weekday|weekend|click|call|accTitle|accDescr|displayMode)\b/iu.test(text));
  const date = fc.integer({ min: 19_000, max: 22_000 }).map(formatDay);
  const length = fc.oneof(fc.integer({ min: 0, max: 60 }).map((n) => `${n}d`), fc.integer({ min: 1, max: 8 }).map((n) => `${n}w`), fc.integer({ min: 1, max: 72 }).map((n) => `${n}h`));
  const tags = fc.subarray(["done", "active", "crit", "milestone"]);
  const indent = fc.constantFrom("", "  ", "    ", "\t");
  const task = fc.tuple(name, tags, fc.option(fc.stringMatching(/^[a-z][a-z0-9]{0,5}$/u), { nil: null }), fc.oneof(date, fc.constant("after a1")), fc.oneof(length, date))
    .chain(([taskName, taskTags, id, start, end]) => fc.tuple(indent, fc.constantFrom(":", " : ", " :"), fc.constantFrom(", ", ",", " , "))
      .map(([lead, colon, comma]) => `${lead}${taskName}${colon}${[...taskTags, ...(id === null ? [] : [id]), start, end].join(comma)}`));
  // why: hand-written charts vary their spacing (indent, above). Canonical-looking input alone
  // would let a serializer that rewrites every line pass this property; a probe showed it.
  const line = fc.oneof(
    { weight: 6, arbitrary: task },
    { weight: 1, arbitrary: fc.tuple(indent, name).map(([lead, text]) => `${lead}section ${text}`) },
    { weight: 1, arbitrary: fc.constantFrom("", "    %% a note", "    axisFormat %e %b", "    todayMarker off") },
  );
  return fc.array(line, { maxLength: 12 }).map((lines) => ["gantt", "    dateFormat YYYY-MM-DD", "    A first :a1, 2026-01-05, 3d", ...lines].join("\n"));
}
