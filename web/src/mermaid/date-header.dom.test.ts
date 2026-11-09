// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { axisLabels, createDateHeader, drawDateHeader } from "./date-header.js";

afterEach(() => { document.body.replaceChildren(); });

function chart(grid: string): SVGSVGElement {
  const host = document.createElement("div");
  host.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg">${grid}</svg>`;
  const svg = host.querySelector("svg");
  if (svg === null) throw new Error("no svg");
  return svg;
}

describe("axisLabels", () => {
  it("reads each date and where it sits, counting the axis's own offset", () => {
    const svg = chart('<g class="grid" transform="translate(80, 198)"><g class="tick" transform="translate(0,0)"><text>3 Nov</text></g><g class="tick" transform="translate(120.5,0)"><text>10 Nov</text></g></g>');
    expect(axisLabels(svg)).toEqual([{ text: "3 Nov", x: 80 }, { text: "10 Nov", x: 200.5 }]);
  });

  it("leaves out the dates thinned out of the way on the axis", () => {
    const svg = chart('<g class="grid" transform="translate(0,0)"><g class="tick" transform="translate(10,0)"><text>a</text></g><g class="tick" transform="translate(20,0)"><text style="display: none">b</text></g></g>');
    expect(axisLabels(svg).map((label) => label.text)).toEqual(["a"]);
  });

  it("finds nothing in a chart without an axis, or with blank ticks", () => {
    const blank = chart('<g class="grid"><g class="tick" transform="translate(5,0)"><text> </text></g><g class="tick"></g></g>');
    expect([axisLabels(chart("<g></g>")), axisLabels(blank)]).toEqual([[], []]);
  });

  it("reads a broken transform as no offset", () => {
    const svg = chart('<g class="grid" transform="scale(2)"><g class="tick" transform="translate(nope)"><text>a</text></g></g>');
    expect(axisLabels(svg)).toEqual([{ text: "a", x: 0 }]);
  });
});

describe("drawDateHeader", () => {
  it("places each date at its scaled position, at the chart's width and text size", () => {
    const header = createDateHeader(document);
    drawDateHeader(header, [{ text: "3 Nov", x: 80 }, { text: "10 Nov", x: 200 }], 750, 1.25, 13.75);
    const spans = [...header.querySelectorAll("span")].map((span) => [span.textContent, span.style.left]);
    expect([header.style.width, header.style.fontSize, spans]).toEqual(["750px", "13.75px", [["3 Nov", "100px"], ["10 Nov", "250px"]]]);
  });

  it("is hidden from assistive technology, which reads the axis with the chart", () => {
    expect(createDateHeader(document).getAttribute("aria-hidden")).toBe("true");
  });

  it("writes dates as text, never as markup", () => {
    const header = createDateHeader(document);
    drawDateHeader(header, [{ text: "<img src=x onerror=alert(1)>", x: 0 }], 10, 1, 11);
    expect([header.querySelector("img"), header.textContent]).toEqual([null, "<img src=x onerror=alert(1)>"]);
  });
});
