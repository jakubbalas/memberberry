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
  expect(menu?.textContent).not.toContain("Single-editor rearrangement only");
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
  const eventTypes = new Set(["pointerdown", "pointermove", "pointerup", "pointercancel", "focusin", "scroll"]);
  const additions = add.mock.calls.filter(call => eventTypes.has(call[0])); const removals = remove.mock.calls.filter(call => eventTypes.has(call[0]));
  expect(additions.length).toBeGreaterThan(0); expect(removals).toHaveLength(additions.length);
  for (const [name, listener, capture] of additions) expect(removals.some(call => call[0] === name && call[1] === listener && call[2] === capture)).toBe(true);
  expect(document.querySelector(".block-handles")).toBeNull(); expect(document.querySelector(".block-drop-indicator")).toBeNull();
  expect(document.querySelector(".block-selection-layer")).toBeNull(); expect(document.querySelector(".block-selection-status")).toBeNull();
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
function key(f: Awaited<ReturnType<typeof open>>, value: string, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true });
  f.editor.view.dom.dispatchEvent(event); return event;
}
it("selects complete blocks separately from text, extends/shrinks with Shift arrows and keeps the range after moving", async () => {
  const f = await open(); f.editor.commands.setTextSelection(f.start(1) + 2);
  expect(key(f, "Escape").defaultPrevented).toBe(true);
  expect(f.editor.state.selection.empty).toBe(true);
  key(f, "ArrowDown", true);
  expect(document.querySelector(".block-selection-status")?.textContent).toContain("2 blocks selected");
  key(f, "ArrowUp", true);
  expect(document.querySelector(".block-selection-status")?.textContent).toContain("1 block selected");
  key(f, "ArrowDown", true);
  expect(f.handles.move("down")).toBe(true);
  expect(await f.saved()).toBe("# Title\n\nGamma\n\nAlpha\n\nBeta\n");
  expect(document.querySelector(".block-selection-status")?.textContent).toContain("2 blocks selected");
  expect(f.control("Move 2 blocks")).toBeDefined();
  key(f, "Escape"); expect(f.editor.view.dom.classList.contains("has-block-selection")).toBe(false);
});
it("exposes select and extend actions for touch without selecting a protected title", async () => {
  const f = await open(); f.editor.commands.setTextSelection(2);
  expect(key(f, "Escape").defaultPrevented).toBe(false);
  f.editor.commands.setTextSelection(f.start(1) + 2); f.handles.focus();
  f.control("Select block").click();
  f.handles.focus(); f.control("Extend selection down").click();
  expect(document.querySelector(".block-selection-status")?.textContent).toContain("2 blocks selected");
  f.handles.focus(); f.control("Clear block selection").click();
  expect(f.editor.view.dom.classList.contains("has-block-selection")).toBe(false);
});
it("clears selection on typing, a text pointer gesture, composition, document changes and outside focus", async () => {
  const f = await open();
  const select = (): void => { f.editor.commands.setTextSelection(f.start(1) + 2); key(f, "Escape"); key(f, "ArrowDown", true); };
  select(); key(f, "a"); expect(f.editor.view.dom.classList.contains("has-block-selection")).toBe(false);
  select(); f.editor.view.dom.querySelector("p")?.dispatchEvent(pointer("pointerdown", 120, 170));
  expect(f.editor.view.dom.classList.contains("has-block-selection")).toBe(false);
  select(); f.editor.view.dom.dispatchEvent(new Event("compositionstart", { bubbles: true }));
  expect(f.editor.view.dom.classList.contains("has-block-selection")).toBe(false);
  f.editor.view.dom.dispatchEvent(new Event("compositionend", { bubbles: true }));
  select(); f.editor.view.dispatch(f.editor.state.tr.insertText("x", f.start(3) + 1));
  expect(f.editor.view.dom.classList.contains("has-block-selection")).toBe(false);
  select(); const outside = document.createElement("button"); document.body.append(outside); outside.focus(); outside.remove();
  expect(f.editor.view.dom.classList.contains("has-block-selection")).toBe(false);
});
it("invalidates a selected range when connection, peer or host readiness changes", async () => {
  const connection = createConnectionStatus(); connection.set({ connected: true, synced: true, pending: 0 });
  const f = await open(undefined, { connection }); f.editor.commands.setTextSelection(f.start(1) + 2);
  key(f, "Escape"); key(f, "ArrowDown", true); const before = await f.saved();
  connection.set({ connected: false, synced: false, pending: 0 });
  expect(f.editor.view.dom.classList.contains("has-block-selection")).toBe(false);
  expect(f.handles.move("down")).toBe(false); expect(await f.saved()).toBe(before);
  connection.set({ connected: true, synced: true, pending: 0 }); key(f, "Escape");
  f.panel.dataset["body"] = "waiting"; await Promise.resolve();
  expect(f.editor.view.dom.classList.contains("has-block-selection")).toBe(false);
});
it("retains the moved range through its own pending acknowledgement while refusing further writes", async () => {
  const connection = createConnectionStatus(); connection.set({ connected: true, synced: true, pending: 0 });
  const f = await open(undefined, { connection }); f.editor.commands.setTextSelection(f.start(1) + 2);
  key(f, "Escape"); key(f, "ArrowDown", true);
  const pending = (): void => { connection.set({ connected: true, synced: true, pending: 1 }); };
  f.ydoc.on("update", pending);
  expect(f.handles.move("down")).toBe(true); const moved = await f.saved();
  expect(f.editor.view.dom.classList.contains("has-block-selection")).toBe(true);
  expect(f.handles.move("up")).toBe(false); expect(await f.saved()).toBe(moved);
  f.ydoc.off("update", pending); connection.set({ connected: true, synced: true, pending: 0 });
  expect(f.control("Move 2 blocks")).toBeDefined();
  key(f, "ArrowUp", true); expect(document.querySelector(".block-selection-status")?.textContent).toContain("1 block selected");
  key(f, "Escape"); expect(f.editor.view.dom.classList.contains("has-block-selection")).toBe(false);
});
it("margin marquee selects full rows, Shift-click extends them and cancel removes the marquee", async () => {
  const f = await open(); f.editor.commands.setTextSelection(f.start(1) + 2);
  vi.spyOn(f.panel, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 700, 600));
  for (let i = 0; i < 4; i++) {
    const el = f.editor.view.nodeDOM(f.start(i)); if (!(el instanceof HTMLElement)) throw new Error("missing row DOM");
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 50 + i * 100, 500, 40));
  }
  vi.spyOn(f.editor.view, "posAtCoords").mockImplementation(coords => ({ pos: f.start(coords.top < 200 ? 1 : coords.top < 300 ? 2 : 3) + 1, inside: -1 }));
  const down = pointer("pointerdown", 80, 145); f.editor.view.dom.dispatchEvent(down); expect(down.defaultPrevented).toBe(true);
  document.dispatchEvent(pointer("pointermove", 200, 280));
  await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
  expect(document.querySelectorAll(".block-selection-highlight")).toHaveLength(2);
  expect(document.querySelector(".block-selection-marquee")).not.toBeNull();
  document.dispatchEvent(pointer("pointerup", 200, 280));
  expect(document.querySelector(".block-selection-marquee")).toBeNull();
  const shift = pointer("pointerdown", 150, 370); Object.defineProperty(shift, "shiftKey", { value: true });
  f.editor.view.dom.querySelector("p")?.dispatchEvent(shift);
  expect(document.querySelectorAll(".block-selection-highlight")).toHaveLength(3);
  f.editor.view.dom.dispatchEvent(pointer("pointerdown", 80, 145)); document.dispatchEvent(pointer("pointermove", 200, 280));
  document.dispatchEvent(new Event("pointercancel"));
  expect(document.querySelectorAll(".block-selection-highlight, .block-selection-marquee")).toHaveLength(0);
});

it.each([
  { x: 400, reverse: false, gap: false, label: "blank space inside a paragraph" },
  { x: 650, reverse: false, gap: false, label: "the right margin without crossing back over text" },
  { x: 80, reverse: false, gap: false, label: "the left margin without crossing over text" },
  { x: 400, reverse: true, gap: false, label: "blank space dragged upwards" },
  { x: 400, reverse: false, gap: true, label: "a gap between paragraphs at a block boundary" },
])("selects rows from $label and keeps the grabber hidden until release", async ({ x, reverse, gap }) => {
  const f = await open(); f.editor.commands.setTextSelection(f.start(1) + 2);
  vi.spyOn(f.panel, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 700, 600));
  for (let i = 0; i < 4; i++) {
    const el = f.editor.view.nodeDOM(f.start(i)); if (!(el instanceof HTMLElement)) throw new Error("missing row DOM");
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 50 + i * 100, 500, 40));
  }
  const createRange = document.createRange.bind(document);
  vi.spyOn(document, "createRange").mockImplementation(() => {
    const range = createRange();
    // why: jsdom has no glyph geometry; the real-browser regression supplies that boundary.
    Object.defineProperty(range, "getClientRects", { value: () => [new DOMRect(100, 150, 55, 40), new DOMRect(100, 250, 45, 40)] });
    return range;
  });
  vi.spyOn(f.editor.view, "posAtCoords").mockImplementation(coords => ({ pos: f.start(coords.top < 200 ? 1 : 2) + (gap || coords.left < 100 ? 0 : 1), inside: -1 }));
  const startY = gap ? 145 : reverse ? 280 : 160; const endY = reverse ? 160 : 280;
  const row = f.editor.view.dom.querySelectorAll("p")[reverse ? 1 : 0]; if (!row) throw new Error("missing paragraph");
  (gap ? f.editor.view.dom : row).dispatchEvent(pointer("pointerdown", x, startY));
  document.dispatchEvent(pointer("pointermove", x + 2, endY));
  await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
  expect(document.querySelectorAll(".block-selection-highlight")).toHaveLength(2);
  expect(f.group.hidden).toBe(true);
  document.dispatchEvent(pointer("pointerup", x + 2, endY));
  expect(document.querySelector(".block-selection-marquee")).toBeNull();
  expect(f.group.hidden).toBe(false);
  expect(f.control("Move 2 blocks")).toBeDefined();
  expect(await f.saved()).toBe("# Title\n\nAlpha\n\nBeta\n\nGamma\n");
});

it("does not intercept a drag on rendered text inside a paragraph", async () => {
  const f = await open();
  const row = f.editor.view.dom.querySelector("p"); if (!row) throw new Error("missing paragraph");
  vi.spyOn(row, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 150, 500, 40));
  vi.spyOn(f.editor.view, "posAtCoords").mockReturnValue({ pos: f.start(1) + 2, inside: -1 });
  const createRange = document.createRange.bind(document);
  vi.spyOn(document, "createRange").mockImplementation(() => {
    const range = createRange();
    Object.defineProperty(range, "getClientRects", { value: () => [new DOMRect(100, 150, 55, 40)] });
    return range;
  });
  const down = pointer("pointerdown", 120, 170); row.dispatchEvent(down);
  document.dispatchEvent(pointer("pointermove", 150, 180));
  expect(down.defaultPrevented).toBe(false);
  expect(document.querySelector(".block-selection-marquee")).toBeNull();
  expect(f.editor.view.dom.classList.contains("has-block-selection")).toBe(false);
});

it("hides the grabber for native text highlighting and restores it for a collapsed caret", async () => {
  const f = await open();
  f.editor.commands.setTextSelection({ from: f.start(1) + 1, to: f.start(1) + 4 });
  f.handles.refresh();
  await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
  expect(f.group.hidden).toBe(true);
  // Keyboard access to movement remains available while the floating grabber is hidden.
  expect(f.handles.focus()).toBe(true);
  expect(f.menu.hidden).toBe(false);
  f.menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  f.editor.commands.setTextSelection(f.start(1) + 2);
  f.handles.refresh();
  await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
  expect(f.group.hidden).toBe(false);
});
it("keeps selected rows visible above the bottom-pinned mobile toolbar", async () => {
  const f = await open(); f.editor.commands.setTextSelection(f.start(1) + 2);
  vi.spyOn(f.panel, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 700, 600));
  for (let i = 0; i < 4; i++) {
    const el = f.editor.view.nodeDOM(f.start(i)); if (!(el instanceof HTMLElement)) throw new Error("missing root DOM");
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 50 + i * 100, 500, 40));
  }
  const controls = document.createElement("div"); controls.className = "editor-controls"; f.panel.append(controls);
  vi.spyOn(controls, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 550, 700, 50));
  key(f, "Escape"); key(f, "ArrowDown", true);
  expect(document.querySelectorAll(".block-selection-highlight")).toHaveLength(2);
  expect(document.querySelector<HTMLElement>(".block-selection-layer")?.style.top).toBe("0px");
  expect(document.querySelector<HTMLElement>(".block-selection-layer")?.style.height).toBe("550px");
});
