/**
 * Long labels in a rendered Gantt chart (SPEC §13.2): a task or phase name that does not fit
 * its space is shortened with an ellipsis, and the full name is shown on hover, click or tap.
 *
 * Measuring needs layout, so this runs once the chart is in the page.
 */
import { fitText } from "../gantt/fit-text.js";

/** Room between a bar's edge and its label. */
const BAR_PADDING_PX = 6;
/** A bar narrower than this keeps its label beside it rather than inside. */
const MIN_INSIDE_PX = 40;
/** Space kept clear at the chart's right edge. */
const EDGE_PX = 8;

/** The data attribute a shortened label keeps its full text in. */
export const FULL_TEXT = "fullText";

/**
 * Shortens the task and phase names of a rendered Gantt chart that do not fit, and returns the
 * shortened labels. A task name goes inside its bar when the bar is wide enough, and beside it
 * otherwise, up to the chart's edge. A phase name fits its name column, or the chart's width
 * when phases are rows.
 */
export function shortenLabels(svg: Element, phasesAsRows: boolean): SVGTextElement[] {
  const shortened: SVGTextElement[] = [];
  const width = Number(svg.getAttribute("width") ?? "0");
  const fit = (label: SVGTextElement, max: number): void => {
    // why: Mermaid wraps a phase name in a tspan; the text goes there so its position is kept.
    const target = label.querySelector("tspan") ?? label;
    const full = (target.textContent ?? "").trim();
    if (full === "" || typeof label.getComputedTextLength !== "function") return;
    const shown = fitText(full, Math.max(0, max), (text) => { target.textContent = text; return label.getComputedTextLength(); });
    target.textContent = shown;
    if (shown === full) return;
    label.dataset[FULL_TEXT] = full;
    label.classList.add("mb-shortened");
    shortened.push(label);
  };
  for (const label of svg.querySelectorAll<SVGTextElement>('text[id$="-text"]')) {
    const bar = svg.querySelector<SVGRectElement>(`rect#${CSS.escape(label.id.slice(0, -"-text".length))}`);
    if (bar === null || bar.classList.contains("milestone")) continue;
    const x = Number(bar.getAttribute("x") ?? "0");
    const barWidth = Number(bar.getAttribute("width") ?? "0");
    const inside = barWidth >= MIN_INSIDE_PX;
    // why: Mermaid puts a name that does not fit beside its bar, where a long one runs off the
    // chart or over other bars. Inside the bar, shortened, is where a reader looks for it.
    const textWidth = typeof label.getComputedTextLength === "function" ? label.getComputedTextLength() : 0;
    if (inside && textWidth <= barWidth - 2 * BAR_PADDING_PX) continue;
    label.setAttribute("x", String(inside ? x + barWidth / 2 : x + barWidth + BAR_PADDING_PX));
    label.style.textAnchor = inside ? "middle" : "start";
    fit(label, inside ? barWidth - 2 * BAR_PADDING_PX : width - EDGE_PX - (x + barWidth + BAR_PADDING_PX));
  }
  const leftPadding = Number(/translate\(\s*([\d.-]+)/u.exec(svg.querySelector(".grid")?.getAttribute("transform") ?? "")?.[1] ?? "0");
  for (const title of svg.querySelectorAll<SVGTextElement>(".sectionTitle")) {
    const x = Number(title.getAttribute("x") ?? "0");
    fit(title, phasesAsRows ? width - x - EDGE_PX : leftPadding - x - EDGE_PX);
  }
  return shortened;
}

/**
 * Shows a shortened label's full text in `tip` on hover, focus-free click or tap. A task's bar
 * reveals its label too, since the bar is the bigger target. Listeners live on the chart's own
 * elements, so they go when the chart is replaced.
 */
export function revealFullText(labels: readonly SVGTextElement[], svg: Element, tip: HTMLElement, host: HTMLElement): void {
  let pinned: Element | null = null;
  const show = (label: SVGTextElement): void => {
    tip.textContent = label.dataset[FULL_TEXT] ?? "";
    const box = label.getBoundingClientRect();
    const frame = host.getBoundingClientRect();
    tip.style.top = `${String(box.top - frame.top)}px`;
    tip.hidden = false;
    // why: centred over the label, but kept inside the frame; near an edge a centred tip would
    // be squeezed into a sliver or run off the screen.
    const width = tip.offsetWidth;
    const centred = box.left - frame.left + box.width / 2 - width / 2;
    tip.style.left = `${String(Math.max(0, Math.min(centred, frame.width - width)))}px`;
  };
  const hide = (): void => { tip.hidden = true; pinned = null; };
  for (const label of labels) {
    const bar = label.id.endsWith("-text") ? svg.querySelector(`rect#${CSS.escape(label.id.slice(0, -"-text".length))}`) : null;
    for (const target of bar === null ? [label] : [label, bar]) {
      target.addEventListener("pointerenter", () => { if (pinned === null) show(label); });
      target.addEventListener("pointerleave", () => { if (pinned === null) tip.hidden = true; });
      target.addEventListener("click", (event) => {
        event.stopPropagation();
        // why: a tap has no hover, so a click pins the tip; a second click on it lets it go.
        if (pinned === label) { hide(); return; }
        show(label);
        pinned = label;
      });
    }
  }
  svg.addEventListener("click", hide);
}
