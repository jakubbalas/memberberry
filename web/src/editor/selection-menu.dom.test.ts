// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { Editor } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { applyUpdate, Doc, encodeStateAsUpdate } from "yjs";
import { undo } from "y-prosemirror";
import { Awareness } from "y-protocols/awareness";
import { load, schema, updateFromMarkdown } from "../notes.js";
import { createConnectionStatus, createYjsBinding, PROSEMIRROR_ROOT } from "./collaboration.js";
import { mountEditorShell, type MountEditorShellOptions } from "./editor-shell.js";
import { protectedTitleExtension } from "./note-editor.js";
import { createMemberberryExtensions } from "./schema.js";
import { tableRowHandles } from "./table-tools.js";
import { editorMarkdown } from "./source.js";
import { mountSelectionMenu, SINGLE_EDITOR_WARNING } from "./selection-menu.js";

const cleanups: (() => void)[] = [];
beforeAll(async () => { await load(readFileSync("src/wasm/mb_bg.wasm")); });
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

type Routed = Pick<MountEditorShellOptions, "noteKey" | "awareness" | "connection">;
async function open(markdown = "# Title\n\nFirst body\n\nLater words\n", routed: Routed = {}) {
  const panel = document.createElement("section");
  panel.className = "note-pane";
  const surface = document.createElement("div");
  const status = document.createElement("p");
  panel.append(surface, status);
  document.body.append(panel);
  const ydoc = new Doc();
  applyUpdate(ydoc, await updateFromMarkdown(markdown));
  const editor = new Editor({ element: surface, extensions: [
    ...createMemberberryExtensions(await schema()), tableRowHandles, protectedTitleExtension,
    createYjsBinding(ydoc.getXmlFragment(PROSEMIRROR_ROOT)),
  ] });
  const shell = mountEditorShell({ editor, document: ydoc, panel, status, ...routed });
  cleanups.push(() => { shell.destroy(); editor.destroy(); ydoc.destroy(); panel.remove(); });
  const select = (text: string) => {
    let from = -1;
    editor.state.doc.descendants((node, pos) => { if (node.isText && node.text?.includes(text)) from = pos + node.text.indexOf(text); });
    if (from < 0) throw new Error(`missing text ${text}`);
    editor.commands.setTextSelection({ from, to: from + text.length });
    return { from, to: from + text.length };
  };
  const menu = () => document.querySelector<HTMLElement>(".selection-menu");
  const control = (label: string) => {
    const found = menu()?.querySelector<HTMLButtonElement>(`[aria-label='${label}']`);
    expect(found, `${label} is reachable for selected body text`).toBeInstanceOf(HTMLButtonElement);
    if (!found) throw new Error(`missing ${label}`);
    return found;
  };
  return { panel, editor, ydoc, shell, select, menu, control };
}

it("clears selected marks without changing text and keeps insertion actions under More", async () => {
  const fixture = await open("# Title\n\n**Later** words\n");
  fixture.select("Later");
  fixture.control("Clear formatting").click();
  expect(await editorMarkdown(fixture.ydoc)).toBe("# Title\n\nLater words\n");
  expect(fixture.panel.querySelector(".editor-toolbar > [aria-label='Insert task block']")).toBeNull();
  expect(fixture.panel.querySelector(".editor-more [aria-label='Insert task block']")).not.toBeNull();
  expect(fixture.panel.querySelector(".editor-toolbar [aria-label='Toggle Markdown source view']")).not.toBeNull();
});

it("shows formatting only for body text and Strong survives canonical WASM/Yjs reopen", async () => {
  const fixture = await open();
  expect(fixture.menu()?.hidden ?? true).toBe(true);
  fixture.select("Later");
  expect(fixture.menu()?.hidden, "selected text shows contextual formatting").toBe(false);
  const strong = fixture.control("Bold");
  strong.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
  strong.click();
  const saved = await editorMarkdown(fixture.ydoc);
  expect(saved).toBe("# Title\n\nFirst body\n\n**Later** words\n");
  expect(fixture.editor.state.selection.empty).toBe(false);
  expect(fixture.control("Bold").getAttribute("aria-pressed")).toBe("true");
  const reopened = await open(saved);
  expect(reopened.editor.view.dom.querySelector("strong")?.textContent).toBe("Later");
});

it("captures a pending native keyboard selection before Alt-F10 focus, supports roving keys and Escape", async () => {
  const f = await open();
  f.select("First");
  const paragraph = f.editor.view.dom.querySelectorAll("p")[1];
  const text = paragraph?.firstChild;
  if (!text) throw new Error("missing later paragraph");
  // jsdom activation seam: real browser Alt-F10/Enter is independently exercised in E2E.
  document.getSelection()?.setBaseAndExtent(text, 0, text, 5);
  f.editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", altKey: true, bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(f.control("Bold"));
  f.control("Bold").dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(f.control("Clear formatting"));
  f.control("Clear formatting").dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
  f.control("Bold").click();
  expect(await editorMarkdown(f.ydoc)).toContain("**Later** words");
  f.editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  expect(f.menu()?.hidden).toBe(true);
  expect(f.editor.view.hasFocus()).toBe(true);
  expect(f.editor.state.doc.textBetween(f.editor.state.selection.from, f.editor.state.selection.to)).toBe("Later");
});

it("closes while source is opening and while the body is waiting", async () => {
  const f = await open();
  f.select("Later");
  const source = f.panel.querySelector<HTMLButtonElement>("[aria-label='Toggle Markdown source view']");
  source?.click();
  expect(f.menu()?.hidden, "source entry closes synchronously before the WASM await").toBe(true);
  const g = await open();
  g.panel.dataset["body"] = "waiting";
  g.select("Later");
  expect(g.menu()?.hidden, "unavailable body has no formatter").toBe(true);
});

it("disposes its portal on editor destruction and ignores retained controls after shell teardown", async () => {
  const f = await open();
  f.select("Later");
  const button = f.control("Bold");
  const before = await editorMarkdown(f.ydoc);
  f.shell.destroy();
  f.shell.destroy();
  button.click();
  expect(await editorMarkdown(f.ydoc)).toBe(before);
  expect(f.menu()).toBeNull();
  const g = await open();
  g.editor.destroy();
  expect(g.menu()).toBeNull();
});

it("hides on collapse, outside focus, title intersections, read-only and composition", async () => {
  const f = await open();
  const range = f.select("Later");
  f.editor.commands.setTextSelection(range.from);
  expect(f.menu()?.hidden).toBe(true);
  f.select("Later");
  const outside = document.createElement("button");
  document.body.append(outside);
  outside.focus();
  expect(f.menu()?.hidden).toBe(true);
  outside.remove();
  f.select("Title");
  expect(f.menu()?.hidden).toBe(true);
  f.editor.commands.setTextSelection({ from: 3, to: range.to });
  expect(f.menu()?.hidden).toBe(true);
  f.select("Later");
  f.editor.setEditable(false);
  expect(f.menu()?.hidden).toBe(true);
  f.editor.setEditable(true);
  f.select("Later");
  f.editor.view.dom.dispatchEvent(new Event("compositionstart", { bubbles: true }));
  expect(f.menu()?.hidden).toBe(true);
  f.editor.view.dom.dispatchEvent(new Event("compositionend", { bubbles: true }));
});

it("does not revive a mapped capture through refresh, focus, popup pointer or a retained form", async () => {
  const f = await open();
  f.shell.destroy();
  const controller = mountSelectionMenu({ editor: f.editor, panel: f.panel });
  cleanups.push(() => controller.destroy());
  f.select("Later");
  const bold = f.control("Bold");
  f.control("Link").click();
  const form = f.menu()?.querySelector("form");
  const input = form?.querySelector("input");
  if (!form || !input) throw new Error("link workflow missing");
  f.editor.view.dispatch(f.editor.state.tr.insertText("fresh ", (f.editor.state.doc.firstChild?.nodeSize ?? 0) + 1));
  const before = await editorMarkdown(f.ydoc);
  // selectionSet is not evidence of human intent, including plugin/remote appenders.
  f.editor.view.dispatch(f.editor.state.tr.setSelection(f.editor.state.selection));
  for (let i = 0; i < 3; i++) controller.refresh();
  bold.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
  expect(controller.focus()).toBe(false);
  bold.click();
  input.value = "https://example.com";
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  f.panel.dataset["body"] = "waiting";
  await Promise.resolve();
  f.panel.dataset["body"] = "ready";
  await Promise.resolve();
  window.dispatchEvent(new Event("resize"));
  controller.refresh();
  expect(f.menu()?.hidden).toBe(true);
  expect(await editorMarkdown(f.ydoc)).toBe(before);
});

it("invalidates an open capture on document change instead of formatting stale offsets", async () => {
  const f = await open();
  f.select("Later");
  const button = f.control("Bold");
  f.editor.commands.insertContentAt(8, "fresh ");
  expect(f.menu()?.hidden).toBe(true);
  button.click();
  expect(await editorMarkdown(f.ydoc)).not.toContain("**");
});

it("invalidates document edits appended to a selection-only transaction", async () => {
  const f = await open();
  f.select("Later");
  const bold = f.control("Bold");
  f.editor.registerPlugin(new Plugin({
    appendTransaction(transactions, _before, state) {
      if (transactions.some((transaction) => transaction.getMeta("repair-appended-edit"))) {
        return state.tr.insertText("fresh ", (state.doc.firstChild?.nodeSize ?? 0) + 1);
      }
      return null;
    },
  }));
  f.editor.view.dispatch(f.editor.state.tr.setSelection(f.editor.state.selection).setMeta("repair-appended-edit", true));
  const before = await editorMarkdown(f.ydoc);
  bold.click();
  expect(await editorMarkdown(f.ydoc)).toBe(before);
  expect(f.menu()?.hidden).toBe(true);
});

it("remote Yjs updates invalidate the link workflow and cannot mint a mapped action capture", async () => {
  const f = await open();
  f.shell.destroy();
  const controller = mountSelectionMenu({ editor: f.editor, panel: f.panel });
  cleanups.push(() => controller.destroy());
  const remote = new Doc();
  applyUpdate(remote, encodeStateAsUpdate(f.ydoc));
  const surface = document.createElement("div");
  document.body.append(surface);
  const peer = new Editor({ element: surface, extensions: [...createMemberberryExtensions(await schema()), tableRowHandles, createYjsBinding(remote.getXmlFragment(PROSEMIRROR_ROOT))] });
  cleanups.push(() => { peer.destroy(); remote.destroy(); surface.remove(); });
  const updates: Uint8Array[] = [];
  remote.on("update", (update: Uint8Array) => { updates.push(update); });
  f.select("Later");
  f.control("Link").click();
  const input = f.menu()?.querySelector("input");
  const form = f.menu()?.querySelector("form");
  if (!input || !form) throw new Error("link workflow missing");
  peer.view.dispatch(peer.state.tr.insertText("remote ", (peer.state.doc.firstChild?.nodeSize ?? 0) + 1));
  expect(updates.length).toBeGreaterThan(0);
  for (const update of updates) applyUpdate(f.ydoc, update, "repair-peer");
  expect(await editorMarkdown(f.ydoc)).toBe("# Title\n\nremote First body\n\nLater words\n");
  controller.refresh();
  expect(controller.focus()).toBe(false);
  input.value = "https://example.com";
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  expect(f.menu()?.hidden).toBe(true);
  expect(await editorMarkdown(f.ydoc)).toBe(await editorMarkdown(remote));
});

it("requires explicit selection intent after invalidation, not arbitrary selectionSet", async () => {
  const f = await open();
  f.shell.destroy();
  const controller = mountSelectionMenu({ editor: f.editor, panel: f.panel });
  cleanups.push(() => controller.destroy());
  f.select("Later");
  f.editor.view.dispatch(f.editor.state.tr.insertText("fresh ", (f.editor.state.doc.firstChild?.nodeSize ?? 0) + 1));
  const range = f.select("First");
  controller.refresh();
  expect(f.menu()?.hidden).toBe(true);
  // Deliberate API intent is distinct from PM plugin selectionSet and refresh/focus.
  expect(controller.select({ from: range.from, to: range.to })).toBe(true);
  expect(controller.focus()).toBe(true);
  f.control("Bold").click();
  expect(await editorMarkdown(f.ydoc)).toBe("# Title\n\nfresh **First** body\n\nLater words\n");
  expect(f.control("Bold").getAttribute("aria-pressed")).toBe("true");
});

it.each([
  ["Italic", "*Later*"], ["Strikethrough", "~~Later~~"],
  ["Highlight", "==Later=="], ["Inline code", "`Later`"],
])("%s formats only selected plain body text and exposes active state", async (label, formatted) => {
  const f = await open();
  f.select("Later");
  f.control(label).click();
  expect(await editorMarkdown(f.ydoc)).toBe(`# Title\n\nFirst body\n\n${formatted} words\n`);
  expect(f.control(label).getAttribute("aria-pressed")).toBe("true");
  f.control(label).click();
  expect(await editorMarkdown(f.ydoc)).toBe("# Title\n\nFirst body\n\nLater words\n");
});

it("keeps the captured range across link-editor focus, rejects unsafe URLs and writes safe Markdown links", async () => {
  const f = await open();
  f.select("Later");
  const opener = f.control("Link");
  opener.focus();
  opener.click();
  expect(f.menu()?.hidden).toBe(false);
  const input = f.menu()?.querySelector<HTMLInputElement>("[aria-label='Link destination']");
  expect(input).toBeInstanceOf(HTMLInputElement);
  if (!input) throw new Error("missing link input");
  input.focus();
  input.value = "javascript:alert(1)";
  f.control("Apply link").click();
  expect(await editorMarkdown(f.ydoc)).toBe("# Title\n\nFirst body\n\nLater words\n");
  expect(f.menu()?.textContent).toContain("Enter a safe");
  input.value = "https://example.com/path";
  f.control("Apply link").click();
  expect(await editorMarkdown(f.ydoc)).toBe("# Title\n\nFirst body\n\n[Later](https://example.com/path) words\n");
  expect(f.editor.view.hasFocus()).toBe(true);
  f.control("Link").click();
  f.control("Remove link").click();
  expect(await editorMarkdown(f.ydoc)).toBe("# Title\n\nFirst body\n\nLater words\n");
});

it("coalesces geometry, flips/clamps to pane and visual viewport, and releases reflow observers and frames", async () => {
  const f = await open();
  f.shell.destroy();
  const callbacks = new Map<number, FrameRequestCallback>();
  let next = 0;
  const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callbacks.set(++next, callback); return next; });
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { callbacks.delete(id); });
  const viewport = Object.assign(new EventTarget(), { offsetLeft: 180, offsetTop: 120, width: 380, height: 220 });
  const descriptor = Object.getOwnPropertyDescriptor(window, "visualViewport");
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  let reflow: ResizeObserverCallback | undefined;
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { reflow = callback; }
    observe = observe;
    disconnect = disconnect;
    unobserve = vi.fn();
  });
  const paneRect = vi.spyOn(f.panel, "getBoundingClientRect").mockReturnValue(new DOMRect(200, 80, 400, 520));
  const coords = vi.spyOn(f.editor.view, "coordsAtPos").mockReturnValue({ left: 202, right: 210, top: 130, bottom: 150 });
  const controller = mountSelectionMenu({ editor: f.editor, panel: f.panel });
  cleanups.push(() => {
    controller.destroy(); raf.mockRestore(); cancel.mockRestore(); paneRect.mockRestore(); coords.mockRestore();
    vi.unstubAllGlobals();
    if (descriptor) Object.defineProperty(window, "visualViewport", descriptor);
    else Reflect.deleteProperty(window, "visualViewport");
  });
  f.select("Later");
  const popup = f.menu();
  if (!popup) throw new Error("missing popup");
  vi.spyOn(popup, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 320, 60));
  for (let i = 0; i < 10; i++) {
    window.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
    f.panel.dispatchEvent(new Event("scroll"));
  }
  expect(callbacks.size).toBe(1);
  const flush = () => { const entries = [...callbacks]; callbacks.clear(); for (const [, callback] of entries) callback(0); };
  flush();
  expect(coords).toHaveBeenCalledTimes(2);
  expect(popup.style.left).toBe("208px");
  expect(popup.style.top).toBe("158px");
  expect(observe, "pane and popup reflow are observed without full-document geometry").toHaveBeenCalled();
  expect(reflow).toBeTypeOf("function");
  reflow?.([], {} as ResizeObserver);
  viewport.height = 140;
  viewport.dispatchEvent(new Event("resize"));
  expect(callbacks.size).toBe(1);
  flush();
  expect(Number.parseFloat(popup.style.top) + 60).toBeLessThanOrEqual(260);
  viewport.dispatchEvent(new Event("scroll"));
  expect(callbacks.size).toBe(1);
  controller.destroy(); controller.destroy();
  expect(callbacks.size).toBe(0);
  expect(disconnect).toHaveBeenCalledTimes(1);
  expect(document.querySelector(".selection-menu")).toBeNull();
  const calls = raf.mock.calls.length;
  viewport.dispatchEvent(new Event("resize"));
  window.dispatchEvent(new Event("resize"));
  f.select("First");
  expect(raf.mock.calls.length).toBe(calls);
});

it("withdraws an already-open menu when its body readiness changes without an editor transaction", async () => {
  const f = await open();
  f.select("Later");
  f.panel.dataset["body"] = "waiting";
  await Promise.resolve();
  expect(f.menu()?.hidden).toBe(true);
});

it("restores a pending native range even when Clear changes no marks", async () => {
  const f = await open();
  f.select("First");
  const text = f.editor.view.dom.querySelectorAll("p")[1]?.firstChild;
  if (!text) throw new Error("missing later paragraph");
  document.getSelection()?.setBaseAndExtent(text, 0, text, 5);
  f.editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", altKey: true, bubbles: true, cancelable: true }));
  f.control("Clear formatting").click();
  expect(f.editor.state.doc.textBetween(f.editor.state.selection.from, f.editor.state.selection.to)).toBe("Later");
  expect(await editorMarkdown(f.ydoc)).toBe("# Title\n\nFirst body\n\nLater words\n");
});

// Chrome delivers selectionchange as a later task. Focus leaving the editor first dispatches
// Tiptap's blur transaction, so the menu refreshes before ProseMirror reads the native range.
function extendNativeBeforeBlur(f: Awaited<ReturnType<typeof open>>, model: { readonly from: number; readonly to: number }): void {
  f.editor.commands.setTextSelection(model);
  const text = f.editor.view.dom.querySelectorAll("p")[1]?.firstChild;
  if (!text) throw new Error("missing later paragraph");
  document.getSelection()?.setBaseAndExtent(text, 0, text, "Later words".length);
  f.editor.view.dispatch(f.editor.state.tr.setMeta("blur", { event: new FocusEvent("blur") }));
}

it("formats the visible native range when a blur refresh runs before the lagging model catches up", async () => {
  const f = await open();
  const { from, to } = f.select("Later words");
  extendNativeBeforeBlur(f, { from, to: to - 1 });
  f.control("Underline").click();
  expect(await editorMarkdown(f.ydoc)).toBe("# Title\n\nFirst body\n\n:mb-style[Later words]{underline=\"true\"}\n");
});

it("keeps the menu for a visible native range when the lagging model is still collapsed", async () => {
  const f = await open();
  const { from } = f.select("Later words");
  extendNativeBeforeBlur(f, { from, to: from });
  expect(f.menu()?.hidden).toBe(false);
});

function synced() {
  const connection = createConnectionStatus();
  connection.set({ connected: true, synced: true, pending: 0 });
  return connection;
}
function turnInto(f: Awaited<ReturnType<typeof open>>): HTMLSelectElement {
  const found = f.menu()?.querySelector<HTMLSelectElement>("select[aria-label='Turn into']");
  if (!found) throw new Error("missing Turn into");
  return found;
}
function choose(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event("change"));
}

it("turns the selected paragraph into a heading through the popup and undoes it in one step", async () => {
  const f = await open(undefined, { noteKey: "turn-into", connection: synced() });
  f.select("Later");
  choose(turnInto(f), "h2");
  expect(await editorMarkdown(f.ydoc)).toBe("# Title\n\nFirst body\n\n## Later words\n");
  expect(turnInto(f).value).toBe("h2");
  expect(undo(f.editor.state)).toBe(true);
  expect(await editorMarkdown(f.ydoc)).toBe("# Title\n\nFirst body\n\nLater words\n");
});

it("lists the single-editor warning with the block choices it governs", async () => {
  const f = await open(undefined, { noteKey: "warning", connection: synced() });
  f.select("Later");
  expect(turnInto(f).querySelector("optgroup")?.label).toBe(SINGLE_EDITOR_WARNING);
});

it("offers no block conversion in a local-only editor without a routed note identity", async () => {
  const f = await open();
  f.select("Later");
  expect(f.menu()?.querySelector("select[aria-label='Turn into']")).toBeNull();
});

it("shows why conversion is refused while a known peer is present and writes nothing", async () => {
  const peerDoc = new Doc();
  const awareness = new Awareness(peerDoc);
  cleanups.push(() => { awareness.destroy(); peerDoc.destroy(); });
  const f = await open(undefined, { noteKey: "peer", connection: synced(), awareness });
  f.select("Later");
  awareness.states.set(4242, { user: { name: "peer" } });
  awareness.emit("change", [{ added: [4242], updated: [], removed: [] }, "test"]);
  const control = turnInto(f);
  expect(control.disabled).toBe(true);
  expect(control.selectedOptions[0]?.textContent).toBe("Text · Someone else has this note open");
  choose(control, "h2");
  expect(await editorMarkdown(f.ydoc)).toBe("# Title\n\nFirst body\n\nLater words\n");
});

it("refuses conversion while offline or with unsent writes, and re-enables once synced", async () => {
  const connection = synced();
  const f = await open(undefined, { noteKey: "transport", connection });
  f.select("Later");
  connection.set({ connected: true, synced: true, pending: 1 });
  expect(turnInto(f).disabled).toBe(true);
  choose(turnInto(f), "h3");
  connection.set({ connected: false, synced: false, pending: 0 });
  expect(turnInto(f).disabled).toBe(true);
  expect(await editorMarkdown(f.ydoc)).toBe("# Title\n\nFirst body\n\nLater words\n");
  connection.set({ connected: true, synced: true, pending: 0 });
  expect(turnInto(f).disabled).toBe(false);
});

it("refuses conversion while a second editor has the same note mounted", async () => {
  const f = await open(undefined, { noteKey: "same-note", connection: synced() });
  const g = await open(undefined, { noteKey: "same-note", connection: synced() });
  f.select("Later");
  expect(turnInto(f).disabled).toBe(true);
  g.shell.destroy();
  expect(turnInto(f).disabled).toBe(false);
});

it("hides block conversion for text nested in a list rather than flattening it", async () => {
  const f = await open("# Title\n\n- Later words\n", { noteKey: "nested", connection: synced() });
  f.select("Later");
  expect(f.menu()?.hidden).toBe(false);
  expect(turnInto(f).hidden).toBe(true);
});

it("closes the More menu after inserting a block so it does not cover the new content", async () => {
  const f = await open();
  const more = f.panel.querySelector<HTMLDetailsElement>(".editor-more");
  if (!more) throw new Error("missing More");
  more.open = true;
  f.panel.querySelector<HTMLButtonElement>(".editor-more [aria-label='Insert table block']")?.click();
  expect(more.open).toBe(false);
});

it("keeps the More menu open after Move so a block can be moved repeatedly", async () => {
  const f = await open();
  f.select("Later");
  const more = f.panel.querySelector<HTMLDetailsElement>(".editor-more");
  if (!more) throw new Error("missing More");
  more.open = true;
  f.panel.querySelector<HTMLButtonElement>(".editor-more [aria-label='Insert move up block']")?.click();
  expect(more.open).toBe(true);
});

function styleChoice(f: Awaited<ReturnType<typeof open>>, label: string): HTMLButtonElement {
  const found = f.menu()?.querySelector<HTMLButtonElement>(`.selection-style-panel [aria-label='${label}']`);
  if (!found) throw new Error(`missing ${label}`);
  return found;
}

it("applies colour, background and size in one visit to the style panel", async () => {
  const f = await open();
  f.select("Later words");
  f.control("Text color, background and size").click();
  for (const label of ["Red text", "Yellow background", "Large text size"]) styleChoice(f, label).click();
  expect(await editorMarkdown(f.ydoc)).toBe("# Title\n\nFirst body\n\n:mb-style[Later words]{color=\"red\" background=\"yellow\" size=\"large\"}\n");
});

it("does not disable the style choices when a write turns pending mid-apply", async () => {
  const connection = synced();
  const f = await open(undefined, { noteKey: "pending-mid-apply", connection });
  // Like the sync provider: the local write becomes pending during the editor dispatch.
  f.editor.on("transaction", ({ transaction }) => {
    if (transaction.docChanged) connection.set({ connected: true, synced: true, pending: 1 });
  });
  f.select("Later words");
  f.control("Text color, background and size").click();
  const red = styleChoice(f, "Red text");
  const seen: boolean[] = [];
  connection.subscribe(() => { seen.push(red.disabled); });
  red.click();
  expect(seen).not.toContain(true);
});
