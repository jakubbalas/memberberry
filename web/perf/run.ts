/**
 * The performance harness (`SPEC.md` §21, §23 M7 — the last open M0 box).
 *
 * `make perf` runs this. It measures every §21.2 budget it honestly can, on both device
 * classes of §21.1, against the generated 10 000-note vault §21 names, and fails when a
 * budget is breached and nothing records that breach.
 *
 *   node --experimental-strip-types perf/run.ts [--bundle-only] [--report-only] [--record]
 *
 *   --bundle-only  skip the browser. The bundle budget is the one deterministic metric, so
 *                  this is the part that can gate a CI runner whose timing nobody has
 *                  characterised.
 *   --report-only  measure and print, but exit 0 whatever the verdicts are. What CI uses for
 *                  the browser half: §21.1 wants the desktop class pinned to "CI runner
 *                  spec, fixed and recorded", and until somebody records it, enforcing an
 *                  absolute millisecond budget on a shared runner would produce a flaky
 *                  gate — which AGENTS.md §2.3 counts as a failing one.
 *   --record       print the `perf/breaches.json` entries this run would need, instead of
 *                  writing them. Deliberately not automatic: a breach has to be given a
 *                  reason by a person, and a tool that records one silently is how a budget
 *                  stops being a budget.
 *
 * Entry shim, so it is excluded from the coverage floors the way `src/main.ts` is: it wires
 * the measured pieces together and everything it calls is tested on its own.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadBreaches } from "./breaches.ts";
import { measureBundle } from "./bundle.ts";
import { DEVICE_CLASSES, type DeviceClass } from "./budgets.ts";
import { PROFILES, measureBrowser } from "./measure.ts";
import { buildReport, formatReport, reduce, type Reduced } from "./report.ts";
import { REPO, residentBytes, startServer } from "./server.ts";
import { format } from "./verdict.ts";

const OUT = join(REPO, "target", "perf");
const BREACHES = join(REPO, "web", "perf", "breaches.json");
const DIST = join(REPO, "web", "dist");

const argv = process.argv.slice(2);
const bundleOnly = argv.includes("--bundle-only");
const reportOnly = argv.includes("--report-only");
const recording = argv.includes("--record");

async function main(): Promise<number> {
  const breaches = loadBreaches(BREACHES);
  const measurements: Reduced[] = [];
  const notes: string[] = [];

  const bundle = measureBundle(DIST);
  for (const device of DEVICE_CLASSES) {
    measurements.push({
      id: "critical-bundle-gzip",
      device,
      value: bundle.totalGzip,
      samples: 1,
    });
  }
  notes.push(
    `bundle, raw: ${format(bundle.totalRaw, "bytes")} across ${bundle.assets.length} assets ` +
      `(${bundle.assets.map((a) => `${a.name} ${format(a.gzip, "bytes")}`).join(", ")})`,
  );
  if (bundle.excluded.length > 0) {
    notes.push(`excluded as lazily loaded: ${bundle.excluded.join(", ")}`);
  }

  if (!bundleOnly) {
    const server = await startServer();
    try {
      const runs = await measureBrowser(server.origin, PROFILES);
      for (const run of runs) {
        for (const measurement of run.measurements) {
          measurements.push({
            id: measurement.id,
            device: run.device,
            value: reduce(measurement.samples, measurement.reduce),
            samples: measurement.samples.length,
            ...(measurement.caveat === undefined ? {} : { caveat: measurement.caveat }),
          });
        }
        if (run.cpuThrottle !== 1) {
          notes.push(
            `${run.device} numbers are Chromium with the CPU throttled ${run.cpuThrottle}x, ` +
              "not a Pixel 7a. See perf/measure.ts on what that does and does not tell you.",
          );
        }
        notes.push(
          `${run.device} cold load actually transferred ` +
            `${format(run.observedTransfer, "bytes")} of JS + WASM, ` +
            `${run.observedCompressed ? "compressed" : "**uncompressed**"}.`,
        );
        for (const lost of run.lost) {
          notes.push(`${run.device} measured nothing for ${lost}`);
        }
      }

      // Measured last, and after the browser has driven the whole app: "idle" in §21.2 is
      // more usefully read as "idle after use" than as "idle before anything happened", and
      // the second reading is the one that would flatter the number.
      const resident = residentBytes(server.pid);
      for (const device of DEVICE_CLASSES) {
        measurements.push({
          id: "server-memory-idle",
          device,
          value: resident,
          samples: 1,
          caveat: "resident set size after the whole run, not before it",
        });
      }
    } finally {
      server.stop();
    }
  }

  const report = buildReport(measurements, breaches, notes);
  console.log(formatReport(report));

  mkdirSync(OUT, { recursive: true });
  const json = join(OUT, "report.json");
  writeFileSync(json, `${JSON.stringify({ measuredAt: Date.now(), report }, null, 2)}\n`, "utf8");
  console.log(`\n  report: ${json}`);

  if (recording) {
    console.log(`\n  entries this run would need in perf/breaches.json:\n`);
    console.log(suggest(report.failures));
  }

  if (report.failures.length === 0) {
    console.log("\nperf: ok — every measured budget is within SPEC §21.2 or a recorded breach");
    return 0;
  }
  console.log(`\nperf: ${report.failures.length} metric(s) need a decision:`);
  for (const failure of report.failures) {
    console.log(
      `  ${failure.id} [${failure.device}] ${failure.formatted}: ${failure.verdict.detail}`,
    );
  }
  if (!recording) {
    console.log("\n  Re-run with --record to see the breaches.json entries these would need.");
  }
  if (reportOnly) {
    console.log("\nperf: --report-only, so this is a report and not a gate. Exit 0.");
    return 0;
  }
  return 1;
}

/** The JSON a person would paste into `breaches.json`, with the reason left for them. */
function suggest(failures: readonly { id: string; device: DeviceClass; measured: number }[]): string {
  const grouped: Record<string, Record<string, number>> = {};
  for (const failure of failures) {
    const entry = (grouped[failure.id] ??= {});
    entry[failure.device] = Math.ceil(failure.measured);
  }
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(grouped).map(([id, recorded]) => [
        id,
        { recorded, reason: "TODO: why this is being carried rather than fixed" },
      ]),
    ),
    null,
    2,
  );
}

process.exitCode = await main();
