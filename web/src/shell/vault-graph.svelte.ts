/**
 * The global graph's state (`SPEC.md` §9.4).
 *
 * Owns the four things that outlive a frame: the payload, the filters over it, the layout
 * running in a worker, and the camera. The component below it draws whatever this says and
 * decides nothing — which is what keeps the decisions testable, since the two canvases it
 * draws into cannot be exercised outside a real browser.
 *
 * **The layout is restarted, never patched.** A filter change removes nodes, and a force
 * simulation whose node set changed under it is a picture that jumps. Restarting is cheap in
 * the only sense that matters: the worker is already off the main thread, and a settled
 * layout of a *filtered* vault is a different picture anyway.
 */

import { type Camera, type SizeBy, boundsOf, fitCamera } from "./graph-camera.js";
import { type GraphFilters, NO_FILTERS, filterGraph } from "./graph-filters.js";
import { type LayoutFrame, type LayoutRequest, startLayout } from "./graph-layout-run.js";
import { type VaultGraphData, type VaultGraphNode, fetchVaultGraph } from "./vault-graph.js";

/** Something that can lay a graph out and report positions as it goes. */
export interface LayoutRunner {
  /** Starts a layout, replacing any that is running. */
  start(count: number, edges: Uint32Array, onframe: (frame: LayoutFrame) => void): void;
  /** Stops whatever is running and releases anything it holds. */
  stop(): void;
}

/**
 * A runner backed by a real Web Worker, falling back to this thread when there is none.
 *
 * The fallback is not a second implementation: `startLayout` takes its scheduling from the
 * caller, so the same code runs either way — on animation frames here, on `setTimeout` there.
 * That matters because a browser without workers is rare and a *worker that failed to load*
 * is not, and a graph that silently does not appear is worse than one that is briefly less
 * smooth.
 */
export function createRunner(makeWorker: (() => Worker) | undefined = spawnWorker): LayoutRunner {
  let worker: Worker | undefined;
  let cancelInline: (() => void) | undefined;
  let run = 0;

  const stop = (): void => {
    cancelInline?.();
    cancelInline = undefined;
    worker?.terminate();
    worker = undefined;
  };

  return {
    start(count, edges, onframe) {
      stop();
      run += 1;
      const request: LayoutRequest = {
        kind: "layout",
        run,
        count,
        // A copy, because posting transfers the buffer and the caller still needs its edges
        // to draw with.
        edges: edges.slice().buffer as ArrayBuffer,
      };
      const mine = run;
      const deliver = (frame: LayoutFrame): void => {
        // A frame from a superseded layout is a picture of a graph nobody is looking at.
        if (frame.run === mine) onframe(frame);
      };

      if (makeWorker !== undefined) {
        try {
          const spawned = makeWorker();
          spawned.addEventListener("message", (event: MessageEvent<LayoutFrame>) => {
            deliver(event.data);
          });
          spawned.postMessage(request, [request.edges]);
          worker = spawned;
          return;
        } catch {
          // Fall through to the inline path below. Nothing is logged: a browser that will
          // not give us a worker is a browser we still have to draw in.
        }
      }
      cancelInline = startLayout(
        request,
        (frame) => {
          deliver(frame);
        },
        (step) => {
          if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => step());
          else setTimeout(step, 0);
        },
        () => performance.now(),
      );
    },
    stop,
  };
}

/**
 * The real worker.
 *
 * `new URL(..., import.meta.url)` rather than a bare import is what makes the bundler emit
 * the layout as its own chunk: it is not on the critical path (§21.1), and a graph nobody
 * opens should not be bytes everybody downloads.
 */
function spawnWorker(): Worker {
  return new Worker(new URL("./graph-worker.ts", import.meta.url), { type: "module" });
}

export interface VaultGraphOptions {
  readonly vault: string;
  /** Injectable for tests; defaults to the real HTTP call. */
  readonly load?: typeof fetchVaultGraph;
  /** Injectable for tests; defaults to a worker-backed runner. */
  readonly runner?: LayoutRunner;
  /** How many nodes to ask for — §9.4's mobile cap. */
  readonly limit?: number | undefined;
}

/**
 * Everything the global graph view needs, as reactive state.
 *
 * Positions are `$state.raw`: they are typed arrays replaced wholesale on every frame, and
 * making them deeply reactive would put a proxy on ten thousand floats sixty times a second.
 */
export class VaultGraphView {
  #graph: VaultGraphData | undefined = $state.raw(undefined);
  #filters: GraphFilters = $state.raw(NO_FILTERS);
  #sizeBy: SizeBy = $state<SizeBy>("degree");
  #camera: Camera = $state.raw({ x: 0, y: 0, scale: 1 });
  #x: Float32Array = $state.raw(new Float32Array(0));
  #y: Float32Array = $state.raw(new Float32Array(0));
  #settled = $state(false);
  #selected = $state(-1);
  #status: "idle" | "loading" | "ready" | "unavailable" = $state("idle");
  #viewport: { width: number; height: number } = { width: 0, height: 0 };
  #framed = false;
  #request = 0;

  readonly #vault: string;
  readonly #load: typeof fetchVaultGraph;
  readonly #runner: LayoutRunner;
  readonly #limit: number | undefined;

  constructor(options: VaultGraphOptions) {
    this.#vault = options.vault;
    this.#load = options.load ?? fetchVaultGraph;
    this.#runner = options.runner ?? createRunner();
    this.#limit = options.limit;
  }

  get loading(): boolean {
    return this.#status === "loading";
  }

  /** Whether the server would not say. Never rendered as an empty vault; see the view. */
  get unavailable(): boolean {
    return this.#status === "unavailable";
  }

  /** Whether the picture has arrived and there is nothing in it. */
  get empty(): boolean {
    return this.#status === "ready" && (this.#graph?.nodes.length ?? 0) === 0;
  }

  /** The nodes after filtering — what is drawn, and what an index means everywhere else. */
  get nodes(): readonly VaultGraphNode[] {
    return this.#filtered.nodes;
  }

  get edges(): Uint32Array {
    return this.#filtered.edges;
  }

  get x(): Float32Array {
    return this.#x;
  }

  get y(): Float32Array {
    return this.#y;
  }

  get camera(): Camera {
    return this.#camera;
  }

  get filters(): GraphFilters {
    return this.#filters;
  }

  get sizeBy(): SizeBy {
    return this.#sizeBy;
  }

  /** Whether the layout has stopped moving, so the view can stop asking for frames. */
  get settled(): boolean {
    return this.#settled;
  }

  /** The picked node's index in {@link VaultGraphView.nodes}, or `-1`. */
  get selected(): number {
    return this.#selected;
  }

  /** How many nodes the vault has, before the server's cap and before these filters. */
  get total(): number {
    return this.#graph?.total ?? 0;
  }

  /** Whether the server capped the picture (§9.4's "showing 2,000 of 10,431"). */
  get truncated(): boolean {
    return this.#graph?.truncated ?? false;
  }

  /** How many nodes the filters are hiding, so the view can say so. */
  get hidden(): number {
    return (this.#graph?.nodes.length ?? 0) - this.#filtered.nodes.length;
  }

  /**
   * The tags in the vault, most used first — what the filter control offers.
   *
   * why: over the *unfiltered* graph. Taking them from what is on screen would mean that
   * excluding a tag removes its own button, so a reader could hide a tag and then have no way
   * to stop hiding it short of clearing every filter.
   */
  get tags(): readonly string[] {
    const counted = new Map<string, number>();
    for (const node of this.#graph?.nodes ?? []) {
      for (const tag of node.tags) counted.set(tag, (counted.get(tag) ?? 0) + 1);
    }
    return [...counted.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_TAG_FILTERS)
      .map(([tag]) => tag);
  }

  /** The largest value of whatever nodes are sized by — what a radius is relative to. */
  get largest(): number {
    let largest = 0;
    for (const node of this.#filtered.nodes) {
      const value = this.#sizeBy === "words" ? node.words : node.degree;
      if (value > largest) largest = value;
    }
    return largest;
  }

  #filteredCache: ReturnType<typeof filterGraph> = $derived(
    filterGraph(this.#graph ?? EMPTY, this.#filters),
  );

  get #filtered(): ReturnType<typeof filterGraph> {
    return this.#filteredCache;
  }

  /**
   * Fetches the vault and starts laying it out, once.
   *
   * why: idempotent for **every** state except `idle`, including `unavailable`. The view
   * calls this from an effect, and an effect that reads the status and writes it is an effect
   * that re-runs itself — so a version that retried after a failure did not retry, it looped:
   * one request per frame, for as long as the pane was open. A failed load stays failed until
   * somebody asks again, which is what the pane's "Try again" is for.
   */
  load(): void {
    if (this.#status !== "idle") return;
    this.reload();
  }

  /** Fetches again, discarding whatever is on screen. */
  reload(): void {
    this.#status = "loading";
    this.#request += 1;
    const request = this.#request;
    void this.#load(this.#vault, { limit: this.#limit }).then((graph) => {
      if (request !== this.#request) return;
      if (graph === undefined) {
        this.#status = "unavailable";
        return;
      }
      this.#graph = graph;
      this.#status = "ready";
      this.#framed = false;
      this.#selected = -1;
      this.relayout();
    });
  }

  /** Restarts the simulation over whatever is currently filtered in. */
  relayout(): void {
    const count = this.#filtered.nodes.length;
    this.#settled = count === 0;
    this.#x = new Float32Array(count);
    this.#y = new Float32Array(count);
    this.#runner.start(count, this.#filtered.edges, (frame) => {
      this.#x = new Float32Array(frame.x);
      this.#y = new Float32Array(frame.y);
      this.#settled = frame.settled;
      if (!this.#framed) this.fit();
    });
  }

  /** Stops the worker. Every view that creates one of these must call it on teardown. */
  dispose(): void {
    this.#runner.stop();
  }

  setFilters(filters: GraphFilters): void {
    this.#filters = filters;
    // The selection is an index into the filtered list, so it means something different now.
    this.#selected = -1;
    this.#framed = false;
    this.relayout();
  }

  setSizeBy(sizeBy: SizeBy): void {
    this.#sizeBy = sizeBy;
  }

  select(index: number): void {
    this.#selected = index >= 0 && index < this.#filtered.nodes.length ? index : -1;
  }

  setCamera(camera: Camera): void {
    this.#camera = camera;
    // A reader who has moved the camera owns it: refitting under them on the next layout
    // frame would drag the picture out from under a drag.
    this.#framed = true;
  }

  /** Tells the view how big it is. Refits while the reader has not taken the camera over. */
  resize(width: number, height: number): void {
    this.#viewport = { width, height };
    if (!this.#framed) this.fit();
  }

  /** Frames the whole picture — §9.4's `0` key, and what every fresh layout starts at. */
  fit(): void {
    const { width, height } = this.#viewport;
    if (!(width > 0) || !(height > 0)) return;
    this.#camera = fitCamera(boundsOf(this.#x, this.#y, this.#filtered.nodes.length), width, height);
  }
}

/**
 * How many tags the filter control offers.
 *
 * A vault's tag *vocabulary* is small next to its note count (§9.3), but "small" is an
 * assumption rather than a measurement — a row of four hundred buttons would be a filter
 * nobody can use, so the list is the most-used ones and the rest are reachable by path or by
 * the tag pane.
 */
const MAX_TAG_FILTERS = 24;

const EMPTY: VaultGraphData = {
  nodes: [],
  edges: new Uint32Array(0),
  total: 0,
  truncated: false,
};
