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
export type InlineMark = "strong" | "em" | "strikethrough" | "highlight" | "code" | "mb_underline";
/** Finite independent namespace dimensions; null removes only this property. */
export type StyleProperty = "mb_color" | "mb_background" | "mb_size";
export type InlineFormat = InlineMark | "clear" | { readonly link: string | null } | { readonly property: StyleProperty; readonly value: string | null };
/** Semantic presets exposed by the generated schema, never arbitrary CSS. */
export const stylePresets = {
  mb_color: ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"],
  mb_background: ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"],
  mb_size: ["small", "large"],
} as const;
/** Mixed selection is distinct from absent/default. */
export function stylePropertyState(editor: Editor, token: FormatSelection, property: StyleProperty): string {
  const selection = resolveFormatSelection(editor, token);
  if (!selection) return "";
  const values = new Set<string>();
  editor.state.doc.nodesBetween(selection.from, selection.to, (node) => {
    if (!node.isText) return;
    const value: unknown = node.marks.find((mark) => mark.type.name === property)?.attrs["value"];
    values.add(typeof value === "string" ? value : "");
  });
  return values.size > 1 ? "mixed" : [...values][0] ?? "";
}
function actionName(action: InlineFormat): string {
  return typeof action === "string" ? action : "property" in action ? action.property : "link";
}
function removes(editor: Editor, token: FormatSelection, action: InlineFormat): boolean {
  return typeof action === "string" ? action !== "clear" && inlineFormatState(editor, token, action) === "true" : "property" in action ? action.value === null : action.link === null;
}
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

/** Refuses schema-excluded/lossy combinations rather than partially applying a command. */
export function canApplyInlineFormat(editor: Editor, token: FormatSelection, action: InlineFormat, canInteract: () => boolean = () => true): boolean {
  const selection = resolveFormatSelection(editor, token, canInteract);
  if (!selection) return false;
  if (action === "clear") return true;
  const name = actionName(action);
  const mark = editor.state.schema.marks[name];
  if (!mark) return false;
  if (typeof action !== "string") {
    if ("property" in action) {
      if (action.value !== null && !(stylePresets[action.property] as readonly string[]).includes(action.value)) return false;
    } else if (action.link !== null && linkDestination(action.link).kind === "blocked") return false;
  }
  const removing = removes(editor, token, action);
  let safe = true;
  editor.state.doc.nodesBetween(selection.from, selection.to, (node, _pos, parent) => {
    if (action === "code" && node.isInline && !node.isText) safe = false;
    if (!node.isText) return;
    if (!parent?.type.allowsMarkType(mark)) safe = false;
    if (!removing && node.marks.some((existing) => {
      if (existing.type === mark) return false;
      // why: ordinary native wrappers surround literal Code; future namespace styles
      // must not gain code compatibility merely by omitting their schema exclusion.
      const native = ["strong", "em", "strikethrough", "highlight", "code", "link"];
      if ((name === "code" || existing.type.name === "code") &&
          (!native.includes(name) || !native.includes(existing.type.name))) return true;
      return mark.excludes(existing.type) || existing.type.excludes(mark);
    })) safe = false;
  });
  return safe;
}

/** Applies one isolated collaborative undo item, refusing stale/unsafe captures again. */
export function applyInlineFormat(editor: Editor, token: FormatSelection, action: InlineFormat, canInteract: () => boolean = () => true): FormatResult {
  const selection = resolveFormatSelection(editor, token, canInteract);
  const name = actionName(action);
  const mark = editor.state.schema.marks[name];
  if (!selection || !canApplyInlineFormat(editor, token, action, canInteract)) return "refused";
  const transaction = editor.state.tr.setSelection(selection);
  if (action === "clear") {
    for (const name of ["strong", "em", "strikethrough", "highlight", "code", "link", "mb_underline", "mb_color", "mb_background", "mb_size"]) {
      const type = editor.state.schema.marks[name];
      if (type) transaction.removeMark(selection.from, selection.to, type);
    }
  } else if (mark) {
    const removing = removes(editor, token, action);
    if (removing) transaction.removeMark(selection.from, selection.to, mark);
    else editor.state.doc.nodesBetween(selection.from, selection.to, (node, pos) => {
      if (!node.isText) return;
      // why: the destination-only action does not edit authored titles. Preserve each
      // existing run independently; newly linked plain text uses the schema's null title.
      const existing = node.marks.find((candidate) => candidate.type === mark);
      const title = typeof existing?.attrs["title"] === "string" ? existing.attrs["title"] : null;
      transaction.addMark(Math.max(pos, selection.from), Math.min(pos + node.nodeSize, selection.to),
        mark.create(typeof action === "string" ? undefined : "property" in action ? { value: action.value } : { href: action.link?.trim(), title }));
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
