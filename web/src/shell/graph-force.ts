/**
 * The global graph's force-directed layout (`SPEC.md` §9.4).
 *
 * §9.4 asks for springs at vault scale, and this is why the local graph's rings are not
 * enough there: a neighbourhood is a picture of *distance from one note*, which a ring says
 * exactly, and a vault is a picture of **which notes belong together**, which only a layout
 * that lets clusters find each other can say. The three forces are the standard ones —
 * repulsion between every pair, a spring along every edge, and a recentring — with the
 * all-pairs term approximated by a quadtree (Barnes-Hut, §9.4) so ten thousand nodes cost
 * `n log n` per tick rather than `n²`.
 *
 * **This module is pure and knows nothing about the DOM**, because it runs in a Web Worker
 * (§21.3: long work belongs off the main thread, whose job is painting). `graph-worker.ts` is
 * the shim around it; everything worth testing is here, testable without a worker.
 *
 * **Deterministic, on purpose.** Nothing here calls `Math.random`: the starting positions are
 * a phyllotaxis spiral and the tie-breaking jiggle is a hash of the node index. The same
 * vault therefore draws the same picture every time it is opened, which is the difference
 * between a graph a reader can build a memory of and a decoration that rearranges itself.
 */

import { Quadtree } from "./graph-quadtree.js";

/** How many numbers one edge occupies — matching the wire format (§9.4). */
const EDGE_STRIDE = 3;

/** How cool the simulation is when it stops: movement below this is smaller than a pixel. */
const ALPHA_MIN = 0.001;

/** How much of its velocity a node keeps between ticks. d3-force's 0.6, and for its reason:
 * higher oscillates, lower crawls. */
const FRICTION = 0.6;

/** Barnes-Hut's opening angle. Larger is faster and coarser; 0 would be an all-pairs sum. */
const THETA = 0.9;

/** How hard nodes push each other apart, per unit of alpha. */
const REPULSION = -60;

/** Below this distance the repulsion is softened, so a near-collision cannot fling a node. */
const MIN_DISTANCE_SQUARED = 4;

/** The length a spring is happy at. Everything else is measured in these units. */
const SPRING_LENGTH = 30;

export interface ForceLayoutOptions {
  /** How many nodes to place. */
  readonly count: number;
  /** Edges as flat triples of node indices, as {@link readVaultGraph} validates them. */
  readonly edges: Uint32Array;
  /** How many ticks the simulation takes to cool. More is slower and tidier. */
  readonly ticks?: number;
}

/** How many ticks a layout runs for by default. */
export const DEFAULT_TICKS = 320;

/**
 * A cooling force simulation over a fixed set of nodes.
 *
 * Positions live in `x` and `y` and are mutated in place; the caller reads them between
 * ticks and is expected not to write to them. Nothing is allocated per tick apart from the
 * quadtree's growth on the first build, so a long run does not fill the heap with garbage
 * for the collector to find in the middle of an animation.
 */
export class ForceLayout {
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly #vx: Float32Array;
  readonly #vy: Float32Array;
  readonly #count: number;
  readonly #edges: Uint32Array;
  /** How many drawn edges touch each node — what a spring's strength is divided by. */
  readonly #linked: Float64Array;
  readonly #tree = new Quadtree();
  /** Scratch for [`repulsionOn`], so a tick allocates nothing per node. */
  readonly #push = new Float64Array(2);
  readonly #decay: number;
  readonly #budget: number;
  #alpha = 1;
  #ticks = 0;

  constructor(options: ForceLayoutOptions) {
    const count = Math.max(0, Math.floor(options.count));
    const ticks = Math.max(1, Math.floor(options.ticks ?? DEFAULT_TICKS));
    this.#count = count;
    this.#edges = options.edges;
    this.x = new Float32Array(count);
    this.y = new Float32Array(count);
    this.#vx = new Float32Array(count);
    this.#vy = new Float32Array(count);
    this.#linked = new Float64Array(count);
    // The decay that takes alpha from 1 to ALPHA_MIN in exactly `ticks` steps, so "how long
    // does this take" is a number a caller sets rather than one they discover.
    this.#budget = ticks;
    this.#decay = 1 - ALPHA_MIN ** (1 / ticks);

    for (let at = 0; at + EDGE_STRIDE <= this.#edges.length; at += EDGE_STRIDE) {
      const source = this.#edges[at] ?? 0;
      const target = this.#edges[at + 1] ?? 0;
      if (source >= count || target >= count) continue;
      this.#linked[source] = (this.#linked[source] ?? 0) + 1;
      this.#linked[target] = (this.#linked[target] ?? 0) + 1;
    }
    this.#place();
  }

  /** How hot the simulation still is: 1 at the start, [`ALPHA_MIN`] when it is done. */
  get alpha(): number {
    return this.#alpha;
  }

  /**
   * Whether it has cooled. A settled layout does not need another frame.
   *
   * why: the tick budget rather than a threshold on alpha. The decay is chosen so that alpha
   * reaches [`ALPHA_MIN`] after exactly `ticks` steps, and `alpha < ALPHA_MIN` then depends
   * on which side of that value the rounding lands — one run of 320 ticks and the next of
   * 321, for no reason a reader could see. Counting is the thing the caller was promised.
   *
   * An empty graph is settled from the start: there is nothing in it to move, and a caller
   * looping until this was true would otherwise spin on a vault with no readable notes.
   */
  get settled(): boolean {
    return this.#count === 0 || this.#ticks >= this.#budget;
  }

  /** How many ticks have run. */
  get ticks(): number {
    return this.#ticks;
  }

  /**
   * Advances the simulation one step.
   *
   * Calling it after {@link ForceLayout.settled} is harmless and does nothing — the caller
   * driving an animation frame loop should not have to check twice.
   */
  tick(): void {
    if (this.settled) return;
    this.#alpha += (0 - this.#alpha) * this.#decay;
    this.#ticks += 1;

    this.#repel();
    this.#pull();
    for (let i = 0; i < this.#count; i += 1) {
      const vx = (this.#vx[i] ?? 0) * FRICTION;
      const vy = (this.#vy[i] ?? 0) * FRICTION;
      this.#vx[i] = vx;
      this.#vy[i] = vy;
      this.x[i] = (this.x[i] ?? 0) + vx;
      this.y[i] = (this.y[i] ?? 0) + vy;
    }
    this.#recentre();
  }

  /** Runs until settled. For a test, and for a caller with no frames to spend. */
  run(): void {
    while (!this.settled) {
      this.tick();
    }
  }

  /**
   * Starting positions: a phyllotaxis spiral, the arrangement of a sunflower's seeds.
   *
   * why: not a grid and not random. A grid starts every node in a straight line with its
   * neighbours, and the symmetry takes many ticks to break; random is not reproducible, which
   * is the property this whole module is arranged around. The spiral is even, has no axis to
   * get stuck on, and is a closed form.
   */
  #place(): void {
    const angle = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < this.#count; i += 1) {
      const radius = SPRING_LENGTH * Math.sqrt(0.5 + i);
      this.x[i] = radius * Math.cos(i * angle);
      this.y[i] = radius * Math.sin(i * angle);
    }
  }

  /** Every node pushes every other away, through the quadtree (§9.4's Barnes-Hut). */
  #repel(): void {
    this.#tree.build(this.x, this.y, this.#count);
    for (let i = 0; i < this.#count; i += 1) {
      repulsionOn(this.#tree, this.x[i] ?? 0, this.y[i] ?? 0, this.#alpha, i, this.#push);
      this.#vx[i] = (this.#vx[i] ?? 0) + (this.#push[0] ?? 0);
      this.#vy[i] = (this.#vy[i] ?? 0) + (this.#push[1] ?? 0);
    }
  }

  /**
   * Every edge pulls its ends towards [`SPRING_LENGTH`].
   *
   * How hard, and which end gives way, are [`springStrength`] and [`springShare`] — both of
   * them functions of the ends' degrees, because a note with four hundred backlinks is on
   * four hundred springs and each of its neighbours is on one.
   */
  #pull(): void {
    const alpha = this.#alpha;
    for (let at = 0; at + EDGE_STRIDE <= this.#edges.length; at += EDGE_STRIDE) {
      const source = this.#edges[at] ?? 0;
      const target = this.#edges[at + 1] ?? 0;
      if (source >= this.#count || target >= this.#count || source === target) continue;
      const sourceLinks = this.#linked[source] ?? 1;
      const targetLinks = this.#linked[target] ?? 1;

      // Measured from where the ends are *going*, not where they are: applying every spring
      // to stale positions makes a chain of them wobble instead of straighten.
      let dx = (this.x[target] ?? 0) + (this.#vx[target] ?? 0) - (this.x[source] ?? 0) - (this.#vx[source] ?? 0);
      let dy = (this.y[target] ?? 0) + (this.#vy[target] ?? 0) - (this.y[source] ?? 0) - (this.#vy[source] ?? 0);
      let length = Math.sqrt(dx * dx + dy * dy);
      if (length === 0) {
        dx = jiggle(source * 3 + 1);
        dy = jiggle(target * 3 + 2);
        length = Math.sqrt(dx * dx + dy * dy);
      }
      const pull =
        ((length - SPRING_LENGTH) / length) * alpha * springStrength(sourceLinks, targetLinks);
      const shift = springShare(sourceLinks, targetLinks);
      this.#vx[target] = (this.#vx[target] ?? 0) - dx * pull * shift;
      this.#vy[target] = (this.#vy[target] ?? 0) - dy * pull * shift;
      this.#vx[source] = (this.#vx[source] ?? 0) + dx * pull * (1 - shift);
      this.#vy[source] = (this.#vy[source] ?? 0) + dy * pull * (1 - shift);
    }
  }

  /**
   * Slides everything so the centre of the picture stays at the origin.
   *
   * Repulsion has no opposing force at long range, so a disconnected graph drifts outwards
   * forever and a connected one wanders. Moving positions rather than adding a force towards
   * the middle keeps the shape exactly as the springs made it — a gravity term would squash
   * the outer clusters inwards, which is a claim about the vault that nothing measured.
   */
  #recentre(): void {
    if (this.#count === 0) return;
    let sumX = 0;
    let sumY = 0;
    for (let i = 0; i < this.#count; i += 1) {
      sumX += this.x[i] ?? 0;
      sumY += this.y[i] ?? 0;
    }
    const shiftX = sumX / this.#count;
    const shiftY = sumY / this.#count;
    for (let i = 0; i < this.#count; i += 1) {
      this.x[i] = (this.x[i] ?? 0) - shiftX;
      this.y[i] = (this.y[i] ?? 0) - shiftY;
    }
  }
}

/**
 * The repulsion a point at `(px, py)` feels from everything in `tree`, written into `out`.
 *
 * Exported because this is where Barnes-Hut's approximation is *used*, and the thing most
 * worth pinning about it is invisible in a finished picture: a quad standing in for forty
 * notes has to push forty times as hard as one note would. A layout that ignored `mass`
 * still draws something plausible, which is exactly why it needs a test of its own.
 *
 * `out` is a two-element scratch array rather than a returned pair: this runs once per node
 * per tick, and at ten thousand nodes over three hundred ticks a returned tuple is three
 * million allocations for the collector to find mid-animation.
 *
 * `seed` identifies the point for the deterministic jiggle — see [`jiggle`].
 */
export function repulsionOn(
  tree: Quadtree,
  px: number,
  py: number,
  alpha: number,
  seed: number,
  out: Float64Array,
): void {
  let fx = 0;
  let fy = 0;
  tree.approximate(px, py, THETA, (dx, dy, distanceSquared, mass) => {
    let ox = dx;
    let oy = dy;
    let d2 = distanceSquared;
    if (d2 === 0) {
      // The point itself, or a node exactly on top of it. Nudge deterministically rather
      // than leaving them welded together — and rather than reaching for `Math.random`,
      // which would make the picture different on every visit.
      ox = jiggle(seed * 2 + 1);
      oy = jiggle(seed * 2 + 2);
      d2 = ox * ox + oy * oy;
    }
    // Soften the very close range: without this, a pair that happens to land a hundredth of
    // a unit apart is thrown across the picture in a single tick.
    const softened = d2 < MIN_DISTANCE_SQUARED ? Math.sqrt(MIN_DISTANCE_SQUARED * d2) : d2;
    const push = (REPULSION * alpha * mass) / softened;
    fx += ox * push;
    fy += oy * push;
  });
  out[0] = fx;
  out[1] = fy;
}

/**
 * How stiff the spring along an edge is, from the degrees of the notes it joins.
 *
 * Weakest link wins: two hubs joined by one link among hundreds are barely held together,
 * because that one link says much less about them than a link between two notes that have
 * only each other. It is the reciprocal of the *smaller* degree rather than of the larger,
 * so a leaf hanging off a hub still gets a full-strength spring — the leaf's one link is all
 * it has, and a hub is not evidence that its neighbour is unimportant.
 */
export function springStrength(sourceLinks: number, targetLinks: number): number {
  return 1 / Math.max(1, Math.min(sourceLinks, targetLinks));
}

/**
 * What share of a spring's correction the **target** end takes, in `0..1`.
 *
 * The busier end gives way less. Without this a note with four hundred backlinks is dragged
 * by four hundred springs while each of its neighbours is dragged by one, and the picture
 * collapses into a ball around it — the hub ends up wherever the sum of its springs put it
 * rather than in the middle of what points at it.
 */
export function springShare(sourceLinks: number, targetLinks: number): number {
  const total = sourceLinks + targetLinks;
  // Two nodes with no counted links at all: nothing distinguishes them, so share evenly.
  return total > 0 ? sourceLinks / total : 0.5;
}

/**
 * A tiny deterministic offset, standing in for the random one a force layout usually uses.
 *
 * Two nodes at exactly the same coordinate have no direction to separate along, so something
 * has to choose one. `Math.random` is the usual answer and it is the wrong one here: it would
 * make the same vault draw a different picture every time it was opened, and it would make
 * every test of this module flaky.
 */
export function jiggle(seed: number): number {
  const mixed = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  return (mixed / 0xffff_ffff - 0.5) * 1e-6;
}
