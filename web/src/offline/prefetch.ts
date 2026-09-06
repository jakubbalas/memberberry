/**
 * Fetching the notes this device is keeping offline (`SPEC.md` §7.2's pinned tier).
 *
 * "Forced eager" is what makes a pin worth having: a note you pinned has to be there on the
 * train whether or not you happened to open it first. So on every start, each pinned note
 * whose body is not resident is opened *without an editor* — a Y document and the sync
 * transport, nothing else — until the server has sent its state, and then closed again.
 *
 * Sequential on purpose. A pinned set is user-chosen and can be large, and one socket per
 * note in parallel is a burst of connections against the §7.1 frame limit for a benefit
 * nobody is waiting on. This runs after the page has loaded and nothing depends on it
 * finishing.
 */

import { createNoteCollaboration } from "../editor/collaboration.js";
import type { Replica } from "./replica.js";

/** One note being fetched in the background. */
export interface PrefetchHandle {
  /** Resolves `true` once the server has sent the note's state. */
  readonly synced: Promise<boolean>;
  destroy(): Promise<void>;
}

export interface PrefetchOptions {
  readonly vault: string;
  readonly replica: Replica;
  /** Opens one note's document and transport. */
  readonly openNote: (note: string) => PrefetchHandle;
  /**
   * How many notes in a row may fail before the sweep gives up.
   *
   * why: a sweep with no give-up condition is a sweep that opens a socket per pinned note
   * while offline, each waiting out its own timeout. Two in a row is enough to distinguish
   * "this note is gone" from "there is no server".
   */
  readonly giveUpAfter?: number;
}

export interface PrefetchResult {
  /** Notes whose bodies arrived during this sweep. */
  readonly fetched: readonly string[];
  /** Pinned notes still not resident when the sweep ended. */
  readonly missing: readonly string[];
}

export async function prefetchPinned(options: PrefetchOptions): Promise<PrefetchResult> {
  const giveUpAfter = options.giveUpAfter ?? 2;
  const fetched: string[] = [];
  const missing: string[] = [];
  let failures = 0;

  for (const note of await options.replica.pinned(options.vault)) {
    if (await options.replica.isResident(options.vault, note)) continue;
    if (failures >= giveUpAfter) {
      missing.push(note);
      continue;
    }
    const handle = options.openNote(note);
    let arrived = false;
    try {
      arrived = await handle.synced;
    } catch {
      arrived = false;
    } finally {
      await handle.destroy();
    }
    if (arrived) {
      await options.replica.opened(options.vault, note);
      fetched.push(note);
      failures = 0;
    } else {
      missing.push(note);
      failures += 1;
    }
  }
  return { fetched, missing };
}


/** How long one pinned note has to arrive before the sweep counts it as a failure. */
const FETCH_TIMEOUT_MS = 15_000;

export interface NoteFetcherOptions {
  readonly vault: string;
  readonly user: string;
  readonly endpoint: string;
  readonly timeoutMs?: number;
  /** Injectable for tests, which have neither IndexedDB nor a socket. */
  readonly createCollaboration?: typeof createNoteCollaboration;
  /** Injectable for tests; defaults to `setTimeout`, and returns its cancel. */
  readonly setTimer?: (run: () => void, ms: number) => () => void;
}

/**
 * Opens one note with no editor attached, for the sweep above.
 *
 * A document and a transport, which is all "downloading a note" is: `y-indexeddb` persists
 * whatever arrives, so closing it again leaves the body on the device. There is no editor,
 * no awareness and no presence — a background fetch must not put this user's cursor into a
 * room they are not looking at (§7.5).
 */
export function noteFetcher(options: NoteFetcherOptions): (note: string) => PrefetchHandle {
  const create = options.createCollaboration ?? createNoteCollaboration;
  const setTimer = options.setTimer ?? defaultTimer;
  return (note: string): PrefetchHandle => {
    const collaboration = create({
      vaultId: options.vault,
      noteId: note,
      remoteSync: {
        endpoint: options.endpoint,
        vault: options.vault,
        note,
        user: options.user,
      },
    });
    const synced = new Promise<boolean>((resolve) => {
      let settled = false;
      let unsubscribe: (() => void) | undefined;
      const finish = (arrived: boolean): void => {
        if (settled) return;
        settled = true;
        cancel();
        unsubscribe?.();
        resolve(arrived);
      };
      const cancel = setTimer(() => finish(false), options.timeoutMs ?? FETCH_TIMEOUT_MS);
      unsubscribe = collaboration.connection?.subscribe((state) => {
        if (state.synced) finish(true);
      });
      // A document with no transport can never sync, so waiting out the timeout would be
      // fifteen seconds of nothing.
      if (collaboration.connection === undefined) finish(false);
    });
    return { synced, destroy: () => collaboration.destroy() };
  };
}

function defaultTimer(run: () => void, ms: number): () => void {
  const id = globalThis.setTimeout(run, ms);
  return () => {
    globalThis.clearTimeout(id);
  };
}
