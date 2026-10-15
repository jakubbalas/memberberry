// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { Editor } from "@tiptap/core";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import fc from "fast-check";
import { applyUpdate, Doc } from "yjs";
import { undo, redo } from "y-prosemirror";
import { load, schema, updateFromMarkdown } from "../notes.js";
import { createYjsBinding, PROSEMIRROR_ROOT } from "./collaboration.js";
import { createMemberberryExtensions } from "./schema.js";
import { protectedTitleExtension } from "./note-editor.js";
import { editorMarkdown } from "./source.js";
import { createSingleEditorGate } from "./single-editor.js";
import { mountBlockCatalog } from "./block-catalog.js";
import { mountEmojiPicker } from "./emoji-picker.js";

const cleanups: (() => void)[] = [];
beforeAll(async () => { await load(readFileSync("src/wasm/mb_bg.wasm")); });
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
async function fixture() {
  const documentModel = new Doc(); applyUpdate(documentModel, await updateFromMarkdown("# Title\n\nBefore\n\nAfter\n"));
  const host = document.createElement("div"); const surface = document.createElement("div"); const status = document.createElement("p");
  document.body.append(host, surface, status);
  const editor = new Editor({ element: surface, extensions: [...createMemberberryExtensions(await schema()), protectedTitleExtension, createYjsBinding(documentModel.getXmlFragment(PROSEMIRROR_ROOT))] });
  const gate = createSingleEditorGate({ editor, document: documentModel, noteKey: `catalogue-${documentModel.clientID}` });
  const image = vi.fn(); const emoji = vi.fn(); let ready = true;
  const draftChanged = vi.fn();
  const catalog = mountBlockCatalog({ editor, host, status, gate, image, emoji, canInteract: () => ready, onDraftStateChange: draftChanged });
  const menu = host.nextElementSibling;
  if (!(menu instanceof HTMLElement)) throw new Error("missing catalogue");
  const click = (label: string): void => {
    const button = [...menu.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === label);
    if (!button) throw new Error(`missing ${label}`);
    button.click();
  };
  const input = (label: string, value: string): void => {
    const field = menu.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    if (!field) throw new Error(`missing ${label}`);
    field.value = value; field.dispatchEvent(new Event("input", { bubbles: true }));
  };
  cleanups.push(() => { catalog.destroy(); gate.destroy(); editor.destroy(); documentModel.destroy(); host.remove(); surface.remove(); status.remove(); });
  const beforeStart = editor.state.doc.child(0).nodeSize;
  return { editor, documentModel, catalog, menu, status, click, input, image, emoji, beforeStart, draftChanged,
    ready: (value: boolean) => { ready = value; },
    saved: () => editorMarkdown(documentModel),
    submit: () => menu.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })) };
}

it.each([
  ["Text", "paragraph"], ["Heading 1", "heading"], ["Heading 2", "heading"], ["Heading 3", "heading"], ["Heading 4", "heading"],
  ["Bulleted list", "bullet_list"], ["Numbered list", "ordered_list"], ["To-do list", "bullet_list"], ["Toggle list", "callout"],
  ["Callout", "callout"], ["Quote", "blockquote"], ["Divider", "divider"], ["Table", "table"],
])("inserts %s below the captured root without changing surrounding content", async (label, type) => {
  const f = await fixture(); f.catalog.show(f.beforeStart); f.click(label);
  expect(f.editor.state.doc.child(2).type.name).toBe(type);
  expect([f.editor.state.doc.child(0).textContent, f.editor.state.doc.child(1).textContent, f.editor.state.doc.lastChild?.textContent]).toEqual(["Title", "Before", "After"]);
  const saved = await f.saved();
  const reopened = new Doc(); applyUpdate(reopened, await updateFromMarkdown(saved));
  expect(await editorMarkdown(reopened)).toBe(saved); reopened.destroy();
});

it("insertion preserves arbitrary surrounding Unicode and Markdown punctuation (seed 20261014)", async () => {
  const text = fc.array(fc.constantFrom("a", "é", "🫐", "مرحبا", " ", "*", "[", "]", "$", "`"), { minLength: 1, maxLength: 40 }).map(parts => parts.join(""));
  await fc.assert(fc.asyncProperty(text, fc.constantFrom("Heading 2", "Quote", "Toggle list", "Divider"), async (value, label) => {
    const f = await fixture();
    f.editor.commands.insertContentAt({ from: f.beforeStart + 1, to: f.beforeStart + 7 }, { type: "text", text: value });
    const before = f.editor.state.doc;
    f.catalog.show(f.beforeStart); f.click(label);
    expect([f.editor.state.doc.child(0).toJSON(), f.editor.state.doc.child(1).toJSON(), f.editor.state.doc.child(3).toJSON()])
      .toEqual([before.child(0).toJSON(), before.child(1).toJSON(), before.child(2).toJSON()]);
  }), { seed: 20261014, numRuns: 30 });
});

it.each([["Code", "Language", "typescript", "```typescript"], ["Block equation", "Equation", "x^2", "$$\nx^2\n$$"], ["Inline equation", "Equation", "α+β", "$α+β$"], ["Date", "Date", "2026-12-24", "2026-12-24"]])("persists %s in canonical Markdown", async (label, field, value, markdown) => {
  const f = await fixture(); f.catalog.show(f.beforeStart); f.click(label); f.input(field, value); f.submit();
  expect(await f.saved()).toContain(markdown);
});

it("stores Unicode web bookmarks as ordinary links without fetching the URL", async () => {
  const f = await fixture(); const fetcher = vi.spyOn(globalThis, "fetch");
  try {
    f.catalog.show(f.beforeStart); f.click("Web bookmark"); f.input("URL", "https://example.com/a?q=1"); f.input("Link label", "دليل 🫐"); f.submit();
    expect(await f.saved()).toContain("[دليل 🫐](https://example.com/a?q=1)");
    expect(fetcher).not.toHaveBeenCalled();
  } finally { fetcher.mockRestore(); }
});

it.each(["javascript:alert(1)", "data:text/html,bad", "file:///etc/passwd", "https://user:secret@example.com", "not a URL"]) ("rejects unsafe or malformed bookmark %s", async url => {
  const f = await fixture(); const before = f.editor.state.doc;
  f.catalog.show(f.beforeStart); f.click("Web bookmark"); f.input("URL", url); f.submit();
  expect(f.editor.state.doc).toBe(before);
  expect(f.menu.hidden).toBe(false);
});

it.each(["", "2026-02-30"]) ("rejects invalid date %s", async date => {
  const f = await fixture(); const before = f.editor.state.doc;
  f.catalog.show(f.beforeStart); f.click("Date"); f.input("Date", date); f.submit();
  expect(f.editor.state.doc).toBe(before);
});

it("removes only the slash trigger and preserves surrounding text", async () => {
  const f = await fixture(); f.editor.commands.setTextSelection(f.beforeStart + 7);
  f.editor.commands.insertContent(" /date"); f.catalog.sync();
  f.click("Date"); f.catalog.sync(); f.input("Date", "2026-12-24"); f.submit();
  expect(await f.saved()).toBe("# Title\n\nBefore 2026-12-24\n\nAfter\n");
});

it("reopens a dismissed slash menu after editing back to the same query", async () => {
  const f = await fixture(); f.editor.commands.setTextSelection(f.beforeStart + 7);
  f.editor.commands.insertContent(" /date"); f.catalog.sync(); f.catalog.hide();
  f.editor.commands.deleteRange({ from: f.editor.state.selection.from - 1, to: f.editor.state.selection.from }); f.catalog.sync();
  f.editor.commands.insertContent("e"); f.catalog.sync();
  expect(f.menu.hidden).toBe(false);
});

it("refuses inline equation dollar delimiters", async () => {
  const f = await fixture(); const before = f.editor.state.doc;
  f.catalog.show(f.beforeStart); f.click("Inline equation"); f.input("Equation", "$x$"); f.submit();
  expect(f.editor.state.doc).toBe(before);
});

it("a bookmark insertion is one undoable change independent of later typing", async () => {
  const f = await fixture(); const before = await f.saved();
  f.catalog.show(f.beforeStart); f.click("Web bookmark"); f.input("URL", "https://example.com"); f.submit();
  const inserted = await f.saved();
  f.editor.commands.insertContent("later typing");
  expect(undo(f.editor.state)).toBe(true); expect(await f.saved()).toBe(inserted);
  expect(undo(f.editor.state)).toBe(true); expect(await f.saved()).toBe(before);
  expect(redo(f.editor.state)).toBe(true); expect(await f.saved()).toBe(inserted);
});

it("invalidates a draft when the document changes instead of inserting at stale positions", async () => {
  const f = await fixture(); f.catalog.show(f.beforeStart); f.click("Date"); f.input("Date", "2026-12-24");
  f.editor.commands.setTextSelection(f.beforeStart + 1); f.editor.commands.insertContent("Changed ");
  const before = await f.saved(); f.submit();
  expect(f.menu.hidden).toBe(true); expect(await f.saved()).toBe(before);
});

it.each(["readonly", "unavailable", "destroyed"]) ("refuses retained form submission when %s", async state => {
  const f = await fixture(); f.catalog.show(f.beforeStart); f.click("Date"); f.input("Date", "2026-12-24");
  const before = f.editor.state.doc;
  if (state === "readonly") f.editor.setEditable(false);
  else if (state === "destroyed") f.catalog.destroy();
  else f.ready(false);
  f.submit(); expect(f.editor.state.doc).toBe(before);
});

it("converts the hovered root rather than the unrelated caret and preserves its content", async () => {
  const f = await fixture(); f.catalog.show(f.beforeStart, true); f.click("Heading 2");
  expect(await f.saved()).toBe("# Title\n\n## Before\n\nAfter\n");
});

it("rechecks structural conversion readiness at invocation", async () => {
  const f = await fixture(); f.catalog.show(f.beforeStart, true); f.ready(false); f.click("Heading 2");
  expect(await f.saved()).toBe("# Title\n\nBefore\n\nAfter\n");
});

it("insertion from the title goes below it and preserves the title", async () => {
  const f = await fixture(); f.editor.commands.setTextSelection({ from: 1, to: 6 });
  f.catalog.show(); f.click("Heading 2");
  expect([f.editor.state.doc.child(0).textContent, f.editor.state.doc.child(1).type.name, f.editor.state.doc.child(2).textContent]).toEqual(["Title", "heading", "Before"]);
});

it("inserting a block with selected text preserves that text and inserts below its root", async () => {
  const f = await fixture(); f.editor.commands.setTextSelection({ from: f.beforeStart + 1, to: f.beforeStart + 4 });
  f.catalog.show(); f.click("Heading 3");
  expect([f.editor.state.doc.child(1).textContent, f.editor.state.doc.child(2).type.name, f.editor.state.doc.child(3).textContent]).toEqual(["Before", "heading", "After"]);
});

it("refuses conversions if another editor opens the same note while the menu is open", async () => {
  const f = await fixture(); f.catalog.show(f.beforeStart, true);
  const otherDocument = new Doc();
  const other = new Editor({ extensions: [...createMemberberryExtensions(await schema()), createYjsBinding(otherDocument.getXmlFragment(PROSEMIRROR_ROOT))] });
  const otherGate = createSingleEditorGate({ editor: other, document: otherDocument, noteKey: `catalogue-${f.documentModel.clientID}` });
  try { f.click("Heading 2"); expect(await f.saved()).toBe("# Title\n\nBefore\n\nAfter\n"); }
  finally { otherGate.destroy(); other.destroy(); otherDocument.destroy(); }
});

it("uses the existing note-link chooser trigger and existing image and emoji controls", async () => {
  const f = await fixture();
  f.catalog.show(f.beforeStart); f.click("Link to note"); expect(f.editor.getText()).toContain("[[");
  f.catalog.show(f.beforeStart); f.click("Image"); expect(f.image).toHaveBeenCalledOnce();
  f.catalog.show(f.beforeStart); f.click("Emoji"); expect(f.emoji).toHaveBeenCalledOnce();
});

it.each(["changed", "readonly"]) ("refuses a retained emoji choice when its destination is %s", async state => {
  const f = await fixture(); const toolbar = document.createElement("div"); document.body.append(toolbar);
  const picker = mountEmojiPicker(f.editor, toolbar, [{ shortcode: "tada", glyph: "🎉", category: "activities", custom: false }], undefined,
    () => f.editor.isEditable && !f.editor.isDestroyed);
  try {
    f.editor.commands.setTextSelection(f.beforeStart + 1);
    toolbar.querySelector<HTMLButtonElement>(".emoji-picker-toggle")?.click();
    if (state === "changed") f.editor.commands.insertContent("Changed "); else f.editor.setEditable(false);
    const before = await f.saved();
    toolbar.querySelector<HTMLButtonElement>('.emoji-picker-item[aria-label=":tada:"]')?.click();
    expect(await f.saved()).toBe(before);
  } finally { picker.destroy(); toolbar.remove(); }
});

it("supports search, keyboard activation, Escape dismissal and idempotent teardown", async () => {
  const f = await fixture(); f.catalog.show(f.beforeStart); f.input("Filter blocks", "date");
  expect([...f.menu.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual(["Date"]);
  const search = f.menu.querySelector("input");
  search?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  expect(document.activeElement?.textContent).toBe("Date");
  document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  expect(f.menu.querySelector("form")?.hidden).toBe(false);
  f.menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  f.catalog.sync(); expect(f.menu.hidden).toBe(true);
  f.catalog.destroy(); f.catalog.destroy(); expect(f.menu.isConnected).toBe(false);
  f.editor.commands.insertContent("after teardown"); expect(f.menu.isConnected).toBe(false);
});

it("notifies the host when a form draft opens and closes so Reload can recover", async () => {
  const f = await fixture(); f.catalog.show(f.beforeStart); f.click("Date");
  expect(f.catalog.hasOpenDraft()).toBe(true); expect(f.draftChanged).toHaveBeenCalledTimes(1);
  f.catalog.hide();
  expect(f.catalog.hasOpenDraft()).toBe(false); expect(f.draftChanged).toHaveBeenCalledTimes(2);
});
