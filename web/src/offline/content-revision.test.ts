import { IDBFactory } from "fake-indexeddb";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { openOfflineStore } from "./db.js";
import { syncClientIndex } from "./search-index.js";

const zoneId = "a".repeat(64);
const aclHash = "b".repeat(64);

it("refuses a late old-content response after the manifest advances under the same ACL", async () => {
  const store = await openOfflineStore(new IDBFactory());
  try {
    const old = { vault: "v", zoneId, aclHash, contentHash: "c".repeat(64) };
    await store.reconcileSearchZones("v", [old]);
    await store.reconcileSearchZones("v", [{ ...old, contentHash: "d".repeat(64) }]);
    expect(await store.putSearchSegment({ ...old, bytes: new Uint8Array([1]) })).toBe(false);
    expect(await store.searchSegments("v")).toEqual([]);
  } finally { store.close(); }
});

it("reuses unchanged validated content after checking its current permission manifest", async () => {
  const store = await openOfflineStore(new IDBFactory());
  try {
    const bytes = new Uint8Array([1]);
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const fetch = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/segments")
      ? new Response(JSON.stringify({ segments: [{ zoneId, aclHash, contentHash }] }))
      : new Response(bytes));
    const options = { vault: "v", store, fetch, validate: async () => undefined };
    await syncClientIndex(options);
    fetch.mockClear();
    await syncClientIndex(options);
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally { store.close(); }
});

it("refreshes a legacy segment whose server cannot provide a content revision", async () => {
  const store = await openOfflineStore(new IDBFactory());
  try {
    let bytes = new Uint8Array([1]);
    const fetch: typeof globalThis.fetch = async input => String(input).endsWith("/segments")
      ? new Response(JSON.stringify({ segments: [{ zoneId, aclHash }] }))
      : new Response(bytes);
    const options = { vault: "v", store, fetch, validate: async () => undefined };
    await syncClientIndex(options);
    bytes = new Uint8Array([2]);
    await syncClientIndex(options);
    expect((await store.searchSegments("v")).map(segment => [...segment.bytes])).toEqual([[2]]);
  } finally { store.close(); }
});
