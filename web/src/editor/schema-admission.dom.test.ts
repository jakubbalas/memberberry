// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { Doc, XmlElement, XmlText, applyUpdate, encodeStateAsUpdate, encodeStateVector } from "yjs";
import bundledSchema from "../../../crates/mb-core/schema.json";
import { load, noteBridge } from "../notes.js";
import { startNoteEditor } from "./note-editor.js";
import { createMemberberryExtensions } from "./schema.js";
import { SCHEMA_VERSION } from "./schema-revision.js";
import { createSyncProvider, encodeBinaryFrame } from "./sync.js";

beforeAll(async () => { await load(readFileSync(`${process.cwd()}/src/wasm/mb_bg.wasm`)); });

describe("pre-ySync local validation", () => {
  it.each([1, 2])("keeps the real bound ySync editor and live CRDT untouched on an unknown inbound mark (tag %s)", async (tag) => {
    class Socket extends EventTarget {
      readyState: number = WebSocket.CONNECTING; binaryType: BinaryType = "arraybuffer"; sent: unknown[] = [];
      send(value: unknown): void { this.sent.push(value); }
      close(): void { this.readyState = WebSocket.CLOSED; }
    }
    const bridge = await noteBridge(); const initial = bridge.updateFromMarkdown("# Title\n\nKEEP BODY\n");
    const element = document.createElement("div"); document.body.append(element); const socket = new Socket();
    const session = await startNoteEditor({ element, vaultId: "v", noteId: "bound-receive",
      createPersistence: (_name, document) => { applyUpdate(document, initial); return { whenSynced: Promise.resolve(), destroy: async () => undefined }; },
      remoteSync: { endpoint: "ws://fixture", vault: "v", note: "n.md", user: "alice" },
      createRemoteSync: (options, document, awareness, onConnectionChange, onServerState) => createSyncProvider({ ...options, document, awareness, onConnectionChange, onServerState, connect: () => socket as unknown as WebSocket, network: new EventTarget() }),
      loadExtensions: async () => createMemberberryExtensions(bundledSchema), loadEmojiCatalog: async () => [],
    });
    try {
      const editor = session.editor as Editor; const live = session.collaboration.document;
      socket.readyState = WebSocket.OPEN; socket.dispatchEvent(new Event("open"));
      socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "admitted", vault: "v", note: "n.md", schema_version: SCHEMA_VERSION }) }));
      socket.dispatchEvent(new MessageEvent("message", { data: encodeBinaryFrame(1, "v", "n.md", encodeStateAsUpdate(live)).buffer }));
      editor.view.dispatch(editor.state.tr.insertText("pending ", editor.state.doc.child(0).nodeSize + 1));
      expect(session.collaboration.connection?.state.pending).toBe(1);
      const before = encodeStateAsUpdate(live); const view = editor.getJSON(); const sent = socket.sent.length;
      const remote = new Doc(); applyUpdate(remote, before); const vector = encodeStateVector(remote);
      const paragraph = remote.getXmlFragment("prosemirror").get(1) as XmlElement;
      (paragraph.get(0) as XmlText).format(0, 1, { future_mark: {} });
      const update = encodeStateAsUpdate(remote, tag === 1 ? undefined : vector);
      const observed: Uint8Array[] = []; live.on("update", (bytes: Uint8Array) => observed.push(bytes));
      socket.dispatchEvent(new MessageEvent("message", { data: encodeBinaryFrame(tag, "v", "n.md", update).buffer }));
      expect(encodeStateAsUpdate(live)).toEqual(before); expect(editor.getJSON()).toEqual(view);
      expect(observed).toEqual([]); expect(socket.sent.length).toBe(sent);
      expect(session.collaboration.connection?.state).toMatchObject({ refreshRequired: true, pending: 1, synced: false });
      editor.view.dispatch(editor.state.tr.insertText("must not type ", editor.state.doc.child(0).nodeSize + 1));
      expect(encodeStateAsUpdate(live)).toEqual(before); remote.destroy();
    } finally { await session.destroy(); element.remove(); }
  });

  it("refuses an invalid heading attribute before the original Y document or pending state changes", async () => {
    const bridge = await noteBridge(); const initial = bridge.updateFromMarkdown("# Title\n\n## Body\n\nkeep\n");
    const element = document.createElement("div"); document.body.append(element);
    const session = await startNoteEditor({ element, vaultId: "v", noteId: "local-validation",
      createPersistence: (_name, document) => { applyUpdate(document, initial); return { whenSynced: Promise.resolve(), destroy: async () => undefined }; },
      loadExtensions: async () => createMemberberryExtensions(bundledSchema), loadEmojiCatalog: async () => [],
    });
    try {
      const editor = session.editor as Editor;
      const bytes = encodeStateAsUpdate(session.collaboration.document); const before = editor.getJSON();
      const updates: Uint8Array[] = []; session.collaboration.document.on("update", (update: Uint8Array) => updates.push(update));
      const bodyPosition = editor.state.doc.child(0).nodeSize;
      editor.view.dispatch(editor.state.tr.setNodeMarkup(bodyPosition, undefined, { level: 99, anchor: null }));
      expect(editor.getJSON()).toEqual(before);
      expect(encodeStateAsUpdate(session.collaboration.document)).toEqual(bytes);
      expect(updates).toEqual([]);
      const link = editor.schema.marks["link"];
      if (link === undefined) throw new Error("shared link mark missing");
      editor.view.dispatch(editor.state.tr.addMark(bodyPosition + 1, bodyPosition + 3, link.create({ href: 99 })));
      expect(editor.getJSON()).toEqual(before); expect(updates).toEqual([]);
      editor.view.dispatch(editor.state.tr.insertText("changed ", bodyPosition + 1));
      expect(bridge.markdownFromUpdate(encodeStateAsUpdate(session.collaboration.document))).toContain("changed Body");
    } finally { await session.destroy(); element.remove(); }
  });
});
