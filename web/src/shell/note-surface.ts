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

import type { EditorView } from "@tiptap/pm/view";

import { noteBridge, type NoteBridge } from "../notes.js";
import type {
  ConnectionStatus,
  LocalPersistenceFactory,
  ServerStateSignal,
} from "../editor/collaboration.js";
import { reconcile } from "../editor/conflicts.js";
import { mountEditorShell } from "../editor/editor-shell.js";
import { setTaskDue, setTaskPriority, toggleTask } from "../editor/commands.js";
import type { TaskPriority } from "../editor/task-metadata.js";
import { startNoteEditor } from "../editor/note-editor.js";
import { localReplica } from "../offline/local.js";
import { notDownloaded } from "../offline/not-downloaded.js";
import type { Replica } from "../offline/replica.js";
import { type NoteBootstrap, remoteSyncFor } from "./bootstrap.js";
import { createMediaUploader } from "../editor/media-upload.js";

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
  /** Applies one inbox edit to the task at its source-note ordinal. */
  editTask?(ordinal: number, action: TaskEditAction): boolean;
}

export type TaskEditAction =
  | { readonly kind: "toggle" }
  | { readonly kind: "due"; readonly value: string }
  | { readonly kind: "priority"; readonly value: TaskPriority | null };

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

interface ReconcileConflictsOptions {
  readonly bootstrap: NoteBootstrap;
  readonly replica: Replica;
  readonly view: EditorView;
  readonly document: Doc;
  readonly bridge: NoteBridge;
  readonly serverState: ServerStateSignal;
}

/**
 * Reconciles §3.5's divergences for one open note, and keeps its merge base current.
 *
 * This is where the three pieces meet: the transport says the server's state arrived and what
 * this device held that it had not seen, `mb-core` decides whether that is a conflict, and the
 * replica holds the version the two sides last agreed on.
 *
 * **The base is written on every arrival, not only a divergent one.** A note that reconnected
 * cleanly is a note both sides now agree about, and that agreement is exactly what makes the
 * *next* divergence detectable. Skipping it would leave the first offline edit after a clean
 * reconnection with nothing to compare against.
 *
 * The write is not awaited: nothing on screen depends on it, and the reconciliation itself has
 * already happened synchronously by then — see `conflicts.ts` for why that matters.
 */
function reconcileConflicts(options: ReconcileConflictsOptions): { destroy(): void } {
  const { bootstrap, replica } = options;
  let base: string | undefined;
  let loaded = false;
  // Read once, before the first arrival can need it. A base that has not loaded yet reads as
  // absent, which degrades that one merge rather than failing it (§3.5).
  const whenLoaded = replica
    .base(bootstrap.vault, bootstrap.note)
    .then((stored) => {
      if (!loaded) base = stored;
      loaded = true;
    })
    .catch(() => {
      loaded = true;
    });
  const unsubscribe = options.serverState.subscribe((state) => {
    const result = reconcile({
      view: options.view,
      document: options.document,
      bridge: options.bridge,
      state,
      base,
    });
    // Held in memory as well as stored: two arrivals in one session must not both compare
    // against the version from before the first one.
    base = result.base;
    loaded = true;
    // `opened` first, and that ordering is load-bearing: `measured` writes nothing for a note
    // with no resident record, and the *first* sync of a note is exactly when there is none
    // yet. Without this the first base of every note was dropped, so the first offline edit
    // after opening it fell back to the two-way comparison — silently.
    //
    // Recording it here is also what that arrival means: the server has sent this note's
    // whole state, so this device holds the body. It is the same conclusion `waitingForBody`
    // draws from the same frame.
    void replica
      .opened(bootstrap.vault, bootstrap.note)
      .then(() => replica.measured(bootstrap.vault, bootstrap.note, { base: result.base }))
      .catch(() => undefined);
  });
  return {
    destroy: (): void => {
      unsubscribe();
      // Swallowed rather than left dangling: the read is only a cache warm-up and a pane can
      // close before it resolves.
      void whenLoaded;
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

  // §3.5's actions and its merge are the same WASM module the source view already uses, so
  // this resolves from cache in every case but the very first note of a session. Awaited
  // rather than loaded lazily: reconciliation has to be synchronous once it starts, and the
  // callout's buttons have to work the first time they are clicked.
  const bridge = replica === undefined || bootstrap === undefined ? undefined : await noteBridge();

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
    ...(bootstrap === undefined ? {} : { media: { vault: bootstrap.vault } }),
    ...(remoteSync === undefined ? {} : { remoteSync }),
    ...(options.createPersistence === undefined
      ? {}
      : { createPersistence: options.createPersistence }),
    ...(options.loadExtensions === undefined ? {} : { loadExtensions: options.loadExtensions }),
    ...(options.createRemoteSync === undefined
      ? {}
      : { createRemoteSync: options.createRemoteSync }),
    ...(bridge === undefined ? {} : { bridge }),
  });

  if (!(editor.editor instanceof Editor)) {
    // `createEditor` is not injectable here on purpose, so this is a real assertion about
    // the default factory rather than about a stub: the control strip reaches into Tiptap's
    // API, not a structural subset of it.
    await editor.destroy();
    throw new Error("the default editor factory must return a Tiptap Editor");
  }
  const tiptap = editor.editor;

  const { collaboration } = editor;
  const shell = mountEditorShell({
    editor: editor.editor,
    document: collaboration.document,
    ...(collaboration.awareness === undefined ? {} : { awareness: collaboration.awareness }),
    ...(collaboration.connection === undefined ? {} : { connection: collaboration.connection }),
    panel,
    status,
    ...(bootstrap === undefined ? {} : { user: bootstrap.user, title: bootstrap.note }),
    ...(bootstrap === undefined ? {} : {
      mediaUploader: createMediaUploader(
        bootstrap.vault,
        undefined,
        bootstrap.mediaMaxDimension === undefined ? {} : { maxDimension: bootstrap.mediaMaxDimension },
      ),
    }),
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

  // §3.5. After the shell, so the count it announces has somewhere to be rendered, and only
  // with a server behind it: a local-only replica has nothing to diverge from.
  const conflicts =
    bootstrap === undefined || replica === undefined || bridge === undefined
      ? undefined
      : reconcileConflicts({
          bootstrap,
          replica,
          view: editor.editor.view,
          document: collaboration.document,
          bridge,
          serverState: collaboration.serverState,
        });

  let closing: Promise<void> | undefined;
  return {
    editTask: (ordinal, action): boolean => {
      let taskPosition: number | undefined;
      let taskNumber = 0;
      tiptap.state.doc.descendants((node, position) => {
        if (node.type.name !== "task_item") return true;
        if (taskNumber === ordinal) {
          taskPosition = position;
          return false;
        }
        taskNumber += 1;
        return true;
      });
      if (taskPosition === undefined) return false;
      tiptap.commands.setTextSelection(taskPosition + 1);
      if (action.kind === "toggle") return toggleTask(tiptap);
      if (action.kind === "due") return setTaskDue(tiptap, action.value);
      return setTaskPriority(tiptap, action.value);
    },
    destroy: (): Promise<void> => {
      // A pane can be closed by the user and then again by the layout unmounting it, and
      // Tiptap throws if destroyed twice. Caching the promise makes the second call a no-op
      // that still resolves when teardown actually finished.
      closing ??= (async () => {
        await accounting?.settle();
        conflicts?.destroy();
        waiting?.destroy();
        shell.destroy();
        await editor.destroy();
      })();
      return closing;
    },
  };
}
