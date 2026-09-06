/**
 * The resident-body cap (`SPEC.md` §7.2).
 *
 * The two exemptions are the point of every test here. Evicting a note with unsent changes
 * deletes the only copy of somebody's writing; evicting a pinned one breaks the promise the
 * pin made. Everything else about this is an approximation and says so.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import type { ResidentBody } from "./db.js";
import { DEFAULT_CAPS, evictable } from "./eviction.js";

function body(note: string, openedAt: number, extra: Partial<ResidentBody> = {}): ResidentBody {
  return { vault: "personal", note, openedAt, bytes: 0, dirty: false, ...extra };
}

const NOTHING_PINNED: ReadonlySet<string> = new Set();

describe("choosing what to evict", () => {
  it("evicts nothing while under both caps", () => {
    const residents = [body("a.md", 1), body("b.md", 2)];
    expect(evictable(residents, NOTHING_PINNED, { notes: 10, bytes: 1_000 })).toEqual([]);
  });

  it("evicts the least recently opened first", () => {
    const residents = [body("new.md", 30), body("old.md", 10), body("mid.md", 20)];
    const evicted = evictable(residents, NOTHING_PINNED, { notes: 1, bytes: 1_000 });
    expect(evicted.map((entry) => entry.note)).toEqual(["old.md", "mid.md"]);
  });

  it("stops as soon as it is back under the cap", () => {
    const residents = [body("a.md", 1), body("b.md", 2), body("c.md", 3)];
    expect(evictable(residents, NOTHING_PINNED, { notes: 2, bytes: 1_000 })).toHaveLength(1);
  });

  it("counts bytes as well as notes", () => {
    const residents = [body("big.md", 1, { bytes: 900 }), body("small.md", 2, { bytes: 10 })];
    const evicted = evictable(residents, NOTHING_PINNED, { notes: 100, bytes: 500 });
    expect(evicted.map((entry) => entry.note)).toEqual(["big.md"]);
  });

  it("never evicts a pinned note", () => {
    // The promise a pin makes: this one is here on the train.
    const residents = [body("pinned.md", 1), body("other.md", 2)];
    const evicted = evictable(residents, new Set(["pinned.md"]), { notes: 1, bytes: 1_000 });
    expect(evicted.map((entry) => entry.note)).toEqual(["other.md"]);
  });

  it("never evicts a note with unsent changes", () => {
    // This is the one that would lose data: the server has not seen those changes, so this
    // device holds the only copy.
    const residents = [body("dirty.md", 1, { dirty: true }), body("clean.md", 2)];
    const evicted = evictable(residents, NOTHING_PINNED, { notes: 1, bytes: 1_000 });
    expect(evicted.map((entry) => entry.note)).toEqual(["clean.md"]);
  });

  it("stays over the cap rather than evicting something exempt", () => {
    // The honest outcome. The alternative is deleting something the user asked to keep, or
    // something only this device has.
    const residents = [body("pinned.md", 1), body("dirty.md", 2, { dirty: true })];
    expect(evictable(residents, new Set(["pinned.md"]), { notes: 1, bytes: 10 })).toEqual([]);
  });

  it("breaks a tie the same way on every run", () => {
    // Two tabs computing this must agree, and a test that depends on sort stability is a
    // test that passes until the engine changes.
    const residents = [body("b.md", 5), body("a.md", 5), body("c.md", 5)];
    expect(evictable(residents, NOTHING_PINNED, { notes: 1, bytes: 1_000 }).map((e) => e.note))
      .toEqual(["a.md", "b.md"]);
  });

  it("defaults to §7.2's 500 notes and 50 MB", () => {
    expect(DEFAULT_CAPS).toEqual({ notes: 500, bytes: 50 * 1024 * 1024 });
    const residents = Array.from({ length: 501 }, (_, index) => body(`${index}.md`, index));
    expect(evictable(residents, NOTHING_PINNED)).toHaveLength(1);
  });

  it("never proposes evicting something exempt, whatever the shape of the vault", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            note: fc.string({ minLength: 1 }),
            openedAt: fc.integer({ min: 0, max: 1_000 }),
            bytes: fc.integer({ min: 0, max: 10_000 }),
            dirty: fc.boolean(),
            pinned: fc.boolean(),
          }),
          { size: "large" },
        ),
        fc.integer({ min: 0, max: 20 }),
        (entries, cap) => {
          const unique = [...new Map(entries.map((entry) => [entry.note, entry])).values()];
          const residents = unique.map((entry) =>
            body(entry.note, entry.openedAt, { bytes: entry.bytes, dirty: entry.dirty }),
          );
          const pinned = new Set(unique.filter((entry) => entry.pinned).map((entry) => entry.note));
          for (const evicted of evictable(residents, pinned, { notes: cap, bytes: cap * 100 })) {
            expect(pinned.has(evicted.note)).toBe(false);
            expect(evicted.dirty).toBe(false);
          }
        },
      ),
    );
  });
});
