/** Measures the per-edit transport/acknowledgement cost, excluding network and disk latency. */
import { afterAll, bench } from "vitest";
import { Doc } from "yjs";
import { createSyncProvider } from "./sync.js";

class EchoSocket extends EventTarget {
  readonly readyState = WebSocket.OPEN;
  binaryType: BinaryType = "arraybuffer";
  send(data: string | Uint8Array): void {
    if (typeof data === "string") return;
    this.dispatchEvent(new MessageEvent("message", {
      data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    }));
  }
  close(): void { /* the injected transport owns no network resource */ }
}

const local = new Doc();
const replicated = new Doc();
const localText = local.getText("body");
const replicatedText = replicated.getText("body");
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
