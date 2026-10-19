import { IDBFactory } from "fake-indexeddb";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { openOfflineStore, type OfflineStore } from "./db.js";
import { fetchSearchManifest, syncClientIndex } from "./search-index.js";

let store: OfflineStore;
const zone = "a".repeat(64);
const epoch = "b".repeat(64);

beforeEach(async () => {
  store = await openOfflineStore(new IDBFactory());
});

function reply(body: BodyInit | null, status = 200): Response {
  return new Response(body, { status });
}

describe("client index reconciliation", () => {
  it("drops revoked bytes before it asks for a newly permitted segment", async () => {
    await store.reconcileSearchZones("v", [{ vault: "v", zoneId: zone, aclHash: epoch }]);
    await store.putSearchSegment({ vault: "v", zoneId: zone, aclHash: epoch, bytes: new Uint8Array([1]) });
    const calls: string[] = [];

    await expect(
      syncClientIndex({
        vault: "v",
        store,
        validate: async () => undefined,
        fetch: async (input) => {
          calls.push(String(input));
          if (calls.length === 1) {
            return reply(JSON.stringify({ segments: [{ zoneId: "c".repeat(64), aclHash: epoch }] }));
          }
          expect(await store.searchSegments("v")).toEqual([]);
          return reply(new Uint8Array([9]));
        },
      }),
    ).resolves.toBe("synced");
    expect(calls).toHaveLength(2);
  });

  it("stores only validated bytes from the current manifest", async () => {
    const routes: string[] = [];
    await expect(
      syncClientIndex({
        vault: "v",
        store,
        validate: async (bytes) => expect(bytes).toEqual(new Uint8Array([7, 8])),
        fetch: async (input) => {
          routes.push(String(input));
          return routes.length === 1
            ? reply(JSON.stringify({ segments: [{ zoneId: zone, aclHash: epoch }] }))
            : reply(new Uint8Array([7, 8]));
        },
      }),
    ).resolves.toBe("synced");
    expect(await store.searchSegments("v")).toEqual([
      { vault: "v", zoneId: zone, aclHash: epoch, bytes: new Uint8Array([7, 8]) },
    ]);
  });

  it("drops every segment if a manifest race refuses a binary request", async () => {
    await store.reconcileSearchZones("v", [{ vault: "v", zoneId: zone, aclHash: epoch }]);
    await store.putSearchSegment({ vault: "v", zoneId: zone, aclHash: epoch, bytes: new Uint8Array([1]) });
    let call = 0;
    await expect(
      syncClientIndex({
        vault: "v",
        store,
        validate: async () => undefined,
        fetch: async () => {
          call += 1;
          return call === 1
            ? reply(JSON.stringify({ segments: [{ zoneId: "c".repeat(64), aclHash: epoch }] }))
            : reply(null, 404);
        },
      }),
    ).resolves.toBe("denied");
    expect(await store.searchSegments("v")).toEqual([]);
  });

  it("keeps its existing bytes when the manifest is unreachable", async () => {
    await store.reconcileSearchZones("v", [{ vault: "v", zoneId: zone, aclHash: epoch }]);
    await store.putSearchSegment({ vault: "v", zoneId: zone, aclHash: epoch, bytes: new Uint8Array([1]) });
    await expect(
      syncClientIndex({ vault: "v", store, fetch: async () => Promise.reject(new Error("offline")) }),
    ).resolves.toBe("unreachable");
    expect(await store.searchSegments("v")).toHaveLength(1);
  });
});

describe("manifest validation", () => {
  it("treats malformed entries as unreachable rather than revoking stored bytes", async () => {
    const answer = await fetchSearchManifest("v", async () =>
      reply(JSON.stringify({ segments: [{ zoneId: "bad", aclHash: epoch }] })),
    );
    expect(answer).toEqual({ kind: "unreachable" });
  });
});

describe("content revisions", () => {
  const contentHash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
  const syncBytes = (bytes: Uint8Array, binary: Uint8Array | "offline" = bytes) => {
    let calls = 0;
    return syncClientIndex({ vault: "v", store, validate: async () => undefined, fetch: async () => {
      if (++calls === 1) return reply(JSON.stringify({ segments: [{ zoneId: zone, aclHash: epoch, contentHash: contentHash(bytes) }] }));
      if (binary === "offline") throw new TypeError("network disappeared");
      return reply(new Uint8Array(binary));
    } });
  };
  it("refreshes edited note content while the zone and permission epoch stay unchanged", async () => {
    await syncBytes(new Uint8Array([1]));
    await syncBytes(new Uint8Array([2]));
    expect((await store.searchSegments("v")).map(segment => [...segment.bytes])).toEqual([[2]]);
  });
  it("removes obsolete segment content before an unreachable replacement", async () => {
    await syncBytes(new Uint8Array([1]));
    const result = await syncBytes(new Uint8Array([2]), "offline");
    expect([result, (await store.searchSegments("v")).length]).toEqual(["unreachable", 0]);
  });
  it("refuses binary content that does not match the manifest digest", async () => {
    const result = await syncBytes(new Uint8Array([1]), new Uint8Array([2]));
    expect([result, (await store.searchSegments("v")).length]).toEqual(["unreachable", 0]);
  });
});
