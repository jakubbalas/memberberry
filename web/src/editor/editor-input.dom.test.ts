// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { createMemberberryExtensions } from "./schema.js";
import { memberberryInputRules } from "./commands.js";
import { createYjsBinding, PROSEMIRROR_ROOT } from "./collaboration.js";
import { Doc } from "yjs";

const contract: unknown = JSON.parse(readFileSync("../crates/mb-core/schema.json", "utf8"));
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); document.body.replaceChildren(); });

function open(content: object): Editor {
  const document = new Doc();
  const editor = new Editor({
    element: documentElement(),
    extensions: [...createMemberberryExtensions(contract), memberberryInputRules,
      createYjsBinding(document.getXmlFragment(PROSEMIRROR_ROOT))],
  });
  // why: y-prosemirror initializes from the local fragment and replaces constructor content.
  editor.commands.setContent(content);
  cleanups.push(() => { editor.destroy(); document.destroy(); });
  return editor;
}
function documentElement(): HTMLElement {
  const element = document.createElement("div");
  document.body.append(element);
  return element;
}
function item(text: string): object {
  return { type: "list_item", content: [{ type: "paragraph", ...(text === "" ? {} : { content: [{ type: "text", text }] }) }] };
}
function bullet(...texts: string[]): object {
  return { type: "bullet_list", content: texts.map(item) };
}
function cursorAt(editor: Editor, text: string): void {
  let position: number | undefined;
  editor.state.doc.descendants((node, pos) => {
    if (position === undefined && node.isTextblock && node.textContent === text) position = pos + 1 + text.length;
  });
  if (position === undefined) throw new Error(`missing text: ${text}`);
  editor.commands.setTextSelection(position);
}
function type(editor: Editor, text: string): void {
  for (const char of text) {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp("handleTextInput", (handle) => handle(
      editor.view, from, to, char, () => editor.state.tr.insertText(char, from, to),
    ));
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(char, from, to));
  }
}

describe("note editor keyboard input", () => {
  it.each([0, 1, 7, 999999999])("typing %s. followed by a space starts a numbered list at that number", (start) => {
    const editor = open({ type: "doc", content: [{ type: "paragraph" }] });
    type(editor, `${start}. `);
    expect(editor.getJSON()).toMatchObject({ content: [{ type: "ordered_list", attrs: { start }, content: [item("")] }] });
  });

  it("Enter continues a numbered list created by typing and an empty item exits", () => {
    const editor = open({ type: "doc", content: [{ type: "paragraph" }] });
    type(editor, "1. First");
    editor.commands.keyboardShortcut("Enter"); type(editor, "Second");
    editor.commands.keyboardShortcut("Enter"); editor.commands.keyboardShortcut("Enter"); type(editor, "Outside");
    expect(editor.getJSON()).toMatchObject({ content: [
      { type: "ordered_list", attrs: { start: 1 }, content: [item("First"), item("Second")] },
      { type: "paragraph", content: [{ type: "text", text: "Outside" }] },
    ] });
  });

  it.each(["1.", "1.2 ", "Version 1. ", "\\1. ", "1234567890. "])("keeps %j as literal paragraph text", (text) => {
    const editor = open({ type: "doc", content: [{ type: "paragraph" }] });
    type(editor, text);
    expect(editor.getJSON()).toMatchObject({ content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
  });

  it("keeps a typed numbered marker literal inside a fenced code block", () => {
    const editor = open({ type: "doc", content: [{ type: "code_block" }] });
    type(editor, "1. literal");
    expect(editor.getJSON()).toMatchObject({ content: [{ type: "code_block", content: [{ type: "text", text: "1. literal" }] }] });
  });

  it("allows automatic list conversion to be undone back to its literal marker", () => {
    const editor = open({ type: "doc", content: [{ type: "paragraph" }] });
    type(editor, "1. ");
    expect(editor.commands.undoInputRule()).toBe(true);
    expect(editor.getJSON()).toMatchObject({ content: [{ type: "paragraph", content: [{ type: "text", text: "1. " }] }] });
  });

  it.each([9, 1])("joins a preceding numbered list only when the typed %s. continues its sequence", (start) => {
    const editor = open({ type: "doc", content: [
      { type: "ordered_list", attrs: { start: 7 }, content: [item("First"), item("Second")] },
      { type: "paragraph" },
    ] });
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    type(editor, `${start}. Next`);
    expect(editor.getJSON()).toMatchObject({ content: start === 9 ? [
      { type: "ordered_list", attrs: { start: 7 }, content: [item("First"), item("Second"), item("Next")] },
    ] : [
      { type: "ordered_list", attrs: { start: 7 }, content: [item("First"), item("Second")] },
      { type: "ordered_list", attrs: { start: 1 }, content: [item("Next")] },
    ] });
  });

  it.each(["bullet_list", "ordered_list"])("Enter after a nonempty %s item starts a sibling item", (kind) => {
    const editor = open({ type: "doc", content: [{ type: kind, content: [item("First")] }] });
    cursorAt(editor, "First");
    editor.commands.keyboardShortcut("Enter");
    type(editor, "Second");
    expect(editor.getJSON()).toMatchObject({ content: [{ type: kind, content: [
      { type: "list_item", content: [{ type: "paragraph", content: [{ text: "First" }] }] },
      { type: "list_item", content: [{ type: "paragraph", content: [{ text: "Second" }] }] },
    ] }] });
  });

  it.each(["bullet_list", "ordered_list"])("Enter on an empty final %s item exits the list", (kind) => {
    const editor = open({ type: "doc", content: [{ type: kind, content: [item("First"), item("")] }] });
    editor.commands.setTextSelection(editor.state.doc.content.size - 2);
    editor.commands.keyboardShortcut("Enter");
    expect(editor.getJSON().content?.map((node) => node.type)).toEqual([kind, "paragraph"]);
  });

  it("Enter in the middle of a numbered item splits its text and retains the list start", () => {
    const editor = open({ type: "doc", content: [{ type: "ordered_list", attrs: { start: 7 }, content: [item("FirstSecond"), item("Last")] }] });
    cursorAt(editor, "FirstSecond");
    editor.commands.setTextSelection(editor.state.selection.from - "Second".length);
    editor.commands.keyboardShortcut("Enter");
    expect(editor.getJSON()).toMatchObject({ content: [{ type: "ordered_list", attrs: { start: 7 }, content: [
      item("First"), item("Second"), item("Last"),
    ] }] });
  });

  it.each(["bullet_list", "ordered_list"])("Enter continues a nested numbered list inside %s", (outer) => {
    const editor = open({ type: "doc", content: [{ type: outer, content: [{ type: "list_item", content: [
      { type: "paragraph", content: [{ type: "text", text: "Parent" }] },
      { type: "ordered_list", content: [item("Nested")] },
    ] }] }] });
    cursorAt(editor, "Nested");
    editor.commands.keyboardShortcut("Enter");
    type(editor, "Next");
    expect(editor.getJSON()).toMatchObject({ content: [{ type: outer, content: [{ type: "list_item", content: [
      { type: "paragraph", content: [{ type: "text", text: "Parent" }] },
      { type: "ordered_list", content: [item("Nested"), item("Next")] },
    ] }] }] });
  });

  it("Enter does not change a read-only numbered list", () => {
    const editor = open({ type: "doc", content: [{ type: "ordered_list", content: [item("Fixed")] }] });
    cursorAt(editor, "Fixed");
    editor.setEditable(false);
    const before = editor.getJSON();
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(editor.getJSON()).toEqual(before);
  });

  it("Tab nests a bullet beneath its preceding sibling", () => {
    const editor = open({ type: "doc", content: [bullet("First", "Second")] });
    cursorAt(editor, "Second");
    editor.commands.keyboardShortcut("Tab");
    expect(editor.getJSON()).toMatchObject({ content: [{ type: "bullet_list", content: [{ type: "list_item", content: [
      { type: "paragraph", content: [{ text: "First" }] },
      { type: "bullet_list", content: [{ type: "list_item", content: [{ type: "paragraph", content: [{ text: "Second" }] }] }] },
    ] }] }] });
  });

  it("Shift-Tab outdents a nested bullet", () => {
    const editor = open({ type: "doc", content: [{ type: "bullet_list", content: [
      { type: "list_item", content: [{ type: "paragraph", content: [{ type: "text", text: "First" }] }, bullet("Second")] },
    ] }] });
    cursorAt(editor, "Second");
    editor.commands.keyboardShortcut("Shift-Tab");
    expect(editor.getJSON()).toMatchObject({ content: [{ type: "bullet_list", content: [
      { type: "list_item", content: [{ type: "paragraph", content: [{ text: "First" }] }] },
      { type: "list_item", content: [{ type: "paragraph", content: [{ text: "Second" }] }] },
    ] }] });
  });

  it("Tab on a first bullet does not nest without a preceding sibling", () => {
    const editor = open({ type: "doc", content: [bullet("First")] });
    cursorAt(editor, "First");
    editor.commands.keyboardShortcut("Tab");
    expect(editor.getJSON()).toMatchObject({ content: [bullet("First")] });
  });

  it("paired single backticks apply the code mark on manual text input", () => {
    const editor = open({ type: "doc", content: [{ type: "paragraph" }] });
    type(editor, "`code`");
    expect(editor.getJSON().content?.[0]?.content).toEqual([{ type: "text", text: "code", marks: [{ type: "code" }] }]);
  });

  it("an unmatched backtick remains literal text", () => {
    const editor = open({ type: "doc", content: [{ type: "paragraph" }] });
    type(editor, "`code");
    expect(editor.getText()).toBe("`code");
  });

  it("an escaped opening backtick remains literal text", () => {
    const editor = open({ type: "doc", content: [{ type: "paragraph" }] });
    type(editor, "\\`code`");
    expect(editor.getJSON().content?.[0]?.content).toEqual([{ type: "text", text: "\\`code`" }]);
  });

  it("backticks in a fenced code block do not create an inline code mark", () => {
    const editor = open({ type: "doc", content: [{ type: "code_block" }] });
    type(editor, "`code`");
    expect(editor.getJSON().content?.[0]?.content).toEqual([{ type: "text", text: "`code`" }]);
  });

  it("Ctrl-Z on the focused editor undoes text entered via the editor input path", () => {
    const editor = open({ type: "doc", content: [{ type: "paragraph" }] });
    editor.view.focus();
    type(editor, "Hello");
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(editor.getText()).toBe("");
  });
});
