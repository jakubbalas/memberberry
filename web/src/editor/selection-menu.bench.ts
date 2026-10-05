// @vitest-environment jsdom
/** Mounted jsdom/Yjs comparison; native input seam, not Android input-to-paint. */
import { readFileSync } from "node:fs";
import { Editor } from "@tiptap/core";
import { afterAll, beforeAll, bench, describe, expect } from "vitest";
import { applyUpdate, Doc } from "yjs";
import { load, schema, updateFromMarkdown } from "../notes.js";
import { createYjsBinding, PROSEMIRROR_ROOT } from "./collaboration.js";
import { createMemberberryExtensions } from "./schema.js";
import { mountSelectionMenu, type SelectionMenu } from "./selection-menu.js";

interface Fixture { editor: Editor; ydoc: Doc; panel: HTMLElement; menu?: SelectionMenu; text: Text; from: number }
const fixtures = new Map<string, Fixture>();
const sizes = [50, 500, 2000];
beforeAll(async () => {
  await load(readFileSync("src/wasm/mb_bg.wasm"));
  const contract = await schema();
  for (const count of sizes) {
    const seed = await updateFromMarkdown(`# Benchmark\n\n${Array.from({ length: count - 1 }, (_, i) => `Paragraph ${i}.\n`).join("\n")}`);
    for (const enabled of [false, true]) {
      const panel = document.createElement("section");
      const surface = document.createElement("div");
      panel.append(surface);
      document.body.append(panel);
      const ydoc = new Doc();
      applyUpdate(ydoc, seed);
      const editor = new Editor({ element: surface, editorProps: { handleScrollToSelection: () => true }, extensions: [...createMemberberryExtensions(contract), createYjsBinding(ydoc.getXmlFragment(PROSEMIRROR_ROOT))] });
      const text = editor.view.dom.querySelector("p")?.firstChild;
      if (!(text instanceof Text)) throw new Error("benchmark text missing");
      const from = (editor.state.doc.firstChild?.nodeSize ?? 0) + 1;
      editor.commands.setTextSelection(from + text.length);
      const fixture: Fixture = { editor, ydoc, panel, text, from };
      expect(editor.state.doc.childCount).toBe(count);
      fixtures.set(`${count}:${enabled}`, fixture);
      // Negative/no-op detector outside timing: DOM input must reach the bound PM document.
      const before = editor.state.doc.textContent;
      await nativeEdit(fixture, "x");
      expect(editor.state.doc.textContent).not.toBe(before);
      await nativeEdit(fixture, "");
      expect(editor.state.doc.textContent).toBe(before);
    }
  }
});

async function nativeEdit(f: Fixture, insertion: string): Promise<void> {
  // why: jsdom has no native contenteditable default action. Mutate its Text, then flush
  // the real ProseMirror DOM observer/input path; this is not a browser keystroke claim.
  f.editor.view.focus();
  const length = f.text.length;
  f.editor.view.dom.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: insertion ? "insertText" : "deleteContentBackward", data: insertion || null }));
  if (insertion) f.text.appendData(insertion);
  else f.text.deleteData(length - 1, 1);
  document.getSelection()?.setBaseAndExtent(f.text, f.text.length, f.text, f.text.length);
  f.editor.view.dom.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: insertion ? "insertText" : "deleteContentBackward", data: insertion || null }));
  await Promise.resolve();
}
for (const count of sizes) {
  describe(`${count} mounted root blocks`, () => {
    for (const enabled of [false, true]) {
      const hooks = {
        time: 500, warmupTime: 100, iterations: 20,
        setup: async () => {
          const f = fixtures.get(`${count}:${enabled}`);
          if (!f) throw new Error("benchmark not prepared");
          expect(document.querySelectorAll(".selection-menu").length).toBe(0);
          if (enabled) f.menu = mountSelectionMenu({ editor: f.editor, panel: f.panel });
          expect(document.querySelectorAll(".selection-menu").length).toBe(enabled ? 1 : 0);
          const before = f.editor.state.doc.textContent;
          await nativeEdit(f, "x");
          expect(f.editor.state.doc.textContent).not.toBe(before);
          await nativeEdit(f, "");
          expect(f.editor.state.doc.textContent).toBe(before);
          f.editor.commands.setTextSelection({ from: f.from, to: f.from + 5 });
          expect(f.editor.state.selection.empty).toBe(false);
          if (enabled) expect(document.querySelector<HTMLElement>(".selection-menu")?.hidden).toBe(false);
          f.editor.commands.setTextSelection(f.from + 5);
          if (enabled) expect(document.querySelector<HTMLElement>(".selection-menu")?.hidden).toBe(true);
        },
        teardown: () => {
          const f = fixtures.get(`${count}:${enabled}`);
          f?.menu?.destroy();
          if (f) delete f.menu;
          expect(document.querySelectorAll(".selection-menu").length).toBe(0);
        },
      };
      bench(`collapsed native input ${enabled ? "with" : "without"} selection controller`, async () => {
        const fixture = fixtures.get(`${count}:${enabled}`);
        if (!fixture) throw new Error("benchmark not prepared");
        await nativeEdit(fixture, "x");
        await nativeEdit(fixture, "");
      }, hooks);
      bench(`body selection ${enabled ? "with" : "without"} selection controller`, async () => {
        const fixture = fixtures.get(`${count}:${enabled}`);
        if (!fixture) throw new Error("benchmark not prepared");
        fixture.editor.commands.setTextSelection({ from: fixture.from, to: fixture.from + 5 });
        fixture.editor.commands.setTextSelection(fixture.from + 5);
      }, hooks);
    }
  });
}
afterAll(() => {
  for (const f of fixtures.values()) {
    f.menu?.destroy(); f.editor.destroy(); f.ydoc.destroy(); f.panel.remove();
  }
  expect(document.querySelector(".selection-menu")).toBeNull();
});
