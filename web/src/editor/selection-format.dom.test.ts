// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { Editor } from "@tiptap/core";
import { AllSelection, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { afterEach, beforeAll, expect, it } from "vitest";
import { applyUpdate, Doc, encodeStateAsUpdate } from "yjs";
import { redo, undo, yUndoPluginKey } from "y-prosemirror";
import { load, schema, updateFromMarkdown } from "../notes.js";
import { createYjsBinding, PROSEMIRROR_ROOT } from "./collaboration.js";
import { createMemberberryExtensions } from "./schema.js";
import { editorMarkdown } from "./source.js";
import { applyInlineFormat, captureFormatSelection, inlineFormatState } from "./selection-format.js";

const cleanups: (() => void)[] = [];
beforeAll(async () => { await load(readFileSync("src/wasm/mb_bg.wasm")); });
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
async function open(markdown = "# Title\n\nBody words\n") {
  const ydoc = new Doc();
  applyUpdate(ydoc, await updateFromMarkdown(markdown));
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({ element, extensions: [
    ...createMemberberryExtensions(await schema()), createYjsBinding(ydoc.getXmlFragment(PROSEMIRROR_ROOT)),
  ] });
  cleanups.push(() => { editor.destroy(); ydoc.destroy(); element.remove(); });
  const select = (text: string) => {
    let from = -1;
    editor.state.doc.descendants((node, pos) => { if (node.isText && node.text?.includes(text)) from = pos + node.text.indexOf(text); });
    if (from < 0) throw new Error(`missing text ${text}`);
    editor.commands.setTextSelection({ from, to: from + text.length });
    const token = captureFormatSelection(editor);
    if (!token) throw new Error(`cannot capture ${text}`);
    return token;
  };
  return { editor, ydoc, select };
}

it("refuses a TextSelection whose resolved document belongs to a different editor", async () => {
  const a = await open();
  const b = await open();
  b.select("Body");
  expect(captureFormatSelection(a.editor, () => true, b.editor.state.selection)).toBeUndefined();
});

it("refuses Strong on existing literal inline code instead of reporting a successful partial edit", async () => {
  const f = await open("# Title\n\nBody `literal` words\n");
  const token = f.select("literal");
  const before = await editorMarkdown(f.ydoc);
  expect(applyInlineFormat(f.editor, token, "strong")).toBe("refused");
  expect(await editorMarkdown(f.ydoc)).toBe(before);
});

it("refuses title ranges, AllSelection, NodeSelection and atom-only selections", async () => {
  const f = await open("# Title\n\nBody [[Target]] words\n");
  const body = f.editor.state.doc.firstChild?.nodeSize ?? 0;
  for (const [from, to] of [[1, 4], [3, body + 4]] as const) {
    f.editor.commands.setTextSelection({ from, to });
    expect(captureFormatSelection(f.editor)).toBeUndefined();
  }
  f.editor.view.dispatch(f.editor.state.tr.setSelection(new AllSelection(f.editor.state.doc)));
  expect(captureFormatSelection(f.editor)).toBeUndefined();
  let atom = -1;
  f.editor.state.doc.descendants((node, pos) => { if (node.type.name === "wikilink") atom = pos; });
  f.editor.view.dispatch(f.editor.state.tr.setSelection(NodeSelection.create(f.editor.state.doc, atom)));
  expect(captureFormatSelection(f.editor)).toBeUndefined();
  f.editor.view.dispatch(f.editor.state.tr.setSelection(TextSelection.create(f.editor.state.doc, atom, atom + 1)));
  expect(captureFormatSelection(f.editor)).toBeUndefined();
});

it("rechecks read-only, live readiness, composition, hidden DOM, editor token and stale document at action time", async () => {
  const f = await open();
  const other = await open();
  const token = f.select("Body");
  const before = await editorMarkdown(f.ydoc);
  expect(applyInlineFormat(other.editor, token, "strong")).toBe("refused");
  f.editor.setEditable(false);
  expect(applyInlineFormat(f.editor, token, "strong")).toBe("refused");
  f.editor.setEditable(true);
  expect(applyInlineFormat(f.editor, token, "strong", () => false)).toBe("refused");
  Object.defineProperty(f.editor.view, "composing", { configurable: true, value: true });
  expect(applyInlineFormat(f.editor, token, "strong")).toBe("refused");
  Object.defineProperty(f.editor.view, "composing", { configurable: true, value: false });
  f.editor.view.dom.hidden = true;
  expect(applyInlineFormat(f.editor, token, "strong")).toBe("refused");
  f.editor.view.dom.hidden = false;
  expect(await editorMarkdown(f.ydoc)).toBe(before);
  f.editor.commands.insertContentAt(f.editor.state.doc.content.size - 1, "new");
  expect(applyInlineFormat(f.editor, token, "strong")).toBe("refused");
  f.editor.destroy();
  expect(applyInlineFormat(f.editor, token, "strong")).toBe("refused");
  expect(captureFormatSelection(f.editor)).toBeUndefined();
});

it.each(["```\nliteral\n```\n", "$$\nliteral\n$$\n"])("refuses formatting in literal blocks %s", async (body) => {
  const f = await open(`# Title\n\n${body}`);
  let from = -1;
  f.editor.state.doc.descendants((node, pos) => { if (node.isText && node.text === "literal") from = pos; });
  f.editor.commands.setTextSelection({ from, to: from + 3 });
  expect(captureFormatSelection(f.editor)).toBeUndefined();
});

it("separates mark undo from earlier and later typing through the actual Yjs UndoManager", async () => {
  const f = await open();
  f.select("Body");
  f.editor.view.dispatch(f.editor.state.tr.setSelection(TextSelection.create(f.editor.state.doc, f.editor.state.selection.to)).insertText("X"));
  const token = f.select("Body");
  expect(applyInlineFormat(f.editor, token, "strong")).toBe("applied");
  f.editor.view.dispatch(f.editor.state.tr.setSelection(TextSelection.create(f.editor.state.doc, f.editor.state.selection.to)).insertText("Y"));
  undo(f.editor.state);
  expect(await editorMarkdown(f.ydoc)).toBe("# Title\n\n**Body**X words\n");
  undo(f.editor.state);
  expect(await editorMarkdown(f.ydoc)).toBe("# Title\n\nBodyX words\n");
  undo(f.editor.state);
  expect(await editorMarkdown(f.ydoc)).toBe("# Title\n\nBody words\n");
  redo(f.editor.state); redo(f.editor.state); redo(f.editor.state);
  expect(await editorMarkdown(f.ydoc)).toContain("BodyY");
});

it("Clear removes marks only, retaining task metadata, atoms, anchors and table structure", async () => {
  const f = await open("# Title\n\n- [ ] **Body** [[Target]] $x$ 📅 2026-09-30 🔁 every day ^task\n\n| **Head** |\n| --- |\n| *Cell* |\n");
  const before = f.editor.state.doc.toJSON();
  const titleEnd = f.editor.state.doc.firstChild?.nodeSize ?? 0;
  let from = -1;
  let to = 0;
  f.editor.state.doc.descendants((node, pos) => {
    if (node.isText && pos >= titleEnd) { if (from < 0) from = pos; to = pos + node.nodeSize; }
  });
  f.editor.commands.setTextSelection({ from, to });
  const token = captureFormatSelection(f.editor);
  if (!token) throw new Error("body capture missing");
  expect(applyInlineFormat(f.editor, token, "clear")).toBe("applied");
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "marks").map(([key, val]) => [key, strip(val)]));
    return value;
  };
  // why: removing marks coalesces adjacent text; compare normalized PM structure, not text-run boundaries.
  expect(f.editor.state.doc.toJSON()).toEqual(f.editor.state.schema.nodeFromJSON(strip(before)).toJSON());
  const saved = await editorMarkdown(f.ydoc);
  expect(saved).toContain("[[Target]] $x$");
  expect(saved).toContain("📅 2026-09-30");
  expect(saved).toContain("🔁 every day");
  expect(saved).toContain("^task");
  expect(saved).not.toContain("**");
  const reopened = await open(saved);
  expect(reopened.editor.state.doc.toJSON()).toEqual(f.editor.state.doc.toJSON());
});

it("refuses a lossy code mark over rich text or inline math and allows code removal", async () => {
  const f = await open("# Title\n\n**Body** $x$ words\n");
  const token = f.select("Body");
  expect(applyInlineFormat(f.editor, token, "code")).toBe("refused");
  f.editor.commands.setTextSelection({ from: f.editor.state.selection.from, to: f.editor.state.doc.content.size - 1 });
  const all = captureFormatSelection(f.editor);
  if (!all) throw new Error("missing capture");
  expect(applyInlineFormat(f.editor, all, "code")).toBe("refused");
  const g = await open("# Title\n\n`Body` words\n");
  expect(applyInlineFormat(g.editor, g.select("Body"), "code")).toBe("applied");
  expect(await editorMarkdown(g.ydoc)).toBe("# Title\n\nBody words\n");
});

it.each(["javascript:alert(1)", "data:text/html,x", "//outside.example", "java%73cript:alert(1)", "https:\\bad.example", ""]) ("rejects unsafe direct link admission %s", async (link) => {
  const f = await open();
  expect(applyInlineFormat(f.editor, f.select("Body"), { link })).toBe("refused");
  expect(await editorMarkdown(f.ydoc)).toBe("# Title\n\nBody words\n");
});

it.each(["https://example.com/x", "mailto:a@example.com", "../Other.md#Heading"]) ("admits safe direct link destination %s", async (link) => {
  const f = await open();
  expect(applyInlineFormat(f.editor, f.select("Body"), { link })).toBe("applied");
  const saved = await editorMarkdown(f.ydoc);
  expect(saved).toContain(`[Body](${link})`);
  const reopened = await open(saved);
  expect(reopened.editor.view.dom.querySelector("a")?.textContent).toBe("Body");
});

it("reports mixed strong state and formats legacy notes without treating their first paragraph as a title", async () => {
  const f = await open("**Body** words\n");
  const from = 1;
  f.editor.commands.setTextSelection({ from, to: f.editor.state.doc.content.size - 1 });
  const token = captureFormatSelection(f.editor);
  if (!token) throw new Error("legacy body missing");
  expect(inlineFormatState(f.editor, token, "strong")).toBe("mixed");
  expect(applyInlineFormat(f.editor, token, "strong")).toBe("applied");
  expect(await editorMarkdown(f.ydoc)).toBe("**Body words**\n");
});

it("accepting an unchanged href preserves authored title without Yjs updates or undo items", async () => {
  const initial = '# Title\n\n[Body](https://example.com "authored title") words\n';
  const f = await open(initial);
  const token = f.select("Body");
  const manager = yUndoPluginKey.getState(f.editor.state)?.undoManager;
  const count = manager?.undoStack.length;
  let updates = 0;
  f.ydoc.on("update", () => { updates++; });
  expect(applyInlineFormat(f.editor, token, { link: " https://example.com " })).toBe("unchanged");
  expect(updates).toBe(0);
  expect(manager?.undoStack.length).toBe(count);
  expect(await editorMarkdown(f.ydoc)).toBe(initial);
});

it.each([
  ['[Body](https://example.com "kept") words', "Body", '[Body](https://new.example "kept") words'],
  ['[Body](https://example.com "kept") words', "od", '[B](https://example.com "kept")[od](https://new.example "kept")[y](https://example.com "kept") words'],
  ['[First](https://first.example "one") plain [Later](https://later.example "two")', null, '[First](https://new.example "one")[ plain ](https://new.example)[Later](https://new.example "two")'],
] as const)("href-only updates preserve each authored link run: %s", async (body, selected, expected) => {
  const f = await open(`# Title\n\n${body}\n`);
  if (selected) f.select(selected);
  else f.editor.commands.setTextSelection({ from: (f.editor.state.doc.firstChild?.nodeSize ?? 0) + 1, to: f.editor.state.doc.content.size - 1 });
  const token = captureFormatSelection(f.editor);
  if (!token) throw new Error("missing body capture");
  expect(applyInlineFormat(f.editor, token, { link: "https://new.example" })).toBe("applied");
  const saved = `# Title\n\n${expected}\n`;
  expect(await editorMarkdown(f.ydoc)).toBe(saved);
  const binary = new Doc();
  applyUpdate(binary, encodeStateAsUpdate(f.ydoc));
  try { expect(await editorMarkdown(binary)).toBe(saved); } finally { binary.destroy(); }
  const reopened = await open(saved);
  expect(reopened.editor.state.doc.toJSON()).toEqual(f.editor.state.doc.toJSON());
  undo(f.editor.state);
  expect(await editorMarkdown(f.ydoc)).toBe(`# Title\n\n${body}\n`);
});



