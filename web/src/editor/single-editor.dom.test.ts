// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { Editor } from "@tiptap/core";
import { afterEach, beforeAll, expect, it } from "vitest";
import { applyUpdate, Doc } from "yjs";
import { Awareness } from "y-protocols/awareness";
import { load, schema, updateFromMarkdown } from "../notes.js";
import { createConnectionStatus, createYjsBinding, PROSEMIRROR_ROOT } from "./collaboration.js";
import { createMemberberryExtensions } from "./schema.js";
import { createSingleEditorGate } from "./single-editor.js";

const cleanups: (() => void)[] = [];
beforeAll(async () => { await load(readFileSync("src/wasm/mb_bg.wasm")); });
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
async function open() {
  const ydoc = new Doc();
  applyUpdate(ydoc, await updateFromMarkdown("# Title\n\nBody\n"));
  const surface = document.createElement("div"); document.body.append(surface);
  const editor = new Editor({ element: surface, extensions: [...createMemberberryExtensions(await schema()), createYjsBinding(ydoc.getXmlFragment(PROSEMIRROR_ROOT))] });
  cleanups.push(() => { editor.destroy(); ydoc.destroy(); surface.remove(); });
  return { editor, ydoc };
}

it("passes for one bound editor of a routed note with no known peers", async () => {
  const f = await open();
  const gate = createSingleEditorGate({ editor: f.editor, document: f.ydoc, noteKey: "alone" }); cleanups.push(gate.destroy);
  expect(gate.refusal()).toBeUndefined();
});

it("treats several controllers on one editor as one mount, not a duplicate", async () => {
  const f = await open();
  const conversion = createSingleEditorGate({ editor: f.editor, document: f.ydoc, noteKey: "controllers" }); cleanups.push(conversion.destroy);
  const movement = createSingleEditorGate({ editor: f.editor, document: f.ydoc, noteKey: "controllers" }); cleanups.push(movement.destroy);
  expect(conversion.refusal()).toBeUndefined();
});

it("refuses a second editor of the same note and tells the first when it closes", async () => {
  const f = await open(); const g = await open();
  const first = createSingleEditorGate({ editor: f.editor, document: f.ydoc, noteKey: "twice" }); cleanups.push(first.destroy);
  let notified = 0; first.subscribe(() => notified++);
  const second = createSingleEditorGate({ editor: g.editor, document: g.ydoc, noteKey: "twice" });
  expect(first.refusal()).toBe("duplicate");
  second.destroy();
  expect([first.refusal(), notified]).toEqual([undefined, 2]);
});

it("releases its mount when the editor is destroyed", async () => {
  const f = await open(); const g = await open();
  createSingleEditorGate({ editor: f.editor, document: f.ydoc, noteKey: "editor-destroyed" });
  const other = createSingleEditorGate({ editor: g.editor, document: g.ydoc, noteKey: "editor-destroyed" }); cleanups.push(other.destroy);
  f.editor.destroy();
  expect(other.refusal()).toBeUndefined();
});

it("reports known peers, offline transport and unsent writes in that order of precedence", async () => {
  const f = await open();
  const peerDoc = new Doc(); const awareness = new Awareness(peerDoc); cleanups.push(() => { awareness.destroy(); peerDoc.destroy(); });
  const connection = createConnectionStatus(); connection.set({ connected: true, synced: true, pending: 1 });
  const gate = createSingleEditorGate({ editor: f.editor, document: f.ydoc, noteKey: "states", awareness, connection }); cleanups.push(gate.destroy);
  const seen = [gate.refusal()];
  connection.set({ connected: true, synced: false, pending: 1 }); seen.push(gate.refusal());
  awareness.states.set(7, { user: { name: "peer" } }); seen.push(gate.refusal());
  expect(seen).toEqual(["pending", "offline", "peer"]);
});

it("fails closed for an empty note key, a foreign document or after teardown", async () => {
  const f = await open(); const g = await open();
  const unkeyed = createSingleEditorGate({ editor: f.editor, document: f.ydoc, noteKey: "" }); cleanups.push(unkeyed.destroy);
  const foreign = createSingleEditorGate({ editor: f.editor, document: g.ydoc, noteKey: "foreign" }); cleanups.push(foreign.destroy);
  const closed = createSingleEditorGate({ editor: f.editor, document: f.ydoc, noteKey: "closed" }); closed.destroy();
  expect([unkeyed.refusal(), foreign.refusal(), closed.refusal()]).toEqual(["unbound", "unbound", "unbound"]);
});

it("stops notifying and unsubscribes from transport and presence on teardown", async () => {
  const f = await open();
  const peerDoc = new Doc(); const awareness = new Awareness(peerDoc); cleanups.push(() => { awareness.destroy(); peerDoc.destroy(); });
  const status = createConnectionStatus(); status.set({ connected: true, synced: true, pending: 0 });
  let unsubscribed = 0;
  const connection = { get state() { return status.state; }, subscribe(listener: Parameters<typeof status.subscribe>[0]) { const off = status.subscribe(listener); return () => { unsubscribed++; off(); }; } };
  const gate = createSingleEditorGate({ editor: f.editor, document: f.ydoc, noteKey: "teardown", awareness, connection });
  let changes = 0; gate.subscribe(() => changes++);
  gate.destroy(); gate.destroy();
  status.set({ connected: false, synced: false, pending: 0 });
  awareness.emit("change", [{ added: [], updated: [], removed: [] }, "test"]);
  expect([changes, unsubscribed]).toEqual([0, 1]);
});
