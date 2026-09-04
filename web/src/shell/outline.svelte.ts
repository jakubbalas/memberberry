/**
 * The outline of the note in front (`SPEC.md` §9.5).
 *
 * Unlike the backlinks panel and the tag pane, this fetches nothing: the headings are in the
 * open document, so they arrive as {@link OUTLINE_EVENT} announcements from the editor and
 * change as the reader types. There is no request, no loading state, and no staleness — the
 * one thing to get right is that a request travelling back down reaches *the editor that
 * announced*, which is why the source element is kept beside the headings.
 */

import {
  OUTLINE_GOTO_EVENT,
  OUTLINE_MOVE_EVENT,
  type OutlineDetail,
  type OutlineGotoDetail,
  type OutlineHeading,
  type OutlineMoveDetail,
} from "../editor/outline.js";

export class OutlineView {
  #headings: readonly OutlineHeading[] = $state([]);
  #active = $state(-1);
  /**
   * The editor's DOM, which is where a request goes back.
   *
   * Deliberately not `$state`: nothing renders it, and making a DOM node reactive would have
   * every announcement invalidate whatever read it.
   */
  #source: Element | undefined;

  get headings(): readonly OutlineHeading[] {
    return this.#headings;
  }

  /** The heading the reader is inside, or `-1` above the first one. */
  get active(): number {
    return this.#active;
  }

  /** Takes an announcement from an editor. */
  receive(detail: OutlineDetail, source: EventTarget | null): void {
    this.#headings = detail.headings;
    this.#active = detail.active;
    this.#source = source instanceof Element ? source : undefined;
  }

  /** Empties the panel — the pane closed, or its note changed and has not announced yet. */
  clear(): void {
    this.#headings = [];
    this.#active = -1;
    this.#source = undefined;
  }

  /** Asks the editor to scroll to a heading (§9.5, "click to scroll"). */
  goto(index: number): void {
    this.#request<OutlineGotoDetail>(OUTLINE_GOTO_EVENT, { index });
  }

  /** Asks the editor to move a section, which moves the blocks under it. */
  move(from: number, to: number): void {
    if (from === to) return;
    this.#request<OutlineMoveDetail>(OUTLINE_MOVE_EVENT, { from, to });
  }

  #request<T>(name: string, detail: T): void {
    const source = this.#source;
    // A pane can close between the announcement and the click. Dispatching at a detached
    // element is silent rather than wrong, but checking says so out loud.
    if (source === undefined || !source.isConnected) return;
    source.dispatchEvent(new CustomEvent<T>(name, { detail }));
  }
}
