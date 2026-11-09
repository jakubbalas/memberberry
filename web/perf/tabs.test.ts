/** The open-note scenario must switch to the note it times, whatever else the workspace holds. */
import { describe, expect, it } from "vitest";

import { switchTargetIndex } from "./tabs.js";

const NOTE_0 = "folder-00/note-00000.md";
const NOTE_777 = "folder-27/note-00777.md";

describe("switchTargetIndex", () => {
  it("finds a desktop tab by its note path, not its position", () => {
    // why: the diagram scenario runs first and the server restores its tab, so Note 0 is
    // the second tab. Clicking the first one timed a switch to the Gantt note instead.
    const tabs = [
      { title: "perf-fixtures/gantt.md", text: "Gantt fixture" },
      { title: NOTE_0, text: "Note 0" },
      { title: NOTE_777, text: "Note 777" },
    ];
    expect([switchTargetIndex(tabs, NOTE_0), switchTargetIndex(tabs, NOTE_777)]).toEqual([1, 2]);
  });

  it("finds a mobile sheet entry by the folder it shows", () => {
    const sheet = [
      { title: null, text: "Gantt fixtureperf-fixtures" },
      { title: null, text: "Note 0folder-00" },
      { title: null, text: "Note 777folder-27" },
    ];
    expect([switchTargetIndex(sheet, NOTE_0), switchTargetIndex(sheet, NOTE_777)]).toEqual([1, 2]);
  });

  it("refuses to guess when no target or more than one matches", () => {
    const ambiguous = [{ title: null, text: "afolder-00" }, { title: null, text: "bfolder-00" }];
    expect([switchTargetIndex([], NOTE_0), switchTargetIndex(ambiguous, NOTE_0)]).toEqual([-1, -1]);
  });

  it("does not match a root-level note by an empty folder", () => {
    expect(switchTargetIndex([{ title: null, text: "Anything" }], "Root.md")).toBe(-1);
  });
});
