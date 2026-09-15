// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { Doc } from "yjs";
import { undo } from "y-prosemirror";
import { createYjsBinding, PROSEMIRROR_ROOT } from "./collaboration.js";
import { createMemberberryExtensions } from "./schema.js";

const contract: unknown = JSON.parse(readFileSync("../crates/mb-core/schema.json", "utf8"));
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function open(): Editor {
  const document = new Doc();
  const editor = new Editor({
    extensions: [...createMemberberryExtensions(contract), createYjsBinding(document.getXmlFragment(PROSEMIRROR_ROOT))],
  });
  cleanups.push(() => { editor.destroy(); document.destroy(); });
  return editor;
}

describe("collaborative editor undo shortcuts", () => {
  it("undoes a local text edit with Mod-z", () => {
    const editor = open();
    editor.commands.insertContent("Hello 🌍");
    editor.commands.keyboardShortcut("Mod-z");
    expect(editor.getText()).toBe("");
  });

  it.each(["Mod-Shift-z", "Mod-y"])("restores an undone edit with %s", (shortcut) => {
    const editor = open();
    editor.commands.insertContent("Hello 🌍");
    undo(editor.state);
    editor.commands.keyboardShortcut(shortcut);
    expect(editor.getText()).toBe("Hello 🌍");
  });

  it("leaves an empty undo stack unchanged", () => {
    const editor = open();
    editor.commands.keyboardShortcut("Mod-z");
    editor.commands.keyboardShortcut("Mod-Shift-z");
    expect(editor.getText()).toBe("");
  });

  it("does not change content after editing permission is removed", () => {
    const editor = open();
    editor.commands.insertContent("Keep this");
    editor.setEditable(false);
    editor.commands.keyboardShortcut("Mod-z");
    expect(editor.getText()).toBe("Keep this");
  });
});
