/**
 * The date header of a capped Gantt chart (SPEC §13.2). Mermaid draws a chart's dates along its
 * bottom, so a chart taller than its box hides them while its top is in view. The header repeats
 * the dates the axis shows in a strip that stays at the top of the box as it scrolls.
 *
 * It copies the axis rather than drawing its own, so the dates, their spacing and the labels
 * thinned out of the way always match the axis underneath.
 */

/** One date on the axis: its text and where its centre sits, in the chart's own units. */
export interface AxisLabel {
  readonly text: string;
  readonly x: number;
}

const TRANSLATE = /translate\(\s*(-?[\d.]+)/u;

/** The x of a `translate(x, y)` transform, or 0. */
function translateX(node: Element | null): number {
  const match = TRANSLATE.exec(node?.getAttribute("transform") ?? "");
  const x = Number(match?.[1] ?? "0");
  return Number.isFinite(x) ? x : 0;
}

/** The dates the chart's axis shows, left to right; labels thinned out of the way are left out. */
export function axisLabels(svg: Element): readonly AxisLabel[] {
  const grid = svg.querySelector(".grid");
  if (grid === null) return [];
  const left = translateX(grid);
  const labels: AxisLabel[] = [];
  for (const tick of grid.querySelectorAll(".tick")) {
    const text = tick.querySelector("text");
    if (text === null || (text as Element & ElementCSSInlineStyle).style.display === "none") continue;
    const content = text.textContent.trim();
    if (content !== "") labels.push({ text: content, x: left + translateX(tick) });
  }
  return labels;
}

/** The header element, empty until it is drawn. */
export function createDateHeader(doc: Document): HTMLElement {
  const header = doc.createElement("div");
  header.className = "mb-chart-dates";
  // why: it repeats the axis, which assistive technology already reads with the chart.
  header.setAttribute("aria-hidden", "true");
  return header;
}

/**
 * Draws `labels` into `header`, which is `width` pixels wide; `scale` turns chart units into
 * pixels and `fontSize` is the axis text's size in pixels, so both match the chart as drawn.
 */
export function drawDateHeader(header: HTMLElement, labels: readonly AxisLabel[], width: number, scale: number, fontSize: number): void {
  const doc = header.ownerDocument;
  header.style.width = `${String(width)}px`;
  header.style.fontSize = `${String(fontSize)}px`;
  header.replaceChildren(...labels.map((label) => {
    const node = doc.createElement("span");
    node.textContent = label.text;
    node.style.left = `${String(label.x * scale)}px`;
    return node;
  }));
}
