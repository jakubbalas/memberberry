// @vitest-environment jsdom

/**
 * The graph's palette (§9.4, §20).
 *
 * The one part of the renderer that decides something, so the one part that can be tested
 * without a browser. What matters is that a colour comes from a **token** and that a value
 * which is not a colour produces a visible fallback rather than a `NaN` channel — a shader
 * given `NaN` draws nothing at all, which looks exactly like a graph with no notes in it.
 */

import { describe, expect, it } from "vitest";

import { SERIES_COLOURS, parseColour, readColours } from "./graph-colours.js";

describe("reading a colour", () => {
  it("reads a six-digit hex, which is what the token file is written in", () => {
    expect(parseColour("#b03a2e")).toEqual([176 / 255, 58 / 255, 46 / 255]);
  });

  it("reads a three-digit hex", () => {
    expect(parseColour("#f0a")).toEqual([1, 0, 170 / 255]);
  });

  it("ignores case and surrounding space, which a computed style adds", () => {
    expect(parseColour("  #B03A2E ")).toEqual(parseColour("#b03a2e"));
  });

  it("reads the rgb form a browser resolves a colour to", () => {
    expect(parseColour("rgb(176, 58, 46)")).toEqual(parseColour("#b03a2e"));
    expect(parseColour("rgba(176, 58, 46, 0.5)")).toEqual(parseColour("#b03a2e"));
    expect(parseColour("rgb(176 58 46 / 50%)")).toEqual(parseColour("#b03a2e"));
  });

  it("answers nothing for something that is not a colour", () => {
    // A guess here would be a wrong colour that looks deliberate, which is harder to notice
    // than a grey one.
    for (const bad of ["", "   ", "red", "#12", "#1234567", "#gggggg", "rgb()", "rgb(a,b,c)"]) {
      expect(parseColour(bad), bad).toBeUndefined();
    }
  });

  it("keeps every channel inside the range a shader expects", () => {
    const colour = parseColour("#ffffff");
    expect(colour).toEqual([1, 1, 1]);
    expect(parseColour("#000000")).toEqual([0, 0, 0]);
  });
});

describe("the palette", () => {
  /** An element carrying the tokens, as the app's stylesheet would. */
  function styled(tokens: Record<string, string>): HTMLElement {
    const element = document.createElement("div");
    for (const [name, value] of Object.entries(tokens)) {
      element.style.setProperty(name, value);
    }
    document.body.append(element);
    return element;
  }

  it("takes one colour per series token", () => {
    const element = styled(
      Object.fromEntries(
        Array.from({ length: SERIES_COLOURS }, (_, at) => [`--series-${at}`, "#010203"]),
      ),
    );
    const palette = readColours(element);
    expect(palette.series).toHaveLength(SERIES_COLOURS);
    expect(palette.series[0]).toEqual([1 / 255, 2 / 255, 3 / 255]);
  });

  it("falls back to something visible when a token is missing", () => {
    // A missing token must not become `NaN`: a shader given one draws nothing, and a graph
    // with no dots in it looks exactly like a vault with no notes in it.
    const palette = readColours(styled({}));
    for (const colour of [...palette.series, palette.link, palette.embed, palette.ghost]) {
      for (const channel of colour) {
        expect(Number.isFinite(channel)).toBe(true);
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });

  it("draws an embed in the accent colour and a link in the muted one", () => {
    // §9.4 asks for link and embed edges to be distinguishable, not merely filterable.
    const element = styled({ "--text-muted": "#111111", "--accent-primary": "#222222" });
    const palette = readColours(element);
    expect(palette.link).toEqual(parseColour("#111111"));
    expect(palette.embed).toEqual(parseColour("#222222"));
    expect(palette.link).not.toEqual(palette.embed);
  });
});
