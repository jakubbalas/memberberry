import { describe, expect, it, vi } from "vitest";

import { HistoryView } from "./history.js";

function response(body: unknown, ok = true, contentType = "application/json"): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: ok ? 200 : 404,
    headers: { "content-type": contentType },
  });
}

describe("HistoryView", () => {
  it("validates version metadata and encodes note path segments", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({
      versions: [{ id: "1-a", timestamp: 1, actor: "alice", bytes: 4, content_hash: "a" }, { id: 4 }],
    }));
    const view = new HistoryView({ vault: "personal", fetch });
    await view.refresh("Projects/Plan.md");
    expect(view.versions).toHaveLength(1);
    expect(view.versions[0]?.size_delta).toBe(0);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/v1/vaults/personal/history/Projects/Plan.md");
  });

  it("reads, diffs, and restores through the typed endpoints", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ versions: [] }))
      .mockResolvedValueOnce(response("old\n", true, "text/markdown"))
      .mockResolvedValueOnce(response({ from: "a", to: "b", parts: [{ kind: "removed", text: "old" }] }))
      .mockResolvedValueOnce(response({ restored: "a" }));
    const view = new HistoryView({ vault: "personal", fetch });
    await view.refresh("Plan.md");
    expect(await view.read("Plan.md", "a/b")).toBe("old\n");
    expect(await view.diff("Plan.md", "a", "b")).toEqual({ from: "a", to: "b", parts: [{ kind: "removed", text: "old" }] });
    expect(await view.restore("Plan.md", "a")).toBe(true);
    expect(fetch.mock.calls[3]?.[1]).toMatchObject({ method: "POST", body: JSON.stringify({ version: "a" }) });
  });

  it("does not let an older response replace a newer note request", async () => {
    let resolveFirst: ((value: Response) => void) | undefined;
    const first = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(response({ versions: [{ id: "new", timestamp: 2, actor: "alice", bytes: 1, content_hash: "b" }] }));
    const view = new HistoryView({ vault: "personal", fetch });
    const oldRequest = view.refresh("Old.md");
    await view.refresh("New.md");
    resolveFirst?.(response({ versions: [{ id: "old", timestamp: 1, actor: "alice", bytes: 1, content_hash: "a" }] }));
    await oldRequest;
    expect(view.versions[0]?.id).toBe("new");
  });

  it("derives each displayed size delta from the preceding version", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ versions: [
      { id: "one", timestamp: 1, actor: "alice", bytes: 10, content_hash: "a" },
      { id: "two", timestamp: 2, actor: "alice", bytes: 7, content_hash: "b" },
    ] }));
    const view = new HistoryView({ vault: "personal", fetch });
    await view.refresh("Plan.md");
    expect(view.versions.map((version) => version.size_delta)).toEqual([0, -3]);
  });
});
