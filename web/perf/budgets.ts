/**
 * The performance budgets of `SPEC.md` §21.2, as data.
 *
 * This file is the single place a budget number is written down on this side of the repo.
 * §21.3 says a budget nobody checks is a comment, and the corollary is that a budget written
 * in two places is a budget one of them is wrong about.
 *
 * A metric that the harness cannot measure yet is still listed, with the milestone that
 * unblocks it. That is deliberate: the gap between "budgeted" and "measured" is the most
 * useful thing this file has to say, and leaving unmeasurable metrics out would hide it.
 */

/** The two reference device classes of `SPEC.md` §21.1. */
export type DeviceClass = "mobile" | "desktop";

export const DEVICE_CLASSES: readonly DeviceClass[] = ["mobile", "desktop"];

/** What a number means, which decides how it is formatted and compared. */
export type Unit = "ms" | "bytes";

/**
 * A budget the harness measures today.
 *
 * `mobile` and `desktop` are the two columns of §21.2. A metric measured once for the whole
 * system rather than per device — the bundle, the server's memory — carries the same number
 * in both, which is also how §21.2 writes it ("same").
 */
export interface Budget {
  readonly id: string;
  /** How §21.2 names the row, so a report can be read against the spec. */
  readonly metric: string;
  readonly unit: Unit;
  readonly mobile: number;
  readonly desktop: number;
  /** §21.2's own qualifier, e.g. "p95". Reported so a number is never quoted without it. */
  readonly note?: string;
}

/**
 * A budget nothing can measure yet, and the milestone that changes that.
 *
 * why: listed rather than omitted. An unmeasured budget is the thing most likely to be
 * breached, because nothing is looking — recording which ones those are is the point.
 */
export interface Pending {
  readonly id: string;
  readonly metric: string;
  readonly blockedBy: string;
  readonly reason: string;
}

export const BUDGETS: readonly Budget[] = [
  {
    // M6 (§7.4) is what made this measurable: before the service worker there was no warm
    // cache to start from. Measured with one browser context across the samples and a fresh
    // page for each, and dropped entirely if no worker takes control — see `measure.ts`.
    id: "cold-start-warm-cache",
    metric: "Cold start → interactive, warm SW cache",
    unit: "ms",
    mobile: 1_500,
    desktop: 800,
  },
  {
    id: "cold-start-first-visit",
    metric: "Cold start → interactive, first ever visit",
    unit: "ms",
    mobile: 3_000,
    desktop: 2_000,
  },
  {
    id: "open-note",
    metric: "Open note ≤ 5k words, locally resident",
    unit: "ms",
    mobile: 150,
    desktop: 80,
  },
  {
    id: "keystroke-to-paint",
    metric: "Keystroke → paint",
    unit: "ms",
    mobile: 16,
    desktop: 16,
    note: "p95",
  },
  {
    id: "inp",
    metric: "INP (Interaction to Next Paint)",
    unit: "ms",
    mobile: 200,
    desktop: 100,
    note: "p95",
  },
  {
    id: "longest-task",
    metric: "Longest main-thread task",
    unit: "ms",
    mobile: 50,
    desktop: 50,
  },
  {
    id: "quick-switcher",
    metric: "Quick-switcher results, 10k notes",
    unit: "ms",
    mobile: 80,
    desktop: 50,
  },
  {
    // why: time rather than rate. §21.2 writes this row as "≥ 30 fps", and every other number
    // in this file is one where lower is better — a harness with two comparison directions is
    // a harness with a branch that can be wrong about which way a budget runs. 30 fps is a
    // frame every 33.3 ms, so that is the number, and §21.2 says so.
    id: "graph-fps",
    metric: "Graph frame time, whole vault (30 fps = 33.3 ms)",
    unit: "ms",
    mobile: 33.3,
    desktop: 33.3,
    note: "p95, while the camera moves every frame; mobile is capped to 2,000 nodes (§9.4)",
  },
  {
    id: "critical-bundle-gzip",
    metric: "Initial JS + WASM, gzip (excl. lazy Excalidraw)",
    unit: "bytes",
    mobile: 350 * 1024,
    desktop: 350 * 1024,
  },
  {
    id: "server-memory-idle",
    metric: "Server memory, idle, 10k notes",
    unit: "bytes",
    mobile: 150 * 1024 * 1024,
    desktop: 150 * 1024 * 1024,
    note: "server-side; no device class",
  },
  {
    id: "reindex",
    metric: "Full reindex, 10k notes",
    unit: "ms",
    // §21.2 gives this row a desktop figure and a dash for mobile: it is server work, and a
    // phone is not the machine that does it. The same number goes in both columns because a
    // budget of `undefined` would make the metric unreportable rather than unbudgeted.
    mobile: 30_000,
    desktop: 30_000,
    note: "server-side; no device class. §21.8 has where the time goes",
  },
];

export const PENDING: readonly Pending[] = [
  {
    id: "scroll-fps",
    metric: "Scroll, 60 fps sustained",
    blockedBy: "M7 follow-up",
    reason:
      "needs a frame-by-frame timeline rather than a mark; CDP can produce one and reading " +
      "it honestly is its own piece of work, so it is named here rather than faked",
  },
  {
    id: "search",
    metric: "Full-text search, 10k notes, offline index",
    blockedBy: "M9",
    reason: "there is no search index to query",
  },
  {
    id: "client-index-size",
    metric: "Client search index, 10k notes",
    blockedBy: "M9",
    reason: "there is no client index to size",
  },
  {
    id: "peak-memory",
    metric: "Peak memory, 10k-note vault, index loaded",
    blockedBy: "M9",
    reason:
      "the budget is written for a loaded index, which does not exist. The JS heap is " +
      "measurable today but is not the same quantity, and reporting it under this row " +
      "would be a number that looks like compliance without being it",
  },
];

/** The budget for `id` on `device`, or `undefined` if nothing budgets it. */
export function budgetFor(id: string, device: DeviceClass): number | undefined {
  const budget = BUDGETS.find((candidate) => candidate.id === id);
  return budget === undefined ? undefined : budget[device];
}

/** The budget row for `id`, or `undefined`. */
export function budget(id: string): Budget | undefined {
  return BUDGETS.find((candidate) => candidate.id === id);
}
