// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { markPhases } from "./mermaid-view.js";

/** What Mermaid draws for two phases of two tasks each, trimmed to the parts `markPhases` reads. */
const DRAWN = `<svg xmlns="http://www.w3.org/2000/svg" id="d" width="680" height="248" viewBox="0 0 680 248">
<g class="grid" transform="translate(80, 198)"><g class="tick"><line y2="-150"></line><text>3 Nov</text></g></g>
<g><rect x="0" y="54" width="656" height="34" class="section section0"></rect><rect x="0" y="88" width="656" height="34" class="section section0"></rect>
<rect x="0" y="122" width="656" height="34" class="section section1"></rect><rect x="0" y="156" width="656" height="34" class="section section1"></rect></g>
<g><rect id="d-wf" x="80" y="56" width="120" height="26" transform-origin="140px 69px" class="task done0"></rect>
<rect id="d-vd" x="200" y="90" width="192" height="26" transform-origin="296px 103px" class="task active0"></rect>
<rect id="d-api" x="392" y="124" width="240" height="26" transform-origin="512px 137px" class="task task1"></rect>
<rect id="d-ship" x="619" y="158" width="26" height="26" transform-origin="632px 171px" class="task milestone task1"></rect>
<text id="d-api-text" x="512" y="141" class="taskText taskText1">API</text></g>
<g><text x="10" y="90" class="sectionTitle sectionTitle0"><tspan x="10">Design</tspan></text><text x="10" y="158" class="sectionTitle sectionTitle1"><tspan x="10">Build</tspan></text></g>
<g class="today"><line x1="264" x2="264" y1="25" y2="223" class="today"></line></g></svg>`;

const SOURCE = ["gantt", "    dateFormat YYYY-MM-DD", "    section Design", "    Wireframes :done, wf, 2026-11-02, 5d", "    Visual :active, vd, after wf, 8d", "    section Build", "    API :api, after vd, 10d", "    Ship :milestone, ship, after api, 0d"].join("\n");

function drawn(options: readonly string[] = []): SVGSVGElement {
  const svg = new DOMParser().parseFromString(DRAWN, "image/svg+xml").documentElement as unknown as SVGSVGElement;
  markPhases(svg, [...SOURCE.split("\n"), ...options.map((line) => `    ${line}`)].join("\n"));
  return svg;
}
const y = (svg: Element, selector: string): number => Number(svg.querySelector(selector)?.getAttribute("y") ?? "NaN");

describe("markPhases: phases in a column (the default)", () => {
  it("gives each phase a stripe, a line where it starts, and no header rows", () => {
    const svg = drawn();
    expect([svg.querySelectorAll(".mb-phase-stripe").length, svg.querySelectorAll(".mb-phase-divider").length, svg.querySelectorAll(".mb-phase-name").length, svg.getAttribute("height")])
      .toEqual([2, 1, 0, "248"]);
  });
});

describe("markPhases: phases as rows", () => {
  it("opens a header row above each phase and moves the phase's name into it", () => {
    const svg = drawn(["%% option phases row"]);
    const headers = [...svg.querySelectorAll(".mb-phase-name")].map((node) => [node.getAttribute("y"), node.getAttribute("height")]);
    expect([headers, y(svg, ".sectionTitle0"), y(svg, ".sectionTitle1"), svg.querySelector(".sectionTitle1 tspan")?.getAttribute("x")])
      .toEqual([[["54", "30"], ["152", "30"]], 69, 167, "12"]);
  });

  it("moves each phase's bars, labels and milestones down by the headers above them", () => {
    const svg = drawn(["%% option phases row"]);
    expect([y(svg, "#d-wf"), y(svg, "#d-vd"), y(svg, "#d-api"), y(svg, "#d-api-text"), svg.querySelector("#d-ship")?.getAttribute("transform-origin")])
      .toEqual([86, 120, 184, 201, "632px 231px"]);
  });

  it("grows the chart, its grid and today's line by every header row", () => {
    const svg = drawn(["%% option phases row"]);
    expect([svg.getAttribute("height"), svg.getAttribute("viewBox"), svg.querySelector(".grid")?.getAttribute("transform"), svg.querySelector(".tick line")?.getAttribute("y2"), svg.querySelector("line.today")?.getAttribute("y2")])
      .toEqual(["308", "0 0 680 308", "translate(80, 258)", "-210", "283"]);
  });

  it("uses taller header rows with tall rows", () => {
    const svg = drawn(["%% option phases row", "%% option rows zoomed"]);
    expect(svg.querySelector(".mb-phase-name")?.getAttribute("height")).toBe("40");
  });

  it("draws a phase's own colour in its header, and no colour as a plain header", () => {
    const svg = drawn(["%% option phases row", "%% section-color green Design", "%% section-color none Build"]);
    const [design, build] = [...svg.querySelectorAll<SVGRectElement>(".mb-phase-name")];
    expect([design?.style.fill, build?.style.fill, build?.classList.contains("mb-phase-name-plain")])
      .toEqual(["color-mix(in srgb, var(--note-color-green) 18%, var(--surface-note))", "none", true]);
  });
});

describe("markPhases: colour on the name only", () => {
  it("hides the coloured task rows and outlines a cell behind each name instead of a stripe", () => {
    const svg = drawn(["%% option phase-fill name"]);
    const rows = [...svg.querySelectorAll<SVGRectElement>("rect.section")].map((row) => row.style.visibility);
    const cells = [...svg.querySelectorAll(".mb-phase-name")].map((cell) => cell.classList.contains("mb-phase-outlined"));
    expect([rows, cells, svg.querySelectorAll(".mb-phase-stripe").length]).toEqual([["hidden", "hidden", "hidden", "hidden"], [true, true], 0]);
  });

  it("outlines a phase's own colour on its header row", () => {
    const svg = drawn(["%% option phases row", "%% option phase-fill name", "%% section-color #c0392b Build"]);
    const build = svg.querySelectorAll<SVGRectElement>(".mb-phase-name")[1];
    expect([build?.style.stroke, build?.getAttribute("width")]).toEqual(["rgb(192, 57, 43)", "656"]);
  });
});
