/**
 * Which notes this device keeps offline (`SPEC.md` §7.2).
 *
 * A thin reactive shell over the replica's pin store, because the palette has to *read* the
 * pin state to word its command — "Keep this note offline" and "Stop keeping it" are one
 * command, and a toggle that cannot see its own state has to be two.
 *
 * Loaded once per vault per session and updated in place. Pins are changed by this device,
 * so there is no second writer to disagree with — except a second tab, which is the same
 * limitation every other cached list in the shell has (`HANDOFF.md`).
 */

import { localReplica } from "../offline/local.js";
import type { Replica } from "../offline/replica.js";

export interface PinnedNotesOptions {
  readonly vault: string;
  /** Injectable for tests; defaults to this page's replica. */
  readonly replica?: () => Promise<Replica | undefined>;
}

export class PinnedNotes {
  #notes: readonly string[] = $state([]);
  #available = $state(false);
  #loaded = false;
  readonly #vault: string;
  readonly #replica: () => Promise<Replica | undefined>;

  constructor(options: PinnedNotesOptions) {
    this.#vault = options.vault;
    this.#replica = options.replica ?? localReplica;
  }

  /** The pinned notes, as paths. Empty until `ensure` has resolved. */
  get notes(): readonly string[] {
    return this.#notes;
  }

  /**
   * Whether this device can keep anything offline at all.
   *
   * `false` until the store has been opened once, and permanently `false` where there is
   * nowhere to keep a replica. The command that offers pinning is *absent* rather than
   * disabled in that case: a row that is present and does nothing is worse than one that is
   * not there, because it looks like a broken feature rather than an unavailable one.
   */
  get available(): boolean {
    return this.#available;
  }

  has(note: string): boolean {
    return this.#notes.includes(note);
  }

  /** Loads the pins once. Safe to call from a render path. */
  ensure(): void {
    if (this.#loaded) return;
    this.#loaded = true;
    void this.refresh();
  }

  async refresh(): Promise<void> {
    const replica = await this.#replica();
    this.#available = replica !== undefined;
    this.#notes = (await replica?.pinned(this.#vault)) ?? [];
  }

  /**
   * Pins or unpins a note, and returns what it now is.
   *
   * The local state is updated from the store's answer rather than optimistically: a device
   * with nowhere to keep a replica cannot pin anything, and a UI that claimed otherwise
   * would promise a note offline that will not be there.
   */
  async toggle(note: string): Promise<boolean> {
    const replica = await this.#replica();
    if (replica === undefined) return false;
    const next = !this.has(note);
    await replica.setPinned(this.#vault, note, next);
    this.#notes = await replica.pinned(this.#vault);
    return this.has(note);
  }
}
