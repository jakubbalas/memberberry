/** Bounded reorder for the explicitly limited single-editor-per-note scope. */
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { ySyncPluginKey, yUndoPluginKey } from "y-prosemirror";
import type { Doc, UndoManager } from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type { ConnectionStatus } from "./collaboration.js";

/** One note/editor lifetime. noteKey must include vault identity, not a title/path label. */
export interface BlockMoveOptions {
  readonly editor: Editor;
  readonly document: Doc;
  readonly noteKey: string;
  readonly awareness?: Awareness;
  readonly connection?: ConnectionStatus;
  /** Rechecked at invocation; the host supplies mode/body/authorization readiness. */
  readonly canInteract?: () => boolean;
}
/** Opaque capture; backing editor/document/root node are controller-private. */
export interface BlockMoveToken { readonly label: string; readonly index: number; readonly start: number }
/** Distinguishes document invalidation from a known readiness-state change. */
export type BlockMoveChange = "document" | "safety";
/** Bounded mutation API; boundaries are root indices in the exact captured, pre-delete doc. */
export interface BlockMover {
  /** Capture the complete root containing a PM position, never a nested item/cell. */
  capture(pos: number): BlockMoveToken | undefined;
  /** Recheck lifetime, exact doc/generation and current single-editor/runtime readiness. */
  isCurrent(token: BlockMoveToken): boolean;
  /** Test a pre-delete boundary without writing; indices source/source+1 are no-ops. */
  canDrop(token: BlockMoveToken, boundary: number): boolean;
  /** Apply one adjacent move and isolate its real Y undo capture. */
  move(token: BlockMoveToken, direction: "up" | "down"): boolean;
  /** Apply one bounded delete/insert transaction; never accept external node/drop data. */
  drop(token: BlockMoveToken, boundary: number): boolean;
  /** Observe known-peer/connection/registration/Y-update changes; teardown is idempotent. */
  subscribe(listener: (change: BlockMoveChange) => void): () => void;
  destroy(): void;
}
interface Capture { doc: PMNode; node: PMNode; generation: number }
const mounted = new Map<string, Set<() => void>>();
function title(doc: PMNode): PMNode | undefined {
  return doc.firstChild?.type.name === "heading" && doc.firstChild.attrs["level"] === 1 ? doc.firstChild : undefined;
}
function label(node: PMNode): string {
  if (node.type.name === "bullet_list" || node.type.name === "ordered_list") {
    let tasks = true;
    node.forEach(child => { if (child.type.name !== "task_item") tasks = false; });
    return tasks ? "Move task list" : node.type.name === "ordered_list" ? "Move numbered list" : "Move list";
  }
  if (node.type.name === "paragraph" && node.childCount === 1 && node.firstChild?.type.name === "image") return "Move image";
  return `Move ${node.type.name.replaceAll("_", " ").replace("blockquote", "quote")}`;
}
function offset(doc: PMNode, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return pos;
}
/** Creates a local controller. Known peers are refused; this is not a distributed lock. */
export function createBlockMover(options: BlockMoveOptions): BlockMover {
  const { editor } = options;
  const captures = new WeakMap<BlockMoveToken, Capture>();
  let destroyed = false;
  let generation = 0;
  const listeners = new Set<(change: BlockMoveChange) => void>();
  const changed = (change: BlockMoveChange): void => { if (!destroyed) for (const listener of listeners) listener(change); };
  const safetyChanged = (): void => { changed("safety"); };
  const registration = safetyChanged;
  const registrations = mounted.get(options.noteKey) ?? new Set<() => void>();
  registrations.add(registration); mounted.set(options.noteKey, registrations);
  const allowed = (): boolean => {
    if (destroyed || editor.isDestroyed || !editor.isEditable || !editor.view.editable || editor.view.composing || !(options.canInteract?.() ?? true)) return false;
    const sync = ySyncPluginKey.getState(editor.state) as { doc: Doc } | undefined;
    if (options.noteKey.length === 0 || sync?.doc !== options.document || !yUndoPluginKey.getState(editor.state) || options.document.isDestroyed || registrations.size > 1) return false;
    const state = options.connection?.state;
    if (state && (!state.connected || !state.synced || state.pending !== 0)) return false;
    if (options.awareness) for (const [client, state] of options.awareness.getStates()) if (client !== options.awareness.clientID && state !== null) return false;
    return true;
  };
  const capture = (pos: number): BlockMoveToken | undefined => {
    if (!allowed()) return undefined;
    const doc = editor.state.doc;
    if (!Number.isInteger(pos) || pos < 0 || pos > doc.content.size) return undefined;
    const resolved = doc.resolve(pos);
    const index = resolved.index(0);
    if (index >= doc.childCount || (index === 0 && title(doc))) return undefined;
    const node = doc.child(index);
    // why: selection already resolves the root start; do not scan preceding roots on typing.
    const token = Object.freeze({ label: label(node), index, start: resolved.depth === 0 ? pos : resolved.before(1) });
    captures.set(token, { doc, node, generation });
    return token;
  };
  const isCurrent = (token: BlockMoveToken): boolean => {
    const saved = captures.get(token);
    return allowed() && saved !== undefined && saved.doc === editor.state.doc && saved.generation === generation;
  };
  const canDrop = (token: BlockMoveToken, boundary: number): boolean => {
    if (!isCurrent(token)) return false;
    const saved = captures.get(token);
    if (!saved || !Number.isInteger(boundary) || boundary < (title(saved.doc) ? 1 : 0) || boundary > saved.doc.childCount || boundary === token.index || boundary === token.index + 1) return false;
    if (!title(saved.doc) && token.index === 0 && saved.doc.childCount > 1) {
      const next = saved.doc.child(1);
      if (next.type.name === "heading" && next.attrs["level"] === 1) return false;
    }
    return !(boundary === 0 && saved.node.type.name === "heading" && saved.node.attrs["level"] === 1);
  };
  const drop = (token: BlockMoveToken, boundary: number): boolean => {
    if (!canDrop(token, boundary)) return false;
    const saved = captures.get(token);
    if (!saved) return false;
    const selection = editor.state.selection;
    const tr = editor.state.tr.delete(token.start, token.start + saved.node.nodeSize);
    const insertion = tr.mapping.map(offset(saved.doc, boundary), -1);
    tr.insert(insertion, saved.node);
    const originalTitle = title(saved.doc);
    if (originalTitle ? !tr.doc.firstChild?.eq(originalTitle) : title(tr.doc) !== undefined) return false;
    const relocate = (pos: number) => pos > token.start && pos < token.start + saved.node.nodeSize ? insertion + pos - token.start : tr.mapping.map(pos);
    if (selection instanceof TextSelection) tr.setSelection(TextSelection.create(tr.doc, relocate(selection.anchor), relocate(selection.head)));
    else if (selection instanceof NodeSelection && selection.from === token.start) tr.setSelection(NodeSelection.create(tr.doc, insertion));
    tr.setStoredMarks(editor.state.storedMarks);
    const manager = (yUndoPluginKey.getState(editor.state) as { undoManager: UndoManager } | undefined)?.undoManager;
    manager?.stopCapturing();
    try { editor.view.dispatch(tr); } finally { manager?.stopCapturing(); }
    return editor.state.doc.eq(tr.doc);
  };
  const move = (token: BlockMoveToken, direction: "up" | "down"): boolean => drop(token, direction === "up" ? token.index - 1 : token.index + 2);
  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    registrations.delete(registration);
    if (registrations.size === 0) mounted.delete(options.noteKey);
    editor.off("destroy", destroy);
    options.document.off("update", updated);
    options.document.off("destroy", destroy);
    options.awareness?.off("change", safetyChanged);
    unsubscribeConnection?.();
    listeners.clear();
    for (const notify of registrations) notify();
  };
  const updated = (): void => { generation++; changed("document"); };
  const unsubscribeConnection = options.connection?.subscribe(safetyChanged);
  options.awareness?.on("change", safetyChanged);
  options.document.on("update", updated);
  options.document.on("destroy", destroy);
  editor.on("destroy", destroy);
  for (const notify of registrations) notify();
  const subscribe = (listener: (change: BlockMoveChange) => void): (() => void) => {
    if (!destroyed) listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  return { capture, move, drop, isCurrent, canDrop, subscribe, destroy };
}
