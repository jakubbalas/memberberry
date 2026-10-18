// @vitest-environment jsdom
/** Large grouped-note capture cost; this is not a physical-phone input-to-paint measurement. */
import { readFileSync } from "node:fs";
import { Editor } from "@tiptap/core";
import { afterAll, beforeAll, bench, describe } from "vitest";
import { applyUpdate, Doc } from "yjs";
import { load, schema, updateFromMarkdown } from "../notes.js";
import { createYjsBinding, PROSEMIRROR_ROOT } from "./collaboration.js";
import { createMemberberryExtensions } from "./schema.js";
import { createBlockMover, type BlockMover } from "./block-move.js";

interface Fixture { editor: Editor; doc: Doc; mover: BlockMover; pos: number }
const fixtures = new Map<string, Fixture>();
const counts = [50, 500, 2000];
beforeAll(async () => {
  await load(readFileSync("src/wasm/mb_bg.wasm"));
  const contract = await schema();
  for (const kind of ["bullet", "line"] as const) for (const count of counts) {
    const doc = new Doc();
    const body = Array.from({ length: count }, (_, i) => `${kind === "bullet" ? "- " : ""}Row ${i}`).join("\n");
    applyUpdate(doc, await updateFromMarkdown(`# Benchmark\n\n${body}\n`));
    const editor = new Editor({ editorProps: { handleScrollToSelection: () => true }, extensions: [...createMemberberryExtensions(contract), createYjsBinding(doc.getXmlFragment(PROSEMIRROR_ROOT))] });
    let pos = 0;
    editor.state.doc.descendants((node, start) => { if (node.isText) pos = start; });
    const mover = createBlockMover({ editor, document: doc, noteKey: `capture-${kind}-${count}` });
    fixtures.set(`${kind}:${count}`, { editor, doc, mover, pos });
  }
});
describe("individual grouped-unit capture", () => {
  for (const kind of ["bullet", "line"] as const) for (const count of counts) {
    bench(`last ${kind} among ${count}`, () => {
      const f = fixtures.get(`${kind}:${count}`); if (!f) throw new Error("missing benchmark fixture");
      if (!f.mover.capture(f.pos)) throw new Error("benchmark did not capture a unit");
    }, { time: 200, warmupTime: 100 });
  }
});
describe("contiguous group capture", () => {
  for (const kind of ["bullet", "line"] as const) for (const count of counts) {
    bench(`all ${count} ${kind} rows`, () => {
      const f = fixtures.get(`${kind}:${count}`); if (!f) throw new Error("missing benchmark fixture");
      const first = f.mover.capture(f.editor.state.doc.firstChild?.nodeSize ?? 0);
      if (!first || !f.mover.captureRange(first.start, f.pos)) throw new Error("benchmark did not capture a range");
    }, { time: 200, warmupTime: 100 });
  }
});
afterAll(() => {
  for (const f of fixtures.values()) { f.mover.destroy(); f.editor.destroy(); f.doc.destroy(); }
  fixtures.clear();
});
