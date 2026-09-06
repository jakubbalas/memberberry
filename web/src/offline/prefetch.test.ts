/**
 * The pinned-note sweep (`SPEC.md` §7.2).
 *
 * What is worth testing is what it refuses to do: re-fetch what is already here, and keep
 * opening sockets when there is plainly no server on the other end.
 */

import { describe, expect, it } from "vitest";

import type { createNoteCollaboration } from "../editor/collaboration.js";
import { noteFetcher, prefetchPinned, type PrefetchHandle } from "./prefetch.js";
import { stubReplica } from "./testing.js";

/** Records which notes were opened, and answers each with `arrives`. */
function server(arrives: (note: string) => boolean) {
  const opened: string[] = [];
  const destroyed: string[] = [];
  return {
    opened,
    destroyed,
    openNote: (note: string): PrefetchHandle => {
      opened.push(note);
      return {
        synced: Promise.resolve(arrives(note)),
        destroy: async () => {
          destroyed.push(note);
        },
      };
    },
  };
}

function replica(pinned: string[], resident: string[] = []) {
  const recorded: string[] = [];
  return {
    recorded,
    handle: stubReplica({
      pinned: async () => pinned,
      isResident: async (_vault: string, note: string) => resident.includes(note),
      opened: async (_vault: string, note: string) => {
        recorded.push(note);
      },
    }),
  };
}

describe("prefetching pinned notes", () => {
  it("fetches the ones this device does not have", async () => {
    const store = replica(["One.md", "Two.md"]);
    const remote = server(() => true);

    const result = await prefetchPinned({
      vault: "personal",
      replica: store.handle,
      openNote: remote.openNote,
    });

    expect(result.fetched).toEqual(["One.md", "Two.md"]);
    expect(store.recorded).toEqual(["One.md", "Two.md"]);
    // Each is closed again: this is a background sweep, not a set of open editors.
    expect(remote.destroyed).toEqual(["One.md", "Two.md"]);
  });

  it("leaves alone the ones it already has", async () => {
    const store = replica(["One.md", "Two.md"], ["One.md"]);
    const remote = server(() => true);

    await prefetchPinned({ vault: "personal", replica: store.handle, openNote: remote.openNote });

    expect(remote.opened).toEqual(["Two.md"]);
  });

  it("gives up rather than opening a socket per note with no server", async () => {
    // Offline, every one of these waits out its own timeout. A sweep with no give-up
    // condition turns a pinned set of two hundred notes into two hundred of them.
    const store = replica(["a.md", "b.md", "c.md", "d.md"]);
    const remote = server(() => false);

    const result = await prefetchPinned({
      vault: "personal",
      replica: store.handle,
      openNote: remote.openNote,
      giveUpAfter: 2,
    });

    expect(remote.opened).toEqual(["a.md", "b.md"]);
    expect(result.fetched).toEqual([]);
    expect(result.missing).toEqual(["a.md", "b.md", "c.md", "d.md"]);
  });

  it("keeps going when one note fails and the next succeeds", async () => {
    // A single failure is a note that was deleted or refused, not evidence of a dead network.
    const store = replica(["gone.md", "here.md"]);
    const remote = server((note) => note === "here.md");

    const result = await prefetchPinned({
      vault: "personal",
      replica: store.handle,
      openNote: remote.openNote,
    });

    expect(result.fetched).toEqual(["here.md"]);
    expect(result.missing).toEqual(["gone.md"]);
  });

  it("closes a note whose fetch threw", async () => {
    const store = replica(["One.md"]);
    let destroyed = 0;
    const result = await prefetchPinned({
      vault: "personal",
      replica: store.handle,
      openNote: () => ({
        synced: Promise.reject(new Error("the socket refused")),
        destroy: async () => {
          destroyed += 1;
        },
      }),
    });
    expect(destroyed).toBe(1);
    expect(result.fetched).toEqual([]);
  });

  it("does nothing at all when nothing is pinned", async () => {
    const remote = server(() => true);
    const result = await prefetchPinned({
      vault: "personal",
      replica: stubReplica(),
      openNote: remote.openNote,
    });
    expect(result).toEqual({ fetched: [], missing: [] });
    expect(remote.opened).toEqual([]);
  });
});

describe("opening one note without an editor", () => {
  /** A collaboration whose connection a test drives. */
  function collaboration() {
    let report: ((state: { connected: boolean; pending: number; synced: boolean }) => void) | undefined;
    let destroyed = 0;
    return {
      get destroyed(): number {
        return destroyed;
      },
      deliver(): void {
        report?.({ connected: true, pending: 0, synced: true });
      },
      create: ((options: { noteId: string }) => ({
        document: { note: options.noteId } as never,
        fragment: {} as never,
        awareness: {} as never,
        connection: {
          state: { connected: false, pending: 0, synced: false },
          subscribe: (listener: (state: { connected: boolean; pending: number; synced: boolean }) => void) => {
            report = listener;
            listener({ connected: false, pending: 0, synced: false });
            return () => {
              report = undefined;
            };
          },
        },
        whenReady: Promise.resolve(),
        destroy: async () => {
          destroyed += 1;
        },
      })) as unknown as typeof createNoteCollaboration,
    };
  }

  it("resolves when the server sends the body", async () => {
    const remote = collaboration();
    const fetch = noteFetcher({
      vault: "personal",
      user: "alice",
      endpoint: "ws://localhost/api/v1/sync",
      createCollaboration: remote.create,
      setTimer: () => () => undefined,
    });
    const handle = fetch("One.md");
    remote.deliver();
    expect(await handle.synced).toBe(true);
    await handle.destroy();
    expect(remote.destroyed).toBe(1);
  });

  it("gives up after the timeout rather than holding a socket open", async () => {
    const remote = collaboration();
    let fire: (() => void) | undefined;
    const fetch = noteFetcher({
      vault: "personal",
      user: "alice",
      endpoint: "ws://localhost/api/v1/sync",
      createCollaboration: remote.create,
      setTimer: (run) => {
        fire = run;
        return () => {
          fire = undefined;
        };
      },
    });
    const handle = fetch("One.md");
    fire?.();
    expect(await handle.synced).toBe(false);
  });

  it("does not wait out the timeout for a document with no transport", async () => {
    // A local-only replica can never sync, so waiting would be fifteen seconds of nothing.
    const fetch = noteFetcher({
      vault: "personal",
      user: "alice",
      endpoint: "ws://localhost/api/v1/sync",
      createCollaboration: (() => ({
        document: {} as never,
        fragment: {} as never,
        awareness: {} as never,
        whenReady: Promise.resolve(),
        destroy: async () => undefined,
      })) as unknown as typeof createNoteCollaboration,
      setTimer: () => () => undefined,
    });
    expect(await fetch("One.md").synced).toBe(false);
  });
});
