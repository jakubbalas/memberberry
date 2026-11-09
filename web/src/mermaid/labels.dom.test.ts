// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";

import { revealFullText, shortenLabels } from "./labels.js";

beforeAll(() => {
  // why: jsdom does no layout. 7px a character stands in for the rendered width.
  Object.defineProperty(SVGElement.prototype, "getComputedTextLength", {
    configurable: true,
    value(this: SVGElement) { return [...(this.textContent ?? "")].length * 7; },
  });
});

/** Mermaid's drawing of a two-phase chart, trimmed to what the labels code reads. */
function drawn(names: { phase?: string; wide?: string; narrow?: string } = {}): Element {
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200">
<g class="grid" transform="translate(80, 150)"></g>
<g><rect id="d-wide" x="80" y="56" width="120" height="26" class="task task0"></rect>
<rect id="d-narrow" x="300" y="90" width="20" height="26" class="task task0"></rect>
<rect id="d-ms" x="350" y="124" width="26" height="26" class="task milestone task1"></rect>
<text id="d-wide-text" x="140" y="73" class="taskText">${names.wide ?? "Wireframes"}</text>
<text id="d-narrow-text" x="325" y="107" class="taskTextOutsideRight">${names.narrow ?? "QA"}</text>
<text id="d-ms-text" x="363" y="141" class="taskText milestoneText">A very long milestone name</text></g>
<g><text x="10" y="90" class="sectionTitle sectionTitle0"><tspan x="10">${names.phase ?? "Design"}</tspan></text></g></svg>`;
  const svg = new DOMParser().parseFromString(markup, "image/svg+xml").documentElement;
  document.body.replaceChildren(document.importNode(svg, true));
  const live = document.body.firstElementChild;
  if (live === null) throw new Error("no chart");
  return live;
}
const text = (svg: Element, selector: string): string => svg.querySelector(selector)?.textContent ?? "";

describe("shortenLabels", () => {
  it("leaves names that fit alone and marks nothing", () => {
    const svg = drawn();
    expect([shortenLabels(svg, false).length, text(svg, "#d-wide-text"), text(svg, ".sectionTitle")]).toEqual([0, "Wireframes", "Design"]);
  });

  it("shortens a long task name inside its bar, centred, and keeps the full name", () => {
    const svg = drawn({ wide: "Wireframes for every landing page" });
    shortenLabels(svg, false);
    const label = svg.querySelector<SVGTextElement>("#d-wide-text");
    expect([label?.textContent, label?.getAttribute("x"), label?.style.textAnchor, label?.dataset["fullText"]])
      .toEqual(["Wireframes for…", "140", "middle", "Wireframes for every landing page"]);
  });

  it("keeps a narrow bar's name beside it, shortened at the chart's edge", () => {
    const svg = drawn({ narrow: "Quality assurance and sign-off" });
    shortenLabels(svg, false);
    const label = svg.querySelector<SVGTextElement>("#d-narrow-text");
    expect([label?.textContent, label?.getAttribute("x"), label?.style.textAnchor]).toEqual(["Quality…", "326", "start"]);
  });

  it("shortens a phase name to its column, in the tspan Mermaid put it in", () => {
    const svg = drawn({ phase: "Discovery and research" });
    shortenLabels(svg, false);
    expect([text(svg, ".sectionTitle tspan"), svg.querySelector<SVGTextElement>(".sectionTitle")?.dataset["fullText"]]).toEqual(["Discove…", "Discovery and research"]);
  });

  it("gives a phase name the chart's width when phases are rows", () => {
    const svg = drawn({ phase: "Discovery and research" });
    shortenLabels(svg, true);
    expect(text(svg, ".sectionTitle")).toBe("Discovery and research");
  });

  it("leaves milestone names to Mermaid", () => {
    const svg = drawn();
    shortenLabels(svg, false);
    expect(text(svg, "#d-ms-text")).toBe("A very long milestone name");
  });
});

describe("revealFullText", () => {
  function setup() {
    const svg = drawn({ wide: "Wireframes for every landing page" });
    const host = document.createElement("div");
    const tip = document.createElement("div");
    tip.hidden = true;
    host.append(tip);
    document.body.append(host);
    revealFullText(shortenLabels(svg, false), svg, tip, host);
    const label = svg.querySelector("#d-wide-text");
    const bar = svg.querySelector("#d-wide");
    if (label === null || bar === null) throw new Error("no label");
    return { svg, tip, label, bar };
  }

  it("shows the full name while the pointer is over the label or its bar", () => {
    const { tip, label, bar } = setup();
    bar.dispatchEvent(new Event("pointerenter"));
    const shown = [tip.hidden, tip.textContent];
    bar.dispatchEvent(new Event("pointerleave"));
    label.dispatchEvent(new Event("pointerenter"));
    const again = tip.hidden;
    label.dispatchEvent(new Event("pointerleave"));
    expect([shown, again, tip.hidden]).toEqual([[false, "Wireframes for every landing page"], false, true]);
  });

  it("keeps the name shown after a click or tap, until a second one or a click elsewhere", () => {
    const { svg, tip, bar } = setup();
    bar.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    bar.dispatchEvent(new Event("pointerleave"));
    const pinned = tip.hidden;
    bar.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const unpinned = tip.hidden;
    bar.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    svg.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect([pinned, unpinned, tip.hidden]).toEqual([false, true, true]);
  });
});
