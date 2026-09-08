/**
 * The backlinks of whichever note is in front (`SPEC.md` §9.5).
 *
 * Reactive state rather than a fetch in the component, for two reasons the component cannot
 * solve on its own: a switch between two notes must not let the slower response overwrite the
 * faster one, and the panel is unmounted whenever the right sidebar is collapsed — which
 * would otherwise re-fetch on every toggle.
 *
 * There is no cache. Backlinks change when anyone edits any note that mentions this one, and
 * a stale panel is worse than a second request: it says a link exists that has been deleted.
 */

import { type BacklinkSource, type MentionSource, fetchBacklinks } from "./backlinks.js";

export interface BacklinkViewOptions {
  readonly vault: string;
  /** Injectable for tests; defaults to the real HTTP call. */
  readonly load?: typeof fetchBacklinks;
}

export class BacklinkView {
  #note: string | undefined = $state(undefined);
  #sources: readonly BacklinkSource[] = $state([]);
  #mentions: readonly MentionSource[] = $state([]);
  #state: "idle" | "loading" | "ready" | "unavailable" = $state("idle");
  /** Guards against an out-of-order response; see `show`. */
  #request = 0;
  readonly #vault: string;
  readonly #load: typeof fetchBacklinks;

  constructor(options: BacklinkViewOptions) {
    this.#vault = options.vault;
    this.#load = options.load ?? fetchBacklinks;
  }

  /** The note these backlinks are for, or `undefined` before anything asked. */
  get note(): string | undefined {
    return this.#note;
  }

  get sources(): readonly BacklinkSource[] {
    return this.#sources;
  }

  /** Notes naming this one without linking to it (§9.5). */
  get mentions(): readonly MentionSource[] {
    return this.#mentions;
  }

  get loading(): boolean {
    return this.#state === "loading";
  }

  /**
   * Whether the list of *links* has arrived and is empty — a real answer, not a failure.
   *
   * Deliberately not "and there are no mentions either". The two sections are separate
   * statements: "nothing links here yet" stays true and worth saying when six notes mention
   * the note without linking to it, which is precisely when a reader wants to know.
   */
  get empty(): boolean {
    return this.#state === "ready" && this.#sources.length === 0;
  }

  /**
   * Whether the server would not say.
   *
   * Kept apart from `empty` on purpose: a note nobody links to and a note the server refused
   * to answer for are different facts, and showing "no backlinks" for the second is a lie the
   * user cannot see through.
   */
  get unavailable(): boolean {
    return this.#state === "unavailable";
  }

  /**
   * Loads the backlinks for `note`, or clears the panel when there is no note.
   *
   * Idempotent for the note already shown, so it is safe to call from an effect that re-runs
   * when anything else in the pane changes.
   */
  show(note: string | undefined): void {
    if (note === this.#note && this.#state !== "idle") return;
    this.#note = note;
    this.#sources = [];
    this.#mentions = [];
    if (note === undefined) {
      this.#state = "ready";
      return;
    }
    this.#state = "loading";
    // why: a sequence number rather than an AbortController. Aborting the request would be
    // tidier if the response were expensive to receive, but what actually matters is that a
    // late answer for the previous note cannot land in the panel — and only the caller's
    // ordering can decide that.
    this.#request += 1;
    const request = this.#request;
    void this.#load(this.#vault, note).then((response) => {
      if (request !== this.#request) return;
      if (response === undefined) {
        this.#state = "unavailable";
        return;
      }
      this.#sources = response.sources;
      this.#mentions = response.mentions;
      this.#state = "ready";
    });
  }

  /** Re-fetches the current note's backlinks, for when an edit may have changed them. */
  refresh(): void {
    const note = this.#note;
    this.#note = undefined;
    this.show(note);
  }
}
