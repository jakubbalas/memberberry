/** Permission-aware WebSocket transport for a single persisted Yjs note. */

import { Doc, applyUpdate } from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  modifyAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";

/** Marks updates received from the server so they are never echoed back. */
export const REMOTE_SYNC_ORIGIN = "memberberry:remote-sync";

/** Awareness is throttled to this cadence (`SPEC.md` §7.5). */
const PRESENCE_INTERVAL_MS = 50;

/**
 * Binary frame tags. CRDT payloads travel as binary because JSON encodes bytes as an array
 * of decimal numbers — several times the size, plus a per-element parse, on the path a
 * keystroke takes (`SPEC.md` §21). Control frames stay JSON: small, rare, and legible in a
 * network panel.
 */
const FRAME_SYNC = 0x01;
const FRAME_UPDATE = 0x02;
/** Tag byte, then two `u16` lengths. */
const BINARY_HEADER_BYTES = 5;

export interface SyncProvider {
  readonly connected: boolean;
  sendAwareness(state: unknown): void;
  destroy(): void;
}

export interface CreateSyncProviderOptions {
  readonly endpoint: string;
  readonly vault: string;
  readonly note: string;
  readonly document: Doc;
  readonly awareness?: Awareness;
  readonly socket?: WebSocket;
  /** Notified whenever the transport's connected state changes. */
  readonly onConnectionChange?: (connected: boolean) => void;
}

type ControlFrame =
  | { readonly type: "awareness"; readonly vault: string; readonly note: string; readonly user: string; readonly state: unknown }
  | { readonly type: "departed"; readonly vault: string; readonly note: string; readonly clients: number[] }
  | { readonly type: "error"; readonly code: string };

interface BinaryFrame {
  readonly tag: number;
  readonly vault: string;
  readonly note: string;
  readonly payload: Uint8Array;
}

/** Opens a server-authorized sync session. The server remains the permission boundary. */
export function createSyncProvider(options: CreateSyncProviderOptions): SyncProvider {
  const socket = options.socket ?? new WebSocket(options.endpoint);
  socket.binaryType = "arraybuffer";
  let connected = false;
  let destroyed = false;
  let lastPresence = 0;
  let pendingPresence: unknown | undefined;
  // `ReturnType<typeof setTimeout>` rather than `number`: this module must not assume a
  // `window`, so it can be unit-tested outside a DOM and later moved into a worker.
  let timer: ReturnType<typeof setTimeout> | undefined;

  const setConnected = (next: boolean): void => {
    if (connected === next) return;
    connected = next;
    options.onConnectionChange?.(next);
  };
  const send = (frame: unknown): void => {
    if (!destroyed && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(frame));
    }
  };
  const sendBinary = (bytes: Uint8Array): void => {
    if (!destroyed && socket.readyState === WebSocket.OPEN) {
      socket.send(bytes);
    }
  };
  const sendAwareness = (state: unknown, clients: number[] = []): void => {
    pendingPresence = { state, clients };
    const now = performance.now();
    const delay = Math.max(0, PRESENCE_INTERVAL_MS - (now - lastPresence));
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      lastPresence = performance.now();
      const queued = pendingPresence as { state: unknown; clients: number[] } | undefined;
      pendingPresence = undefined;
      if (queued === undefined) return;
      send({
        type: "awareness",
        vault: options.vault,
        note: options.note,
        clients: queued.clients,
        state: queued.state,
      });
    }, delay);
  };
  const sendUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin !== REMOTE_SYNC_ORIGIN) {
      sendBinary(encodeBinaryFrame(FRAME_UPDATE, options.vault, options.note, update));
    }
  };
  const onOpen = (): void => {
    setConnected(true);
    send({ type: "subscribe", vault: options.vault, note: options.note });
  };
  const onMessage = (event: MessageEvent<unknown>): void => {
    if (event.data instanceof ArrayBuffer) {
      const frame = decodeBinaryFrame(new Uint8Array(event.data));
      if (frame === null || frame.vault !== options.vault || frame.note !== options.note) return;
      if (frame.tag === FRAME_SYNC || frame.tag === FRAME_UPDATE) {
        applyUpdate(options.document, frame.payload, REMOTE_SYNC_ORIGIN);
      }
      return;
    }
    if (typeof event.data !== "string") return;
    const frame = parseControlFrame(event.data);
    if (frame === null || frame.type === "error") return;
    if (frame.vault !== options.vault || frame.note !== options.note) return;
    if (frame.type === "awareness") applyRemoteAwareness(frame.user, frame.state);
    // why: §7.5 requires a disconnected client's cursor to disappear on socket close. The
    // server names the awareness clients that left, so the removal is immediate rather than
    // waiting out y-protocols' 30s staleness timeout.
    if (frame.type === "departed" && options.awareness !== undefined) {
      removeAwarenessStates(options.awareness, frame.clients, REMOTE_SYNC_ORIGIN);
    }
  };
  const onClose = (): void => { setConnected(false); };
  const onAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }): void => {
    const changed = [...added, ...updated, ...removed];
    if (changed.length > 0 && options.awareness !== undefined) {
      sendAwareness({ update: [...encodeAwarenessUpdate(options.awareness, changed)] }, changed);
    }
  };
  const applyRemoteAwareness = (user: string, state: unknown): void => {
    if (options.awareness === undefined || !isAwarenessState(state)) return;
    const update = modifyAwarenessUpdate(new Uint8Array(state.update), ({ user: _ignored, ...rest }) => ({
      ...rest,
      user: { name: user, color: presenceColor(user) },
    }));
    applyAwarenessUpdate(options.awareness, update, REMOTE_SYNC_ORIGIN);
  };
  socket.addEventListener("open", onOpen);
  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", onClose);
  options.document.on("update", sendUpdate);
  options.awareness?.on("update", onAwareness);

  return {
    get connected(): boolean { return connected; },
    sendAwareness: (state: unknown): void => { sendAwareness(state); },
    destroy: (): void => {
      if (destroyed) return;
      if (timer !== undefined) clearTimeout(timer);
      // Leave the room explicitly so the server releases it now rather than when the socket
      // is noticed to be gone, and so remote cursors for this client vanish at once. Sent
      // before `destroyed` is set, because `send` refuses to write to a destroyed provider.
      send({ type: "unsubscribe", vault: options.vault, note: options.note });
      destroyed = true;
      options.document.off("update", sendUpdate);
      options.awareness?.off("update", onAwareness);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.close();
      setConnected(false);
    },
  };
}

/** Deterministically assigns accessible collaboration colours from a stable user id. */
export function presenceColor(userId: string): string {
  let hash = 0;
  for (const character of userId) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  return PRESENCE_COLOR_TOKENS[hash % PRESENCE_COLOR_TOKENS.length] ?? "var(--presence-2)";
}

/**
 * The collaboration palette, as design tokens rather than literals (`AGENTS.md` §4.4).
 *
 * The values live in `shell/app.css` so light and dark can each carry a variant that passes
 * the §20.3 contrast checks; a hard-coded hex cannot do that, and would silently fail one
 * of the two themes.
 */
export const PRESENCE_COLOR_TOKENS = [
  "var(--presence-0)",
  "var(--presence-1)",
  "var(--presence-2)",
  "var(--presence-3)",
  "var(--presence-4)",
  "var(--presence-5)",
] as const;

/** Frames a CRDT payload: tag, `u16` vault length, `u16` note length, then the three parts. */
export function encodeBinaryFrame(tag: number, vault: string, note: string, payload: Uint8Array): Uint8Array {
  const encoder = new TextEncoder();
  const vaultBytes = encoder.encode(vault);
  const noteBytes = encoder.encode(note);
  const frame = new Uint8Array(BINARY_HEADER_BYTES + vaultBytes.length + noteBytes.length + payload.length);
  const view = new DataView(frame.buffer);
  view.setUint8(0, tag);
  view.setUint16(1, vaultBytes.length);
  view.setUint16(3, noteBytes.length);
  frame.set(vaultBytes, BINARY_HEADER_BYTES);
  frame.set(noteBytes, BINARY_HEADER_BYTES + vaultBytes.length);
  frame.set(payload, BINARY_HEADER_BYTES + vaultBytes.length + noteBytes.length);
  return frame;
}

/** Parses a CRDT frame, returning null for anything truncated or malformed. */
export function decodeBinaryFrame(bytes: Uint8Array): BinaryFrame | null {
  if (bytes.length < BINARY_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vaultLength = view.getUint16(1);
  const noteLength = view.getUint16(3);
  const vaultEnd = BINARY_HEADER_BYTES + vaultLength;
  const noteEnd = vaultEnd + noteLength;
  if (bytes.length < noteEnd) return null;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    return {
      tag: view.getUint8(0),
      vault: decoder.decode(bytes.subarray(BINARY_HEADER_BYTES, vaultEnd)),
      note: decoder.decode(bytes.subarray(vaultEnd, noteEnd)),
      payload: bytes.subarray(noteEnd),
    };
  } catch {
    return null;
  }
}

/** Parses a JSON control frame. Anything unrecognized is dropped rather than guessed at. */
export function parseControlFrame(value: string): ControlFrame | null {
  let frame: unknown;
  try {
    frame = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof frame !== "object" || frame === null) return null;
  const typed = frame as { type?: unknown; vault?: unknown; note?: unknown; user?: unknown; state?: unknown; clients?: unknown; code?: unknown };
  if (
    typed.type === "awareness"
    && typeof typed.vault === "string"
    && typeof typed.note === "string"
    && typeof typed.user === "string"
  ) {
    return { type: "awareness", vault: typed.vault, note: typed.note, user: typed.user, state: typed.state };
  }
  if (
    typed.type === "departed"
    && typeof typed.vault === "string"
    && typeof typed.note === "string"
    && isNumberArray(typed.clients)
  ) {
    return { type: "departed", vault: typed.vault, note: typed.note, clients: typed.clients };
  }
  if (typed.type === "error" && typeof typed.code === "string") {
    return { type: "error", code: typed.code };
  }
  return null;
}

function isAwarenessState(value: unknown): value is { readonly update: number[] } {
  return typeof value === "object" && value !== null && "update" in value && isNumberArray(value.update);
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "number");
}
