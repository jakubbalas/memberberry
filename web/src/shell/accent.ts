/**
 * A vault's accent colour, kept readable in every palette (`SPEC.md` §20.1, §20.3).
 *
 * The owner picks one colour, but `--accent-primary` is also link and label text on the
 * note surface, which is near-white in Paper and near-black in Charcoal. No single colour
 * reads on both, so the chosen hue and saturation are kept and only its lightness moves —
 * away from the surface, one step at a time — until it clears WCAG AA (4.5:1). A colour
 * that already passes is used exactly as chosen.
 *
 * Pure apart from `applyAccent`, which only writes two custom properties.
 */

/** The minimum text contrast `--accent-primary` must keep against `--surface-note`. */
export const ACCENT_MIN_CONTRAST = 4.5;

const HEX = /^#[0-9a-f]{6}$/;

/** Narrows untrusted input to a lowercase `#rrggbb` accent, the only form the server stores. */
export function parseAccent(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const lower = value.toLowerCase();
  return HEX.test(lower) ? lower : undefined;
}

interface Rgb { readonly r: number; readonly g: number; readonly b: number }

function rgbOf(hex: string): Rgb | undefined {
  const parsed = parseAccent(hex.trim());
  if (parsed === undefined) return undefined;
  return {
    r: Number.parseInt(parsed.slice(1, 3), 16),
    g: Number.parseInt(parsed.slice(3, 5), 16),
    b: Number.parseInt(parsed.slice(5, 7), 16),
  };
}

function hexOf({ r, g, b }: Rgb): string {
  const part = (value: number): string => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

function luminance({ r, g, b }: Rgb): number {
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.039_28 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two `#rrggbb` colours; `undefined` when either is not one. */
export function contrastRatio(first: string, second: string): number | undefined {
  const a = rgbOf(first);
  const b = rgbOf(second);
  if (a === undefined || b === undefined) return undefined;
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

interface Hsl { readonly h: number; readonly s: number; readonly l: number }

function hslOf({ r, g, b }: Rgb): Hsl {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return { h: h / 6, s, l };
}

function rgbOfHsl({ h, s, l }: Hsl): Rgb {
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t0: number): number => {
    const t = t0 < 0 ? t0 + 1 : t0 > 1 ? t0 - 1 : t0;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return { r: hue(h + 1 / 3) * 255, g: hue(h) * 255, b: hue(h - 1 / 3) * 255 };
}

/**
 * The accent to paint on `surface`: `accent` itself when it is readable there, otherwise
 * the same hue moved lighter or darker until it is. `undefined` for malformed input.
 *
 * Always terminates with a readable colour for any real surface: the walk ends at black or
 * white, and one of the two clears 4.5:1 against every colour.
 */
export function readableAccent(accent: string, surface: string, minimum = ACCENT_MIN_CONTRAST): string | undefined {
  const chosen = rgbOf(accent);
  const ground = rgbOf(surface);
  if (chosen === undefined || ground === undefined) return undefined;
  const canonical = hexOf(chosen);
  if ((contrastRatio(canonical, hexOf(ground)) ?? 0) >= minimum) return canonical;
  const hsl = hslOf(chosen);
  // why: move away from the surface. Against a dark surface, lighter text gains contrast.
  const direction = luminance(ground) > 0.18 ? -1 : 1;
  for (let step = 1; step <= 100; step += 1) {
    const l = Math.min(1, Math.max(0, hsl.l + direction * step / 100));
    const candidate = hexOf(rgbOfHsl({ ...hsl, l }));
    if ((contrastRatio(candidate, hexOf(ground)) ?? 0) >= minimum) return candidate;
  }
  const extreme = direction < 0 ? 0 : 255;
  return hexOf({ r: extreme, g: extreme, b: extreme });
}

/** The two properties an accent re-declares. The focus ring follows it, as in every theme. */
const ACCENT_PROPERTIES = ["--accent-primary", "--focus-ring"] as const;

/**
 * Re-declares the accent on `root` for whichever palette is active now, or removes the
 * override. Must run after the theme attribute changes: it reads the resulting surface.
 */
export function applyAccent(root: HTMLElement, accent: string | undefined): void {
  for (const property of ACCENT_PROPERTIES) root.style.removeProperty(property);
  if (accent === undefined) return;
  const surface = getComputedStyle(root).getPropertyValue("--surface-note").trim();
  const painted = readableAccent(accent, surface);
  if (painted === undefined) return;
  for (const property of ACCENT_PROPERTIES) root.style.setProperty(property, painted);
}
