// @vitest-environment jsdom
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { safeStyle, sanitizeSvg, svgElement } from "./sanitize.js";

const SEED = 20261108;
const svg = (inner: string, attrs = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"${attrs}>${inner}</svg>`;

function parse(markup: string | undefined): Element {
  if (markup === undefined) throw new Error("sanitizer rejected an SVG");
  return new DOMParser().parseFromString(markup, "image/svg+xml").documentElement;
}

describe("sanitizeSvg", () => {
  it("keeps the shapes, text and same-document references a Gantt chart is made of", () => {
    const out = parse(sanitizeSvg(svg(
      `<defs><marker id="m"/></defs><g class="section"><rect width="10" height="5"/><text x="1">Design ✏️ تصميم</text>` +
      `<line marker-end="url(#m)"/><use href="#m"/></g>`,
    )));
    expect([out.querySelector("rect") !== null, out.querySelector("text")?.textContent,
      out.querySelector("use")?.getAttribute("href")]).toEqual([true, "Design ✏️ تصميم", "#m"]);
  });

  it("removes scripts however deeply they are nested", () => {
    const out = parse(sanitizeSvg(svg(`<g><g><script>alert(1)</script></g></g>`)));
    expect(out.querySelector("script")).toBeNull();
  });

  it("removes elements that load or embed another resource", () => {
    const out = parse(sanitizeSvg(svg(
      `<image href="https://example.com/x.png"/><foreignObject><iframe src="https://example.com"/></foreignObject>` +
      `<animate attributeName="href" to="javascript:alert(1)"/><set attributeName="href" to="x"/>`,
    )));
    expect(out.querySelectorAll("image, iframe, animate, set")).toHaveLength(0);
  });

  it("drops links that leave the document, including javascript: URLs", () => {
    const out = parse(sanitizeSvg(svg(
      `<a href="javascript:alert(1)"><text>a</text></a><a xlink:href="https://example.com"><text>b</text></a>`,
    )));
    expect(Array.from(out.querySelectorAll("a"), (a) => a.attributes.length)).toEqual([0, 0]);
  });

  it("removes every event-handler attribute, whatever its name or value", () => {
    fc.assert(fc.property(
      fc.stringMatching(/^on[a-z]{1,12}$/), fc.string(),
      (name, value) => {
        const escaped = value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;");
        const out = parse(sanitizeSvg(svg(`<rect ${name}="${escaped}"/>`, ` ${name.toUpperCase()}="${escaped}"`)));
        const all = [out, ...Array.from(out.querySelectorAll("*"))];
        expect(all.flatMap((el) => Array.from(el.attributes, (a) => a.name)).filter((n) => /^on/i.test(n))).toEqual([]);
      },
    ), { seed: SEED, numRuns: 200 });
  });

  it("removes a stylesheet that would fetch, and keeps one that does not", () => {
    const out = parse(sanitizeSvg(svg(
      `<style>@import url(https://example.com/a.css);</style><style>#d .task { fill: red; }</style>`,
    )));
    expect(Array.from(out.querySelectorAll("style"), (s) => s.textContent)).toEqual(["#d .task { fill: red; }"]);
  });

  it("strips an inline style that fetches but leaves the element", () => {
    const out = parse(sanitizeSvg(svg(`<rect style="fill: url(https://example.com/p.svg#x)"/>`)));
    expect([out.querySelector("rect") !== null, out.querySelector("rect")?.hasAttribute("style")]).toEqual([true, false]);
  });

  it("refuses markup that is not an SVG document", () => {
    expect([sanitizeSvg("<html><body>hi</body></html>"), sanitizeSvg("not markup"), sanitizeSvg("")])
      .toEqual([undefined, undefined, undefined]);
  });
});

describe("safeStyle", () => {
  it.each([
    ["same-document url", "stroke: url(#arrow)", true],
    ["quoted same-document url", "fill: url('#g')", true],
    ["plain declarations", "font-family: \"trebuchet ms\", sans-serif; fill: #333", true],
    ["remote url", "background: url(https://example.com/i.png)", false],
    ["data url", "background: url(data:image/png;base64,AAAA)", false],
    ["import", "@import 'x.css';", false],
    ["escaped url function", "background: \\75 rl(https://example.com)", false],
    ["legacy expression", "width: expression(alert(1))", false],
  ])("%s → %s", (_name, css, safe) => {
    expect(safeStyle(css)).toBe(safe);
  });
});

describe("svgElement", () => {
  it("imports sanitized markup into the target document", () => {
    const element = svgElement(svg("<rect/>"), document);
    expect([element?.ownerDocument === document, element?.localName]).toEqual([true, "svg"]);
  });

  it("returns nothing for markup that is not SVG", () => {
    expect(svgElement("<p>hi</p>", document)).toBeUndefined();
  });
});
