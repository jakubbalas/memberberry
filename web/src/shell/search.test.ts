import { describe, expect, it } from "vitest";

import type { CompactSearchResults } from "../notes.js";
import type { OfflineStore, SearchSegment } from "../offline/db.js";
import { fetchOnlineSearch, SearchView } from "./search.svelte.js";

const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const store = {} as OfflineStore;
const segment: SearchSegment = {
  vault: "personal",
  zoneId: "a".repeat(64),
  aclHash: "b".repeat(64),
  bytes: new Uint8Array([1]),
};

describe("online search", () => {
  it("accepts only a complete server result payload", async () => {
    const hits = await fetchOnlineSearch("personal", "road", async (url) => {
      expect(String(url)).toContain("q=road");
      return response({ hits: [{ path: "Road.md", title: "Road", context: "A road map" }] });
    });
    expect(hits).toEqual([{ path: "Road.md", title: "Road", context: "A road map" }]);
  });

  it("does not turn a malformed response into an empty answer and identifies revocation", async () => {
    await expect(fetchOnlineSearch("personal", "road", async () => response({ hits: [{}] }))).resolves.toBeUndefined();
    await expect(fetchOnlineSearch("personal", "road", async () => response({}, 403))).resolves.toBe("denied");
  });
});

describe("search mode selection", () => {
  it("uses exact online results when the server answers", async () => {
    const view = new SearchView({
      vault: "personal",
      request: async () => response({ hits: [{ path: "Road.md", title: "Road", context: "exact" }] }),
      openStore: async () => store,
      stored: async () => [segment],
      queryOffline: async () => offline("offline"),
    });
    await view.search("road");
    expect(view.answer).toEqual({
      mode: "online",
      hits: [{ path: "Road.md", title: "Road", context: "exact" }],
      phraseDegraded: false,
    });
  });

  it("falls back only to the persisted permitted segments", async () => {
    let received: readonly Uint8Array[] = [];
    const view = new SearchView({
      vault: "personal",
      request: async () => { throw new Error("offline"); },
      openStore: async () => store,
      stored: async (actual, vault) => {
        expect(actual).toBe(store);
        expect(vault).toBe("personal");
        return [segment];
      },
      queryOffline: async (_query, bytes) => {
        received = bytes;
        return offline("prefix");
      },
    });
    await view.search('"road map"');
    expect(received).toEqual([segment.bytes]);
    expect(view.answer?.mode).toBe("offline");
    expect(view.answer?.phraseDegraded).toBe(true);
  });

  it("drops retained segments instead of falling back after a denial", async () => {
    let cleared = false;
    const view = new SearchView({
      vault: "personal",
      request: async () => response({}, 403),
      openStore: async () => ({
        reconcileSearchZones: async (_vault: string, zones: readonly never[]) => {
          cleared = zones.length === 0;
          return [];
        },
      }) as unknown as OfflineStore,
      stored: async () => [segment],
      queryOffline: async () => {
        throw new Error("a denied request must not query cached bytes");
      },
    });
    await view.search("private");
    expect(cleared).toBe(true);
    expect(view.answer).toBeUndefined();
    expect(view.unavailable).toBe(true);
  });

  it("keeps a slower prior query from replacing the newer one", async () => {
    let completeFirst: ((value: Response) => void) | undefined;
    const view = new SearchView({
      vault: "personal",
      request: (url) => {
        if (String(url).includes("q=first")) return new Promise<Response>((resolve) => (completeFirst = resolve));
        return Promise.resolve(response({ hits: [{ path: "Second.md", title: "Second", context: "new" }] }));
      },
    });
    const first = view.search("first");
    const second = view.search("second");
    await second;
    completeFirst?.(response({ hits: [{ path: "First.md", title: "First", context: "old" }] }));
    await first;
    expect(view.answer?.hits).toEqual([{ path: "Second.md", title: "Second", context: "new" }]);
  });
});

function offline(context: string): CompactSearchResults {
  return {
    hits: [{ path: "Road.md", title: "Road", snippet: context, tags: [], icon: null }],
    phraseDegraded: true,
  };
}
