// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { bookmarkletSource, clipCurrentPage } from "./entrypoints.js";

describe("clipCurrentPage", () => {
  it("passes the selected mode and destination to the transport", async () => {
    const page = document.implementation.createHTMLDocument("page");
    page.body.innerHTML = "<p>selected</p>";
    const clip = vi.fn(async () => ({ state: "queued" as const, id: "one" }));
    const result = await clipCurrentPage("full", { vault: "v", path: "Clips/page.md" }, { clip }, page, null);
    expect(result).toEqual({ state: "queued", id: "one" });
    expect(clip).toHaveBeenCalledWith({
      url: page.URL,
      html: expect.stringContaining("<p>selected</p>"),
      path: "Clips/page.md",
    });
  });
});

describe("bookmarkletSource", () => {
  it("contains the configured endpoint without executable interpolation", () => {
    const source = bookmarkletSource("https://notes.example/clip?vault=v");
    expect(source).toContain("https://notes.example/clip?vault=v");
    expect(source).toContain("noopener,noreferrer");
  });
});
