/**
 * The workspace layout transport (`SPEC.md` §8.1, E15).
 *
 * Every dependency is injected — `fetch`, the timer, the storage — so nothing here touches a
 * network, a clock or a browser. The behaviours under test are the ones that only appear
 * under load: that a burst of layout changes produces one request, that two saves cannot land
 * out of order, and that a failed save is survivable rather than fatal.
 */

import { describe, expect, it } from "vitest";

import { type Workspace, counterIds, createWorkspace, openTab, tabs } from "./workspace.js";
import { serializeWorkspace } from "./workspace-storage.js";
import {
  DEVICE_ID_KEY,
  createWorkspaceTransport,
  deviceId,
  workspaceUrl,
} from "./workspace-sync.js";

/** A controllable stand-in for `setTimeout`, so a debounce is exercised without waiting. */
function clock() {
  let next = 1;
  const scheduled = new Map<number, () => void>();
  return {
    setTimer: (run: () => void): number => {
      const handle = next;
      next += 1;
      scheduled.set(handle, run);
      return handle;
    },
    clearTimer: (handle: number): void => {
      scheduled.delete(handle);
    },
    /** Fires everything currently scheduled. */
    tick: (): void => {
      const due = [...scheduled.values()];
      scheduled.clear();
      for (const run of due) run();
    },
    get pending(): number {
      return scheduled.size;
    },
  };
}

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly body: string | undefined;
}

/** A `fetch` that records calls and answers with whatever the test set up. */
function transportFetch(reply: (call: Recorded) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call: Recorded = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    return reply(call);
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

function populated(notes: readonly string[]): Workspace {
  const ids = counterIds();
  let workspace = createWorkspace("personal", ids);
  for (const note of notes) workspace = openTab(workspace, { note, reuse: false }, ids);
  return workspace;
}

const ids = (): ReturnType<typeof counterIds> => counterIds("fresh-");

describe("the endpoint", () => {
  it("is per vault and per device, with both encoded", () => {
    expect(workspaceUrl("personal", "laptop")).toBe(
      "/api/v1/vaults/personal/workspace/laptop",
    );
    // A slug and a device id are both constrained server-side, but encoding them here means
    // a bug in either cannot become a request to a different path.
    expect(workspaceUrl("my vault", "a/b")).toBe(
      "/api/v1/vaults/my%20vault/workspace/a%2Fb",
    );
  });
});

describe("loading", () => {
  it("returns the stored layout when the server has one", async () => {
    const stored = populated(["One.md", "Two.md"]);
    const { fetch, calls } = transportFetch(() => new Response(serializeWorkspace(stored)));
    const transport = createWorkspaceTransport({
      vault: "personal",
      device: "laptop",
      ids: ids(),
      fetch,
    });

    const loaded = await transport.load();
    expect(loaded.ok).toBe(true);
    expect(loaded.workspace).toEqual(stored);
    expect(calls[0]?.method).toBe("GET");
  });

  it("falls back to a fresh workspace when this device has never saved one", async () => {
    // 404 is the normal first visit and is also every denial (E15), which is the point: the
    // client cannot tell them apart and does not need to.
    const { fetch } = transportFetch(() => new Response("{}", { status: 404 }));
    const transport = createWorkspaceTransport({
      vault: "personal",
      device: "laptop",
      ids: ids(),
      fetch,
    });

    const loaded = await transport.load();
    expect(loaded.ok).toBe(false);
    expect(tabs(loaded.workspace.root)).toEqual([]);
    expect(loaded.workspace.vault).toBe("personal");
  });

  it("falls back rather than throwing when the network fails", async () => {
    const { fetch } = transportFetch(() => {
      throw new Error("offline");
    });
    const transport = createWorkspaceTransport({
      vault: "personal",
      device: "laptop",
      ids: ids(),
      fetch,
    });

    const loaded = await transport.load();
    expect(loaded.ok).toBe(false);
    expect(tabs(loaded.workspace.root)).toEqual([]);
  });

  it("rejects a layout the server returned that does not validate", async () => {
    // The client does not trust the server any more than the server trusts the client
    // (AGENTS.md §4.3). A layout naming another vault is the case that would put foreign
    // note paths in the tab bar.
    const { fetch } = transportFetch(
      () => new Response(serializeWorkspace(populated(["One.md"])).replace('"personal"', '"work"')),
    );
    const transport = createWorkspaceTransport({
      vault: "personal",
      device: "laptop",
      ids: ids(),
      fetch,
    });

    const loaded = await transport.load();
    expect(loaded.ok).toBe(false);
    expect(tabs(loaded.workspace.root)).toEqual([]);
  });
});

describe("saving", () => {
  it("coalesces a burst of changes into one request carrying the latest layout", async () => {
    // Dragging a split emits a change per frame. One request per frame would be both a
    // performance problem and a way to arrive at the server out of order.
    const timers = clock();
    const { fetch, calls } = transportFetch(() => new Response(null, { status: 204 }));
    const transport = createWorkspaceTransport({
      vault: "personal",
      device: "laptop",
      ids: ids(),
      fetch,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    transport.save(populated(["One.md"]));
    transport.save(populated(["One.md", "Two.md"]));
    const last = populated(["One.md", "Two.md", "Three.md"]);
    transport.save(last);
    expect(calls).toHaveLength(0);

    timers.tick();
    await transport.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.body).toBe(serializeWorkspace(last));
  });

  it("writes a pending layout on flush without waiting for the debounce", async () => {
    // The closing-tab case: `flush` is what a `pagehide` handler calls, and there is no
    // second chance after it.
    const timers = clock();
    const { fetch, calls } = transportFetch(() => new Response(null, { status: 204 }));
    const transport = createWorkspaceTransport({
      vault: "personal",
      device: "laptop",
      ids: ids(),
      fetch,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    transport.save(populated(["One.md"]));
    await transport.flush();

    expect(calls).toHaveLength(1);
    expect(timers.pending).toBe(0);
  });

  it("keeps two saves in order rather than racing them", async () => {
    // Out of order, the server ends up holding the *older* layout — a bug that only appears
    // when the network is slow, which is when nobody is looking.
    const timers = clock();
    const completed: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const { fetch, calls } = transportFetch(async (call) => {
      const marker = call.body?.includes("Two.md") === true ? "second" : "first";
      if (marker === "first") {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      completed.push(marker);
      return new Response(null, { status: 204 });
    });
    const transport = createWorkspaceTransport({
      vault: "personal",
      device: "laptop",
      ids: ids(),
      fetch,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    transport.save(populated(["One.md"]));
    timers.tick();
    transport.save(populated(["One.md", "Two.md"]));
    timers.tick();

    // Yield once so the queued write actually starts; the chain is built synchronously but
    // runs on a microtask.
    await Promise.resolve();
    // The second request has not even been issued while the first is outstanding.
    expect(calls).toHaveLength(1);
    releaseFirst?.();
    await transport.flush();

    expect(completed).toEqual(["first", "second"]);
  });

  it("reports a refusal instead of throwing, and keeps working", async () => {
    const timers = clock();
    const failures: unknown[] = [];
    let status = 500;
    const { fetch, calls } = transportFetch(() => new Response(null, { status }));
    const transport = createWorkspaceTransport({
      vault: "personal",
      device: "laptop",
      ids: ids(),
      fetch,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      onSaveError: (error) => failures.push(error),
    });

    transport.save(populated(["One.md"]));
    timers.tick();
    await transport.flush();
    expect(failures).toHaveLength(1);

    // The layout is still correct in memory, so the next change simply tries again.
    status = 204;
    transport.save(populated(["One.md", "Two.md"]));
    timers.tick();
    await transport.flush();
    expect(calls).toHaveLength(2);
    expect(failures).toHaveLength(1);
  });

  it("writes nothing more after it is destroyed", async () => {
    const timers = clock();
    const { fetch, calls } = transportFetch(() => new Response(null, { status: 204 }));
    const transport = createWorkspaceTransport({
      vault: "personal",
      device: "laptop",
      ids: ids(),
      fetch,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    transport.save(populated(["One.md"]));
    transport.destroy();
    timers.tick();
    await transport.flush();

    expect(calls).toHaveLength(0);
    expect(timers.pending).toBe(0);
  });
});

describe("the device id", () => {
  /** A `localStorage` stand-in. */
  function storage(initial?: string) {
    const values = new Map<string, string>();
    if (initial !== undefined) values.set(DEVICE_ID_KEY, initial);
    return {
      getItem: (key: string): string | null => values.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        values.set(key, value);
      },
      get stored(): string | undefined {
        return values.get(DEVICE_ID_KEY);
      },
    };
  }

  it("is created once and reused", () => {
    const store = storage();
    const first = deviceId(store);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(deviceId(store)).toBe(first);
  });

  it("keeps an existing id, so a reload does not lose the layout", () => {
    const store = storage("my-laptop");
    expect(deviceId(store)).toBe("my-laptop");
  });

  it("replaces one the server would refuse", () => {
    // The server rejects anything outside `[A-Za-z0-9_-]{1,64}`, so a corrupted value means
    // no layout is ever saved again — silently, which is the worst kind of broken.
    const store = storage("../../etc/passwd");
    const replaced = deviceId(store);
    expect(replaced).toMatch(/^[0-9a-f]{32}$/);
    expect(store.stored).toBe(replaced);
  });

  it("replaces one that is too long for the server to accept", () => {
    const store = storage("x".repeat(65));
    expect(deviceId(store)).toMatch(/^[0-9a-f]{32}$/);
  });
});
