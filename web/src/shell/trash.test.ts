import { describe, expect, it, vi } from "vitest";
import { TrashView } from "./trash.js";

function response(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), { status: ok ? 200 : 404 });
}

describe("TrashView", () => {
  it("calls the browser fetch implementation with its required global receiver", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(function (this: unknown) {
      expect(this).toBe(globalThis);
      return Promise.resolve(response({ entries: [] }));
    });

    try {
      await new TrashView({ vault: "personal" }).refresh();
    } finally {
      request.mockRestore();
    }
  });

  it("lists entries and encodes note path segments for deletion", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ entries: [{ id: "a".repeat(32), path: "Folder/One.md", deleted_at: 1, actor: "alice" }] }))
      .mockResolvedValueOnce(response({}));
    const view = new TrashView({ vault: "personal", request });

    await view.refresh();
    expect(view.entries[0]?.path).toBe("Folder/One.md");
    expect(await view.delete("Folder/One.md")).toBe(true);
    expect(request.mock.calls[1]?.[0]).toBe("/api/v1/vaults/personal/notes/Folder/One.md");
    expect(request.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
  });

  it("restores by opaque id and reports server refusals", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response({}, false));
    const view = new TrashView({ vault: "personal", request });

    expect(await view.restore("a".repeat(32))).toBe(false);
    expect(request.mock.calls[0]?.[0]).toBe(`/api/v1/vaults/personal/trash/${"a".repeat(32)}`);
  });

  it("turns delete and restore network failures into visible refusals", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    const view = new TrashView({ vault: "personal", request });

    await expect(view.delete("Plan.md")).resolves.toBe(false);
    await expect(view.restore("a".repeat(32))).resolves.toBe(false);
  });
});
