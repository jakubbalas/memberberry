/** Source-view bridge. Markdown conversion is delegated to Rust/WASM. */

import type { Editor } from "@tiptap/core";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import { applyUpdate, Doc, encodeStateAsUpdate, type XmlFragment } from "yjs";

import { markdownFromUpdate, updateFromMarkdown } from "../notes.js";

/** Reads the active Y.Doc as canonical Markdown through the WASM boundary. */
export async function editorMarkdown(document: Doc): Promise<string> {
  return markdownFromUpdate(encodeStateAsUpdate(document));
}

/** Parses source Markdown through WASM and replaces the editor content with the result. */
export async function applySourceMarkdown(editor: Editor, markdown: string): Promise<void> {
  const update = await updateFromMarkdown(markdown);
  const document = new Doc();
  applyUpdate(document, update);
  const fragment = document.getXmlFragment("prosemirror");
  const content = yXmlFragmentToProsemirrorJSON(fragment);
  editor.commands.setContent(content, { emitUpdate: true });
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
