/**
 * Starting and stopping the editor for one note.
 *
 * This is the imperative half of the note pane: Tiptap, the Y.Doc, the sync transport and the
 * M3 control strip are all objects with lifecycles, and none of them is expressible as
 * markup. Keeping it here rather than inside a component is `AGENTS.md` §4.4 — a component
 * that owns a WebSocket is a component you cannot test without mounting one.
 *
 * The teardown contract is the reason this is worth its own module. A note pane is opened and
 * closed constantly once splits and tabs exist (§8.2), so a leaked editor or an unclosed
 * socket is not a slow leak but a fast one, and `destroy` has to be safe to call before
 * startup has finished.
 */

import { Editor, type Extensions } from "@tiptap/core";

import type { LocalPersistenceFactory } from "../editor/collaboration.js";
import { mountEditorShell } from "../editor/editor-shell.js";
import { startNoteEditor } from "../editor/note-editor.js";
import { type NoteBootstrap, remoteSyncFor } from "./bootstrap.js";

export interface NoteSurfaceElements {
  /** Where Tiptap mounts. */
  readonly surface: HTMLElement;
  /** The panel the control strip is inserted into. */
  readonly panel: HTMLElement;
  /** The element the connection state is reported in. */
  readonly status: HTMLElement;
}

export interface OpenNoteSurfaceOptions extends NoteSurfaceElements {
  /**
   * The server's answer about which note this is, or `undefined` for a local-only replica.
   *
   * Local-only is the `npm run dev` path and it must keep working; it is also what the
   * editor falls back to rather than syncing under an identity nobody authenticated.
   */
  readonly bootstrap?: NoteBootstrap | undefined;
  /** Injectable for tests, which have no `window`. */
  readonly location?: Location;
  /**
   * Injectables passed straight through to the editor.
   *
   * jsdom has no IndexedDB and a test should not stand up a real socket, so both come in
   * from outside — the same pattern `collaboration.ts` and `note-editor.ts` already use.
   * `createEditor` is deliberately *not* injectable here: the check below that the factory
   * returned a real Tiptap `Editor` is only worth making against the real factory.
   */
  readonly createPersistence?: LocalPersistenceFactory;
  readonly loadExtensions?: () => Promise<Extensions>;
  readonly createRemoteSync?: NonNullable<
    Parameters<typeof startNoteEditor>[0]["createRemoteSync"]
  >;
}

export interface NoteSurface {
  /**
   * Releases the editor, the local replica and the socket.
   *
   * Returns a promise because teardown genuinely is asynchronous — Tiptap is destroyed, then
   * the collaboration, then the transport — and a layout that replaces a pane showing the
   * same note has to wait for the old one to let go of the Y.Doc first. Callers that do not
   * care may ignore it; `void surface.destroy()` is the normal case.
   *
   * Idempotent: calling it again returns the same promise rather than tearing down twice.
   */
  destroy(): Promise<void>;
}

/** The note a local-only replica edits, when no server said otherwise. */
export const LOCAL_ONLY = { vault: "local-demo", note: "scratch-note" } as const;

/**
 * Opens a note into the given elements. Resolves once it is editable.
 *
 * Rejects rather than half-mounting: `startNoteEditor` already tears its own collaboration
 * down on failure, so a rejection here leaves nothing behind to clean up.
 */
export async function openNoteSurface(options: OpenNoteSurfaceOptions): Promise<NoteSurface> {
  const { bootstrap, surface, panel, status } = options;
  const location = options.location ?? window.location;
  const remoteSync = bootstrap === undefined ? undefined : remoteSyncFor(bootstrap, location);

  const editor = await startNoteEditor({
    element: surface,
    vaultId: bootstrap?.vault ?? LOCAL_ONLY.vault,
    noteId: bootstrap?.note ?? LOCAL_ONLY.note,
    // why: only with a server behind it. A transclusion is resolved at render time against
    // the caller's readable set (§9.2, E7), which is a route — so a local-only replica has
    // nothing to ask and renders an embed as the plain link it was before.
    ...(bootstrap === undefined
      ? {}
      : { embeds: { vault: bootstrap.vault, note: bootstrap.note } }),
    ...(remoteSync === undefined ? {} : { remoteSync }),
    ...(options.createPersistence === undefined
      ? {}
      : { createPersistence: options.createPersistence }),
    ...(options.loadExtensions === undefined ? {} : { loadExtensions: options.loadExtensions }),
    ...(options.createRemoteSync === undefined
      ? {}
      : { createRemoteSync: options.createRemoteSync }),
  });

  if (!(editor.editor instanceof Editor)) {
    // `createEditor` is not injectable here on purpose, so this is a real assertion about
    // the default factory rather than about a stub: the control strip reaches into Tiptap's
    // API, not a structural subset of it.
    await editor.destroy();
    throw new Error("the default editor factory must return a Tiptap Editor");
  }

  const { collaboration } = editor;
  const shell = mountEditorShell({
    editor: editor.editor,
    document: collaboration.document,
    ...(collaboration.awareness === undefined ? {} : { awareness: collaboration.awareness }),
    ...(collaboration.connection === undefined ? {} : { connection: collaboration.connection }),
    panel,
    status,
  });

  let closing: Promise<void> | undefined;
  return {
    destroy: (): Promise<void> => {
      // A pane can be closed by the user and then again by the layout unmounting it, and
      // Tiptap throws if destroyed twice. Caching the promise makes the second call a no-op
      // that still resolves when teardown actually finished.
      closing ??= (async () => {
        shell.destroy();
        await editor.destroy();
      })();
      return closing;
    },
  };
}
