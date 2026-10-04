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
import { TextSelection } from "@tiptap/pm/state";

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
import { noteAnchorNavigator, type NoteAnchor } from "../editor/note-anchor.js";
import { placeCursorBelowTitle, startNoteEditor } from "../editor/note-editor.js";
import { localReplica } from "../offline/local.js";
import { notDownloaded } from "../offline/not-downloaded.js";
import type { Replica, ReplicaSession } from "../offline/replica.js";
import { type NoteBootstrap, remoteSyncFor } from "./bootstrap.js";
import { createMediaUploader } from "../editor/media-upload.js";
import { loadEmojiChoices } from "../editor/emoji-picker.js";

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
  readonly onTitleChange?: (title: string) => string | undefined;
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
  /** Accepts one inbox edit, deferring until an authorized source body arrives if needed. */
  editTask?(ordinal: number, action: TaskEditAction): boolean;
  /** Scrolls now or when the authorized body arrives. Replaces any older pending jump. */
  scrollToAnchor?(anchor: NoteAnchor): void;
}

/** One user intent. Callers create a fresh object for each deliberate edit, even a repeat. */
export type TaskEditAction =
  | { readonly kind: "toggle" }
  | { readonly kind: "complete" }
  | { readonly kind: "due"; readonly value: string }
  | { readonly kind: "priority"; readonly value: TaskPriority | null };

// why: a temporary main view can remount a pane and multiple splits can show the same note.
// Both success and rejection belong to the shared intent: a stale ordinal or denied edit must
// never revive on remount. Pending work stays transferable across ordinary pane teardown.
const taskEditOutcomes = new WeakMap<TaskEditAction, boolean>();

interface ResidencyOptions {
  readonly resident: boolean;
  readonly bootstrap: NoteBootstrap;
  readonly replica: Replica;
  readonly session: ReplicaSession;
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
function trackResidency(options: ResidencyOptions): { arrived(): void; settle(): Promise<void> } {
  const { bootstrap, replica, session } = options;
  let opening: Promise<readonly string[]> | undefined;
  let opened = false;
  let dirty: boolean | undefined;
  const record = (state: ConnectionStatus["state"] | undefined): void => {
    if (session.revoked) return;
    // why: a fresh transport starts at zero even when IndexedDB holds unsent edits.
    // Preserve the durable dirty flag until the server's state has reconciled them.
    const next = state === undefined || (!state.synced && state.pending === 0)
      ? undefined
      : state.pending > 0;
    if (!opened) {
      // Normalization can produce pending updates before the first body arrives. Do not
      // claim it is downloaded then, or cache a dirty patch that has no resident to update.
      if (!options.resident && state?.synced !== true) return;
      opened = true;
      dirty = next;
      // First residency and its dirty flag are one atomic write, before any cap sweep.
      opening = session.opened(next)
        .then(() => replica.evict(bootstrap.vault));
      return;
    }
    if (next === undefined || next === dirty) return;
    dirty = next;
    void session.measured({ dirty: next });
  };
  const unsubscribe = options.connection?.subscribe(record);
  if (options.connection === undefined) record(undefined);
  return {
    arrived: (): void => record({
      connected: options.connection?.state.connected ?? false,
      pending: options.connection?.state.pending ?? 0,
      synced: true,
    }),
    settle: async (): Promise<void> => {
      unsubscribe?.();
      await opening;
      await session.measured({
        bytes: encodeStateAsUpdate(options.collaboration.document).byteLength,
      });
    },
  };
}

interface WaitingOptions {
  readonly resident: boolean;
  readonly bootstrap: NoteBootstrap;
  readonly replica: Replica;
  readonly session: ReplicaSession;
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
  if (!options.session.revoked && (options.resident || options.connection === undefined)) {
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
  };
  const unsubscribe = options.connection?.subscribe((state) => {
    if (state.synced && !options.session.revoked) arrived();
  });
  return {
    destroy: (): void => {
      cancel();
      unsubscribe?.();
      notice.remove();
      delete panel.dataset["body"];
    },
  };
}

interface ReconcileConflictsOptions {
  readonly bootstrap: NoteBootstrap;
  readonly replica: Replica;
  readonly session: ReplicaSession;
  readonly view: EditorView;
  readonly document: Doc;
  readonly bridge: NoteBridge;
  readonly serverState: ServerStateSignal;
  readonly onBody: () => void;
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
    // why: a buffered sync predates the catalog's revocation even when delivered now.
    if (options.session.revoked) return;
    options.onBody();
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
    // why: residency accounting queues the atomic open before this patch. A separate
    // read/replace here could overwrite dirty state, or recreate a record after denial.
    void options.session.measured({ base: result.base })
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
  // Tiptap attaches and paints its document before the controls can be mounted below. Keep the
  // surface covered across that async gap so switching notes never shows a partially built pane.
  options.panel.dataset["editor"] = "loading";
  const replica = await (options.replica ?? localReplica)();
  const session = options.bootstrap === undefined ? undefined
    : replica?.session(options.bootstrap.vault, options.bootstrap.note);
  try {
    return await mountNoteSurface(options, replica, session);
  } catch (error) {
    session?.close();
    throw error;
  }
}

async function mountNoteSurface(
  options: OpenNoteSurfaceOptions,
  replica: Replica | undefined,
  session: ReplicaSession | undefined,
): Promise<NoteSurface> {
  const { bootstrap, surface, panel, status } = options;
  const location = options.location ?? window.location;
  const remoteSync = bootstrap === undefined ? undefined : remoteSyncFor(bootstrap, location);
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
      : { embeds: { vault: bootstrap.vault, note: bootstrap.note, editable: true } }),
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
  let removeBodyPlacementListener: (() => void) | undefined;
  if (!placeCursorBelowTitle(tiptap)) {
    const placeBody = (): void => {
      if (!placeCursorBelowTitle(tiptap)) return;
      tiptap.off("update", placeBody);
      removeBodyPlacementListener = undefined;
    };
    tiptap.on("update", placeBody);
    removeBodyPlacementListener = () => tiptap.off("update", placeBody);
  }

  const { collaboration } = editor;
  const shell = mountEditorShell({
    editor: editor.editor,
    document: collaboration.document,
    ...(collaboration.awareness === undefined ? {} : { awareness: collaboration.awareness }),
    ...(collaboration.connection === undefined ? {} : { connection: collaboration.connection }),
    panel,
    status,
    ...(bootstrap === undefined ? {} : { user: bootstrap.user, title: bootstrap.note }),
    ...(options.onTitleChange === undefined ? {} : { onTitleChange: options.onTitleChange }),
    ...(bootstrap === undefined ? {} : {
      mediaUploader: createMediaUploader(
        bootstrap.vault,
        undefined,
        bootstrap.mediaMaxDimension === undefined ? {} : { maxDimension: bootstrap.mediaMaxDimension },
      ),
      media: { vault: bootstrap.vault },
    }),
    emojiChoices: (signal) => loadEmojiChoices(bootstrap?.vault, signal),
    ...(bootstrap === undefined ? {} : { emojiImport: { vault: bootstrap.vault, status } }),
  });
  delete panel.dataset["editor"];

  // A missing body stays covered until the server sends it; residency accounting below
  // owns the durable record so uncovering the UI cannot race the dirty flag.
  const waiting =
    bootstrap === undefined || replica === undefined || session === undefined
      ? undefined
      : waitingForBody({
          resident,
          bootstrap,
          replica,
          session,
          panel,
          connection: collaboration.connection,
          setTimer: options.setTimer ?? defaultTimer,
        });

  // §7.2's cap. After the pane is up and not awaited: nothing on screen depends on it, and a
  // reader opening a note should not wait for a sweep over five hundred records.
  const accounting =
    bootstrap === undefined || replica === undefined || session === undefined
      ? undefined
      : trackResidency({ resident, bootstrap, replica, session, collaboration, connection: collaboration.connection });

  // §3.5. After the shell, so the count it announces has somewhere to be rendered, and only
  // with a server behind it: a local-only replica has nothing to diverge from.
  const conflicts =
    bootstrap === undefined || replica === undefined || bridge === undefined || session === undefined
      ? undefined
      : reconcileConflicts({
          bootstrap,
          replica,
          session,
          view: editor.editor.view,
          document: collaboration.document,
          bridge,
          serverState: collaboration.serverState,
          onBody: () => accounting?.arrived(),
        });

  const anchors = noteAnchorNavigator(tiptap, () => panel.dataset["body"] !== "waiting");
  const unwatchAnchorBody = collaboration.connection?.subscribe(() => anchors.refresh());
  let taskEditsClosed = false;
  let taskEditScheduled = false;
  const pendingTaskEdits: { readonly ordinal: number; readonly action: TaskEditAction }[] = [];
  const canEditTask = (): boolean => !taskEditsClosed && !tiptap.isDestroyed && tiptap.isEditable && session?.revoked !== true;
  const finishTaskEdit = (action: TaskEditAction, outcome: boolean): boolean => {
    taskEditOutcomes.set(action, outcome);
    return outcome;
  };
  const rejectPendingTaskEdits = (): void => {
    for (const { action } of pendingTaskEdits.splice(0)) {
      // Another split may already have settled the same intent. Its terminal result wins.
      if (!taskEditOutcomes.has(action)) finishTaskEdit(action, false);
    }
  };
  const applyTaskEdit = (ordinal: number, action: TaskEditAction): boolean => {
    if (taskEditsClosed || tiptap.isDestroyed) return false;
    const outcome = taskEditOutcomes.get(action);
    if (outcome !== undefined) return outcome;
    if (!canEditTask()) return finishTaskEdit(action, false);
    let taskPosition: number | undefined;
    let taskNumber = 0;
    tiptap.state.doc.descendants((node, position) => {
      // why: returning false skips children, not later siblings. Do not overwrite a match.
      if (taskPosition !== undefined) return false;
      if (node.type.name === "task_item" && taskNumber++ === ordinal) {
        taskPosition = position;
        return false;
      }
      return true;
    });
    if (taskPosition === undefined) return finishTaskEdit(action, false);
    // why: inbox rows can be cached unchecked after the source was completed. A new click
    // still means complete, not reopen; do not even move selection/focus for this no-op.
    if (action.kind === "complete" && tiptap.state.doc.nodeAt(taskPosition)?.attrs["status"] === "done") {
      return finishTaskEdit(action, true);
    }
    tiptap.view.dispatch(tiptap.state.tr.setSelection(TextSelection.near(tiptap.state.doc.resolve(taskPosition + 1))));
    // Selection listeners can close the pane or revoke editing synchronously. Teardown is
    // transferable, but denial is terminal; neither permits the following mutation.
    if (taskEditsClosed || tiptap.isDestroyed) return false;
    if (!canEditTask()) return finishTaskEdit(action, false);
    const applied = action.kind === "toggle" || action.kind === "complete" ? toggleTask(tiptap)
      : action.kind === "due" ? setTaskDue(tiptap, action.value)
        : setTaskPriority(tiptap, action.value);
    return finishTaskEdit(action, applied);
  };
  const refreshTaskEdits = (): void => {
    if (taskEditsClosed || tiptap.isDestroyed) return;
    if (!canEditTask()) {
      rejectPendingTaskEdits();
      return;
    }
    if (pendingTaskEdits.length === 0 || taskEditScheduled || panel.dataset["body"] === "waiting") return;
    taskEditScheduled = true;
    // why: first sync applies the CRDT, normalizes the editor and uncovers the body in one
    // stack. Wait until all three finish rather than editing an empty/partially applied doc.
    queueMicrotask(() => {
      taskEditScheduled = false;
      if (taskEditsClosed || tiptap.isDestroyed) return;
      if (!canEditTask()) { rejectPendingTaskEdits(); return; }
      if (panel.dataset["body"] === "waiting") return;
      // Consume before dispatch (which emits another update). Missing ordinals are stale,
      // not permission to toggle a task added by some later keystroke or remote edit.
      for (const { ordinal, action } of pendingTaskEdits.splice(0)) applyTaskEdit(ordinal, action);
    });
  };
  tiptap.on("update", refreshTaskEdits);
  const unwatchTaskBody = collaboration.connection?.subscribe(refreshTaskEdits);
  let closing: Promise<void> | undefined;
  return {
    scrollToAnchor: (anchor) => anchors.follow(anchor),
    editTask: (ordinal, action): boolean => {
      if (taskEditsClosed || tiptap.isDestroyed) return false;
      const outcome = taskEditOutcomes.get(action);
      if (outcome !== undefined) return outcome;
      if (!canEditTask()) {
        rejectPendingTaskEdits();
        return finishTaskEdit(action, false);
      }
      if (!Number.isInteger(ordinal) || ordinal < 0) return finishTaskEdit(action, false);
      if (pendingTaskEdits.some((pending) => pending.action === action)) return true;
      if (panel.dataset["body"] !== "waiting") return applyTaskEdit(ordinal, action);
      // An unopened source resolves its surface before first sync. Acceptance is not a
      // terminal outcome: normal teardown may transfer this intent to a replacement pane.
      pendingTaskEdits.push({ ordinal, action });
      return true;
    },
    destroy: (): Promise<void> => {
      // A pane can be closed by the user and then again by the layout unmounting it, and
      // Tiptap throws if destroyed twice. Caching the promise makes the second call a no-op
      // that still resolves when teardown actually finished.
      closing ??= (async () => {
        // A denial may close the pane before another sync/update can observe it. Ordinary
        // unmounts leave unfinished intents reusable, but a known denial must not escape.
        if (!tiptap.isEditable || session?.revoked === true) rejectPendingTaskEdits();
        taskEditsClosed = true;
        pendingTaskEdits.length = 0;
        tiptap.off("update", refreshTaskEdits);
        unwatchTaskBody?.();
        anchors.destroy();
        unwatchAnchorBody?.();
        conflicts?.destroy();
        waiting?.destroy();
        await accounting?.settle();
        removeBodyPlacementListener?.();
        shell.destroy();
        await editor.destroy();
      })().finally(() => session?.close());
      return closing;
    },
  };
}
