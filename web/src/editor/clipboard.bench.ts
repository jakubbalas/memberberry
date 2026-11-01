// @vitest-environment jsdom
/** Clipboard serialization and explicit paste admission; never runs during ordinary typing. */
import { readFileSync } from "node:fs";
import { Editor } from "@tiptap/core";
import { Slice, Fragment } from "@tiptap/pm/model";
import { afterAll, beforeAll, bench, describe } from "vitest";
import { load, schema } from "../notes.js";
import { createMemberberryExtensions } from "./schema.js";
import { allowsClipboardTransaction, readClipboardSlice, writeClipboardSlice } from "./clipboard.js";

let editor: Editor;
const fixtures = new Map<number, { slice: Slice; data: { clearData(): void; setData(type: string, value: string): void; getData(type: string): string } }>();
beforeAll(async () => {
  await load(readFileSync("src/wasm/mb_bg.wasm"));
  editor = new Editor({ extensions: createMemberberryExtensions(await schema()) });
  for (const count of [50, 500, 2000]) {
    const nodes = Array.from({ length: count }, (_, i) => editor.schema.node("paragraph", null, editor.schema.text(`Row ${i} ملاحظات 🌍`, [editor.schema.mark("strong")])));
    const formats = new Map<string, string>();
    const data = { clearData: () => { formats.clear(); }, setData: (type: string, value: string) => { formats.set(type, value); }, getData: (type: string) => formats.get(type) ?? "" };
    const slice = new Slice(Fragment.fromArray(nodes), 0, 0);
    writeClipboardSlice(editor.view, data, slice);
    fixtures.set(count, { slice, data });
  }
});
afterAll(() => { editor.destroy(); fixtures.clear(); });
describe("rich clipboard slices", () => {
  for (const count of [50, 500, 2000]) {
    bench(`write ${count} selected paragraphs`, () => {
      const fixture = fixtures.get(count); if (!fixture) throw new Error("missing fixture");
      writeClipboardSlice(editor.view, fixture.data, fixture.slice);
    }, { time: 150, warmupTime: 50 });
    bench(`admit ${count} paragraphs through Rust codec`, () => {
      const fixture = fixtures.get(count); if (!fixture) throw new Error("missing fixture");
      const transaction = editor.state.tr.replaceSelection(fixture.slice);
      if (!allowsClipboardTransaction(editor.view, transaction)) throw new Error("invalid prospective paste");
    }, { time: 150, warmupTime: 50 });
    bench(`validate ${count} pasted paragraphs`, () => {
      const fixture = fixtures.get(count); if (!fixture) throw new Error("missing fixture");
      const result = readClipboardSlice(editor.view, fixture.data);
      if (!result || !("slice" in result)) throw new Error("invalid fixture");
    }, { time: 150, warmupTime: 50 });
  }
});
