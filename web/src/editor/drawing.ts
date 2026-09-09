/** Loading and mounting helpers for Excalidraw embeds (§13). */

export interface DrawingPayload {
  readonly markdown: string;
  readonly scene: Record<string, unknown>;
  readonly revision: string;
}

export interface DrawingExports {
  readonly svg: string;
  readonly png: string;
}

export interface DrawingRequest {
  readonly vault: string;
  readonly target: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

/** A lazy drawing embed which keeps the Excalidraw package out of the editor's first chunk. */
export class DrawingBlock {
  readonly dom: HTMLElement;
  private readonly aborter = new AbortController();
  private unmount: (() => void) | undefined;
  private destroyed = false;

  constructor(
    private readonly request: DrawingRequest,
    private readonly editable: boolean,
  private readonly save: (markdown: string, base: string, exports: DrawingExports) => Promise<string>,
  ) {
    this.dom = document.createElement("span");
    this.dom.className = "note-drawing";
    this.dom.setAttribute("contenteditable", "false");
    this.dom.dataset["drawingState"] = "loading";
    this.dom.textContent = "Loading drawing…";
    void this.load();
  }

  destroy(): void {
    this.destroyed = true;
    this.aborter.abort();
    this.unmount?.();
    this.unmount = undefined;
  }

  private async load(): Promise<void> {
    try {
      const payload = await loadDrawing({ ...this.request, signal: this.aborter.signal });
      if (this.destroyed) return;
      window.EXCALIDRAW_ASSET_PATH = `${window.location.origin}/assets/excalidraw/`;
      const island = await import("./drawing-island.js");
      if (this.destroyed) return;
      this.dom.replaceChildren();
      this.dom.dataset["drawingState"] = "ready";
      this.unmount = island.mountDrawingIsland(this.dom, payload, this.editable, this.save);
    } catch {
      if (this.destroyed) return;
      this.dom.dataset["drawingState"] = "unavailable";
      this.dom.textContent = "Drawing unavailable.";
    }
  }
}

/** Fetches one drawing through the permission-filtered server route. */
export async function loadDrawing(request: DrawingRequest): Promise<DrawingPayload> {
  const send = request.fetch ?? globalThis.fetch.bind(globalThis);
  const response = await send(drawingUrl(request.vault, request.target), {
    headers: { accept: "application/json" },
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  if (!response.ok) throw new Error("drawing unavailable");
  const body: unknown = await response.json();
  return readDrawing(body);
}

/** Builds the drawing endpoint without allowing a target to create URL path segments. */
export function drawingUrl(vault: string, target: string): string {
  const clean = target.startsWith("drawings/") ? target.slice("drawings/".length) : target;
  const path = clean.endsWith(".excalidraw.md") ? clean : `${clean}.md`;
  return `/api/v1/vaults/${encodeURIComponent(vault)}/drawings/${encodeURIComponent(path)}`;
}

/** Builds the sibling endpoint used for derived SVG/PNG files. */
export function drawingExportsUrl(vault: string, target: string): string {
  return drawingUrl(vault, target).replace("/drawings/", "/drawing-exports/");
}

/** Validates the JSON shape before handing it to the React island. */
export function readDrawing(body: unknown): DrawingPayload {
  if (
    !isRecord(body) ||
    typeof body["markdown"] !== "string" ||
    typeof body["revision"] !== "string" ||
    !isRecord(body["scene"])
  ) {
    throw new Error("invalid drawing response");
  }
  const scene = body["scene"];
  if (scene["type"] !== "excalidraw" || !Array.isArray(scene["elements"])) {
    throw new Error("invalid drawing scene");
  }
  return { markdown: body["markdown"], scene, revision: body["revision"] };
}

/** Replaces only the first supported scene fence, preserving surrounding Obsidian text. */
export function replaceScene(markdown: string, scene: unknown): string {
  const serialized = JSON.stringify(scene);
  const lines = markdown.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const language = lines[index]?.trim();
    if (language !== "```compressed-json" && language !== "```json") continue;
    const end = lines.findIndex((line, offset) => offset > index && line.trim() === "```");
    if (end < 0) throw new Error("drawing scene fence is incomplete");
    lines.splice(index + 1, end - index - 1, serialized);
    return lines.join("\n");
  }
  throw new Error("drawing scene fence is missing");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
