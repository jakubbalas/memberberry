// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { Editor } from "@tiptap/core";
import { prosemirrorToYDoc } from "y-prosemirror";
import { beforeAll, describe, expect, it } from "vitest";
import { extract, load } from "../notes.js";
import { loadMemberberryExtensions } from "./schema.js";
import { editorMarkdown } from "./source.js";

beforeAll(async () => {
  await load(readFileSync("src/wasm/mb_bg.wasm"));
});

describe("typed tags", () => {
  it.each(["", " remaining text"])("completes a tag with one Enter, preserving following text %j", async (following) => {
    const editor = new Editor({ extensions: await loadMemberberryExtensions() });
    try {
      editor.commands.insertContent(`#hello${following}`);
      editor.commands.setTextSelection(7);
      editor.view.someProp("handleKeyDown", (handle) =>
        handle(editor.view, new KeyboardEvent("keydown", { key: "Enter" })));
      expect(editor.getJSON().content).toEqual([
        { type: "paragraph", attrs: { anchor: null }, content: [{ type: "tag", attrs: { name: "hello" } }] },
        { type: "paragraph", attrs: { anchor: null }, ...(following ? { content: [{ type: "text", text: following }] } : {}) },
      ]);
      expect(editor.state.selection.$from.parentOffset).toBe(0);
      expect(editor.state.selection.$from.index(0)).toBe(1);
    } finally {
      editor.destroy();
    }
  });

  it("accepts a hashtag delivered in one text-input event", async () => {
    const editor = new Editor({ extensions: await loadMemberberryExtensions() });
    try {
      const text = "#hello ";
      editor.view.someProp("handleTextInput", (handle) =>
        handle(editor.view, 1, 1, text, () => editor.state.tr.insertText(text)));
      expect(editor.view.dom.querySelector("[data-tag]")?.textContent).toBe("#hello");
    } finally {
      editor.destroy();
    }
  });

  it.each(["code_block", "code"])("does not convert hashtags inside %s", async (kind) => {
    const editor = new Editor({
      extensions: await loadMemberberryExtensions(),
      content: { type: "doc", content: [{ type: kind === "code_block" ? kind : "paragraph", content: [{ type: "text", text: "#hello", ...(kind === "code" ? { marks: [{ type: "code" }] } : {}) }] }] },
    });
    try {
      editor.commands.setTextSelection(7);
      const handled = editor.view.someProp("handleTextInput", (handle) =>
        handle(editor.view, 7, 7, " ", () => editor.state.tr.insertText(" ")));
      expect(handled).toBeFalsy();
    } finally {
      editor.destroy();
    }
  });

  it.each(["hello", "project/memberberry", "with-dashes", "tag_2"])("saves #%s as an indexable tag", async (name) => {
    const editor = new Editor({ extensions: await loadMemberberryExtensions() });
    try {
      for (const character of `#${name} `) {
        const { from, to } = editor.state.selection;
        const handled = editor.view.someProp("handleTextInput", (handle) =>
          handle(editor.view, from, to, character, () => editor.state.tr.insertText(character, from, to)));
        if (!handled) editor.view.dispatch(editor.state.tr.insertText(character, from, to));
      }
      const document = prosemirrorToYDoc(editor.state.doc);
      try {
        const markdown = await editorMarkdown(document);
        expect((await extract(markdown)).tags).toEqual([name]);
      } finally {
        document.destroy();
      }
    } finally {
      editor.destroy();
    }
  });

  it.each(["#404 ", "\\#hello ", "# hello "])("keeps %s as ordinary text", async (text) => {
    const editor = new Editor({ extensions: await loadMemberberryExtensions() });
    try {
      for (const character of text) {
        const { from, to } = editor.state.selection;
        const handled = editor.view.someProp("handleTextInput", (handle) =>
          handle(editor.view, from, to, character, () => editor.state.tr.insertText(character, from, to)));
        if (!handled) editor.view.dispatch(editor.state.tr.insertText(character, from, to));
      }
      expect(editor.view.dom.querySelector("[data-tag]")).toBeNull();
    } finally {
      editor.destroy();
    }
  });
});
