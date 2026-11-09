import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { fitText } from "./fit-text.js";

/** A stand-in for a rendered width: 7px a character, 14px an emoji. */
const measure = (text: string): number => [...text].reduce((sum, char) => sum + (char.length > 1 ? 14 : 7), 0);

describe("fitText", () => {
  it("leaves text that fits alone", () => {
    expect(fitText("Design", 42, measure)).toBe("Design");
  });

  it("cuts long text to the longest start that fits with an ellipsis", () => {
    expect(fitText("Discovery and research", 70, measure)).toBe("Discovery…");
  });

  it("drops a space left before the ellipsis", () => {
    expect(fitText("Big launch", 35, measure)).toBe("Big…");
  });

  it("never splits an emoji", () => {
    expect(fitText("🚀🚀🚀🚀🚀", 40, measure)).toBe("🚀🚀…");
  });

  it("gives just the ellipsis when nothing else fits", () => {
    expect(fitText("Wireframes", 3, measure)).toBe("…");
  });

  it("always fits, keeps the text's start, and shortens only what does not fit", () => {
    fc.assert(fc.property(fc.string({ unit: "binary", maxLength: 40 }), fc.integer({ min: 7, max: 300 }), (full, max) => {
      const shown = fitText(full, max, measure);
      const fits = measure(full) <= max;
      return fits ? shown === full : measure(shown) <= max && shown.endsWith("…") && full.startsWith(shown.slice(0, -1));
    }), { seed: 20261109, numRuns: 1000 });
  });

  it("keeps as much as fits: one more character would not", () => {
    fc.assert(fc.property(fc.stringMatching(/^[a-z]{1,40}$/u), fc.integer({ min: 7, max: 300 }), (full, max) => {
      const shown = fitText(full, max, measure);
      const kept = shown.endsWith("…") ? shown.slice(0, -1) : shown;
      return shown === full || measure(`${full.slice(0, kept.length + 1)}…`) > max;
    }), { seed: 20261109, numRuns: 1000 });
  });
});
