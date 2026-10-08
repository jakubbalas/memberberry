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
  it("Enter after a nonempty bullet starts a sibling bullet", () => {
    const editor = open({ type: "doc", content: [bullet("First")] });
    cursorAt(editor, "First");
    editor.commands.keyboardShortcut("Enter");
    type(editor, "Second");
    expect(editor.getJSON()).toMatchObject({ content: [{ type: "bullet_list", content: [
      { type: "list_item", content: [{ type: "paragraph", content: [{ text: "First" }] }] },
      { type: "list_item", content: [{ type: "paragraph", content: [{ text: "Second" }] }] },
    ] }] });
  });

  it("Enter on an empty final bullet exits the list", () => {
    const editor = open({ type: "doc", content: [bullet("First", "")] });
    editor.commands.setTextSelection(editor.state.doc.content.size - 2);
    editor.commands.keyboardShortcut("Enter");
    expect(editor.getJSON().content?.map((node) => node.type)).toEqual(["bullet_list", "paragraph"]);
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
