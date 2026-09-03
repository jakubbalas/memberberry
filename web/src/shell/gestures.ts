/**
 * Edge-swipe recognition for the mobile drawers (`SPEC.md` §8.3).
 *
 * "Sidebars become swipe-in drawers" is one sentence in the spec and a pile of judgement in
 * practice, because the surface being swiped over is a **text editor**. Every rule here
 * exists to keep a gesture from stealing a selection drag:
 *
 * - It must **start within `edgeWidth` of the screen edge**, where there is no text to select.
 * - It must be **clearly horizontal** — more sideways than vertical by `dominance` — so a
 *   scroll is never mistaken for a swipe.
 * - It must travel at least `threshold`, so a tap with a shaky thumb is not a swipe.
 * - It must be **a single touch**. A second finger means a pinch or a system gesture.
 *
 * Kept as a pure recognizer over pointer coordinates rather than a component behaviour, so
 * the rules can be tested exhaustively without a browser or a real finger.
 */

/** Which edge a swipe came from, and therefore which drawer it opens. */
export type SwipeEdge = "left" | "right";

export interface SwipeOptions {
  /** How close to the edge a swipe must start, in CSS pixels. Defaults to 24. */
  readonly edgeWidth?: number;
  /** How far it must travel to count. Defaults to 48. */
  readonly threshold?: number;
  /** How much more horizontal than vertical it must be. Defaults to 1.5. */
  readonly dominance?: number;
  /** The viewport width, so the right edge can be located. */
  readonly width: number;
}

export interface SwipeStart {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly edge: SwipeEdge;
}

const DEFAULTS = { edgeWidth: 24, threshold: 48, dominance: 1.5 } as const;

/**
 * Whether a pointer going down starts a candidate edge swipe.
 *
 * `undefined` for anything that is not one — including a mouse, which has no business
 * opening a drawer by dragging, and would otherwise make text selection near the window
 * edge unpredictable on a small desktop window.
 */
export function swipeStart(
  event: Pick<PointerEvent, "pointerId" | "clientX" | "clientY" | "pointerType" | "isPrimary">,
  options: SwipeOptions,
): SwipeStart | undefined {
  if (event.pointerType !== "touch" || !event.isPrimary) return undefined;
  const edgeWidth = options.edgeWidth ?? DEFAULTS.edgeWidth;
  const edge: SwipeEdge | undefined =
    event.clientX <= edgeWidth
      ? "left"
      : event.clientX >= options.width - edgeWidth
        ? "right"
        : undefined;
  if (edge === undefined) return undefined;
  return { pointerId: event.pointerId, x: event.clientX, y: event.clientY, edge };
}

/** How a swipe in progress has resolved. */
export type SwipeResult =
  | { readonly kind: "pending" }
  /** Travelled far enough, in the direction that opens `edge`'s drawer. */
  | { readonly kind: "open"; readonly edge: SwipeEdge }
  /** Abandoned: too vertical, or heading the wrong way. */
  | { readonly kind: "cancelled" };

/**
 * Resolves a moving pointer against the swipe that started it.
 *
 * A swipe *inward* from an edge opens that edge's drawer. Outward is not a gesture — it is
 * how a drawer is dismissed, which the drawer itself handles.
 */
export function swipeProgress(
  start: SwipeStart,
  event: Pick<PointerEvent, "pointerId" | "clientX" | "clientY">,
  options: SwipeOptions,
): SwipeResult {
  if (event.pointerId !== start.pointerId) return { kind: "pending" };
  const threshold = options.threshold ?? DEFAULTS.threshold;
  const dominance = options.dominance ?? DEFAULTS.dominance;

  const dx = event.clientX - start.x;
  const dy = Math.abs(event.clientY - start.y);
  const distance = Math.abs(dx);

  // Vertical first: a scroll that happens to begin near the edge must never become a swipe,
  // and it is far more common than the gesture itself.
  if (dy > threshold && dy * dominance > distance) return { kind: "cancelled" };
  if (distance < threshold) return { kind: "pending" };
  if (distance < dy * dominance) return { kind: "pending" };

  const inward = start.edge === "left" ? dx > 0 : dx < 0;
  return inward ? { kind: "open", edge: start.edge } : { kind: "cancelled" };
}
