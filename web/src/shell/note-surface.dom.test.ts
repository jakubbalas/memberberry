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

import { Doc, applyUpdate, encodeStateAsUpdate } from "yjs";

import type { LocalPersistence } from "../editor/collaboration.js";
import type { ConnectionState } from "../editor/sync.js";
import { stubReplica } from "../offline/testing.js";
import { createMemberberryExtensions } from "../editor/schema.js";
import { load, updateFromMarkdown } from "../notes.js";
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
    handle: async () =>
      stubReplica({
        isResident: async (_vault: string, note: string) => resident.includes(note),
        metadata: async (_vault: string, note: string) => ({
          path: note,
          title: "Roadmap",
          conflicts: 0,
        }),
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

describe("keeping §7.2's bookkeeping", () => {
  const bootstrap = { vault: "personal", note: "Projects/Roadmap.md", user: "alice" } as const;
  const location = { protocol: "http:", host: "localhost:9010" } as Location;

  /** A replica that records every call the pane makes about residency. */
  function accounting() {
    const patches: Array<{ note: string; bytes?: number; dirty?: boolean }> = [];
    const evicted: string[] = [];
    return {
      patches,
      evicted,
      handle: async () =>
        stubReplica({
          isResident: async () => true,
          measured: async (_vault, note, patch) => {
            patches.push({ note, ...patch });
          },
          evict: async (vault) => {
            evicted.push(vault);
            return [];
          },
        }),
    };
  }

  it("sweeps the cap once, when a note opens", async () => {
    // The moment a new body has just been added, and the only moment that needs a sweep.
    const store = accounting();
    const { surface } = await open({ bootstrap, location, replica: store.handle });
    try {
      await vi.waitFor(() => expect(store.evicted).toEqual(["personal"]));
    } finally {
      await surface.destroy();
    }
  });

  it("records unsent changes the moment there are any", async () => {
    // Not on teardown: a tab is usually closed by being closed, so a flag written only then
    // would be missing from exactly the session that produced it.
    const store = accounting();
    let report: ((state: ConnectionState) => void) | undefined;
    const { surface } = await open({
      bootstrap,
      location,
      replica: store.handle,
      createRemoteSync: ((_options, _document, _awareness, onConnectionChange) => {
        report = onConnectionChange;
        return {
          connected: false,
          pending: 0,
          synced: false,
          sendAwareness: () => undefined,
          destroy: () => undefined,
        };
      }) as NonNullable<Parameters<typeof openNoteSurface>[0]["createRemoteSync"]>,
    });
    try {
      report?.({ connected: false, pending: 2, synced: true });
      await vi.waitFor(() => expect(store.patches).toContainEqual({ note: bootstrap.note, dirty: true }));

      report?.({ connected: true, pending: 0, synced: true });
      await vi.waitFor(() =>
        expect(store.patches).toContainEqual({ note: bootstrap.note, dirty: false }),
      );
    } finally {
      await surface.destroy();
    }
  });

  it("measures the document when the pane closes", async () => {
    // Seeded through the persistence stub, which is what a restored local replica is: an
    // empty document weighs two bytes whatever happens, so a note with something in it is
    // the only way to tell a measurement from a constant.
    const seed = new Doc();
    seed.getText("body").insert(0, "a".repeat(500));
    const update = encodeStateAsUpdate(seed);

    const store = accounting();
    const { surface } = await open({
      bootstrap,
      location,
      replica: store.handle,
      createPersistence: (_name, document) => {
        applyUpdate(document, update);
        return { whenSynced: Promise.resolve(), destroy: async () => undefined };
      },
    });
    await surface.destroy();

    const measured = store.patches.find((patch) => patch.bytes !== undefined);
    expect(measured?.note).toBe(bootstrap.note);
    expect(measured?.bytes).toBeGreaterThan(500);
  });
});

describe("reconciling §3.5's conflicts", () => {
  const bootstrap = { vault: "personal", note: "Projects/Roadmap.md", user: "alice" } as const;
  const location = { protocol: "http:", host: "localhost:9010" } as Location;

  /** A replica holding one merge base, recording every one written back. */
  function withBase(stored: string | undefined) {
    const written: string[] = [];
    const state = { asked: false };
    return {
      written,
      state,
      handle: async () =>
        stubReplica({
          isResident: async () => true,
          base: async () => {
            state.asked = true;
            return stored;
          },
          measured: async (_vault, _note, patch) => {
            if (patch.base !== undefined) written.push(patch.base);
          },
        }),
    };
  }

  /**
   * Opens a pane whose transport this test drives.
   *
   * `raise` applies the server's state to the document before announcing it, which is what
   * the real transport does and what the announcement means — the CRDT has already merged,
   * and `mine` is the only copy of what was there before. A fake that skipped the apply would
   * be testing a sequence that cannot happen.
   *
   * The transport is the only injected part: the real WASM bridge and the real editor are
   * mounted, because what is being checked is that the three are wired to each other.
   */
  async function openWithTransport(replica: () => Promise<ReturnType<typeof stubReplica>>) {
    let announce: ((state: { mine?: Uint8Array; theirs: Uint8Array }) => void) | undefined;
    let document: Doc | undefined;
    const opened = await open({
      bootstrap,
      location,
      replica,
      createRemoteSync: ((_options, remote, _awareness, _onConnectionChange, onServerState) => {
        document = remote;
        announce = onServerState;
        return {
          connected: true,
          pending: 0,
          synced: true,
          sendAwareness: () => undefined,
          destroy: () => undefined,
        };
      }) as NonNullable<Parameters<typeof openNoteSurface>[0]["createRemoteSync"]>,
    });
    return {
      ...opened,
      ready: (): boolean => announce !== undefined,
      raise: (state: { mine?: Uint8Array; theirs: Uint8Array }): void => {
        if (document !== undefined) applyUpdate(document, state.theirs);
        announce?.(state);
      },
    };
  }

  /** A note's state, as the server would send it or as this device would have captured it. */
  async function stateOf(markdown: string): Promise<Uint8Array> {
    return updateFromMarkdown(markdown);
  }

  it("marks a collision against the stored base and shows the count", async () => {
    const store = withBase("Three levels.\n");
    const pane = await openWithTransport(store.handle);
    try {
      await vi.waitFor(() => expect(pane.ready() && store.state.asked).toBe(true));
      pane.raise({
        mine: await stateOf("Five levels.\n"),
        theirs: await stateOf("Four levels.\n"),
      });

      await vi.waitFor(() => {
        const count = pane.dom.panel.querySelector<HTMLElement>(".conflict-count");
        expect(count?.textContent).toBe("1 unresolved conflict — choose a version below");
        expect(count?.hidden).toBe(false);
      });
      const actions = pane.dom.panel.querySelectorAll(".conflict-action");
      expect([...actions].map((button) => button.textContent)).toEqual([
        "Keep mine",
        "Keep theirs",
        "Keep both",
      ]);
      expect(store.written.at(-1)).toContain("Five levels.");
      expect(store.written.at(-1)).toContain("[!conflict]");
    } finally {
      await pane.surface.destroy();
    }
  });

  it("marks nothing when only the other side changed the note", async () => {
    // The ordinary reconnection. Without the base this is indistinguishable from a collision,
    // and every note in a shared vault would grow a callout on every reconnect.
    const store = withBase("Three levels.\n");
    const pane = await openWithTransport(store.handle);
    try {
      await vi.waitFor(() => expect(pane.ready() && store.state.asked).toBe(true));
      pane.raise({
        mine: await stateOf("Three levels.\n"),
        theirs: await stateOf("Four levels.\n"),
      });

      await vi.waitFor(() => expect(store.written).toEqual(["Four levels.\n"]));
      expect(pane.dom.panel.querySelector(".conflict-action")).toBeNull();
      expect(pane.dom.panel.querySelector<HTMLElement>(".conflict-count")?.hidden).toBe(true);
    } finally {
      await pane.surface.destroy();
    }
  });

  it("records what both sides hold even when there was nothing to reconcile", async () => {
    // §3.5's base is written on every arrival, not only a divergent one: a note that
    // reconnected cleanly is a note both sides now agree about, and that agreement is what
    // makes the *next* offline edit detectable.
    const store = withBase(undefined);
    const pane = await openWithTransport(store.handle);
    try {
      await vi.waitFor(() => expect(pane.ready() && store.state.asked).toBe(true));
      pane.raise({ theirs: await stateOf("Four levels.\n") });

      await vi.waitFor(() => expect(store.written).toEqual(["Four levels.\n"]));
    } finally {
      await pane.surface.destroy();
    }
  });

  it("records a base for a note this device did not hold until now", async () => {
    // The first sync of a note is the one with no resident record yet, and `measured` writes
    // nothing without one — so this used to drop the very first base of every note, leaving
    // the first offline edit after opening it with nothing to compare against.
    const written: string[] = [];
    let resident = false;
    const pane = await openWithTransport(async () =>
      stubReplica({
        isResident: async () => resident,
        base: async () => undefined,
        opened: async () => {
          resident = true;
        },
        measured: async (_vault, _note, patch) => {
          if (patch.base !== undefined && resident) written.push(patch.base);
        },
      }),
    );
    try {
      await vi.waitFor(() => expect(pane.ready()).toBe(true));
      pane.raise({ theirs: await stateOf("Four levels.\n") });

      await vi.waitFor(() => expect(written).toEqual(["Four levels.\n"]));
    } finally {
      await pane.surface.destroy();
    }
  });

  it("compares the second arrival against the first one's result", async () => {
    // Held in memory as well as stored: two reconnections in one session must not both
    // compare against the version from before the first.
    const store = withBase("One.\n");
    const pane = await openWithTransport(store.handle);
    try {
      await vi.waitFor(() => expect(pane.ready() && store.state.asked).toBe(true));
      pane.raise({ theirs: await stateOf("Two.\n") });
      await vi.waitFor(() => expect(store.written).toEqual(["Two.\n"]));

      // Only they changed it again, measured against "Two." — against "One." this would read
      // as a collision and mark a callout.
      pane.raise({ mine: await stateOf("Two.\n"), theirs: await stateOf("Three.\n") });

      await vi.waitFor(() => expect(store.written).toEqual(["Two.\n", "Three.\n"]));
      expect(pane.dom.panel.querySelector(".conflict-action")).toBeNull();
    } finally {
      await pane.surface.destroy();
    }
  });

  it("stops reconciling once the pane is closed", async () => {
    // A pane is closed constantly under splits and tabs, and a transport that outlives one by
    // a frame would reconcile into an editor that has been destroyed.
    const store = withBase("Three levels.\n");
    const pane = await openWithTransport(store.handle);
    await vi.waitFor(() => expect(pane.ready() && store.state.asked).toBe(true));
    await pane.surface.destroy();
    store.written.length = 0;

    pane.raise({ mine: await stateOf("Five levels.\n"), theirs: await stateOf("Four levels.\n") });

    expect(store.written).toEqual([]);
  });

  it("does nothing for a local-only replica", async () => {
    // Nothing to diverge from and no base to keep, so no count is rendered — not even zero.
    const { surface, dom } = await open();
    try {
      expect(dom.panel.querySelector<HTMLElement>(".conflict-count")?.hidden).toBe(true);
      expect(dom.panel.querySelector(".conflict-action")).toBeNull();
    } finally {
      await surface.destroy();
    }
  });
});
