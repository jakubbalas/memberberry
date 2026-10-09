// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { Editor } from "@tiptap/core";
import { afterEach, beforeAll, expect, it } from "vitest";
import { applyUpdate, Doc } from "yjs";
import { load, schema, updateFromMarkdown } from "../notes.js";
import { createYjsBinding, PROSEMIRROR_ROOT } from "./collaboration.js";
import { createMemberberryExtensions } from "./schema.js";
import { editorMarkdown } from "./source.js";
import { calloutFold } from "./callout-fold.js";

const cleanups: (() => void)[] = [];
beforeAll(async () => { await load(readFileSync("src/wasm/mb_bg.wasm")); });
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

async function open(markdown: string, editable = true) {
  const ydoc = new Doc();
  applyUpdate(ydoc, await updateFromMarkdown(markdown));
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({ element, editable, extensions: [
    ...createMemberberryExtensions(await schema()), calloutFold,
    createYjsBinding(ydoc.getXmlFragment(PROSEMIRROR_ROOT)),
  ] });
  cleanups.push(() => { editor.destroy(); ydoc.destroy(); element.remove(); });
  const toggle = (index = 0) => editor.view.dom.querySelectorAll<HTMLButtonElement>("button.mb-fold-toggle")[index];
  const folded = (index = 0) => editor.view.dom.querySelectorAll("aside[data-callout]")[index]?.classList.contains("mb-folded");
  return { editor, ydoc, toggle, folded };
}

const TOGGLE = "# Title\n\n> [!note]+ Meeting notes\n> Ship on Friday\n";

it("gives a foldable callout a disclosure button and leaves a plain callout alone", async () => {
  const f = await open(`${TOGGLE}\n> [!note]\n> Plain\n`);
  expect([f.toggle(0)?.getAttribute("aria-expanded"), f.toggle(1)]).toEqual(["true", undefined]);
});

it("folds the reader's view without writing to the note", async () => {
  const f = await open(TOGGLE);
  const before = await editorMarkdown(f.ydoc);
  f.toggle()?.click();
  expect([f.folded(), f.toggle()?.getAttribute("aria-expanded")]).toEqual([true, "false"]);
  expect(await editorMarkdown(f.ydoc)).toBe(before);
});

it("opens collapsed when the file says so, and expands on request", async () => {
  const f = await open("# Title\n\n> [!note]- Hidden\n> Body\n");
  const initially = f.folded();
  f.toggle()?.click();
  expect([initially, f.folded()]).toEqual([true, false]);
});

it("folds and unfolds from the keyboard with Mod-Enter inside the toggle", async () => {
  const f = await open(TOGGLE);
  let title = -1;
  f.editor.state.doc.descendants((node, pos) => { if (node.type.name === "callout_title") title = pos + 1; });
  f.editor.commands.setTextSelection(title + 2);
  // why: a real keydown. Tiptap's keyboardShortcut command replays only the steps of what a
  // handler dispatches, and folding is a step-free, metadata-only transaction.
  const press = () => f.editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
  press();
  const afterFold = f.folded();
  press();
  expect([afterFold, f.folded()]).toEqual([true, false]);
});

it("moves a caret out of the body it is about to hide, onto the summary", async () => {
  const f = await open(TOGGLE);
  let body = -1;
  f.editor.state.doc.descendants((node, pos) => { if (node.isText && node.text === "Ship on Friday") body = pos + 2; });
  f.editor.commands.setTextSelection(body);
  f.toggle()?.click();
  expect(f.editor.state.selection.$head.parent.type.name).toBe("callout_title");
});

it("keeps a folded toggle folded while text above it changes", async () => {
  const f = await open(`# Title\n\nAbove\n\n${TOGGLE.slice("# Title\n\n".length)}`);
  f.toggle()?.click();
  f.editor.commands.insertContentAt(8, "more ");
  expect(f.folded()).toBe(true);
});

it("folds in a read-only editor too, since folding is not an edit", async () => {
  const f = await open(TOGGLE, false);
  f.toggle()?.click();
  expect(f.folded()).toBe(true);
});

it("keeps the summary's text exactly what the file says; the arrow is drawn, not written", async () => {
  const f = await open(TOGGLE);
  expect([f.editor.view.dom.querySelector("[data-callout-title]")?.textContent, f.toggle()?.textContent]).toEqual(["Meeting notes", ""]);
});
