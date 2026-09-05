/**
 * Where the local graph's nodes sit (`SPEC.md` §9.4).
 *
 * **Concentric rings by hop, not a force simulation.** §9.4 asks for a force-directed layout
 * in a Web Worker at *global* scale, where the question is what the shape of a whole vault
 * looks like. The local graph answers a different question — how far is this from that — and
 * a ring per hop answers it directly: the distance from the centre *is* the hop count, which
 * a spring layout only approximates and never guarantees. It is also pure, deterministic and
 * costs nothing on the keystroke path, so the panel needs no worker, no animation frame and
 * no settling time (§21.2).
 *
 * The ordering around a ring is the one piece of art here: a node is placed near the
 * neighbours it already has on the ring inside it, which pulls related nodes together and
 * takes most of the crossings out — the part of a force layout that was actually earning its
 * keep. Ties break on the node key, so the same graph always draws the same picture.
 */

import type { GraphEdge, GraphNode } from "./graph.js";

/** The coordinate space the panel's `viewBox` uses. Square, so it scales with the sidebar. */
export const VIEWPORT = 200;

/** Half the viewport, kept apart because it is the origin's position and a ring's centre. */
export const CENTRE = VIEWPORT / 2;

/** Room left around the outermost ring for a node's own radius and its label. */
const MARGIN = 22;

/** A node's drawn radius, at its smallest and largest (§9.4: size by degree). */
const MIN_RADIUS = 3.5;
const MAX_RADIUS = 8;

/**
 * The largest a node's hit area may be, however much room it has.
 *
 * A drawn dot is 3–8 units across in a 200-unit picture, which on a phone is a target of a
 * few millimetres — so what a pointer or a finger actually hits is a transparent circle
 * around it, widened by `widenHitAreas` to half the distance to the nearest other node.
 * §8.3 asks for 44px targets and a dense ring cannot have them without two nodes claiming
 * the same tap; half the distance to the nearest node is the largest honest answer.
 */
const HIT_MAX = 11;

/** Where one node is drawn. */
export interface Placement {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  /** Drawn radius, from the node's degree within this graph. */
  readonly r: number;
  /** Radius of the transparent circle that actually takes the click. Never overlaps. */
  readonly hit: number;
}

export interface Layout {
  readonly places: ReadonlyMap<string, Placement>;
  /** In the order they should be drawn — the origin last, so it is never overdrawn. */
  readonly ordered: readonly Placement[];
}

/**
 * Places every node of a neighbourhood.
 *
 * Deterministic in the node and edge lists: same input, same picture, with no dependence on
 * insertion order, object identity or a random seed.
 */
export function layoutGraph(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  degrees: ReadonlyMap<string, number>,
): Layout {
  const places = new Map<string, Placement>();
  if (nodes.length === 0) return { places, ordered: [] };

  const adjacency = neighbours(edges);
  const maxDegree = Math.max(1, ...degrees.values());
  const rings = byHop(nodes);
  const outermost = Math.max(...rings.keys());
  // A single ring uses the whole radius; three rings share it. Never divide by zero: a graph
  // of one node has only ring 0, which sits at the centre anyway.
  const step = outermost === 0 ? 0 : (CENTRE - MARGIN) / outermost;
  /** The angle each placed node ended up at, so the next ring can aim at it. */
  const angles = new Map<string, number>();

  for (const hop of [...rings.keys()].sort((a, b) => a - b)) {
    const ring = rings.get(hop) ?? [];
    const ordered = orderRing(ring, adjacency, angles);
    const radius = step * hop;
    ordered.forEach((node, index) => {
      // Start at the top and go clockwise: a reader scans a ring the way they read a clock,
      // and starting at the right (angle 0) puts the first node in an arbitrary-looking spot.
      const angle = (index / ordered.length) * 2 * Math.PI - Math.PI / 2;
      angles.set(node.key, angle);
      const drawn = radiusOf(degrees.get(node.key) ?? 0, maxDegree);
      places.set(node.key, {
        key: node.key,
        x: CENTRE + radius * Math.cos(angle),
        y: CENTRE + radius * Math.sin(angle),
        r: drawn,
        // Provisional: the neighbours it has to keep clear of are not all placed yet.
        hit: drawn,
      });
    });
  }

  widenHitAreas(places);

  // Outermost first, origin last: an SVG paints in document order, so the node the panel is
  // about must be the one on top when two rings crowd.
  // The key breaks the tie: `Array.prototype.sort` is stable, so ties would otherwise keep
  // whatever order the nodes arrived in — which is the same dependence the ring ordering was
  // just fixed for, and the module's own promise above says it is not there.
  const ordered = [...nodes]
    .sort((a, b) => (b.hop === a.hop ? (a.key < b.key ? -1 : 1) : b.hop - a.hop))
    .map((node) => places.get(node.key))
    .filter((place): place is Placement => place !== undefined);
  return { places, ordered };
}

/**
 * Grows every node's hit area to half the distance to its nearest neighbour.
 *
 * Half, so two hit areas can touch but never overlap: an overlap means one tap belongs to
 * two nodes, and whichever the browser picks is the wrong one about half the time. A picture
 * of one node has no neighbour to keep clear of and gets the ceiling.
 *
 * why: no minimum. A first version floored this at the dot's radius so the hit area could
 * never be smaller than what it surrounds — and a property test found the floor reaching
 * *past* a neighbour on a crowded ring, which is exactly the overlap it exists to prevent.
 * The floor was unnecessary as well as wrong: the visible dot is a sibling in the same group
 * and takes a click on its own, so this circle only ever adds forgiveness.
 */
function widenHitAreas(places: Map<string, Placement>): void {
  const all = [...places.values()];
  for (const place of all) {
    let nearest = Number.POSITIVE_INFINITY;
    for (const other of all) {
      if (other.key === place.key) continue;
      nearest = Math.min(nearest, Math.hypot(other.x - place.x, other.y - place.y));
    }
    const room = Number.isFinite(nearest) ? nearest / 2 : HIT_MAX;
    places.set(place.key, {
      ...place,
      hit: Math.min(HIT_MAX, room),
    });
  }
}

/** A node's drawn radius, scaled by how connected it is within this picture (§9.4). */
export function radiusOf(degree: number, maxDegree: number): number {
  if (maxDegree <= 0) return MIN_RADIUS;
  // Square root, not linear: a hub with twenty edges should read as bigger than one with
  // two, without becoming twenty times the area and swallowing the ring.
  const share = Math.sqrt(Math.min(degree, maxDegree) / maxDegree);
  return MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * share;
}

function byHop(nodes: readonly GraphNode[]): Map<number, GraphNode[]> {
  const rings = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    const ring = rings.get(node.hop);
    if (ring === undefined) rings.set(node.hop, [node]);
    else ring.push(node);
  }
  return rings;
}

/** Every node each node shares an edge with, in either direction. */
function neighbours(edges: readonly GraphEdge[]): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  const join = (from: string, to: string): void => {
    const existing = adjacency.get(from);
    if (existing === undefined) adjacency.set(from, new Set([to]));
    else existing.add(to);
  };
  for (const edge of edges) {
    join(edge.source, edge.target);
    join(edge.target, edge.source);
  }
  return adjacency;
}

/**
 * Orders one ring so each node sits near the neighbours already placed inside it.
 *
 * The anchor is the *circular* mean of those angles — summing unit vectors rather than
 * numbers, because 350° and 10° average to 0°, not to 180°, and a node between two
 * neighbours either side of the top belongs at the top.
 *
 * A node with no placed neighbour keeps a stable place at the start of the ring; that cannot
 * happen for a graph the server built, where a node at hop *n* is adjacent to one at *n-1* by
 * construction, but a picture assembled from something else should still draw.
 */
function orderRing(
  ring: readonly GraphNode[],
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
  angles: ReadonlyMap<string, number>,
): readonly GraphNode[] {
  const anchors = new Map<string, number>();
  for (const node of ring) {
    let x = 0;
    let y = 0;
    let found = 0;
    // why: sorted. Floating-point addition is not associative, so summing these unit vectors
    // in the order the edges happened to arrive gives a slightly different angle for the same
    // graph — enough to flip a near-tie in the sort below and redraw the whole ring. A
    // property test comparing a graph against its own reverse is what found that.
    for (const neighbour of [...(adjacency.get(node.key) ?? [])].sort()) {
      const angle = angles.get(neighbour);
      if (angle === undefined) continue;
      x += Math.cos(angle);
      y += Math.sin(angle);
      found += 1;
    }
    // Two neighbours exactly opposite each other sum to no direction at all, and
    // `Math.atan2(0, 0)` is 0 rather than NaN — due east, which is as good an aim as any
    // when the graph has not expressed a preference.
    if (found === 0) continue;
    anchors.set(node.key, Math.atan2(y, x));
  }
  return [...ring].sort((a, b) => {
    const left = anchors.get(a.key);
    const right = anchors.get(b.key);
    if (left === undefined && right === undefined) return a.key < b.key ? -1 : 1;
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left !== right) return left - right;
    return a.key < b.key ? -1 : 1;
  });
}

/**
 * Which side of a node its label hangs off.
 *
 * A label centred on a node near the edge of the picture runs out of it; anchoring it
 * inwards keeps it inside the `viewBox` without measuring text. The band in the middle stays
 * centred, because a label pushed sideways under the origin reads as belonging to something
 * else.
 */
export function labelAnchor(x: number): "start" | "middle" | "end" {
  const bias = VIEWPORT / 5;
  if (x > CENTRE + bias) return "end";
  if (x < CENTRE - bias) return "start";
  return "middle";
}
