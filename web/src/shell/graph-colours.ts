/**
 * The graph's colours, read from the design tokens (`SPEC.md` §20).
 *
 * Its own module because it is the one part of the renderer that is a *decision* rather than
 * a WebGL call: which token a node's colour comes from, and what to do with a value that is
 * not a colour. `graph-gl.ts` beside it cannot be tested outside a browser and is excluded
 * from the coverage floors for that reason; this can be, and is.
 *
 * A hard-coded colour is a bug (`AGENTS.md` §4.4). The graph shares `--series-0`…`--series-5`
 * with presence, for the reason §20.1 records: two features inventing two categorical
 * palettes is how one screen ends up with two of them.
 */

/** An `r, g, b` triple in `0..1`, which is what a shader wants. */
export type Rgb = readonly [number, number, number];

/** How many colours the categorical series holds (§20.1). */
export const SERIES_COLOURS = 6;

export interface GraphColours {
  /** One per folder, cycled — the same series presence uses (§20.1). */
  readonly series: readonly Rgb[];
  /** A resolved link. */
  readonly link: Rgb;
  /** A transclusion, so §9.4's "link vs embed" is visible and not only filterable. */
  readonly embed: Rgb;
  /** An unresolved link's node, drawn hollow. */
  readonly ghost: Rgb;
  /** The ring around the node under the pointer or the cursor. */
  readonly highlight: Rgb;
}

/** What the renderer falls back to when a token is missing: legible, and obviously wrong. */
const FALLBACK: Rgb = [0.5, 0.5, 0.5];

/**
 * Reads a CSS colour into a shader triple.
 *
 * Handles `#rgb`, `#rrggbb` and `rgb()`/`rgba()`, which is every form the token file and a
 * browser's computed style produce. Anything else answers `undefined` rather than a guess —
 * a wrong colour that looks deliberate is harder to notice than a grey one.
 */
export function parseColour(text: string): Rgb | undefined {
  const value = text.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex !== null) {
    const digits = hex[1] ?? "";
    const wide = digits.length === 6;
    const part = (at: number): number => {
      const slice = wide ? digits.slice(at * 2, at * 2 + 2) : (digits[at] ?? "0").repeat(2);
      return Number.parseInt(slice, 16) / 255;
    };
    return [part(0), part(1), part(2)];
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(value);
  if (rgb !== null) {
    const parts = (rgb[1] ?? "")
      .split(/[\s,/]+/)
      .filter((piece) => piece !== "")
      .map((piece) => Number.parseFloat(piece));
    const [r, g, b] = parts;
    if (r === undefined || g === undefined || b === undefined) return undefined;
    if (![r, g, b].every((channel) => Number.isFinite(channel))) return undefined;
    return [r / 255, g / 255, b / 255];
  }
  return undefined;
}

/** The graph's palette, taken from the tokens in scope at `element` (§20). */
export function readColours(element: Element): GraphColours {
  const style = getComputedStyle(element);
  const token = (name: string): Rgb => parseColour(style.getPropertyValue(name)) ?? FALLBACK;
  return {
    series: Array.from({ length: SERIES_COLOURS }, (_, at) => token(`--series-${at}`)),
    link: token("--text-muted"),
    embed: token("--accent-primary"),
    ghost: token("--text-muted"),
    highlight: token("--accent-primary"),
  };
}

