/**
 * Where the global graph is looked at from (`SPEC.md` §9.4).
 *
 * Pan, zoom, and the level-of-detail decisions that hang off the zoom: §9.4 asks for labels
 * and icons only *above a zoom threshold*, which is what keeps ten thousand nodes from
 * becoming ten thousand pieces of text nobody can read. All of it is pure arithmetic on
 * plain numbers, so the part of the renderer that decides what a reader sees is testable
 * without a canvas — which matters here more than usual, because jsdom has no WebGL at all
 * and everything below `graph-gl.ts` can only be exercised in a real browser.
 *
 * The camera is a **world point at the centre of the viewport plus a scale**, rather than a
 * matrix: those three numbers are what a control changes, what a test can read, and what a
 * saved view would have to store.
 */

/** The size of a node's dot at scale 1, in world units. */
const BASE_RADIUS = 3;

/** How much bigger the busiest node in a vault may be drawn than the quietest. */
const SIZE_RANGE = 3.5;

/** Below this scale, a label is smaller than it is legible and there are too many of them. */
export const LABEL_SCALE = 0.55;

/** The most labels drawn at once, however far in a reader zooms. */
export const MAX_LABELS = 160;

/** How far out and in a reader may zoom. */
export const MIN_SCALE = 0.02;
export const MAX_SCALE = 8;

export interface Camera {
  /** The world coordinate sitting at the centre of the viewport. */
  readonly x: number;
  readonly y: number;
  /** Screen pixels per world unit. */
  readonly scale: number;
}

export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** What a node's size is taken from — §9.4 offers both. */
export type SizeBy = "degree" | "words";

export const ORIGIN: Camera = { x: 0, y: 0, scale: 1 };

/** The box every node sits in, or a unit box when there are none to measure. */
export function boundsOf(x: Float32Array, y: Float32Array, count: number): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count; i += 1) {
    const px = x[i] ?? 0;
    const py = y[i] ?? 0;
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  if (minX > maxX) return { minX: -1, minY: -1, maxX: 1, maxY: 1 };
  return { minX, minY, maxX, maxY };
}

/**
 * The camera that frames `bounds` inside a viewport, with room around the edge.
 *
 * `padding` is a fraction of the smaller side, so the margin looks the same on a phone and
 * on a wide desktop pane rather than being a pixel count that swallows one of them.
 */
export function fitCamera(
  bounds: Bounds,
  width: number,
  height: number,
  padding = 0.08,
): Camera {
  const x = (bounds.minX + bounds.maxX) / 2;
  const y = (bounds.minY + bounds.maxY) / 2;
  if (!(width > 0) || !(height > 0)) return { x, y, scale: 1 };
  // A single node has no extent, and a row of them has none on one axis; either way the
  // scale would be infinite, so fall back to something a reader can see.
  const spanX = Math.max(bounds.maxX - bounds.minX, 1e-6);
  const spanY = Math.max(bounds.maxY - bounds.minY, 1e-6);
  const room = 1 - 2 * Math.min(Math.max(padding, 0), 0.45);
  const scale = Math.min((width * room) / spanX, (height * room) / spanY);
  return { x, y, scale: clampScale(scale) };
}

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** Where a world point lands on screen, in CSS pixels from the viewport's top left. */
export function worldToScreen(
  camera: Camera,
  width: number,
  height: number,
  wx: number,
  wy: number,
): { x: number; y: number } {
  return {
    x: width / 2 + (wx - camera.x) * camera.scale,
    y: height / 2 + (wy - camera.y) * camera.scale,
  };
}

/** The inverse: what a reader is pointing at. */
export function screenToWorld(
  camera: Camera,
  width: number,
  height: number,
  sx: number,
  sy: number,
): { x: number; y: number } {
  return {
    x: camera.x + (sx - width / 2) / camera.scale,
    y: camera.y + (sy - height / 2) / camera.scale,
  };
}

/** Slides the camera by a drag measured in screen pixels. */
export function panBy(camera: Camera, dx: number, dy: number): Camera {
  return { ...camera, x: camera.x - dx / camera.scale, y: camera.y - dy / camera.scale };
}

/**
 * Zooms by `factor` about a point on screen.
 *
 * The world point under the cursor stays under the cursor, which is what makes a wheel over
 * a graph feel like a magnifying glass rather than a slider — and what makes a pinch on a
 * phone land where the fingers are.
 */
export function zoomAt(
  camera: Camera,
  width: number,
  height: number,
  sx: number,
  sy: number,
  factor: number,
): Camera {
  const scale = clampScale(camera.scale * (Number.isFinite(factor) && factor > 0 ? factor : 1));
  const anchor = screenToWorld(camera, width, height, sx, sy);
  // Solve for the centre that keeps `anchor` under `(sx, sy)` at the new scale.
  return {
    scale,
    x: anchor.x - (sx - width / 2) / scale,
    y: anchor.y - (sy - height / 2) / scale,
  };
}

/** The world rectangle currently on screen, widened by `margin` world units. */
export function visibleBounds(
  camera: Camera,
  width: number,
  height: number,
  margin = 0,
): Bounds {
  const halfX = width / 2 / camera.scale + margin;
  const halfY = height / 2 / camera.scale + margin;
  return {
    minX: camera.x - halfX,
    minY: camera.y - halfY,
    maxX: camera.x + halfX,
    maxY: camera.y + halfY,
  };
}

/** Whether §9.4's zoom threshold for labels and icons has been crossed. */
export function labelsVisible(camera: Camera): boolean {
  return camera.scale >= LABEL_SCALE;
}

/**
 * A node's radius in world units, from whichever measure §9.4's control is set to.
 *
 * `largest` is the biggest value in the picture, so the scale is relative to the vault
 * rather than absolute: a vault whose busiest note has six links should still show that note
 * as its hub. The square root is what keeps a note with four hundred links from being a disc
 * the size of a folder — area, not radius, carries the number.
 */
export function nodeRadius(value: number, largest: number, sizeBy: SizeBy): number {
  const top = Math.max(largest, 1);
  const share = Math.min(Math.max(value, 0), top) / top;
  // why: `words` is far more skewed than `degree` — a vault has notes of ten words and of
  // ten thousand — so it is compressed harder. Both end at the same maximum, so a reader
  // switching the control sees the same picture resized rather than a different one.
  const eased = sizeBy === "words" ? Math.cbrt(share) : Math.sqrt(share);
  return BASE_RADIUS * (1 + (SIZE_RANGE - 1) * eased);
}

/**
 * Which nodes to draw a label for: the biggest ones that are actually on screen (§9.4).
 *
 * Nothing off screen, never more than [`MAX_LABELS`], and nothing at all below the zoom
 * threshold. The order is by size and then by index, so the labels that appear as a reader
 * zooms in are stable rather than shuffling with each frame.
 */
export function labelledNodes(
  camera: Camera,
  width: number,
  height: number,
  x: Float32Array,
  y: Float32Array,
  weight: Float32Array,
  count: number,
): number[] {
  if (!labelsVisible(camera)) return [];
  const view = visibleBounds(camera, width, height);
  const shown: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const px = x[i] ?? 0;
    const py = y[i] ?? 0;
    if (px < view.minX || px > view.maxX || py < view.minY || py > view.maxY) continue;
    shown.push(i);
  }
  // why: no tie-break on the index. `shown` is built in index order and `Array.sort` is
  // stable, so two nodes of the same size already keep it — an explicit tie-break here was
  // written first and no test could tell it from its absence.
  shown.sort((a, b) => (weight[b] ?? 0) - (weight[a] ?? 0));
  return shown.slice(0, MAX_LABELS);
}
