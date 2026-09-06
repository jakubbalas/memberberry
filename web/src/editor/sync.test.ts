import { describe, expect, it, vi } from "vitest";
import { Doc, applyUpdate, encodeStateAsUpdate, encodeStateVector } from "yjs";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";

import {
  PRESENCE_COLOR_TOKENS,
  type ConnectionState,
  REMOTE_SYNC_ORIGIN,
  createSyncProvider,
  decodeBinaryFrame,
  encodeBinaryFrame,
  hasContent,
  parseControlFrame,
  presenceColor,
  reconnectDelay,
} from "./sync.js";

/** A WebSocket stand-in that records what was sent and lets a test push frames back. */
class FakeSocket implements Pick<WebSocket, "readyState" | "send" | "close" | "binaryType"> {
  // Starts connecting, like a real one. A fake that starts open cannot express the state
  // this transport now cares most about — a socket that is not there yet (§7.4).
  readyState: number = WebSocket.CONNECTING;
  binaryType: BinaryType = "blob";
  readonly sent: unknown[] = [];
  closed = 0;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed += 1;
    this.readyState = WebSocket.CLOSED;
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
    if (type === "open") this.readyState = WebSocket.OPEN;
    if (type === "close") this.readyState = WebSocket.CLOSED;
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

/**
 * A provider over a socket a test can drive.
 *
 * `connect` is a factory rather than a socket because the transport reconnects (§7.4), and a
 * `WebSocket` is single-use. The default hands back the *same* fake on every attempt, which
 * is what a test asserting on one connection wants; `sockets` collects each attempt for the
 * tests that care that a second one happened at all.
 */
function provider(overrides: Partial<Parameters<typeof createSyncProvider>[0]> = {}) {
  const sockets: FakeSocket[] = [new FakeSocket()];
  const document = new Doc();
  const awareness = new Awareness(document);
  const sync = createSyncProvider({
    endpoint: "ws://localhost/api/v1/sync",
    vault: "personal",
    note: "One.md",
    document,
    awareness,
    connect: () => sockets[sockets.length - 1] as unknown as WebSocket,
    ...overrides,
  });
  const socket = sockets[0] as FakeSocket;
  return { socket, sockets, document, awareness, sync };
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
    const changes: ConnectionState[] = [];
    const { socket, sync } = provider({ onConnectionChange: (state) => changes.push(state) });
    expect(sync.connected).toBe(false);

    socket.emit("open", {});

    expect(sync.connected).toBe(true);
    expect(changes).toEqual([{ connected: true, pending: 0 }]);
    expect(socket.json()[0]).toEqual({ type: "subscribe", vault: "personal", note: "One.md" });
    sync.destroy();
  });

  it("reports a dropped connection so the UI can say you are alone", () => {
    const changes: ConnectionState[] = [];
    const { socket, sync } = provider({ onConnectionChange: (state) => changes.push(state) });
    socket.emit("open", {});

    socket.emit("close", {});

    expect(sync.connected).toBe(false);
    expect(changes).toEqual([
      { connected: true, pending: 0 },
      { connected: false, pending: 0 },
    ]);
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

  it("survives an awareness frame announcing that a client has no state", () => {
    // Regression. `y-protocols` encodes a client with no state — one that has left, or that
    // cleared its own — as a literal `null`, and the rewrite that stamps the server's
    // username over the client's claim destructured it unconditionally. In a browser that
    // threw `Cannot destructure property 'user' of 'object null'` out of the socket's
    // message handler on every editor load, which the unit suite never saw because every
    // fixture here had a state to rewrite. Playwright found it on the first run.
    const { socket, awareness, sync } = provider();
    socket.emit("open", {});
    const remoteDoc = new Doc();
    const remote = new Awareness(remoteDoc);
    remote.setLocalState(null);
    const encoded = [...encodeAwarenessUpdate(remote, [remote.clientID])];

    expect(() => {
      socket.emit("message", {
        data: JSON.stringify({
          type: "awareness",
          vault: "personal",
          note: "One.md",
          user: "bob",
          state: { update: encoded },
        }),
      });
    }).not.toThrow();

    // A stateless client contributes no cursor rather than an empty one.
    expect(awareness.getStates().get(remote.clientID)).toBeUndefined();
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

describe("reconnectDelay", () => {
  it("never returns zero, so a refused connection is not a hot loop", () => {
    // The likeliest reason a server closed us is §7.1's frame-rate limit. Retrying instantly
    // is how a client turns its own throttling into a denial of service.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(reconnectDelay(attempt, () => 0)).toBeGreaterThan(0);
    }
  });

  it("doubles the window until it reaches the cap", () => {
    const highest = (attempt: number): number => reconnectDelay(attempt, () => 1);
    expect(highest(0)).toBe(1_000);
    expect(highest(1)).toBe(2_000);
    expect(highest(2)).toBe(4_000);
    expect(highest(20)).toBe(30_000);
  });

  it("jitters within the top half of the window", () => {
    // Equal jitter: a hundred tabs that lost the same Wi-Fi must not all return in the same
    // millisecond, and none of them should wait longer than the window they earned.
    for (const random of [0, 0.5, 1]) {
      const delay = reconnectDelay(3, () => random);
      expect(delay).toBeGreaterThanOrEqual(4_000);
      expect(delay).toBeLessThanOrEqual(8_000);
    }
  });

  it("treats a nonsensical attempt count as the first one", () => {
    expect(reconnectDelay(-5, () => 1)).toBe(1_000);
  });
});

describe("hasContent", () => {
  it("recognises the two bytes a diff of two identical documents encodes to", () => {
    // Pins the encoding this optimisation rests on rather than trusting a comment: an update
    // with no structs and no delete set is a zero varint followed by a zero varint. If a
    // future yjs changes that, this fails here instead of silently sending a frame per
    // reconnection forever.
    const mine = new Doc();
    const theirs = new Doc();
    mine.getText("body").insert(0, "shared");
    applyUpdate(theirs, encodeStateAsUpdate(mine));

    const nothing = encodeStateAsUpdate(mine, encodeStateVector(theirs));
    expect([...nothing]).toEqual([0, 0]);
    expect(hasContent(nothing)).toBe(false);
  });

  it("recognises an update that carries something", () => {
    const doc = new Doc();
    doc.getText("body").insert(0, "a");
    expect(hasContent(encodeStateAsUpdate(doc))).toBe(true);
  });
});

describe("editing with the socket closed (SPEC §7.4)", () => {
  /** The server's answer to `subscribe`: its whole state, tagged 0x01. */
  function syncFrame(state: Uint8Array): ArrayBufferLike {
    const frame = encodeBinaryFrame(0x01, "personal", "One.md", state);
    return frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength);
  }

  it("counts a change it could not send instead of dropping it", () => {
    const changes: ConnectionState[] = [];
    const { document, sync } = provider({ onConnectionChange: (state) => changes.push(state) });

    document.getText("body").insert(0, "written on a train");

    expect(sync.pending).toBe(1);
    expect(changes.at(-1)).toEqual({ connected: false, pending: 1 });
    sync.destroy();
  });

  it("sends everything the server is missing when it reconnects, and clears the count", () => {
    // The bug this exists for: through M5 an edit made while the socket was closed reached
    // IndexedDB and never reached the server, because `subscribe` was answered with the
    // server's state and nothing ever sent this client's.
    const { socket, document, sync } = provider();
    document.getText("body").insert(0, "written on a train");
    expect(sync.pending).toBe(1);

    socket.emit("open", {});
    socket.emit("message", { data: syncFrame(encodeStateAsUpdate(new Doc())) });

    const server = new Doc();
    for (const frame of socket.binary().map(decodeBinaryFrame)) {
      if (frame !== null) applyUpdate(server, frame.payload);
    }
    expect(server.getText("body").toString()).toBe("written on a train");
    expect(sync.pending).toBe(0);
    sync.destroy();
  });

  it("sends nothing when the server already has everything", () => {
    const { socket, document, sync } = provider();
    socket.emit("open", {});
    document.getText("body").insert(0, "already there");
    const sentBefore = socket.binary().length;

    socket.emit("message", { data: syncFrame(encodeStateAsUpdate(document)) });

    expect(socket.binary().length).toBe(sentBefore);
    sync.destroy();
  });
});

describe("reconnecting (SPEC §7.4)", () => {
  it("opens a new socket after a close, and subscribes again", () => {
    vi.useFakeTimers();
    try {
      const sockets = [new FakeSocket()];
      const document = new Doc();
      const sync = createSyncProvider({
        endpoint: "ws://localhost/api/v1/sync",
        vault: "personal",
        note: "One.md",
        document,
        connect: () => {
          const next = new FakeSocket();
          sockets.push(next);
          return next as unknown as WebSocket;
        },
      });
      const first = sockets.at(-1);
      first?.emit("open", {});
      expect(sockets).toHaveLength(2);

      first?.emit("close", {});
      vi.advanceTimersByTime(60_000);

      expect(sockets).toHaveLength(3);
      const second = sockets.at(-1);
      second?.emit("open", {});
      expect(second?.json()[0]).toEqual({ type: "subscribe", vault: "personal", note: "One.md" });
      sync.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops trying once the pane is closed", () => {
    // A destroyed provider that kept reconnecting would hold a socket open for a note nobody
    // has on screen — and every closed tab would leave one behind.
    vi.useFakeTimers();
    try {
      let opened = 0;
      const socket = new FakeSocket();
      const sync = createSyncProvider({
        endpoint: "ws://localhost/api/v1/sync",
        vault: "personal",
        note: "One.md",
        document: new Doc(),
        connect: () => {
          opened += 1;
          return socket as unknown as WebSocket;
        },
      });
      socket.emit("open", {});
      socket.emit("close", {});
      sync.destroy();

      vi.advanceTimersByTime(60_000);

      expect(opened).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a frame from the socket it has already dropped", () => {
    // A socket that closes can still deliver a queued event. Acting on one would apply an
    // update through a transport that is no longer this provider's.
    vi.useFakeTimers();
    try {
      const { socket, document, sync } = provider();
      socket.emit("open", {});
      socket.emit("close", {});

      const stale = new Doc();
      stale.getText("body").insert(0, "from a dead socket");
      const frame = encodeBinaryFrame(0x02, "personal", "One.md", encodeStateAsUpdate(stale));
      socket.emit("message", { data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) });

      expect(document.getText("body").toString()).toBe("");
      sync.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("coming back online (SPEC §7.4)", () => {
  /** A stand-in for the browser's own network events. */
  function fakeNetwork() {
    const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
    return {
      target: {
        addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
          const existing = listeners.get(type) ?? new Set();
          existing.add(listener);
          listeners.set(type, existing);
        },
        removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
          listeners.get(type)?.delete(listener);
        },
      },
      fire(type: "online" | "offline"): void {
        for (const listener of [...(listeners.get(type) ?? [])]) {
          if (typeof listener === "function") listener(new Event(type));
        }
      },
      count(): number {
        return [...listeners.values()].reduce((total, set) => total + set.size, 0);
      },
    };
  }

  it("reconnects at once rather than waiting out the backoff", () => {
    // A laptop closed for an hour wakes mid-way through a thirty-second window. Without this
    // the user watches an "Offline" label for half a minute while plainly online.
    vi.useFakeTimers();
    try {
      const network = fakeNetwork();
      let opened = 0;
      const sockets: FakeSocket[] = [];
      const sync = createSyncProvider({
        endpoint: "ws://localhost/api/v1/sync",
        vault: "personal",
        note: "One.md",
        document: new Doc(),
        network: network.target,
        connect: () => {
          opened += 1;
          const next = new FakeSocket();
          sockets.push(next);
          return next as unknown as WebSocket;
        },
      });
      sockets.at(-1)?.emit("open", {});
      sockets.at(-1)?.emit("close", {});
      expect(opened).toBe(1);

      network.fire("online");

      expect(opened).toBe(2);
      // ...and the timer that was already scheduled does not then open a third.
      vi.advanceTimersByTime(60_000);
      expect(opened).toBe(2);
      sync.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing when it is already connected", () => {
    const network = fakeNetwork();
    let opened = 0;
    const socket = new FakeSocket();
    const sync = createSyncProvider({
      endpoint: "ws://localhost/api/v1/sync",
      vault: "personal",
      note: "One.md",
      document: new Doc(),
      network: network.target,
      connect: () => {
        opened += 1;
        return socket as unknown as WebSocket;
      },
    });
    socket.emit("open", {});

    network.fire("online");

    expect(opened).toBe(1);
    sync.destroy();
  });

  it("stops listening when the pane closes", () => {
    // AGENTS.md §4.3: every listener has a matching teardown, and a test that proves it.
    const network = fakeNetwork();
    const socket = new FakeSocket();
    const sync = createSyncProvider({
      endpoint: "ws://localhost/api/v1/sync",
      vault: "personal",
      note: "One.md",
      document: new Doc(),
      network: network.target,
      connect: () => socket as unknown as WebSocket,
    });
    expect(network.count()).toBe(2);

    sync.destroy();

    expect(network.count()).toBe(0);
  });

  it("gives up a socket the browser says cannot deliver anything", () => {
    // The state this exists for: a socket that has not noticed the network is gone accepts
    // every `send` and delivers none of them, while the UI reports itself connected. Closing
    // it is what turns the next edit into a counted, pending one (§7.4).
    vi.useFakeTimers();
    try {
      const network = fakeNetwork();
      const socket = new FakeSocket();
      const document = new Doc();
      const sync = createSyncProvider({
        endpoint: "ws://localhost/api/v1/sync",
        vault: "personal",
        note: "One.md",
        document,
        network: network.target,
        connect: () => socket as unknown as WebSocket,
      });
      socket.emit("open", {});
      expect(sync.connected).toBe(true);

      network.fire("offline");

      expect(sync.connected).toBe(false);
      expect(socket.closed).toBe(1);
      document.getText("body").insert(0, "written on a train");
      expect(sync.pending).toBe(1);
      sync.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not close a socket it does not have", () => {
    const network = fakeNetwork();
    const socket = new FakeSocket();
    const sync = createSyncProvider({
      endpoint: "ws://localhost/api/v1/sync",
      vault: "personal",
      note: "One.md",
      document: new Doc(),
      network: network.target,
      connect: () => socket as unknown as WebSocket,
    });
    sync.destroy();

    network.fire("offline");

    expect(socket.closed).toBe(1);
  });
});
