// @vitest-environment jsdom
import { mount, unmount } from "svelte";
import { expect, it, vi } from "vitest";
import EmojiText from "./EmojiText.svelte";

const entry = { shortcode: "3d-printer", pack: "printing", file: "printer.png", aliases: ["3dp"] };
it("renders aliases in Unicode/RTL labels without interpreting markup or changing their text", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([entry])));
  vi.stubGlobal("fetch", request);
  const target = document.createElement("div"); document.body.append(target);
  const app = mount(EmojiText, { target, props: { text: "مرحبا :3DP: / :3d-printer: / <script> / :unknown:", vault: "v" } });
  try {
    await vi.waitFor(() => expect(target.querySelectorAll("img")).toHaveLength(2));
    expect(target.querySelector("img")?.getAttribute("alt")).toBe(":3DP:");
    expect(target.textContent).toContain("<script> / :unknown:");
    expect(target.querySelector("script")).toBeNull();
    expect(request).toHaveBeenCalledOnce();
  } finally { await unmount(app); target.remove(); vi.unstubAllGlobals(); }
});

it("falls back to the original shortcode after an image error and unsubscribes on teardown", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([entry])));
  vi.stubGlobal("fetch", request);
  const target = document.createElement("div"); document.body.append(target);
  const app = mount(EmojiText, { target, props: { text: ":3dp:", vault: "v" } });
  try {
    await vi.waitFor(() => expect(target.querySelector("img")).not.toBeNull());
    target.querySelector("img")?.dispatchEvent(new Event("error"));
    await vi.waitFor(() => expect(target.textContent).toBe(":3dp:"));
  } finally {
    await unmount(app); target.remove();
    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    vi.unstubAllGlobals();
  }
});

it("does not request a catalog for ordinary labels or serverless contexts", async () => {
  const request = vi.fn(); vi.stubGlobal("fetch", request);
  const target = document.createElement("div");
  const one = mount(EmojiText, { target, props: { text: "Plain 🎉", vault: "v" } });
  const two = mount(EmojiText, { target, props: { text: ":3dp:" } });
  try { await Promise.resolve(); expect(request).not.toHaveBeenCalled(); }
  finally { await unmount(one); await unmount(two); vi.unstubAllGlobals(); }
});
