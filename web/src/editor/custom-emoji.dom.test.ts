// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { Editor } from "@tiptap/core";
import { afterEach, expect, it, vi } from "vitest";
import { createMemberberryExtensions } from "./schema.js";
import { customEmojiViews } from "./custom-emoji.js";
import { emojiInputRules } from "./commands.js";
import { emojiAutocomplete } from "./emoji-autocomplete.js";

const contract: unknown = JSON.parse(readFileSync("../crates/mb-core/schema.json", "utf8"));
const manifest = [{ shortcode: "3d-printer", pack: "printing", file: "printer.png", aliases: ["3dp"] }];
const editors: Editor[] = [];
afterEach(() => { for (const editor of editors.splice(0)) { const element = editor.options.element; editor.destroy(); if (element instanceof HTMLElement) element.remove(); } vi.unstubAllGlobals(); });
function open(content: object): Editor {
  const element = document.createElement("div"); document.body.append(element);
  const editor = new Editor({ element, extensions: [...createMemberberryExtensions(contract), emojiInputRules([]), emojiAutocomplete([], "v"), customEmojiViews("v")], content });
  editors.push(editor);
  return editor;
}
function catalog(): ReturnType<typeof vi.fn<typeof fetch>> {
  const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(manifest)));
  vi.stubGlobal("fetch", request);
  return request;
}
function type(editor: Editor, text: string): void {
  for (const char of text) {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp("handleTextInput", (handle) => handle(editor.view, from, to, char, () => editor.state.tr.insertText(char, from, to)));
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(char, from, to));
  }
}

it("renders canonical atoms in titles/body and resolves uppercase aliases without changing content", async () => {
  catalog();
  const editor = open({ type: "doc", content: [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "emoji", attrs: { shortcode: "3d-printer" } }] },
    { type: "paragraph", content: [{ type: "emoji", attrs: { shortcode: "3DP" } }] },
  ] });
  const before = editor.getJSON();
  await vi.waitFor(() => expect(editor.view.dom.querySelectorAll("img.custom-emoji-image")).toHaveLength(2));
  expect(editor.getJSON()).toEqual(before);
  expect(editor.getText()).toContain(":3DP:");
  expect(editor.state.doc.firstChild?.textContent).toBe(":3d-printer:");
  expect(editor.view.dom.querySelector("h1 img")?.getAttribute("src")).toBe("/api/v1/vaults/v/emoji/printing/printer.png");
});

it("renders legacy text without rewriting it and leaves code and unknown names readable", async () => {
  catalog();
  const editor = open({ type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "Old :3d-printer: and :3dp: with :missing:." }] },
    { type: "code_block", content: [{ type: "text", text: ":3d-printer:" }] },
    { type: "paragraph", content: [{ type: "text", text: ":3d-printer:", marks: [{ type: "code" }] }] },
  ] });
  const before = editor.getJSON();
  await vi.waitFor(() => expect(editor.view.dom.querySelectorAll("img.custom-emoji-image")).toHaveLength(2));
  expect(editor.getJSON()).toEqual(before);
  expect(editor.view.dom.querySelectorAll(".custom-emoji-legacy-source")).toHaveLength(2);
  expect(editor.view.dom.querySelector("pre img, code img")).toBeNull();
  expect(editor.view.dom.textContent).toContain(":missing:");
});

it("updates only changed legacy text blocks and removes artwork when a token becomes code", async () => {
  catalog();
  const editor = open({ type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: ":3dp:" }] },
    { type: "paragraph", content: [{ type: "text", text: "After" }] },
  ] });
  await vi.waitFor(() => expect(editor.view.dom.querySelector("img.custom-emoji-image")).not.toBeNull());
  const retained = editor.view.dom.querySelector("img.custom-emoji-image");
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  editor.commands.insertContent(" :3dp:");
  expect(editor.view.dom.querySelectorAll("img.custom-emoji-image")).toHaveLength(2);
  expect(editor.view.dom.querySelector("img.custom-emoji-image")).toBe(retained);
  const code = editor.schema.marks["code"];
  if (code === undefined) throw new Error("code mark missing");
  editor.view.dispatch(editor.state.tr.addMark(1, 6, code.create()));
  expect(editor.view.dom.querySelectorAll("img.custom-emoji-image")).toHaveLength(1);
  expect(editor.view.dom.querySelector("code")?.textContent).toBe(":3dp:");
});

it("converts typed custom shortcodes to schema atoms and includes them in inline suggestions", async () => {
  catalog();
  const editor = open({ type: "doc", content: [{ type: "paragraph" }] });
  editor.view.focus();
  type(editor, ":3");
  await vi.waitFor(() => expect(document.querySelector(".emoji-autocomplete")?.textContent).toContain(":3d-printer:"));
  editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  type(editor, "dp:");
  expect(editor.getJSON()).toMatchObject({ content: [{ content: [{ type: "emoji", attrs: { shortcode: "3dp" } }] }] });
  await vi.waitFor(() => expect(editor.view.dom.querySelector("img.custom-emoji-image")).not.toBeNull());
  expect(editor.getText()).toBe(":3dp:");
});

it("chooses a custom autocomplete entry as an emoji atom rather than an empty string", async () => {
  catalog(); const editor = open({ type: "doc", content: [{ type: "paragraph" }] });
  editor.view.focus(); type(editor, ":3");
  await vi.waitFor(() => expect(document.querySelector(".emoji-autocomplete-item")?.textContent).toContain(":3d-printer:"));
  editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(editor.getJSON()).toMatchObject({ content: [{ content: [{ type: "emoji", attrs: { shortcode: "3d-printer" } }] }] });
});

it.each(["atom", "legacy"])("falls back to the readable shortcode when an %s image fails", async (kind) => {
  catalog();
  const inline = kind === "atom" ? { type: "emoji", attrs: { shortcode: "3dp" } } : { type: "text", text: ":3dp:" };
  const editor = open({ type: "doc", content: [{ type: "paragraph", content: [inline] }] });
  const before = editor.getJSON();
  await vi.waitFor(() => expect(editor.view.dom.querySelector("img.custom-emoji-image")).not.toBeNull());
  editor.view.dom.querySelector("img.custom-emoji-image")?.dispatchEvent(new Event("error"));
  expect(editor.view.dom.querySelector("img.custom-emoji-image")).toBeNull();
  expect(editor.view.dom.textContent).toBe(":3dp:");
  expect(editor.getJSON()).toEqual(before);
  expect(editor.view.dom.querySelector(".custom-emoji-legacy-source")).toBeNull();
});

it("does not load the catalog for notes containing only code examples", async () => {
  const request = catalog();
  open({ type: "doc", content: [{ type: "code_block", content: [{ type: "text", text: ":3d-printer:" }] }] });
  await Promise.resolve();
  expect(request).not.toHaveBeenCalled();
});
