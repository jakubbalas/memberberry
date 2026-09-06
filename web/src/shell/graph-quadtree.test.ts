/**
 * The quadtree behind Barnes-Hut and hit testing (§9.4).
 *
 * Both of its questions have an obvious slow answer — sum every pair, scan every point — so
 * both are tested against exactly that. A tree is only worth having if it agrees with the
 * loop it replaced, and the properties at the bottom are where that is checked over shapes
 * nobody would think to write down: every point on one line, every point in one place, a
 * thousand points in a cluster with one far away.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { Quadtree } from "./graph-quadtree.js";

/** Points as two arrays, the shape the layout keeps them in. */
function points(pairs: readonly (readonly [number, number])[]): {
  x: Float32Array;
  y: Float32Array;
} {
  const x = new Float32Array(pairs.length);
  const y = new Float32Array(pairs.length);
  pairs.forEach(([px, py], at) => {
    x[at] = px;
    y[at] = py;
  });
  return { x, y };
}

function treeOver(pairs: readonly (readonly [number, number])[]): {
  tree: Quadtree;
  x: Float32Array;
  y: Float32Array;
} {
  const { x, y } = points(pairs);
  const tree = new Quadtree();
  tree.build(x, y, pairs.length);
  return { tree, x, y };
}

/** The nearest point by the loop the tree exists to replace. */
function nearestByScan(
  pairs: readonly (readonly [number, number])[],
  px: number,
  py: number,
  radius: number,
): number {
  let best = -1;
  let bestDistance = radius * radius;
  pairs.forEach(([qx, qy], at) => {
    const distance = (qx - px) ** 2 + (qy - py) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = at;
    }
  });
  return best;
}

/** The total repulsion on `(px, py)` by summing every pair, with no approximation. */
function forceByScan(
  pairs: readonly (readonly [number, number])[],
  px: number,
  py: number,
): [number, number] {
  let fx = 0;
  let fy = 0;
  for (const [qx, qy] of pairs) {
    const dx = qx - px;
    const dy = qy - py;
    const distanceSquared = dx * dx + dy * dy;
    if (distanceSquared === 0) continue;
    fx += dx / distanceSquared;
    fy += dy / distanceSquared;
  }
  return [fx, fy];
}

/** The same total, taken from the tree at `theta`. */
function forceByTree(tree: Quadtree, px: number, py: number, theta: number): [number, number] {
  let fx = 0;
  let fy = 0;
  tree.approximate(px, py, theta, (dx, dy, distanceSquared, mass) => {
    if (distanceSquared === 0) return;
    fx += (mass * dx) / distanceSquared;
    fy += (mass * dy) / distanceSquared;
  });
  return [fx, fy];
}

describe("building", () => {
  it("holds no quads for no points", () => {
    const { tree } = treeOver([]);
    expect(tree.quads).toBe(0);
    expect(tree.find(0, 0, 100)).toBe(-1);
  });

  it("finds the only point of a one-point tree", () => {
    const { tree } = treeOver([[3, 4]]);
    expect(tree.find(3, 4, 1)).toBe(0);
    expect(tree.find(0, 0, 6)).toBe(0);
  });

  it("does not run out of quads when every point is in the same place", () => {
    // The case that hangs a subdivision with no depth cap: nothing separates these, so the
    // tree splits until it stops being able to. It has to chain them instead.
    const same: [number, number][] = Array.from({ length: 64 }, () => [1.5, -2.5]);
    const { tree } = treeOver(same);
    // The quad count is the assertion that can see this. Without the cap the tree still
    // *answers* correctly — it just builds a chain of quads until the region halves its way
    // into a denormal, which is a hang in the worker rather than a wrong picture.
    expect(tree.quads).toBeLessThan(64);
    expect(tree.find(1.5, -2.5, 0.5)).toBe(0);
    let seen = 0;
    tree.approximate(1000, 1000, 0, () => {
      seen += 1;
    });
    expect(seen, "every coincident point is still a body").toBe(64);
  });

  it("handles points on a single line, where one axis has no extent", () => {
    const row: [number, number][] = Array.from({ length: 32 }, (_, at) => [at, 0]);
    const { tree } = treeOver(row);
    expect(tree.find(17.1, 0, 0.5)).toBe(17);
    expect(tree.find(17.1, 5, 0.5)).toBe(-1);
  });
});

describe("hit testing", () => {
  it("answers nothing when the nearest point is outside the radius", () => {
    const { tree } = treeOver([
      [0, 0],
      [100, 100],
    ]);
    expect(tree.find(70, 70, 10)).toBe(-1);
    expect(tree.find(70, 70, 80)).toBe(1);
  });

  it("refuses a radius that is not a positive number", () => {
    const { tree } = treeOver([[0, 0]]);
    expect(tree.find(0, 0, 0)).toBe(-1);
    expect(tree.find(0, 0, -1)).toBe(-1);
    expect(tree.find(0, 0, Number.NaN)).toBe(-1);
  });

  it("breaks a tie towards the lower index, so one overlap is always one note", () => {
    // Two nodes exactly the same distance away. Whichever the traversal met first would be
    // an answer that depends on the layout, and a click that opened a different note on a
    // second visit is a bug nobody could reproduce.
    const { tree } = treeOver([
      [-1, 0],
      [1, 0],
    ]);
    expect(tree.find(0, 0, 5)).toBe(0);
  });

  it("ignores a point whose position is not a number", () => {
    const { x, y } = points([
      [Number.NaN, 0],
      [2, 2],
    ]);
    const tree = new Quadtree();
    tree.build(x, y, 2);
    expect(tree.find(2, 2, 1)).toBe(1);
  });

  it("builds nothing at all when no point has a position", () => {
    const { x, y } = points([[Number.NaN, Number.NaN]]);
    const tree = new Quadtree();
    tree.build(x, y, 1);
    expect(tree.find(0, 0, 10)).toBe(-1);
  });
});

describe("Barnes-Hut", () => {
  it("is exact at theta zero", () => {
    // theta 0 means "never approximate", which turns the traversal back into the all-pairs
    // sum. If these two disagree the tree is losing or double-counting bodies, whatever the
    // approximation does.
    const pairs: [number, number][] = [
      [0, 0],
      [10, 0],
      [0, 10],
      [30, 40],
      [-25, 5],
    ];
    const { tree } = treeOver(pairs);
    const [tx, ty] = forceByTree(tree, 1, 1, 0);
    const [sx, sy] = forceByScan(pairs, 1, 1);
    expect(tx).toBeCloseTo(sx, 10);
    expect(ty).toBeCloseTo(sy, 10);
  });

  it("visits one mass for a distant cluster instead of every point in it", () => {
    // The whole point of the structure: a cluster far away is one body. Counting the visits
    // is the only way to see that from outside — the force it produces is the same either
    // way, which is what makes this worth asserting separately.
    const cluster: [number, number][] = Array.from({ length: 256 }, (_, at) => [
      (at % 16) * 0.1,
      Math.floor(at / 16) * 0.1,
    ]);
    const { tree } = treeOver(cluster);
    let visits = 0;
    tree.approximate(10_000, 10_000, 0.9, () => {
      visits += 1;
    });
    expect(visits).toBe(1);
  });

  it("reports each body once when the point being pushed is inside the cluster", () => {
    const pairs: [number, number][] = Array.from({ length: 40 }, (_, at) => [at % 7, at % 5]);
    const { tree } = treeOver(pairs);
    let bodies = 0;
    tree.approximate(3, 2, 0, (_dx, _dy, _distance, mass) => {
      bodies += mass;
    });
    expect(bodies).toBe(40);
  });
});

// ------------------------------------------------------------------ properties

/** A cloud of points, biased large — a small cloud is one where nothing clusters. */
const cloud = fc.array(
  fc.tuple(
    fc.float({ min: -500, max: 500, noNaN: true }),
    fc.float({ min: -500, max: 500, noNaN: true }),
  ),
  { minLength: 1, maxLength: 400, size: "large" },
);

describe("against the loop it replaces", () => {
  it("finds the same nearest point as a scan", () => {
    fc.assert(
      fc.property(
        cloud,
        fc.float({ min: -600, max: 600, noNaN: true }),
        fc.float({ min: -600, max: 600, noNaN: true }),
        fc.float({ min: Math.fround(0.01), max: 2000, noNaN: true }),
        (pairs, px, py, radius) => {
          const { tree } = treeOver(pairs);
          expect(tree.find(px, py, radius)).toBe(nearestByScan(pairs, px, py, radius));
        },
      ),
      { numRuns: 300 },
    );
  });

  it("sums every body exactly once, whatever the tree's shape", () => {
    // Mass is what Barnes-Hut trades bodies for, so "the masses add up to the point count"
    // is the invariant that catches a body counted twice or left in a quad nobody visited —
    // independently of whether the force it contributes looks plausible.
    fc.assert(
      fc.property(
        cloud,
        fc.float({ min: -600, max: 600, noNaN: true }),
        fc.float({ min: -600, max: 600, noNaN: true }),
        fc.float({ min: 0, max: Math.fround(1.5), noNaN: true }),
        (pairs, px, py, theta) => {
          const { tree } = treeOver(pairs);
          let total = 0;
          tree.approximate(px, py, theta, (_dx, _dy, _distance, mass) => {
            total += mass;
          });
          expect(total).toBe(pairs.length);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("agrees with the full sum when the angle is small enough to barely approximate", () => {
    // The tight one, and the one worth having: at theta 0.05 almost every quad is opened, so
    // any disagreement is a body the traversal lost, counted twice, or placed at the wrong
    // centre of mass — not an approximation error.
    fc.assert(
      fc.property(cloud, (pairs) => {
        const { tree } = treeOver(pairs);
        const [sx, sy] = forceByScan(pairs, 1200, 900);
        const [tx, ty] = forceByTree(tree, 1200, 900, 0.05);
        const magnitude = Math.hypot(sx, sy);
        fc.pre(magnitude > 1e-9);
        expect(Math.hypot(tx - sx, ty - sy) / magnitude).toBeLessThan(0.005);
      }),
      { numRuns: 200 },
    );
  });

  it("is as approximate as the opening angle says, and no more accurate than that", () => {
    // why: an example rather than a property, and this exact pair of points rather than a
    // tidy one. A property asserting "within 5% at theta 0.5" passed for several runs and
    // then failed on a seed, because the true worst case *is* 5% — a shrunk counterexample
    // from that run, kept here so the bound is a measurement rather than a hope
    // (`AGENTS.md` §2.3: a property that fails one run in ten is a flaky test).
    const pair: [number, number][] = [
      [0, 0],
      [451.9378356933594, -499.9993591308594],
    ];
    const { tree } = treeOver(pair);
    const [sx, sy] = forceByScan(pair, 1200, 900);
    const [tx, ty] = forceByTree(tree, 1200, 900, 0.5);
    const error = Math.hypot(tx - sx, ty - sy) / Math.hypot(sx, sy);
    expect(error).toBeGreaterThan(0.04);
    expect(error).toBeLessThan(0.06);
  });

  it("is more approximate still at the angle the layout actually uses", () => {
    // `graph-force.ts` opens at 0.9, which is d3-force's default and fast; two masses in
    // opposite corners of one quad are then summarised as a single body in the middle, and
    // the answer is a fifth out. Pinned so that nobody reads "Barnes-Hut" as "exact", and so
    // that a change to that constant shows up as a red test rather than as a picture that
    // settles differently for no visible reason.
    const corners: [number, number][] = [
      [-500, -500],
      [500, 500],
    ];
    const { tree } = treeOver(corners);
    const [sx, sy] = forceByScan(corners, 1200, 900);
    const [tx, ty] = forceByTree(tree, 1200, 900, 0.9);
    expect(Math.hypot(tx - sx, ty - sy) / Math.hypot(sx, sy)).toBeCloseTo(0.222, 2);
  });

  it("draws the same tree from the same points twice", () => {
    fc.assert(
      fc.property(cloud, (pairs) => {
        const first = treeOver(pairs);
        const second = treeOver(pairs);
        expect(second.tree.quads).toBe(first.tree.quads);
        expect(forceByTree(second.tree, 5, 5, 0.7)).toEqual(
          forceByTree(first.tree, 5, 5, 0.7),
        );
      }),
      { numRuns: 100 },
    );
  });

  it("is reusable: a rebuild answers for the new points and not the old ones", () => {
    // The layout rebuilds this every tick rather than allocating a new one, so state left
    // over from the previous build is a bug that would only show up as a picture drifting
    // towards where it used to be.
    fc.assert(
      fc.property(cloud, cloud, (first, second) => {
        const tree = new Quadtree();
        const one = points(first);
        tree.build(one.x, one.y, first.length);
        const two = points(second);
        tree.build(two.x, two.y, second.length);

        const fresh = new Quadtree();
        const same = points(second);
        fresh.build(same.x, same.y, second.length);
        expect(forceByTree(tree, 3, -7, 0.6)).toEqual(forceByTree(fresh, 3, -7, 0.6));
      }),
      { numRuns: 100 },
    );
  });
});
