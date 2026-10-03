/**
 * The vault's readable notes, loaded on demand and shared (`SPEC.md` §8.2, §8.4).
 *
 * The tree and the quick switcher want the same list. Fetching it twice would mean two things
 * that can disagree about which notes exist, and — since the list is the largest payload the
 * shell asks for — twice the cost of the largest payload the shell asks for.
 *
 * Fetched on demand rather than at mount: a session that only edits one note should not pay
 * for the index of a 10 000-note vault. The tree asks for it when the sidebar is open, the
 * palette when it is first opened, and whichever comes first pays. The workspace refreshes
 * this shared list on browser resume/reconnect events, without polling.
 */

import { localReplica } from "../offline/local.js";
import type { Replica } from "../offline/replica.js";
import { type NoteSummary, fetchNotes } from "./catalog.js";

export interface NoteCatalogOptions {
  readonly vault: string;
  /** Injectable for tests; defaults to the real HTTP call. */
  readonly load?: typeof fetchNotes;
  /** Injectable for tests; defaults to this page's replica (§7.2). */
  readonly replica?: () => Promise<Replica | undefined>;
}

export class NoteCatalog {
  #notes: readonly NoteSummary[] = $state([]);
  #state: "idle" | "loading" | "ready" = $state("idle");
  readonly #vault: string;
  readonly #load: typeof fetchNotes;
  readonly #replica: () => Promise<Replica | undefined>;
  #request = 0;
  #deniedThrough = 0;
  #reconciling: Promise<void> = Promise.resolve();

  constructor(options: NoteCatalogOptions) {
    this.#vault = options.vault;
    this.#load = options.load ?? fetchNotes;
    this.#replica = options.replica ?? localReplica;
  }

  /** The readable notes, already permission-filtered by the server (§6.4 E5). */
  get notes(): readonly NoteSummary[] {
    return this.#notes;
  }

  /** Whether the list has arrived. `false` while loading *and* before anything asked. */
  get ready(): boolean {
    return this.#state === "ready";
  }

  get loading(): boolean {
    return this.#state === "loading";
  }

  /**
   * Fetches the list if nothing has yet.
   *
   * Safe to call from a render path: concurrent callers share one request, and a second call
   * after it has arrived does nothing. That matters because both the tree and the palette
   * call it, and the tree calls it from an effect that can re-run.
   */
  ensure(): void {
    if (this.#state !== "idle") return;
    void this.refresh();
  }

  /**
   * Re-fetches unconditionally, and reconciles the local replica with what came back (§7.4).
   *
   * The list this ends up holding is the replica's answer, not the server's, and the
   * difference is the whole point: offline it is the stored copy, and on a refusal it is
   * empty even though a stored copy exists.
   */
  async refresh(): Promise<void> {
    const request = ++this.#request;
    this.#state = "loading";
    const answer = await this.#load(this.#vault);
    // why: a newer network failure cannot supersede a denial. Every denial invalidates
    // requests already in flight; only a request begun afterwards can restore the list.
    if (answer.kind === "denied") {
      this.#deniedThrough = this.#request;
      this.#notes = [];
    } else if (request !== this.#request) return;
    const reconcile = async (): Promise<void> => {
      const replica = await this.#replica();
      // why: a success may have been queued or awaiting storage when a denial arrived.
      const notes = answer.kind === "ok" && request <= this.#deniedThrough
        ? []
        : replica === undefined
          ? (answer.kind === "ok" ? answer.notes : [])
          : await replica.reconcile(this.#vault, answer);
      if (request !== this.#request) return;
      // why: an offline read already in progress can still return pre-purge metadata.
      this.#notes = request <= this.#deniedThrough ? [] : notes;
      this.#state = "ready";
    };
    // why: checking only the rendered result still lets an older IndexedDB write undo a
    // denial. Accepted answers reconcile in order, including denials followed by offline
    // reads. A failed storage operation must not poison every subsequent refresh.
    const pending = this.#reconciling.then(reconcile, reconcile);
    this.#reconciling = pending;
    await pending;
  }
}
