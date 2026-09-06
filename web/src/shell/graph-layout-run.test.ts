/**
 * Driving a layout in slices (§9.4, §21.3).
 *
 * The worker's half of the graph, tested without a worker — which is the whole reason
 * `startLayout` takes its `post`, its scheduler and its clock from the caller. What matters
 * here is the pacing and the cancelling: a picture that never posts its first frame is a
 * blank canvas until the layout settles, and a run that keeps going after it has been
 * replaced is a picture of a graph nobody is looking at.
 */

import { describe, expect, it } from "vitest";

import { type LayoutFrame, type LayoutRequest, startLayout } from "./graph-layout-run.js";

/** A request for `count` nodes with no edges. */
function request(count: number, ticks = 12): LayoutRequest {
  return { kind: "layout", run: 7, count, edges: new Uint32Array(0).buffer, ticks };
}

/**
 * Runs a layout with a clock the test advances, and a scheduler it drains by hand.
 *
 * `elapse` is how much the clock moves per tick, so a test can decide whether a slice holds
 * one tick or all of them without depending on how fast the machine is.
 */
function drive(layout: LayoutRequest, elapse: number) {
  const frames: LayoutFrame[] = [];
  const transfers: ArrayBuffer[][] = [];
  const queue: (() => void)[] = [];
  let clock = 0;
  const cancel = startLayout(
    layout,
    (frame, transfer) => {
      frames.push(frame);
      transfers.push(transfer);
    },
    (step) => queue.push(step),
    () => {
      clock += elapse;
      return clock;
    },
  );
  const drain = (limit = 200): void => {
    for (let at = 0; at < limit && queue.length > 0; at += 1) {
      (queue.shift() ?? (() => undefined))();
    }
  };
  return { frames, transfers, queue, drain, cancel };
}

describe("starting a layout", () => {
  it("posts the starting positions before it does any work", () => {
    // Otherwise the canvas is empty until the first slice is over, which on a large vault is
    // a picture that appears out of nowhere rather than one that settles into place.
    const { frames } = drive(request(4), 0);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.ticks).toBe(0);
    expect(frames[0]?.settled).toBe(false);
    expect(new Float32Array(frames[0]?.x ?? new ArrayBuffer(0))).toHaveLength(4);
  });

  it("echoes the run number, so a late frame can be told from a current one", () => {
    const { frames } = drive(request(2), 0);
    expect(frames[0]?.run).toBe(7);
  });

  it("transfers the position buffers rather than copying them", () => {
    const { frames, transfers } = drive(request(3), 0);
    expect(transfers[0]).toEqual([frames[0]?.x, frames[0]?.y]);
  });

  it("posts a settled frame and stops when there is nothing to lay out", () => {
    const { frames, queue } = drive(request(0), 0);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.settled).toBe(true);
    expect(queue, "an empty graph must not ask for another slice").toHaveLength(0);
  });
});

describe("slicing", () => {
  it("runs the whole layout in one slice when the clock does not move", () => {
    // The deadline is a wall-clock one, so a clock that never advances means every tick fits.
    const { frames, drain } = drive(request(5, 10), 0);
    drain();
    const last = frames.at(-1);
    expect(last?.settled).toBe(true);
    expect(last?.ticks).toBe(10);
    expect(frames).toHaveLength(2);
  });

  it("posts a frame per slice when each tick spends the whole deadline", () => {
    // What a large vault looks like: one tick is more than a slice, so the picture updates
    // once per tick and the main thread hears from it that often.
    const { frames, drain } = drive(request(5, 4), 100);
    drain();
    expect(frames.map((frame) => frame.ticks)).toEqual([0, 1, 2, 3, 4]);
    expect(frames.at(-1)?.settled).toBe(true);
  });

  it("always advances by at least one tick, however slow the clock is", () => {
    // A `do…while` rather than a `while`: a deadline already spent before the first tick
    // would post the same frame forever and never finish.
    const { frames, drain } = drive(request(3, 6), 1_000_000);
    drain();
    expect(frames.at(-1)?.ticks).toBe(6);
  });

  it("asks for no further slice once it has settled", () => {
    const { queue, drain } = drive(request(3, 3), 100);
    drain();
    expect(queue).toHaveLength(0);
  });
});

describe("cancelling", () => {
  it("stops posting once it has been cancelled", () => {
    const { frames, queue, cancel } = drive(request(4, 20), 100);
    const before = frames.length;
    cancel();
    (queue.shift() ?? (() => undefined))();
    expect(frames).toHaveLength(before);
  });

  it("does not schedule anything more after a cancelled step", () => {
    const { queue, cancel } = drive(request(4, 20), 100);
    cancel();
    (queue.shift() ?? (() => undefined))();
    expect(queue).toHaveLength(0);
  });
});
