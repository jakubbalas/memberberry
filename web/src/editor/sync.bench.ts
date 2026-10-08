/** Measures the per-edit transport/acknowledgement cost, excluding network and disk latency. */
import { afterAll, bench } from "vitest";
import { Doc, XmlElement, XmlText, applyUpdate } from "yjs";
import { readFileSync } from "node:fs";
import { load, noteBridge } from "../notes.js";
import { SCHEMA_VERSION } from "./schema-revision.js";
await load(readFileSync(`${process.cwd()}/src/wasm/mb_bg.wasm`));
const bridge = await noteBridge();
import { createSyncProvider } from "./sync.js";

class EchoSocket extends EventTarget {
  readonly readyState = WebSocket.OPEN;
  binaryType: BinaryType = "arraybuffer";
  send(data: string | Uint8Array): void {
    if (typeof data === "string") {
      const frame = JSON.parse(data) as { type: string };
      if (frame.type === "subscribe") this.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ type: "admitted", vault: "benchmark", note: "Note.md", schema_version: SCHEMA_VERSION }),
      }));
      return;
    }
    this.dispatchEvent(new MessageEvent("message", {
      data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    }));
  }
  close(): void { /* the injected transport owns no network resource */ }
}

const local = new Doc();
const replicated = new Doc();
applyUpdate(local, bridge.updateFromMarkdown("benchmark\n"));
applyUpdate(replicated, bridge.updateFromMarkdown("benchmark\n"));
const localText = (local.getXmlFragment("prosemirror").get(0) as XmlElement).get(0) as XmlText;
const replicatedText = (replicated.getXmlFragment("prosemirror").get(0) as XmlElement).get(0) as XmlText;
const socket = new EchoSocket();
const provider = createSyncProvider({
  endpoint: "ws://localhost/benchmark",
  vault: "benchmark",
  note: "Note.md",
  document: replicated,
  connect: () => socket as unknown as WebSocket,
});
socket.dispatchEvent(new Event("open"));

bench("insert/delete in a local Y document without transport", () => {
  localText.insert(0, "a");
  localText.delete(0, 1);
});
bench("insert/delete with binary sync and durable-echo bookkeeping", () => {
  replicatedText.insert(0, "a");
  replicatedText.delete(0, 1);
});
afterAll(() => {
  provider.destroy();
  local.destroy();
  replicated.destroy();
});
