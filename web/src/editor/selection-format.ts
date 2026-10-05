/** Snapshot-bound inline edits on the Rust-generated Markdown schema. */
import type { Editor } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { TextSelection, type SelectionBookmark } from "@tiptap/pm/state";
import { yUndoPluginKey } from "y-prosemirror";
import { linkDestination } from "./links.js";

/** Opaque capture: offsets cannot be reused in a different editor or document. */
export interface FormatSelection { readonly kind: "memberberry-format-selection" }
interface Capture { readonly editor: Editor; readonly doc: Node; readonly bookmark: SelectionBookmark }
const captures = new WeakMap<FormatSelection, Capture>();
/** Native Markdown actions; no HTML or block rewriting. */
export type InlineMark = "strong" | "em" | "strikethrough" | "highlight" | "code";
export type InlineFormat = InlineMark | "clear" | { readonly link: string | null };
/** Refusal is explicit, including when a plugin filters out a transaction. */
export type FormatResult = "applied" | "unchanged" | "refused";

function eligible(editor: Editor, selection: TextSelection, canInteract: () => boolean): boolean {
  if (editor.isDestroyed || !editor.isEditable || !editor.view.editable || editor.view.composing || !canInteract() || editor.view.dom.hidden || selection.empty) return false;
  const first = editor.state.doc.firstChild;
  if (first?.type.name === "heading" && first.attrs["level"] === 1 && selection.from < first.nodeSize) return false;
  let text = false;
  let literal = false;
  editor.state.doc.nodesBetween(selection.from, selection.to, (node) => {
    if (node.type.spec.code) literal = true;
    if (node.isText && node.text) text = true;
  });
  return text && !literal;
}

/** Captures only nonempty body text; callers supply the live mode/readiness gate. */
export function captureFormatSelection(editor: Editor, canInteract: () => boolean = () => true, selection = editor.state.selection): FormatSelection | undefined {
  if (!(selection instanceof TextSelection) || selection.$from.doc !== editor.state.doc || !eligible(editor, selection, canInteract)) return undefined;
  const token: FormatSelection = { kind: "memberberry-format-selection" };
  captures.set(token, { editor, doc: editor.state.doc, bookmark: selection.getBookmark() });
  return token;
}

/** Resolves only against the exact captured document and editor lifetime. */
export function resolveFormatSelection(editor: Editor, token: FormatSelection, canInteract: () => boolean = () => true): TextSelection | undefined {
  const capture = captures.get(token);
  if (!capture || capture.editor !== editor || editor.isDestroyed || capture.doc !== editor.state.doc) return undefined;
  const selection = capture.bookmark.resolve(editor.state.doc);
  return selection instanceof TextSelection && eligible(editor, selection, canInteract) ? selection : undefined;
}

/** Reports all/mixed/no selected text carrying this mark, ignoring inline atoms. */
export function inlineFormatState(editor: Editor, token: FormatSelection, action: InlineMark | "link"): "true" | "false" | "mixed" {
  const selection = resolveFormatSelection(editor, token);
  if (!selection) return "false";
  let marked = false;
  let plain = false;
  editor.state.doc.nodesBetween(selection.from, selection.to, (node) => {
    if (!node.isText) return;
    if (node.marks.some((mark) => mark.type.name === action)) marked = true;
    else plain = true;
  });
  return marked ? plain ? "mixed" : "true" : "false";
}

/** Refuses literal/lossy combinations rather than allowing a partially applied command. */
export function canApplyInlineFormat(editor: Editor, token: FormatSelection, action: InlineFormat, canInteract: () => boolean = () => true): boolean {
  const selection = resolveFormatSelection(editor, token, canInteract);
  if (!selection) return false;
  if (action === "clear") return true;
  const name = typeof action === "string" ? action : "link";
  const mark = editor.state.schema.marks[name];
  if (!mark || (typeof action !== "string" && action.link !== null && linkDestination(action.link).kind === "blocked")) return false;
  const removing = typeof action === "string" ? inlineFormatState(editor, token, action) === "true" : action.link === null;
  let safe = true;
  editor.state.doc.nodesBetween(selection.from, selection.to, (node, _pos, parent) => {
    if (action === "code" && node.isInline && !node.isText) safe = false;
    if (!node.isText) return;
    if (!parent?.type.allowsMarkType(mark)) safe = false;
    if (!removing && node.marks.some((existing) =>
      action === "code" ? existing.type.name !== "code" : existing.type.name === "code")) safe = false;
  });
  return safe;
}

/** Applies one isolated collaborative undo item, refusing stale/unsafe captures again. */
export function applyInlineFormat(editor: Editor, token: FormatSelection, action: InlineFormat, canInteract: () => boolean = () => true): FormatResult {
  const selection = resolveFormatSelection(editor, token, canInteract);
  const name = typeof action === "string" ? action : "link";
  const mark = editor.state.schema.marks[name];
  if (!selection || !canApplyInlineFormat(editor, token, action, canInteract)) return "refused";
  const transaction = editor.state.tr.setSelection(selection);
  if (action === "clear") {
    for (const name of ["strong", "em", "strikethrough", "highlight", "code", "link"]) {
      const type = editor.state.schema.marks[name];
      if (type) transaction.removeMark(selection.from, selection.to, type);
    }
  } else if (mark) {
    const removing = typeof action === "string" ? inlineFormatState(editor, token, action) === "true" : action.link === null;
    if (removing) transaction.removeMark(selection.from, selection.to, mark);
    else editor.state.doc.nodesBetween(selection.from, selection.to, (node, pos) => {
      if (!node.isText) return;
      // why: the destination-only action does not edit authored titles. Preserve each
      // existing run independently; newly linked plain text uses the schema's null title.
      const existing = node.marks.find((candidate) => candidate.type === mark);
      const title = typeof existing?.attrs["title"] === "string" ? existing.attrs["title"] : null;
      transaction.addMark(Math.max(pos, selection.from), Math.min(pos + node.nodeSize, selection.to),
        mark.create(typeof action === "string" ? undefined : { href: action.link?.trim(), title }));
    });
  }
  if (!transaction.docChanged) {
    // why: native selection may be ahead of the model even for a no-op Clear/unlink.
    if (!editor.state.selection.eq(selection)) editor.view.dispatch(transaction);
    return "unchanged";
  }
  const undo = yUndoPluginKey.getState(editor.state)?.undoManager;
  undo?.stopCapturing();
  try { editor.view.dispatch(transaction); } finally { undo?.stopCapturing(); }
  return editor.state.doc === transaction.doc ? "applied" : "refused";
}
