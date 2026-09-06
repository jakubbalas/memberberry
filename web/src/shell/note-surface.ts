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
import { encodeStateAsUpdate, type Doc } from "yjs";

import type { ConnectionStatus, LocalPersistenceFactory } from "../editor/collaboration.js";
import { mountEditorShell } from "../editor/editor-shell.js";
import { startNoteEditor } from "../editor/note-editor.js";
import { localReplica } from "../offline/local.js";
import { notDownloaded } from "../offline/not-downloaded.js";
import type { Replica } from "../offline/replica.js";
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
  /** Injectable for tests; defaults to this page's replica (§7.2). */
  readonly replica?: () => Promise<Replica | undefined>;
  /**
   * Schedules `run` and returns its cancel. Injectable for tests; defaults to `setTimeout`.
   *
   * A cancel closure rather than a timer id, because the id form pushes `clearTimeout` into
   * the caller and a test's fake id then cancels nothing — which is a test that cannot see
   * the cancellation it exists to check.
   */
  readonly setTimer?: (run: () => void, ms: number) => () => void;
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

interface ResidencyOptions {
  readonly bootstrap: NoteBootstrap;
  readonly replica: Replica;
  readonly collaboration: { readonly document: Doc };
  readonly connection: ConnectionStatus | undefined;
}

/**
 * Keeps §7.2's bookkeeping for one open note up to date.
 *
 * Two facts, written at different times for the same reason: a tab is usually closed by
 * being closed, not by the pane unmounting.
 *
 * - **Unsent changes are recorded the moment there are any**, from the transport's own
 *   count. This is the flag eviction refuses to cross, and a flag only written on teardown
 *   would be missing from exactly the session that produced it — the one that ended with the
 *   browser being quit on a train.
 * - **The size is measured when the pane closes**, because it costs a serialization of the
 *   document and nothing needs it before then. A note that never gets measured reads as
 *   zero bytes, which the note half of §7.2's cap still catches.
 *
 * The sweep runs once, on open: it is the moment a new body has just been added.
 */
function trackResidency(options: ResidencyOptions): { settle(): Promise<void> } {
  const { bootstrap, replica } = options;
  let dirty: boolean | undefined;
  const unsubscribe = options.connection?.subscribe((state) => {
    const next = state.pending > 0;
    if (next === dirty) return;
    dirty = next;
    void replica.measured(bootstrap.vault, bootstrap.note, { dirty: next });
  });
  void replica.evict(bootstrap.vault);
  return {
    settle: async (): Promise<void> => {
      unsubscribe?.();
      await replica.measured(bootstrap.vault, bootstrap.note, {
        bytes: encodeStateAsUpdate(options.collaboration.document).byteLength,
      });
    },
  };
}

interface WaitingOptions {
  readonly resident: boolean;
  readonly bootstrap: NoteBootstrap;
  readonly replica: Replica;
  readonly panel: HTMLElement;
  readonly connection: ConnectionStatus | undefined;
  readonly setTimer: (run: () => void, ms: number) => () => void;
}

/**
 * How long a body has to arrive before the pane says it has not.
 *
 * why: the *first* open of any note online is a note this device does not hold yet, so
 * without a grace period every one of them would flash "this note has not been downloaded"
 * for the length of a round trip. The editor is covered from the moment the pane opens
 * regardless — that part is not cosmetic, it is what stops an empty document being typed
 * into — so what this delays is only the sentence.
 */
const BODY_NOTICE_DELAY_MS = 500;

function defaultTimer(run: () => void, ms: number): () => void {
  const id = globalThis.setTimeout(run, ms);
  return () => {
    globalThis.clearTimeout(id);
  };
}

/**
 * Covers a note whose body has not arrived, and uncovers it when it does (§7.2).
 *
 * **The signal is the sync frame, not `navigator.onLine`.** A browser that believes it is
 * online says nothing about whether this note's body ever came — a server that is refusing
 * connections, a session that expired, a tab woken from sleep before its socket reconnected
 * all read as online — and the emulated offline mode a browser test uses does not update
 * that property across a navigation at all. What "downloaded" means is that the server has
 * sent this note's state, which is exactly what `ConnectionState.synced` latches (§7.4).
 *
 * The editor is mounted underneath rather than skipped, so there is nothing to build twice
 * when the body lands. It is hidden by `data-body`, which is also what stops it being typed
 * into: a hidden `contenteditable` cannot take focus, and an empty document that *could* be
 * typed into would merge those words with the body that arrives on reconnect.
 */
function waitingForBody(options: WaitingOptions): { destroy(): void } {
  const { bootstrap, replica, panel } = options;
  if (options.resident || options.connection === undefined) {
    return { destroy: (): void => undefined };
  }
  const notice = notDownloaded(bootstrap.note, undefined);
  // Immediately, and before anything is rendered: this is what hides the editor.
  panel.dataset["body"] = "waiting";
  const cancel = options.setTimer(() => panel.append(notice), BODY_NOTICE_DELAY_MS);
  void replica
    .metadata(bootstrap.vault, bootstrap.note)
    .then((metadata) => {
      // The title arrives from the metadata tier, which is replicated even when the body is
      // not. Rendered when it resolves rather than awaited, so a slow store never delays the
      // editor behind it.
      const heading = notice.querySelector("h2");
      if (heading !== null && metadata?.title != null) heading.textContent = metadata.title;
    })
    .catch(() => undefined);

  const arrived = (): void => {
    cancel();
    notice.remove();
    delete panel.dataset["body"];
    void replica.opened(bootstrap.vault, bootstrap.note);
  };
  const unsubscribe = options.connection.subscribe((state) => {
    if (state.synced) arrived();
  });
  return {
    destroy: (): void => {
      cancel();
      unsubscribe();
      notice.remove();
      delete panel.dataset["body"];
    },
  };
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
  const replica = await (options.replica ?? localReplica)();
  // §7.2's tiered replication: the body of a note nobody has opened on this device is not
  // here. Resolved *before* the editor exists, because what it decides is whether there is
  // anything to type into — see `waitingForBody` below.
  const resident =
    bootstrap === undefined || replica === undefined
      ? true
      : await replica.isResident(bootstrap.vault, bootstrap.note);

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

  // A note this device already holds is open now, and the write moves it to the front of
  // §7.2's LRU. One it does not is *waiting*, and `waiting` is what removes the notice and
  // records it — when the server sends the body, and not before.
  const waiting =
    bootstrap === undefined || replica === undefined
      ? undefined
      : waitingForBody({
          resident,
          bootstrap,
          replica,
          panel,
          connection: collaboration.connection,
          setTimer: options.setTimer ?? defaultTimer,
        });
  if (resident && bootstrap !== undefined && replica !== undefined) {
    await replica.opened(bootstrap.vault, bootstrap.note);
  }

  // §7.2's cap. After the pane is up and not awaited: nothing on screen depends on it, and a
  // reader opening a note should not wait for a sweep over five hundred records.
  const accounting =
    bootstrap === undefined || replica === undefined
      ? undefined
      : trackResidency({ bootstrap, replica, collaboration, connection: collaboration.connection });

  let closing: Promise<void> | undefined;
  return {
    destroy: (): Promise<void> => {
      // A pane can be closed by the user and then again by the layout unmounting it, and
      // Tiptap throws if destroyed twice. Caching the promise makes the second call a no-op
      // that still resolves when teardown actually finished.
      closing ??= (async () => {
        await accounting?.settle();
        waiting?.destroy();
        shell.destroy();
        await editor.destroy();
      })();
      return closing;
    },
  };
}
