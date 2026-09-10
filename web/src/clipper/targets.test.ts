// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { clipCurrentPage } from "./entrypoints.js";

describe("clip targets", () => {
  it("passes folder, tags, and template metadata to the sender", async () => {
    const sender = { clip: vi.fn(async () => ({ state: "queued" as const, id: "one" })) };
    const page = document.implementation.createHTMLDocument("page");
    page.body.innerHTML = "<p>clip</p>";
    await clipCurrentPage("full", { vault: "v", folder: "Articles", tags: ["reading"], template: "Templates/Article.md" }, sender, page, null);
    expect(sender.clip).toHaveBeenCalledWith(expect.objectContaining({ folder: "Articles", tags: ["reading"], template: "Templates/Article.md" }));
  });
});
