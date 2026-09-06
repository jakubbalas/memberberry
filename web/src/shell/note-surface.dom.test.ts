// @vitest-environment jsdom

/**
 * Opening and closing a note pane, against the real editor.
 *
 * Tiptap, the Y.Doc and the control strip are all real here — only IndexedDB and the socket
 * are injected, because jsdom has no IndexedDB and a unit test should not open a WebSocket.
 * The `instanceof Editor` check inside `openNoteSurface` is only meaningful against the real
 * factory, so the factory is not stubbed.
 *
 * The teardown tests are the point. Once splits and tabs exist (§8.2) a pane is opened and
 * closed constantly, so a `destroy` that leaves a listener attached or throws on a second
 * call is not a slow leak but a fast one.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Extensions } from "@tiptap/core";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { LocalPersistence } from "../editor/collaboration.js";
import type { ConnectionState } from "../editor/sync.js";
import { createMemberberryExtensions } from "../editor/schema.js";
import { load } from "../notes.js";
import { LOCAL_ONLY, openNoteSurface } from "./note-surface.js";

const fixture = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

const contract = JSON.parse(
  readFileSync(fixture("../../../crates/mb-core/schema.json"), "utf8"),
) as unknown;

beforeAll(async () => {
  await load(readFileSync(fixture("../wasm/mb_bg.wasm")));
});

/** Stands in for `y-indexeddb`, which jsdom has no store for. */
function localPersistence(): LocalPersistence {
  return { whenSynced: Promise.resolve(), destroy: async () => undefined };
}

const loadExtensions = async (): Promise<Extensions> => createMemberberryExtensions(contract);

/** The three elements a pane needs, attached to the document so layout works. */
function elements(): { surface: HTMLElement; panel: HTMLElement; status: HTMLElement } {
  const panel = document.createElement("section");
  panel.className = "editor-panel";
  const surface = document.createElement("div");
  surface.className = "editor-surface";
  const status = document.createElement("p");
  status.className = "offline-status";
  panel.append(surface);
  document.body.append(panel, status);
  return { surface, panel, status };
}

async function open(
  overrides: Partial<Parameters<typeof openNoteSurface>[0]> = {},
): Promise<{
  surface: Awaited<ReturnType<typeof openNoteSurface>>;
  dom: ReturnType<typeof elements>;
}> {
  const dom = elements();
  const surface = await openNoteSurface({
    ...dom,
    createPersistence: localPersistence,
    loadExtensions,
    // Explicit rather than inherited: jsdom has no IndexedDB, so the default would be
    // `undefined` anyway, and a test that relied on that would silently start using a real
    // store the day the environment grew one.
    replica: async () => undefined,
    ...overrides,
  });
  return { surface, dom };
}

/** A replica holding exactly the notes named, for the §7.2 tests below. */
function replicaHolding(...resident: string[]) {
  const opened: string[] = [];
  return {
    opened,
    handle: async () => ({
      reconcile: async () => [],
      isResident: async (_vault: string, note: string) => resident.includes(note),
      metadata: async (_vault: string, note: string) => ({ path: note, title: "Roadmap" }),
      opened: async (_vault: string, note: string) => {
        opened.push(note);
      },
    }),
  };
}

describe("opening a note pane", () => {
  it("mounts an editable Tiptap surface and the control strip", async () => {
    const { surface, dom } = await open();
    try {
      expect(dom.surface.querySelector(".tiptap")).not.toBeNull();
      expect(dom.panel.querySelector(".editor-controls")).not.toBeNull();
      expect(dom.panel.querySelector(".editor-toolbar")).not.toBeNull();
    } finally {
      await surface.destroy();
    }
  });

  it("edits a local-only replica when no server bootstrapped the page", async () => {
    // The `npm run dev` path. It must not open a socket and must not invent an identity.
    let socketRequested = false;
    const { surface } = await open({
      createRemoteSync: () => {
        socketRequested = true;
        return { connected: false, pending: 0, synced: false, sendAwareness: () => undefined, destroy: () => undefined };
      },
    });
    try {
      expect(socketRequested).toBe(false);
      expect(LOCAL_ONLY.vault).toBe("local-demo");
    } finally {
      await surface.destroy();
    }
  });

  it("opens a socket on the origin that served the page when the server named the note", async () => {
    let endpoint: string | undefined;
    const { surface } = await open({
      bootstrap: { vault: "personal", note: "Welcome.md", user: "alice" },
      location: { protocol: "https:", host: "notes.example" } as Location,
      createRemoteSync: (options) => {
        endpoint = options.endpoint;
        return { connected: true, pending: 0, synced: false, sendAwareness: () => undefined, destroy: () => undefined };
      },
    });
    try {
      expect(endpoint).toBe("wss://notes.example/api/v1/sync");
    } finally {
      await surface.destroy();
    }
  });
});

describe("closing a note pane", () => {
  it("removes the control strip it added", async () => {
    const { surface, dom } = await open();
    expect(dom.panel.querySelector(".editor-controls")).not.toBeNull();

    await surface.destroy();
    expect(dom.panel.querySelector(".editor-controls")).toBeNull();
  });

  it("destroys the sync provider", async () => {
    let destroyed = 0;
    const { surface } = await open({
      bootstrap: { vault: "personal", note: "Welcome.md", user: "alice" },
      location: { protocol: "http:", host: "localhost:9010" } as Location,
      createRemoteSync: () => ({
        connected: true,
        pending: 0,
        synced: false,
        sendAwareness: () => undefined,
        destroy: () => {
          destroyed += 1;
        },
      }),
    });

    // Awaited rather than flushed a guessed number of microtasks: teardown chains through
    // Tiptap, the collaboration and then the transport, and counting ticks is how a test
    // becomes flaky the moment one of those gains a step (AGENTS.md §2.3).
    await surface.destroy();
    expect(destroyed).toBe(1);
  });

  it("is idempotent, because a pane can be closed twice", async () => {
    // The user closes the tab and the layout unmounts the pane. Tiptap throws if destroyed
    // twice, so without the guard the second call takes the page down with it.
    const { surface } = await open();
    await surface.destroy();
    await expect(surface.destroy()).resolves.toBeUndefined();
  });
});

describe("a note whose body was never replicated (SPEC §7.2)", () => {
  const bootstrap = { vault: "personal", note: "Projects/Roadmap.md", user: "alice" } as const;
  const location = { protocol: "http:", host: "localhost:9010" } as Location;

  /** A transport whose connection state a test drives, the way a server would. */
  function transport() {
    let report: ((state: ConnectionState) => void) | undefined;
    return {
      /** Simulates the server answering `subscribe` with the note's state. */
      deliverBody(): void {
        report?.({ connected: true, pending: 0, synced: true });
      },
      create: ((_options, _document, _awareness, onConnectionChange) => {
        report = onConnectionChange;
        return {
          connected: false,
          pending: 0,
          synced: false,
          sendAwareness: () => undefined,
          destroy: () => undefined,
        };
      }) as NonNullable<Parameters<typeof openNoteSurface>[0]["createRemoteSync"]>,
    };
  }

  it("covers the editor and says the body is elsewhere", async () => {
    // An editor that could be typed into here would merge those words with the body that
    // arrives on reconnect, and the note would look destroyed.
    const replica = replicaHolding();
    const server = transport();
    const { surface, dom } = await open({
      bootstrap,
      location,
      replica: replica.handle,
      createRemoteSync: server.create,
      // Immediately, rather than after §7.2's grace period: what the delay is for is the
      // *first* open of a note online, and it has its own test below.
      setTimer: (run) => {
        run();
        return () => undefined;
      },
    });
    try {
      expect(dom.panel.dataset["body"]).toBe("waiting");
      const notice = dom.panel.querySelector(".note-not-downloaded");
      expect(notice).not.toBeNull();
      // jsdom applies no stylesheet, so *that* the editor is hidden is a browser assertion
      // (`e2e/offline.spec.ts`). What is checkable here is the attribute the CSS keys on.
      expect(notice?.textContent).toContain("has not been downloaded");
      // Nothing is recorded as resident: the body has not arrived.
      expect(replica.opened).toEqual([]);
    } finally {
      await surface.destroy();
    }
  });

  it("uncovers it when the server sends the body, and remembers it is here", async () => {
    const replica = replicaHolding();
    const server = transport();
    const { surface, dom } = await open({
      bootstrap,
      location,
      replica: replica.handle,
      createRemoteSync: server.create,
      // Immediately, rather than after §7.2's grace period: what the delay is for is the
      // *first* open of a note online, and it has its own test below.
      setTimer: (run) => {
        run();
        return () => undefined;
      },
    });
    try {
      server.deliverBody();
      await Promise.resolve();

      expect(dom.panel.querySelector(".note-not-downloaded")).toBeNull();
      expect(dom.panel.dataset["body"]).toBeUndefined();
      expect(replica.opened).toEqual(["Projects/Roadmap.md"]);
    } finally {
      await surface.destroy();
    }
  });

  it("shows the replicated title, which is the whole point of the metadata tier", async () => {
    const replica = replicaHolding();
    const server = transport();
    const { surface, dom } = await open({
      bootstrap,
      location,
      replica: replica.handle,
      createRemoteSync: server.create,
      // Immediately, rather than after §7.2's grace period: what the delay is for is the
      // *first* open of a note online, and it has its own test below.
      setTimer: (run) => {
        run();
        return () => undefined;
      },
    });
    try {
      // Rendered when the store answers rather than awaited, so a slow store cannot delay
      // the editor behind it.
      await vi.waitFor(() =>
        expect(dom.panel.querySelector(".note-not-downloaded h2")?.textContent).toBe("Roadmap"),
      );
    } finally {
      await surface.destroy();
    }
  });

  it("does not cover a note this device already holds", async () => {
    // Offline-first: a resident note opens immediately, with no server involved at all.
    const replica = replicaHolding("Projects/Roadmap.md");
    const server = transport();
    const { surface, dom } = await open({
      bootstrap,
      location,
      replica: replica.handle,
      createRemoteSync: server.create,
      // Immediately, rather than after §7.2's grace period: what the delay is for is the
      // *first* open of a note online, and it has its own test below.
      setTimer: (run) => {
        run();
        return () => undefined;
      },
    });
    try {
      expect(dom.panel.querySelector(".note-not-downloaded")).toBeNull();
      expect(dom.surface.querySelector(".tiptap")).not.toBeNull();
      // ...and the open moves it to the front of §7.2's LRU.
      expect(replica.opened).toEqual(["Projects/Roadmap.md"]);
    } finally {
      await surface.destroy();
    }
  });

  it("never applies to a local-only replica", async () => {
    // The `npm run dev` path has no server, so "downloaded" means nothing there — the
    // document *is* the local one, and there is no transport to wait on.
    const replica = replicaHolding();
    const { surface, dom } = await open({ replica: replica.handle });
    try {
      expect(dom.panel.querySelector(".note-not-downloaded")).toBeNull();
      expect(dom.surface.querySelector(".tiptap")).not.toBeNull();
      expect(replica.opened).toEqual([]);
    } finally {
      await surface.destroy();
    }
  });

  it("does not flash the notice on a first open that is about to succeed", async () => {
    // Every first open is a note this device does not hold yet, so without the delay each
    // one would say "not downloaded" for the length of a round trip. The editor is covered
    // regardless — that part is not cosmetic.
    const replica = replicaHolding();
    const server = transport();
    let pending: Array<() => void> = [];
    const { surface, dom } = await open({
      bootstrap,
      location,
      replica: replica.handle,
      createRemoteSync: server.create,
      setTimer: (run) => {
        pending.push(run);
        return () => {
          pending = pending.filter((queued) => queued !== run);
        };
      },
    });
    try {
      expect(dom.panel.dataset["body"]).toBe("waiting");
      expect(dom.panel.querySelector(".note-not-downloaded")).toBeNull();

      server.deliverBody();
      await Promise.resolve();

      expect(dom.panel.dataset["body"]).toBeUndefined();
      // ...and the timer was cancelled, so it cannot append the notice a second later over
      // a note that is now open. Nothing is left to fire.
      expect(pending).toEqual([]);
      expect(dom.panel.querySelector(".note-not-downloaded")).toBeNull();
    } finally {
      await surface.destroy();
    }
  });

  it("leaves nothing behind when the pane closes while still waiting", async () => {
    const replica = replicaHolding();
    const server = transport();
    const { surface, dom } = await open({
      bootstrap,
      location,
      replica: replica.handle,
      createRemoteSync: server.create,
      // Immediately, rather than after §7.2's grace period: what the delay is for is the
      // *first* open of a note online, and it has its own test below.
      setTimer: (run) => {
        run();
        return () => undefined;
      },
    });
    await surface.destroy();

    expect(dom.panel.querySelector(".note-not-downloaded")).toBeNull();
    expect(dom.panel.dataset["body"]).toBeUndefined();
  });
});
