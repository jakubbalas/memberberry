import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Doc, XmlElement, XmlText, applyUpdate, encodeStateAsUpdate, encodeStateVector } from "yjs";
import { load, noteBridge } from "../notes.js";
import { createLoadedSchemaAdmission, SCHEMA_VERSION } from "./schema-admission.js";
import { createSyncProvider, encodeBinaryFrame, type ConnectionState } from "./sync.js";

beforeAll(async () => { await load(readFileSync(new URL("../wasm/mb_bg.wasm", import.meta.url))); });
class Socket extends EventTarget {
  readyState: number = WebSocket.CONNECTING; binaryType = "arraybuffer";
  readonly sent: (string | Uint8Array)[] = []; closed = 0;
  send(value: string | Uint8Array): void { this.sent.push(value); }
  close(): void { this.closed++; this.readyState = WebSocket.CLOSED; }
  open(): void { this.readyState = WebSocket.OPEN; this.dispatchEvent(new Event("open")); }
  message(data: unknown): void { this.dispatchEvent(new MessageEvent("message", { data })); }
  admit(version: unknown = SCHEMA_VERSION): void {
    this.message(JSON.stringify({ type: "admitted", vault: "v", note: "n.md", schema_version: version }));
  }
  receive(update: Uint8Array, tag = 1): void { this.message(encodeBinaryFrame(tag, "v", "n.md", update).buffer); }
}

async function fixture() {
  const bridge = await noteBridge(); const doc = new Doc();
  applyUpdate(doc, bridge.updateFromMarkdown("# Title\n\nKEEP BODY\n"));
  const socket = new Socket(); const network = new EventTarget(); const changes: ConnectionState[] = [];
  const connect = vi.fn(() => socket as unknown as WebSocket);
  const admission = createLoadedSchemaAdmission();
  const sync = createSyncProvider({ admission, endpoint: "ws://fixture", vault: "v", note: "n.md", document: doc, connect, network, onConnectionChange: (state) => changes.push(state) });
  return { bridge, doc, socket, network, changes, connect, sync, admission };
}

function unknownUpdate(): Uint8Array {
  const doc = new Doc(); const element = new XmlElement("future_block"); const text = new XmlText();
  element.insert(0, [text]); doc.getXmlFragment("prosemirror").insert(0, [element]); text.insert(0, "KEEP FUTURE CONTENT");
  const bytes = encodeStateAsUpdate(doc); doc.destroy(); return bytes;
}

describe("receive admission", () => {
  it.each(["future_mark", "future_attribute", "corrupt"])("preserves the bound-state candidate and pending edits on incremental %s", async (kind) => {
    const { doc, socket, sync } = await fixture();
    try {
      socket.open(); socket.admit(); socket.receive(encodeStateAsUpdate(doc));
      const block = doc.getXmlFragment("prosemirror").get(1) as XmlElement;
      (block.get(0) as XmlText).insert(0, "pending ");
      const before = encodeStateAsUpdate(doc); const remote = new Doc(); applyUpdate(remote, before);
      const vector = encodeStateVector(remote); const remoteBlock = remote.getXmlFragment("prosemirror").get(1) as XmlElement;
      if (kind === "future_mark") (remoteBlock.get(0) as XmlText).format(0, 1, { future_mark: {} });
      if (kind === "future_attribute") remoteBlock.setAttribute("future_attribute", "red");
      const update = kind === "corrupt" ? new Uint8Array([255]) : encodeStateAsUpdate(remote, vector);
      const sentBefore = socket.sent.length; socket.receive(update, 2);
      expect(encodeStateAsUpdate(doc)).toEqual(before); expect(sync.pending).toBe(1);
      expect(sync.refreshRequired).toBe(true); expect(socket.sent.length).toBe(sentBefore);
      remote.destroy();
    } finally { sync.destroy(); doc.destroy(); }
  });

  it("acknowledges an exact durable echo without a redundant full-note receive scan", async () => {
    const { doc, socket, sync, admission } = await fixture();
    const validate = vi.spyOn(admission, "validateIncoming");
    try {
      socket.open(); socket.admit(); socket.receive(encodeStateAsUpdate(doc));
      expect(validate).toHaveBeenCalledOnce();
      const block = doc.getXmlFragment("prosemirror").get(1) as XmlElement;
      (block.get(0) as XmlText).insert(0, "typed ");
      const sent = socket.sent.find((frame): frame is Uint8Array => frame instanceof Uint8Array);
      socket.message(sent?.buffer);
      expect(sync.pending).toBe(0); expect(validate).toHaveBeenCalledOnce();
    } finally { sync.destroy(); doc.destroy(); }
  });
  it.each([undefined, null, SCHEMA_VERSION - 1, SCHEMA_VERSION + 1, "1", 1.5])("refuses invalid/missing acknowledgement terminally (%s)", async (version) => {
    const { doc, socket, sync, connect, network, changes } = await fixture();
    vi.useFakeTimers();
    try {
      socket.open(); const before = encodeStateAsUpdate(doc);
      socket.message(JSON.stringify({ type: "admitted", vault: "v", note: "n.md", schema_version: version }));
      expect(sync.refreshRequired).toBe(true); expect(sync.connected).toBe(false); expect(sync.synced).toBe(false);
      expect(changes.at(-1)).toMatchObject({ refreshRequired: true, synced: false });
      socket.receive(unknownUpdate()); network.dispatchEvent(new Event("online")); vi.advanceTimersByTime(120_000);
      expect(connect).toHaveBeenCalledOnce(); expect(encodeStateAsUpdate(doc)).toEqual(before);
    } finally { sync.destroy(); doc.destroy(); vi.useRealTimers(); }
  });

  it("refuses binary bootstrap before acknowledgement without content apply", async () => {
    const { doc, socket, sync } = await fixture();
    try {
      socket.open(); const before = encodeStateAsUpdate(doc); socket.receive(unknownUpdate());
      expect(sync.refreshRequired).toBe(true); expect(encodeStateAsUpdate(doc)).toEqual(before);
    } finally { sync.destroy(); doc.destroy(); }
  });

  it("advertises the real revision and preserves the durable-echo pending contract for a compatible peer", async () => {
    const { doc, socket, sync, bridge } = await fixture();
    try {
      socket.open();
      expect(JSON.parse(socket.sent[0] as string)).toMatchObject({ type: "subscribe", schema_version: SCHEMA_VERSION });
      socket.admit(); socket.receive(encodeStateAsUpdate(doc)); expect(sync.synced).toBe(true);
      const block = doc.getXmlFragment("prosemirror").get(1);
      if (!(block instanceof XmlElement) || !(block.get(0) instanceof XmlText)) throw new Error("valid fixture text missing");
      const text = block.get(0) as XmlText; text.insert(0, "changed ");
      expect(sync.pending).toBe(1);
      const sent = socket.sent.find((frame): frame is Uint8Array => frame instanceof Uint8Array);
      expect(sent).toBeDefined(); socket.message(sent?.buffer);
      expect(sync.pending).toBe(0);
      expect(bridge.markdownFromUpdate(encodeStateAsUpdate(doc))).toContain("changed KEEP BODY");
    } finally { sync.destroy(); doc.destroy(); }
  });

  it("does not claim rejected local edits saved and never reconnects a schema-refused provider", async () => {
    const { doc, socket, sync, network, connect } = await fixture();
    vi.useFakeTimers();
    try {
      socket.open(); socket.admit(); socket.receive(encodeStateAsUpdate(doc));
      const block = doc.getXmlFragment("prosemirror").get(1) as XmlElement; const text = block.get(0) as XmlText;
      text.insert(0, "pending "); const before = encodeStateAsUpdate(doc);
      socket.message(JSON.stringify({ type: "error", code: "schema_refresh_required" }));
      expect(sync.pending).toBe(1); expect(sync.synced).toBe(false); expect(sync.refreshRequired).toBe(true);
      network.dispatchEvent(new Event("online")); vi.advanceTimersByTime(120_000);
      expect(connect).toHaveBeenCalledOnce(); expect(encodeStateAsUpdate(doc)).toEqual(before);
    } finally { sync.destroy(); doc.destroy(); vi.useRealTimers(); }
  });

  it("refuses unknown received state before mutating or echoing the live document", async () => {
    const { doc, socket, sync } = await fixture();
    try {
      socket.open(); socket.admit(); const before = encodeStateAsUpdate(doc);
      const updates: Uint8Array[] = []; doc.on("update", (update: Uint8Array) => updates.push(update));
      socket.receive(unknownUpdate());
      expect(encodeStateAsUpdate(doc)).toEqual(before);
      expect(updates).toEqual([]);
      expect(socket.sent.filter((frame) => frame instanceof Uint8Array)).toEqual([]);
      expect(sync.synced).toBe(false);
    } finally { sync.destroy(); doc.destroy(); }
  });
});
