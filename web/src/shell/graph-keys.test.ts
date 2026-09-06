/**
 * The global graph's keyboard map (§8.4, §9.4).
 *
 * §8.4 says no mouse-only feature ships, and the interesting question for a picture is what
 * an arrow key *means* when there are no rows. It means the nearest node that way, which is
 * the part with cases worth writing down: a node behind you, a node off to the side, and the
 * first press when nothing is picked at all.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { KEY_ZOOM, graphKeyAction, nearestInDirection } from "./graph-keys.js";

function places(pairs: readonly (readonly [number, number])[]): [Float32Array, Float32Array] {
  const x = new Float32Array(pairs.length);
  const y = new Float32Array(pairs.length);
  pairs.forEach(([px, py], at) => {
    x[at] = px;
    y[at] = py;
  });
  return [x, y];
}

describe("moving to the nearest node in a direction", () => {
  const [x, y] = places([
    [0, 0], // 0: the middle
    [10, 0], // 1: right, near
    [40, 0], // 2: right, far
    [0, -10], // 3: up
    [0, 10], // 4: down
    [-10, 0], // 5: left
    [100, 3], // 6: right, far, slightly off
  ]);

  it("takes the nearest node the arrow points at", () => {
    expect(nearestInDirection(x, y, 7, 0, 1, 0)).toBe(1);
    expect(nearestInDirection(x, y, 7, 0, -1, 0)).toBe(5);
    expect(nearestInDirection(x, y, 7, 0, 0, -1)).toBe(3);
    expect(nearestInDirection(x, y, 7, 0, 0, 1)).toBe(4);
  });

  it("walks the picture rather than jumping across it", () => {
    // From the near one, Right goes to the next one along, not back to the middle.
    expect(nearestInDirection(x, y, 7, 1, 1, 0)).toBe(2);
  });

  it("ignores a node behind the direction pressed", () => {
    const [only, alsoY] = places([
      [0, 0],
      [-50, 0],
    ]);
    expect(nearestInDirection(only, alsoY, 2, 0, 1, 0)).toBe(-1);
  });

  it("ignores a node too far off to the side to be that way", () => {
    // A half-plane test would call this "up", and pressing Up to move sideways is a picture
    // that does not answer the key.
    const [sideways, alsoY] = places([
      [0, 0],
      [100, -1],
    ]);
    expect(nearestInDirection(sideways, alsoY, 2, 0, 0, -1)).toBe(-1);
  });

  it("accepts a node inside the cone", () => {
    const [inside, alsoY] = places([
      [0, 0],
      [5, -10],
    ]);
    expect(nearestInDirection(inside, alsoY, 2, 0, 0, -1)).toBe(1);
  });

  it("answers nothing for a starting node that is not in the picture", () => {
    expect(nearestInDirection(x, y, 7, -1, 1, 0)).toBe(-1);
    expect(nearestInDirection(x, y, 7, 99, 1, 0)).toBe(-1);
  });

  it("breaks a tie towards the lower index", () => {
    const [tied, alsoY] = places([
      [0, 0],
      [10, 0],
      [10, 0],
    ]);
    expect(nearestInDirection(tied, alsoY, 3, 0, 1, 0)).toBe(1);
  });
});

describe("what a key does", () => {
  const [x, y] = places([
    [0, 0],
    [10, 0],
    [20, 0],
  ]);

  it("does nothing at all in an empty picture", () => {
    const empty = new Float32Array(0);
    for (const key of ["ArrowUp", "Enter", "+", "0"]) {
      expect(graphKeyAction(key, empty, empty, 0, -1)).toEqual({ kind: "none" });
    }
  });

  it("picks something on the first arrow, so a keyboard can get in", () => {
    expect(graphKeyAction("ArrowRight", x, y, 3, -1)).toEqual({ kind: "select", to: 0 });
  });

  it("moves to the nearest node that way", () => {
    expect(graphKeyAction("ArrowRight", x, y, 3, 0)).toEqual({ kind: "select", to: 1 });
  });

  it("stays where it is when there is nothing that way", () => {
    expect(graphKeyAction("ArrowRight", x, y, 3, 2)).toEqual({ kind: "none" });
  });

  it("jumps to the ends", () => {
    expect(graphKeyAction("Home", x, y, 3, 2)).toEqual({ kind: "select", to: 0 });
    expect(graphKeyAction("End", x, y, 3, 0)).toEqual({ kind: "select", to: 2 });
  });

  it("opens what is picked, and only what is picked", () => {
    expect(graphKeyAction("Enter", x, y, 3, 1)).toEqual({ kind: "open" });
    expect(graphKeyAction(" ", x, y, 3, 1)).toEqual({ kind: "open" });
    expect(graphKeyAction("Enter", x, y, 3, -1)).toEqual({ kind: "none" });
  });

  it("zooms both ways, and frames everything with zero", () => {
    // §9.4 asks for a picture a reader can move around in, and a pointer-only zoom is a
    // mouse-only feature (§8.4).
    expect(graphKeyAction("+", x, y, 3, 0)).toEqual({ kind: "zoom", factor: KEY_ZOOM });
    expect(graphKeyAction("=", x, y, 3, 0)).toEqual({ kind: "zoom", factor: KEY_ZOOM });
    expect(graphKeyAction("-", x, y, 3, 0)).toEqual({ kind: "zoom", factor: 1 / KEY_ZOOM });
    expect(graphKeyAction("0", x, y, 3, 0)).toEqual({ kind: "fit" });
  });

  it("ignores everything else, so typing elsewhere is not swallowed", () => {
    for (const key of ["a", "Escape", "Tab", "F5", "PageDown"]) {
      expect(graphKeyAction(key, x, y, 3, 0), key).toEqual({ kind: "none" });
    }
  });
});

describe("every picture", () => {
  const clouds = fc.array(
    fc.tuple(
      fc.float({ min: -200, max: 200, noNaN: true }),
      fc.float({ min: -200, max: 200, noNaN: true }),
    ),
    { minLength: 1, maxLength: 60, size: "large" },
  );

  it("never selects a node that is not in it", () => {
    fc.assert(
      fc.property(
        clouds,
        fc.constantFrom("ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"),
        fc.integer({ min: -2, max: 80 }),
        (pairs, key, from) => {
          const [x, y] = places(pairs);
          const action = graphKeyAction(key, x, y, pairs.length, from);
          if (action.kind !== "select") return;
          expect(action.to).toBeGreaterThanOrEqual(0);
          expect(action.to).toBeLessThan(pairs.length);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("never moves to the node it is already on", () => {
    fc.assert(
      fc.property(
        clouds,
        fc.constantFrom("ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"),
        fc.nat(59),
        (pairs, key, seed) => {
          const [x, y] = places(pairs);
          const from = seed % pairs.length;
          const action = graphKeyAction(key, x, y, pairs.length, from);
          if (action.kind === "select") expect(action.to).not.toBe(from);
        },
      ),
      { numRuns: 300 },
    );
  });
});
