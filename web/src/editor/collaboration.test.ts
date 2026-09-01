import { describe, expect, it, vi } from "vitest";

import {
  PROSEMIRROR_ROOT,
  createNoteCollaboration,
  createYjsBinding,
  persistenceName,
  yjsPlugins,
  type LocalPersistence,
} from "./collaboration.js";

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
