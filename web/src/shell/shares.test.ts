import { describe, expect, it, vi } from "vitest";

import { ShareView } from "./shares.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("ShareView", () => {
  it("loads only validated share metadata", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response([
      { id: 4, note: "Welcome.md", expires_at: 100, include_embeds: true, password_protected: true, access_count: 2 },
      { id: 6, note: "Permanent.md", expires_at: null },
      { id: "leak", note: "Should not render", expires_at: 100 },
      { id: 5, note: "", expires_at: 100 },
    ]));
    const view = new ShareView({ vault: "my vault", fetch: request });
    view.ensure();
    await vi.waitFor(() => expect(view.loading).toBe(false));
    expect(request).toHaveBeenCalledWith("/api/v1/vaults/my%20vault/shares", { headers: { accept: "application/json" } });
    expect(view.links).toHaveLength(2);
    expect(view.links[0]?.note).toBe("Welcome.md");
  });

  it("returns failures instead of leaking rejected fetches", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    const view = new ShareView({ vault: "v", fetch: request });
    await expect(view.create({ note: "Welcome.md", include_embeds: false })).resolves.toBeUndefined();
    await expect(view.revoke(1)).resolves.toBe(false);
  });

  it("creates a never-expiring share explicitly", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ url: "/s/secret", note: "Welcome.md", include_embeds: false, expires_at: null }))
      .mockResolvedValueOnce(response([]));
    const view = new ShareView({ vault: "v", fetch: request });
    const created = await view.create({ note: "Welcome.md", include_embeds: false, never_expires: true });
    expect(created?.expires_at).toBeNull();
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      note: "Welcome.md",
      include_embeds: false,
      never_expires: true,
    });
  });

  it("creates without sending an empty password and removes a revoked link", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ url: "/s/secret", note: "Welcome.md", include_embeds: false, expires_at: 100 }))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const view = new ShareView({ vault: "v", fetch: request });
    const created = await view.create({ note: "Welcome.md", include_embeds: false, password: "" });
    expect(created?.url).toBe("/s/secret");
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({ note: "Welcome.md", include_embeds: false });
    expect(await view.revoke(9)).toBe(true);
  });
});
