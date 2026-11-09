/**
 * The lazy Mermaid renderer (SPEC §13.2).
 *
 * The `mermaid` package is reached only through `import("mermaid")` here, so it is never part
 * of the initial bundle (§21.2). Renders are serialized because Mermaid keeps global
 * configuration and measures text in a temporary node: two concurrent renders with
 * different themes would each paint with whichever `initialize` ran last.
 */

import type { MermaidConfig } from "mermaid";

import { chartOptions, PHASE_COLOURS, tint } from "../gantt/colors.js";
import { sanitizeSvg } from "./sanitize.js";

/** The part of Mermaid's API this module uses, so tests can supply a double. */
export interface MermaidApi {
  initialize(config: MermaidConfig): void;
  render(id: string, text: string): Promise<{ readonly svg: string }>;
}

/** What one render produced. Errors are values, and are cached like successes. */
export type MermaidOutcome =
  | { readonly kind: "ok"; readonly svg: string }
  | { readonly kind: "error"; readonly message: string };

export interface MermaidRenderer {
  /**
   * Renders `source` with `theme` at `width` CSS pixels, from the cache when the same three
   * rendered before.
   */
  render(source: string, theme: Readonly<Record<string, string>>, width?: number): Promise<MermaidOutcome>;
}

export interface MermaidRendererOptions {
  readonly load?: () => Promise<MermaidApi>;
  /** How many outcomes to keep. Old entries are evicted least-recently-used first. */
  readonly capacity?: number;
}

const DEFAULT_CAPACITY = 64;

/**
 * The narrowest layout width a Gantt chart gets. Below this its date axis overlaps, so a
 * phone scrolls the chart sideways rather than squeezing it (SPEC §13.2).
 */
export const MIN_DIAGRAM_WIDTH = 640;

/** Lays out at the available width, rounded so small resizes still hit the cache. */
export function layoutWidth(available: number): number {
  const rounded = Math.round((Number.isFinite(available) ? available : 0) / 40) * 40;
  return Math.max(MIN_DIAGRAM_WIDTH, rounded);
}

/** Creates a renderer. The app uses one per page through `sharedMermaidRenderer`. */
export function createMermaidRenderer(options: MermaidRendererOptions = {}): MermaidRenderer {
  const load = options.load ?? loadMermaid;
  const capacity = Math.max(1, options.capacity ?? DEFAULT_CAPACITY);
  const cache = new Map<string, MermaidOutcome>();
  let api: Promise<MermaidApi> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let sequence = 0;

  function remember(key: string, outcome: MermaidOutcome): void {
    cache.set(key, outcome);
    if (cache.size > capacity) {
      const oldest = cache.keys().next();
      if (oldest.done !== true) cache.delete(oldest.value);
    }
  }

  async function renderNow(source: string, theme: Readonly<Record<string, string>>, width: number): Promise<MermaidOutcome> {
    let mermaid: MermaidApi;
    try {
      api ??= load();
      mermaid = await api;
    } catch {
      // why: a chunk that failed to arrive (offline before precache finished) may arrive later.
      api = undefined;
      return { kind: "error", message: "The diagram renderer could not be loaded." };
    }
    sequence += 1;
    try {
      mermaid.initialize(configFor(theme, width, source));
      const { svg } = await mermaid.render(`mb-mermaid-${String(sequence)}`, source);
      const clean = sanitizeSvg(svg);
      return clean === undefined
        ? { kind: "error", message: "The diagram renderer produced no picture." }
        : { kind: "ok", svg: clean };
    } catch (error) {
      return { kind: "error", message: errorMessage(error) };
    }
  }

  return {
    render(source, theme, available = 0) {
      const width = layoutWidth(available);
      const key = `${String(width)}\n${JSON.stringify(theme)}\n${source}`;
      const hit = cache.get(key);
      if (hit !== undefined) {
        cache.delete(key);
        cache.set(key, hit);
        return Promise.resolve(hit);
      }
      const next = queue.then(() => renderNow(source, theme, width));
      queue = next.catch(() => undefined);
      return next.then((outcome) => {
        // why: a load failure is transient; caching it would pin the error after reconnecting.
        if (outcome.kind === "ok" || api !== undefined) remember(key, outcome);
        return outcome;
      });
    },
  };
}

let shared: MermaidRenderer | undefined;

/** The page's one renderer, so the cache and the render queue are shared by every block. */
export function sharedMermaidRenderer(): MermaidRenderer {
  shared ??= createMermaidRenderer();
  return shared;
}

async function loadMermaid(): Promise<MermaidApi> {
  const module = await import("mermaid");
  return module.default;
}

/** The fixed security and appearance configuration; only the theme varies. */
export function configFor(theme: Readonly<Record<string, string>>, width = MIN_DIAGRAM_WIDTH, source = ""): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    // why: SVG text labels instead of HTML in <foreignObject>, so nothing HTML-shaped is
    // inserted and the sanitizer has one language to reason about.
    htmlLabels: false,
    suppressErrorRendering: true,
    theme: "base",
    themeVariables: { ...theme },
    // why: Mermaid otherwise lays a Gantt chart out at 1200px in an off-screen node and the
    // browser shrinks the result, which leaves its labels unreadably small. Lay it out at the
    // width it will be shown at, and keep that size rather than scaling to fit.
    // why: Mermaid's default axis prints a full ISO date on every daily tick, which overlaps
    // at any width a note has. A diagram's own `axisFormat` still overrides this.
    gantt: { useWidth: width, useMaxWidth: false, axisFormat: "%e %b", ...ganttLayout(source) },
    themeCSS: chartOptions(source).rows === "zoomed" ? `${GANTT_CSS}\n${ZOOMED_CSS}` : GANTT_CSS,
    ...(theme["fontFamily"] === undefined ? {} : { fontFamily: theme["fontFamily"] }),
  };
}

/** The left margin when phase names are in header rows: room for the stripe and a gap. */
const ROW_MODE_LEFT_PX = 20;

/** The header row height for phases shown as rows (SPEC §13.3), by row height. */
export const PHASE_HEADER_PX = { fixed: 30, zoomed: 40 } as const;

/** Roughly the width of one character of a 13px phase name, and the margin around it. */
const SECTION_CHAR_PX = 7.4;
const SECTION_MARGIN_PX = 32;

/**
 * Gantt spacing (SPEC §13.2). The left margin is sized from the longest phase name: Mermaid's
 * default of 75px let names run under the bars.
 */
export function ganttLayout(source: string): {
  readonly leftPadding: number;
  readonly rightPadding: number;
  readonly barHeight: number;
  readonly barGap: number;
  readonly topPadding: number;
  readonly gridLineStartPadding: number;
  readonly fontSize: number;
  readonly sectionFontSize: number;
  readonly numberSectionStyles: number;
} {
  const options = chartOptions(source);
  const longest = [...source.matchAll(/^\s*section\s+(.+?)\s*$/gmu)].reduce((max, match) => Math.max(max, [...(match[1] ?? "")].length), 0);
  const zoomed = options.rows === "zoomed";
  const charPx = zoomed ? SECTION_CHAR_PX * 15 / 13 : SECTION_CHAR_PX;
  // why: with phases as rows (SPEC §13.3) their names sit in header rows, so the bars can start
  // near the left edge instead of after a name column.
  const leftPadding = options.phases === "row" ? ROW_MODE_LEFT_PX : Math.round(Math.min(280, Math.max(80, longest * charPx + SECTION_MARGIN_PX)));
  const size = zoomed ? { barHeight: 36, barGap: 12, fontSize: 14, sectionFontSize: 15 } : { barHeight: 26, barGap: 8, fontSize: 12, sectionFontSize: 13 };
  return { leftPadding, rightPadding: 48, ...size, topPadding: 56, gridLineStartPadding: 42, numberSectionStyles: PHASE_COLOURS.length };
}


/** Per-phase rules: its band, its name, and its bars in each state. */
function phaseRules(colour: string, n: number): string[] {
  return [
    `.section${String(n)} { fill: ${colour}; opacity: 0.09; }`,
    `.sectionTitle${String(n)} { fill: ${colour}; }`,
    `.task${String(n)} { fill: ${tint(colour, 24)}; stroke: ${colour}; }`,
    `.active${String(n)} { fill: ${tint(colour, 45)}; stroke: ${colour}; stroke-width: 2.5px; }`,
    `.done${String(n)} { fill: ${tint(colour, 10)}; stroke: ${colour}; stroke-opacity: 0.55; }`,
    `.crit${String(n)}, .activeCrit${String(n)}, .doneCrit${String(n)} { fill: ${tint(colour, 24)}; stroke: var(--state-danger); stroke-width: 2px; }`,
    `.mb-phase-stripe${String(n)} { fill: ${colour}; }`,
    `.mb-phase-name${String(n)} { fill: ${tint(colour, 18)}; }`,
    `.mb-phase-outlined.mb-phase-name${String(n)} { stroke: ${colour}; }`,
  ];
}

/**
 * How a Gantt chart looks in a note (SPEC §13.2): design tokens only, so it follows the theme.
 * Mermaid scopes this to the chart and adds it after its own rules, so these win.
 *
 * why: phases are told apart by colour: each phase's band is tinted, its name is in its colour
 * and its bars are drawn in it, with a stripe down its left edge and a line where it starts
 * (both added after rendering). A task's own colour (A40) is an inline style and still wins.
 */
export const GANTT_CSS = [
  ".titleText { font-size: 16px; font-weight: 600; fill: var(--text-primary); }",
  ".sectionTitle { font-size: 13px; font-weight: 700; }",
  ".section { stroke: none; }",
  ".grid .tick line { stroke: var(--border-subtle); stroke-dasharray: 2 4; opacity: 1; }",
  ".grid .tick text { fill: var(--text-muted); font-size: 11px; }",
  ".grid path { stroke: none; }",
  "rect.task { rx: 6px; ry: 6px; stroke-width: 1.5px; }",
  "rect.milestone { rx: 2px; ry: 2px; }",
  ".taskText, .taskTextOutsideRight, .taskTextOutsideLeft { font-size: 12px; font-weight: 500; fill: var(--text-primary); }",
  ".today { stroke-width: 2px; stroke-dasharray: 4 4; }",
  ".mb-phase-divider { stroke: var(--text-muted); stroke-width: 1px; opacity: 0.4; }",
  ".mb-phase-outlined { stroke-width: 1.5px; }",
  ...PHASE_COLOURS.flatMap((colour, n) => phaseRules(colour, n)),
].join("\n");

/** Larger text for tall rows (SPEC §13.3); the bars themselves grow through `ganttLayout`. */
const ZOOMED_CSS = [
  ".titleText { font-size: 18px; }",
  ".sectionTitle { font-size: 15px; }",
  ".taskText, .taskTextOutsideRight, .taskTextOutsideLeft { font-size: 14px; }",
  ".grid .tick text { font-size: 12px; }",
].join("\n");

/** A phase drawn by Mermaid: where its rows start and end, and its style number. */
export interface PhaseBand {
  readonly top: number;
  readonly bottom: number;
  readonly style: number;
}

/**
 * Groups Mermaid's per-row bands into phases: consecutive rows with the same style number are
 * one phase. Bands come in any order; they are sorted by position.
 */
export function phaseBands(rows: readonly PhaseBand[]): PhaseBand[] {
  const phases: PhaseBand[] = [];
  for (const row of [...rows].sort((a, b) => a.top - b.top)) {
    const last = phases.at(-1);
    if (last !== undefined && last.style === row.style && Math.abs(last.bottom - row.top) < 1) phases[phases.length - 1] = { ...last, bottom: row.bottom };
    else phases.push(row);
  }
  return phases;
}

/**
 * Which of a row of axis labels to keep so none overlap: each is kept only when it starts at
 * least `gap` pixels after the last one kept.
 *
 * why: Mermaid ticks the date axis by its own rule, and at a note's width a daily or
 * every-other-day tick ran its labels into each other.
 */
export function thinLabels(boxes: readonly { readonly left: number; readonly right: number }[], gap = 8): boolean[] {
  let edge = -Infinity;
  return boxes.map((box) => {
    if (box.right - box.left <= 0) return true;
    if (box.left < edge + gap) return false;
    edge = box.right;
    return true;
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message.trim();
  if (typeof error === "string" && error.trim() !== "") return error.trim();
  return "The diagram could not be drawn.";
}
