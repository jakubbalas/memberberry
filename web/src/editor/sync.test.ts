import { describe, expect, it, vi } from "vitest";
import { Doc, applyUpdate, encodeStateAsUpdate } from "yjs";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";

import {
  PRESENCE_COLOR_TOKENS,
  REMOTE_SYNC_ORIGIN,
  createSyncProvider,
  decodeBinaryFrame,
  encodeBinaryFrame,
  parseControlFrame,
  presenceColor,
} from "./sync.js";

/** A WebSocket stand-in that records what was sent and lets a test push frames back. */
class FakeSocket implements Pick<WebSocket, "readyState" | "send" | "close" | "binaryType"> {
  readyState: number = WebSocket.OPEN;
  binaryType: BinaryType = "blob";
  readonly sent: unknown[] = [];
  closed = 0;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed += 1;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? new Set();
    existing.add(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  /** How many listeners are still attached, so teardown can be asserted rather than assumed. */
  listenerCount(): number {
    return [...this.listeners.values()].reduce((total, set) => total + set.size, 0);
  }

  /** The JSON frames sent, parsed. */
  json(): Array<Record<string, unknown>> {
    return this.sent
      .filter((frame): frame is string => typeof frame === "string")
      .map((frame) => JSON.parse(frame) as Record<string, unknown>);
  }

  /** The binary frames sent. */
  binary(): Uint8Array[] {
    return this.sent.filter((frame): frame is Uint8Array => frame instanceof Uint8Array);
  }
}

function provider(overrides: Partial<Parameters<typeof createSyncProvider>[0]> = {}) {
  const socket = new FakeSocket();
  const document = new Doc();
  const awareness = new Awareness(document);
  const sync = createSyncProvider({
    endpoint: "ws://localhost/api/v1/sync",
    vault: "personal",
    note: "One.md",
    document,
    awareness,
    socket: socket as unknown as WebSocket,
    ...overrides,
  });
  return { socket, document, awareness, sync };
}

describe("presenceColor", () => {
  it("is stable for a user across sessions", () => {
    expect(presenceColor("user-42")).toBe(presenceColor("user-42"));
  });

  it("uses a design token rather than a hard-coded colour", () => {
    expect(PRESENCE_COLOR_TOKENS).toContain(presenceColor("alice"));
    expect(presenceColor("alice")).toMatch(/^var\(--presence-\d\)$/);
  });

  it("spreads users across the whole palette", () => {
    const seen = new Set(
      Array.from({ length: 200 }, (_, index) => presenceColor(`user-${index}`)),
    );
    expect(seen.size).toBe(PRESENCE_COLOR_TOKENS.length);
  });
});

describe("binary framing", () => {
  it("round-trips a payload with its vault and note", () => {
    const payload = new Uint8Array([1, 2, 3, 250]);
    const frame = decodeBinaryFrame(encodeBinaryFrame(0x02, "personal", "a/b.md", payload));
    expect(frame).not.toBeNull();
    expect(frame?.tag).toBe(0x02);
    expect(frame?.vault).toBe("personal");
    expect(frame?.note).toBe("a/b.md");
    expect([...(frame?.payload ?? [])]).toEqual([1, 2, 3, 250]);
  });

  it("round-trips names that are multi-byte in UTF-8", () => {
    // Lengths are byte counts, not character counts; a naive implementation truncates here.
    const frame = decodeBinaryFrame(
      encodeBinaryFrame(0x01, "persönlich", "notes/Café ☕.md", new Uint8Array([9])),
    );
    expect(frame?.vault).toBe("persönlich");
    expect(frame?.note).toBe("notes/Café ☕.md");
  });

  it("carries an empty payload without becoming malformed", () => {
    const frame = decodeBinaryFrame(encodeBinaryFrame(0x02, "v", "n.md", new Uint8Array()));
    expect(frame?.payload.length).toBe(0);
  });

  it("rejects a frame truncated inside its header", () => {
    expect(decodeBinaryFrame(new Uint8Array([0x02, 0, 8]))).toBeNull();
  });

  it("rejects a frame whose declared lengths run past its end", () => {
    const frame = encodeBinaryFrame(0x02, "personal", "One.md", new Uint8Array([1]));
    expect(decodeBinaryFrame(frame.subarray(0, 8))).toBeNull();
  });

  it("rejects a frame whose names are not valid UTF-8", () => {
    const frame = encodeBinaryFrame(0x02, "ab", "cd", new Uint8Array());
    frame[5] = 0xff;
    expect(decodeBinaryFrame(frame)).toBeNull();
  });
});

describe("parseControlFrame", () => {
  it("accepts an awareness frame", () => {
    const frame = parseControlFrame(
      JSON.stringify({ type: "awareness", vault: "v", note: "n.md", user: "alice", state: {} }),
    );
    expect(frame).toMatchObject({ type: "awareness", user: "alice" });
  });

  it("accepts a departure frame", () => {
    const frame = parseControlFrame(
      JSON.stringify({ type: "departed", vault: "v", note: "n.md", clients: [1, 2] }),
    );
    expect(frame).toMatchObject({ type: "departed", clients: [1, 2] });
  });

  it.each([
    ["not json at all", "{"],
    ["a JSON primitive", "42"],
    ["null", "null"],
    ["an unknown type", JSON.stringify({ type: "shutdown" })],
    ["an awareness frame with no user", JSON.stringify({ type: "awareness", vault: "v", note: "n" })],
    ["a departure with non-numeric clients", JSON.stringify({ type: "departed", vault: "v", note: "n", clients: ["x"] })],
    ["an error with no code", JSON.stringify({ type: "error" })],
  ])("rejects %s", (_label, payload) => {
    expect(parseControlFrame(payload)).toBeNull();
  });
});

describe("createSyncProvider", () => {
  it("subscribes on open and reports the connection", () => {
    const changes: boolean[] = [];
    const { socket, sync } = provider({ onConnectionChange: (connected) => changes.push(connected) });
    expect(sync.connected).toBe(false);

    socket.emit("open", {});

    expect(sync.connected).toBe(true);
    expect(changes).toEqual([true]);
    expect(socket.json()[0]).toEqual({ type: "subscribe", vault: "personal", note: "One.md" });
    sync.destroy();
  });

  it("reports a dropped connection so the UI can say you are alone", () => {
    const changes: boolean[] = [];
    const { socket, sync } = provider({ onConnectionChange: (connected) => changes.push(connected) });
    socket.emit("open", {});

    socket.emit("close", {});

    expect(sync.connected).toBe(false);
    expect(changes).toEqual([true, false]);
    sync.destroy();
  });

  it("sends a local edit as a binary frame", () => {
    const { socket, document, sync } = provider();
    socket.emit("open", {});

    document.getText("body").insert(0, "hello");

    const frames = socket.binary().map(decodeBinaryFrame);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]?.tag).toBe(0x02);
    expect(frames[0]?.vault).toBe("personal");
    expect(frames[0]?.payload.length).toBeGreaterThan(0);
    sync.destroy();
  });

  it("never echoes an update that came from the server", () => {
    const { socket, document, sync } = provider();
    socket.emit("open", {});
    const source = new Doc();
    source.getText("body").insert(0, "remote");
    const update = encodeStateAsUpdate(source);

    applyUpdate(document, update, REMOTE_SYNC_ORIGIN);

    expect(socket.binary()).toHaveLength(0);
    sync.destroy();
  });

  it("applies a server update addressed to this note", () => {
    const { socket, document, sync } = provider();
    socket.emit("open", {});
    const source = new Doc();
    source.getText("body").insert(0, "from the server");
    const frame = encodeBinaryFrame(0x02, "personal", "One.md", encodeStateAsUpdate(source));

    socket.emit("message", { data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) });

    expect(document.getText("body").toString()).toBe("from the server");
    sync.destroy();
  });

  it("ignores a frame addressed to a different note", () => {
    // A shared socket carries every open note. Applying another note's update into this
    // document would silently corrupt it.
    const { socket, document, sync } = provider();
    socket.emit("open", {});
    const source = new Doc();
    source.getText("body").insert(0, "someone else's note");
    const frame = encodeBinaryFrame(0x02, "personal", "Other.md", encodeStateAsUpdate(source));

    socket.emit("message", { data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) });

    expect(document.getText("body").toString()).toBe("");
    sync.destroy();
  });

  it("survives a malformed binary frame", () => {
    const { socket, document, sync } = provider();
    socket.emit("open", {});

    socket.emit("message", { data: new Uint8Array([0x02, 0xff]).buffer });

    expect(document.getText("body").toString()).toBe("");
    sync.destroy();
  });

  it("removes a departed client's presence at once", () => {
    const { socket, awareness, sync } = provider();
    socket.emit("open", {});
    const remote = new Doc();
    const other = new Awareness(remote);
    other.setLocalStateField("user", { name: "bob", color: "var(--presence-1)" });
    // Mirror the remote client into this awareness the way a server broadcast would.
    awareness.states.set(other.clientID, { user: { name: "bob", color: "var(--presence-1)" } });
    awareness.meta.set(other.clientID, { clock: 1, lastUpdated: Date.now() });
    expect(awareness.getStates().has(other.clientID)).toBe(true);

    socket.emit("message", {
      data: JSON.stringify({
        type: "departed",
        vault: "personal",
        note: "One.md",
        clients: [other.clientID],
      }),
    });

    expect(awareness.getStates().has(other.clientID)).toBe(false);
    sync.destroy();
  });

  it("relabels remote presence with the server's username, not the client's claim", () => {
    const { socket, awareness, sync } = provider();
    socket.emit("open", {});
    const remoteDoc = new Doc();
    const remote = new Awareness(remoteDoc);
    remote.setLocalStateField("user", { name: "administrator", color: "#000000" });
    const encoded = [...encodeAwarenessUpdate(remote, [remote.clientID])];

    socket.emit("message", {
      data: JSON.stringify({
        type: "awareness",
        vault: "personal",
        note: "One.md",
        user: "bob",
        state: { update: encoded },
      }),
    });

    const state = awareness.getStates().get(remote.clientID) as { user?: { name?: string } } | undefined;
    expect(state?.user?.name).toBe("bob");
    sync.destroy();
  });

  it("throttles presence rather than sending one frame per cursor move", () => {
    vi.useFakeTimers();
    try {
      const { socket, sync } = provider();
      socket.emit("open", {});

      for (let move = 0; move < 20; move += 1) {
        sync.sendAwareness({ cursor: move });
      }
      expect(socket.json().filter((frame) => frame["type"] === "awareness")).toHaveLength(0);
      vi.advanceTimersByTime(60);

      const sentAwareness = socket.json().filter((frame) => frame["type"] === "awareness");
      expect(sentAwareness).toHaveLength(1);
      expect(sentAwareness[0]?.["state"]).toEqual({ cursor: 19 });
      sync.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases every listener and leaves the room on destroy", () => {
    const { socket, document, awareness, sync } = provider();
    socket.emit("open", {});
    const before = socket.listenerCount();

    sync.destroy();

    expect(socket.listenerCount()).toBe(0);
    expect(before).toBeGreaterThan(0);
    expect(socket.closed).toBe(1);
    expect(socket.json().some((frame) => frame["type"] === "unsubscribe")).toBe(true);
    // A detached provider must not keep reacting to its old document or awareness.
    const sentBefore = socket.sent.length;
    document.getText("body").insert(0, "after destroy");
    awareness.setLocalStateField("user", { name: "late", color: "var(--presence-0)" });
    expect(socket.sent.length).toBe(sentBefore);
  });

  it("is safe to destroy twice", () => {
    const { socket, sync } = provider();
    socket.emit("open", {});

    sync.destroy();
    sync.destroy();

    expect(socket.closed).toBe(1);
  });

  it("does not send once the socket is no longer open", () => {
    const { socket, document, sync } = provider();
    socket.emit("open", {});
    socket.readyState = WebSocket.CLOSING;

    document.getText("body").insert(0, "while closing");

    expect(socket.binary()).toHaveLength(0);
    sync.destroy();
  });
});
