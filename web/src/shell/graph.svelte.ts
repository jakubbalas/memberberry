/**
 * The local graph's state (`SPEC.md` §9.4).
 *
 * Reactive state rather than a fetch in the component, for the reasons the backlinks panel
 * has and one of its own: a switch between two notes must not let the slower response
 * overwrite the faster one, the panel is unmounted whenever the right sidebar is collapsed,
 * and the hop count is a control the user sets — so it outlives both the note and the panel.
 *
 * There is no cache. A neighbourhood changes when anyone edits any note near this one, and a
 * stale picture draws a link that has been deleted.
 */

import { type GraphEdge, type GraphNode, clampHops, fetchGraph } from "./graph.js";

export interface GraphViewOptions {
  readonly vault: string;
  /** Injectable for tests; defaults to the real HTTP call. */
  readonly load?: typeof fetchGraph;
  /** Where the hop control starts. §9.4's range is 1–3 and 1 is the cheapest honest answer. */
  readonly hops?: number;
}

export class GraphView {
  #note: string | undefined = $state(undefined);
  #nodes: readonly GraphNode[] = $state([]);
  #edges: readonly GraphEdge[] = $state([]);
  #truncated = $state(false);
  #hops: number = $state(1);
  #state: "idle" | "loading" | "ready" | "unavailable" = $state("idle");
  /** Guards against an out-of-order response; see `show`. */
  #request = 0;
  readonly #vault: string;
  readonly #load: typeof fetchGraph;

  constructor(options: GraphViewOptions) {
    this.#vault = options.vault;
    this.#load = options.load ?? fetchGraph;
    this.#hops = clampHops(options.hops ?? 1);
  }

  /** The note this graph is drawn around, or `undefined` before anything asked. */
  get note(): string | undefined {
    return this.#note;
  }

  get nodes(): readonly GraphNode[] {
    return this.#nodes;
  }

  get edges(): readonly GraphEdge[] {
    return this.#edges;
  }

  /** How far the walk went — the server's answer, so a clamped request shows what it drew. */
  get hops(): number {
    return this.#hops;
  }

  /** Whether the node cap cut the neighbourhood short (§9.4). */
  get truncated(): boolean {
    return this.#truncated;
  }

  get loading(): boolean {
    return this.#state === "loading";
  }

  /**
   * Whether the picture has arrived and holds nothing but the note itself.
   *
   * A real answer — a note nothing links to and that links to nothing — and deliberately not
   * the same state as `unavailable`.
   */
  get empty(): boolean {
    return this.#state === "ready" && this.#nodes.length <= 1;
  }

  /** Whether the server would not say. Never rendered as an empty graph; see the panel. */
  get unavailable(): boolean {
    return this.#state === "unavailable";
  }

  /**
   * Draws `note`, or clears the panel when there is no note.
   *
   * Idempotent for the note and hop count already shown, so it is safe to call from an
   * effect that re-runs when anything else in the pane changes.
   */
  show(note: string | undefined): void {
    if (note === this.#note && this.#state !== "idle") return;
    this.#note = note;
    this.#draw(note, this.#hops);
  }

  /**
   * Widens or narrows the walk (§9.4's adjustable 1–3).
   *
   * Refetches rather than filtering the picture it already has: a two-hop graph is not a
   * one-hop graph plus a ring — the outer ring's own links to each other come with it — so
   * narrowing by discarding nodes would leave edges the server never sent.
   */
  setHops(hops: number): void {
    const next = clampHops(hops);
    if (next === this.#hops && this.#state !== "idle") return;
    this.#hops = next;
    this.#draw(this.#note, next);
  }

  /** Re-fetches, for when an edit may have changed what is near this note. */
  refresh(): void {
    this.#draw(this.#note, this.#hops);
  }

  #draw(note: string | undefined, hops: number): void {
    this.#nodes = [];
    this.#edges = [];
    this.#truncated = false;
    if (note === undefined) {
      this.#state = "ready";
      return;
    }
    this.#state = "loading";
    // why: a sequence number rather than an AbortController, as in `BacklinkView` — what
    // matters is that a late answer for the previous note or hop count cannot land in the
    // panel, and only the caller's ordering can decide that.
    this.#request += 1;
    const request = this.#request;
    void this.#load(this.#vault, note, hops).then((response) => {
      if (request !== this.#request) return;
      if (response === undefined) {
        this.#state = "unavailable";
        return;
      }
      this.#nodes = response.nodes;
      this.#edges = response.edges;
      this.#truncated = response.truncated;
      // The server clamps, so the picture may be of a different walk than was asked for —
      // and the control has to show the one that was drawn.
      this.#hops = clampHops(response.hops);
      this.#state = "ready";
    });
  }
}
