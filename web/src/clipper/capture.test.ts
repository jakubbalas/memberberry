// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { captureClip } from "./capture.js";

describe("captureClip", () => {
  it("captures the complete document", () => {
    const page = document.implementation.createHTMLDocument("page");
    page.body.innerHTML = "<p>full</p>";
    expect(captureClip("full", page).html).toContain("<p>full</p>");
  });

  it("captures a selection as a fragment", () => {
    const page = document.implementation.createHTMLDocument("page");
    page.body.innerHTML = "<p>before <strong>selected</strong> after</p>";
    const strong = page.querySelector("strong");
    if (strong === null) throw new Error("test fixture has no strong element");
    const range = page.createRange();
    range.selectNode(strong);
    expect(captureClip("selection", page, { rangeCount: 1, getRangeAt: () => range }).html).toBe("<strong>selected</strong>");
  });

  it("extracts a readable article and its metadata", () => {
    const page = document.implementation.createHTMLDocument("page");
    page.title = "Readable title";
    page.body.innerHTML = "<nav>noise</nav><article><h1>Readable title</h1><p>Article body with enough text to be identified by the reader extraction algorithm.</p></article>";
    expect(captureClip("article", page)).toMatchObject({ title: "Readable title" });
    expect(captureClip("article", page).html).toContain("Article body");
  });

  it("falls back to the main element when readability cannot extract", () => {
    const page = document.implementation.createHTMLDocument("page");
    page.body.innerHTML = "<main>main</main>";
    expect(captureClip("article", page).html).toContain("<main>main</main>");
  });
});
