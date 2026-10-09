/** Native block conversion on exact editor/document snapshots; no Markdown codec. */
import type { Editor } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { TextSelection, type Selection, type SelectionBookmark, type Transaction } from "@tiptap/pm/state";
import { yUndoPluginKey } from "y-prosemirror";
import { resolveFormatSelection, type FormatSelection } from "./selection-format.js";

/** Opaque editor-local selection capture. Raw positions are not accepted as tokens. */
export interface BlockSelection { readonly kind: "memberberry-block-selection" }
/** Native Markdown choices only; imported H5/H6 remain visible as active state. */
export type BlockFormat = "text" | "h1" | "h2" | "h3" | "h4" | "bullet_list" | "ordered_list" | "task_item" | "blockquote" | "callout" | "toggle" | "code_block" | "math_block";
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
  ["toggle", "Toggle"],
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
/** Builds the replacement for a container target, or a refusal reason. */
function container(editor: Editor, units: readonly Unit[], format: BlockFormat): Node | string {
  const nodes = editor.state.schema.nodes;
  const blocks = units.map(({ node }) => node);
  try {
    switch (format) {
      // why: list items, quotes and callouts hold whole blocks, so each selected block moves
      // in unchanged — headings stay headings, and marks and `^anchors` come along.
      case "bullet_list":
      case "ordered_list": {
        const item = nodes["list_item"];
        const list = nodes[format];
        if (!item || !list) return "unsupported";
        return list.createChecked(format === "ordered_list" ? { start: 1 } : null, blocks.map((block) => item.createChecked(null, block)));
      }
      case "task_item": {
        const task = nodes["task_item"];
        const list = nodes["bullet_list"];
        if (!task || !list) return "unsupported";
        return list.createChecked(null, blocks.map((block) => task.createChecked({ status: "todo", unknown: [] }, block)));
      }
      case "blockquote": {
        const quote = nodes["blockquote"];
        return quote ? quote.createChecked(null, blocks) : "unsupported";
      }
      case "callout": {
        const callout = nodes["callout"];
        const title = nodes["callout_title"];
        if (!callout || !title) return "unsupported";
        return callout.createChecked({ kind: "note", fold: "none" }, [title.createChecked(), ...blocks]);
      }
      // A toggle is a foldable callout (`> [!note]+ Summary`, SPEC §8.4): the first block's
      // inline content is the summary, the rest its body, and its anchor moves to the toggle.
      case "toggle": {
        const callout = nodes["callout"];
        const title = nodes["callout_title"];
        const paragraph = nodes["paragraph"];
        const [summary, ...body] = blocks;
        if (!callout || !title || !paragraph || !summary) return "unsupported";
        const anchor = summary.attrs["anchor"];
        return callout.createChecked(
          { kind: "note", fold: "expanded", ...(typeof anchor === "string" ? { anchor } : {}) },
          [title.createChecked(null, summary.content), ...(body.length > 0 ? body : [paragraph.createChecked()])],
        );
      }
      case "code_block":
      case "math_block": {
        const type = nodes[format];
        if (!type) return "unsupported";
        // why: code holds no marks, links or atoms. Converting formatted text would drop
        // them silently, so only plain text converts (SPEC §8.4: preserve marks/atoms).
        if (blocks.some((block) => !block.content.content.every((child) => child.isText && child.marks.length === 0))) return "formatted";
        const anchors = blocks.flatMap((block) => typeof block.attrs["anchor"] === "string" ? [block.attrs["anchor"]] : []);
        if (anchors.length > 1) return "anchored";
        const text = blocks.map((block) => block.textContent).join("\n");
        return type.createChecked(anchors[0] === undefined ? null : { anchor: anchors[0] }, text.length === 0 ? null : editor.state.schema.text(text));
      }
      default:
        return "unsupported";
    }
  } catch {
    // why: createChecked throws on a shape the schema rejects; refuse rather than write it.
    return "unsupported";
  }
}
function prepare(editor: Editor, capture: Capture, format: BlockFormat): Transaction | string {
  if (!choices.some(([name]) => name === format)) return "unsupported";
  if (format === "h1" && capture.units[0]?.index === 0) return "title";
  if (capture.units.some(({ node }) => !["paragraph", "heading"].includes(node.type.name))) return "unsupported";
  const first = capture.units[0];
  const last = capture.units[capture.units.length - 1];
  if (!first || !last) return "unsupported";
  const level = { h1: 1, h2: 2, h3: 3, h4: 4 }[format as "h1" | "h2" | "h3" | "h4"];
  if (format !== "text" && !level) {
    const replacement = container(editor, capture.units, format);
    if (typeof replacement === "string") return replacement;
    const tr = editor.state.tr.replaceWith(first.pos, last.pos + last.node.nodeSize, replacement);
    const summary = replacement.firstChild;
    // why: a fresh single-block toggle has an empty body to fill, as in Notion; leaving the
    // summary selected meant the next keystroke replaced it.
    if (format === "toggle" && capture.units.length === 1 && summary !== null) {
      return tr.setSelection(TextSelection.create(tr.doc, first.pos + 1 + summary.nodeSize + 1));
    }
    // why: the old range was replaced wholesale; keep the converted text selected.
    return tr.setSelection(TextSelection.between(tr.doc.resolve(first.pos), tr.doc.resolve(first.pos + replacement.nodeSize)));
  }
  const type = editor.state.schema.nodes[format === "text" ? "paragraph" : "heading"];
  if (!type) return "unsupported";
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
