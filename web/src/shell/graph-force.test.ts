/**
 * The global graph's force layout (§9.4).
 *
 * A force simulation has no single right answer, so the tests are about the properties a
 * *reader* depends on: linked notes end up near each other, unlinked ones do not pile up,
 * the picture settles rather than vibrating forever, and — the one that is not a matter of
 * taste — **the same vault draws the same picture twice**. That last one is why nothing in
 * `graph-force.ts` calls `Math.random`, and it is the property most easily lost by accident.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_TICKS,
  ForceLayout,
  jiggle,
  repulsionOn,
  springShare,
  springStrength,
} from "./graph-force.js";
import { Quadtree } from "./graph-quadtree.js";

/** Edges as the wire sends them: flat triples of node indices. */
function edges(...pairs: readonly (readonly [number, number])[]): Uint32Array {
  const out = new Uint32Array(pairs.length * 3);
  pairs.forEach(([source, target], at) => {
    out[at * 3] = source;
    out[at * 3 + 1] = target;
    out[at * 3 + 2] = 0;
  });
  return out;
}

function settled(count: number, links: Uint32Array, ticks = 120): ForceLayout {
  const layout = new ForceLayout({ count, edges: links, ticks });
  layout.run();
  return layout;
}

const between = (layout: ForceLayout, a: number, b: number): number =>
  Math.hypot((layout.x[a] ?? 0) - (layout.x[b] ?? 0), (layout.y[a] ?? 0) - (layout.y[b] ?? 0));

describe("starting positions", () => {
  it("places nothing for an empty graph rather than dividing by zero", () => {
    const layout = new ForceLayout({ count: 0, edges: new Uint32Array(0) });
    layout.run();
    expect(layout.x.length).toBe(0);
    expect(layout.settled).toBe(true);
  });

  it("gives every node a distinct starting place", () => {
    // A layout that starts every node at the origin has no direction to separate them along,
    // and spends its whole budget undoing that.
    const layout = new ForceLayout({ count: 200, edges: new Uint32Array(0) });
    const places = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      places.add(`${layout.x[i]},${layout.y[i]}`);
    }
    expect(places.size).toBe(200);
  });
});

describe("settling", () => {
  it("cools to a stop in about the number of ticks it was given", () => {
    const layout = new ForceLayout({ count: 40, edges: edges([0, 1]), ticks: 100 });
    expect(layout.settled).toBe(false);
    layout.run();
    expect(layout.settled).toBe(true);
    expect(layout.ticks).toBe(100);
  });

  it("does nothing when ticked after it has settled", () => {
    const layout = settled(20, edges([0, 1], [1, 2]), 60);
    const before = Array.from(layout.x);
    layout.tick();
    layout.tick();
    expect(Array.from(layout.x)).toEqual(before);
    expect(layout.ticks).toBe(60);
  });

  it("defaults to enough ticks to be worth looking at", () => {
    expect(DEFAULT_TICKS).toBeGreaterThan(100);
  });
});

describe("what the picture says", () => {
  it("puts two linked notes nearer than two unlinked ones", () => {
    // The whole claim of a force layout, in one assertion.
    const layout = settled(3, edges([0, 1]));
    expect(between(layout, 0, 1)).toBeLessThan(between(layout, 0, 2));
  });

  it("keeps unlinked notes apart instead of stacking them", () => {
    const layout = settled(30, new Uint32Array(0));
    for (let a = 0; a < 30; a += 1) {
      for (let b = a + 1; b < 30; b += 1) {
        expect(between(layout, a, b)).toBeGreaterThan(1);
      }
    }
  });

  it("draws a chain as a chain, with the ends further apart than the links", () => {
    const layout = settled(6, edges([0, 1], [1, 2], [2, 3], [3, 4], [4, 5]), 400);
    expect(between(layout, 0, 5)).toBeGreaterThan(between(layout, 0, 1) * 2);
  });

  it("pulls two clusters apart from each other", () => {
    // Six notes in two groups of three, nothing between them: what a vault's folders look
    // like, and the reason §9.4 asks for springs at this scale rather than rings.
    const layout = settled(
      6,
      edges([0, 1], [1, 2], [2, 0], [3, 4], [4, 5], [5, 3]),
      400,
    );
    const inside = Math.max(between(layout, 0, 1), between(layout, 1, 2), between(layout, 0, 2));
    const across = Math.min(
      between(layout, 0, 3),
      between(layout, 0, 4),
      between(layout, 1, 3),
      between(layout, 2, 5),
    );
    expect(across).toBeGreaterThan(inside);
  });

  it("does not let a hub drag its neighbours into a ball", () => {
    // A note with forty backlinks is on forty springs and each neighbour is on one. Without
    // the strength and share both scaling by degree, the hub wins every tug and the picture
    // becomes a dot.
    const links: [number, number][] = Array.from({ length: 40 }, (_, at) => [0, at + 1]);
    const layout = settled(41, edges(...links), 400);
    for (let leaf = 1; leaf <= 40; leaf += 1) {
      expect(between(layout, 0, leaf)).toBeGreaterThan(5);
    }
  });

  it("keeps the picture centred on the origin", () => {
    // Repulsion has nothing pushing back at long range, so without this a disconnected graph
    // sails off the canvas and the viewport has nothing to frame.
    const layout = settled(50, edges([0, 1], [2, 3]), 200);
    let sumX = 0;
    let sumY = 0;
    for (let i = 0; i < 50; i += 1) {
      sumX += layout.x[i] ?? 0;
      sumY += layout.y[i] ?? 0;
    }
    expect(Math.abs(sumX / 50)).toBeLessThan(1e-3);
    expect(Math.abs(sumY / 50)).toBeLessThan(1e-3);
  });
});

describe("edges it should not trust", () => {
  it("ignores an edge naming a node that is not there", () => {
    // `readVaultGraph` already drops these, so this is depth: a layout that read one would
    // write outside its own arrays, which in a typed array is a silent no-op and in the
    // arithmetic below is a `NaN` that spreads through the whole picture.
    const layout = settled(3, edges([0, 9], [1, 2]));
    for (let i = 0; i < 3; i += 1) {
      expect(Number.isFinite(layout.x[i] ?? Number.NaN)).toBe(true);
      expect(Number.isFinite(layout.y[i] ?? Number.NaN)).toBe(true);
    }
  });

  it("ignores a self-link, which has no direction to pull along", () => {
    const layout = settled(2, edges([0, 0], [0, 1]));
    expect(Number.isFinite(layout.x[0] ?? Number.NaN)).toBe(true);
    expect(between(layout, 0, 1)).toBeGreaterThan(0);
  });

  it("survives a trailing part-edge in the array", () => {
    const ragged = new Uint32Array([0, 1, 0, 1]);
    const layout = new ForceLayout({ count: 2, edges: ragged, ticks: 30 });
    layout.run();
    expect(Number.isFinite(layout.x[1] ?? Number.NaN)).toBe(true);
  });
});

describe("the push a node feels", () => {
  /** A tree over the given points, and the force they exert on `(px, py)`. */
  function pushOn(
    points: readonly (readonly [number, number])[],
    px: number,
    py: number,
  ): [number, number] {
    const x = new Float32Array(points.length);
    const y = new Float32Array(points.length);
    points.forEach(([qx, qy], at) => {
      x[at] = qx;
      y[at] = qy;
    });
    const tree = new Quadtree();
    tree.build(x, y, points.length);
    const out = new Float64Array(2);
    repulsionOn(tree, px, py, 1, 0, out);
    return [out[0] ?? Number.NaN, out[1] ?? Number.NaN];
  }

  it("pushes away from a node rather than towards it", () => {
    const [fx, fy] = pushOn([[10, 0]], 0, 0);
    expect(fx).toBeLessThan(0);
    expect(Math.abs(fy)).toBeLessThan(1e-9);
  });

  it("is a crowd's worth of push, not one node's", () => {
    // The whole of what Barnes-Hut trades away, and the one thing a finished picture cannot
    // show: a quad standing in for forty notes has to push like forty notes. A layout that
    // dropped `mass` still draws something plausible.
    const crowd: [number, number][] = Array.from({ length: 40 }, (_, at) => [
      600 + (at % 8) * 0.5,
      (at >> 3) * 0.5,
    ]);
    const [many] = pushOn(crowd, 0, 0);
    const [one] = pushOn([crowd[0] ?? [600, 0]], 0, 0);
    expect(many / one).toBeGreaterThan(35);
    expect(many / one).toBeLessThan(45);
  });

  it("softens a near-collision instead of flinging a node across the picture", () => {
    // Two nodes a hundredth of a unit apart: an unsoftened inverse-square term is ten
    // thousand times the force of a node at one unit, which is a dot leaving the viewport.
    const [close] = pushOn([[0.01, 0]], 0, 0);
    const [far] = pushOn([[10, 0]], 0, 0);
    expect(Math.abs(close)).toBeLessThan(Math.abs(far) * 200);
  });

  it("separates two nodes in exactly the same place", () => {
    // Distance zero has no direction to push along, so something has to choose one. It must
    // be the same one every time, or the picture would differ between visits.
    const [fx, fy] = pushOn([[0, 0]], 0, 0);
    expect(Number.isFinite(fx)).toBe(true);
    expect(Number.isFinite(fy)).toBe(true);
    expect(Math.abs(fx) + Math.abs(fy)).toBeGreaterThan(0);
    expect(pushOn([[0, 0]], 0, 0)).toEqual([fx, fy]);
  });

  it("feels nothing from an empty tree", () => {
    expect(pushOn([], 5, 5)).toEqual([0, 0]);
  });
});

describe("how a spring is shared", () => {
  it("gives way at the end with fewer links", () => {
    // A hub on forty springs and a leaf on one: the leaf does almost all of the moving. The
    // share is the target's, so a hub as the *source* keeps almost all of the correction for
    // the target and vice versa.
    expect(springShare(40, 1)).toBeCloseTo(40 / 41, 10);
    expect(springShare(1, 40)).toBeCloseTo(1 / 41, 10);
  });

  it("shares evenly between two notes with the same number of links", () => {
    expect(springShare(7, 7)).toBe(0.5);
    expect(springShare(1, 1)).toBe(0.5);
  });

  it("shares evenly when neither end has a counted link", () => {
    // Reachable only through an edge the layout is ignoring; sharing by a zero total would
    // put both ends at `NaN`, which is one node lost and the viewport's bounds with it.
    expect(springShare(0, 0)).toBe(0.5);
  });

  it("weakens a spring between two well-connected notes", () => {
    expect(springStrength(20, 30)).toBeLessThan(springStrength(2, 3));
  });

  it("keeps a leaf's only link at full strength however busy the other end is", () => {
    // The weakest link wins: a leaf's one link is all it has, and a hub on the other end is
    // not evidence that the leaf is unimportant.
    expect(springStrength(400, 1)).toBe(1);
    expect(springStrength(1, 400)).toBe(1);
  });

  it("does not divide by a degree of zero", () => {
    expect(springStrength(0, 0)).toBe(1);
  });
});

describe("the jiggle", () => {
  it("is small enough to separate a pair without moving the picture", () => {
    for (let seed = 0; seed < 50; seed += 1) {
      expect(Math.abs(jiggle(seed))).toBeLessThan(1e-6);
    }
  });

  it("gives the same answer for the same seed", () => {
    expect(jiggle(7)).toBe(jiggle(7));
    expect(jiggle(7)).not.toBe(jiggle(8));
  });
});

// ------------------------------------------------------------------ properties

/** A graph: how many nodes, and which pairs are linked. */
const graphs = fc
  .integer({ min: 1, max: 60 })
  .chain((count) =>
    fc.tuple(
      fc.constant(count),
      fc.array(
        fc.tuple(fc.integer({ min: 0, max: count - 1 }), fc.integer({ min: 0, max: count - 1 })),
        { maxLength: 120, size: "large" },
      ),
    ),
  );

describe("every graph", () => {
  it("draws the same picture twice", () => {
    // The property this module is arranged around. A `Math.random` anywhere in the forces —
    // or an iteration over a `Set` whose order came from insertion — breaks exactly this and
    // nothing else, and a reader would experience it as a graph that never looks familiar.
    fc.assert(
      fc.property(graphs, ([count, pairs]) => {
        const links = edges(...pairs);
        const first = settled(count, links, 40);
        const second = settled(count, links, 40);
        expect(Array.from(second.x)).toEqual(Array.from(first.x));
        expect(Array.from(second.y)).toEqual(Array.from(first.y));
      }),
      { numRuns: 120 },
    );
  });

  it("leaves every node somewhere real", () => {
    // A `NaN` position draws nothing, hit-tests as nothing, and takes the viewport's bounds
    // with it — one node lost this way makes the whole picture disappear.
    fc.assert(
      fc.property(graphs, ([count, pairs]) => {
        const layout = settled(count, edges(...pairs), 40);
        for (let i = 0; i < count; i += 1) {
          expect(Number.isFinite(layout.x[i] ?? Number.NaN)).toBe(true);
          expect(Number.isFinite(layout.y[i] ?? Number.NaN)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("settles rather than running forever", () => {
    fc.assert(
      fc.property(graphs, ([count, pairs]) => {
        const layout = new ForceLayout({ count, edges: edges(...pairs), ticks: 40 });
        for (let tick = 0; tick < 500 && !layout.settled; tick += 1) {
          layout.tick();
        }
        expect(layout.settled).toBe(true);
        expect(layout.ticks).toBeLessThanOrEqual(40);
      }),
      { numRuns: 100 },
    );
  });

  it("does not depend on where the nodes started drifting to", () => {
    // Ticking one at a time and ticking to completion have to agree, or something in the
    // simulation is reading state that a caller's frame rate can change.
    fc.assert(
      fc.property(graphs, ([count, pairs]) => {
        const links = edges(...pairs);
        const stepped = new ForceLayout({ count, edges: links, ticks: 30 });
        for (let tick = 0; tick < 30; tick += 1) {
          stepped.tick();
        }
        const all = settled(count, links, 30);
        expect(Array.from(stepped.x)).toEqual(Array.from(all.x));
      }),
      { numRuns: 80 },
    );
  });
});
