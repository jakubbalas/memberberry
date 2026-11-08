/** The A38 diagram fixture (SPEC §13.2) must be a stable, valid chart, or the rows it feeds drift. */
import { describe, expect, it } from "vitest";

import { PERF_DIAGRAM_MARKER, diagramFixture } from "./server.js";

const tasks = (note: string) => note.split("\n").filter((line) => /^ {4}\S.* :/.test(line));

describe("diagramFixture", () => {
  it("is byte-identical on every call, so recorded numbers stay comparable", () => {
    expect(diagramFixture()).toBe(diagramFixture());
  });

  it("is one mermaid fence holding a 43-task Gantt chart, then the typing paragraph", () => {
    const note = diagramFixture();
    expect([note.match(/```mermaid\ngantt\n/g)?.length, tasks(note).length, note.endsWith(`${PERF_DIAGRAM_MARKER} for the quarter.\n`)])
      .toEqual([1, 43, true]);
  });

  it("only depends on tasks defined earlier, with unique ids", () => {
    const seen = new Set<string>();
    const problems: string[] = [];
    for (const line of tasks(diagramFixture())) {
      const fields = line.split(":")[1]?.split(",").map((field) => field.trim()) ?? [];
      const id = fields.find((field) => /^(s\d+t\d+|launch)$/.test(field));
      for (const dependency of /after (.+)$/.exec(fields.find((f) => f.startsWith("after")) ?? "")?.[1]?.split(" ") ?? []) {
        if (!seen.has(dependency)) problems.push(`${line.trim()} depends on undefined ${dependency}`);
      }
      if (id === undefined || seen.has(id)) problems.push(`${line.trim()} has a missing or repeated id`);
      else seen.add(id);
    }
    expect(problems).toEqual([]);
  });
});
