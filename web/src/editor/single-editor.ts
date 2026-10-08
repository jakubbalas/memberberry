/** The single-editor-per-note safety gate for structural edits (SPEC §8.4). Not a lock. */
import type { Editor } from "@tiptap/core";
import { ySyncPluginKey, yUndoPluginKey } from "y-prosemirror";
import type { Doc } from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type { ConnectionStatus } from "./collaboration.js";

/** Why a structural edit is refused right now; absence means the known checks pass. */
export type SingleEditorRefusal = "unbound" | "duplicate" | "peer" | "offline" | "pending";

/** One note/editor binding. noteKey must include vault identity, not a title/path label. */
export interface SingleEditorOptions {
  readonly editor: Editor;
  readonly document: Doc;
  readonly noteKey: string;
  readonly awareness?: Awareness;
  readonly connection?: ConnectionStatus;
}

/** Rechecked at every capability and invocation boundary; teardown is idempotent. */
export interface SingleEditorGate {
  refusal(): SingleEditorRefusal | undefined;
  /** Known-peer, connection and same-note mount changes. */
  subscribe(listener: () => void): () => void;
  destroy(): void;
}

/** Plain-language reasons for a visible disabled state. */
export const singleEditorMessages: Readonly<Record<SingleEditorRefusal, string>> = {
  unbound: "Unavailable for this editor",
  duplicate: "This note is open in another editor here",
  peer: "Someone else has this note open",
  offline: "Waiting for the connection to sync",
  pending: "Waiting for unsaved changes to sync",
};

// why: count distinct editors per note, not controllers. One editor legitimately mounts
// several gated controllers (conversion, movement); a second *editor* is the duplicate.
const mounted = new Map<string, Map<Editor, Set<() => void>>>();

function notifyAll(noteKey: string): void {
  for (const listeners of mounted.get(noteKey)?.values() ?? []) for (const notify of listeners) notify();
}

/** Registers this editor's mount for noteKey until destroy, editor or document teardown. */
export function createSingleEditorGate(options: SingleEditorOptions): SingleEditorGate {
  const { editor, document, noteKey, awareness, connection } = options;
  const listeners = new Set<() => void>();
  let destroyed = false;
  const changed = (): void => { if (!destroyed) for (const listener of listeners) listener(); };
  const editors = mounted.get(noteKey) ?? new Map<Editor, Set<() => void>>();
  mounted.set(noteKey, editors);
  const own = editors.get(editor) ?? new Set<() => void>();
  editors.set(editor, own);
  own.add(changed);
  const refusal = (): SingleEditorRefusal | undefined => {
    if (destroyed || editor.isDestroyed || document.isDestroyed || noteKey.length === 0) return "unbound";
    const sync = ySyncPluginKey.getState(editor.state) as { doc: Doc } | undefined;
    if (sync?.doc !== document || !yUndoPluginKey.getState(editor.state)) return "unbound";
    if ((mounted.get(noteKey)?.size ?? 0) > 1) return "duplicate";
    if (awareness) for (const [client, state] of awareness.getStates()) if (client !== awareness.clientID && state !== null) return "peer";
    const state = connection?.state;
    if (state && (!state.connected || !state.synced)) return "offline";
    if (state && state.pending !== 0) return "pending";
    return undefined;
  };
  const unsubscribeConnection = connection?.subscribe(changed);
  awareness?.on("change", changed);
  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    own.delete(changed);
    if (own.size === 0) editors.delete(editor);
    if (editors.size === 0) mounted.delete(noteKey);
    awareness?.off("change", changed);
    unsubscribeConnection?.();
    editor.off("destroy", destroy);
    document.off("destroy", destroy);
    listeners.clear();
    notifyAll(noteKey);
  };
  editor.on("destroy", destroy);
  document.on("destroy", destroy);
  notifyAll(noteKey);
  return {
    refusal,
    subscribe: (listener) => {
      if (!destroyed) listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    destroy,
  };
}
