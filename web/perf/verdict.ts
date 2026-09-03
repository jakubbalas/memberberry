/**
 * Turning samples into a verdict.
 *
 * All pure, and all unit tested, because this is where the harness decides whether the build
 * fails. A gate whose arithmetic is only exercised by running the whole browser harness is a
 * gate nobody can reason about.
 *
 * The shape of the decision is a **ratchet**. `SPEC.md` §21.2 states the budgets and §21.1
 * records that the bundle currently breaches one of them by 44%. A gate that simply failed on
 * any breach could not be turned on at all, and a gate that ignored breaches would be the
 * comment §21.3 warns about. So every breach is *enumerated* with the value it was recorded
 * at, and the build fails when a breach is new or when a known one gets worse. Fixing a
 * breach means deleting its entry.
 */

import type { Unit } from "./budgets.ts";

/**
 * How much worse than its recorded value a known breach may measure before the build fails.
 *
 * why: zero for bytes and 20% for time, because the two are not the same kind of number. A
 * gzip size is deterministic — the same input produces the same byte count, so any increase
 * is a real one. A timing sample is not: the same code on the same machine varies with
 * thermal state, what else is running and which way the scheduler went. A 0% ratchet on a
 * timing metric is a coin flip dressed as a gate, and AGENTS.md §2.3 is explicit that a
 * flaky check is a failing one.
 */
export const TOLERANCE: Readonly<Record<Unit, number>> = { bytes: 0, ms: 0.2 };

export type Status =
  /** At or under budget. */
  | "ok"
  /** Over budget, but a recorded breach covers it and it has not got worse. */
  | "known"
  /** Over budget with no recorded breach. Fails the build. */
  | "new-breach"
  /** Over a recorded breach by more than the tolerance. Fails the build. */
  | "regressed"
  /** Under budget while a breach is still recorded — the entry is stale. */
  | "improved";

export interface Verdict {
  readonly status: Status;
  /** True when this verdict should fail the run. */
  readonly fails: boolean;
  /** Human-readable explanation, always populated for anything but a plain `ok`. */
  readonly detail: string;
}

export interface VerdictInput {
  readonly measured: number;
  readonly budget: number;
  readonly unit: Unit;
  /** The value this metric's breach was recorded at, if it has one. */
  readonly recorded?: number;
}

/** The ceiling a known breach may not exceed. */
export function ceiling(recorded: number, unit: Unit): number {
  return recorded * (1 + TOLERANCE[unit]);
}

/**
 * Decides whether one measurement passes.
 *
 * A stale entry is only fatal for a deterministic unit. An improved *timing* number may be
 * one lucky sample, and failing the build on a lucky sample is how a gate teaches people to
 * re-run CI until it is green.
 */
export function judge(input: VerdictInput): Verdict {
  const { measured, budget, unit, recorded } = input;
  const within = measured <= budget;

  if (within && recorded === undefined) {
    return { status: "ok", fails: false, detail: "" };
  }
  if (within) {
    const fatal = TOLERANCE[unit] === 0;
    return {
      status: "improved",
      fails: fatal,
      detail:
        `now within budget, but perf/breaches.json still records a breach at ${recorded}. ` +
        `Delete the entry — a recorded breach nobody removes is a gate that has been ` +
        `permanently loosened.${fatal ? "" : " Not fatal: one timing sample is not proof."}`,
    };
  }
  if (recorded === undefined) {
    return {
      status: "new-breach",
      fails: true,
      detail:
        `over the SPEC §21.2 budget of ${budget} and nothing records it. Either bring it ` +
        `back under, or record it in perf/breaches.json with a reason and say so in SPEC ` +
        `§21.1 — §21.3 does not permit carrying a breach quietly.`,
    };
  }
  const limit = ceiling(recorded, unit);
  if (measured > limit) {
    return {
      status: "regressed",
      fails: true,
      detail:
        `a known breach got worse: recorded at ${recorded}, tolerance ` +
        `${Math.round(TOLERANCE[unit] * 100)}%, ceiling ${Math.round(limit)}.`,
    };
  }
  return {
    status: "known",
    fails: false,
    detail: `known breach, recorded at ${recorded} (SPEC §21.1). Budget is ${budget}.`,
  };
}

/**
 * The p-th percentile of `samples`, by nearest-rank on the sorted samples.
 *
 * why: nearest-rank rather than interpolation. §21.2's p95 figures are about "did any
 * interaction miss the frame", and an interpolated p95 can report a value no sample ever
 * took — which is the wrong answer to that question.
 */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) {
    throw new Error("percentile of no samples");
  }
  if (p <= 0 || p > 100) {
    throw new Error(`percentile ${p} is not in (0, 100]`);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const value = sorted[rank];
  if (value === undefined) {
    throw new Error(`percentile ${p}: rank ${rank} is outside ${sorted.length} samples`);
  }
  return value;
}

/** The median. Reported alongside every p95 so a skewed distribution is visible. */
export function median(samples: readonly number[]): number {
  return percentile(samples, 50);
}

/** A byte count or a duration, formatted the way its unit is read. */
export function format(value: number, unit: Unit): string {
  if (unit === "bytes") {
    return value >= 1024 * 1024
      ? `${(value / (1024 * 1024)).toFixed(2)} MB`
      : `${(value / 1024).toFixed(1)} KB`;
  }
  return value >= 100 ? `${Math.round(value)} ms` : `${value.toFixed(1)} ms`;
}
