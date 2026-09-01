import { describe, expect, it, vi } from "vitest";

import type { Extensions } from "@tiptap/core";

import type { LocalPersistence } from "./collaboration.js";
import { startNoteEditor } from "./note-editor.js";

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function persistence(whenSynced: Promise<unknown>): LocalPersistence & { destroy: ReturnType<typeof vi.fn> } {
  return { whenSynced, destroy: vi.fn(async () => undefined) };
}

const element = {} as HTMLElement;

describe("startNoteEditor", () => {
  it("waits for IndexedDB before mounting Tiptap with the generated extensions and Yjs binding", async () => {
    const synced = deferred<void>();
    const local = persistence(synced.promise);
    const editor = { destroy: vi.fn() };
    const createEditor = vi.fn(() => editor);
    const loadExtensions = vi.fn(async (): Promise<Extensions> => []);

    const started = startNoteEditor({
      vaultId: "vault",
      noteId: "note",
      element,
      createPersistence: () => local,
      createEditor,
      loadExtensions,
    });
    await Promise.resolve();
    expect(createEditor).not.toHaveBeenCalled();

    synced.resolve();
    const session = await started;

    expect(loadExtensions).toHaveBeenCalledOnce();
    expect(createEditor).toHaveBeenCalledWith({
      element,
      extensions: expect.arrayContaining([expect.objectContaining({ name: "memberberryYjs" })]),
      editable: true,
    });
    await session.destroy();
  });

  it("honours readonly mode and destroys both the view and persistence once", async () => {
    const local = persistence(Promise.resolve());
    const editor = { destroy: vi.fn() };
    const session = await startNoteEditor({
      vaultId: "vault",
      noteId: "note",
      element,
      editable: false,
      createPersistence: () => local,
      createEditor: () => editor,
      loadExtensions: async () => [],
    });

    await Promise.all([session.destroy(), session.destroy()]);

    expect(editor.destroy).toHaveBeenCalledOnce();
    expect(local.destroy).toHaveBeenCalledOnce();
  });

  it("releases local persistence when generated extensions cannot load", async () => {
    const local = persistence(Promise.resolve());

    await expect(
      startNoteEditor({
        vaultId: "vault",
        noteId: "note",
        element,
        createPersistence: () => local,
        loadExtensions: async () => {
          throw new Error("schema unavailable");
        },
      }),
    ).rejects.toThrow("schema unavailable");

    expect(local.destroy).toHaveBeenCalledOnce();
  });
});
