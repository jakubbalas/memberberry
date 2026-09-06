/**
 * The local replica, and what reconnecting does to it (`SPEC.md` §7.2, §7.4, §6.7).
 *
 * §7.2 replicates note *metadata* eagerly so the tree, the switcher and the breadcrumbs
 * work with no network, and note *bodies* on demand. §7.4 attaches one rule to that: on
 * reconnect the client reconciles permissions **first**, dropping anything it is no longer
 * permitted before doing anything else.
 *
 * That rule is the whole reason this module distinguishes three answers rather than two.
 * "The server said no" and "the server said nothing" look identical to a `fetch` that
 * returns an empty list, and treating them the same way is a choice between two bugs: fall
 * back to the stored copy on a denial and a revoked user keeps reading titles they lost;
 * discard it on a network blip and going through a tunnel wipes the offline replica of a
 * 10 000-note vault. So the caller says which happened, and this decides.
 */

import { persistenceName } from "../editor/collaboration.js";
import type { Factory, OfflineStore, PinnedNote, ReplicatedNote, ResidentBody } from "./db.js";
import { DEFAULT_CAPS, evictable, type ResidentCaps } from "./eviction.js";

/** What the server's note index said — or failed to say. */
export type CatalogAnswer =
  /** The permission-filtered list, straight from the server (§6.4 E5). */
  | { readonly kind: "ok"; readonly notes: readonly ReplicatedNote[] }
  /** A refusal. Under the invisibility rule this is also what an unknown vault looks like. */
  | { readonly kind: "denied" }
  /** No answer at all: offline, or a server that failed. */
  | { readonly kind: "unreachable" };

/** What is known about a resident body now. Absent fields are left as they were. */
export interface ResidentPatch {
  readonly bytes?: number;
  readonly dirty?: boolean;
}

/** Deletes a Y document's own IndexedDB database. */
export type DropBody = (vault: string, note: string) => Promise<void>;

export interface ReplicaOptions {
  readonly store: OfflineStore;
  readonly dropBody: DropBody;
  /** Injectable for tests; defaults to the wall clock. */
  readonly now?: () => number;
  /** §7.2's resident-body caps. Injectable for tests; the defaults are the spec's. */
  readonly caps?: ResidentCaps;
}

export interface Replica {
  /**
   * Applies the server's answer and returns the list the client should use.
   *
   * The returned list is the *only* one a caller should render. On a denial it is empty —
   * never the stored copy — because the stored copy is precisely what a revocation
   * invalidates.
   */
  reconcile(vault: string, answer: CatalogAnswer): Promise<readonly ReplicatedNote[]>;
  /** Whether this device holds this note's body (§7.2's "body not downloaded" state). */
  isResident(vault: string, note: string): Promise<boolean>;
  /** What the replica knows *about* a note, which is what that state has to show. */
  metadata(vault: string, note: string): Promise<ReplicatedNote | undefined>;
  /** Records that a note's body is here, and that it was just opened. */
  opened(vault: string, note: string): Promise<void>;
  /**
   * Records what a note now weighs, or whether it has changes the server has not seen.
   *
   * Both are what §7.2's cap is decided from, and the second is what stops the cap deleting
   * the only copy of somebody's writing — so it is written the moment a change goes unsent,
   * rather than when the pane closes. A pane that is never closed is the normal way a tab
   * ends.
   */
  measured(vault: string, note: string, patch: ResidentPatch): Promise<void>;
  /**
   * Brings a vault back under §7.2's caps, dropping the least recently opened bodies.
   *
   * Returns what it dropped. Never a pinned note and never one with unsent changes.
   */
  evict(vault: string): Promise<readonly string[]>;
  /** The notes this device is keeping offline (§7.2's pinned tier). */
  pinned(vault: string): Promise<readonly string[]>;
  /** Marks a note to keep, or stops keeping it. Idempotent either way. */
  setPinned(vault: string, note: string, pinned: boolean): Promise<void>;
}

export function createReplica(options: ReplicaOptions): Replica {
  const now = options.now ?? Date.now;
  const caps = options.caps ?? DEFAULT_CAPS;
  return {
    async reconcile(vault, answer): Promise<readonly ReplicatedNote[]> {
      if (answer.kind === "unreachable") {
        return (await options.store.getNotes(vault)) ?? [];
      }
      if (answer.kind === "denied") {
        // Everything, not just the metadata: a vault this user can no longer open is one
        // whose note bodies they may no longer read either (§6.7).
        const residents = await options.store.residents(vault);
        await options.store.deleteVault(vault);
        await Promise.all(residents.map((body) => options.dropBody(body.vault, body.note)));
        return [];
      }
      const readable = new Set(answer.notes.map((note) => note.path));
      const gone = unreadable(await options.store.residents(vault), readable);
      // A pin for a note that is no longer readable is a standing instruction to fetch
      // something this user may not have. It goes with the body.
      for (const pin of await options.store.pins(vault)) {
        if (!readable.has(pin.note)) await options.store.deletePin(vault, pin.note);
      }
      // Bodies first, then the metadata: interrupted half-way, the honest failure is a
      // device that has dropped what it may not read and will re-fetch what it may.
      for (const body of gone) {
        await options.dropBody(body.vault, body.note);
        await options.store.deleteResident(body.vault, body.note);
      }
      await options.store.putNotes(vault, answer.notes);
      return answer.notes;
    },
    async isResident(vault, note): Promise<boolean> {
      const residents = await options.store.residents(vault);
      return residents.some((body) => body.note === note);
    },
    async metadata(vault, note): Promise<ReplicatedNote | undefined> {
      const notes = await options.store.getNotes(vault);
      return notes?.find((entry) => entry.path === note);
    },
    async opened(vault, note): Promise<void> {
      // Read first, so opening a note does not forget what it weighed or that it has unsent
      // changes — `putResident` replaces the record rather than merging it.
      const existing = await options.store.getResident(vault, note);
      await options.store.putResident({
        vault,
        note,
        openedAt: now(),
        bytes: existing?.bytes ?? 0,
        dirty: existing?.dirty ?? false,
      });
    },
    async measured(vault, note, patch): Promise<void> {
      const existing = await options.store.getResident(vault, note);
      // Only for a note this device holds. Measuring one it does not would create a record
      // claiming a body that is not there, and `isResident` would then hide §7.2's state.
      if (existing === undefined) return;
      await options.store.putResident({
        ...existing,
        ...(patch.bytes === undefined ? {} : { bytes: patch.bytes }),
        ...(patch.dirty === undefined ? {} : { dirty: patch.dirty }),
      });
    },
    async evict(vault): Promise<readonly string[]> {
      const pinned = new Set((await options.store.pins(vault)).map((pin) => pin.note));
      const dropping = evictable(await options.store.residents(vault), pinned, caps);
      for (const body of dropping) {
        await options.dropBody(body.vault, body.note);
        await options.store.deleteResident(body.vault, body.note);
      }
      return dropping.map((body) => body.note);
    },
    async pinned(vault): Promise<readonly string[]> {
      return (await options.store.pins(vault)).map((pin: PinnedNote) => pin.note);
    },
    async setPinned(vault, note, pinned): Promise<void> {
      if (pinned) await options.store.putPin({ vault, note });
      else await options.store.deletePin(vault, note);
    },
  };
}

/**
 * The resident bodies a fresh readable set no longer contains.
 *
 * A note leaves that set for three reasons and this cannot tell them apart: the ACL
 * tightened, the note was deleted, or it was renamed. Dropping the local body is right for
 * all three — under the invisibility rule (§6.5) a note the server will not list is one that
 * does not exist for this reader, and a stale replica of it is exactly the thing §6.7 admits
 * an offline client keeps until it reconnects. This is the reconnection.
 */
export function unreadable(
  residents: readonly ResidentBody[],
  readable: ReadonlySet<string>,
): readonly ResidentBody[] {
  return residents.filter((body) => !readable.has(body.note));
}

/** Deletes the `y-indexeddb` database holding one note's body. */
export function dropBodyWith(factory: Factory): DropBody {
  return (vault: string, note: string): Promise<void> =>
    new Promise<void>((resolve) => {
      const request = factory.deleteDatabase(persistenceName(vault, note));
      // Resolves either way. A database that will not delete — because a tab still has it
      // open — must not stall reconciliation; the record is dropped regardless, so the body
      // is unreachable from this application even if its bytes linger until the tab closes.
      request.onsuccess = (): void => resolve();
      request.onerror = (): void => resolve();
      request.onblocked = (): void => resolve();
    });
}
