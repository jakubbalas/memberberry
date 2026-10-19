// @vitest-environment jsdom
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { afterEach, beforeAll, expect, it } from "vitest";
import { applyUpdate, Doc, encodeStateAsUpdate } from "yjs";
import { redo, undo } from "y-prosemirror";
import { Awareness } from "y-protocols/awareness";
import { load, schema, updateFromMarkdown, markdownFromUpdate } from "../notes.js";
import { createConnectionStatus, createYjsBinding, PROSEMIRROR_ROOT } from "./collaboration.js";
import { createMemberberryExtensions } from "./schema.js";
import { createBlockMover } from "./block-move.js";

const cleanups: (() => void)[] = [];
beforeAll(async () => { await load(readFileSync("src/wasm/mb_bg.wasm")); });
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
async function open(markdown = "# Title ^title\n\nAlpha ^a\n\n## Beta ^b\n\nGamma ^c\n") {
  const ydoc = new Doc();
  applyUpdate(ydoc, await updateFromMarkdown(markdown));
  const surface = document.createElement("div"); document.body.append(surface);
  const editor = new Editor({ element: surface, editorProps: { handleScrollToSelection: () => true }, extensions: [...createMemberberryExtensions(await schema()), createYjsBinding(ydoc.getXmlFragment(PROSEMIRROR_ROOT))] });
  cleanups.push(() => { editor.destroy(); ydoc.destroy(); surface.remove(); });
  const start = (index: number) => { let pos = 0; for (let i = 0; i < index; i++) pos += editor.state.doc.child(i).nodeSize; return pos; };
  const saved = () => markdownFromUpdate(encodeStateAsUpdate(ydoc));
  return { editor, ydoc, start, saved };
}
it("moves an adjacent complete block through actual Yjs/WASM and isolates move undo from earlier/later typing", async () => {
  const f = await open();
  f.editor.commands.setTextSelection(f.start(1) + 3);
  f.editor.view.dispatch(f.editor.state.tr.insertText("-before", f.start(1) + 6));
  const before = await f.saved();
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "adjacent" });
  cleanups.push(mover.destroy);
  const token = mover.capture(f.start(1) + 2);
  expect(token).toBeDefined();
  if (!token) throw new Error("capture missing");
  expect(mover.move(token, "down")).toBe(true);
  expect(await f.saved()).toBe("# Title ^title\n\n## Beta ^b\n\nAlpha-before ^a\n\nGamma ^c\n");
  expect(f.editor.state.doc.resolve(f.editor.state.selection.head).parent.textContent).toBe("Alpha-before");
  const moved = await f.saved();
  const reopened = await open(moved);
  expect(reopened.editor.state.doc.toJSON()).toEqual(f.editor.state.doc.toJSON());
  f.editor.view.dispatch(f.editor.state.tr.insertText("-later"));
  expect(undo(f.editor.state)).toBe(true);
  expect(await f.saved()).toBe(moved);
  expect(undo(f.editor.state)).toBe(true);
  expect(await f.saved()).toBe(before);
  expect(undo(f.editor.state)).toBe(true);
  expect(await f.saved()).toBe("# Title ^title\n\nAlpha ^a\n\n## Beta ^b\n\nGamma ^c\n");
});
it("moves just the selected bullet with its nested children and keeps its siblings in place", async () => {
  const f = await open("# Title\n\n- Alpha\n  - child\n- **Beta α🌍**\n- Gamma\n\nAfter\n");
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "bullet-row" }); cleanups.push(mover.destroy);
  const original = await f.saved();
  let pos = -1;
  f.editor.state.doc.descendants((node, start) => { if (node.isText && node.text === "Beta α🌍") pos = start; });
  f.editor.commands.setTextSelection(pos + 2);
  const token = mover.capture(pos); if (!token) throw new Error("missing bullet");
  expect(mover.move(token, "up")).toBe(true);
  expect(await f.saved()).toBe("# Title\n\n- **Beta α🌍**\n\n- Alpha\n\n  - child\n\n- Gamma\n\nAfter\n");
  expect(undo(f.editor.state)).toBe(true);
  expect(await f.saved()).toBe(original);
  expect(redo(f.editor.state)).toBe(true);
  expect(f.editor.state.selection.$head.parent.textContent).toBe("Beta α🌍");
});
it.each(["\n", "  \n", "\r\n", "\r"])("moves just one explicit text line separated by %j through save and reopen", async separator => {
  const f = await open(`# Title\n\nAlpha${separator}**Beta α🌍**${separator}Gamma\n\nAfter\n`);
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "text-row" }); cleanups.push(mover.destroy);
  let pos = -1;
  f.editor.state.doc.descendants((node, start) => { if (node.isText && node.text === "Beta α🌍") pos = start; });
  f.editor.commands.setTextSelection(pos + 2);
  const original = await f.saved();
  const token = mover.capture(pos); if (!token) throw new Error("missing line");
  expect(mover.move(token, "up")).toBe(true);
  const canonicalSeparator = separator === "  \n" ? "\\\n" : "\n";
  expect(await f.saved()).toBe(`# Title\n\n**Beta α🌍**${canonicalSeparator}Alpha${canonicalSeparator}Gamma\n\nAfter\n`);
  const reopened = await open(await f.saved()); expect(reopened.editor.state.doc.toJSON()).toEqual(f.editor.state.doc.toJSON());
  expect(undo(f.editor.state)).toBe(true); expect(await f.saved()).toBe(original);
  expect(f.editor.state.selection.$head.parentOffset).toBe(8);
});
function textPosition(editor: Editor, text: string): number {
  let found: number | undefined;
  editor.state.doc.descendants((node, pos) => { if (node.isText && node.text === text) found = pos; });
  if (found === undefined) throw new Error(`missing fixture text ${text}`);
  return found;
}
it.each([
  ["First\\\nSecond\nThird", "First", "Second\nThird"],
  ["First\nSecond\\\nThird", "Third", "First\nSecond"],
  ["First\\\nSecond\nThird", "Second", "First\\\nThird"],
])("deleting an explicit line retains the surviving separators (%s, %s)", async (body, removed, result) => {
  const f = await open(`# Title\n\n${body}\n`);
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "delete-line" }); cleanups.push(mover.destroy);
  const token = mover.captureRange(textPosition(f.editor, removed), textPosition(f.editor, removed));
  if (!token) throw new Error("missing line capture");
  expect(mover.edit(token, "delete")).toBe(true); expect(await f.saved()).toBe(`# Title\n\n${result}\n`);
});
it("deleting every nested item removes its list without removing its parent item", async () => {
  const f = await open("# Title\n\n- Parent\n  - Alpha\n  - Beta\n- Last\n");
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "delete-nested" }); cleanups.push(mover.destroy);
  const token = mover.captureRange(textPosition(f.editor, "Alpha"), textPosition(f.editor, "Beta"));
  if (!token) throw new Error("missing nested capture");
  expect(mover.edit(token, "delete")).toBe(true); expect(await f.saved()).toBe("# Title\n\n- Parent\n- Last\n");
});
it("deleting the first numbered item preserves unselected text anchors and the list start", async () => {
  const f = await open("# Title\n\n7. Alpha\n1. Beta ^kept-item\n1. Gamma\n");
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "delete-anchor" }); cleanups.push(mover.destroy);
  const token = mover.captureRange(textPosition(f.editor, "Alpha"), textPosition(f.editor, "Alpha"));
  if (!token) throw new Error("missing list capture");
  expect(mover.edit(token, "delete")).toBe(true);
  expect(f.editor.state.doc.child(1).attrs).toMatchObject({ start: 7 });
  expect(f.editor.state.doc.child(1).firstChild?.firstChild?.attrs["anchor"]).toBe("kept-item");
  const reopened = await open(await f.saved()); expect(reopened.editor.getJSON()).toEqual(f.editor.getJSON());
});
it("highlighted edits refuse a forged/stale token and loss of runtime editability", async () => {
  const f = await open(); let available = true;
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "edit-refusal", canInteract: () => available }); cleanups.push(mover.destroy);
  const token = mover.captureRange(f.start(1), f.start(2)); if (!token) throw new Error("missing edit capture");
  const before = await f.saved();
  expect(mover.edit({ ...token }, "delete")).toBe(false);
  available = false; expect(mover.edit(token, "delete")).toBe(false); available = true;
  f.editor.setEditable(false); expect(mover.edit(token, "delete")).toBe(false); f.editor.setEditable(true);
  expect(await f.saved()).toBe(before);
  f.editor.commands.insertContentAt(f.start(1) + 1, "changed ");
  const changed = await f.saved(); expect(mover.edit(token, "delete")).toBe(false); expect(await f.saved()).toBe(changed);
});
it.each(["pending", "offline", "peer"])("highlighted Delete refuses newly %s captures", async reason => {
  const f = await open(); const connection = createConnectionStatus(); connection.set({ connected: true, synced: true, pending: 0 });
  const awareness = new Awareness(f.ydoc); cleanups.push(() => awareness.destroy());
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "edit-state", connection, awareness }); cleanups.push(mover.destroy);
  const token = mover.captureRange(f.start(1), f.start(2)); if (!token) throw new Error("missing edit capture");
  const before = await f.saved();
  if (reason === "peer") awareness.getStates().set(f.ydoc.clientID + 1, { user: "peer" });
  else connection.set(reason === "pending" ? { connected: true, synced: true, pending: 1 } : { connected: false, synced: false, pending: 0 });
  expect(mover.edit(token, "delete")).toBe(false); expect(await f.saved()).toBe(before);
});
it("mixed and first-item indentation refuses the entire capture without partial restructuring", async () => {
  const f = await open("# Title\n\n- Alpha\n- Beta\n\nAfter\n");
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "indent-refusal" }); cleanups.push(mover.destroy);
  const first = mover.captureRange(textPosition(f.editor, "Alpha"), textPosition(f.editor, "Beta"));
  const mixed = mover.captureRange(textPosition(f.editor, "Beta"), textPosition(f.editor, "After"));
  if (!first || !mixed) throw new Error("missing refused capture");
  const before = await f.saved();
  expect(mover.edit(first, "indent")).toBe(false); expect(mover.edit(mixed, "indent")).toBe(false); expect(await f.saved()).toBe(before);
});
it("deletion preserves unselected paragraphs and isolated undo across arbitrary contiguous ranges", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 8 }), fc.nat(100), fc.nat(100), async (count, left, length) => {
    const f = await open("# Title\n\n" + Array.from({ length: count }, (_, i) => `Row ${i} α🌍\n\n`).join(""));
    const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: `delete-property-${f.ydoc.clientID}` }); cleanups.push(mover.destroy);
    const start = left % count; const size = 1 + length % (count - start);
    const token = mover.captureRange(f.start(start + 1), f.start(start + size)); if (!token) throw new Error("missing property capture");
    const before = await f.saved(); expect(mover.edit(token, "delete")).toBe(true);
    const expected = Array.from({ length: count }, (_, i) => `Row ${i} α🌍`).filter((_text, i) => i < start || i >= start + size);
    expect(f.editor.state.doc.content.content.slice(1).map(node => node.textContent)).toEqual(expected.length ? expected : [""]);
    expect(undo(f.editor.state)).toBe(true); expect(await f.saved()).toBe(before);
  }), { seed: 20261019, numRuns: 40 });
});
it("moves a contiguous mixed range in order, saves/reopens it and undoes it in one step", async () => {
  const f = await open("# Title\n\nBefore\n\n- **Alpha**\n- Beta\n\nMiddle\n\nAfter\n");
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "mixed-range" }); cleanups.push(mover.destroy);
  const original = await f.saved();
  const token = mover.captureRange(textPosition(f.editor, "Alpha"), textPosition(f.editor, "Middle"));
  if (!token) throw new Error("missing range");
  expect(token.count).toBe(3);
  expect(mover.drop(token, mover.targets(token).length)).toBe(true);
  expect(await f.saved()).toBe("# Title\n\nBefore\n\nAfter\n\n- **Alpha**\n- Beta\n\nMiddle\n");
  expect(mover.moved(token)?.count).toBe(3);
  const reopened = await open(await f.saved()); expect(reopened.editor.state.doc.toJSON()).toEqual(f.editor.state.doc.toJSON());
  expect(undo(f.editor.state)).toBe(true); expect(await f.saved()).toBe(original);
  expect(redo(f.editor.state)).toBe(true); expect(await f.saved()).toBe(await reopened.saved());
});
it("renumbers the source and destination when the first numbered group moves to another list", async () => {
  const f = await open("# Title\n\n1. Alpha\n2. Beta\n3. Gamma\n\nBetween\n\n7. Delta\n8. Epsilon\n");
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "numbered-group" }); cleanups.push(mover.destroy);
  const original = await f.saved();
  const token = mover.captureRange(textPosition(f.editor, "Alpha"), textPosition(f.editor, "Beta"));
  if (!token) throw new Error("missing numbered range");
  expect(mover.drop(token, mover.targets(token).length - 1)).toBe(true);
  expect(await f.saved()).toBe("# Title\n\n1. Gamma\n\nBetween\n\n7. Delta\n1. Alpha\n1. Beta\n1. Epsilon\n");
  const reopened = await open(await f.saved()); expect(reopened.editor.state.doc.toJSON()).toEqual(f.editor.state.doc.toJSON());
  expect(undo(f.editor.state)).toBe(true); expect(await f.saved()).toBe(original);
});
it("renumbers the remaining source after an individual first numbered item moves out", async () => {
  const f = await open("# Title\n\n1. Alpha\n2. Beta\n3. Gamma\n\nAfter\n");
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "numbered-first" }); cleanups.push(mover.destroy);
  const token = mover.capture(textPosition(f.editor, "Alpha")); if (!token) throw new Error("missing item");
  expect(mover.drop(token, mover.targets(token).length)).toBe(true);
  expect(await f.saved()).toBe("# Title\n\n1. Beta\n1. Gamma\n\nAfter\n\n1. Alpha\n");
});
it.each([false, true])("renumbers all items when a numbered group is reordered within its list (reverse=%j)", async reverse => {
  const f = await open("# Title\n\n1. Alpha\n2. Beta\n3. Gamma\n4. Delta\n");
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "numbered-within" }); cleanups.push(mover.destroy);
  const token = mover.captureRange(textPosition(f.editor, reverse ? "Gamma" : "Alpha"), textPosition(f.editor, reverse ? "Delta" : "Beta"));
  if (!token) throw new Error("missing numbered group");
  expect(mover.drop(token, reverse ? 1 : mover.targets(token).length)).toBe(true);
  expect(await f.saved()).toBe("# Title\n\n1. Gamma\n1. Delta\n1. Alpha\n1. Beta\n");
});
it("refuses title ranges, nested scope crossings, every internal drop boundary and stale group tokens", async () => {
  const f = await open("# Title\n\n- Parent\n  - Child\n- Sibling\n\nAfter\n");
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "range-refusals" }); cleanups.push(mover.destroy);
  expect(mover.captureRange(0, textPosition(f.editor, "After"))).toBeUndefined();
  expect(mover.captureRange(textPosition(f.editor, "Child"), textPosition(f.editor, "Sibling"))).toBeUndefined();
  expect(mover.captureRange(NaN, -1)).toBeUndefined();
  const token = mover.captureRange(textPosition(f.editor, "Sibling"), textPosition(f.editor, "Parent")); if (!token) throw new Error("missing range");
  for (let boundary = token.index; boundary <= token.index + token.count; boundary++) expect(mover.drop(token, boundary)).toBe(false);
  expect(mover.drop(token, 0)).toBe(false);
  f.editor.view.dispatch(f.editor.state.tr.insertText("x", textPosition(f.editor, "After")));
  expect(mover.drop(token, mover.targets(token).length)).toBe(false);
});
it("preserves group ordering and one-step undo for seeded list permutations", async () => {
  const f = await open("# Title\n\n1. Alpha\n2. Beta\n3. Gamma\n4. Delta\n5. Epsilon\n");
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "range-property" }); cleanups.push(mover.destroy);
  const original = f.editor.state.doc;
  const names = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"];
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 3 }), fc.integer({ min: 1, max: 4 }), fc.integer({ min: 0, max: 5 }), async (index, size, boundary) => {
    const count = Math.min(size, names.length - index);
    const token = mover.captureRange(textPosition(f.editor, names[index] ?? ""), textPosition(f.editor, names[index + count - 1] ?? ""));
    if (!token) throw new Error("missing seeded range");
    const noop = boundary >= index && boundary <= index + count;
    try {
      expect(mover.drop(token, boundary + 1)).toBe(!noop);
      if (!noop) {
        const expected = names.slice(); const moved = expected.splice(index, count);
        expected.splice(boundary > index ? boundary - count : boundary, 0, ...moved);
        expect(await f.saved()).toBe(`# Title\n\n${expected.map(name => `1. ${name}`).join("\n")}\n`);
      }
    } finally {
      if (!f.editor.state.doc.eq(original)) { expect(undo(f.editor.state)).toBe(true); expect(f.editor.state.doc.eq(original)).toBe(true); }
    }
  }), { seed: 20261018, numRuns: 32 });
});
it("moves several explicit lines together without losing breaks, marks or their unique paragraph anchor", async () => {
  const f = await open("# Title\n\nFirst\n**Second**\\\nThird\nFourth ^body\n\nAfter\n");
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "line-range" }); cleanups.push(mover.destroy);
  const original = await f.saved();
  const token = mover.captureRange(textPosition(f.editor, "Second"), textPosition(f.editor, "Third")); if (!token) throw new Error("missing line range");
  expect(mover.drop(token, mover.targets(token).length)).toBe(true);
  expect(await f.saved()).toBe("# Title\n\nFirst\nFourth ^body\n\nAfter\n\n**Second**\nThird\n");
  const reopened = await open(await f.saved()); expect(reopened.editor.state.doc.toJSON()).toEqual(f.editor.state.doc.toJSON());
  expect(undo(f.editor.state)).toBe(true); expect(await f.saved()).toBe(original);
});
it("moves a range of nested siblings with their subtrees while preserving the parent", async () => {
  const f = await open("# Title\n\n- Parent\n  - One\n    - Descendant\n  - Two\n  - Three\n- Outside\n");
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "nested-range" }); cleanups.push(mover.destroy);
  const before = f.editor.state.doc;
  const token = mover.captureRange(textPosition(f.editor, "One"), textPosition(f.editor, "Two")); if (!token) throw new Error("missing nested range");
  expect(mover.move(token, "down")).toBe(true);
  const list = f.editor.state.doc.child(1).child(0).child(1);
  expect(list.child(0).textContent).toBe("Three");
  expect(list.child(1).toJSON()).toEqual(before.child(1).child(0).child(1).child(0).toJSON());
  expect(f.editor.state.doc.child(1).child(1).eq(before.child(1).child(1))).toBe(true);
  const reopened = await open(await f.saved()); expect(reopened.editor.state.doc.toJSON()).toEqual(f.editor.state.doc.toJSON());
  expect(undo(f.editor.state)).toBe(true); expect(f.editor.state.doc.eq(before)).toBe(true);
});
it("keeps task metadata and subtrees exact when a group joins a differently numbered list", async () => {
  const f = await open("# Title\n\n1. [x] **Done** 📅 2026-10-03 ✅ 2026-10-04\n2. [ ] Todo\n3. Remaining\n\nBetween\n\n5. Destination\n");
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "task-range" }); cleanups.push(mover.destroy);
  const list = f.editor.state.doc.child(1);
  const token = mover.captureRange(textPosition(f.editor, "Done"), textPosition(f.editor, "Todo")); if (!token) throw new Error("missing task range");
  expect(mover.drop(token, mover.targets(token).length)).toBe(true);
  const result = f.editor.state.doc.lastChild;
  expect(result?.attrs["start"]).toBe(5);
  expect(result?.child(1).toJSON()).toEqual(list.child(0).toJSON());
  expect(result?.child(2).toJSON()).toEqual(list.child(1).toJSON());
  expect(f.editor.state.doc.child(1).attrs["start"]).toBe(1);
  const reopened = await open(await f.saved()); expect(reopened.editor.state.doc.toJSON()).toEqual(f.editor.state.doc.toJSON());
});
it("applies the same peer, transport, read-only, foreign-token and stale gates to group moves", async () => {
  const connection = createConnectionStatus(); connection.set({ connected: true, synced: true, pending: 0 });
  const f = await open(); const awareness = new Awareness(f.ydoc); cleanups.push(() => awareness.destroy());
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "guarded-range", connection, awareness }); cleanups.push(mover.destroy);
  const token = mover.captureRange(f.start(1) + 1, f.start(2) + 1); if (!token) throw new Error("missing guarded range");
  const original = await f.saved();
  connection.set({ connected: true, synced: true, pending: 1 }); expect(mover.move(token, "down")).toBe(false);
  connection.set({ connected: false, synced: false, pending: 0 }); expect(mover.move(token, "down")).toBe(false);
  connection.set({ connected: true, synced: true, pending: 0 });
  awareness.states.set(999, { user: { name: "peer" } }); expect(mover.move(token, "down")).toBe(false); awareness.states.delete(999);
  f.editor.setEditable(false); expect(mover.move(token, "down")).toBe(false); f.editor.setEditable(true);
  const g = await open(); const foreign = createBlockMover({ editor: g.editor, document: g.ydoc, noteKey: "foreign-range" }); cleanups.push(foreign.destroy);
  expect(foreign.move(token, "down")).toBe(false); expect(await f.saved()).toBe(original);
  expect(mover.move(token, "down")).toBe(true);
});
it("captures a bullet marker boundary as the individual item", async () => {
  const f = await open("# Title\n\n- Alpha\n- Beta\n- Gamma\n");
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "marker" }); cleanups.push(mover.destroy);
  const start = f.start(1) + 1;
  const token = mover.capture(start); if (!token) throw new Error("missing bullet marker");
  expect(token.label).toBe("Move list item");
  expect(mover.move(token, "down")).toBe(true);
  expect(await f.saved()).toBe("# Title\n\n- Beta\n- Alpha\n- Gamma\n");
});
it.each(["- Alpha\n- Beta", "Alpha\nBeta"])("captures a selection seed on the outer container boundary: %s", async body => {
  const f = await open(`# Title\n\n${body}\n`);
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "margin-boundary" }); cleanups.push(mover.destroy);
  const token = mover.captureRange(f.start(1), f.start(1));
  expect(token?.count).toBe(1);
  expect(token?.start).toBe(f.start(1) + 1);
});
it("reorders nested sibling bullets while keeping their parent and other siblings intact", async () => {
  const f = await open("# Title\n\n- Parent\n  - One\n  - Two\n- Sibling\n");
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "nested" }); cleanups.push(mover.destroy);
  const before = f.editor.state.doc;
  const token = mover.capture(textPosition(f.editor, "Two")); if (!token) throw new Error("missing nested item");
  expect(mover.move(token, "up")).toBe(true);
  const parent = f.editor.state.doc.child(1).child(0);
  expect(parent.child(0).eq(before.child(1).child(0).child(0))).toBe(true);
  expect(parent.child(1).child(0).eq(before.child(1).child(0).child(1).child(1))).toBe(true);
  expect(f.editor.state.doc.child(1).child(1).eq(before.child(1).child(1))).toBe(true);
  expect(undo(f.editor.state)).toBe(true); expect(f.editor.state.doc.eq(before)).toBe(true);
});
it("moves one bullet beyond its list without losing its siblings, marks or nested content on reopen", async () => {
  const f = await open("# Title\n\n- **Alpha**\n- Beta\n\nAfter\n");
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "outside-list" }); cleanups.push(mover.destroy);
  const item = f.editor.state.doc.child(1).child(0);
  const token = mover.capture(textPosition(f.editor, "Alpha")); if (!token) throw new Error("missing item");
  expect(mover.drop(token, mover.targets(token).length)).toBe(true);
  expect(f.editor.state.doc.lastChild?.firstChild?.eq(item)).toBe(true);
  expect(await f.saved()).toBe("# Title\n\n- Beta\n\nAfter\n\n- **Alpha**\n");
  const reopened = await open(await f.saved()); expect(reopened.editor.state.doc.toJSON()).toEqual(f.editor.state.doc.toJSON());
});
it("merges a moved bullet into a compatible destination list so save/reopen preserves the structure", async () => {
  const f = await open("# Title\n\n- Alpha\n- Beta\n\nBetween\n\n- Gamma\n- Delta\n");
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "between-lists" }); cleanups.push(mover.destroy);
  const token = mover.capture(textPosition(f.editor, "Alpha")); if (!token) throw new Error("missing item");
  expect(mover.drop(token, mover.targets(token).length - 1)).toBe(true);
  expect(await f.saved()).toBe("# Title\n\n- Beta\n\nBetween\n\n- Gamma\n- Alpha\n- Delta\n");
  const reopened = await open(await f.saved()); expect(reopened.editor.state.doc.toJSON()).toEqual(f.editor.state.doc.toJSON());
});
it("uses the destination numbering when moving an item between differently numbered lists", async () => {
  const f = await open("# Title\n\n1. Alpha\n2. Beta\n\nBetween\n\n7. Gamma\n8. Delta\n");
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "numbered-destination" }); cleanups.push(mover.destroy);
  const token = mover.capture(textPosition(f.editor, "Alpha")); if (!token) throw new Error("missing item");
  expect(mover.drop(token, mover.targets(token).length - 1)).toBe(true);
  expect(f.editor.state.doc.lastChild?.attrs["start"]).toBe(7);
  expect(f.editor.state.doc.lastChild?.childCount).toBe(3);
  const reopened = await open(await f.saved()); expect(reopened.editor.state.doc.toJSON()).toEqual(f.editor.state.doc.toJSON());
});
it("keeps a node selection on the moved bullet at an adjacent item boundary", async () => {
  const f = await open("# Title\n\n- Alpha\n- Beta\n- Gamma\n");
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "selected-item" }); cleanups.push(mover.destroy);
  const start = f.start(1) + 1 + f.editor.state.doc.child(1).child(0).nodeSize;
  f.editor.view.dispatch(f.editor.state.tr.setSelection(NodeSelection.create(f.editor.state.doc, start)));
  const token = mover.capture(start); if (!token) throw new Error("missing selected item");
  expect(mover.move(token, "up")).toBe(true);
  expect(f.editor.state.selection instanceof NodeSelection && f.editor.state.selection.node.textContent).toBe("Beta");
  expect(undo(f.editor.state)).toBe(true);
  expect(f.editor.state.selection.from).toBe(start);
});
it("retains an unrelated selected bullet while another item in the same list moves", async () => {
  const f = await open("# Title\n\n- Alpha\n- Beta\n- Gamma\n");
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "other-selected-item" }); cleanups.push(mover.destroy);
  const list = f.editor.state.doc.child(1);
  const start = f.start(1) + 1 + list.child(0).nodeSize + list.child(1).nodeSize;
  f.editor.view.dispatch(f.editor.state.tr.setSelection(NodeSelection.create(f.editor.state.doc, start)));
  const token = mover.capture(textPosition(f.editor, "Alpha")); if (!token) throw new Error("missing item");
  expect(mover.move(token, "down")).toBe(true);
  expect(f.editor.state.selection instanceof NodeSelection && f.editor.state.selection.node.textContent).toBe("Gamma");
});
it("moves one text line beyond its paragraph while preserving a unique block anchor and every inline mark", async () => {
  const f = await open("# Title\n\nAlpha\n**Beta α🌍**\nGamma ^body\n\nAfter\n");
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "outside-paragraph" }); cleanups.push(mover.destroy);
  const token = mover.capture(textPosition(f.editor, "Beta α🌍")); if (!token) throw new Error("missing line");
  expect(mover.drop(token, mover.targets(token).length)).toBe(true);
  expect(await f.saved()).toBe("# Title\n\nAlpha\nGamma ^body\n\nAfter\n\n**Beta α🌍**\n");
  const reopened = await open(await f.saved()); expect(reopened.editor.state.doc.toJSON()).toEqual(f.editor.state.doc.toJSON());
});
it("keeps line selection and mixed explicit separator kinds through move, undo and redo", async () => {
  const f = await open("# Title\n\nAlpha\n**Beta**\\\nGamma\n");
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "mixed-lines" }); cleanups.push(mover.destroy);
  const pos = textPosition(f.editor, "Beta");
  f.editor.commands.setTextSelection({ from: pos + 1, to: pos + 3 });
  const original = f.editor.state.doc;
  const token = mover.capture(pos); if (!token) throw new Error("missing line");
  expect(mover.move(token, "up")).toBe(true);
  expect(await f.saved()).toBe("# Title\n\n**Beta**\nAlpha\\\nGamma\n");
  expect(f.editor.state.doc.textBetween(f.editor.state.selection.from, f.editor.state.selection.to)).toBe("et");
  expect(undo(f.editor.state)).toBe(true); expect(f.editor.state.doc.eq(original)).toBe(true);
  expect(f.editor.state.selection.from).toBe(pos + 1);
  expect(redo(f.editor.state)).toBe(true);
  expect(f.editor.state.doc.textBetween(f.editor.state.selection.from, f.editor.state.selection.to)).toBe("et");
});
it("preserves numbered task item JSON and original list start through reordering", async () => {
  const f = await open("# Title\n\n3. [x] **Done** 📅 2026-10-03 ✅ 2026-10-04\n4. Plain\n5. [ ] Todo\n");
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "numbered" }); cleanups.push(mover.destroy);
  const original = f.editor.state.doc.child(1);
  const token = mover.capture(textPosition(f.editor, "Done")); if (!token) throw new Error("missing task");
  expect(mover.move(token, "down")).toBe(true);
  expect(f.editor.state.doc.child(1).attrs).toEqual(original.attrs);
  expect(f.editor.state.doc.child(1).child(1).toJSON()).toEqual(original.child(0).toJSON());
  const reopened = await open(await f.saved()); expect(reopened.editor.state.doc.toJSON()).toEqual(f.editor.state.doc.toJSON());
});
it.each(["- Alpha\n- Beta\n- Gamma", "Alpha\nBeta\nGamma"])("rechecks a captured individual unit after authority and source changes: %s", async body => {
  const f = await open(`# Title\n\n${body}\n`); let ready = true;
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: `unit-guard-${f.ydoc.clientID}`, canInteract: () => ready }); cleanups.push(mover.destroy);
  const token = mover.capture(textPosition(f.editor, "Beta")); if (!token) throw new Error("missing unit");
  const before = await f.saved();
  ready = false; expect(mover.move(token, "up")).toBe(false);
  ready = true; f.editor.setEditable(false); expect(mover.move(token, "up")).toBe(false);
  expect(await f.saved()).toBe(before);
  f.editor.setEditable(true);
  f.ydoc.getMap("frontmatter").set("version", "changed");
  const changed = await f.saved();
  expect(mover.move(token, "up")).toBe(false); expect(await f.saved()).toBe(changed);
});
it("preserves each bullet subtree exactly across seeded nonadjacent item moves and undo", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 4 }), async (index, boundary) => {
    const f = await open("# Title\n\n- **One**\n- [ ] Two 📅 2026-10-03\n- Three\n  - child\n- Four\n");
    const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: `item-property-${f.ydoc.clientID}` }); cleanups.push(mover.destroy);
    const original = f.editor.state.doc; const list = original.child(1);
    let pos = f.start(1) + 1; for (let i = 0; i < index; i++) pos += list.child(i).nodeSize;
    const token = mover.capture(pos + 2); if (!token) throw new Error("missing item");
    const expected: object[] = []; list.forEach(node => expected.push(node.toJSON() as object));
    const item = expected.splice(index, 1)[0]; if (!item) throw new Error("missing expected item");
    expected.splice(boundary > index ? boundary - 1 : boundary, 0, item);
    const changed = mover.drop(token, boundary + 1);
    expect(changed).toBe(boundary !== index && boundary !== index + 1);
    const actual: object[] = []; f.editor.state.doc.child(1).forEach(node => actual.push(node.toJSON() as object));
    expect(actual).toEqual(expected);
    const reopened = await open(await f.saved()); expect(reopened.editor.state.doc.toJSON()).toEqual(f.editor.state.doc.toJSON());
    if (changed) { expect(undo(f.editor.state)).toBe(true); expect(f.editor.state.doc.eq(original)).toBe(true); }
  }), { seed: 171026, numRuns: 24 });
});
it("refuses moving the original first H1 and preserves title identity", async () => {
  const f = await open(); const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "title" }); cleanups.push(mover.destroy);
  expect(mover.capture(2)).toBeUndefined();
  const title = f.editor.state.doc.firstChild;
  const token = mover.capture(f.start(1) + 1);
  if (!token) throw new Error("body capture missing");
  expect(mover.move(token, "up")).toBe(false);
  expect(f.editor.state.doc.firstChild?.eq(title ?? f.editor.state.doc)).toBe(true);
});
it("rechecks runtime read-only and caller readiness after capture", async () => {
  const f = await open(); let ready = true;
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "ready", canInteract: () => ready }); cleanups.push(mover.destroy);
  const token = mover.capture(f.start(1) + 1); if (!token) throw new Error("missing token");
  const before = await f.saved();
  f.editor.setEditable(false); expect(mover.move(token, "down")).toBe(false);
  f.editor.setEditable(true); ready = false; expect(mover.move(token, "down")).toBe(false);
  expect(await f.saved()).toBe(before);
});
it("rejects captures after source-equal Yjs character replacement", async () => {
  const f = await open(); const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "stale" }); cleanups.push(mover.destroy);
  const token = mover.capture(f.start(1) + 1); if (!token) throw new Error("missing token");
  const before = await f.saved();
  const { XmlElement, XmlText } = await import("yjs");
  const element = f.ydoc.getXmlFragment(PROSEMIRROR_ROOT).get(1);
  if (!(element instanceof XmlElement)) throw new Error("missing real Y element");
  const text = element.get(0); if (!(text instanceof XmlText)) throw new Error("missing real Y text");
  f.ydoc.transact(() => { const value = text.toString(); text.delete(0, text.length); text.insert(0, value); }, "source-equal-update");
  expect(await f.saved()).toBe(before);
  expect(mover.move(token, "down")).toBe(false);
});
it("drops nonadjacently on exact root boundaries and refuses no-op, invalid, foreign and expired captures", async () => {
  const f = await open(); const g = await open();
  const a = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "drop-a" });
  const b = createBlockMover({ editor: g.editor, document: g.ydoc, noteKey: "drop-b" }); cleanups.push(a.destroy, b.destroy);
  const token = a.capture(f.start(1) + 1); if (!token) throw new Error("missing token");
  expect(typeof a.drop, "boundary drop exists").toBe("function");
  if (typeof a.drop !== "function") return;
  const before = await f.saved();
  for (const boundary of [-1, 0, 1, 2, 5, 1.5, NaN]) expect(a.drop(token, boundary)).toBe(false);
  expect(b.drop(token, 4)).toBe(false);
  expect(await f.saved()).toBe(before);
  f.editor.commands.setTextSelection(f.start(3) + 3);
  expect(a.drop(token, 4)).toBe(true);
  expect(await f.saved()).toBe("# Title ^title\n\n## Beta ^b\n\nGamma ^c\n\nAlpha ^a\n");
  expect(f.editor.state.doc.resolve(f.editor.state.selection.head).parent.textContent).toBe("Gamma");
  expect(a.drop(token, 1)).toBe(false);
  a.destroy(); expect(a.capture(2)).toBeUndefined();
});
it("labels a nested table cell as its whole table and moves every child unchanged", async () => {
  const f = await open("# Title\n\n| H | B |\n| :--- | ---: |\n| α🌍 | **strong** |\n\nAfter\n");
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "table" }); cleanups.push(mover.destroy);
  const table = f.editor.state.doc.child(1);
  const token = mover.capture(f.start(1) + 3); if (!token) throw new Error("missing table token");
  expect(token.label).toBe("Move table");
  expect(mover.move(token, "down")).toBe(true);
  expect(f.editor.state.doc.child(2).toJSON()).toEqual(table.toJSON());
  const reopen = await open(await f.saved()); expect(reopen.editor.state.doc.toJSON()).toEqual(f.editor.state.doc.toJSON());
});
it("moves a task item with its status/due/done, nested children and marks", async () => {
  const f = await open("# Title\n\n- [x] **Done α🌍** 📅 2026-10-03 ✅ 2026-10-04\n  - child [link](https://example.com)\n- [ ] sibling\n\nAfter\n");
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "task" }); cleanups.push(mover.destroy);
  const list = f.editor.state.doc.child(1);
  const token = mover.capture(f.start(1) + 4); if (!token) throw new Error("missing list token");
  expect(token.label).toBe("Move task item");
  expect(mover.move(token, "down")).toBe(true);
  expect(f.editor.state.doc.child(1).child(1).toJSON()).toEqual(list.child(0).toJSON());
  expect(f.editor.state.doc.child(1).child(0).toJSON()).toEqual(list.child(1).toJSON());
  const reopen = await open(await f.saved()); expect(reopen.editor.state.doc.toJSON()).toEqual(f.editor.state.doc.toJSON());
});
it("refuses known peers, duplicate mounted note keys and routed unsynced/offline/pending writes", async () => {
  const f = await open(); const g = await open();
  const connection = createConnectionStatus(); const awareness = new Awareness(f.ydoc); cleanups.push(() => awareness.destroy());
  connection.set({ connected: true, synced: true, pending: 0 });
  const a = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "shared", connection, awareness }); cleanups.push(a.destroy);
  const token = a.capture(f.start(1) + 1); if (!token) throw new Error("missing token");
  const before = await f.saved();
  for (const state of [{ connected: false, synced: true, pending: 0 }, { connected: true, synced: false, pending: 0 }, { connected: true, synced: true, pending: 1 }]) {
    connection.set(state); expect(a.move(token, "down")).toBe(false);
  }
  connection.set({ connected: true, synced: true, pending: 0 });
  awareness.states.set(12345, { user: { name: "known peer" } }); expect(a.move(token, "down")).toBe(false); awareness.states.delete(12345);
  const b = createBlockMover({ editor: g.editor, document: g.ydoc, noteKey: "shared" }); cleanups.push(b.destroy);
  expect(a.move(token, "down")).toBe(false); b.destroy();
  expect(await f.saved()).toBe(before);
  expect(a.move(token, "down")).toBe(true);
});
it("invalidates captures on any observed Yjs update and binds the exact document lifetime", async () => {
  const f = await open(); const g = await open();
  const wrong = createBlockMover({ editor: f.editor, document: g.ydoc, noteKey: "wrong-doc" }); cleanups.push(wrong.destroy);
  expect(wrong.capture(f.start(1) + 1)).toBeUndefined(); wrong.destroy();
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "generation" }); cleanups.push(mover.destroy);
  const token = mover.capture(f.start(1) + 1); if (!token) throw new Error("missing token");
  f.ydoc.getMap("frontmatter").set("probe", "changed outside visible PM doc");
  expect(mover.move(token, "down")).toBe(false);
});
it("subscribes to safety changes and removes awareness/connection/document/editor registrations on teardown", async () => {
  const f = await open(); const awareness = new Awareness(f.ydoc); cleanups.push(() => awareness.destroy());
  const status = createConnectionStatus(); status.set({ connected: true, synced: true, pending: 0 });
  let subscribed = 0; let unsubscribed = 0;
  const connection = { get state() { return status.state; }, subscribe(listener: Parameters<typeof status.subscribe>[0]) { subscribed++; const off = status.subscribe(listener); return () => { unsubscribed++; off(); }; } };
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "lifecycle", awareness, connection });
  expect(typeof mover.subscribe, "safety subscription exists").toBe("function");
  if (typeof mover.subscribe !== "function") { mover.destroy(); return; }
  let changes = 0; const off = mover.subscribe(() => changes++);
  status.set({ connected: false, synced: false, pending: 0 }); expect(changes).toBeGreaterThan(0);
  const after = changes; mover.destroy(); mover.destroy();
  status.set({ connected: true, synced: true, pending: 0 });
  awareness.emit("change", [{ added: [], updated: [], removed: [] }, "test"]);
  expect(changes).toBe(after); expect(subscribed).toBe(1); expect(unsubscribed).toBe(1); off();
  const fresh = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "lifecycle" }); cleanups.push(fresh.destroy);
  expect(fresh.capture(f.start(1) + 1)).toBeDefined(); f.editor.destroy();
  const g = await open(); const reopened = createBlockMover({ editor: g.editor, document: g.ydoc, noteKey: "lifecycle" }); cleanups.push(reopened.destroy);
  expect(reopened.capture(g.start(1) + 1)).toBeDefined();
});
it("never promotes a body H1 into title position in a note without a leading title", async () => {
  const f = await open("First paragraph\n\n# Body H1\n\nLast\n");
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "no-title" }); cleanups.push(mover.destroy);
  const first = mover.capture(1); const heading = mover.capture(f.start(1) + 1);
  if (!first || !heading) throw new Error("missing captures");
  expect(mover.drop(heading, 0)).toBe(false);
  expect(mover.move(first, "down")).toBe(false);
  expect(await f.saved()).toBe("First paragraph\n\n# Body H1\n\nLast\n");
});
it("preserves explicit stored marks for later typing at the relocated caret", async () => {
  const f = await open(); const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "stored-marks" }); cleanups.push(mover.destroy);
  f.editor.commands.setTextSelection(f.start(1) + 3);
  const strong = f.editor.schema.marks["strong"]; if (!strong) throw new Error("missing strong");
  f.editor.view.dispatch(f.editor.state.tr.setStoredMarks([strong.create()]));
  const token = mover.capture(f.start(1) + 1); if (!token) throw new Error("missing capture");
  expect(mover.move(token, "down")).toBe(true); f.editor.view.dispatch(f.editor.state.tr.insertText("X"));
  expect(await f.saved()).toContain("Al**X**pha ^a");
});
it("retains a nonempty logical text range when its current complete root moves", async () => {
  const f = await open(); const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "range" }); cleanups.push(mover.destroy);
  f.editor.commands.setTextSelection({ from: f.start(1) + 2, to: f.start(1) + 5 });
  const text = f.editor.state.doc.textBetween(f.editor.state.selection.from, f.editor.state.selection.to);
  const token = mover.capture(f.start(1) + 1); if (!token) throw new Error("capture missing"); expect(mover.drop(token, 4)).toBe(true);
  expect(f.editor.state.doc.textBetween(f.editor.state.selection.from, f.editor.state.selection.to)).toBe(text);
  expect(f.editor.state.selection.empty).toBe(false);
});
it("writes actual moved Yjs bytes and canonical Markdown to disk and reopens each with the installed WASM/schema", async () => {
  const f = await open(); const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "durable-local" }); cleanups.push(mover.destroy);
  const token = mover.capture(f.start(1) + 1); if (!token) throw new Error("capture missing"); expect(mover.drop(token, 4)).toBe(true);
  const folder = mkdtempSync(join(process.env["MB_BLOCK_MOVE_RECEIPTS"] ?? tmpdir(), "durable-local-"));
  const bytes = encodeStateAsUpdate(f.ydoc); const source = await f.saved();
  writeFileSync(join(folder, "moved.bin"), bytes); writeFileSync(join(folder, "moved.md"), source);
  writeFileSync(join(folder, "moved-pm.json"), JSON.stringify(f.editor.state.doc.toJSON(), null, 2));
  const diskDoc = new Doc(); applyUpdate(diskDoc, readFileSync(join(folder, "moved.bin"))); cleanups.push(() => diskDoc.destroy());
  expect(await markdownFromUpdate(encodeStateAsUpdate(diskDoc))).toBe(source);
  const reopened = await open(readFileSync(join(folder, "moved.md"), "utf8")); expect(reopened.editor.state.doc.toJSON()).toEqual(f.editor.state.doc.toJSON());
});
it("keeps complete root content and logical caret across seeded nonadjacent orders and real undo", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 5 }), fc.integer({ min: 1, max: 4 }), async (index, boundary, selected) => {
    const f = await open("# Title ^title\n\nEcho ^a\n\n## Echo ^b\n\n**Echo α🌍** ^c\n\n> Echo quote\n");
    const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: `property-${f.ydoc.clientID}` }); cleanups.push(mover.destroy);
    const original: object[] = []; f.editor.state.doc.forEach(node => original.push(node.toJSON() as object));
    const selectedRoot = f.editor.state.doc.child(selected);
    f.editor.commands.setTextSelection(f.start(selected) + (selectedRoot.type.name === "blockquote" ? 3 : 2));
    const token = mover.capture(f.start(index) + 1); if (!token) throw new Error("capture missing");
    const before = await f.saved();
    const expected = original.slice(); const moved = expected.splice(index, 1)[0]; if (!moved) throw new Error("expected node missing");
    expected.splice(boundary > index ? boundary - 1 : boundary, 0, moved);
    const changed = mover.drop(token, boundary);
    expect(changed).toBe(boundary !== index && boundary !== index + 1);
    const actual: object[] = []; f.editor.state.doc.forEach(node => actual.push(node.toJSON() as object)); expect(actual).toEqual(expected);
    expect(f.editor.state.doc.child(f.editor.state.selection.$head.index(0)).textContent).toBe(selectedRoot.textContent);
    if (changed) { expect(undo(f.editor.state)).toBe(true); expect(await f.saved()).toBe(before); }
  }), { seed: 42026, numRuns: 30 });
});
for (const [kind, source, expectedLabel] of [
  ["paragraph", "**α🌍** [link](https://example.com \"Title\") ^p", "Move paragraph"],
  ["heading", "## Heading α ^h", "Move heading"],
  ["ordered_list", "3. first\n4. second\n   - nested", "Move numbered list"],
  ["bullet_list", "- first\n  - nested\n- second", "Move list"],
  ["callout", "> [!warning]- **Notice**\n>\n> child [link](https://example.com)", "Move callout"],
  ["blockquote", "> quote α\n>\n> - nested", "Move quote"],
  ["code_block", "```ts\nconst α = '🌍';\n```", "Move code block"],
  ["math_block", "$$\nx+y=α\n$$", "Move math block"],
  ["paragraph-image", "![Alt α🌍](media/image.png \"Image title\")", "Move image"],
  ["divider", "***", "Move divider"],
] as const) {
  it(`preserves complete ${kind} root JSON/attrs/children through move, WASM materialization and reopen`, async () => {
    const f = await open(`# Title ^title\n\n${source}\n\nAfter ^after\n`);
    const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: kind }); cleanups.push(mover.destroy);
    const root = f.editor.state.doc.child(1); const title = f.editor.state.doc.firstChild;
    const yTitle = f.ydoc.getXmlFragment(PROSEMIRROR_ROOT).get(0);
    const token = mover.capture(f.start(1) + (root.isLeaf || kind.endsWith("_list") ? 0 : 1)); if (!token) throw new Error("missing capture");
    expect(token.label).toBe(expectedLabel);
    if (root.isAtom) f.editor.view.dispatch(f.editor.state.tr.setSelection(NodeSelection.create(f.editor.state.doc, f.start(1))));
    expect(mover.move(token, "down")).toBe(true);
    expect(f.editor.state.doc.child(2).toJSON()).toEqual(root.toJSON());
    expect(f.editor.state.doc.firstChild?.eq(title ?? root)).toBe(true);
    expect(f.ydoc.getXmlFragment(PROSEMIRROR_ROOT).get(0)).toBe(yTitle);
    const reopened = await open(await f.saved()); expect(reopened.editor.state.doc.toJSON()).toEqual(f.editor.state.doc.toJSON());
    expect(undo(f.editor.state)).toBe(true); expect(f.editor.state.doc.child(1).toJSON()).toEqual(root.toJSON());
  });
}

const ATOM_NOTE = "# Title\n\nAlpha ![a](media/a.png)\n\nBeta\n\nGamma\n\nDelta\n";
function selectImage(f: Awaited<ReturnType<typeof open>>): void {
  let image = -1;
  f.editor.state.doc.descendants((node, pos) => { if (node.type.name === "image") image = pos; });
  f.editor.view.dispatch(f.editor.state.tr.setSelection(NodeSelection.create(f.editor.state.doc, image)));
}
it("keeps a nested atom's node selection on that atom after its root moves", async () => {
  const f = await open(ATOM_NOTE); const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "nested-atom" }); cleanups.push(mover.destroy);
  selectImage(f);
  const token = mover.capture(f.start(1) + 1); if (!token) throw new Error("capture missing");
  expect(mover.move(token, "down")).toBe(true);
  const selection = f.editor.state.selection;
  expect(selection instanceof NodeSelection ? selection.node.type.name : selection.constructor.name).toBe("image");
});
it("returns the caret to the moved block on undo and on redo", async () => {
  const f = await open(ATOM_NOTE); const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "undo-caret" }); cleanups.push(mover.destroy);
  f.editor.commands.setTextSelection(f.start(1) + 3);
  const token = mover.capture(f.start(1) + 1); if (!token) throw new Error("capture missing");
  expect(mover.move(token, "down")).toBe(true);
  const caret = () => { const { $head } = f.editor.state.selection; return [f.editor.state.doc.child($head.index(0)).textContent, $head.parentOffset]; };
  expect(undo(f.editor.state)).toBe(true); const afterUndo = caret();
  expect(redo(f.editor.state)).toBe(true); const afterRedo = caret();
  expect([afterUndo, afterRedo]).toEqual([["Alpha ", 2], ["Alpha ", 2]]);
});
