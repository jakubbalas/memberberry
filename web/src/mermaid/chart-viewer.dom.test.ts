// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { createChartViewer } from "./chart-viewer.js";

afterEach(() => { document.body.replaceChildren(); });

function setup(withToday = true, cap?: string, box?: number) {
  const preview = document.createElement("div");
  if (cap !== undefined) preview.dataset["maxHeight"] = cap;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "600");
  svg.setAttribute("height", "200");
  svg.setAttribute("viewBox", "0 0 600 200");
  svg.innerHTML = '<g class="grid" transform="translate(80, 150)"><g class="tick" transform="translate(0,0)"><text>3 Nov</text></g><g class="tick" transform="translate(100,0)"><text>10 Nov</text></g></g>';
  if (withToday) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("class", "today");
    line.setAttribute("x1", "450");
    svg.append(line);
  }
  preview.append(svg);
  document.body.append(preview);
  if (box !== undefined) Object.defineProperty(preview, "clientHeight", { configurable: true, value: box });
  const onZoom = vi.fn();
  const viewer = createChartViewer({ preview, onZoom });
  document.body.append(viewer.controls);
  viewer.attach(svg);
  const press = (label: string) => viewer.controls.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)?.click();
  const readout = () => viewer.controls.querySelector('[aria-label="Reset zoom"]')?.textContent;
  return { preview, svg, viewer, onZoom, press, readout };
}

describe("createChartViewer", () => {
  it("shows the chart at its laid-out size to begin with", () => {
    const { svg, readout } = setup();
    expect([svg.style.width, svg.style.height, readout()]).toEqual(["600px", "200px", "100%"]);
  });

  it("zooms in and out a step at a time, scaling the picture and saying by how much", () => {
    const { svg, press, readout, onZoom } = setup();
    press("Zoom in");
    const zoomedIn = [svg.style.width, readout()];
    press("Zoom out");
    press("Zoom out");
    expect([zoomedIn, svg.style.width, readout(), onZoom.mock.calls.length]).toEqual([["750px", "125%"], "480px", "80%", 3]);
  });

  it("goes back to 100% from the readout", () => {
    const { svg, press } = setup();
    press("Zoom in");
    press("Reset zoom");
    expect(svg.style.width).toBe("600px");
  });

  it("stops at the limits, and says so by disabling the button", () => {
    const { press, viewer } = setup();
    for (let i = 0; i < 20; i += 1) press("Zoom in");
    expect([viewer.controls.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.disabled, viewer.controls.querySelector('[aria-label="Reset zoom"]')?.textContent]).toEqual([true, "400%"]);
  });

  it("zooms with Ctrl or ⌘ and the wheel, and leaves a plain wheel to scroll", () => {
    const { preview, readout } = setup();
    const plain = new WheelEvent("wheel", { deltaY: -100, cancelable: true });
    preview.dispatchEvent(plain);
    const afterPlain = [readout(), plain.defaultPrevented];
    const pinch = new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, cancelable: true });
    preview.dispatchEvent(pinch);
    expect([afterPlain, readout() !== "100%", pinch.defaultPrevented]).toEqual([["100%", false], true, true]);
  });

  it("keeps the zoom when the chart is drawn again", () => {
    const { svg, press, viewer, onZoom } = setup();
    press("Zoom in");
    const again = svg.cloneNode(true) as SVGSVGElement;
    viewer.attach(again);
    // The new drawing is fitted again (its date labels thinned) at the kept zoom.
    expect([again.style.width, onZoom.mock.lastCall?.[0] === again]).toEqual(["750px", true]);
  });

  it("offers Today only when the chart shows today", () => {
    const today = setup(true).viewer.controls.querySelector<HTMLButtonElement>('[aria-label="Scroll to today"]')?.hidden;
    document.body.replaceChildren();
    const none = setup(false).viewer.controls.querySelector<HTMLButtonElement>('[aria-label="Scroll to today"]')?.hidden;
    expect([today, none]).toEqual([false, true]);
  });

  it("hides the controls for a diagram that is not a Gantt chart", () => {
    const { viewer } = setup();
    viewer.attach(null);
    expect(viewer.controls.hidden).toBe(true);
  });

  it("does not take the click that ends a drag as a click on the chart", () => {
    const { preview, svg } = setup();
    const clicked = vi.fn();
    svg.addEventListener("click", clicked);
    preview.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 100, clientY: 100, pointerType: "mouse" }));
    preview.dispatchEvent(new PointerEvent("pointermove", { clientX: 160, clientY: 100, pointerType: "mouse" }));
    preview.dispatchEvent(new PointerEvent("pointerup", { clientX: 160, clientY: 100, pointerType: "mouse" }));
    svg.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    svg.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(clicked.mock.calls.length).toBe(1);
  });
});

describe("the date header of a capped chart", () => {
  const header = (preview: HTMLElement) => preview.querySelector<HTMLElement>(":scope > .mb-chart-dates");
  const dates = (preview: HTMLElement) => [...(header(preview)?.querySelectorAll("span") ?? [])].map((span) => [span.textContent, span.style.left]);

  it("repeats the axis's dates above a capped chart taller than its box", () => {
    const { preview, svg } = setup(true, "medium", 120);
    expect([preview.firstElementChild === header(preview), preview.lastElementChild === svg, dates(preview)]).toEqual([true, true, [["3 Nov", "80px"], ["10 Nov", "180px"]]]);
  });

  it("is not drawn for a chart with no cap", () => {
    expect(header(setup(true, undefined, 120).preview)).toBeNull();
  });

  it("is not drawn while the whole capped chart fits in its box", () => {
    expect(header(setup(true, "large", 400).preview)).toBeNull();
  });

  it("moves its dates with the zoom, after the axis is thinned for it", () => {
    const { preview, press, onZoom, svg } = setup(true, "medium", 120);
    onZoom.mockImplementation(() => { svg.querySelectorAll("text")[1]?.setAttribute("style", "display: none"); });
    press("Zoom in");
    expect([header(preview)?.style.width, dates(preview)]).toEqual(["750px", [["3 Nov", "100px"]]]);
  });

  it("comes back when the chart is drawn again, and goes with a diagram that is not a Gantt chart", () => {
    const { preview, svg, viewer } = setup(true, "medium", 120);
    const again = svg.cloneNode(true) as SVGSVGElement;
    preview.replaceChildren(again);
    viewer.attach(again);
    const redrawn = header(preview) !== null;
    viewer.attach(null);
    expect([redrawn, header(preview)]).toEqual([true, null]);
  });
});

