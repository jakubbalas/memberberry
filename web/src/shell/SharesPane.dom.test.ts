// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { describe, expect, it, vi } from "vitest";

import SharesPane from "./SharesPane.svelte";
import { ShareView } from "./shares.js";

async function settle(): Promise<void> {
  await tick();
  await Promise.resolve();
  await tick();
}

describe("shares pane", () => {
  it("does not reload the share list while the note path is edited", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
    );
    const view = new ShareView({ vault: "personal", fetch: request });
    const target = document.createElement("div");
    document.body.append(target);
    const app = mount(SharesPane, { target, props: { view, note: "Welcome.md" } });
    try {
      await settle();
      expect(request).toHaveBeenCalledTimes(1);
      const note = target.querySelector<HTMLInputElement>("#share-note");
      expect(note?.value).toBe("Welcome.md");
      if (note !== null) {
        note.value = "Another.md";
        note.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await settle();
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      unmount(app);
      target.remove();
    }
  });

  it("recovers the create button after a network failure", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
      )
      .mockRejectedValueOnce(new Error("offline"));
    const view = new ShareView({ vault: "personal", fetch: request });
    const target = document.createElement("div");
    document.body.append(target);
    const app = mount(SharesPane, { target, props: { view, note: "Welcome.md" } });
    try {
      await settle();
      const button = target.querySelector<HTMLButtonElement>('button[type="submit"]');
      button?.click();
      await settle();
      expect(button?.disabled).toBe(false);
      expect(target.textContent).toContain("Could not create this share.");
    } finally {
      unmount(app);
      target.remove();
    }
  });
});
