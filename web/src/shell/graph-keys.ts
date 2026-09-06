/**
 * What a keypress means inside the global graph (`SPEC.md` §8.4, §9.4).
 *
 * §8.4 does not allow a mouse-only feature, and a picture of ten thousand nodes cannot be
 * ten thousand tab stops — the local graph, the note tree and the tag pane all answer that
 * with one tab stop and arrow keys, and so does this. The difference is what an arrow
 * *means*: in a list it is the next row, and in a picture it is **the nearest node that way**,
 * because a list order over a force layout is an order nobody can see.
 *
 * Here rather than in the component so it is testable without mounting anything, exactly as
 * `graphKeyAction` is for the local graph.
 */

/** What a key does to the graph. */
export type GraphAction =
  | { readonly kind: "none" }
  | { readonly kind: "select"; readonly to: number }
  | { readonly kind: "open" }
  | { readonly kind: "zoom"; readonly factor: number }
  | { readonly kind: "fit" };

/** How much one press of `+` or `-` zooms. */
export const KEY_ZOOM = 1.4;

/**
 * The node nearest `from` in the direction `(dx, dy)`, or `-1` when there is none.
 *
 * "In the direction" is a cone rather than a half-plane: a node directly above and one far
 * off to the side are both "up" by a half-plane test, and the second is not what anyone
 * pressing Up means. Within the cone the nearest wins, so repeated presses walk the picture
 * rather than jumping across it.
 *
 * Ties go to the lower index, so the same keypress always moves to the same node.
 */
export function nearestInDirection(
  x: Float32Array,
  y: Float32Array,
  count: number,
  from: number,
  dx: number,
  dy: number,
): number {
  if (from < 0 || from >= count) return -1;
  const ox = x[from] ?? 0;
  const oy = y[from] ?? 0;
  let best = -1;
  let bestDistance = Infinity;
  for (let at = 0; at < count; at += 1) {
    if (at === from) continue;
    const vx = (x[at] ?? 0) - ox;
    const vy = (y[at] ?? 0) - oy;
    const along = vx * dx + vy * dy;
    if (along <= 0) continue;
    const across = Math.abs(vx * dy - vy * dx);
    // A 45° cone either side: `across <= along` is exactly that, and it is the widest cone
    // in which the four arrows do not overlap.
    if (across > along) continue;
    const distance = vx * vx + vy * vy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = at;
    }
  }
  return best;
}

/**
 * What `key` does, given a picture of `count` nodes with `selected` picked.
 *
 * The arrows need the positions, so this takes them; everything else is a decision about the
 * key alone. Returning an action rather than acting keeps the component free of behaviour
 * and this file free of the DOM.
 */
export function graphKeyAction(
  key: string,
  x: Float32Array,
  y: Float32Array,
  count: number,
  selected: number,
): GraphAction {
  if (count === 0) return { kind: "none" };
  switch (key) {
    case "ArrowUp":
    case "ArrowDown":
    case "ArrowLeft":
    case "ArrowRight": {
      // Nothing picked yet: the first arrow picks something rather than doing nothing, which
      // is how a keyboard user gets into the picture at all.
      if (selected < 0 || selected >= count) return { kind: "select", to: 0 };
      const direction = DIRECTIONS[key] ?? [0, 0];
      const to = nearestInDirection(x, y, count, selected, direction[0], direction[1]);
      return to === -1 ? { kind: "none" } : { kind: "select", to };
    }
    case "Home":
      return { kind: "select", to: 0 };
    case "End":
      return { kind: "select", to: count - 1 };
    case "Enter":
    case " ":
      return selected >= 0 && selected < count ? { kind: "open" } : { kind: "none" };
    case "+":
    case "=":
      return { kind: "zoom", factor: KEY_ZOOM };
    case "-":
    case "_":
      return { kind: "zoom", factor: 1 / KEY_ZOOM };
    case "0":
      return { kind: "fit" };
    default:
      return { kind: "none" };
  }
}

/** Screen directions: `y` grows downwards, so Up is negative. */
const DIRECTIONS: Record<string, readonly [number, number]> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
};
