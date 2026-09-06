/** Permission-aware WebSocket transport for a single persisted Yjs note. */

import { Doc, applyUpdate, encodeStateAsUpdate, encodeStateVectorFromUpdate } from "yjs";
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
 * Reconnection backoff (`SPEC.md` §7.4).
 *
 * A closed socket is the normal state of an offline-first application, not an error, so it
 * is retried forever rather than a fixed number of times — a tab left open on a train has to
 * come back on its own. The cap is what makes "forever" affordable: one attempt every thirty
 * seconds costs nothing, and it bounds how long a reconnection takes after the network
 * returns.
 */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;

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
  /** Local changes produced while the socket was not open, and so not yet sent. */
  readonly pending: number;
  /** Whether the server has sent this note's state at least once (§7.2). */
  readonly synced: boolean;
  sendAwareness(state: unknown): void;
  destroy(): void;
}

export interface CreateSyncProviderOptions {
  readonly endpoint: string;
  readonly vault: string;
  readonly note: string;
  readonly document: Doc;
  readonly awareness?: Awareness;
  /**
   * Opens a socket. Called again for every reconnection, which is why this is a factory and
   * not a socket: a `WebSocket` is single-use, so a transport handed one can connect once.
   */
  readonly connect?: () => WebSocket;
  /**
   * Where "the network came back" is announced — `globalThis` in a browser.
   *
   * Injectable, and read through this narrow type, because this module must not assume a
   * `window`: it is unit-tested outside a DOM and could move into a worker.
   */
  readonly network?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  /** Notified whenever the transport's connected state or pending count changes. */
  readonly onConnectionChange?: (state: ConnectionState) => void;
}

/** What the transport reports about itself, for a UI that has to say so (§7.4). */
export interface ConnectionState {
  readonly connected: boolean;
  /** Local changes produced while the socket was not open, and so not yet sent. */
  readonly pending: number;
  /**
   * Whether the server has sent this note's state at least once in this session.
   *
   * Latches: once the body has arrived it is here, and a later disconnection does not
   * un-download it. This is what §7.2 means by a note being *downloaded*, and it is a better
   * signal than `navigator.onLine` for the same question — a browser that believes it is
   * online tells you nothing about whether this note's body ever came.
   */
  readonly synced: boolean;
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
  const openSocket = options.connect ?? ((): WebSocket => new WebSocket(options.endpoint));
  const network = options.network ?? defaultNetwork();
  let socket: WebSocket | undefined;
  let connected = false;
  let pending = 0;
  let synced = false;
  /** Consecutive failed connections, which is what the backoff grows from. */
  let attempts = 0;
  let destroyed = false;
  let lastPresence = 0;
  let pendingPresence: unknown | undefined;
  // `ReturnType<typeof setTimeout>` rather than `number`: this module must not assume a
  // `window`, so it can be unit-tested outside a DOM and later moved into a worker.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const announce = (): void => {
    options.onConnectionChange?.({ connected, pending, synced });
  };
  const setConnected = (next: boolean): void => {
    if (connected === next) return;
    connected = next;
    announce();
  };
  const setPending = (next: number): void => {
    if (pending === next) return;
    pending = next;
    announce();
  };
  const isOpen = (): boolean =>
    !destroyed && socket !== undefined && socket.readyState === WebSocket.OPEN;
  const send = (frame: unknown): void => {
    if (isOpen()) socket?.send(JSON.stringify(frame));
  };
  const sendBinary = (bytes: Uint8Array): void => {
    if (isOpen()) socket?.send(bytes);
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
    if (origin === REMOTE_SYNC_ORIGIN) return;
    if (!isOpen()) {
      // why: counted rather than queued. The document itself is the queue — every one of
      // these is already in the Y doc and, a moment later, in IndexedDB — so keeping the
      // bytes as well would be a second copy that can disagree with the first. What
      // reconnecting sends is the difference between this document and the server's, which
      // is exact however many updates went unsent (§7.4).
      setPending(pending + 1);
      return;
    }
    sendBinary(encodeBinaryFrame(FRAME_UPDATE, options.vault, options.note, update));
  };
  /**
   * Sends whatever the server's state does not already contain.
   *
   * This is the reconnect flush, and it is also what makes a *first* connection correct: the
   * local replica is restored from IndexedDB before the socket opens, so a note edited
   * offline and then reloaded has changes the server has never seen. Through M5 nothing sent
   * them — the server answered `subscribe` with its own state, the client merged it, and the
   * client's own updates stayed on the device forever.
   *
   * The difference is computed from the state vector *of the server's own frame*, so it is
   * exactly what is missing rather than everything this client has.
   */
  const flush = (remote: Uint8Array): void => {
    const missing = encodeStateAsUpdate(options.document, encodeStateVectorFromUpdate(remote));
    if (hasContent(missing)) {
      sendBinary(encodeBinaryFrame(FRAME_UPDATE, options.vault, options.note, missing));
    }
    // Both at once, and one announcement: a subscriber must never see this half-applied,
    // and the *first* sync is news even when the count was already zero. `ConnectionStatus`
    // drops a repeat of an identical state, so announcing unconditionally costs nothing.
    synced = true;
    pending = 0;
    announce();
  };
  const onOpen = (): void => {
    attempts = 0;
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
      // The server answers `subscribe` with its whole state, which is the only frame that
      // says what it does *not* have.
      if (frame.tag === FRAME_SYNC) flush(frame.payload);
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
  const onClose = (): void => {
    setConnected(false);
    detach();
    scheduleReconnect();
  };
  const attach = (): void => {
    if (destroyed) return;
    const next = openSocket();
    next.binaryType = "arraybuffer";
    socket = next;
    next.addEventListener("open", onOpen);
    next.addEventListener("message", onMessage);
    next.addEventListener("close", onClose);
  };
  /** Drops the current socket's listeners, so a late event from a dead one cannot act. */
  const detach = (): void => {
    socket?.removeEventListener("open", onOpen);
    socket?.removeEventListener("message", onMessage);
    socket?.removeEventListener("close", onClose);
    socket = undefined;
  };
  /**
   * Gives up the socket when the browser says the network has gone.
   *
   * why: a socket does not notice a network that disappeared. Nothing is delivered and
   * nothing is refused — a TCP connection can take minutes to admit it is dead, and until it
   * does, every `send` succeeds into nowhere. That is the state where this transport is
   * silently losing edits *while reporting itself connected*, which is worse than being
   * offline. Closing it deliberately makes the next update count as pending (§7.4) and the
   * next connection a real one.
   *
   * `navigator.onLine` is famously imprecise — a captive portal reads as online, a VM can
   * read as offline. The cost of believing it wrongly is bounded: a working socket is closed
   * and reopened immediately after, because the reconnection then succeeds.
   */
  const onOffline = (): void => {
    if (destroyed || socket === undefined) return;
    const closing = socket;
    // Detach first, so the close this causes is not also handled as a dropped connection.
    detach();
    closing.close();
    setConnected(false);
    scheduleReconnect();
  };
  /**
   * Reconnects at once when the browser says the network is back.
   *
   * why: without it, the backoff decides how long a returning connection takes. A laptop
   * closed for an hour wakes up mid-way through a thirty-second window and a user who is
   * plainly online watches an "Offline" label for half a minute. The backoff is still what
   * governs a server that is refusing connections, which is the case it exists for.
   */
  const onOnline = (): void => {
    if (destroyed || connected) return;
    if (retry !== undefined) {
      clearTimeout(retry);
      retry = undefined;
    }
    attempts = 0;
    attach();
  };
  const scheduleReconnect = (): void => {
    if (destroyed || retry !== undefined) return;
    const delay = reconnectDelay(attempts, Math.random);
    attempts += 1;
    retry = setTimeout(() => {
      retry = undefined;
      attach();
    }, delay);
  };
  const onAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }): void => {
    const changed = [...added, ...updated, ...removed];
    if (changed.length > 0 && options.awareness !== undefined) {
      sendAwareness({ update: [...encodeAwarenessUpdate(options.awareness, changed)] }, changed);
    }
  };
  const applyRemoteAwareness = (user: string, state: unknown): void => {
    if (options.awareness === undefined || !isAwarenessState(state)) return;
    const update = modifyAwarenessUpdate(new Uint8Array(state.update), (client: unknown) => {
      // why: `y-protocols` represents "this client has no state" — it left, or cleared its
      // own — as a literal `null`, and an update may carry those alongside live ones.
      // Destructuring one threw out of the socket's message handler on every editor load.
      // Passing it through unchanged is also the correct behaviour: there is no claimed
      // username to overwrite, and inventing a state would resurrect a departed cursor.
      if (client === null || typeof client !== "object") return client;
      const { user: _ignored, ...rest } = client as Record<string, unknown>;
      return { ...rest, user: { name: user, color: presenceColor(user) } };
    });
    applyAwarenessUpdate(options.awareness, update, REMOTE_SYNC_ORIGIN);
  };
  attach();
  network?.addEventListener("online", onOnline);
  network?.addEventListener("offline", onOffline);
  options.document.on("update", sendUpdate);
  options.awareness?.on("update", onAwareness);

  return {
    get connected(): boolean { return connected; },
    get pending(): number { return pending; },
    get synced(): boolean { return synced; },
    sendAwareness: (state: unknown): void => { sendAwareness(state); },
    destroy: (): void => {
      if (destroyed) return;
      if (timer !== undefined) clearTimeout(timer);
      if (retry !== undefined) clearTimeout(retry);
      // Leave the room explicitly so the server releases it now rather than when the socket
      // is noticed to be gone, and so remote cursors for this client vanish at once. Sent
      // before `destroyed` is set, because `send` refuses to write to a destroyed provider.
      send({ type: "unsubscribe", vault: options.vault, note: options.note });
      destroyed = true;
      options.document.off("update", sendUpdate);
      options.awareness?.off("update", onAwareness);
      network?.removeEventListener("online", onOnline);
      network?.removeEventListener("offline", onOffline);
      const closing = socket;
      detach();
      closing?.close();
      setConnected(false);
    },
  };
}

/**
 * The browser's own network events, or nothing outside one.
 *
 * `globalThis` rather than `window`, so a worker scope works the same way and a test
 * environment without either is simply absent rather than a thrown reference.
 */
function defaultNetwork(): Pick<EventTarget, "addEventListener" | "removeEventListener"> | undefined {
  return typeof globalThis.addEventListener === "function" ? globalThis : undefined;
}

/**
 * How long to wait before the *n*th reconnection attempt (`SPEC.md` §7.4).
 *
 * Exponential with equal jitter: the delay is somewhere in the top half of the doubling
 * window, so a hundred tabs that lost the same Wi-Fi do not all come back in the same
 * millisecond, and no attempt is ever immediate — a zero-delay retry against a server that
 * has just closed the connection is a hot loop, and the most likely reason it closed is the
 * frame-rate limit (§7.1).
 */
export function reconnectDelay(attempt: number, random: () => number): number {
  const window = Math.min(RECONNECT_BASE_MS * 2 ** Math.max(0, attempt), RECONNECT_CAP_MS);
  return window / 2 + random() * (window / 2);
}

/**
 * Whether a Yjs update carries anything at all.
 *
 * An update that adds nothing still encodes to two bytes — a zero count of clients with
 * structs, and an empty delete set. Sending one would be a wasted frame per reconnection,
 * and on the server it is a write the note did not need. `sync.test.ts` pins the encoding
 * rather than trusting this comment.
 */
export function hasContent(update: Uint8Array): boolean {
  return !(update.length === 2 && update[0] === 0 && update[1] === 0);
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
