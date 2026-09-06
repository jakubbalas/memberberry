/**
 * Driving the global graph's layout in slices (`SPEC.md` §9.4, §21.3).
 *
 * Split from `graph-worker.ts` so that the worker file is a shim with nothing in it but its
 * `onmessage`, and everything with a decision in it lives here — where a test can drive it
 * with a `post` function and a clock rather than a Worker. The same code runs on both sides:
 * inside the worker on `setTimeout`, and on this thread on animation frames when a browser
 * will not give us a worker (see `createRunner`).
 */

import { ForceLayout } from "./graph-force.js";

/** How long a batch of ticks may take before the worker posts and yields, in milliseconds. */
const SLICE_MS = 12;

/** Start laying out a graph, replacing whatever the worker was doing. */
export interface LayoutRequest {
  readonly kind: "layout";
  /** A generation number, echoed back, so a late reply for an old graph can be ignored. */
  readonly run: number;
  readonly count: number;
  /** Flat triples of node indices, transferred rather than copied. */
  readonly edges: ArrayBuffer;
  readonly ticks?: number;
}

/** Positions as they stand, posted between batches and again when the layout settles. */
export interface LayoutFrame {
  readonly kind: "frame";
  readonly run: number;
  readonly x: ArrayBuffer;
  readonly y: ArrayBuffer;
  readonly ticks: number;
  readonly settled: boolean;
}

/** Everything the worker will accept. */
export type LayoutMessage = LayoutRequest | { readonly kind: "stop" };

/**
 * Drives a layout, posting a frame per time slice.
 *
 * Separated from the worker's own `onmessage` so it can be driven by a test with nothing
 * but a `post` function and a clock — and so the worker file itself holds no logic that is
 * only exercised in a browser.
 */
export function startLayout(
  request: LayoutRequest,
  post: (frame: LayoutFrame, transfer: ArrayBuffer[]) => void,
  schedule: (step: () => void) => void,
  now: () => number = () => Date.now(),
): () => void {
  const layout = new ForceLayout({
    count: request.count,
    edges: new Uint32Array(request.edges),
    ...(request.ticks === undefined ? {} : { ticks: request.ticks }),
  });
  let cancelled = false;

  const emit = (): void => {
    // why: a copy rather than a transfer of the layout's own arrays. Transferring detaches
    // them, and the simulation is still using them — the copy is 8 bytes a node, which at
    // ten thousand nodes is 80 KB a frame and cheaper than any of the alternatives that keep
    // the worker able to continue.
    const x = layout.x.slice();
    const y = layout.y.slice();
    post(
      {
        kind: "frame",
        run: request.run,
        x: x.buffer as ArrayBuffer,
        y: y.buffer as ArrayBuffer,
        ticks: layout.ticks,
        settled: layout.settled,
      },
      [x.buffer as ArrayBuffer, y.buffer as ArrayBuffer],
    );
  };

  const step = (): void => {
    if (cancelled) return;
    const deadline = now() + SLICE_MS;
    do {
      layout.tick();
    } while (!layout.settled && now() < deadline);
    emit();
    if (!layout.settled) schedule(step);
  };

  // The first frame goes out before any tick, so the picture appears at its starting
  // positions rather than after the first slice of work.
  emit();
  if (!layout.settled) schedule(step);
  return () => {
    cancelled = true;
  };
}

