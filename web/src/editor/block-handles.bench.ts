// @vitest-environment jsdom
/** Mounted PM/Yjs native-input seam, not browser/phone input-to-paint. */
import { readFileSync } from "node:fs";
import { Editor } from "@tiptap/core";
import { afterAll, beforeAll, bench, describe, expect } from "vitest";
import { applyUpdate, Doc } from "yjs";
import { load, schema, updateFromMarkdown } from "../notes.js";
import { createYjsBinding, PROSEMIRROR_ROOT } from "./collaboration.js";
import { createMemberberryExtensions } from "./schema.js";
import { mountBlockHandles, type BlockHandles } from "./block-handles.js";

interface Fixture { editor: Editor; document: Doc; panel: HTMLElement; text: Text; controller?: BlockHandles }
const fixtures = new Map<string, Fixture>();
const sizes = [50, 500, 2000];
async function nativeEdit(f: Fixture, insertion: string): Promise<void> {
  // why: jsdom has no contenteditable default action. Mutate the native Text then let the
  // real PM DOM observer/input binding run. No synthetic PM transaction substitutes for it.
  f.editor.view.focus();
  f.editor.view.dom.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: insertion ? "insertText" : "deleteContentBackward", data: insertion || null }));
  if (insertion) f.text.appendData(insertion);
  else f.text.deleteData(f.text.length - 1, 1);
  document.getSelection()?.setBaseAndExtent(f.text, f.text.length, f.text, f.text.length);
  f.editor.view.dom.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: insertion ? "insertText" : "deleteContentBackward", data: insertion || null }));
  await Promise.resolve();
}
beforeAll(async () => {
  await load(readFileSync("src/wasm/mb_bg.wasm"));
  const contract = await schema();
  for (const count of sizes) {
    const seed = await updateFromMarkdown(`# Benchmark\n\n${Array.from({ length: count - 1 }, (_, i) => `Paragraph ${i}.`).join("\n\n")}\n`);
    for (const enabled of [false, true]) {
      const panel = document.createElement("section"); const surface = document.createElement("div"); panel.append(surface); document.body.append(panel);
      const ydoc = new Doc(); applyUpdate(ydoc, seed);
      const editor = new Editor({ element: surface, editorProps: { handleScrollToSelection: () => true }, extensions: [...createMemberberryExtensions(contract), createYjsBinding(ydoc.getXmlFragment(PROSEMIRROR_ROOT))] });
      // why: include the later-root worst case, not only the first body paragraph.
      const paragraphs = editor.view.dom.querySelectorAll("p");
      const text = paragraphs.item(paragraphs.length - 1)?.firstChild;
      if (!(text instanceof Text)) throw new Error("benchmark text missing");
      expect(editor.state.doc.childCount).toBe(count);
      fixtures.set(`${count}:${enabled}`, { editor, document: ydoc, panel, text });
    }
  }
});
for (const count of sizes) {
  describe(`${count} mounted root blocks`, () => {
    for (const enabled of process.env["MB_BLOCK_BENCH_REVERSE"] === "1" ? [true, false] : [false, true]) {
      bench(`native input ${enabled ? "with" : "without"} movement controller`, async () => {
        const f = fixtures.get(`${count}:${enabled}`); if (!f) throw new Error("fixture not prepared");
        await nativeEdit(f, "x"); await nativeEdit(f, "");
      }, {
        time: 300, warmupTime: 100, iterations: 20,
        setup: async () => {
          const f = fixtures.get(`${count}:${enabled}`); if (!f) throw new Error("fixture not prepared");
          // why: no baseline is allowed to dispatch through other fixtures' global controllers.
          expect(document.querySelectorAll(".block-handles").length).toBe(0);
          if (enabled) f.controller = mountBlockHandles({ editor: f.editor, document: f.document, panel: f.panel, noteKey: `bench-${count}` });
          expect(document.querySelectorAll(".block-handles").length).toBe(enabled ? 1 : 0);
          const before = f.editor.state.doc.textContent;
          await nativeEdit(f, "x"); expect(f.editor.state.doc.textContent, "native input changed the bound document").not.toBe(before);
          await nativeEdit(f, ""); expect(f.editor.state.doc.textContent).toBe(before);
        },
        teardown: () => {
          const f = fixtures.get(`${count}:${enabled}`); f?.controller?.destroy(); if (f) delete f.controller;
          expect(document.querySelectorAll(".block-handles").length).toBe(0);
          expect(document.querySelectorAll(".block-move-menu").length).toBe(0);
        },
      });
    }
  });
}
afterAll(() => {
  for (const f of fixtures.values()) { f.controller?.destroy(); f.editor.destroy(); f.document.destroy(); f.panel.remove(); }
  fixtures.clear(); expect(document.querySelector(".block-handles")).toBeNull();
});
