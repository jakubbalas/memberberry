// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { Editor } from "@tiptap/core";
import { Slice, Fragment } from "@tiptap/pm/model";
import fc from "fast-check";
import { afterAll, beforeAll, expect, it } from "vitest";
import { load, schema } from "../notes.js";
import { createMemberberryExtensions } from "./schema.js";
import { CLIPBOARD_TYPE, readClipboardSlice, writeClipboardSlice } from "./clipboard.js";
import { SCHEMA_VERSION } from "./schema-revision.js";

let editor: Editor;
beforeAll(async () => {
  await load(readFileSync("src/wasm/mb_bg.wasm"));
  editor = new Editor({ extensions: createMemberberryExtensions(await schema()) });
});
afterAll(() => { editor.destroy(); });

function memory() {
  const formats = new Map<string, string>();
  return { formats, clearData: () => formats.clear(), setData: (type: string, value: string) => { formats.set(type, value); }, getData: (type: string) => formats.get(type) ?? "" };
}

it("round-trips structured clipboard slices with Unicode, marks and list attributes", () => {
  fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 100 }), fc.boolean(), fc.constantFrom("paragraph", "bullet_list", "ordered_list"), (random, bold, kind) => {
    const text = editor.schema.text(`ملاحظات 🌍 ${random}`, bold ? [editor.schema.mark("strong")] : []);
    const paragraph = editor.schema.node("paragraph", null, text);
    const node = kind === "paragraph" ? paragraph : editor.schema.node(kind, kind === "ordered_list" ? { start: 7 } : null, editor.schema.node("list_item", null, paragraph));
    const slice = new Slice(Fragment.from(node), 0, 0);
    const data = memory(); writeClipboardSlice(editor.view, data, slice);
    const result = readClipboardSlice(editor.view, data);
    expect(result && "slice" in result && result.slice.eq(slice)).toBe(true);
  }), { seed: 20261031, numRuns: 100 });
});

it("leaves ordinary external plain-text/HTML paste to ProseMirror", () => {
  expect(readClipboardSlice(editor.view, memory())).toBeUndefined();
});

it.each([
  "{", "null", "[]", JSON.stringify({ version: SCHEMA_VERSION + 1, slice: { content: [{ type: "paragraph", content: [{ type: "text", text: "future" }] }] } }),
  JSON.stringify({ version: SCHEMA_VERSION, slice: { content: [] } }),
  JSON.stringify({ version: SCHEMA_VERSION, slice: { content: [{ type: "future_block" }] } }),
  JSON.stringify({ version: SCHEMA_VERSION, slice: { content: [{ type: "heading", attrs: { level: 99 } }] } }),
  JSON.stringify({ version: SCHEMA_VERSION, slice: { content: [{ type: "paragraph", attrs: { future: true } }] } }),
  JSON.stringify({ version: SCHEMA_VERSION, slice: { content: [{ type: "paragraph", content: [{ type: "text", text: "bad", marks: [{ type: "mb_color", attrs: { value: "url(evil)" } }] }] }] } }),
  JSON.stringify({ version: SCHEMA_VERSION, slice: { content: [{ type: "paragraph" }], openStart: -1 } }),
  JSON.stringify({ version: SCHEMA_VERSION, slice: { content: [{ type: "paragraph" }], openEnd: 100 } }),
  JSON.stringify({ version: SCHEMA_VERSION, slice: { content: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(8 * 1024 * 1024) }] }] } }),
])("refuses malformed or incompatible own-format clipboard data (#%#)", value => {
  const data = memory(); data.formats.set(CLIPBOARD_TYPE, value);
  expect(readClipboardSlice(editor.view, data)).toEqual({ refused: true });
});

it("refuses an oversized copy before replacing existing clipboard contents", () => {
  const slice = new Slice(Fragment.from(editor.schema.node("paragraph", null, editor.schema.text("x".repeat(8 * 1024 * 1024)))), 0, 0);
  const data = memory(); data.formats.set("text/plain", "previous clipboard");
  expect(() => writeClipboardSlice(editor.view, data, slice)).toThrow("clipboard limit");
  expect(data.formats.get("text/plain")).toBe("previous clipboard");
});
