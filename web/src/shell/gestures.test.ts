/**
 * Edge-swipe recognition (`SPEC.md` §8.3).
 *
 * Most of these are the *rejections*. The surface being swiped over is a text editor, so a
 * recogniser that is even slightly too eager steals selection drags and scrolls — and that
 * failure is intermittent, gesture-dependent and close to impossible to report usefully.
 * Cheaper to enumerate every way a gesture must be refused.
 */

import { describe, expect, it } from "vitest";

import { type SwipeStart, swipeProgress, swipeStart } from "./gestures.js";

const WIDTH = 400;
const options = { width: WIDTH } as const;

function down(
  x: number,
  overrides: Partial<Parameters<typeof swipeStart>[0]> = {},
): Parameters<typeof swipeStart>[0] {
  return {
    pointerId: 1,
    clientX: x,
    clientY: 300,
    pointerType: "touch",
    isPrimary: true,
    ...overrides,
  };
}

function move(x: number, y = 300, pointerId = 1) {
  return { pointerId, clientX: x, clientY: y };
}

function started(edge: "left" | "right"): SwipeStart {
  const start = swipeStart(down(edge === "left" ? 5 : WIDTH - 5), options);
  if (start === undefined) throw new Error("expected an edge swipe to start");
  return start;
}

describe("starting a swipe", () => {
  it("recognises a touch at either edge", () => {
    expect(swipeStart(down(5), options)?.edge).toBe("left");
    expect(swipeStart(down(WIDTH - 5), options)?.edge).toBe("right");
  });

  it("ignores a touch in the middle, where the text is", () => {
    expect(swipeStart(down(WIDTH / 2), options)).toBeUndefined();
  });

  it("ignores a mouse, which selects text near the window edge", () => {
    // On a narrow desktop window the layout is the mobile one, and a mouse drag starting at
    // the window edge is someone selecting a line — not someone opening a drawer.
    expect(swipeStart(down(5, { pointerType: "mouse" }), options)).toBeUndefined();
    expect(swipeStart(down(5, { pointerType: "pen" }), options)).toBeUndefined();
  });

  it("ignores a second finger, which means a pinch rather than a swipe", () => {
    expect(swipeStart(down(5, { isPrimary: false }), options)).toBeUndefined();
  });

  it("respects a wider edge when one is asked for", () => {
    expect(swipeStart(down(40), options)).toBeUndefined();
    expect(swipeStart(down(40), { ...options, edgeWidth: 60 })?.edge).toBe("left");
  });
});

describe("a swipe in progress", () => {
  it("stays pending until it has travelled far enough", () => {
    const start = started("left");
    expect(swipeProgress(start, move(20), options).kind).toBe("pending");
    expect(swipeProgress(start, move(60), options)).toEqual({ kind: "open", edge: "left" });
  });

  it("opens the right drawer when swiped inward from the right", () => {
    const start = started("right");
    expect(swipeProgress(start, move(WIDTH - 80), options)).toEqual({
      kind: "open",
      edge: "right",
    });
  });

  it("is cancelled when it heads outward instead of inward", () => {
    // Outward is not a gesture: it is how an *open* drawer is dismissed, which the drawer
    // handles itself.
    const start = started("left");
    expect(swipeProgress(start, move(-60), options).kind).toBe("cancelled");
  });

  it("is cancelled by a vertical drag, which is a scroll", () => {
    // The common case, and the one that matters most: a scroll starting near the edge must
    // never open a drawer.
    const start = started("left");
    expect(swipeProgress(start, move(10, 400), options).kind).toBe("cancelled");
  });

  it("stays pending for a diagonal that has not committed either way", () => {
    // Neither clearly horizontal nor clearly vertical: waiting is right, because guessing
    // wrong in either direction is worse than a moment of nothing happening.
    const start = started("left");
    expect(swipeProgress(start, move(60, 340), options).kind).toBe("pending");
  });

  it("opens on a mostly-horizontal drag that drifts a little", () => {
    const start = started("left");
    expect(swipeProgress(start, move(100, 320), options)).toEqual({ kind: "open", edge: "left" });
  });

  it("ignores a different pointer entirely", () => {
    // A second finger landing mid-gesture must not drive the swipe that the first started.
    const start = started("left");
    expect(swipeProgress(start, move(300, 300, 2), options).kind).toBe("pending");
  });

  it("honours a custom threshold", () => {
    const start = started("left");
    expect(swipeProgress(start, move(30), options).kind).toBe("pending");
    expect(swipeProgress(start, move(30), { ...options, threshold: 20 }).kind).toBe("open");
  });
});
