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
import { ySyncPlugin, yUndoPlugin } from "y-prosemirror";

/** The Y.XmlFragment root name defined by the Rust CRDT contract. */
export const PROSEMIRROR_ROOT = "prosemirror";

/** A persistence provider with the lifecycle Memberberry needs from y-indexeddb. */
export interface LocalPersistence {
  readonly whenSynced: Promise<unknown>;
  destroy(): Promise<void>;
}

/** Constructs a persistence provider; injectable so lifecycle behaviour stays unit-testable. */
export type LocalPersistenceFactory = (name: string, document: Doc) => LocalPersistence;

/** One locally persisted note document, ready to attach to a Tiptap editor. */
export interface NoteCollaboration {
  readonly document: Doc;
  readonly fragment: XmlFragment;
  readonly whenReady: Promise<void>;
  destroy(): Promise<void>;
}

export interface CreateNoteCollaborationOptions {
  readonly vaultId: string;
  readonly noteId: string;
  readonly createPersistence?: LocalPersistenceFactory;
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
  const fragment = document.getXmlFragment(PROSEMIRROR_ROOT);
  const createPersistence = options.createPersistence ?? defaultPersistence;
  const persistence = createPersistence(name, document);
  const whenReady = persistence.whenSynced.then(() => undefined);
  let destroyed: Promise<void> | undefined;

  return {
    document,
    fragment,
    whenReady,
    destroy: () => {
      destroyed ??= persistence.destroy().then(() => document.destroy());
      return destroyed;
    },
  };
}

/** Creates the Tiptap extension that maps editor transactions to the note's Y.XmlFragment. */
export function createYjsBinding(fragment: XmlFragment): Extension {
  return Extension.create({
    name: "memberberryYjs",
    addProseMirrorPlugins: () => yjsPlugins(fragment),
  });
}

/** The ProseMirror plugins that keep one editor view synchronized with its local Y.Doc. */
export function yjsPlugins(fragment: XmlFragment): Plugin[] {
  return [ySyncPlugin(fragment), yUndoPlugin()];
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
