/**
 * The tag pane's state (`SPEC.md` §9.3).
 *
 * Two fetches with different lifetimes, which is why this is a class rather than two effects
 * in the component: the tree is per vault and fetched once, the note list is per selected tag
 * and refetched on every selection. Both outlive the component, because the pane is unmounted
 * whenever the left sidebar is collapsed and re-fetching a 10 000-note vault's tag tree on
 * every toggle is not a thing to do.
 */

import { type TagCount, type TaggedNote, fetchTaggedNotes, fetchTags } from "./tags.js";

export interface TagViewOptions {
  readonly vault: string;
  /** Injectable for tests; default to the real HTTP calls. */
  readonly load?: typeof fetchTags;
  readonly loadNotes?: typeof fetchTaggedNotes;
}

export class TagView {
  #counts: readonly TagCount[] = $state([]);
  #state: "idle" | "loading" | "ready" | "unavailable" = $state("idle");
  #selected: string | undefined = $state(undefined);
  #notes: readonly TaggedNote[] = $state([]);
  #notesState: "idle" | "loading" | "ready" | "unavailable" = $state("idle");
  /** Guards against an out-of-order response; see `select`. */
  #request = 0;
  readonly #vault: string;
  readonly #load: typeof fetchTags;
  readonly #loadNotes: typeof fetchTaggedNotes;

  constructor(options: TagViewOptions) {
    this.#vault = options.vault;
    this.#load = options.load ?? fetchTags;
    this.#loadNotes = options.loadNotes ?? fetchTaggedNotes;
  }

  /** Every tag prefix, already permission-filtered by the server (E16). */
  get counts(): readonly TagCount[] {
    return this.#counts;
  }

  get loading(): boolean {
    return this.#state === "loading";
  }

  /** Whether the tree has arrived and is empty — a real answer, not a failure. */
  get empty(): boolean {
    return this.#state === "ready" && this.#counts.length === 0;
  }

  /**
   * Whether the server would not say.
   *
   * Kept apart from `empty` for the reason the backlinks panel keeps them apart: a vault with
   * no tags and a request that was refused are different facts, and showing the second as the
   * first is a lie the user cannot see through.
   */
  get unavailable(): boolean {
    return this.#state === "unavailable";
  }

  /** The selected tag's key, or `undefined` when nothing is selected. */
  get selected(): string | undefined {
    return this.#selected;
  }

  get notes(): readonly TaggedNote[] {
    return this.#notes;
  }

  get notesLoading(): boolean {
    return this.#notesState === "loading";
  }

  get notesUnavailable(): boolean {
    return this.#notesState === "unavailable";
  }

  /**
   * Fetches the tree if nothing has yet.
   *
   * Safe to call from a render path: a second call while one is in flight, or after it has
   * arrived, does nothing. The pane calls it from an effect that re-runs.
   */
  ensure(): void {
    if (this.#state !== "idle") return;
    void this.refresh();
  }

  /** Re-fetches the tree, for when an edit may have added or removed a tag. */
  async refresh(): Promise<void> {
    this.#state = "loading";
    const counts = await this.#load(this.#vault);
    if (counts === undefined) {
      this.#counts = [];
      this.#state = "unavailable";
      return;
    }
    this.#counts = counts;
    this.#state = "ready";
  }

  /**
   * Selects a tag and loads the notes under it, or clears the selection when given the tag
   * already selected — the second click on a row puts it back.
   */
  select(key: string | undefined): void {
    if (key === undefined || key === this.#selected) {
      this.#selected = undefined;
      this.#notes = [];
      this.#notesState = "idle";
      // Any answer still in flight belongs to a selection that no longer exists.
      this.#request += 1;
      return;
    }
    this.#selected = key;
    this.#notes = [];
    this.#notesState = "loading";
    // why: a sequence number rather than an AbortController, as in `backlinks.svelte.ts`.
    // What matters is not that the request stops but that a late answer for the previously
    // selected tag cannot land under the current one.
    this.#request += 1;
    const request = this.#request;
    void this.#loadNotes(this.#vault, key).then((response) => {
      if (request !== this.#request) return;
      if (response === undefined) {
        this.#notesState = "unavailable";
        return;
      }
      this.#notes = response.notes;
      this.#notesState = "ready";
    });
  }
}
