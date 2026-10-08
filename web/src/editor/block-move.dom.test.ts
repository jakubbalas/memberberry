// @vitest-environment jsdom
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { afterEach, beforeAll, expect, it } from "vitest";
import { applyUpdate, Doc, encodeStateAsUpdate } from "yjs";
import { undo } from "y-prosemirror";
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
it("labels a nested task as its whole list and preserves status/due/done, nested children and marks", async () => {
  const f = await open("# Title\n\n- [x] **Done α🌍** 📅 2026-10-03 ✅ 2026-10-04\n  - child [link](https://example.com)\n- [ ] sibling\n\nAfter\n");
  const mover = createBlockMover({ editor: f.editor, document: f.ydoc, noteKey: "task" }); cleanups.push(mover.destroy);
  const list = f.editor.state.doc.child(1);
  const token = mover.capture(f.start(1) + 4); if (!token) throw new Error("missing list token");
  expect(token.label).toBe("Move task list");
  expect(mover.move(token, "down")).toBe(true);
  expect(f.editor.state.doc.child(2).toJSON()).toEqual(list.toJSON());
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
    const token = mover.capture(f.start(1) + (root.isLeaf ? 0 : 1)); if (!token) throw new Error("missing capture");
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
