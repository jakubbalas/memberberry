import { describe, expect, it, vi } from "vitest";

import {
  PROSEMIRROR_ROOT,
  createNoteCollaboration,
  createYjsBinding,
  persistenceName,
  yjsPlugins,
  type LocalPersistence,
} from "./collaboration.js";
import type { ConnectionState } from "./sync.js";

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("persistenceName", () => {
  it("keeps vault and note identities unambiguous", () => {
    expect(persistenceName("personal/work", "a:b")).not.toBe(persistenceName("personal", "work/a:b"));
    expect(persistenceName("personal/work", "a:b")).toBe("memberberry:ydoc:personal%2Fwork:a%3Ab");
  });

  it("rejects an incomplete local identity", () => {
    expect(() => persistenceName("", "note")).toThrow("must not be empty");
    expect(() => persistenceName("vault", "")).toThrow("must not be empty");
  });
});

describe("createNoteCollaboration", () => {
  it("uses the contract root and waits for local restoration", async () => {
    const synced = deferred<void>();
    const persistence = fakePersistence(synced.promise);
    const createPersistence = vi.fn(() => persistence);

    const collaboration = createNoteCollaboration({
      vaultId: "vault",
      noteId: "note",
      createPersistence,
    });
    let ready = false;
    void collaboration.whenReady.then(() => {
      ready = true;
    });
    await Promise.resolve();

    expect(createPersistence).toHaveBeenCalledWith("memberberry:ydoc:vault:note", collaboration.document);
    expect(collaboration.fragment).toBe(collaboration.document.getXmlFragment(PROSEMIRROR_ROOT));
    expect(ready).toBe(false);

    synced.resolve();
    await collaboration.whenReady;
    expect(ready).toBe(true);
  });

  it("tears down persistence and its owned Y.Doc exactly once", async () => {
    const persistence = fakePersistence(Promise.resolve());
    const collaboration = createNoteCollaboration({
      vaultId: "vault",
      noteId: "note",
      createPersistence: () => persistence,
    });
    const destroyed = vi.fn();
    collaboration.document.on("destroy", destroyed);

    await Promise.all([collaboration.destroy(), collaboration.destroy()]);

    expect(persistence.destroy).toHaveBeenCalledTimes(1);
    expect(destroyed).toHaveBeenCalledTimes(1);
  });

  it("starts remote sync only after restoration and tears it down with the document", async () => {
    const synced = deferred<void>();
    const remote = { connected: true, pending: 0, synced: false, sendAwareness: vi.fn(), destroy: vi.fn() };
    const createRemoteSync = vi.fn(() => remote);
    const collaboration = createNoteCollaboration({
      vaultId: "vault",
      noteId: "note",
      createPersistence: () => fakePersistence(synced.promise),
      remoteSync: { endpoint: "ws://localhost/api/v1/sync", vault: "personal", note: "One.md", user: "alice" },
      createRemoteSync,
    });

    expect(createRemoteSync).not.toHaveBeenCalled();
    synced.resolve();
    await collaboration.whenReady;
    expect(createRemoteSync).toHaveBeenCalledWith(
      { endpoint: "ws://localhost/api/v1/sync", vault: "personal", note: "One.md", user: "alice" },
      collaboration.document,
      collaboration.awareness,
      expect.any(Function),
    );
    await collaboration.destroy();
    expect(remote.destroy).toHaveBeenCalledOnce();
  });

  it("reports the transport's connection so the UI can say you are alone", async () => {
    const synced = deferred<void>();
    let report: ((state: ConnectionState) => void) | undefined;
    const collaboration = createNoteCollaboration({
      vaultId: "vault",
      noteId: "note",
      createPersistence: () => fakePersistence(synced.promise),
      remoteSync: { endpoint: "ws://localhost/api/v1/sync", vault: "personal", note: "One.md", user: "alice" },
      createRemoteSync: (_options, _document, _awareness, onConnectionChange) => {
        report = onConnectionChange;
        return { connected: false, pending: 0, synced: false, sendAwareness: vi.fn(), destroy: vi.fn() };
      },
    });
    synced.resolve();
    await collaboration.whenReady;
    const seen: ConnectionState[] = [];
    const unsubscribe = collaboration.connection?.subscribe((state) => seen.push(state));

    report?.({ connected: true, pending: 0, synced: false });
    report?.({ connected: true, pending: 0, synced: false });
    report?.({ connected: false, pending: 0, synced: false });
    // A change to the pending count alone is a change worth reporting: §7.4's indicator says
    // how much is waiting, and a repeated `connected: false` that carries a new number would
    // otherwise be swallowed as a no-op transition.
    report?.({ connected: false, pending: 2, synced: false });

    // Subscribing replays the current value, then only genuine transitions follow.
    expect(seen).toEqual([
      { connected: false, pending: 0, synced: false },
      { connected: true, pending: 0, synced: false },
      { connected: false, pending: 0, synced: false },
      { connected: false, pending: 2, synced: false },
    ]);
    expect(collaboration.connection?.state).toEqual({ connected: false, pending: 2, synced: false });
    unsubscribe?.();
    report?.({ connected: true, pending: 0, synced: false });
    expect(seen).toHaveLength(4);
    await collaboration.destroy();
  });

  it("has no connection to report for a local-only document", () => {
    // SPEC 7.5: a note with no server transport is not "offline", it simply has no server.
    const collaboration = createNoteCollaboration({
      vaultId: "vault",
      noteId: "note",
      createPersistence: () => fakePersistence(Promise.resolve()),
    });

    expect(collaboration.connection).toBeUndefined();
  });
});

describe("createYjsBinding", () => {
  it("creates the Tiptap extension that owns sync and per-document undo", () => {
    const collaboration = createNoteCollaboration({
      vaultId: "vault",
      noteId: "note",
      createPersistence: () => fakePersistence(Promise.resolve()),
    });

    const binding = createYjsBinding(collaboration.fragment);

    expect(binding.name).toBe("memberberryYjs");
    expect(yjsPlugins(collaboration.fragment)).toHaveLength(2);
  });
});

function fakePersistence(whenSynced: Promise<unknown>): LocalPersistence & { destroy: ReturnType<typeof vi.fn> } {
  return { whenSynced, destroy: vi.fn(async () => undefined) };
}
