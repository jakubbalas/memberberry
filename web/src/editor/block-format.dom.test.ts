// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { afterEach, beforeAll, expect, it } from "vitest";
import { applyUpdate, Doc, encodeStateAsUpdate } from "yjs";
import { redo, undo } from "y-prosemirror";
import { load, schema, updateFromMarkdown } from "../notes.js";
import { createYjsBinding, PROSEMIRROR_ROOT } from "./collaboration.js";
import { createMemberberryExtensions } from "./schema.js";
import { protectedTitleExtension } from "./note-editor.js";
import { editorMarkdown } from "./source.js";
import { captureFormatSelection } from "./selection-format.js";
import { applyBlockFormat, captureBlockSelection, blockFormatState, type BlockFormat, type BlockSelection } from "./block-format.js";

const cleanups: (() => void)[] = [];
beforeAll(async () => { await load(readFileSync("src/wasm/mb_bg.wasm")); });
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
async function open(markdown = "# Title\n\nBody words ^body\n\nUntouched\n", update?: Uint8Array) {
  const ydoc = new Doc();
  applyUpdate(ydoc, update ?? await updateFromMarkdown(markdown));
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({ element, extensions: [
    ...createMemberberryExtensions(await schema()), protectedTitleExtension,
    createYjsBinding(ydoc.getXmlFragment(PROSEMIRROR_ROOT)),
  ] });
  cleanups.push(() => { editor.destroy(); ydoc.destroy(); element.remove(); });
  const range = (text: string) => {
    let from = -1;
    editor.state.doc.descendants((node, pos) => { if (node.isText && node.text?.includes(text)) from = pos + node.text.indexOf(text); });
    if (from < 0) throw new Error(`missing text ${text}`);
    return { from, to: from + text.length };
  };
  const select = (text: string, caret = false, gate = () => true): BlockSelection => {
    const { from, to } = range(text);
    editor.commands.setTextSelection({ from, to: caret ? from : to });
    const token = captureBlockSelection(editor, gate);
    if (!token) throw new Error(`cannot capture ${text}`);
    return token;
  };
  return { editor, ydoc, select, range };
}
async function roundtrip(f: Awaited<ReturnType<typeof open>>) {
  const saved = await editorMarkdown(f.ydoc);
  const reopened = await open(saved);
  expect(reopened.editor.state.doc.toJSON()).toEqual(f.editor.state.doc.toJSON());
  return saved;
}

it("converts the complete existing body paragraph selected in part to H2 without inserting an empty block", async () => {
  const f = await open("# Title\n\nBefore **Body** [[Target]] $x$ 🫐 words ^body\n\nUntouched\n");
  const before = f.editor.state.doc;
  const token = f.select("Body");
  expect(applyBlockFormat(f.editor, token, "h2")).toEqual({ status: "applied" });
  expect(f.editor.state.doc.childCount).toBe(before.childCount);
  expect(f.editor.state.doc.child(0)).toBe(before.child(0));
  expect(f.editor.state.doc.child(2)).toBe(before.child(2));
  expect(f.editor.state.doc.child(1).content.eq(before.child(1).content)).toBe(true);
  expect(f.editor.state.doc.child(1).attrs).toEqual({ level: 2, anchor: "body" });
  expect(f.editor.state.doc.textBetween(f.editor.state.selection.from, f.editor.state.selection.to)).toBe("Body");
  expect(await roundtrip(f)).toBe("# Title\n\n## Before **Body** [[Target]] $x$ 🫐 words ^body\n\nUntouched\n");
});

it("reverts native H1–H6 body headings to Text and keeps H5/H6 active state accurate", async () => {
  for (const level of [1, 2, 3, 4, 5, 6]) {
    const f = await open(`# Title\n\n${"#".repeat(level)} Body words ^body\n`);
    const token = f.select("Body", true);
    expect(blockFormatState(f.editor, token).active).toBe(`h${level}`);
    expect(applyBlockFormat(f.editor, token, "text")).toEqual({ status: "applied" });
    expect(await roundtrip(f)).toBe("# Title\n\nBody words ^body\n");
    expect(applyBlockFormat(f.editor, f.select("Body"), "text")).toEqual({ status: "unchanged" });
  }
});

it("isolates heading conversion undo from both earlier and later typing", async () => {
  const f = await open();
  f.select("Body");
  f.editor.view.dispatch(f.editor.state.tr.setSelection(TextSelection.create(f.editor.state.doc, f.editor.state.selection.to)).insertText("X"));
  expect(applyBlockFormat(f.editor, f.select("Body"), "h2")).toEqual({ status: "applied" });
  f.editor.view.dispatch(f.editor.state.tr.setSelection(TextSelection.create(f.editor.state.doc, f.editor.state.selection.to)).insertText("Y"));
  undo(f.editor.state);
  expect(await editorMarkdown(f.ydoc)).toBe("# Title\n\n## BodyX words ^body\n\nUntouched\n");
  undo(f.editor.state);
  expect(await editorMarkdown(f.ydoc)).toBe("# Title\n\nBodyX words ^body\n\nUntouched\n");
  undo(f.editor.state);
  expect(await editorMarkdown(f.ydoc)).toBe("# Title\n\nBody words ^body\n\nUntouched\n");
  redo(f.editor.state); redo(f.editor.state); redo(f.editor.state);
  expect(await roundtrip(f)).toBe("# Title\n\n## BodyYX words ^body\n\nUntouched\n");
});

it("refuses the protected title and accidental first-block title promotion", async () => {
  const f = await open();
  f.editor.commands.setTextSelection({ from: 1, to: f.range("Body").to });
  expect(captureBlockSelection(f.editor)).toBeUndefined();
  f.editor.commands.setTextSelection(2);
  expect(captureBlockSelection(f.editor)).toBeUndefined();
  const legacy = await open("Body words\n");
  const token = legacy.select("Body");
  expect(applyBlockFormat(legacy.editor, token, "h1")).toEqual({ status: "refused", reason: "title" });
  expect(await roundtrip(legacy)).toBe("Body words\n");
});

it("rechecks exact editor/doc and stored readiness plus readonly/composition/hidden/destroy at invocation", async () => {
  const f = await open();
  const other = await open();
  let ready = true;
  const token = f.select("Body", false, () => ready);
  const before = encodeStateAsUpdate(f.ydoc);
  expect(applyBlockFormat(other.editor, token, "h2").status).toBe("refused");
  expect(captureBlockSelection(other.editor, () => true, f.editor.state.selection)).toBeUndefined();
  f.editor.setEditable(false);
  expect(applyBlockFormat(f.editor, token, "h2")).toEqual({ status: "refused", reason: "readonly" });
  expect(captureBlockSelection(f.editor)).toBeUndefined();
  f.editor.setEditable(true);
  ready = false;
  expect(applyBlockFormat(f.editor, token, "h2")).toEqual({ status: "refused", reason: "unavailable" });
  ready = true;
  Object.defineProperty(f.editor.view, "composing", { configurable: true, value: true });
  expect(applyBlockFormat(f.editor, token, "h2")).toEqual({ status: "refused", reason: "composition" });
  Object.defineProperty(f.editor.view, "composing", { configurable: true, value: false });
  f.editor.view.dom.hidden = true;
  expect(applyBlockFormat(f.editor, token, "h2")).toEqual({ status: "refused", reason: "unavailable" });
  f.editor.view.dom.hidden = false;
  expect(encodeStateAsUpdate(f.ydoc)).toEqual(before);
  f.editor.commands.insertContentAt(f.editor.state.doc.content.size - 1, "new");
  expect(applyBlockFormat(f.editor, token, "h2")).toEqual({ status: "refused", reason: "stale" });
  f.editor.destroy();
  expect(applyBlockFormat(f.editor, token, "h2")).toEqual({ status: "refused", reason: "destroyed" });
  expect(captureBlockSelection(f.editor)).toBeUndefined();
});

it("converts all complete containing root textblocks for a partial cross-block selection and reports mixed state", async () => {
  const f = await open("# Title\n\nFirst words ^first\n\n### Second words ^second\n\nUntouched\n");
  const from = f.range("First").from + 2;
  const to = f.range("Second").to - 2;
  const selection = TextSelection.create(f.editor.state.doc, to, from);
  const token = captureBlockSelection(f.editor, () => true, selection);
  if (!token) throw new Error("missing multi-block capture");
  expect(blockFormatState(f.editor, token).active).toBe("mixed");
  expect(blockFormatState(f.editor, token).choices.map((choice) => choice.format)).toEqual(["text", "h1", "h2", "h3", "h4", "bullet_list", "ordered_list", "task_item", "code_block", "blockquote", "callout", "math_block"]);
  for (const format of ["h1", "h3", "h4"] as const) {
    const current = captureBlockSelection(f.editor, () => true, TextSelection.create(f.editor.state.doc, to, from));
    if (!current) throw new Error("missing updated capture");
    expect(applyBlockFormat(f.editor, current, format)).toEqual({ status: "applied" });
    expect(f.editor.state.doc.child(0).textContent).toBe("Title");
    expect(f.editor.state.doc.child(1).attrs["anchor"]).toBe("first");
    expect(f.editor.state.doc.child(2).attrs["anchor"]).toBe("second");
    expect(f.editor.state.selection.anchor).toBe(to);
    expect(f.editor.state.selection.head).toBe(from);
    await roundtrip(f);
  }
});

it("accepts the opaque inline-menu handoff and rejects forged captures and unsupported native choices", async () => {
  const f = await open();
  f.editor.commands.setTextSelection(f.range("Body"));
  const inline = captureFormatSelection(f.editor);
  if (!inline) throw new Error("missing inline capture");
  const token = captureBlockSelection(f.editor, () => true, inline);
  if (!token) throw new Error("missing block handoff");
  f.editor.commands.setTextSelection(f.range("Untouched"));
  expect(applyBlockFormat(f.editor, token, "h4")).toEqual({ status: "applied" });
  expect(f.editor.state.doc.child(1).attrs["level"]).toBe(4);
  const before = encodeStateAsUpdate(f.ydoc);
  expect(applyBlockFormat(f.editor, { kind: "memberberry-block-selection" }, "h2").status).toBe("refused");
  expect(applyBlockFormat(f.editor, f.select("Body"), "toggle" as BlockFormat)).toEqual({ status: "refused", reason: "unsupported" });
  expect(encodeStateAsUpdate(f.ydoc)).toEqual(before);
});
