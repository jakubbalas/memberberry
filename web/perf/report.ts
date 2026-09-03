/**
 * Assembling measurements into a report, and deciding whether the run passed.
 *
 * Pure — everything here takes numbers and returns numbers or strings. That is deliberate:
 * the gate's arithmetic and its wording are the part most worth having tests for, and they
 * are the part a browser harness makes hardest to test if they live inside it.
 */

import { type Breaches, recordedFor } from "./breaches.ts";
import { BUDGETS, type DeviceClass, PENDING, budget } from "./budgets.ts";
import { format, judge, median, percentile, type Status, type Verdict } from "./verdict.ts";

/** One metric on one device class, measured and judged. */
export interface Row {
  readonly id: string;
  readonly metric: string;
  readonly device: DeviceClass;
  readonly measured: number;
  readonly budget: number;
  readonly formatted: string;
  readonly budgetFormatted: string;
  readonly samples: number;
  readonly verdict: Verdict;
  readonly caveat?: string;
}

export interface Report {
  readonly rows: readonly Row[];
  /** Anything the harness observed that is not a budgeted metric but changes how to read one. */
  readonly notes: readonly string[];
  readonly failures: readonly Row[];
}

/** One measurement, already reduced to the single number the budget compares against. */
export interface Reduced {
  readonly id: string;
  readonly device: DeviceClass;
  readonly value: number;
  readonly samples: number;
  readonly caveat?: string;
}

/** Reduces raw samples the way the metric asks to be reduced. */
export function reduce(
  samples: readonly number[],
  how: "median" | "p95" | "max",
): number {
  switch (how) {
    case "median":
      return median(samples);
    case "p95":
      return percentile(samples, 95);
    case "max":
      return Math.max(...samples);
  }
}

/**
 * Judges every reduced measurement against §21.2 and the recorded breaches.
 *
 * A measurement with no budget is an error rather than a skip: it means a metric id was
 * typed differently in two files, and the failure mode of ignoring it is a metric that
 * silently stops being gated.
 */
export function buildReport(
  measurements: readonly Reduced[],
  breaches: Breaches,
  notes: readonly string[] = [],
): Report {
  const rows: Row[] = [];
  for (const measurement of measurements) {
    const row = budget(measurement.id);
    if (row === undefined) {
      throw new Error(
        `${measurement.id} was measured but SPEC §21.2 has no budget for it. Either add it ` +
          "to budgets.ts or stop measuring it — an unbudgeted measurement gates nothing.",
      );
    }
    const limit = row[measurement.device];
    const recorded = recordedFor(breaches, measurement.id, measurement.device);
    const verdict = judge({
      measured: measurement.value,
      budget: limit,
      unit: row.unit,
      ...(recorded === undefined ? {} : { recorded }),
    });
    rows.push({
      id: measurement.id,
      metric: row.note === undefined ? row.metric : `${row.metric} (${row.note})`,
      device: measurement.device,
      measured: measurement.value,
      budget: limit,
      formatted: format(measurement.value, row.unit),
      budgetFormatted: format(limit, row.unit),
      samples: measurement.samples,
      verdict,
      ...(measurement.caveat === undefined ? {} : { caveat: measurement.caveat }),
    });
  }
  return { rows, notes, failures: rows.filter((r) => r.verdict.fails) };
}

/**
 * Budgets that nothing measured, which is a hole in the harness rather than a pass.
 *
 * Per device class, not pooled. An earlier version compared against every row in the report,
 * so a metric measured on mobile and missing on desktop counted as covered — and the missing
 * half was invisible. `undefined` means every device class.
 */
export function unmeasured(rows: readonly Row[], device?: DeviceClass): readonly string[] {
  const pending = new Set(PENDING.map((entry) => entry.id));
  const scoped = device === undefined ? rows : rows.filter((row) => row.device === device);
  const measured = new Set(scoped.map((row) => row.id));
  return BUDGETS.filter((row) => !measured.has(row.id) && !pending.has(row.id)).map(
    (row) => row.id,
  );
}

/** Metrics measured once for the whole system rather than per device class. */
const STATIC_METRICS = new Set(["critical-bundle-gzip", "server-memory-idle"]);

const MARK: Readonly<Record<Status, string>> = {
  ok: "ok  ",
  known: "KNOWN",
  improved: "BETTER",
  "new-breach": "OVER",
  regressed: "WORSE",
};

/** The report, as the fixed-width table `make perf` prints. */
export function formatReport(report: Report): string {
  const lines: string[] = [];
  const width = Math.max(...report.rows.map((row) => row.metric.length), 20);

  for (const device of ["desktop", "mobile"] as const) {
    const rows = report.rows.filter((row) => row.device === device);
    if (rows.length === 0) continue;
    lines.push("", `  ${device}`);
    for (const row of rows) {
      lines.push(
        `  ${MARK[row.verdict.status].padEnd(6)} ${row.metric.padEnd(width)}  ` +
          `${row.formatted.padStart(10)}  budget ${row.budgetFormatted.padStart(10)}  ` +
          `n=${row.samples}`,
      );
      if (row.caveat !== undefined) lines.push(`         ↳ ${row.caveat}`);
      if (row.verdict.detail !== "") lines.push(`         ↳ ${row.verdict.detail}`);
    }
  }

  if (report.notes.length > 0) {
    lines.push("", "  observed");
    for (const note of report.notes) lines.push(`  · ${note}`);
  }

  // A bundle-only run has no per-device story to tell, so it gets one pooled list; a full run
  // reports each device separately, because a metric measured on one and missing on the other
  // is a hole in exactly one of them.
  const browserRan = report.rows.some((row) => !STATIC_METRICS.has(row.id));
  const holesFor: Array<[string, readonly string[]]> = browserRan
    ? (["desktop", "mobile"] as const).map((device) => [device, unmeasured(report.rows, device)])
    : [["this run", unmeasured(report.rows)]];
  for (const [scope, holes] of holesFor) {
    if (holes.length === 0) continue;
    lines.push("", `  budgeted but NOT MEASURED on ${scope} — a hole, not a pass`);
    for (const id of holes) lines.push(`  · ${id}`);
  }

  lines.push("", "  not measurable yet, and why");
  for (const entry of PENDING) {
    lines.push(`  · ${entry.metric} — ${entry.blockedBy}: ${entry.reason}`);
  }

  return lines.join("\n");
}
