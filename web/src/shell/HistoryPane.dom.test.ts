// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { describe, expect, it, vi } from "vitest";

import HistoryPane from "./HistoryPane.svelte";
import { HistoryView } from "./history.js";

describe("HistoryPane", () => {
  it("renders versions and exposes preview, compare, and restore controls", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ versions: [
        { id: "one", timestamp: 1, actor: "alice", bytes: 3, content_hash: "a" },
        { id: "two", timestamp: 2, actor: "bob", bytes: 4, content_hash: "b" },
      ] })))
      .mockResolvedValueOnce(new Response("old\n"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ from: "one", to: "two", parts: [{ kind: "added", text: "new" }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ restored: "one" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ versions: [
        { id: "one", timestamp: 1, actor: "alice", bytes: 3, content_hash: "a" },
        { id: "two", timestamp: 2, actor: "bob", bytes: 4, content_hash: "b" },
      ] })));
    const view = new HistoryView({ vault: "personal", fetch });
    const target = document.createElement("div");
    document.body.append(target);
    const app = mount(HistoryPane, { target, props: { view, note: "Plan.md" } });
    await Promise.resolve();
    await Promise.resolve();
    await tick();
    await tick();
    expect(view.versions).toHaveLength(2);
    await vi.waitFor(() => expect(target.querySelectorAll(".history-row")).toHaveLength(2));
    const buttons = [...target.querySelectorAll<HTMLButtonElement>(".history-actions button")];
    buttons[0]?.click();
    await vi.waitFor(() => expect(target.querySelector(".history-preview")).not.toBeNull());
    const checks = [...target.querySelectorAll<HTMLInputElement>(".history-select input")];
    checks.forEach((check) => check.click());
    await tick();
    const compare = target.querySelector<HTMLButtonElement>(".history-compare");
    expect(compare?.disabled).toBe(false);
    compare?.click();
    await vi.waitFor(() => expect(target.querySelector(".history-diff")).not.toBeNull());
    buttons[1]?.click();
    await vi.waitFor(() => expect(target.textContent).toContain("Version restored as an edit."));
    expect(fetch.mock.calls[3]?.[1]).toMatchObject({ method: "POST" });
    unmount(app);
  });
});
