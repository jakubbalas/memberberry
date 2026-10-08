import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { IndexeddbPersistence } from "y-indexeddb";
import { Doc, applyUpdate, encodeStateAsUpdate } from "yjs";
import { load, noteBridge } from "../notes.js";
import { createNoteCollaboration, persistenceName } from "./collaboration.js";
import { SCHEMA_VERSION } from "./schema-revision.js";

beforeAll(async () => { await load(readFileSync(new URL("../wasm/mb_bg.wasm", import.meta.url))); });

describe("real revision-isolated y-indexeddb replicas", () => {
  it.each(["memberberry:ydoc:v:n.md", `memberberry:schema:${SCHEMA_VERSION - 1}:ydoc:v:n.md`])("does not import or delete old pending state (%s)", async (oldName) => {
    const factory = new IDBFactory(); vi.stubGlobal("indexedDB", factory); vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    const bridge = await noteBridge(); const old = new Doc();
    applyUpdate(old, bridge.updateFromMarkdown("# OLD\n\nUNSENT OLD PENDING BODY\n"));
    const oldPersistence = new IndexeddbPersistence(oldName, old); await oldPersistence.whenSynced;
    await oldPersistence.destroy(); const bytes = encodeStateAsUpdate(old); old.destroy();
    const current = createNoteCollaboration({ vaultId: "v", noteId: "n.md" });
    try {
      await current.whenReady;
      expect(current.fragment.length).toBe(0);
      expect(persistenceName("v", "n.md")).not.toBe(oldName);
      applyUpdate(current.document, bridge.updateFromMarkdown("# SERVER\n\nAUTHORITATIVE BODY\n"));
      expect(bridge.markdownFromUpdate(encodeStateAsUpdate(current.document))).toContain("AUTHORITATIVE BODY");
      const reopening = new Doc(); const storedOld = new IndexeddbPersistence(oldName, reopening);
      await storedOld.whenSynced;
      expect(encodeStateAsUpdate(reopening)).toEqual(bytes);
      expect(bridge.markdownFromUpdate(encodeStateAsUpdate(reopening))).toContain("UNSENT OLD PENDING BODY");
      await storedOld.destroy(); reopening.destroy();
    } finally { await current.destroy(); vi.unstubAllGlobals(); }
  });
});
