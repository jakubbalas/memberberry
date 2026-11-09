/**
 * Looking around a Gantt chart in a note (SPEC §13.2): zoom buttons, Ctrl or ⌘ with the wheel
 * (a trackpad pinch), a two-finger pinch on a touch screen, dragging to move around, and a jump
 * to today. Nothing here changes the note; the zoom lasts while the note is open.
 *
 * The chart keeps the size Mermaid laid it out at; zooming scales the picture, and the preview
 * scrolls when it is bigger than its box.
 */

import { axisLabels, createDateHeader, drawDateHeader } from "./date-header.js";

/** The zoom levels the buttons step through. */
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4] as const;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;
/** How far the pointer must move before a press becomes a drag, not a click. */
const DRAG_PX = 4;
/** Mermaid's axis text size, for when it cannot be read from the drawn chart. */
const AXIS_FONT_PX = 11;

/** A zoom within the allowed range. */
export function clampZoom(zoom: number): number {
  return Number.isFinite(zoom) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) : 1;
}

/** The next zoom step in or out from `zoom`, which need not be a step itself. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const next = direction > 0
    ? ZOOM_STEPS.find((step) => step > zoom + 0.001)
    : [...ZOOM_STEPS].reverse().find((step) => step < zoom - 0.001);
  return next ?? (direction > 0 ? MAX_ZOOM : MIN_ZOOM);
}

/** The zoom that makes content `width` wide fill `available`, within range. */
export function fitZoom(width: number, available: number): number {
  return width > 0 && available > 0 ? clampZoom(available / width) : 1;
}

/**
 * Where to scroll so the point `offset` pixels into the picture stays under the pointer when
 * the zoom changes by `ratio`.
 */
export function anchoredScroll(scroll: number, offset: number, ratio: number): number {
  return Math.max(0, scroll + offset * (ratio - 1));
}

/** How a zoom reads on its reset button. */
export function zoomText(zoom: number): string {
  return `${String(Math.round(zoom * 100))}%`;
}

/** A chart's width in its own units: its viewBox width, else its laid-out width. */
function viewBoxWidth(svg: Element, fallback: number): number {
  const width = Number((svg.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/u)[2] ?? "NaN");
  return Number.isFinite(width) && width > 0 ? width : fallback;
}

export interface ChartViewer {
  /** The zoom controls, for the host to place. */
  readonly controls: HTMLElement;
  /** Shows a freshly rendered chart at the current zoom; `null` for a chart with no viewer. */
  attach(svg: Element | null): void;
}

export interface ChartViewerOptions {
  /** The scrolling box the chart is drawn in. */
  readonly preview: HTMLElement;
  /** Called after the zoom changes, to redo anything that depends on drawn sizes. */
  readonly onZoom?: (svg: Element) => void;
}

/** Builds the zoom controls and wires zooming and moving around into `preview`. */
export function createChartViewer(options: ChartViewerOptions): ChartViewer {
  const { preview } = options;
  const doc = preview.ownerDocument;
  let zoom = 1;
  let svg: Element | null = null;
  let base = { width: 0, height: 0 };

  const controls = doc.createElement("div");
  controls.className = "mb-chart-zoom";
  controls.setAttribute("role", "group");
  controls.setAttribute("aria-label", "Chart zoom");
  const button = (text: string, label: string, onClick: () => void): HTMLButtonElement => {
    const node = doc.createElement("button");
    node.type = "button";
    node.textContent = text;
    node.setAttribute("aria-label", label);
    node.title = label;
    // why: keeps the caret where it was, as the other diagram buttons do.
    node.addEventListener("mousedown", (event) => { event.preventDefault(); });
    node.addEventListener("click", (event) => { event.preventDefault(); onClick(); });
    controls.append(node);
    return node;
  };
  const zoomOut = button("−", "Zoom out", () => { setZoom(stepZoom(zoom, -1)); });
  const reset = button("100%", "Reset zoom", () => { setZoom(1); });
  const zoomIn = button("+", "Zoom in", () => { setZoom(stepZoom(zoom, 1)); });
  button("Fit", "Fit to width", () => { setZoom(fitZoom(base.width, preview.clientWidth - padding())); });
  const today = button("Today", "Scroll to today", () => { scrollToToday(); });
  controls.hidden = true;
  const header = createDateHeader(doc);

  function padding(): number {
    const style = doc.defaultView?.getComputedStyle(preview);
    return (Number.parseFloat(style?.paddingLeft ?? "") || 0) + (Number.parseFloat(style?.paddingRight ?? "") || 0);
  }

  function show(): void {
    if (svg !== null) {
      // why: every SVG and HTML element has inline style; `Element` just does not say so.
      const node = svg as Element & ElementCSSInlineStyle;
      node.style.width = `${String(base.width * zoom)}px`;
      node.style.height = `${String(base.height * zoom)}px`;
    }
    reset.textContent = zoomText(zoom);
    zoomOut.disabled = zoom <= MIN_ZOOM + 0.001;
    zoomIn.disabled = zoom >= MAX_ZOOM - 0.001;
  }

  /**
   * Shows the dates at the top of a capped chart taller than its box, where the axis at the
   * bottom is out of sight (SPEC §13.2); removes them otherwise. Runs after the axis is thinned.
   */
  function syncHeader(): void {
    const style = doc.defaultView?.getComputedStyle(preview);
    const room = preview.clientHeight - (Number.parseFloat(style?.paddingTop ?? "") || 0) - (Number.parseFloat(style?.paddingBottom ?? "") || 0);
    if (svg === null || preview.dataset["maxHeight"] === undefined || base.height * zoom <= room) {
      header.remove();
      return;
    }
    const width = base.width * zoom;
    const scale = width / viewBoxWidth(svg, base.width);
    const sample = svg.querySelector(".grid .tick text");
    const size = Number.parseFloat(sample === null ? "" : doc.defaultView?.getComputedStyle(sample).fontSize ?? "");
    drawDateHeader(header, axisLabels(svg), width, scale, (Number.isFinite(size) && size > 0 ? size : AXIS_FONT_PX) * scale);
    if (preview.firstElementChild !== header) preview.prepend(header);
  }

  /** Zooms, keeping the picture point under (clientX, clientY) in place when one is given. */
  function setZoom(next: number, anchor?: { clientX: number; clientY: number }): void {
    const target = clampZoom(next);
    if (svg === null || Math.abs(target - zoom) < 0.0001) return;
    const ratio = target / zoom;
    const box = svg.getBoundingClientRect();
    const frame = preview.getBoundingClientRect();
    const at = anchor ?? { clientX: frame.left + preview.clientWidth / 2, clientY: frame.top + preview.clientHeight / 2 };
    const left = anchoredScroll(preview.scrollLeft, at.clientX - box.left, ratio);
    const top = anchoredScroll(preview.scrollTop, at.clientY - box.top, ratio);
    zoom = target;
    show();
    preview.scrollLeft = left;
    preview.scrollTop = top;
    options.onZoom?.(svg);
    syncHeader();
  }

  function scrollToToday(): void {
    const line = svg?.querySelector("line.today");
    if (svg === null || line === null || line === undefined) return;
    const x = Number(line.getAttribute("x1") ?? "NaN");
    if (!Number.isFinite(x)) return;
    const offset = svg.getBoundingClientRect().left - preview.getBoundingClientRect().left + preview.scrollLeft;
    // why: a third of the way in, so what comes next is in view as well as what is under way.
    preview.scrollLeft = Math.max(0, offset + x * zoom - preview.clientWidth / 3);
  }

  // Ctrl or ⌘ with the wheel zooms, as a trackpad pinch arrives; a plain wheel scrolls as usual.
  preview.addEventListener("wheel", (event) => {
    if (svg === null || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    setZoom(zoom * Math.exp(-event.deltaY * 0.01), event);
  }, { passive: false });

  // Dragging with a mouse moves around a chart bigger than its box. Touch scrolls natively.
  let drag: { x: number; y: number; left: number; top: number; moved: boolean } | null = null;
  /** Set when a drag ends, so the click the browser sends after it is not taken as a click. */
  let dragged = false;
  preview.addEventListener("click", (click) => {
    if (!dragged) return;
    dragged = false;
    click.stopPropagation();
    click.preventDefault();
  }, { capture: true });
  const touches = new Map<number, { clientX: number; clientY: number }>();
  let pinch: { distance: number; zoom: number } | null = null;
  const spread = (): number => {
    const [a, b] = [...touches.values()];
    return a === undefined || b === undefined ? 0 : Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  };
  preview.addEventListener("pointerdown", (event) => {
    if (svg === null) return;
    if (event.pointerType === "touch") {
      touches.set(event.pointerId, event);
      if (touches.size === 2) pinch = { distance: spread(), zoom };
      return;
    }
    if (event.button !== 0) return;
    dragged = false;
    drag = { x: event.clientX, y: event.clientY, left: preview.scrollLeft, top: preview.scrollTop, moved: false };
  });
  preview.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch") {
      if (!touches.has(event.pointerId)) return;
      touches.set(event.pointerId, event);
      if (pinch === null || pinch.distance <= 0) return;
      const [a, b] = [...touches.values()];
      if (a === undefined || b === undefined) return;
      setZoom(pinch.zoom * (spread() / pinch.distance), { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 });
      return;
    }
    if (drag === null) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_PX) return;
    if (!drag.moved) {
      drag.moved = true;
      preview.dataset["panning"] = "true";
      preview.setPointerCapture?.(event.pointerId);
    }
    preview.scrollLeft = drag.left - dx;
    preview.scrollTop = drag.top - dy;
  });
  const release = (event: PointerEvent): void => {
    if (event.pointerType === "touch") {
      touches.delete(event.pointerId);
      if (touches.size < 2) pinch = null;
      return;
    }
    // why: the click that ends a drag is not a click on what lies under it (a label's tip).
    dragged = drag?.moved === true;
    drag = null;
    delete preview.dataset["panning"];
  };
  preview.addEventListener("pointerup", release);
  preview.addEventListener("pointercancel", release);

  return {
    controls,
    attach(next) {
      svg = next;
      controls.hidden = next === null;
      if (next === null) { header.remove(); return; }
      base = { width: Number(next.getAttribute("width") ?? "0"), height: Number(next.getAttribute("height") ?? "0") };
      today.hidden = next.querySelector("line.today") === null;
      show();
      if (zoom !== 1) options.onZoom?.(next);
      syncHeader();
    },
  };
}
