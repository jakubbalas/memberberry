/**
 * What a keypress means in the outline pane, and what a row is called (`SPEC.md` §9.5).
 *
 * The headings and the section moves belong to the editor and are tested there;
 * `Outline.dom.test.ts` covers what a reader sees and which editor the panel listens to.
 * These need no DOM at all, which is the point of the logic living outside the component.
 */

import { describe, expect, it } from "vitest";

import type { OutlineHeading } from "../editor/outline.js";
import { cursorAfterReorder, headingLabel, outlineKeyAction } from "./outline.js";

const heading = (index: number, level: number, text: string): OutlineHeading => ({
  index,
  block: index * 2 + 1,
  level,
  text,
});

const NORMAL = { altKey: false };
const ALT = { altKey: true };

describe("labelling a row", () => {
  it("uses the heading's text", () => {
    expect(headingLabel(heading(0, 1, "First"))).toBe("First");
  });

  it("names an empty heading rather than rendering a blank row", () => {
    // A heading someone has just inserted has no text yet, and a row of nothing is a row
    // nobody can click on purpose or hear read out.
    expect(headingLabel(heading(0, 2, ""))).toBe("Untitled heading");
  });
});

describe("the outline keyboard", () => {
  /** Three top-level sections, the second holding a subsection. */
  const FLAT = [heading(0, 1, "One"), heading(1, 1, "Two"), heading(2, 1, "Three")];
  const NESTED = [
    heading(0, 1, "Title"),
    heading(1, 2, "Alpha"),
    heading(2, 3, "Alpha detail"),
    heading(3, 2, "Beta"),
  ];

  it("moves the cursor with the bare arrows", () => {
    expect(outlineKeyAction("ArrowDown", NORMAL, FLAT, 0)).toEqual({ kind: "move", to: 1 });
    expect(outlineKeyAction("ArrowUp", NORMAL, FLAT, 2)).toEqual({ kind: "move", to: 1 });
    expect(outlineKeyAction("Home", NORMAL, FLAT, 2)).toEqual({ kind: "move", to: 0 });
    expect(outlineKeyAction("End", NORMAL, FLAT, 0)).toEqual({ kind: "move", to: 2 });
  });

  it("stops at the ends rather than wrapping", () => {
    expect(outlineKeyAction("ArrowUp", NORMAL, FLAT, 0)).toEqual({ kind: "none" });
    expect(outlineKeyAction("ArrowDown", NORMAL, FLAT, 2)).toEqual({ kind: "none" });
  });

  it("scrolls to the section on Enter or Space", () => {
    for (const key of ["Enter", " "]) {
      expect(outlineKeyAction(key, NORMAL, FLAT, 1)).toEqual({ kind: "goto", index: 1 });
    }
  });

  it("reorders with Alt and an arrow, which is the drag's keyboard equivalent", () => {
    // §8.2: native drag-and-drop is not keyboard-operable at all, so this is a second
    // implementation of one feature rather than a nicety.
    expect(outlineKeyAction("ArrowDown", ALT, FLAT, 0)).toEqual({
      kind: "reorder",
      from: 0,
      to: 1,
      cursor: 1,
    });
    expect(outlineKeyAction("ArrowUp", ALT, FLAT, 2)).toEqual({
      kind: "reorder",
      from: 2,
      to: 1,
      cursor: 1,
    });
  });

  it("moves a section past its next sibling, not into its own subsection", () => {
    // `## Alpha` owns `### Alpha detail`, which travels with it — so "down" means past
    // `## Beta`. Targeting the subsection would be a move the editor refuses, and a keypress
    // that is refused looks broken rather than declined.
    expect(outlineKeyAction("ArrowDown", ALT, NESTED, 1)).toEqual({
      kind: "reorder",
      from: 1,
      to: 3,
      cursor: 2,
    });
  });

  it("leaves the cursor on the section that moved", () => {
    // Two rows travelled, so the moved heading lands one short of where the target was.
    expect(cursorAfterReorder(NESTED, 1, 3)).toBe(2);
    expect(cursorAfterReorder(NESTED, 3, 1)).toBe(1);
    // An index that names no heading leaves the cursor where it was.
    expect(cursorAfterReorder(NESTED, 9, 11)).toBe(9);
  });

  it("has nothing to reorder past either end", () => {
    expect(outlineKeyAction("ArrowUp", ALT, FLAT, 0)).toEqual({ kind: "none" });
    expect(outlineKeyAction("ArrowDown", ALT, FLAT, 2)).toEqual({ kind: "none" });
    // Nor when every heading below is inside the section being moved.
    expect(outlineKeyAction("ArrowDown", ALT, NESTED, 0)).toEqual({ kind: "none" });
  });

  it("does nothing for an empty outline, an out-of-range cursor, or another key", () => {
    expect(outlineKeyAction("ArrowDown", NORMAL, [], 0)).toEqual({ kind: "none" });
    expect(outlineKeyAction("Enter", NORMAL, FLAT, 7)).toEqual({ kind: "none" });
    expect(outlineKeyAction("x", NORMAL, FLAT, 0)).toEqual({ kind: "none" });
  });
});
