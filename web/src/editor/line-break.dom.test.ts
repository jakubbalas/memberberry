// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { Editor } from "@tiptap/core";
import { afterEach, beforeAll, expect, it } from "vitest";
import { applyUpdate, Doc } from "yjs";
import { load, schema, updateFromMarkdown } from "../notes.js";
import { calloutFold } from "./callout-fold.js";
import { createYjsBinding, PROSEMIRROR_ROOT } from "./collaboration.js";
import { lineBreak } from "./line-break.js";
import { createMemberberryExtensions } from "./schema.js";
import { editorMarkdown } from "./source.js";

const cleanups: (() => void)[] = [];
beforeAll(async () => { await load(readFileSync("src/wasm/mb_bg.wasm")); });
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

async function open(source: string, editable = true) {
  const ydoc = new Doc();
  applyUpdate(ydoc, await updateFromMarkdown(source));
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({ element, editable, extensions: [
    ...createMemberberryExtensions(await schema()), calloutFold, lineBreak,
    createYjsBinding(ydoc.getXmlFragment(PROSEMIRROR_ROOT)),
  ] });
  cleanups.push(() => { editor.destroy(); ydoc.destroy(); element.remove(); });
  /** Places the caret after `offset` characters of the first text node equal to `text`. */
  const caretIn = (text: string, offset = text.length) => {
    let at = -1;
    editor.state.doc.descendants((node, pos) => { if (at < 0 && node.isText && node.text === text) at = pos + offset; });
    editor.commands.setTextSelection(at);
  };
  // why: a real keydown. Tiptap's keyboardShortcut command bypasses the keymap's priority order.
  const press = (init: KeyboardEventInit = { shiftKey: true }) => {
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }));
  };
  const markdown = () => editorMarkdown(ydoc);
  return { editor, caretIn, press, markdown };
}

/** Types plain text at the caret, as the user would after the break. */
function type(editor: Editor, text: string): void {
  editor.view.dispatch(editor.state.tr.insertText(text));
}

it("Shift-Enter keeps the next line in the same paragraph as a Markdown hard break", async () => {
  const f = await open("# Title\n\nFirst line\n");
  f.caretIn("First line");
  f.press();
  type(f.editor, "second line");
  expect(await f.markdown()).toBe("# Title\n\nFirst line\\\nsecond line\n");
});

it("splits text at the caret onto the next line without starting a new block", async () => {
  const f = await open("# Title\n\nleft right\n");
  f.caretIn("left right", "left ".length);
  f.press();
  expect(await f.markdown()).toBe("# Title\n\nleft\\\nright\n");
});

it("replaces a selection with the break", async () => {
  const f = await open("# Title\n\nkeep DROP keep\n");
  f.caretIn("keep DROP keep", "keep ".length);
  const from = f.editor.state.selection.from;
  f.editor.commands.setTextSelection({ from, to: from + "DROP ".length });
  f.press();
  expect(await f.markdown()).toBe("# Title\n\nkeep\\\nkeep\n");
});

it("adds a line inside a list item without creating a new bullet", async () => {
  const f = await open("# Title\n\n- one\n- two\n");
  f.caretIn("one");
  f.press();
  type(f.editor, "more");
  expect(await f.markdown()).toBe("# Title\n\n- one\\\n  more\n- two\n");
});

it("adds a line inside a quote", async () => {
  const f = await open("# Title\n\n> quoted\n");
  f.caretIn("quoted");
  f.press();
  type(f.editor, "again");
  expect(await f.markdown()).toBe("# Title\n\n> quoted\\\n> again\n");
});

it("adds a line in a toggle body instead of folding the toggle", async () => {
  const f = await open("# Title\n\n> [!note]+ Summary\n> Body\n");
  f.caretIn("Body");
  f.press();
  type(f.editor, "more");
  const folded = f.editor.view.dom.querySelector("aside[data-callout]")?.classList.contains("mb-folded");
  expect([folded, await f.markdown()]).toEqual([false, "# Title\n\n> [!note]+ Summary\n>\n> Body\\\n> more\n"]);
});

it("leaves Mod-Enter folding a toggle from its body", async () => {
  const f = await open("# Title\n\n> [!note]+ Summary\n> Body\n");
  f.caretIn("Body");
  const before = await f.markdown();
  f.press({ ctrlKey: true });
  const folded = f.editor.view.dom.querySelector("aside[data-callout]")?.classList.contains("mb-folded");
  expect([folded, await f.markdown()]).toEqual([true, before]);
});

it("leaves a heading single-line, since Markdown headings cannot hold a break", async () => {
  const f = await open("# Title\n\n## Section\n");
  f.caretIn("Section");
  const before = await f.markdown();
  f.press();
  expect(await f.markdown()).toBe(before);
});

it("does not edit a read-only note", async () => {
  const f = await open("# Title\n\nFixed\n", false);
  f.caretIn("Fixed");
  const before = await f.markdown();
  f.press();
  expect(await f.markdown()).toBe(before);
});

it("leaves plain Enter splitting the paragraph into a new block", async () => {
  const f = await open("# Title\n\nab\n");
  f.caretIn("ab", 1);
  f.press({});
  expect(f.editor.state.doc.childCount).toBe(3);
});
