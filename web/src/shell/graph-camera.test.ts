/**
 * The camera and the level-of-detail rules (§9.4).
 *
 * This is the half of the renderer that can be tested without a browser, and it is the half
 * that decides what a reader actually sees: what is framed when the picture opens, where a
 * click lands in the vault, and which labels are drawn. `graph-gl.ts` below it can only be
 * exercised by `make e2e`, because jsdom has no WebGL — so anything that can live here does.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  type Camera,
  LABEL_SCALE,
  MAX_LABELS,
  MAX_SCALE,
  MIN_SCALE,
  boundsOf,
  clampScale,
  fitCamera,
  labelledNodes,
  labelsVisible,
  nodeRadius,
  panBy,
  screenToWorld,
  visibleBounds,
  worldToScreen,
  zoomAt,
} from "./graph-camera.js";

function positions(pairs: readonly (readonly [number, number])[]): [Float32Array, Float32Array] {
  const x = new Float32Array(pairs.length);
  const y = new Float32Array(pairs.length);
  pairs.forEach(([px, py], at) => {
    x[at] = px;
    y[at] = py;
  });
  return [x, y];
}

describe("bounds", () => {
  it("is the box every node sits in", () => {
    const [x, y] = positions([
      [-5, 2],
      [10, -3],
      [0, 0],
    ]);
    expect(boundsOf(x, y, 3)).toEqual({ minX: -5, minY: -3, maxX: 10, maxY: 2 });
  });

  it("is a unit box when there is nothing to measure", () => {
    // An empty vault still has to produce a camera, and a box of infinities makes every
    // number downstream a `NaN`.
    expect(boundsOf(new Float32Array(0), new Float32Array(0), 0)).toEqual({
      minX: -1,
      minY: -1,
      maxX: 1,
      maxY: 1,
    });
  });

  it("ignores a position that is not a number", () => {
    const [x, y] = positions([
      [Number.NaN, 0],
      [4, 4],
    ]);
    expect(boundsOf(x, y, 2)).toEqual({ minX: 4, minY: 4, maxX: 4, maxY: 4 });
  });
});

describe("framing the picture", () => {
  it("centres on the middle of the graph", () => {
    const camera = fitCamera({ minX: 0, minY: 0, maxX: 100, maxY: 50 }, 400, 400);
    expect(camera.x).toBe(50);
    expect(camera.y).toBe(25);
  });

  it("fits the longer side, so nothing is cut off", () => {
    const camera = fitCamera({ minX: 0, minY: 0, maxX: 100, maxY: 10 }, 400, 400, 0);
    // 400 / 100 rather than 400 / 10: the wide axis is the one that decides.
    expect(camera.scale).toBe(4);
  });

  it("leaves room around the edge", () => {
    const tight = fitCamera({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, 400, 400, 0);
    const padded = fitCamera({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, 400, 400, 0.1);
    expect(padded.scale).toBeLessThan(tight.scale);
  });

  it("still frames a single node, which has no extent at all", () => {
    const camera = fitCamera({ minX: 7, minY: 7, maxX: 7, maxY: 7 }, 400, 400);
    expect(camera.x).toBe(7);
    expect(camera.scale).toBe(MAX_SCALE);
  });

  it("does not divide by a viewport that has not been measured yet", () => {
    // The first paint happens before the element has a size, and a scale of `Infinity`
    // there puts every node at the same place for the rest of the session.
    expect(fitCamera({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 0, 0).scale).toBe(1);
  });
});

describe("screen and world", () => {
  const camera: Camera = { x: 100, y: 50, scale: 2 };

  it("puts the camera's own point in the middle of the viewport", () => {
    expect(worldToScreen(camera, 800, 600, 100, 50)).toEqual({ x: 400, y: 300 });
  });

  it("scales the offset from the centre", () => {
    expect(worldToScreen(camera, 800, 600, 110, 50)).toEqual({ x: 420, y: 300 });
  });

  it("reads a pointer back into the vault", () => {
    expect(screenToWorld(camera, 800, 600, 420, 300)).toEqual({ x: 110, y: 50 });
  });

  it("round-trips", () => {
    fc.assert(
      fc.property(
        fc.float({ min: -1000, max: 1000, noNaN: true }),
        fc.float({ min: -1000, max: 1000, noNaN: true }),
        fc.float({ min: Math.fround(0.05), max: 5, noNaN: true }),
        (wx, wy, scale) => {
          const view: Camera = { x: 3, y: -4, scale };
          const screen = worldToScreen(view, 640, 480, wx, wy);
          const world = screenToWorld(view, 640, 480, screen.x, screen.y);
          expect(world.x).toBeCloseTo(wx, 3);
          expect(world.y).toBeCloseTo(wy, 3);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("panning", () => {
  it("moves the picture with the drag, not against it", () => {
    // Dragging right moves the *content* right, which means looking further left.
    const moved = panBy({ x: 0, y: 0, scale: 2 }, 100, 0);
    expect(moved.x).toBe(-50);
  });

  it("moves by less in world units the further in a reader has zoomed", () => {
    expect(panBy({ x: 0, y: 0, scale: 1 }, 10, 0).x).toBe(-10);
    expect(panBy({ x: 0, y: 0, scale: 10 }, 10, 0).x).toBe(-1);
  });
});

describe("zooming", () => {
  it("keeps the point under the cursor under the cursor", () => {
    // The property that makes a wheel feel like a magnifying glass. Without it the picture
    // slides away from wherever a reader is looking as they zoom in.
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 800, noNaN: true }),
        fc.float({ min: 0, max: 600, noNaN: true }),
        fc.float({ min: Math.fround(0.2), max: 5, noNaN: true }),
        (sx, sy, factor) => {
          const before: Camera = { x: 12, y: -7, scale: 1.3 };
          const under = screenToWorld(before, 800, 600, sx, sy);
          const after = zoomAt(before, 800, 600, sx, sy, factor);
          const now = screenToWorld(after, 800, 600, sx, sy);
          expect(now.x).toBeCloseTo(under.x, 3);
          expect(now.y).toBeCloseTo(under.y, 3);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("refuses to zoom past the limits", () => {
    expect(zoomAt({ x: 0, y: 0, scale: 1 }, 100, 100, 50, 50, 1e6).scale).toBe(MAX_SCALE);
    expect(zoomAt({ x: 0, y: 0, scale: 1 }, 100, 100, 50, 50, 1e-6).scale).toBe(MIN_SCALE);
  });

  it("ignores a factor that is not a number it can zoom by", () => {
    for (const factor of [0, -1, Number.NaN, Infinity]) {
      expect(zoomAt({ x: 0, y: 0, scale: 2 }, 100, 100, 50, 50, factor).scale).toBe(2);
    }
  });

  it("clamps a scale that arrived from somewhere else", () => {
    expect(clampScale(Number.NaN)).toBe(1);
    expect(clampScale(0)).toBe(MIN_SCALE);
    expect(clampScale(1e9)).toBe(MAX_SCALE);
  });
});

describe("what is on screen", () => {
  it("is the viewport in world units", () => {
    expect(visibleBounds({ x: 0, y: 0, scale: 2 }, 800, 400)).toEqual({
      minX: -200,
      minY: -100,
      maxX: 200,
      maxY: 100,
    });
  });

  it("widens by a margin, so a node just off the edge still draws its line", () => {
    expect(visibleBounds({ x: 0, y: 0, scale: 1 }, 100, 100, 10).minX).toBe(-60);
  });
});

describe("level of detail", () => {
  it("draws no labels below the zoom threshold", () => {
    // §9.4's whole answer to ten thousand nodes: the picture is a shape until a reader
    // comes close enough for the names to mean something.
    expect(labelsVisible({ x: 0, y: 0, scale: LABEL_SCALE - 0.01 })).toBe(false);
    expect(labelsVisible({ x: 0, y: 0, scale: LABEL_SCALE })).toBe(true);
  });

  it("labels nothing at all when zoomed out", () => {
    const [x, y] = positions([[0, 0]]);
    const camera = { x: 0, y: 0, scale: LABEL_SCALE / 2 };
    expect(labelledNodes(camera, 500, 500, x, y, new Float32Array([1]), 1)).toEqual([]);
  });

  it("labels only what is on screen", () => {
    const [x, y] = positions([
      [0, 0],
      [10_000, 0],
    ]);
    const camera = { x: 0, y: 0, scale: 1 };
    const weight = new Float32Array([1, 99]);
    expect(labelledNodes(camera, 500, 500, x, y, weight, 2)).toEqual([0]);
  });

  it("labels the biggest nodes first when there are too many", () => {
    const pairs: [number, number][] = Array.from({ length: MAX_LABELS + 10 }, (_, at) => [at, 0]);
    const [x, y] = positions(pairs);
    const weight = new Float32Array(pairs.map((_, at) => at));
    const shown = labelledNodes({ x: 0, y: 0, scale: 1 }, 10_000, 10_000, x, y, weight, pairs.length);
    expect(shown).toHaveLength(MAX_LABELS);
    expect(shown[0]).toBe(pairs.length - 1);
  });

  it("keeps two nodes of the same size in index order, so labels do not shuffle", () => {
    const [x, y] = positions([
      [0, 0],
      [1, 0],
      [2, 0],
    ]);
    const weight = new Float32Array([5, 5, 5]);
    expect(labelledNodes({ x: 0, y: 0, scale: 1 }, 1000, 1000, x, y, weight, 3)).toEqual([0, 1, 2]);
  });
});

describe("a node's size", () => {
  it("grows with the measure it is drawn from", () => {
    expect(nodeRadius(10, 10, "degree")).toBeGreaterThan(nodeRadius(1, 10, "degree"));
  });

  it("is the same at the top whichever measure is chosen", () => {
    // A reader switching the control should see the same picture resized rather than a
    // different picture.
    expect(nodeRadius(10, 10, "degree")).toBeCloseTo(nodeRadius(500, 500, "words"), 10);
  });

  it("compresses word counts harder than degrees, because they are more skewed", () => {
    expect(nodeRadius(1, 1000, "words")).toBeGreaterThan(nodeRadius(1, 1000, "degree"));
  });

  it("gives a node with nothing to measure a visible dot rather than none", () => {
    expect(nodeRadius(0, 0, "degree")).toBeGreaterThan(0);
    expect(nodeRadius(0, 100, "words")).toBeGreaterThan(0);
  });

  it("does not grow past the top of the range for a value out of range", () => {
    expect(nodeRadius(1e9, 10, "degree")).toBe(nodeRadius(10, 10, "degree"));
    expect(nodeRadius(-5, 10, "degree")).toBe(nodeRadius(0, 10, "degree"));
  });
});
