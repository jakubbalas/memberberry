/** The M3 local editor shell. Server-selected note identities arrive with M4 sync. */

import { Editor } from "@tiptap/core";

import { mountEditorShell } from "./editor/editor-shell.js";
import { startNoteEditor } from "./editor/note-editor.js";

async function main(): Promise<void> {
  const element = document.querySelector<HTMLElement>("#editor");
  if (!element) {
    throw new Error("the page is missing the editor element");
  }

  const editor = await startNoteEditor({
    element,
    // why: M4 supplies server-authorized UUIDs. Until then, this is an explicitly local demo
    // document and cannot be mistaken for a synced vault note.
    vaultId: "local-demo",
    noteId: "scratch-note",
  });
  if (!(editor.editor instanceof Editor)) {
    throw new Error("the default editor factory must return a Tiptap Editor");
  }
  const panel = document.querySelector<HTMLElement>(".editor-panel");
  const status = document.querySelector<HTMLElement>(".offline-status");
  if (panel === null || status === null) {
    throw new Error("the page is missing the editor shell");
  }
  const shell = mountEditorShell({ editor: editor.editor, document: editor.collaboration.document, panel, status });
  window.addEventListener("pagehide", () => {
    shell.destroy();
    void editor.destroy();
  }, { once: true });
}

void main();
