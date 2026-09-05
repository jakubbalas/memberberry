/**
 * Where the local graph's nodes end up (§9.4).
 *
 * The examples pin the decisions — the origin at the centre, one ring per hop, a size from
 * the degree — and the properties pin what has to be true of *every* picture: nothing
 * outside the frame, nothing on top of anything else, and the same input drawing the same
 * output. A layout that is right for four nodes and puts the fortieth off the panel is the
 * failure a table of examples does not find.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { GraphEdge, GraphNode } from "./graph.js";
import { degrees } from "./graph.js";
import { CENTRE, VIEWPORT, labelAnchor, layoutGraph, radiusOf } from "./graph-layout.js";

const node = (key: string, hop: number): GraphNode => ({
  key,
  path: `${key}.md`,
  label: key,
  hop,
});

const edge = (source: string, target: string): GraphEdge => ({
  source,
  target,
  embed: false,
});

/** Lay out a graph, taking the degrees from the edges as the panel does. */
function place(nodes: readonly GraphNode[], edges: readonly GraphEdge[] = []) {
  return layoutGraph(nodes, edges, degrees({ nodes, edges }));
}

describe("laying out a neighbourhood", () => {
  it("puts the origin in the middle", () => {
    const { places } = place([node("a", 0)]);
    expect(places.get("a")).toMatchObject({ x: CENTRE, y: CENTRE });
  });

  it("draws nothing for an empty graph rather than dividing by zero", () => {
    const layout = place([]);
    expect(layout.places.size).toBe(0);
    expect(layout.ordered).toEqual([]);
  });

  it("puts every node of one hop at the same distance from the centre", () => {
    const { places } = place([node("a", 0), node("b", 1), node("c", 1), node("d", 2)]);
    const distance = (key: string): number => {
      const at = places.get(key);
      return at === undefined ? Number.NaN : Math.hypot(at.x - CENTRE, at.y - CENTRE);
    };
    expect(distance("b")).toBeCloseTo(distance("c"), 6);
    expect(distance("d")).toBeGreaterThan(distance("b"));
  });

  it("uses the whole radius when there is only one ring", () => {
    // A one-hop graph drawn on the inner third of the panel wastes the panel.
    const one = place([node("a", 0), node("b", 1)]);
    const two = place([node("a", 0), node("b", 1), node("c", 2)]);
    const reach = (layout: ReturnType<typeof place>, key: string): number => {
      const at = layout.places.get(key);
      return at === undefined ? Number.NaN : Math.hypot(at.x - CENTRE, at.y - CENTRE);
    };
    expect(reach(one, "b")).toBeGreaterThan(reach(two, "b"));
    expect(reach(one, "b")).toBeCloseTo(reach(two, "c"), 6);
  });

  it("paints the origin last, so a crowded ring never draws over it", () => {
    const { ordered } = place([node("a", 0), node("b", 1), node("c", 2)]);
    expect(ordered.map((at) => at.key)).toEqual(["c", "b", "a"]);
  });

  it("sizes a node by how connected it is within the picture", () => {
    const nodes = [node("hub", 0), node("b", 1), node("c", 1), node("d", 1)];
    const edges = [edge("hub", "b"), edge("hub", "c"), edge("hub", "d")];
    const { places } = place(nodes, edges);
    const hub = places.get("hub")?.r ?? 0;
    const leaf = places.get("b")?.r ?? 0;
    expect(hub).toBeGreaterThan(leaf);
  });

  it("gives every node the same size when nothing is connected", () => {
    const { places } = place([node("a", 0), node("b", 1)]);
    expect(places.get("a")?.r).toBe(places.get("b")?.r);
  });

  it("places a node near the neighbour it hangs off", () => {
    // The one piece of art in the layout: `c` links only to `b`, so it belongs beside `b`
    // rather than at whichever angle its key sorts to. Ordering by key alone would put `c`
    // between `b` and `d` on the outer ring irrespective of what it is attached to.
    const nodes = [node("a", 0), node("b", 1), node("z", 1), node("c", 2), node("y", 2)];
    const edges = [edge("a", "b"), edge("a", "z"), edge("b", "c"), edge("z", "y")];
    const { places } = place(nodes, edges);
    const angle = (key: string): number => {
      const at = places.get(key);
      return at === undefined ? Number.NaN : Math.atan2(at.y - CENTRE, at.x - CENTRE);
    };
    const gap = (one: string, two: string): number => {
      const raw = Math.abs(angle(one) - angle(two));
      return Math.min(raw, 2 * Math.PI - raw);
    };
    expect(gap("c", "b")).toBeLessThan(gap("c", "z"));
    expect(gap("y", "z")).toBeLessThan(gap("y", "b"));
  });
});

describe("what a click actually hits", () => {
  it("is bigger than the dot when there is room, because the dot is a few millimetres", () => {
    const { places } = place([node("a", 0), node("b", 1), node("c", 1)]);
    for (const at of places.values()) expect(at.hit).toBeGreaterThan(at.r);
  });

  it("never overlaps a neighbour's, so a tap belongs to exactly one node", () => {
    const nodes = [node("a", 0), ...Array.from({ length: 9 }, (_, n) => node(`n${n}`, 1))];
    const { places } = place(nodes);
    const all = [...places.values()];
    for (const one of all) {
      for (const other of all) {
        if (one.key === other.key) continue;
        const gap = Math.hypot(one.x - other.x, one.y - other.y);
        expect(one.hit + other.hit).toBeLessThanOrEqual(gap + 1e-9);
      }
    }
  });

  it("does not reach past a neighbour to keep a big dot surrounded", () => {
    // Regression, from the property below: the hit area used to be floored at the dot's own
    // radius, and on a ring of nine around a hub the floor reached further than half the
    // distance to the next node — an overlap, which is the one thing this sizing exists to
    // prevent. Nine at hop 1 and one far out, so the rings are tight.
    const nodes = [
      node("hub", 0),
      ...Array.from({ length: 9 }, (_, n) => node(`n${n}`, 1)),
      node("far", 3),
    ];
    const edges = [edge("hub", "n5")];
    const all = [...place(nodes, edges).places.values()];
    for (const one of all) {
      for (const other of all) {
        if (one.key === other.key) continue;
        expect(one.hit + other.hit).toBeLessThanOrEqual(
          Math.hypot(one.x - other.x, one.y - other.y) + 1e-9,
        );
      }
    }
  });

  it("shrinks as a ring fills up, rather than letting two nodes claim one tap", () => {
    const sparse = place([node("a", 0), node("b", 1), node("c", 1)]);
    const crowded = place([
      node("a", 0),
      ...Array.from({ length: 40 }, (_, n) => node(`n${n}`, 1)),
    ]);
    expect(crowded.places.get("n0")?.hit ?? 0).toBeLessThan(sparse.places.get("b")?.hit ?? 0);
  });

  it("takes the ceiling for a graph of one node, which has no neighbour to avoid", () => {
    const alone = place([node("a", 0)]);
    const crowded = place([node("a", 0), node("b", 1), node("c", 1)]);
    expect(alone.places.get("a")?.hit ?? 0).toBeGreaterThanOrEqual(
      crowded.places.get("a")?.hit ?? 0,
    );
  });
});

describe("the same graph, sent two different ways", () => {
  // Regression, shrunk from the property below. The ring anchor is the circular mean of a
  // node's already-placed neighbours, and floating-point addition is not associative — so
  // summing those unit vectors in the order the edges happened to arrive gave a slightly
  // different angle for the same graph, which was enough to flip a near-tie in the ring's
  // sort and redraw the whole picture. Deterministic here on purpose: the property finds
  // this on some seeds and not others, and a test that only sometimes fails is not one.
  const nodes = [
    node("k0", 0),
    node("k1", 2),
    node("k2", 2),
    node("k3", 1),
    node("k4", 1),
    node("k5", 1),
  ];
  const edges = [edge("k1", "k0"), edge("k4", "k1"), edge("k1", "k5"), edge("k2", "k4")];

  it("draws every node in the same spot whichever order it arrives in", () => {
    const forwards = place(nodes, edges).places;
    const backwards = place([...nodes].reverse(), [...edges].reverse()).places;
    for (const [key, at] of forwards) {
      expect(backwards.get(key)?.x).toBeCloseTo(at.x, 9);
      expect(backwards.get(key)?.y).toBeCloseTo(at.y, 9);
    }
  });

  it("paints them in the same order too, so nothing swaps which is on top", () => {
    // `Array.prototype.sort` is stable, so two nodes on one ring keep the order they arrived
    // in unless something else breaks the tie — and which of two overlapping dots is drawn
    // over the other is a visible difference.
    const forwards = place(nodes, edges).ordered.map((at) => at.key);
    const backwards = place([...nodes].reverse(), [...edges].reverse()).ordered.map(
      (at) => at.key,
    );
    expect(backwards).toEqual(forwards);
  });
});

describe("a node's drawn radius", () => {
  it("is the floor for a node with no edges", () => {
    expect(radiusOf(0, 5)).toBeLessThan(radiusOf(1, 5));
  });

  it("does not exceed the ceiling for a degree beyond the maximum", () => {
    expect(radiusOf(50, 5)).toBe(radiusOf(5, 5));
  });

  it("is the floor when there is no maximum to scale against", () => {
    expect(radiusOf(3, 0)).toBe(radiusOf(0, 1));
  });
});

describe("where a label hangs", () => {
  it("stays centred in the middle band and turns inwards near an edge", () => {
    expect(labelAnchor(CENTRE)).toBe("middle");
    expect(labelAnchor(VIEWPORT - 1)).toBe("end");
    expect(labelAnchor(1)).toBe("start");
  });
});

// ---------------------------------------------------------------------------------------
// Properties. A graph of `n` nodes with hops assigned from a walk, and arbitrary edges over
// the keys — the same shapes the server produces, without hand-picking any of them.
// ---------------------------------------------------------------------------------------

/** Nodes `k0`..`k{n-1}`, the first at hop 0, the rest spread over hops 1–3. */
const graphs = fc
  // why: `size: "large"`. fast-check biases arrays small by default, and small pictures are
  // exactly the ones where nothing crowds — a probe that gave every node the maximum hit
  // area passed against the default generator and was caught only by a hand-written example.
  .array(fc.integer({ min: 1, max: 3 }), {
    minLength: 0,
    maxLength: 40,
    size: "large",
  })
  .chain((hops) => {
    const nodes = [node("k0", 0), ...hops.map((hop, index) => node(`k${index + 1}`, hop))];
    const keys = nodes.map((entry) => entry.key);
    return fc
      .array(fc.tuple(fc.constantFrom(...keys), fc.constantFrom(...keys)), {
        maxLength: 60,
      })
      .map((pairs) => ({
        nodes,
        edges: pairs.filter(([from, to]) => from !== to).map(([from, to]) => edge(from, to)),
      }));
  });

describe("every picture the layout can draw", () => {
  it("places every node, and only nodes it was given", () => {
    fc.assert(
      fc.property(graphs, ({ nodes, edges }) => {
        const { places, ordered } = place(nodes, edges);
        expect(places.size).toBe(nodes.length);
        expect(ordered).toHaveLength(nodes.length);
        for (const entry of nodes) expect(places.has(entry.key)).toBe(true);
      }),
    );
  });

  it("never lets two hit areas overlap, however crowded the picture", () => {
    // The property behind the tap: two overlapping hit areas mean one tap belongs to two
    // nodes, and whichever the browser picks is the wrong one about half the time.
    fc.assert(
      fc.property(graphs, ({ nodes, edges }) => {
        const all = [...place(nodes, edges).places.values()];
        for (let i = 0; i < all.length; i += 1) {
          for (let j = i + 1; j < all.length; j += 1) {
            const one = all[i];
            const other = all[j];
            if (one === undefined || other === undefined) continue;
            const gap = Math.hypot(one.x - other.x, one.y - other.y);
            expect(one.hit + other.hit).toBeLessThanOrEqual(gap + 1e-9);
          }
        }
      }),
    );
  });

  it("keeps every node inside the frame, its own radius included", () => {
    fc.assert(
      fc.property(graphs, ({ nodes, edges }) => {
        for (const at of place(nodes, edges).places.values()) {
          expect(at.x - at.r).toBeGreaterThanOrEqual(0);
          expect(at.y - at.r).toBeGreaterThanOrEqual(0);
          expect(at.x + at.r).toBeLessThanOrEqual(VIEWPORT);
          expect(at.y + at.r).toBeLessThanOrEqual(VIEWPORT);
        }
      }),
    );
  });

  it("gives every node a real coordinate", () => {
    fc.assert(
      fc.property(graphs, ({ nodes, edges }) => {
        for (const at of place(nodes, edges).places.values()) {
          expect(Number.isFinite(at.x) && Number.isFinite(at.y) && Number.isFinite(at.r)).toBe(
            true,
          );
        }
      }),
    );
  });

  it("never puts two nodes in the same place", () => {
    fc.assert(
      fc.property(graphs, ({ nodes, edges }) => {
        const seen = new Set<string>();
        for (const at of place(nodes, edges).places.values()) {
          const spot = `${at.x.toFixed(6)},${at.y.toFixed(6)}`;
          expect(seen.has(spot)).toBe(false);
          seen.add(spot);
        }
      }),
    );
  });

  it("draws the same picture twice for the same graph", () => {
    fc.assert(
      fc.property(graphs, ({ nodes, edges }) => {
        const first = place(nodes, edges);
        const second = place(nodes, edges);
        expect([...second.places.entries()]).toEqual([...first.places.entries()]);
      }),
    );
  });

  it("does not depend on the order the nodes arrived in", () => {
    // The server orders by hop and key; a layout that also depended on that order would
    // redraw itself differently the day the query's `ORDER BY` changed.
    fc.assert(
      fc.property(graphs, ({ nodes, edges }) => {
        const forwards = place(nodes, edges).places;
        const backwards = place([...nodes].reverse(), [...edges].reverse()).places;
        for (const [key, at] of forwards) {
          expect(backwards.get(key)?.x).toBeCloseTo(at.x, 9);
          expect(backwards.get(key)?.y).toBeCloseTo(at.y, 9);
        }
      }),
      { numRuns: 500 },
    );
  });
});
