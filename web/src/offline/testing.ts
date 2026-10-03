/**
 * Test doubles for the offline replica.
 *
 * One place, rather than a hand-built object in each test file, for a reason the last three
 * changes demonstrated: every method added to `Replica` broke four unrelated tests that only
 * wanted "a replica that does nothing". `mb-index/src/testing.rs` exists for the same reason.
 *
 * Nothing in the application imports this — it is reachable only from tests, and the bundle
 * drops it.
 */

import type { Replica } from "./replica.js";

/** A replica that holds nothing and records nothing, with any part overridable. */
export function stubReplica(overrides: Partial<Replica> = {}): Replica {
  const replica: Replica = {
    session: (vault, note) => ({
      revoked: false,
      opened: (dirty) => replica.opened(vault, note, dirty),
      measured: (patch) => replica.measured(vault, note, patch),
      close: () => undefined,
    }),
    reconcile: async (_vault, answer) => (answer.kind === "ok" ? answer.notes : []),
    isResident: async () => false,
    metadata: async () => undefined,
    opened: async () => undefined,
    measured: async () => undefined,
    base: async () => undefined,
    evict: async () => [],
    pinned: async () => [],
    setPinned: async () => undefined,
    ...overrides,
  };
  return replica;
}
