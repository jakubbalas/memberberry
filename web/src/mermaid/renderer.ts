/**
 * The lazy Mermaid renderer (SPEC §13.2).
 *
 * The `mermaid` package is reached only through `import("mermaid")` here, so it is never part
 * of the initial bundle (§21.2). Renders are serialized because Mermaid keeps global
 * configuration and measures text in a temporary node: two concurrent renders with
 * different themes would each paint with whichever `initialize` ran last.
 */

import type { MermaidConfig } from "mermaid";

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
      mermaid.initialize(configFor(theme, width));
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
export function configFor(theme: Readonly<Record<string, string>>, width = MIN_DIAGRAM_WIDTH): MermaidConfig {
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
    gantt: { useWidth: width, useMaxWidth: false, axisFormat: "%e %b" },
    ...(theme["fontFamily"] === undefined ? {} : { fontFamily: theme["fontFamily"] }),
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message.trim();
  if (typeof error === "string" && error.trim() !== "") return error.trim();
  return "The diagram could not be drawn.";
}
