/**
 * Reconciling the local replica with what the server says now (`SPEC.md` §7.4, §6.7).
 *
 * The most security-relevant module in `src/offline/`, and the one whose failure is quiet:
 * a client that keeps a replica of notes it may no longer read is §6.7's revocation limit
 * left permanent instead of closed on reconnect. Every case here is a case that has to hold
 * *before* anything else happens on a reconnection.
 */

import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";

import { openOfflineStore, type OfflineStore } from "./db.js";
import { createReplica, dropBodyWith, unreadable, type Replica } from "./replica.js";

let store: OfflineStore;
let dropped: string[];
let replica: Replica;

beforeEach(async () => {
  store = await openOfflineStore(new IDBFactory());
  dropped = [];
  replica = createReplica({
    store,
    dropBody: async (vault, note) => {
      dropped.push(`${vault}/${note}`);
    },
    now: () => 1_000,
  });
});

describe("a fresh readable set", () => {
  it("becomes the stored replica", async () => {
    const notes = [{ path: "One.md", title: "One" }];
    expect(await replica.reconcile("personal", { kind: "ok", notes })).toEqual(notes);
    expect(await store.getNotes("personal")).toEqual(notes);
  });

  it("drops the body of a note it no longer contains", async () => {
    // The reconnection §6.7 promises. The note left the readable set because an ACL
    // tightened, because it was deleted, or because it was renamed — this cannot tell them
    // apart, and dropping the local copy is right for all three.
    await store.putResident({ vault: "personal", note: "Secret.md", openedAt: 1, bytes: 0, dirty: false });
    await store.putResident({ vault: "personal", note: "One.md", openedAt: 2, bytes: 0, dirty: false });

    await replica.reconcile("personal", { kind: "ok", notes: [{ path: "One.md", title: "One" }] });

    expect(dropped).toEqual(["personal/Secret.md"]);
    expect((await store.residents("personal")).map((body) => body.note)).toEqual(["One.md"]);
  });

  it("keeps the bodies it still may read", async () => {
    await store.putResident({ vault: "personal", note: "One.md", openedAt: 1, bytes: 0, dirty: false });
    await replica.reconcile("personal", { kind: "ok", notes: [{ path: "One.md", title: "One" }] });
    expect(dropped).toEqual([]);
  });
});

describe("pins", () => {
  it("keeps and forgets a note", async () => {
    await replica.setPinned("personal", "One.md", true);
    expect(await replica.pinned("personal")).toEqual(["One.md"]);
    await replica.setPinned("personal", "One.md", false);
    expect(await replica.pinned("personal")).toEqual([]);
  });

  it("drops a pin for a note that left the readable set", async () => {
    // A pin is a standing instruction to fetch something. One naming a note this user may no
    // longer read would keep asking for it on every start.
    await replica.setPinned("personal", "Secret.md", true);
    await replica.setPinned("personal", "One.md", true);

    await replica.reconcile("personal", { kind: "ok", notes: [{ path: "One.md", title: "One" }] });

    expect(await replica.pinned("personal")).toEqual(["One.md"]);
  });

  it("drops every pin when the vault is refused", async () => {
    await replica.setPinned("personal", "One.md", true);
    await replica.reconcile("personal", { kind: "denied" });
    expect(await replica.pinned("personal")).toEqual([]);
  });

  it("keeps them all when the server simply did not answer", async () => {
    await replica.setPinned("personal", "One.md", true);
    await replica.reconcile("personal", { kind: "unreachable" });
    expect(await replica.pinned("personal")).toEqual(["One.md"]);
  });
});

describe("a refusal", () => {
  it("returns nothing, whatever is stored", async () => {
    // Not the stored copy. The stored copy is exactly what a revocation invalidates, and a
    // note this user may not read does not exist for them (§6.5).
    await store.putNotes("personal", [{ path: "One.md", title: "One" }]);
    expect(await replica.reconcile("personal", { kind: "denied" })).toEqual([]);
  });

  it("drops the whole vault: its metadata and every body", async () => {
    await store.putNotes("personal", [{ path: "One.md", title: "One" }]);
    await store.putResident({ vault: "personal", note: "One.md", openedAt: 1, bytes: 0, dirty: false });
    await store.putResident({ vault: "personal", note: "Two.md", openedAt: 2, bytes: 0, dirty: false });

    await replica.reconcile("personal", { kind: "denied" });

    expect(await store.getNotes("personal")).toBeUndefined();
    expect(await store.residents("personal")).toEqual([]);
    expect(dropped.sort()).toEqual(["personal/One.md", "personal/Two.md"]);
  });

  it("leaves another vault alone", async () => {
    await store.putNotes("work", [{ path: "Two.md", title: "Two" }]);
    await replica.reconcile("personal", { kind: "denied" });
    expect(await store.getNotes("work")).toEqual([{ path: "Two.md", title: "Two" }]);
  });
});

describe("no answer at all", () => {
  it("uses the stored copy, which is what makes the tree work offline", async () => {
    await store.putNotes("personal", [{ path: "One.md", title: "One" }]);
    expect(await replica.reconcile("personal", { kind: "unreachable" })).toEqual([
      { path: "One.md", title: "One" },
    ]);
  });

  it("keeps every body, because a tunnel is not a revocation", async () => {
    await store.putResident({ vault: "personal", note: "One.md", openedAt: 1, bytes: 0, dirty: false });
    await replica.reconcile("personal", { kind: "unreachable" });
    expect(dropped).toEqual([]);
    expect(await store.residents("personal")).toHaveLength(1);
  });

  it("is an empty list on a device that has never been online here", async () => {
    expect(await replica.reconcile("personal", { kind: "unreachable" })).toEqual([]);
  });
});

describe("resident bodies", () => {
  it("records a note as resident when it is opened", async () => {
    expect(await replica.isResident("personal", "One.md")).toBe(false);
    await replica.opened("personal", "One.md");
    expect(await replica.isResident("personal", "One.md")).toBe(true);
    expect((await store.residents("personal"))[0]?.openedAt).toBe(1_000);
  });

  it("knows what it has stored about a note, which is what the notice shows", async () => {
    await store.putNotes("personal", [{ path: "One.md", title: "One" }]);
    expect(await replica.metadata("personal", "One.md")).toEqual({ path: "One.md", title: "One" });
    expect(await replica.metadata("personal", "Absent.md")).toBeUndefined();
    expect(await replica.metadata("never-seen", "One.md")).toBeUndefined();
  });

  it("does not confuse two vaults with the same note path", async () => {
    await replica.opened("personal", "One.md");
    expect(await replica.isResident("work", "One.md")).toBe(false);
  });
});

describe("the resident-body cap (§7.2)", () => {
  /** A replica with a two-note cap, so a test can reach it without writing five hundred. */
  function capped() {
    return createReplica({
      store,
      dropBody: async (vault, note) => {
        dropped.push(`${vault}/${note}`);
      },
      now: () => 1_000,
      caps: { notes: 2, bytes: 1_000 },
    });
  }

  it("drops the least recently opened body and its document", async () => {
    for (const [note, openedAt] of [["old.md", 1], ["mid.md", 2], ["new.md", 3]] as const) {
      await store.putResident({ vault: "personal", note, openedAt, bytes: 0, dirty: false });
    }

    expect(await capped().evict("personal")).toEqual(["old.md"]);

    expect(dropped).toEqual(["personal/old.md"]);
    expect((await store.residents("personal")).map((body) => body.note).sort()).toEqual([
      "mid.md",
      "new.md",
    ]);
  });

  it("never drops a pinned note or one with unsent changes", async () => {
    await store.putResident({ vault: "personal", note: "pinned.md", openedAt: 1, bytes: 0, dirty: false });
    await store.putResident({ vault: "personal", note: "dirty.md", openedAt: 2, bytes: 0, dirty: true });
    await store.putResident({ vault: "personal", note: "spare.md", openedAt: 3, bytes: 0, dirty: false });
    await store.putPin({ vault: "personal", note: "pinned.md" });

    expect(await capped().evict("personal")).toEqual(["spare.md"]);
  });

  it("evicts nothing while under the cap", async () => {
    await store.putResident({ vault: "personal", note: "one.md", openedAt: 1, bytes: 0, dirty: false });
    expect(await capped().evict("personal")).toEqual([]);
    expect(dropped).toEqual([]);
  });
});

describe("measuring a note", () => {
  it("records what it weighs and whether it has unsent changes", async () => {
    await replica.opened("personal", "One.md");
    await replica.measured("personal", "One.md", { bytes: 4_096, dirty: true });

    const [record] = await store.residents("personal");
    expect(record?.bytes).toBe(4_096);
    expect(record?.dirty).toBe(true);
  });

  it("leaves alone what a patch does not name", async () => {
    await replica.opened("personal", "One.md");
    await replica.measured("personal", "One.md", { bytes: 4_096, dirty: true });
    await replica.measured("personal", "One.md", { dirty: false });

    const [record] = await store.residents("personal");
    expect(record?.bytes).toBe(4_096);
    expect(record?.dirty).toBe(false);
  });

  it("survives being opened again without forgetting either", async () => {
    // `putResident` replaces rather than merges, so opening a note used to reset what it
    // weighed — and, worse, that it had unsent changes, which is what stops it being evicted.
    await replica.opened("personal", "One.md");
    await replica.measured("personal", "One.md", { bytes: 4_096, dirty: true });
    await replica.opened("personal", "One.md");

    const [record] = await store.residents("personal");
    expect(record?.bytes).toBe(4_096);
    expect(record?.dirty).toBe(true);
  });

  it("does not invent a record for a note this device does not hold", async () => {
    // One would make `isResident` true, which hides §7.2's "body not downloaded" state
    // behind an editor with nothing in it.
    await replica.measured("personal", "Absent.md", { bytes: 10 });
    expect(await store.residents("personal")).toEqual([]);
  });
});

describe("unreadable", () => {
  it("is everything the readable set does not name", () => {
    const residents = [
      { vault: "v", note: "a.md", openedAt: 1, bytes: 0, dirty: false },
      { vault: "v", note: "b.md", openedAt: 2, bytes: 0, dirty: false },
    ];
    expect(unreadable(residents, new Set(["a.md"]))).toEqual([residents[1]]);
  });

  it("is everything when the readable set is empty", () => {
    const residents = [{ vault: "v", note: "a.md", openedAt: 1, bytes: 0, dirty: false }];
    expect(unreadable(residents, new Set())).toEqual(residents);
  });
});

describe("dropping a body", () => {
  it("deletes the document's own database", async () => {
    // The body lives in a `y-indexeddb` database of its own; this store only holds the
    // bookkeeping beside it, so forgetting the record without this would leave the note
    // readable offline after it was revoked.
    const factory = new IDBFactory();
    await new Promise<void>((resolve) => {
      const open = factory.open("memberberry:ydoc:personal:One.md", 1);
      open.onupgradeneeded = (): void => {
        open.result.createObjectStore("updates");
      };
      open.onsuccess = (): void => {
        open.result.close();
        resolve();
      };
    });

    await dropBodyWith(factory)("personal", "One.md");

    const names = await factory.databases();
    expect(names.map((entry) => entry.name)).not.toContain("memberberry:ydoc:personal:One.md");
  });

  it("resolves even when the database is not there", async () => {
    await expect(dropBodyWith(new IDBFactory())("personal", "Gone.md")).resolves.toBeUndefined();
  });
});
