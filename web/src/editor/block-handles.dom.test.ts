// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { applyUpdate, Doc, encodeStateAsUpdate, XmlElement, XmlText } from "yjs";
import { load, schema, updateFromMarkdown, markdownFromUpdate } from "../notes.js";
import { createYjsBinding, PROSEMIRROR_ROOT } from "./collaboration.js";
import { createMemberberryExtensions } from "./schema.js";
import { mountBlockHandles, type BlockHandlesOptions } from "./block-handles.js";
import { Awareness } from "y-protocols/awareness";
import { createConnectionStatus } from "./collaboration.js";

const cleanups: (() => void)[] = [];
beforeAll(async () => { await load(readFileSync("src/wasm/mb_bg.wasm")); });
afterEach(() => { for (const close of cleanups.splice(0)) close(); vi.restoreAllMocks(); });
async function open(markdown = "# Title\n\nAlpha\n\nBeta\n\nGamma\n", extra: Partial<Omit<BlockHandlesOptions, "editor" | "document" | "panel">> = {}) {
  const panel = document.createElement("section"); panel.className = "note-pane";
  const surface = document.createElement("div"); panel.append(surface); document.body.append(panel);
  const ydoc = new Doc(); applyUpdate(ydoc, await updateFromMarkdown(markdown));
  const editor = new Editor({ element: surface, editorProps: { handleScrollToSelection: () => true }, extensions: [...createMemberberryExtensions(await schema()), createYjsBinding(ydoc.getXmlFragment(PROSEMIRROR_ROOT))] });
  const handles = mountBlockHandles({ editor, document: ydoc, panel, noteKey: `fixture-${ydoc.clientID}`, ...extra });
  cleanups.push(() => { handles.destroy(); editor.destroy(); ydoc.destroy(); panel.remove(); });
  const start = (index: number) => { let pos = 0; for (let i = 0; i < index; i++) pos += editor.state.doc.child(i).nodeSize; return pos; };
  const group = Array.from(document.querySelectorAll<HTMLElement>(".block-handles")).at(-1);
  const menu = Array.from(document.querySelectorAll<HTMLElement>(".block-move-menu")).at(-1);
  if (!group || !menu) throw new Error("missing own controller portals");
  const control = (label: string) => {
    const found = group.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`) ?? menu.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
    if (!found) throw new Error(`missing ${label}`); return found;
  };
  const saved = () => markdownFromUpdate(encodeStateAsUpdate(ydoc));
  return { editor, ydoc, panel, handles, start, control, saved, group, menu };
}
it("offers a collapsed-caret keyboard/touch menu outside content, moves real Yjs text and returns editing focus", async () => {
  const f = await open(); f.editor.commands.setTextSelection(f.start(2) + 3);
  const key = new KeyboardEvent("keydown", { key: "F10", altKey: true, shiftKey: true, bubbles: true, cancelable: true });
  f.editor.view.dom.dispatchEvent(key);
  expect(key.defaultPrevented).toBe(true);
  const menu = document.querySelector<HTMLElement>(".block-move-menu");
  expect(menu?.hidden).toBe(false);
  expect(menu?.textContent).toContain("Do not rearrange this note while another browser/device is editing it, including offline");
  expect(document.activeElement).toBe(f.control("Move up"));
  expect(f.editor.view.dom.querySelector("button")).toBeNull();
  // jsdom does not perform keyboard/touch default activation; real browser proof belongs to integration.
  f.control("Move up").click();
  expect(await f.saved()).toBe("# Title\n\nBeta\n\nAlpha\n\nGamma\n");
  expect(f.editor.state.doc.resolve(f.editor.state.selection.head).parent.textContent).toBe("Beta");
  expect(f.editor.view.hasFocus()).toBe(true);
  f.control("Block actions").click();
  expect(menu?.hidden).toBe(false);
});
it("keeps disabled boundaries honest, supports menu arrows/Escape and leaves plain Alt-F10 alone", async () => {
  const f = await open(); f.editor.commands.setTextSelection(f.start(1) + 1);
  expect(f.handles.focus()).toBe(true);
  expect(f.control("Move up").disabled).toBe(true);
  expect(document.activeElement).toBe(f.control("Move down"));
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  f.control("Move down").dispatchEvent(escape);
  expect(escape.defaultPrevented).toBe(true); expect(f.editor.view.hasFocus()).toBe(true);
  expect(document.querySelector<HTMLElement>(".block-move-menu")?.hidden).toBe(true);
  const plain = new KeyboardEvent("keydown", { key: "F10", altKey: true, bubbles: true, cancelable: true }); f.editor.view.dom.dispatchEvent(plain);
  expect(plain.defaultPrevented).toBe(false);
  f.editor.commands.setTextSelection(f.start(2) + 1); f.handles.focus();
  f.control("Move up").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(f.control("Move down"));
});
it("rejects retained menu actions after waiting/source/read-only/composition/doc changes and teardown", async () => {
  const f = await open(); f.editor.commands.setTextSelection(f.start(2) + 1); f.handles.focus();
  const retained = f.control("Move up"); const before = await f.saved();
  f.panel.dataset["body"] = "waiting"; retained.click(); expect(await f.saved()).toBe(before);
  delete f.panel.dataset["body"]; f.handles.focus();
  f.editor.setEditable(false); retained.click(); expect(await f.saved()).toBe(before);
  f.editor.setEditable(true); f.handles.focus();
  f.editor.view.dom.dispatchEvent(new Event("compositionstart", { bubbles: true })); retained.click(); expect(await f.saved()).toBe(before);
  f.editor.view.dom.dispatchEvent(new Event("compositionend", { bubbles: true })); f.handles.focus();
  f.editor.view.dispatch(f.editor.state.tr.insertText("!"));
  const changed = await f.saved(); retained.click(); expect(await f.saved()).toBe(changed);
  expect(document.querySelector<HTMLElement>(".block-move-menu")?.hidden).toBe(true);
  f.handles.destroy(); f.handles.destroy(); retained.click(); expect(await f.saved()).toBe(changed);
  expect(document.querySelector(".block-handles")).toBeNull();
});
it("captures the actual native caret before keyboard focus handoff instead of a stale model selection", async () => {
  const f = await open(); f.editor.commands.setTextSelection(f.start(1) + 1);
  const text = f.editor.view.dom.querySelectorAll("p")[1]?.firstChild; if (!text) throw new Error("missing beta text");
  document.getSelection()?.setBaseAndExtent(text, 2, text, 2);
  f.editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", altKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  f.control("Move up").click(); expect(await f.saved()).toBe("# Title\n\nBeta\n\nAlpha\n\nGamma\n");
});
it("uses only one hovered root group, cancels native node dragging, coalesces geometry and clears every portal/frame", async () => {
  const f = await open("# Title\n\n| H |\n| --- |\n| A |\n\nAfter\n");
  const cell = f.editor.view.dom.querySelector("td"); if (!cell) throw new Error("missing cell");
  cell.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 120, clientY: 140 }));
  expect(f.control("Move table").draggable).toBe(false);
  expect(document.querySelectorAll(".block-handles")).toHaveLength(1);
  const native = new Event("dragstart", { bubbles: true, cancelable: true }); f.control("Move table").dispatchEvent(native); expect(native.defaultPrevented).toBe(true);
  const frame = vi.spyOn(window, "requestAnimationFrame");
  for (let i = 0; i < 20; i++) window.dispatchEvent(new Event("resize"));
  expect(frame.mock.calls.length).toBeLessThanOrEqual(1);
  f.editor.destroy(); expect(document.querySelector(".block-handles")).toBeNull(); expect(document.querySelector(".block-move-menu")).toBeNull();
});
function pointer(type: string, x: number, y: number): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } }); return event;
}
it("pointer-drags a complete block to a nonadjacent boundary without a PM/native drag transaction", async () => {
  const f = await open(); f.editor.commands.setTextSelection(f.start(1) + 2);
  vi.spyOn(f.panel, "getBoundingClientRect").mockReturnValue({ left: 0, right: 700, top: 0, bottom: 600, width: 700, height: 600, x: 0, y: 0, toJSON: () => ({}) });
  for (let i = 0; i < 4; i++) {
    const el = f.editor.view.nodeDOM(f.start(i)); if (!(el instanceof HTMLElement)) throw new Error("missing root DOM");
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({ left: 100, right: 600, top: 50 + i * 100, bottom: 90 + i * 100, width: 500, height: 40, x: 100, y: 50 + i * 100, toJSON: () => ({}) });
  }
  f.handles.refresh(); const grip = f.control("Move paragraph");
  const down = pointer("pointerdown", 90, 160); grip.dispatchEvent(down); expect(down.defaultPrevented).toBe(true);
  document.dispatchEvent(pointer("pointermove", 130, 410));
  await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
  expect(document.querySelector<HTMLElement>(".block-drop-indicator")?.hidden).toBe(false);
  document.dispatchEvent(pointer("pointerup", 130, 410));
  expect(await f.saved()).toBe("# Title\n\nBeta\n\nGamma\n\nAlpha\n");
  expect(f.editor.state.doc.resolve(f.editor.state.selection.head).parent.textContent).toBe("Alpha");
});
it("cancels a pointer drag on editor-local Escape and ignores foreign/native transferred drop data", async () => {
  const f = await open(); f.editor.commands.setTextSelection(f.start(1) + 1); f.handles.refresh();
  const before = await f.saved();
  f.control("Move paragraph").dispatchEvent(pointer("pointerdown", 20, 20));
  const key = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }); f.editor.view.dom.dispatchEvent(key);
  expect(key.defaultPrevented).toBe(true);
  const foreign = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(foreign, "dataTransfer", { value: { getData: () => "foreign-note-node", types: ["text/html"] } });
  f.control("Move paragraph").dispatchEvent(foreign); expect(foreign.defaultPrevented).toBe(true);
  document.dispatchEvent(pointer("pointerup", 200, 400)); expect(await f.saved()).toBe(before);
});
it("renders token-based targets, print hiding and gutter styles only outside authored content", () => {
  expect(existsSync("src/editor/block-handles.css"), "movement stylesheet exists").toBe(true);
  if (!existsSync("src/editor/block-handles.css")) return;
  const css = readFileSync("src/editor/block-handles.css", "utf8");
  expect(css).toContain("var(--touch-target-min)"); expect(css).toContain("@media print");
  expect(css).toContain(".block-handles-host .ProseMirror"); expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
});
it("closes on known peers, offline transport and duplicate mounted keys without claiming absence is a lock", async () => {
  const connection = createConnectionStatus(); connection.set({ connected: true, synced: true, pending: 0 });
  const f = await open(undefined, { connection, noteKey: "same-key" });
  f.editor.commands.setTextSelection(f.start(2) + 1); f.handles.focus(); const retained = f.control("Move up"); const before = await f.saved();
  connection.set({ connected: false, synced: false, pending: 0 }); expect(document.querySelector<HTMLElement>(".block-move-menu")?.hidden).toBe(true);
  retained.click(); expect(await f.saved()).toBe(before);
  connection.set({ connected: true, synced: true, pending: 0 }); f.handles.focus();
  const g = await open(undefined, { noteKey: "same-key" }); retained.click(); expect(await f.saved()).toBe(before);
  g.handles.destroy(); f.handles.focus(); retained.click(); expect(await f.saved()).not.toBe(before);
  const remoteDoc = new Doc(); const awareness = new Awareness(remoteDoc); cleanups.push(() => { awareness.destroy(); remoteDoc.destroy(); });
  const h = await open(undefined, { awareness }); h.editor.commands.setTextSelection(h.start(2) + 1); h.handles.focus(); const peerBefore = await h.saved();
  awareness.states.set(12345, { user: { name: "known" } }); awareness.emit("change", [{ added: [12345], updated: [], removed: [] }, "probe"]);
  expect(h.menu.hidden).toBe(true);
  h.control("Move up").click();
  expect(await h.saved()).toBe(peerBefore);
});
it("pairs controller-global listeners and cancels its pending frame exactly once on teardown", async () => {
  const f = await open(); f.handles.destroy();
  const add = vi.spyOn(document, "addEventListener"); const remove = vi.spyOn(document, "removeEventListener");
  const request = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(991); const cancel = vi.spyOn(window, "cancelAnimationFrame");
  const handles = mountBlockHandles({ editor: f.editor, document: f.ydoc, panel: f.panel, noteKey: "cleanup" });
  f.editor.commands.setTextSelection(f.start(1) + 1); handles.refresh(); expect(request).toHaveBeenCalledTimes(1);
  handles.destroy(); handles.destroy(); expect(cancel).toHaveBeenCalledWith(991);
  const eventTypes = new Set(["pointermove", "pointerup", "pointercancel", "focusin", "scroll"]);
  const additions = add.mock.calls.filter(call => eventTypes.has(call[0])); const removals = remove.mock.calls.filter(call => eventTypes.has(call[0]));
  expect(additions).toHaveLength(5); expect(removals).toHaveLength(5);
  for (const [name, listener, capture] of additions) expect(removals.some(call => call[0] === name && call[1] === listener && call[2] === capture)).toBe(true);
  expect(document.querySelector(".block-handles")).toBeNull(); expect(document.querySelector(".block-drop-indicator")).toBeNull();
});
it("focuses the selected root atom instead of the next paragraph and disposes on document destruction", async () => {
  const f = await open("# Title\n\n***\n\nAfter\n");
  f.editor.view.dispatch(f.editor.state.tr.setSelection(NodeSelection.create(f.editor.state.doc, f.start(1))));
  f.handles.refresh(); expect(f.control("Move divider")).toBeDefined();
  expect(f.handles.focus()).toBe(true); f.control("Move down").click();
  expect(await f.saved()).toBe("# Title\n\nAfter\n\n***\n");
  expect(f.editor.state.selection instanceof NodeSelection).toBe(true);
  f.ydoc.destroy(); expect(document.querySelector(".block-handles")).toBeNull();
});
it("hides the single hovered gutter after leaving its own portal when the editor is unfocused", async () => {
  const f = await open(); const p = f.editor.view.dom.querySelector("p"); if (!p) throw new Error("missing paragraph");
  p.dispatchEvent(new MouseEvent("pointermove", { bubbles: true })); expect(f.group.hidden).toBe(false);
  f.group.dispatchEvent(new MouseEvent("pointerleave", { relatedTarget: document.body })); expect(f.group.hidden).toBe(true);
});
it("rechecks host source mode and native view editability, and cancels a drag after source-equal generation drift", async () => {
  let richMode = true; const f = await open(undefined, { canInteract: () => richMode });
  f.editor.commands.setTextSelection(f.start(2) + 1); f.handles.focus(); const button = f.control("Move up"); const before = await f.saved();
  richMode = false; button.click(); expect(await f.saved()).toBe(before); expect(f.handles.focus()).toBe(false);
  richMode = true; f.handles.focus(); f.editor.view.setProps({ editable: () => false }); button.click(); expect(await f.saved()).toBe(before);
  f.editor.view.setProps({ editable: () => true }); f.handles.refresh();
  f.control("Move paragraph").dispatchEvent(pointer("pointerdown", 20, 20));
  const root = f.ydoc.getXmlFragment(PROSEMIRROR_ROOT).get(2);
  if (!(root instanceof XmlElement)) throw new Error("missing real root");
  const text = root.get(0); if (!(text instanceof XmlText)) throw new Error("missing real text");
  f.ydoc.transact(() => { const value = text.toString(); text.delete(0, text.length); text.insert(0, value); }, "source-equal-drag-drift");
  document.dispatchEvent(pointer("pointerup", 200, 400)); expect(await f.saved()).toBe(before);
  expect(f.group.hidden).toBe(true); expect(document.querySelector<HTMLElement>(".block-drop-indicator")?.hidden).toBe(true);
});
it("focuses the explanatory menu when the sole body root has no available movement boundary", async () => {
  const f = await open("# Title\n\nOnly body\n"); f.editor.commands.setTextSelection(f.start(1) + 1);
  expect(f.handles.focus()).toBe(true); expect(f.control("Move up").disabled).toBe(true); expect(f.control("Move down").disabled).toBe(true);
  expect(document.activeElement).toBe(f.menu);
  f.menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); expect(f.editor.view.hasFocus()).toBe(true);
});
it("shows the already-focused body root when mounted and restores touch actions after waiting readiness recovers", async () => {
  const f = await open(); f.handles.destroy(); f.editor.commands.setTextSelection(f.start(2) + 1); f.editor.view.focus();
  const connection = createConnectionStatus(); connection.set({ connected: true, synced: true, pending: 0 });
  const handles = mountBlockHandles({ editor: f.editor, document: f.ydoc, panel: f.panel, noteKey: "focused-mount", connection }); cleanups.push(handles.destroy);
  const group = document.querySelector<HTMLElement>(".block-handles"); expect(group?.hidden).toBe(false);
  f.panel.dataset["body"] = "waiting"; await Promise.resolve(); expect(group?.hidden).toBe(true);
  delete f.panel.dataset["body"]; await Promise.resolve(); expect(group?.hidden).toBe(false);
  connection.set({ connected: false, synced: false, pending: 0 }); expect(group?.hidden).toBe(true);
  connection.set({ connected: true, synced: true, pending: 0 }); expect(group?.hidden).toBe(false);
});
