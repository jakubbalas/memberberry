/**
 * Which of the two layouts the viewport gets (`SPEC.md` §8.2, §8.3).
 *
 * One state model, two layouts. This module is the only place that decides which, so the
 * breakpoints exist once rather than being repeated in every component and every media query
 * that has to agree with them.
 *
 * Plain TypeScript with an injectable matcher, so the decision is testable without a browser
 * and the components stay presentational (`AGENTS.md` §4.4).
 */

/** The three widths §8 distinguishes. */
export type LayoutMode = "mobile" | "tablet" | "desktop";

/**
 * §8.2 puts the desktop layout at ≥ 1024px and §8.3 the mobile one below 768px; the band
 * between is tablet, which gets the desktop layout with at most one split.
 *
 * Both are *inclusive lower bounds*, which is what the spec says and what the comparisons
 * below implement. The separate `MOBILE_MAX_WIDTH` exists only because a `max-width` media
 * query needs a value just under the boundary — conflating the two put 767.99px in the
 * tablet layout, which the boundary test caught.
 */
export const TABLET_MIN_WIDTH = 768;
export const DESKTOP_MIN_WIDTH = 1024;

/** The largest width a `max-width` query can name and still mean "below 768". */
export const MOBILE_MAX_WIDTH = TABLET_MIN_WIDTH - 0.02;

/** The media queries the layouts answer to. Shared with `app.css`, which must agree. */
export const MOBILE_QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`;
export const DESKTOP_QUERY = `(min-width: ${DESKTOP_MIN_WIDTH}px)`;

/** The mode for a viewport width, in CSS pixels. */
export function layoutModeForWidth(width: number): LayoutMode {
  if (width < TABLET_MIN_WIDTH) return "mobile";
  if (width < DESKTOP_MIN_WIDTH) return "tablet";
  return "desktop";
}

/**
 * How many splits a mode permits.
 *
 * §8.3: "Tablet (768–1024px) gets desktop layout with at most one split." Mobile renders a
 * single leaf, so a split there would be invisible — and an invisible pane holding an editor
 * is a memory cost with nothing to show for it.
 */
export function splitLimitFor(mode: LayoutMode): number {
  switch (mode) {
    case "mobile":
      return 0;
    case "tablet":
      return 1;
    case "desktop":
      return Number.POSITIVE_INFINITY;
  }
}

/**
 * The layout mode right now, read synchronously.
 *
 * why: `watchLayoutMode` reports through a callback that a Svelte `$effect` only receives
 * *after* mount, so a component initialising state from it starts on the default. On a phone
 * that meant the sidebars took their desktop default — open — and covered the note until
 * something else re-rendered. Nothing in the unit suite could see it; every mobile E2E test
 * failed to click anything.
 */
export function currentLayoutMode(match?: (query: string) => MediaMatcher): LayoutMode {
  const matcher = match ?? matchMediaOrUndefined();
  if (matcher === undefined) return "desktop";
  if (matcher(MOBILE_QUERY).matches) return "mobile";
  return matcher(DESKTOP_QUERY).matches ? "desktop" : "tablet";
}

/** The subset of `MediaQueryList` this module uses, so a test can supply one. */
export interface MediaMatcher {
  matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

export interface WatchLayoutOptions {
  /** Defaults to `window.matchMedia`. */
  readonly match?: (query: string) => MediaMatcher;
  readonly onChange: (mode: LayoutMode) => void;
}

/**
 * Reports the layout mode now, and again whenever it changes.
 *
 * Returns a teardown. Two queries rather than a resize listener: a media query fires only
 * when the answer actually changes, where `resize` fires on every pixel — and on mobile it
 * also fires when the virtual keyboard opens, which is not a layout change (§8.3).
 */
export function watchLayoutMode(options: WatchLayoutOptions): () => void {
  const match = options.match ?? matchMediaOrUndefined();
  if (match === undefined) {
    // No `matchMedia`: server-side rendering, or a test environment without one. Desktop is
    // the safe default — it renders the whole tree, so nothing is hidden.
    options.onChange("desktop");
    return () => undefined;
  }

  const mobile = match(MOBILE_QUERY);
  const desktop = match(DESKTOP_QUERY);
  const report = (): void => {
    options.onChange(mobile.matches ? "mobile" : desktop.matches ? "desktop" : "tablet");
  };

  mobile.addEventListener("change", report);
  desktop.addEventListener("change", report);
  report();

  return () => {
    mobile.removeEventListener("change", report);
    desktop.removeEventListener("change", report);
  };
}

function matchMediaOrUndefined(): ((query: string) => MediaMatcher) | undefined {
  if (typeof matchMedia !== "function") return undefined;
  return (query: string) => matchMedia(query);
}
