/**
 * The enumerated budget breaches — the ratchet's memory.
 *
 * `perf/breaches.json` is the only place a breach of `SPEC.md` §21.2 is permitted to live,
 * and every entry must carry the value it was recorded at and the reason it is being carried.
 * `verdict.ts` turns those into the pass/fail decision.
 *
 * **The parser fails closed.** A typo, a missing `reason`, an unknown device name — any of
 * them throws rather than being skipped. The failure mode of a forgiving parser here is a
 * gate that silently stops gating, which is precisely the class of mistake AGENTS.md §3.1
 * refuses for permissions and which is no more acceptable for a budget.
 */

import { readFileSync } from "node:fs";

import { DEVICE_CLASSES, type DeviceClass } from "./budgets.ts";

export interface Breach {
  /** What the metric measured when the breach was recorded, per device class. */
  readonly recorded: Readonly<Partial<Record<DeviceClass, number>>>;
  /** Why it is being carried rather than fixed. Required — see AGENTS.md §7 on TODOs. */
  readonly reason: string;
}

export type Breaches = Readonly<Record<string, Breach>>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates the parsed contents of `breaches.json`.
 *
 * @throws if anything is not exactly the expected shape.
 */
export function parseBreaches(raw: unknown): Breaches {
  if (!isObject(raw)) {
    throw new Error("breaches.json must be a JSON object keyed by metric id");
  }
  const out: Record<string, Breach> = {};
  for (const [id, entry] of Object.entries(raw)) {
    if (!isObject(entry)) {
      throw new Error(`breaches.json: ${id} must be an object`);
    }
    const reason = entry["reason"];
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new Error(
        `breaches.json: ${id} needs a non-empty "reason". A breach without one is a ` +
          "budget quietly abandoned.",
      );
    }
    const recorded = entry["recorded"];
    if (!isObject(recorded)) {
      throw new Error(`breaches.json: ${id} needs a "recorded" object of device → value`);
    }
    const values: Partial<Record<DeviceClass, number>> = {};
    for (const [device, value] of Object.entries(recorded)) {
      if (!DEVICE_CLASSES.includes(device as DeviceClass)) {
        throw new Error(
          `breaches.json: ${id} records an unknown device class ${JSON.stringify(device)}; ` +
            `expected one of ${DEVICE_CLASSES.join(", ")}`,
        );
      }
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new Error(`breaches.json: ${id}.recorded.${device} must be a positive number`);
      }
      values[device as DeviceClass] = value;
    }
    if (Object.keys(values).length === 0) {
      throw new Error(`breaches.json: ${id} records no values, so it gates nothing`);
    }
    out[id] = { recorded: values, reason };
  }
  return out;
}

/** The recorded value for one metric on one device, if a breach covers it. */
export function recordedFor(
  breaches: Breaches,
  id: string,
  device: DeviceClass,
): number | undefined {
  return breaches[id]?.recorded[device];
}

/** Reads and validates `breaches.json`. */
export function loadBreaches(path: string): Breaches {
  return parseBreaches(JSON.parse(readFileSync(path, "utf8")) as unknown);
}
