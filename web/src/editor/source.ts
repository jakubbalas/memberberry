/** Source-view bridge. Markdown conversion is delegated to Rust/WASM. */

import type { Editor } from "@tiptap/core";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import { applyUpdate, Doc, encodeStateAsUpdate, type XmlFragment } from "yjs";

import { markdownFromUpdate, type NoteBridge, noteBridge } from "../notes.js";
import { PROSEMIRROR_ROOT } from "./collaboration.js";

/** Reads the active Y.Doc as canonical Markdown through the WASM boundary. */
export async function editorMarkdown(document: Doc): Promise<string> {
  return markdownFromUpdate(encodeStateAsUpdate(document));
}

/** Parses source Markdown through WASM and replaces the editor content with the result. */
export async function applySourceMarkdown(editor: Editor, markdown: string): Promise<void> {
  applySourceMarkdownWith(await noteBridge(), editor.view, markdown);
}

/**
 * Reads the active Y.Doc as canonical Markdown without awaiting anything.
 *
 * For the one caller that has to read and write a document with no gap in between — see
 * `NoteBridge` — and the reason the async pair above exists as well.
 */
export function editorMarkdownWith(bridge: NoteBridge, document: Doc): string {
  return bridge.markdownFromUpdate(encodeStateAsUpdate(document));
}

/**
 * Replaces a view's content with parsed Markdown, without awaiting anything.
 *
 * Dispatched as one ProseMirror transaction rather than through Tiptap's `setContent`, for
 * two reasons: it is undoable, which is what §3.5 asks a conflict resolution to be, and a
 * `NodeView` holds an `EditorView` rather than an `Editor`, so this is what a callout's own
 * buttons can call.
 */
export function applySourceMarkdownWith(
  bridge: NoteBridge,
  view: EditorView,
  markdown: string,
): void {
  const document = new Doc();
  applyUpdate(document, bridge.updateFromMarkdown(markdown));
  const fragment = document.getXmlFragment(PROSEMIRROR_ROOT);
  const content = yXmlFragmentToProsemirrorJSON(fragment);
  const replacement = ProseMirrorNode.fromJSON(view.state.schema, content);
  view.dispatch(
    view.state.tr.replaceWith(0, view.state.doc.content.size, replacement.content),
  );
  document.destroy();
}

/** Copies text with a narrow clipboard boundary that is easy to substitute in tests. */
export interface MarkdownClipboard {
  writeText(text: string): Promise<void>;
}

export async function copyMarkdown(markdown: string, clipboard: MarkdownClipboard | undefined = navigator.clipboard): Promise<boolean> {
  if (clipboard === undefined) return false;
  await clipboard.writeText(markdown);
  return true;
}

/** The rendering policy for the long-note threshold in SPEC.md §21.2. */
export function longNoteMode(editor: Editor, threshold = 20_000): boolean {
  return editor.state.doc.textBetween(0, editor.state.doc.content.size, " ").trim().split(/\s+/).filter(Boolean).length >= threshold;
}

/** Applies browser rendering containment to large document blocks without changing document state. */
export function setLongNoteMode(element: HTMLElement, enabled: boolean): void {
  element.classList.toggle("is-long-note", enabled);
}
