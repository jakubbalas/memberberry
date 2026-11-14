// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import TrashPane from "./TrashPane.svelte";
import { TrashView } from "./trash.js";

// why: jsdom has no modal dialogs; the browser behaviour is covered by e2e/tree-delete.spec.ts.
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});

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

  it("moves the current note to trash only after the in-app confirmation", async () => {
    // why: `window.confirm` is a silent Cancel in the desktop app's WKWebView (§7.6).
    const nativeConfirm = vi.spyOn(globalThis, "confirm").mockReturnValue(false);
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ entries: [] })))
      .mockResolvedValueOnce(new Response("{}"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ entries: [] })));
    const ondeleted = vi.fn();
    const view = new TrashView({ vault: "personal", request });
    const target = document.createElement("div");
    document.body.append(target);
    const app = mount(TrashPane, { target, props: { view, note: "Notes/Plan ✨.md", ondeleted } });
    try {
      await vi.waitFor(() => expect(target.textContent).toContain("Trash is empty."));
      target.querySelector<HTMLButtonElement>(".trash-delete")?.click();
      await tick();
      const dialog = target.querySelector<HTMLDialogElement>('dialog[aria-label="Move note to trash?"]');
      expect(dialog?.textContent).toContain("Notes/Plan ✨.md");
      expect(request).toHaveBeenCalledTimes(1);
      dialog?.querySelector<HTMLButtonElement>('[type="submit"]')?.click();
      await vi.waitFor(() => expect(target.textContent).toContain("Note moved to trash."));
      expect(request.mock.calls[1]).toEqual(["/api/v1/vaults/personal/notes/Notes/Plan%20%E2%9C%A8.md", { method: "DELETE" }]);
      expect(ondeleted).toHaveBeenCalledOnce();
      expect(target.querySelector("dialog")).toBeNull();
      expect(nativeConfirm).not.toHaveBeenCalled();
    } finally {
      nativeConfirm.mockRestore();
      unmount(app);
      target.remove();
    }
  });

  it("cancelling the confirmation sends nothing", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ entries: [] })));
    const view = new TrashView({ vault: "personal", request });
    const target = document.createElement("div");
    document.body.append(target);
    const app = mount(TrashPane, { target, props: { view, note: "Plan.md" } });
    try {
      await vi.waitFor(() => expect(target.textContent).toContain("Trash is empty."));
      target.querySelector<HTMLButtonElement>(".trash-delete")?.click();
      await tick();
      target.querySelector<HTMLButtonElement>("dialog .rename-cancel")?.click();
      await tick();
      expect(target.querySelector("dialog")).toBeNull();
      expect(request.mock.calls.every(([, init]) => init?.method !== "DELETE")).toBe(true);
    } finally {
      unmount(app);
      target.remove();
    }
  });
});
