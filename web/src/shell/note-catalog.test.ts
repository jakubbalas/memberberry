/**
 * The vault's note list, and where it comes from when there is no server (`SPEC.md` §7.2).
 *
 * The catalog is what the tree, the switcher and the breadcrumbs read, so what it holds
 * after a refresh decides what the whole shell can show offline — and, on a refusal, what it
 * must stop showing.
 */

import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";

import { persistenceName } from "../editor/collaboration.js";
import { openOfflineStore } from "../offline/db.js";
import { createReplica, dropBodyWith, type CatalogAnswer } from "../offline/replica.js";
import { stubReplica } from "../offline/testing.js";
import { NoteCatalog } from "./note-catalog.svelte.js";

const NOTES = [{ path: "One.md", title: "One", conflicts: 0 }];

/** A replica that records what it was asked to reconcile and answers with `stored`. */
function replicaHolding(
  stored: readonly { path: string; title: string | null; conflicts: number }[],
) {
  const seen: CatalogAnswer[] = [];
  return {
    seen,
    handle: async () =>
      stubReplica({
        reconcile: async (_vault: string, answer: CatalogAnswer) => {
          seen.push(answer);
          return answer.kind === "ok" ? answer.notes : answer.kind === "denied" ? [] : stored;
        },
      }),
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("uninitialized deferred"); };
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** A populated replica whose resident body has its own IndexedDB database. */
async function populatedReplica() {
  const factory = new IDBFactory();
  const store = await openOfflineStore(factory);
  const bodyName = persistenceName("personal", "One.md");
  await new Promise<void>((resolve, reject) => {
    const open = factory.open(bodyName, 1);
    open.onupgradeneeded = (): void => {
      open.result.createObjectStore("updates").put("Private cached body", 1);
    };
    open.onsuccess = (): void => { open.result.close(); resolve(); };
    open.onerror = (): void => reject(open.error);
  });
  const replica = createReplica({ store, dropBody: dropBodyWith(factory) });
  await replica.reconcile("personal", { kind: "ok", notes: NOTES });
  await replica.opened("personal", "One.md", true);
  await replica.measured("personal", "One.md", { base: "Private cached body" });
  await replica.setPinned("personal", "One.md", true);
  return { factory, store, replica, bodyName };
}

async function expectPurged(fixture: Awaited<ReturnType<typeof populatedReplica>>): Promise<void> {
  expect(await fixture.store.getNotes("personal")).toBeUndefined();
  expect(await fixture.replica.metadata("personal", "One.md")).toBeUndefined();
  expect(await fixture.replica.pinned("personal")).toEqual([]);
  expect(await fixture.replica.isResident("personal", "One.md")).toBe(false);
  expect(await fixture.replica.base("personal", "One.md")).toBeUndefined();
  expect((await fixture.factory.databases()).map((database) => database.name))
    .not.toContain(fixture.bodyName);
}

describe("catalog refresh ordering", () => {
  it.each(["network failure first", "denial first"])(
    "purges a real replica when an older request is denied and a newer one fails: %s",
    async (order) => {
      const fixture = await populatedReplica();
      const denied = deferred<CatalogAnswer>();
      const unreachable = deferred<CatalogAnswer>();
      const load = vi.fn<typeof import("./catalog.js").fetchNotes>()
        .mockResolvedValueOnce({ kind: "ok", notes: NOTES })
        .mockReturnValueOnce(denied.promise)
        .mockReturnValueOnce(unreachable.promise)
        .mockResolvedValue({ kind: "unreachable" });
      const catalog = new NoteCatalog({ vault: "personal", load, replica: async () => fixture.replica });
      try {
        await catalog.refresh();
        const earlier = catalog.refresh();
        const later = catalog.refresh();
        if (order === "network failure first") {
          unreachable.resolve({ kind: "unreachable" });
          await later;
          expect(catalog.notes).toEqual(NOTES);
          expect(await fixture.replica.pinned("personal")).toEqual(["One.md"]);
          expect(await fixture.replica.isResident("personal", "One.md")).toBe(true);
          expect((await fixture.factory.databases()).map((database) => database.name))
            .toContain(fixture.bodyName);
        }
        denied.resolve({ kind: "denied" });
        await earlier;
        unreachable.resolve({ kind: "unreachable" });
        await later;
        expect(catalog.notes).toEqual([]);
        expect(catalog.ready).toBe(true);
        await expectPurged(fixture);
        await catalog.refresh();
        expect(catalog.notes).toEqual([]);
        await expectPurged(fixture);
      } finally {
        fixture.store.close();
      }
    },
  );

  it.each(["older", "newer"])(
    "rejects %s pending successes after denial but lets a fresh request restore metadata",
    async (successOrder) => {
      const fixture = await populatedReplica();
      const success = deferred<CatalogAnswer>();
      const denied = deferred<CatalogAnswer>();
      const load = vi.fn<typeof import("./catalog.js").fetchNotes>()
        .mockResolvedValueOnce({ kind: "ok", notes: NOTES })
        .mockReturnValueOnce(successOrder === "older" ? success.promise : denied.promise)
        .mockReturnValueOnce(successOrder === "older" ? denied.promise : success.promise)
        .mockResolvedValue({ kind: "ok", notes: NOTES });
      const catalog = new NoteCatalog({ vault: "personal", load, replica: async () => fixture.replica });
      try {
        await catalog.refresh();
        const earlier = catalog.refresh();
        const later = catalog.refresh();
        denied.resolve({ kind: "denied" });
        await (successOrder === "older" ? later : earlier);
        expect(catalog.notes).toEqual([]);
        await expectPurged(fixture);
        success.resolve({ kind: "ok", notes: NOTES });
        await Promise.all([earlier, later]);
        expect(catalog.notes).toEqual([]);
        expect(catalog.ready).toBe(true);
        await expectPurged(fixture);
        await catalog.refresh();
        expect(catalog.notes).toEqual(NOTES);
        expect(await fixture.store.getNotes("personal")).toEqual(NOTES);
        expect(await fixture.replica.pinned("personal")).toEqual([]);
        expect(await fixture.replica.isResident("personal", "One.md")).toBe(false);
      } finally {
        fixture.store.close();
      }
    },
  );

  it.each(["ok", "unreachable"] as const)(
    "does not publish a newer %s answer already awaiting storage when an older denial arrives",
    async (kind) => {
      const fixture = await populatedReplica();
      const denied = deferred<CatalogAnswer>();
      const acquiring = deferred<void>();
      const read = deferred<void>();
      const purge = deferred<void>();
      const handle = vi.fn<() => Promise<typeof fixture.replica>>()
        .mockResolvedValueOnce(fixture.replica)
        .mockImplementationOnce(async () => {
          acquiring.resolve();
          await read.promise;
          return fixture.replica;
        })
        .mockImplementationOnce(async () => { await purge.promise; return fixture.replica; });
      const load = vi.fn<typeof import("./catalog.js").fetchNotes>()
        .mockResolvedValueOnce({ kind: "ok", notes: NOTES })
        .mockReturnValueOnce(denied.promise)
        .mockResolvedValueOnce(kind === "ok"
          ? { kind, notes: [{ path: "Stale.md", title: "Stale", conflicts: 0 }] }
          : { kind });
      const catalog = new NoteCatalog({ vault: "personal", load, replica: handle });
      await catalog.refresh();
      const earlier = catalog.refresh();
      const later = catalog.refresh();
      try {
        await acquiring.promise;
        denied.resolve({ kind: "denied" });
        await Promise.resolve();
        expect(catalog.notes).toEqual([]);
        read.resolve();
        await later;
        // The denial's purge is still blocked: an already queued answer must neither
        // republish the stored names nor replace them with a stale successful listing.
        expect(catalog.notes).toEqual([]);
        expect(await fixture.store.getNotes("personal")).toEqual(NOTES);
        purge.resolve();
        await earlier;
        await expectPurged(fixture);
        expect(catalog.ready).toBe(true);
      } finally {
        denied.resolve({ kind: "denied" });
        read.resolve();
        purge.resolve();
        await Promise.all([earlier, later]);
        fixture.store.close();
      }
    },
  );

  it("never reconciles an older successful response after a newer denial", async () => {
    const old = deferred<CatalogAnswer>();
    const replica = replicaHolding(NOTES);
    const load = vi.fn<typeof import("./catalog.js").fetchNotes>()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ kind: "denied" });
    const catalog = new NoteCatalog({ vault: "personal", load, replica: replica.handle });
    const earlier = catalog.refresh();
    await catalog.refresh();
    old.resolve({ kind: "ok", notes: NOTES });
    await earlier;
    expect(catalog.notes).toEqual([]);
    expect(replica.seen).toEqual([{ kind: "denied" }]);
    expect(catalog.ready).toBe(true);
  });

  it("does not publish an older response while a later refresh is pending", async () => {
    const old = deferred<CatalogAnswer>();
    const latest = deferred<CatalogAnswer>();
    const load = vi.fn<typeof import("./catalog.js").fetchNotes>()
      .mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const catalog = new NoteCatalog({ vault: "personal", load, replica: async () => undefined });
    const earlier = catalog.refresh();
    const later = catalog.refresh();
    old.resolve({ kind: "ok", notes: NOTES });
    await earlier;
    expect(catalog.loading).toBe(true);
    expect(catalog.notes).toEqual([]);
    latest.resolve({ kind: "ok", notes: [{ path: "New.md", title: "New", conflicts: 0 }] });
    await later;
    expect(catalog.notes.map((note) => note.path)).toEqual(["New.md"]);
  });

  it("clears a denial immediately and orders replica writes before a following offline read", async () => {
    const saving = deferred<void>();
    const started = deferred<void>();
    let stored: readonly import("./catalog.js").NoteSummary[] = NOTES;
    let block = false;
    const replica = stubReplica({ reconcile: async (_vault, answer) => {
      if (answer.kind === "ok") {
        if (block) { started.resolve(); await saving.promise; }
        stored = [...answer.notes];
      } else if (answer.kind === "denied") stored = [];
      return stored;
    } });
    const load = vi.fn<typeof import("./catalog.js").fetchNotes>()
      .mockResolvedValue({ kind: "ok", notes: NOTES });
    const catalog = new NoteCatalog({ vault: "personal", load, replica: async () => replica });
    await catalog.refresh();
    block = true;
    const earlier = catalog.refresh();
    await started.promise;
    load.mockResolvedValueOnce({ kind: "denied" });
    const denial = catalog.refresh();
    await Promise.resolve();
    expect(catalog.notes).toEqual([]);
    load.mockResolvedValueOnce({ kind: "unreachable" });
    const offline = catalog.refresh();
    saving.resolve();
    await Promise.all([earlier, denial, offline]);
    expect(catalog.notes).toEqual([]);
    expect(stored).toEqual([]);
  });
});

describe("loading the catalog", () => {
  it("preserves a real offline replica on network failure but purges it on denial", async () => {
    const store = await openOfflineStore(new IDBFactory());
    const dropBody = vi.fn(async () => undefined);
    const replica = createReplica({ store, dropBody });
    let answer: CatalogAnswer = { kind: "ok", notes: NOTES };
    const catalog = new NoteCatalog({ vault: "personal", load: async () => answer, replica: async () => replica });
    await catalog.refresh();
    await replica.opened("personal", "One.md");
    await replica.setPinned("personal", "One.md", true);
    answer = { kind: "unreachable" };
    await catalog.refresh();
    expect(catalog.notes).toEqual(NOTES);
    expect(await store.getNotes("personal")).toEqual(NOTES);
    expect(dropBody).not.toHaveBeenCalled();
    answer = { kind: "denied" };
    await catalog.refresh();
    expect(catalog.notes).toEqual([]);
    expect(await store.getNotes("personal")).toBeUndefined();
    expect(await replica.pinned("personal")).toEqual([]);
    expect(await replica.isResident("personal", "One.md")).toBe(false);
    expect(dropBody).toHaveBeenCalledWith("personal", "One.md");
    answer = { kind: "unreachable" };
    await catalog.refresh();
    expect(catalog.notes).toEqual([]);
  });

  it("holds what the server listed", async () => {
    const catalog = new NoteCatalog({
      vault: "personal",
      load: async () => ({ kind: "ok", notes: NOTES }),
      replica: async () => undefined,
    });
    await catalog.refresh();
    expect(catalog.notes).toEqual(NOTES);
    expect(catalog.ready).toBe(true);
  });

  it("holds nothing the server refused, even with a replica", async () => {
    const replica = replicaHolding(NOTES);
    const catalog = new NoteCatalog({
      vault: "personal",
      load: async () => ({ kind: "denied" }),
      replica: replica.handle,
    });
    await catalog.refresh();
    expect(catalog.notes).toEqual([]);
  });

  it("falls back to the replica when there is no server", async () => {
    // This is the tree and the quick switcher working on a train.
    const replica = replicaHolding(NOTES);
    const catalog = new NoteCatalog({
      vault: "personal",
      load: async () => ({ kind: "unreachable" }),
      replica: replica.handle,
    });
    await catalog.refresh();
    expect(catalog.notes).toEqual(NOTES);
    expect(replica.seen).toEqual([{ kind: "unreachable" }]);
  });

  it("shows nothing offline on a device with nowhere to keep a replica", async () => {
    // A private window that refuses IndexedDB. The application still works; it just has no
    // offline copy, which is exactly the behaviour it had before §7.2.
    const catalog = new NoteCatalog({
      vault: "personal",
      load: async () => ({ kind: "unreachable" }),
      replica: async () => undefined,
    });
    await catalog.refresh();
    expect(catalog.notes).toEqual([]);
  });

  it("asks once however many callers want it", async () => {
    // Both the tree and the palette call `ensure`, and the tree calls it from an effect that
    // can re-run — so a second call must not be a second request for a 10 000-note index.
    let calls = 0;
    const catalog = new NoteCatalog({
      vault: "personal",
      load: async () => {
        calls += 1;
        return { kind: "ok", notes: NOTES } satisfies CatalogAnswer;
      },
      replica: async () => undefined,
    });

    catalog.ensure();
    catalog.ensure();
    await vi.waitFor(() => expect(catalog.ready).toBe(true));

    expect(calls).toBe(1);
    catalog.ensure();
    expect(calls).toBe(1);
  });
});
