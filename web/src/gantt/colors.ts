/**
 * Task colours for Gantt charts (SPEC §13.3, A40).
 *
 * Mermaid has no per-task colour, so a colour is a comment line Mermaid ignores:
 * `%% color <task id> <value>`. The value is one of the note colours (§20.1), which follow the
 * theme, or any `#rgb` / `#rrggbb` hex. Anything else is left alone and ignored.
 *
 * Shared by the note view (always loaded) and the visual editor (lazy), so it stays tiny and
 * imports nothing.
 */

/** The note colours, in the order the picker offers them. */
export const NOTE_COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

/**
 * A task or phase colour. `none` is an explicit "no colour": a plain, neutral bar or phase,
 * rather than the automatic phase colour a task or phase has without a colour line.
 */
export type TaskColor =
  | { readonly kind: "note"; readonly name: NoteColor }
  | { readonly kind: "hex"; readonly hex: string }
  | { readonly kind: "none" };

/** A colour line: `%% color <id> <value>`, nothing else on it. */
export const COLOR_LINE = /^\s*%%\s*color\s+([A-Za-z_][A-Za-z0-9_-]*)\s+(\S+)\s*$/iu;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu;

/** A valid colour value, or `null`. Strict, because the value ends up in a style attribute. */
export function parseColor(value: string): TaskColor | null {
  const text = value.trim();
  if (HEX.test(text)) return { kind: "hex", hex: text.toLowerCase() };
  const name = text.toLowerCase();
  if (name === "none") return { kind: "none" };
  return (NOTE_COLORS as readonly string[]).includes(name) ? { kind: "note", name: name as NoteColor } : null;
}

/** How a colour is written back: a note colour's name, or lower-case hex. */
export function colorText(color: TaskColor): string {
  return color.kind === "note" ? color.name : color.kind === "hex" ? color.hex : "none";
}

/** Task id → colour, from the colour lines of a Mermaid source. A later line for an id wins. */
export function taskColors(source: string): ReadonlyMap<string, TaskColor> {
  const colors = new Map<string, TaskColor>();
  for (const line of source.split("\n")) {
    const match = COLOR_LINE.exec(line);
    const color = match === null ? null : parseColor(match[2] ?? "");
    if (match !== null && color !== null) colors.set(match[1] ?? "", color);
  }
  return colors;
}

/**
 * Fill and outline for a coloured bar.
 *
 * why: a note colour uses its own theme tokens. A hex colour outlines in exactly that colour
 * and fills with a light mix of it, so task names (drawn in the text colour) stay readable in
 * light and dark themes whatever was picked.
 */
export function colorStyle(color: TaskColor): { readonly fill: string; readonly stroke: string } {
  if (color.kind === "note") return NOTE_STYLE[color.name];
  if (color.kind === "none") return NEUTRAL;
  return { fill: `color-mix(in srgb, ${color.hex} 35%, var(--surface-note))`, stroke: color.hex };
}

// why: spelled out rather than built from the name, so the token check can see every token
// (it reads literal `var(--…)` names, and a key beside `fill:` would read as a colour literal).
const pair = (fill: string, stroke: string) => ({ fill, stroke });
/** No colour: a plain bar in the surface and muted ink. */
const NEUTRAL = pair("var(--surface-raised)", "var(--text-muted)");
const NOTE_STYLE: Readonly<Record<NoteColor, { readonly fill: string; readonly stroke: string }>> = {
  gray: pair("var(--note-background-gray)", "var(--note-color-gray)"),
  brown: pair("var(--note-background-brown)", "var(--note-color-brown)"),
  orange: pair("var(--note-background-orange)", "var(--note-color-orange)"),
  yellow: pair("var(--note-background-yellow)", "var(--note-color-yellow)"),
  green: pair("var(--note-background-green)", "var(--note-color-green)"),
  blue: pair("var(--note-background-blue)", "var(--note-color-blue)"),
  purple: pair("var(--note-background-purple)", "var(--note-color-purple)"),
  pink: pair("var(--note-background-pink)", "var(--note-color-pink)"),
  red: pair("var(--note-background-red)", "var(--note-color-red)"),
};

/** The colour as a full `#rrggbb`, for an `<input type="color">`. */
export function longHex(hex: string): string {
  return hex.length === 4 ? `#${[...hex.slice(1)].map((digit) => digit + digit).join("")}` : hex;
}

/** A phase colour line: `%% section-color <value> <phase name>`; the name runs to the line's end. */
export const SECTION_COLOR_LINE = /^\s*%%\s*section-color\s+(\S+)\s+(.+?)\s*$/iu;

/** Phase name → colour, from a Mermaid source's phase colour lines. A later line wins. */
export function sectionColors(source: string): ReadonlyMap<string, TaskColor> {
  const colors = new Map<string, TaskColor>();
  for (const line of source.split("\n")) {
    const match = SECTION_COLOR_LINE.exec(line);
    const color = match === null ? null : parseColor(match[1] ?? "");
    if (match !== null && color !== null) colors.set(match[2] ?? "", color);
  }
  return colors;
}

/**
 * The automatic phase colours, in order (SPEC §13.2). Mermaid numbers phases 0..n-1 and wraps
 * after the last. Spelled out so the token check can see them; red (series-0) last, so the
 * first phase does not read as an alarm beside critical tasks.
 */
export const PHASE_COLOURS = ["var(--series-2)", "var(--series-1)", "var(--series-4)", "var(--series-3)", "var(--series-5)", "var(--series-0)"] as const;

/** The one colour a phase is drawn in: a note colour's ink, or the hex itself. */
export function colorHue(color: TaskColor): string {
  return color.kind === "note" ? NOTE_STYLE[color.name].stroke : color.kind === "hex" ? color.hex : NEUTRAL.stroke;
}

/** A light mix of a colour into the note surface, for fills text stays readable on. */
export function tint(colour: string, percent: number): string {
  return `color-mix(in srgb, ${colour} ${String(percent)}%, var(--surface-note))`;
}

const DIRECTIVE = /^(gantt|title|dateFormat|axisFormat|tickInterval|excludes|includes|todayMarker|inclusiveEndDates|topAxis|weekday|weekend|accTitle|accDescr|displayMode|click|call)\b/iu;

/**
 * The phases Mermaid draws, in its order: one per phase that has a task, named, or `null` for
 * tasks above the first `section`. Mermaid numbers its phase styles in this order, and leaves
 * out a phase with no tasks.
 */
export function drawnPhases(source: string): readonly (string | null)[] {
  const order: (string | null)[] = [];
  let current: string | null = null;
  let started = false;
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!started) { started = /^gantt\b/iu.test(line); continue; }
    if (line === "" || line.startsWith("%%") || DIRECTIVE.test(line)) continue;
    const section = /^section\s+(.+)$/iu.exec(line);
    if (section !== null) { current = (section[1] ?? "").trim(); continue; }
    if (line.includes(":") && !order.includes(current)) order.push(current);
  }
  return order;
}

/** Chart-wide style settings (SPEC §13.3), each a `%% option <key> <value>` line. */
export interface ChartOptions {
  /** Phase names in a left column (Mermaid's way), or as a header row above each phase. */
  readonly phases: "column" | "row";
  /** A phase's colour fills its whole band, or only its name (column or header row). */
  readonly phaseFill: "whole" | "name";
  /** Row height: the standard one, or taller rows with larger text. */
  readonly rows: "fixed" | "zoomed";
  /** How tall the chart may be in a note before it scrolls: its full height, or a cap. */
  readonly height: "full" | "small" | "medium" | "large";
}

export const DEFAULT_OPTIONS: ChartOptions = { phases: "column", phaseFill: "whole", rows: "fixed", height: "full" };

/** Each option: its key in the text, and the values it accepts (the first is the default). */
export const OPTION_KEYS = {
  phases: { key: "phases", values: ["column", "row"] },
  phaseFill: { key: "phase-fill", values: ["whole", "name"] },
  rows: { key: "rows", values: ["fixed", "zoomed"] },
  height: { key: "max-height", values: ["full", "small", "medium", "large"] },
} as const;

export const OPTION_LINE = /^\s*%%\s*option\s+(\S+)\s+(\S+)\s*$/iu;

/** The chart's options, from its option lines; unknown keys and values are ignored. */
export function chartOptions(source: string): ChartOptions {
  const options: { -readonly [K in keyof ChartOptions]: ChartOptions[K] } = { ...DEFAULT_OPTIONS };
  for (const line of source.split("\n")) {
    const match = OPTION_LINE.exec(line);
    if (match === null) continue;
    const key = (match[1] ?? "").toLowerCase();
    const value = (match[2] ?? "").toLowerCase();
    if (key === "phases" && (value === "column" || value === "row")) options.phases = value;
    if (key === "phase-fill" && (value === "whole" || value === "name")) options.phaseFill = value;
    if (key === "rows" && (value === "fixed" || value === "zoomed")) options.rows = value;
    if (key === "max-height" && (value === "full" || value === "small" || value === "medium" || value === "large")) options.height = value;
  }
  return options;
}
