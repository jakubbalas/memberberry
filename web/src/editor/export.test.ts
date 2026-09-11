// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { downloadHtml, printPanel, standaloneHtml } from "./export.js";

describe("single-note HTML export", () => {
  it("embeds styles and authenticated media without changing the rendered note", async () => {
    const style = document.createElement("style");
    style.textContent = ".note { color: red; }";
    document.head.append(style);
    const root = document.createElement("article");
    root.setAttribute("contenteditable", "true");
    root.innerHTML = '<h1>&lt;Roadmap&gt;</h1><img src="/media/picture.png"><object data="/media/file.pdf"></object>';
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      new Response(String(input).endsWith(".pdf") ? "%PDF" : "png", {
        headers: { "content-type": String(input).endsWith(".pdf") ? "application/pdf" : "image/png" },
      }),
    );

    const html = await standaloneHtml({ root, title: "A <note>", document, fetch });

    expect(html).toContain("<title>A &lt;note&gt;</title>");
    expect(html).toContain(".note { color: red; }");
    expect(html).toContain("data:image/png;base64,cG5n");
    expect(html).toContain("data:application/pdf;base64,JVBERg==");
    expect(html).not.toContain("contenteditable");
    expect(root.getAttribute("contenteditable")).toBe("true");
    expect(fetch).toHaveBeenCalledTimes(2);
    style.remove();
  });

  it("fails rather than emitting a supposedly self-contained file with missing media", async () => {
    const root = document.createElement("article");
    root.innerHTML = '<img src="/private.png">';
    await expect(
      standaloneHtml({ root, title: "Note", document, fetch: async () => new Response("", { status: 404 }) }),
    ).rejects.toThrow("HTTP 404");
  });

  it("downloads a bounded safe filename and revokes the temporary URL", () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const url = { createObjectURL: vi.fn(() => "blob:export"), revokeObjectURL: vi.fn() };
    downloadHtml("<p>note</p>", ' Plans/2026: "Q1" ', document, url);
    expect(click).toHaveBeenCalledOnce();
    expect(url.revokeObjectURL).toHaveBeenCalledWith("blob:export");
    click.mockRestore();
  });
});

describe("PDF print export", () => {
  it("scopes printing to one panel and removes the scope after printing", () => {
    const panel = document.createElement("section");
    document.body.append(panel);
    const print = vi.fn();
    const target = Object.assign(new EventTarget(), { print }) as unknown as Window;

    printPanel(panel, target);
    expect(print).toHaveBeenCalledOnce();
    expect(document.body.classList.contains("memberberry-printing")).toBe(true);
    expect(panel.dataset["printing"]).toBe("true");
    target.dispatchEvent(new Event("afterprint"));
    expect(document.body.classList.contains("memberberry-printing")).toBe(false);
    expect(panel.dataset["printing"]).toBeUndefined();
    panel.remove();
  });
});
