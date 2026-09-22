// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { Editor } from "@tiptap/core";
import { afterAll, beforeAll, bench } from "vitest";
import { load, normalize } from "../notes.js";
import { createMemberberryExtensions } from "./schema.js";
import { mountTableTools } from "./table-tools.js";

const contract: unknown = JSON.parse(readFileSync("../crates/mb-core/schema.json", "utf8"));
const editors: Editor[] = [];
const cleanups: (() => void)[] = [];
beforeAll(async () => { await load(readFileSync("src/wasm/mb_bg.wasm")); });
const multilineTable = `| Header |\n| --- |\n${"| <br>one<br><br>two<br> |\n".repeat(100)}`;
bench("normalize a 100-row multiline table through WASM", async () => { await normalize(multilineTable); });
for (const tools of [false, true]) {
  const editor = new Editor({ element: document.createElement("div"), extensions: createMemberberryExtensions(contract) });
  editor.commands.setContent({ type: "doc", content: [{ type: "table", attrs: { alignments: ["none", "none"] }, content:
    Array.from({ length: 100 }, () => ({ type: "table_row", content: [{ type: "table_cell" }, { type: "table_cell" }] })),
  }] });
  editor.commands.setTextSelection(3);
  if (tools) cleanups.push(mountTableTools(editor, document.createElement("div")).destroy);
  editors.push(editor);
  bench(`type and delete in a 100-row table ${tools ? "with" : "without"} controls`, () => {
    editor.view.dispatch(editor.state.tr.insertText("a"));
    editor.view.dispatch(editor.state.tr.delete(3, 4));
  });
}
afterAll(() => { for (const cleanup of cleanups) cleanup(); for (const editor of editors) editor.destroy(); });
