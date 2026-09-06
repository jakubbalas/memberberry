/**
 * The local replica's storage (`SPEC.md` §7.2).
 *
 * Driven against `fake-indexeddb`, which is a real implementation of the IndexedDB API
 * rather than a mock of this module's use of it (`AGENTS.md` §2.3). That matters here more
 * than usual: the things most likely to be wrong are the composite key and the index, and a
 * hand-written stub would agree with whatever this file happened to do.
 */

import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";

import { openOfflineStore, type OfflineStore } from "./db.js";

let store: OfflineStore;

beforeEach(async () => {
  // A fresh factory per test: IndexedDB is durable by design, so a shared one would make
  // every test depend on the order the others ran in.
  store = await openOfflineStore(new IDBFactory());
});

describe("the metadata replica", () => {
  it("has nothing before anything was stored", async () => {
    // `undefined`, not an empty list: "this device has never held a copy" and "this vault
    // has no readable notes" are different answers, and only the first one means fall back.
    expect(await store.getNotes("personal")).toBeUndefined();
  });

  it("stores and returns a vault's notes", async () => {
    await store.putNotes("personal", [{ path: "One.md", title: "One" }]);
    expect(await store.getNotes("personal")).toEqual([{ path: "One.md", title: "One" }]);
  });

  it("replaces rather than merges, so a deleted note does not survive", async () => {
    await store.putNotes("personal", [
      { path: "One.md", title: "One" },
      { path: "Two.md", title: "Two" },
    ]);
    await store.putNotes("personal", [{ path: "One.md", title: "One" }]);
    expect(await store.getNotes("personal")).toEqual([{ path: "One.md", title: "One" }]);
  });

  it("keeps vaults apart", async () => {
    await store.putNotes("personal", [{ path: "One.md", title: "One" }]);
    await store.putNotes("work", [{ path: "Two.md", title: "Two" }]);
    expect(await store.getNotes("work")).toEqual([{ path: "Two.md", title: "Two" }]);
  });

  it("drops a record whose shape is not what this version writes", async () => {
    // Written by an older release, or edited in devtools. A `path` that is not a string
    // reaches a DOM attribute (AGENTS.md §4.3).
    await store.putNotes("personal", [
      { path: "One.md", title: "One" },
      { path: "", title: null },
      { path: "Bad.md", title: 7 } as unknown as { path: string; title: null },
    ]);
    expect(await store.getNotes("personal")).toEqual([{ path: "One.md", title: "One" }]);
  });
});

describe("resident bodies", () => {
  it("records which notes this device holds, and when", async () => {
    await store.putResident({ vault: "personal", note: "One.md", openedAt: 10, bytes: 0, dirty: false });
    expect(await store.residents("personal")).toEqual([
      { vault: "personal", note: "One.md", openedAt: 10, bytes: 0, dirty: false },
    ]);
  });

  it("updates a note it already holds rather than duplicating it", async () => {
    await store.putResident({ vault: "personal", note: "One.md", openedAt: 10, bytes: 0, dirty: false });
    await store.putResident({ vault: "personal", note: "One.md", openedAt: 20, bytes: 0, dirty: false });
    expect(await store.residents("personal")).toEqual([
      { vault: "personal", note: "One.md", openedAt: 20, bytes: 0, dirty: false },
    ]);
  });

  it("tells apart two notes whose joined key would collide", async () => {
    // The reason the key is a pair. A note path may contain any character, so `<vault>:<note>`
    // is one filename away from two notes sharing a record.
    await store.putResident({ vault: "a", note: "b:c.md", openedAt: 1, bytes: 0, dirty: false });
    await store.putResident({ vault: "a:b", note: "c.md", openedAt: 2, bytes: 0, dirty: false });
    expect(await store.residents("a")).toEqual([{ vault: "a", note: "b:c.md", openedAt: 1, bytes: 0, dirty: false }]);
    expect(await store.residents("a:b")).toEqual([{ vault: "a:b", note: "c.md", openedAt: 2, bytes: 0, dirty: false }]);
  });

  it("forgets one", async () => {
    await store.putResident({ vault: "personal", note: "One.md", openedAt: 1, bytes: 0, dirty: false });
    await store.putResident({ vault: "personal", note: "Two.md", openedAt: 2, bytes: 0, dirty: false });
    await store.deleteResident("personal", "One.md");
    expect((await store.residents("personal")).map((body) => body.note)).toEqual(["Two.md"]);
  });

  it("lists only the vault it was asked about", async () => {
    await store.putResident({ vault: "personal", note: "One.md", openedAt: 1, bytes: 0, dirty: false });
    await store.putResident({ vault: "work", note: "Two.md", openedAt: 2, bytes: 0, dirty: false });
    expect((await store.residents("personal")).map((body) => body.note)).toEqual(["One.md"]);
  });
});

describe("pins", () => {
  it("records a note to keep, and lists it", async () => {
    await store.putPin({ vault: "personal", note: "One.md" });
    expect(await store.pins("personal")).toEqual([{ vault: "personal", note: "One.md" }]);
  });

  it("is idempotent, so pinning twice is still one pin", async () => {
    await store.putPin({ vault: "personal", note: "One.md" });
    await store.putPin({ vault: "personal", note: "One.md" });
    expect(await store.pins("personal")).toHaveLength(1);
  });

  it("forgets one", async () => {
    await store.putPin({ vault: "personal", note: "One.md" });
    await store.deletePin("personal", "One.md");
    expect(await store.pins("personal")).toEqual([]);
  });

  it("keeps vaults apart", async () => {
    await store.putPin({ vault: "personal", note: "One.md" });
    await store.putPin({ vault: "work", note: "Two.md" });
    expect(await store.pins("work")).toEqual([{ vault: "work", note: "Two.md" }]);
  });

  it("is not the same thing as a resident body", async () => {
    // A pin is a standing instruction, and the note it names may never have been opened —
    // which is the whole point of §7.2's eager tier.
    await store.putPin({ vault: "personal", note: "One.md" });
    expect(await store.residents("personal")).toEqual([]);
  });
});

describe("forgetting a vault", () => {
  it("removes its metadata and every resident record, and nothing else", async () => {
    // What a revoked vault gets (§6.7). Another vault's replica is not this vault's business.
    await store.putNotes("personal", [{ path: "One.md", title: "One" }]);
    await store.putResident({ vault: "personal", note: "One.md", openedAt: 1, bytes: 0, dirty: false });
    await store.putPin({ vault: "personal", note: "One.md" });
    await store.putNotes("work", [{ path: "Two.md", title: "Two" }]);
    await store.putResident({ vault: "work", note: "Two.md", openedAt: 2, bytes: 0, dirty: false });
    await store.putPin({ vault: "work", note: "Two.md" });

    await store.deleteVault("personal");

    expect(await store.getNotes("personal")).toBeUndefined();
    expect(await store.residents("personal")).toEqual([]);
    expect(await store.pins("personal")).toEqual([]);
    expect(await store.getNotes("work")).toEqual([{ path: "Two.md", title: "Two" }]);
    expect(await store.residents("work")).toHaveLength(1);
    expect(await store.pins("work")).toHaveLength(1);
  });

  it("is not an error for a vault this device never held", async () => {
    await expect(store.deleteVault("never-seen")).resolves.toBeUndefined();
  });
});

describe("reopening", () => {
  it("finds what a previous session stored", async () => {
    // The whole point of the store: this is the second visit, after the tab was closed.
    const factory = new IDBFactory();
    const first = await openOfflineStore(factory);
    await first.putNotes("personal", [{ path: "One.md", title: "One" }]);
    first.close();

    const second = await openOfflineStore(factory);
    expect(await second.getNotes("personal")).toEqual([{ path: "One.md", title: "One" }]);
    second.close();
  });
});
