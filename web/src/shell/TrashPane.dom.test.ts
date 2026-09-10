// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { describe, expect, it, vi } from "vitest";

import TrashPane from "./TrashPane.svelte";
import { TrashView } from "./trash.js";

describe("TrashPane", () => {
  it("lists a deleted note and restores it", async () => {
    const id = "a".repeat(32);
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ entries: [{ id, path: "Plan.md", deleted_at: 1, actor: "alice" }] })))
      .mockResolvedValueOnce(new Response("{}"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ entries: [] })));
    const view = new TrashView({ vault: "personal", request });
    const target = document.createElement("div");
    document.body.append(target);
    const app = mount(TrashPane, { target, props: { view, note: "Current.md" } });
    try {
      await vi.waitFor(() => expect(target.querySelectorAll(".trash-row")).toHaveLength(1));
      expect(target.textContent).toContain("Plan.md");
      target.querySelector<HTMLButtonElement>(".trash-row button")?.click();
      await vi.waitFor(() => expect(target.textContent).toContain("Note restored."));
      expect(request.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
    } finally {
      unmount(app);
      target.remove();
    }
  });
});
