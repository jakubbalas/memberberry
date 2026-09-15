// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import ShareTarget from "./ShareTarget.svelte";

afterEach(() => vi.unstubAllGlobals());

describe("share target screen", () => {
  it("lists readable vaults and submits the chosen folder", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)} ${String(init?.body ?? "")}`);
      if (String(input) === "/api/v1/vaults") {
        return new Response(JSON.stringify([{ slug: "personal", name: "Personal" }]), { status: 200 });
      }
      return new Response(JSON.stringify({ path: "Inbox/Thought.md", source: "" }), { status: 200 });
    });
    const target = document.createElement("div");
    document.body.append(target);
    const app = mount(ShareTarget, {
      target,
      props: { draft: { title: "Thought", text: "Remember this" } },
    });
    try {
      await vi.waitFor(() => expect(target.textContent).toContain("Ready to clip."));
      await tick();
      const folder = target.querySelector<HTMLInputElement>("input");
      if (folder === null) throw new Error("folder input missing");
      folder.value = "Inbox";
      folder.dispatchEvent(new Event("input", { bubbles: true }));
      target.querySelector<HTMLButtonElement>("button")?.click();
      await vi.waitFor(() => expect(target.textContent).toContain("Clipped to Inbox/Thought.md"));
      expect(requests.at(-1)).toContain('"folder":"Inbox"');
      expect(requests.at(-1)).toContain('"text":"Remember this"');
    } finally {
      unmount(app);
      target.remove();
    }
  });
});
