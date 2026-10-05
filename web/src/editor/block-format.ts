/** Native block conversion on exact editor/document snapshots; no Markdown codec. */
import type { Editor } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { TextSelection, type Selection, type SelectionBookmark, type Transaction } from "@tiptap/pm/state";
import { yUndoPluginKey } from "y-prosemirror";
import { resolveFormatSelection, type FormatSelection } from "./selection-format.js";

/** Opaque editor-local selection capture. Raw positions are not accepted as tokens. */
export interface BlockSelection { readonly kind: "memberberry-block-selection" }
/** Native Markdown choices only; imported H5/H6 remain visible as active state. */
export type BlockFormat = "text" | "h1" | "h2" | "h3" | "h4" | "bullet_list" | "ordered_list" | "task_item" | "blockquote" | "callout" | "code_block" | "math_block";
/** Explicit refusal; callers must not treat a filtered dispatch as applied. */
export type BlockFormatResult = { readonly status: "applied" | "unchanged" } | { readonly status: "refused"; readonly reason: string };
/** Menu capability, shared with the handler's preflight. */
export interface BlockFormatChoice { readonly format: BlockFormat; readonly label: string; readonly enabled: boolean; readonly reason?: string }
/** A stale token has no meaningful active state. */
export interface BlockFormatState { readonly eligible: boolean; readonly active: string; readonly choices: readonly BlockFormatChoice[]; readonly reason?: string }
interface Unit { readonly pos: number; readonly node: Node; readonly index: number }
interface Capture { readonly editor: Editor; readonly doc: Node; readonly bookmark: SelectionBookmark; readonly units: readonly Unit[]; readonly canInteract: () => boolean }
const captures = new WeakMap<BlockSelection, Capture>();
const choices: readonly (readonly [BlockFormat, string])[] = [
  ["text", "Text"], ["h1", "Heading 1"], ["h2", "Heading 2"], ["h3", "Heading 3"], ["h4", "Heading 4"],
  ["bullet_list", "Bulleted list"], ["ordered_list", "Numbered list"], ["task_item", "To-do list"],
  ["code_block", "Code"], ["blockquote", "Quote"], ["callout", "Callout (Note)"], ["math_block", "Block equation"],
];
function guard(editor: Editor, canInteract: () => boolean): string | undefined {
  if (editor.isDestroyed) return "destroyed";
  if (!editor.isEditable || !editor.view.editable) return "readonly";
  if (editor.view.composing) return "composition";
  if (!canInteract() || editor.view.dom.hidden) return "unavailable";
  return undefined;
}
function reason(editor: Editor, capture: Capture | undefined, canInteract: () => boolean): string | undefined {
  const blocked = guard(editor, () => canInteract() && (capture?.canInteract() ?? true));
  if (blocked) return blocked;
  if (!capture || capture.editor !== editor) return "foreign";
  if (capture.doc !== editor.state.doc) return "stale";
  return undefined;
}
/**
 * Partial root-text selections affect complete containing blocks, never selected words alone.
 * Carets target their root textblock. Nested/container selections are not implicitly flattened.
 * Capture the native PM snapshot at the menu handoff; an inline-menu token is also accepted.
 */
export function captureBlockSelection(editor: Editor, canInteract: () => boolean = () => true, selection?: Selection | FormatSelection): BlockSelection | undefined {
  if (guard(editor, canInteract)) return undefined;
  const selected = selection && "kind" in selection ? resolveFormatSelection(editor, selection, canInteract) : selection ?? editor.state.selection;
  if (!(selected instanceof TextSelection) || selected.$from.doc !== editor.state.doc || selected.$from.depth !== 1 || selected.$to.depth !== 1) return undefined;
  const first = editor.state.doc.firstChild;
  if (first?.type.name === "heading" && first.attrs["level"] === 1 && selected.from < first.nodeSize) return undefined;
  const units: Unit[] = [];
  const start = selected.$from.index(0);
  const end = selected.$to.index(0);
  let pos = selected.$from.before(1);
  for (let index = start; index <= end; index++) {
    const node = editor.state.doc.child(index);
    if (!node.isTextblock) return undefined;
    units.push({ pos, node, index });
    pos += node.nodeSize;
  }
  const token: BlockSelection = { kind: "memberberry-block-selection" };
  captures.set(token, { editor, doc: editor.state.doc, bookmark: selected.getBookmark(), units, canInteract });
  return token;
}
function active(node: Node): string {
  return node.type.name === "heading" ? `h${String(node.attrs["level"])}` : node.type.name === "paragraph" ? "text" : node.type.name;
}
function prepare(editor: Editor, capture: Capture, format: BlockFormat): Transaction | string {
  if (!choices.some(([name]) => name === format)) return "unsupported";
  if (format === "h1" && capture.units[0]?.index === 0) return "title";
  const level = { h1: 1, h2: 2, h3: 3, h4: 4 }[format as "h1" | "h2" | "h3" | "h4"];
  const type = editor.state.schema.nodes[format === "text" ? "paragraph" : level ? "heading" : "unsupported"];
  if (!type || capture.units.some(({ node }) => !["paragraph", "heading"].includes(node.type.name))) return "unsupported";
  const tr = editor.state.tr.setSelection(capture.bookmark.resolve(editor.state.doc));
  for (const { pos, node } of capture.units) {
    const attrs = { ...node.attrs, ...(level ? { level } : {}) };
    if (!node.hasMarkup(type, attrs)) tr.setNodeMarkup(pos, type, attrs);
  }
  return tr;
}
/** Reports the complete units' active style and every native choice's refusal explanation. */
export function blockFormatState(editor: Editor, token: BlockSelection, canInteract: () => boolean = () => true): BlockFormatState {
  const capture = captures.get(token);
  const blocked = reason(editor, capture, canInteract);
  const formats = capture?.units.map(({ node }) => active(node)) ?? [];
  const current = blocked ? "unsupported" : formats.every((name) => name === formats[0]) ? formats[0] ?? "unsupported" : "mixed";
  return {
    eligible: !blocked, active: current,
    choices: choices.map(([format, label]) => {
      const prepared = !blocked && capture ? prepare(editor, capture, format) : blocked ?? "foreign";
      return { format, label, enabled: typeof prepared !== "string", ...(typeof prepared === "string" ? { reason: prepared } : {}) };
    }),
    ...(blocked ? { reason: blocked } : {}),
  };
}
/** Convert existing content in one isolated Yjs undo item; recheck all live gates. */
export function applyBlockFormat(editor: Editor, token: BlockSelection, format: BlockFormat, canInteract: () => boolean = () => true): BlockFormatResult {
  const capture = captures.get(token);
  const blocked = reason(editor, capture, canInteract);
  if (blocked || !capture) return { status: "refused", reason: blocked ?? "foreign" };
  const tr = prepare(editor, capture, format);
  if (typeof tr === "string") return { status: "refused", reason: tr };
  if (!tr.docChanged) return { status: "unchanged" };
  const undo = yUndoPluginKey.getState(editor.state)?.undoManager;
  undo?.stopCapturing();
  try { editor.view.dispatch(tr); } finally { undo?.stopCapturing(); }
  return editor.state.doc === tr.doc ? { status: "applied" } : { status: "refused", reason: "filtered" };
}
