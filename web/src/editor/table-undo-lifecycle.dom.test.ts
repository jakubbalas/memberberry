// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { Editor } from "@tiptap/core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { applyUpdate, Doc, encodeStateAsUpdate, UndoManager } from "yjs";
import { createYjsBinding, PROSEMIRROR_ROOT } from "./collaboration.js";
import { mountTableTools, tableRowHandles } from "./table-tools.js";
import { selectTableCell } from "./tables.js";
import { yUndoPluginKey } from "y-prosemirror";
import { load, noteBridge, updateFromMarkdown } from "../notes.js";
import { startNoteEditor } from "./note-editor.js";
import { createMemberberryExtensions } from "./schema.js";
import { mountEditorShell } from "./editor-shell.js";

const contract: unknown = JSON.parse(readFileSync("../crates/mb-core/schema.json", "utf8"));
beforeAll(async () => { await load(readFileSync("src/wasm/mb_bg.wasm")); });

/**
 * Counts real history closures. UndoManager binds `destroy` in its constructor and hands that
 * copy to `doc.on("destroy")`, so an instance spy installed later never sees a session close.
 */
function trackHistoryClosure(): { closed(manager: UndoManager): number; restore(): void } {
  const spy = vi.spyOn(UndoManager.prototype, "destroy");
  return { closed: (manager) => spy.mock.contexts.filter((context) => context === manager).length, restore: () => { spy.mockRestore(); } };
}

describe("table UI and note-session undo ownership", () => {
  it("remounts usable handles without duplicate plugins or leaked table listeners", async () => {
    const history = trackHistoryClosure();
    const ydoc = new Doc();
    const surface = document.createElement("div");
    const parent = document.createElement("div");
    document.body.append(surface, parent);
    const editor = new Editor({ element: surface, extensions: [
      ...createMemberberryExtensions(contract), tableRowHandles,
      createYjsBinding(ydoc.getXmlFragment(PROSEMIRROR_ROOT)),
    ] });
    const plugins = editor.state.plugins;
    applyUpdate(ydoc, await updateFromMarkdown("| Header |\n| --- |\n| Alpha |\n| Beta |\n"));
    const undoState = yUndoPluginKey.getState(editor.state);
    if (undoState === undefined) throw new Error("undo plugin missing");
    const manager = undoState.undoManager;
    const addWindow = vi.spyOn(window, "addEventListener");
    const removeWindow = vi.spyOn(window, "removeEventListener");
    const addSurface = vi.spyOn(editor.view.dom, "addEventListener");
    const removeSurface = vi.spyOn(editor.view.dom, "removeEventListener");
    let tools: ReturnType<typeof mountTableTools> | undefined;
    try {
      selectTableCell(editor, 1);
      for (let index = 0; index < 3; index += 1) {
        tools = mountTableTools(editor, parent);
        expect(editor.state.plugins).toBe(plugins);
        expect(editor.view.dom.querySelectorAll(".table-row-handle")).toHaveLength(2);
        expect(() => mountTableTools(editor, parent)).toThrow("already mounted");
        expect(parent.querySelectorAll(".table-tools")).toHaveLength(1);
        const handle = editor.view.dom.querySelector<HTMLButtonElement>(".table-row-handle");
        if (handle === null) throw new Error("row handle missing");
        handle.click();
        expect(document.querySelectorAll(".table-row-menu")).toHaveLength(1);
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
        expect(document.querySelector(".table-row-menu")).toBeNull();
        expect(document.activeElement).toBe(handle);
        const retainedAction = Array.from(parent.querySelectorAll("button")).find(button => button.textContent === "Add row");
        handle.click();
        const retainedMenuAction = document.querySelector<HTMLButtonElement>(".table-row-menu button");
        if (retainedMenuAction === null) throw new Error("row menu action missing");
        tools.destroy(); tools.destroy();
        expect(editor.state.plugins).toBe(plugins);
        expect(editor.view.dom.querySelectorAll(".table-row-handle")).toHaveLength(0);
        expect(parent.children).toHaveLength(0);
        const before = editor.getJSON();
        const focused = document.activeElement;
        handle.click(); retainedAction?.click(); retainedMenuAction.click();
        expect(document.activeElement).toBe(focused);
        expect(document.querySelector(".table-row-menu")).toBeNull();
        expect(editor.getJSON()).toEqual(before);
      }
      for (const [added, removed] of [[addWindow, removeWindow], [addSurface, removeSurface]] as const) {
        expect(added.mock.calls.length).toBeGreaterThan(0);
        for (const [type, listener] of added.mock.calls) {
          expect(removed.mock.calls.filter(call => call[0] === type && call[1] === listener)).toHaveLength(1);
        }
      }
      expect(history.closed(manager)).toBe(0);
      expect(yUndoPluginKey.getState(editor.state)?.undoManager).toBe(manager);
      // SPEC §8.4: the stack lasts for the note session, which owns the Y.Doc; a view
      // rebuild or editor teardown alone does not end it, the document's teardown does.
      editor.destroy();
      expect(history.closed(manager)).toBe(0);
      ydoc.destroy();
      expect(history.closed(manager)).toBe(1);
    } finally {
      history.restore();
      tools?.destroy(); editor.destroy(); ydoc.destroy();
      addWindow.mockRestore(); removeWindow.mockRestore(); addSurface.mockRestore(); removeSurface.mockRestore();
      surface.remove(); parent.remove();
    }
  });

  it("refuses missing initial extension before mounting shell controls or changing history", () => {
    const ydoc = new Doc();
    const editor = new Editor({ extensions: [
      ...createMemberberryExtensions(contract), createYjsBinding(ydoc.getXmlFragment(PROSEMIRROR_ROOT)),
    ] });
    const panel = document.createElement("section");
    const status = document.createElement("p");
    const plugins = editor.state.plugins;
    try {
      expect(() => mountEditorShell({ editor, document: ydoc, panel, status })).toThrow("initial editor extensions");
      expect(panel.children).toHaveLength(0);
      expect(editor.state.plugins).toBe(plugins);
      editor.commands.insertContent("still captured");
      editor.commands.keyboardShortcut("Mod-z");
      expect(editor.getText()).toBe("");
    } finally { editor.destroy(); ydoc.destroy(); }
  });

  it("captures the first edit through shell mounts and disposes history only at actual session teardown", async () => {
    const panel = document.createElement("section");
    const surface = document.createElement("div");
    const status = document.createElement("p");
    panel.append(surface);
    document.body.append(panel);
    let editor: Editor | undefined;
    const persistenceDestroyed = vi.fn(async () => undefined);
    const history = trackHistoryClosure();
    const session = await startNoteEditor({
      element: surface, vaultId: "lifecycle-fixture", noteId: "note",
      createPersistence: () => ({ whenSynced: Promise.resolve(), destroy: persistenceDestroyed }),
      loadExtensions: async () => createMemberberryExtensions(contract),
      loadEmojiCatalog: async () => [],
      createEditor: (options) => { editor = new Editor(options); return editor; },
    });
    if (editor === undefined) throw new Error("editor missing");
    const actual = editor;
    const undoState = yUndoPluginKey.getState(actual.state);
    if (undoState === undefined) throw new Error("undo plugin missing");
    const manager = undoState.undoManager;
    const plugins = actual.state.plugins;
    let shell: ReturnType<typeof mountEditorShell> | undefined;
    const canonical = async (): Promise<string> => (await noteBridge()).markdownFromUpdate(encodeStateAsUpdate(session.collaboration.document));
    try {
      applyUpdate(session.collaboration.document, await updateFromMarkdown("# Title\n\nBody\n"), "fixture-seed");
      shell = mountEditorShell({ editor: actual, document: session.collaboration.document, panel, status });
      actual.commands.insertContentAt(8, "First ");
      expect(manager.undoStack).toHaveLength(1);
      expect(await canonical()).toBe("# Title\n\nFirst Body\n");
      expect(history.closed(manager)).toBe(0);
      for (let index = 0; index < 3; index += 1) {
        shell.destroy(); shell.destroy();
        expect(actual.state.plugins).toBe(plugins);
        expect(yUndoPluginKey.getState(actual.state)?.undoManager).toBe(manager);
        expect(history.closed(manager)).toBe(0);
        expect(persistenceDestroyed).not.toHaveBeenCalled();
        expect(panel.querySelectorAll(".editor-controls")).toHaveLength(0);
        shell = mountEditorShell({ editor: actual, document: session.collaboration.document, panel, status });
        expect(panel.querySelectorAll(".editor-controls")).toHaveLength(1);
        expect(actual.state.plugins).toBe(plugins);
      }
      actual.commands.keyboardShortcut("Mod-z");
      expect(await canonical()).toBe("# Title\n\nBody\n");
      actual.commands.keyboardShortcut("Mod-Shift-z");
      expect(await canonical()).toBe("# Title\n\nFirst Body\n");
      shell.destroy();
      expect(history.closed(manager)).toBe(0);
      await session.destroy(); await session.destroy();
      expect(history.closed(manager)).toBe(1);
      expect(persistenceDestroyed).toHaveBeenCalledTimes(1);
    } finally {
      history.restore();
      shell?.destroy();
      await session.destroy();
      panel.remove();
    }
  });
});
