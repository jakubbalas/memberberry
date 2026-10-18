import { IDBFactory } from "fake-indexeddb";
import { expect, it, vi } from "vitest";
import { openOfflineStore } from "./db.js";
import { createReplica } from "./replica.js";
import { prefetchPinned } from "./prefetch.js";

it("refreshes an already-downloaded pinned note without clearing its dirty flag", async () => {
  const store = await openOfflineStore(new IDBFactory());
  const replica = createReplica({ store, dropBody: async () => undefined });
  try {
    await replica.reconcile("personal", { kind: "ok", notes: [{ path: "One.md", title: "One", conflicts: 0 }] });
    await replica.setPinned("personal", "One.md", true);
    await replica.opened("personal", "One.md", true);
    const openNote = vi.fn(() => ({ synced: Promise.resolve(true), destroy: async () => undefined }));
    await prefetchPinned({ vault: "personal", replica, openNote, refreshResident: true });
    expect(openNote).toHaveBeenCalledWith("One.md");
    expect((await store.getResident("personal", "One.md"))?.dirty).toBe(true);
  } finally { store.close(); }
});

it("an in-flight pinned download cannot recreate residency after permission revocation", async () => {
  const store = await openOfflineStore(new IDBFactory());
  const replica = createReplica({ store, dropBody: async () => undefined });
  try {
    await replica.reconcile("personal", { kind: "ok", notes: [{ path: "Secret.md", title: "Secret", conflicts: 0 }] });
    await replica.setPinned("personal", "Secret.md", true);
    let arrived: (value: boolean) => void = () => { throw new Error("not opened"); };
    let started: () => void = () => { throw new Error("not initialized"); };
    const opening = new Promise<void>(resolve => { started = resolve; });
    const syncing = prefetchPinned({ vault: "personal", replica, refreshResident: true, openNote: () => {
      started();
      return { synced: new Promise(resolve => { arrived = resolve; }), destroy: async () => undefined };
    } });
    await opening;
    await replica.reconcile("personal", { kind: "denied" });
    arrived(true);
    await syncing;
    expect(await store.getResident("personal", "Secret.md")).toBeUndefined();
    expect(await replica.pinned("personal")).toEqual([]);
  } finally { store.close(); }
});
