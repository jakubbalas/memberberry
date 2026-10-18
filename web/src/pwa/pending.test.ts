import { IDBFactory } from "fake-indexeddb";
import { expect, it } from "vitest";
import { openOfflineStore } from "../offline/db.js";
import { canReload, hasPendingConnections, trackPending } from "./pending.js";

it("blocks an update until restored live notes have reconciled and all writes are acknowledged", () => {
  let state = { pending: 0, synced: false };
  const stop = trackPending(() => state);
  try {
    expect(hasPendingConnections()).toBe(true);
    state = { pending: 1, synced: true };
    expect(hasPendingConnections()).toBe(true);
    state = { pending: 0, synced: true };
    expect(hasPendingConnections()).toBe(false);
  } finally { stop(); }
  expect(hasPendingConnections()).toBe(false);
});

it("also protects unsent edits in a note that has been closed", async () => {
  const store = await openOfflineStore(new IDBFactory());
  try {
    await store.putNotes("personal", [{ path: "Draft.md", title: "Draft", conflicts: 0 }]);
    await store.putResident({ vault: "personal", note: "Draft.md", openedAt: 1, bytes: 5, dirty: true });
    expect(await canReload(store, () => false)).toBe(false);
    await store.updateResident("personal", "Draft.md", body => body === undefined ? undefined : { ...body, dirty: false });
    expect(await canReload(store, () => false)).toBe(true);
  } finally { store.close(); }
});

it("rechecks live writes after asynchronous storage reads", async () => {
  const store = await openOfflineStore(new IDBFactory());
  let checks = 0;
  try { expect(await canReload(store, () => ++checks > 1)).toBe(false); }
  finally { store.close(); }
});

it("keeps the current page when local write safety cannot be checked", async () => {
  expect(await canReload(undefined)).toBe(false);
  const store = await openOfflineStore(new IDBFactory());
  store.close();
  expect(await canReload(store, () => false)).toBe(false);
});
