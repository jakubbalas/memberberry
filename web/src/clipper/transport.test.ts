import { describe, expect, it, vi } from "vitest";
import { ClipRejectedError, createClipTransport, type ClipStorage } from "./transport.js";

function storage(): ClipStorage {
  return new MapStorage();
}

class MapStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

class OnlineTarget extends EventTarget {
  reconnect(): void { this.dispatchEvent(new Event("online")); }
}

describe("createClipTransport", () => {
  it("posts the clip with a scoped bearer token", async () => {
    let seen: RequestInit | undefined;
    const transport = createClipTransport({
      vault: "personal notes",
      token: "secret",
      storage: storage(),
      fetch: async (_input, init) => {
        seen = init;
        return new Response(JSON.stringify({ path: "Clips/a.md", source: "https://example.test/a" }), { status: 200 });
      },
    });
    const result = await transport.clip({ url: "https://example.test/a", html: "<p>A</p>" });
    expect(result.state).toBe("sent");
    expect(seen?.headers).toEqual(expect.objectContaining({ authorization: "Bearer secret" }));
    expect(seen?.body).toBe(JSON.stringify({ url: "https://example.test/a", html: "<p>A</p>" }));
  });

  it("queues network failures and flushes them later", async () => {
    let online = false;
    const store = storage();
    const transport = createClipTransport({
      vault: "v",
      storage: store,
      id: () => "clip-1",
      fetch: async () => {
        if (!online) throw new TypeError("offline");
        return new Response(JSON.stringify({ path: "Clips/a.md", source: "https://example.test/a" }), { status: 200 });
      },
    });
    expect(await transport.clip({ url: "https://example.test/a", html: "<p>A</p>" })).toEqual({ state: "queued", id: "clip-1" });
    expect(transport.pending()).toHaveLength(1);
    online = true;
    await transport.flush();
    expect(transport.pending()).toHaveLength(0);
  });

  it("does not queue server refusals", async () => {
    const transport = createClipTransport({
      vault: "v",
      storage: storage(),
      fetch: async () => new Response("{}", { status: 400 }),
    });
    await expect(transport.clip({ url: "https://example.test/a", html: "" })).rejects.toBeInstanceOf(ClipRejectedError);
    expect(transport.pending()).toHaveLength(0);
  });

  it("flushes its vault-specific queue when connectivity returns", async () => {
    let online = false;
    const target = new OnlineTarget();
    const store = storage();
    const first = createClipTransport({
      vault: "personal",
      baseUrl: "https://notes.example",
      storage: store,
      online: target,
      id: () => "queued",
      fetch: async () => {
        if (!online) throw new TypeError("offline");
        return new Response(JSON.stringify({ path: "Clips/a.md", source: "https://example.test" }), { status: 200 });
      },
    });
    await first.clip({ url: "https://example.test", html: "<p>A</p>" });
    expect(first.pending()).toHaveLength(1);
    online = true;
    target.reconnect();
    await vi.waitFor(() => expect(first.pending()).toHaveLength(0));
    first.destroy();

    const otherVault = createClipTransport({
      vault: "work",
      baseUrl: "https://notes.example",
      storage: store,
      online: target,
      fetch: async () => new Response("{}", { status: 500 }),
    });
    expect(otherVault.pending()).toHaveLength(0);
    otherVault.destroy();
  });
});
