// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { hydrateCustomEmoji } from "./custom-emoji.js";

it("hydrates Rust HTML markers, preserves unknown spans, and tears down image listeners", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([{ shortcode: "printer", pack: "p", file: "p.png", aliases: [] }])));
  vi.stubGlobal("fetch", request);
  const root = document.createElement("div");
  root.innerHTML = '<span class="mb-emoji" data-shortcode="printer">:printer:</span><span class="mb-emoji" data-shortcode="unknown">:unknown:</span>';
  const close = hydrateCustomEmoji(root, "v");
  try {
    await vi.waitFor(() => expect(root.querySelector("img")?.getAttribute("src")).toBe("/api/v1/vaults/v/emoji/p/p.png"));
    expect(root.textContent).toBe(":unknown:");
    const retained = root.querySelector("img");
    close();
    retained?.dispatchEvent(new Event("error"));
    expect(root.querySelector("img")).toBe(retained);
    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  } finally { close(); vi.unstubAllGlobals(); }
});
