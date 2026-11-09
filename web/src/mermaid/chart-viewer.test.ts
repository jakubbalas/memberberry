import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { anchoredScroll, clampZoom, fitZoom, MAX_ZOOM, MIN_ZOOM, stepZoom, ZOOM_STEPS, zoomText } from "./chart-viewer.js";

describe("stepZoom", () => {
  it("steps through the zoom levels in both directions", () => {
    expect([stepZoom(1, 1), stepZoom(1, -1), stepZoom(MAX_ZOOM, 1), stepZoom(MIN_ZOOM, -1)]).toEqual([1.25, 0.8, MAX_ZOOM, MIN_ZOOM]);
  });

  it("goes to the next level from a zoom between levels, as a fit or pinch leaves it", () => {
    expect([stepZoom(0.9, 1), stepZoom(0.9, -1)]).toEqual([1, 0.8]);
  });

  it("always moves the right way and stays in range", () => {
    fc.assert(fc.property(fc.double({ min: MIN_ZOOM, max: MAX_ZOOM, noNaN: true }), (zoom) => {
      const up = stepZoom(zoom, 1);
      const down = stepZoom(zoom, -1);
      return (up > zoom || zoom >= MAX_ZOOM - 0.001) && (down < zoom || zoom <= MIN_ZOOM + 0.001)
        && [up, down].every((value) => value >= MIN_ZOOM && value <= MAX_ZOOM);
    }), { seed: 20261109, numRuns: 500 });
  });

  it("has its levels in order", () => {
    expect([...ZOOM_STEPS].sort((a, b) => a - b)).toEqual([...ZOOM_STEPS]);
  });
});

describe("clampZoom and fitZoom", () => {
  it("keeps a zoom in range, and treats nonsense as 100%", () => {
    expect([clampZoom(10), clampZoom(0.01), clampZoom(Number.NaN), clampZoom(1.5)]).toEqual([MAX_ZOOM, MIN_ZOOM, 1, 1.5]);
  });

  it("fits a picture to the space, within range, and leaves an unmeasured one alone", () => {
    expect([fitZoom(1000, 500), fitZoom(100, 10_000), fitZoom(0, 500), fitZoom(500, 0)]).toEqual([0.5, MAX_ZOOM, 1, 1]);
  });
});

describe("anchoredScroll", () => {
  it("keeps the point under the pointer in place when zooming", () => {
    // 100px scrolled, pointer 50px into the picture: that point is 150px into the content.
    // At twice the size it is 300px in, so scroll 250 keeps it 50px from the edge.
    expect(anchoredScroll(100, 150, 2)).toBe(250);
  });

  it("never scrolls before the start", () => {
    expect(anchoredScroll(0, 10, 0.25)).toBe(0);
  });
});

describe("zoomText", () => {
  it("reads as a whole percentage", () => {
    expect([zoomText(1), zoomText(0.333), zoomText(2.5)]).toEqual(["100%", "33%", "250%"]);
  });
});
