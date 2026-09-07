/**
 * Local Yjs lifecycle for one open Memberberry note.
 *
 * This is intentionally local-only. Server transport and awareness must be added through the
 * permission-aware sync path, never by a browser-side provider configured here.
 */

import { Extension } from "@tiptap/core";
import type { Plugin } from "@tiptap/pm/state";
import { IndexeddbPersistence } from "y-indexeddb";
import { Doc, type XmlFragment } from "yjs";
import { Awareness } from "y-protocols/awareness";
import { yCursorPlugin, ySyncPlugin, yUndoPlugin } from "y-prosemirror";

import { presenceCursorBuilder } from "./presence.js";
import {
  createSyncProvider,
  presenceColor,
  type ConnectionState,
  type ServerState,
  type SyncProvider,
} from "./sync.js";

/** The Y.XmlFragment root name defined by the Rust CRDT contract. */
export const PROSEMIRROR_ROOT = "prosemirror";

/** A persistence provider with the lifecycle Memberberry needs from y-indexeddb. */
export interface LocalPersistence {
  readonly whenSynced: Promise<unknown>;
  destroy(): Promise<void>;
}

/** Constructs a persistence provider; injectable so lifecycle behaviour stays unit-testable. */
export type LocalPersistenceFactory = (name: string, document: Doc) => LocalPersistence;

/** What the server transport is doing, for hosts that have to say so.
 *
 * `SPEC.md` §7.5: offline you are alone, and the UI says so rather than showing stale
 * avatars. §7.4 adds the other half — how many changes are waiting to be sent. A note with
 * no server transport has no connection to report, so this is absent for local-only
 * documents rather than permanently claiming "offline".
 */
export interface ConnectionStatus {
  readonly state: ConnectionState;
  /** Registers a listener, calls it with the current state, and returns its teardown. */
  subscribe(listener: (state: ConnectionState) => void): () => void;
}

/** One locally persisted note document, ready to attach to a Tiptap editor. */
export interface NoteCollaboration {
  readonly document: Doc;
  readonly fragment: XmlFragment;
  readonly awareness: Awareness;
  readonly connection?: ConnectionStatus;
  /** Raised each time the server sends this note's whole state (§3.5). */
  readonly serverState: ServerStateSignal;
  readonly whenReady: Promise<void>;
  destroy(): Promise<void>;
}

/** A one-slot event: the server's whole state, held until something is listening for it. */
export interface ServerStateSignal {
  /** Registers the handler and returns its teardown. */
  subscribe(handler: (state: ServerState) => void): () => void;
}

/**
 * A server-state signal that buffers the most recent event.
 *
 * why: buffered rather than fire-and-forget. The transport connects as soon as the local
 * replica is restored, and the editor that reconciles a divergence is created a moment
 * later — so a divergence detected in that window would be delivered to nobody, and a note
 * would merge silently exactly when a reader was least expecting it. One slot is enough:
 * two of these before the first is handled would both be against the same local state, and
 * the later one carries the newer server version.
 */
export function createServerStateSignal(): ServerStateSignal & {
  raise(state: ServerState): void;
} {
  let handler: ((state: ServerState) => void) | undefined;
  let held: ServerState | undefined;
  return {
    subscribe(next): () => void {
      handler = next;
      const buffered = held;
      held = undefined;
      if (buffered !== undefined) next(buffered);
      return () => {
        handler = undefined;
      };
    },
    raise(state): void {
      if (handler === undefined) {
        held = state;
        return;
      }
      handler(state);
    },
  };
}

/** A mutable connection status plus the setter its transport drives. */
export function createConnectionStatus(): ConnectionStatus & { set(state: ConnectionState): void } {
  const listeners = new Set<(state: ConnectionState) => void>();
  let state: ConnectionState = { connected: false, pending: 0, synced: false };
  return {
    get state(): ConnectionState {
      return state;
    },
    subscribe(listener: (state: ConnectionState) => void): () => void {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    set(next: ConnectionState): void {
      if (
        next.connected === state.connected
        && next.pending === state.pending
        && next.synced === state.synced
      ) {
        return;
      }
      state = next;
      for (const listener of listeners) listener(next);
    },
  };
}

/** A server-backed transport identity, supplied only for a routed vault note. */
export interface RemoteSyncOptions {
  readonly endpoint: string;
  readonly vault: string;
  readonly note: string;
  readonly user: string;
}

export interface CreateNoteCollaborationOptions {
  readonly vaultId: string;
  readonly noteId: string;
  readonly createPersistence?: LocalPersistenceFactory;
  readonly remoteSync?: RemoteSyncOptions;
  readonly createRemoteSync?: (
    options: RemoteSyncOptions,
    document: Doc,
    awareness: Awareness,
    onConnectionChange: (state: ConnectionState) => void,
    onServerState: (state: ServerState) => void,
  ) => SyncProvider;
}

/**
 * Opens a new local Y.Doc and starts restoring its IndexedDB replica.
 *
 * Consumers must await `whenReady` before mounting y-prosemirror. Otherwise an empty editor
 * can initialize the fragment before the durable local state has been applied.
 */
export function createNoteCollaboration(options: CreateNoteCollaborationOptions): NoteCollaboration {
  const name = persistenceName(options.vaultId, options.noteId);
  const document = new Doc({ gc: true });
  const awareness = new Awareness(document);
  if (options.remoteSync !== undefined) {
    awareness.setLocalStateField("user", { name: options.remoteSync.user, color: presenceColor(options.remoteSync.user) });
  }
  const fragment = document.getXmlFragment(PROSEMIRROR_ROOT);
  const createPersistence = options.createPersistence ?? defaultPersistence;
  const persistence = createPersistence(name, document);
  let remote: SyncProvider | undefined;
  const status = options.remoteSync === undefined ? undefined : createConnectionStatus();
  const serverState = createServerStateSignal();
  const whenReady = persistence.whenSynced.then(() => {
    if (options.remoteSync !== undefined) {
      const createRemoteSync = options.createRemoteSync ?? defaultRemoteSync;
      remote = createRemoteSync(
        options.remoteSync,
        document,
        awareness,
        (state) => status?.set(state),
        serverState.raise,
      );
    }
  });
  let destroyed: Promise<void> | undefined;

  return {
    document,
    fragment,
    awareness,
    serverState,
    ...(status === undefined ? {} : { connection: status }),
    whenReady,
    destroy: () => {
      destroyed ??= whenReady.catch(() => undefined).then(() => persistence.destroy()).then(() => {
        remote?.destroy();
        document.destroy();
      });
      return destroyed;
    },
  };
}

/** Creates the Tiptap extension that maps editor transactions to the note's Y.XmlFragment. */
export function createYjsBinding(fragment: XmlFragment, awareness?: Awareness): Extension {
  return Extension.create({
    name: "memberberryYjs",
    addProseMirrorPlugins: () => yjsPlugins(fragment, awareness),
  });
}

/** The ProseMirror plugins that keep one editor view synchronized with its local Y.Doc. */
export function yjsPlugins(fragment: XmlFragment, awareness?: Awareness): Plugin[] {
  // why: the default cursor builder emits no client id, which leaves no way to age one
  // caret without re-rendering every decoration. §7.5's fades need per-caret identity.
  const cursors = awareness === undefined
    ? []
    : [yCursorPlugin(awareness, { cursorBuilder: presenceCursorBuilder })];
  return [ySyncPlugin(fragment), yUndoPlugin(), ...cursors];
}

/** A collision-free IndexedDB database name for a vault-local note identity. */
export function persistenceName(vaultId: string, noteId: string): string {
  if (vaultId.length === 0 || noteId.length === 0) {
    throw new Error("vaultId and noteId must not be empty");
  }
  return `memberberry:ydoc:${encodeURIComponent(vaultId)}:${encodeURIComponent(noteId)}`;
}

function defaultPersistence(name: string, document: Doc): LocalPersistence {
  return new IndexeddbPersistence(name, document);
}

function defaultRemoteSync(
  options: RemoteSyncOptions,
  document: Doc,
  awareness: Awareness,
  onConnectionChange: (state: ConnectionState) => void,
  onServerState: (state: ServerState) => void,
): SyncProvider {
  return createSyncProvider({
    ...options,
    document,
    awareness,
    onConnectionChange,
    onServerState,
  });
}
