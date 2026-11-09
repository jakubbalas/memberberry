import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { chartOptions, colorHue, colorStyle, colorText, DEFAULT_OPTIONS, drawnPhases, longHex, NOTE_COLORS, parseColor, sectionColors, taskColors } from "./colors.js";

describe("parseColor", () => {
  it("reads note colour names in any case, and short or long hex", () => {
    expect([parseColor("Green"), parseColor("#3A7BD5"), parseColor(" #abc ")]).toEqual([
      { kind: "note", name: "green" },
      { kind: "hex", hex: "#3a7bd5" },
      { kind: "hex", hex: "#abc" },
    ]);
  });

  it("reads none as an explicit no colour, with a plain style", () => {
    const none = parseColor("None");
    expect([none, none === null ? null : colorText(none), none === null ? null : colorStyle(none)])
      .toEqual([{ kind: "none" }, "none", { fill: "var(--surface-raised)", stroke: "var(--text-muted)" }]);
  });

  it.each(["teal", "#12345", "#ggg", "red;fill:url(x)", "#abc)", "", "rgb(1,2,3)"])("refuses %j", (value) => {
    expect(parseColor(value)).toBeNull();
  });

  it("never accepts a value that could break out of a style attribute", () => {
    fc.assert(fc.property(fc.string({ unit: "binary" }), (value) => {
      const color = parseColor(value);
      return color === null || /^(#[0-9a-f]{3}|#[0-9a-f]{6}|[a-z]+)$/u.test(colorText(color));
    }), { seed: 20261109, numRuns: 1000 });
  });
});

describe("taskColors", () => {
  it("reads colour lines, ignores invalid ones, and lets a later line win", () => {
    const source = "gantt\n    %% color wf green\n    %% color vd #FF0000\n    %% color x teal\n    %% color wf blue\n    %% a comment\n";
    expect([...taskColors(source)]).toEqual([["wf", { kind: "note", name: "blue" }], ["vd", { kind: "hex", hex: "#ff0000" }]]);
  });
});

describe("colorStyle", () => {
  it("uses a note colour's theme tokens", () => {
    expect(colorStyle({ kind: "note", name: "green" })).toEqual({ fill: "var(--note-background-green)", stroke: "var(--note-color-green)" });
  });

  it("outlines in a hex colour and fills with a light mix of it", () => {
    expect(colorStyle({ kind: "hex", hex: "#3a7bd5" })).toEqual({ fill: "color-mix(in srgb, #3a7bd5 35%, var(--surface-note))", stroke: "#3a7bd5" });
  });

  it("has a style for every note colour", () => {
    expect(NOTE_COLORS.every((name) => colorStyle({ kind: "note", name }).fill.includes(name))).toBe(true);
  });
});

describe("longHex", () => {
  it("expands short hex for a colour input", () => {
    expect([longHex("#abc"), longHex("#a1b2c3")]).toEqual(["#aabbcc", "#a1b2c3"]);
  });
});

describe("sectionColors", () => {
  it("reads a phase colour line, keeping spaces in the phase name, and ignores invalid ones", () => {
    const source = "gantt\n    %% section-color green Discovery & research\n    %% section-color teal Build\n    %% section-color #ABC Build\n";
    expect([...sectionColors(source)]).toEqual([["Discovery & research", { kind: "note", name: "green" }], ["Build", { kind: "hex", hex: "#abc" }]]);
  });

  it("is not confused with a task colour line", () => {
    expect([sectionColors("gantt\n    %% color wf green").size, taskColors("gantt\n    %% section-color green Build").size]).toEqual([0, 0]);
  });
});

describe("drawnPhases", () => {
  it("lists phases that have tasks, in order, with null for tasks above the first section", () => {
    const source = "gantt\n  title Plan: Q4\n  dateFormat YYYY-MM-DD\n  Kick-off :2026-01-01, 1d\n  section Empty\n  section Build\n  %% note\n  A :2026-01-02, 1d\n  section Ship\n  B :1d";
    expect(drawnPhases(source)).toEqual([null, "Build", "Ship"]);
  });
});

describe("colorHue", () => {
  it("is a note colour's ink, or the hex itself", () => {
    expect([colorHue({ kind: "note", name: "green" }), colorHue({ kind: "hex", hex: "#3a7bd5" })]).toEqual(["var(--note-color-green)", "#3a7bd5"]);
  });
});

describe("chartOptions", () => {
  it("defaults to phases in a column, coloured whole, at the standard row height", () => {
    expect(chartOptions("gantt\n    T :1d")).toEqual({ phases: "column", phaseFill: "whole", rows: "fixed", height: "full" });
  });

  it("reads option lines in any case, and a later line wins", () => {
    const source = "gantt\n    %% option Phases ROW\n    %% option phase-fill name\n    %% option rows zoomed\n    %% option rows fixed\n    %% option max-height Medium";
    expect(chartOptions(source)).toEqual({ phases: "row", phaseFill: "name", rows: "fixed", height: "medium" });
  });

  it.each(["%% option phases diagonal", "%% option colour red", "%% option rows", "%% option max-height 400", "%% options rows zoomed", "T :1d %% option rows zoomed"])("ignores %j", (line) => {
    expect(chartOptions(`gantt\n    ${line}`)).toEqual(DEFAULT_OPTIONS);
  });
});
