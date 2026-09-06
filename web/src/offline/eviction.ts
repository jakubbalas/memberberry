/**
 * The resident-body cap (`SPEC.md` §7.2).
 *
 * "A resident-body LRU cap (default 500 notes / 50MB, configurable) bounds phone memory;
 * eviction never touches pinned notes or notes with unsynced changes."
 *
 * Pure, and separate from the replica for the usual reason: what gets deleted from a user's
 * device is a decision, and the code that does the deleting is a boundary. The two
 * exemptions are the whole of the risk here — evicting a note with unsent changes deletes
 * the only copy of somebody's writing, and evicting a pinned one breaks the promise the pin
 * made.
 */

import type { ResidentBody } from "./db.js";

export interface ResidentCaps {
  readonly notes: number;
  readonly bytes: number;
}

/**
 * §7.2's defaults.
 *
 * Not configurable yet: §7.2 says they should be, and there is nowhere for a client-side
 * preference to live — the workspace layout is per device and the vault config is
 * server-side. Recorded rather than pretended: `HANDOFF.md` carries it.
 */
export const DEFAULT_CAPS: ResidentCaps = { notes: 500, bytes: 50 * 1024 * 1024 };

/**
 * Which resident bodies to drop to bring a vault back under its caps.
 *
 * Least recently opened first, skipping every pinned note and every note with unsent
 * changes. Those two still *count* towards the caps — they occupy the space they occupy —
 * so a device whose exempt notes alone exceed the cap evicts everything else and stays over
 * it. That is the honest outcome: the alternative is deleting something the user asked to
 * keep, or something only this device has.
 */
export function evictable(
  residents: readonly ResidentBody[],
  pinned: ReadonlySet<string>,
  caps: ResidentCaps = DEFAULT_CAPS,
): readonly ResidentBody[] {
  let notes = residents.length;
  let bytes = residents.reduce((total, body) => total + body.bytes, 0);
  if (notes <= caps.notes && bytes <= caps.bytes) return [];

  const candidates = residents
    .filter((body) => !pinned.has(body.note) && !body.dirty)
    // Oldest first. A tie is broken by path so the answer is the same on every run, which is
    // what makes this testable and what stops two tabs disagreeing about who goes.
    .sort((a, b) => a.openedAt - b.openedAt || (a.note < b.note ? -1 : a.note > b.note ? 1 : 0));

  const evicting: ResidentBody[] = [];
  for (const body of candidates) {
    if (notes <= caps.notes && bytes <= caps.bytes) break;
    evicting.push(body);
    notes -= 1;
    bytes -= body.bytes;
  }
  return evicting;
}
