/** The M3 local editor shell. Server-selected note identities arrive with M4 sync. */

import { Editor } from "@tiptap/core";

import { mountEditorShell } from "./editor/editor-shell.js";
import { startNoteEditor } from "./editor/note-editor.js";

async function main(): Promise<void> {
  const element = document.querySelector<HTMLElement>("#editor");
  if (!element) {
    throw new Error("the page is missing the editor element");
  }
  const remoteSync = remoteSyncFrom(element);

  const editor = await startNoteEditor({
    element,
    vaultId: remoteSync?.vault ?? "local-demo",
    noteId: remoteSync?.note ?? "scratch-note",
    ...(remoteSync === undefined ? {} : { remoteSync }),
  });
  if (!(editor.editor instanceof Editor)) {
    throw new Error("the default editor factory must return a Tiptap Editor");
  }
  const panel = document.querySelector<HTMLElement>(".editor-panel");
  const status = document.querySelector<HTMLElement>(".offline-status");
  if (panel === null || status === null) {
    throw new Error("the page is missing the editor shell");
  }
  const { collaboration } = editor;
  const shell = mountEditorShell({
    editor: editor.editor,
    document: collaboration.document,
    awareness: collaboration.awareness,
    ...(collaboration.connection === undefined ? {} : { connection: collaboration.connection }),
    panel,
    status,
  });
  window.addEventListener("pagehide", () => {
    shell.destroy();
    void editor.destroy();
  }, { once: true });
}

function remoteSyncFrom(element: HTMLElement): { endpoint: string; vault: string; note: string; user: string } | undefined {
  const { vault, note, user } = element.dataset;
  if (vault === undefined || note === undefined || user === undefined) return undefined;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return { endpoint: `${protocol}//${window.location.host}/api/v1/sync`, vault, note, user };
}

void main();
