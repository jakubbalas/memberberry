import { describe, expect, it } from "vitest";
import { parseShareTarget, submitSharedClip } from "./share-target.js";

describe("parseShareTarget", () => {
  it("prefers the explicit shared URL and preserves metadata", () => {
    expect(parseShareTarget("?url=https%3A%2F%2Fexample.com%2Fa&title=Story&text=Read%20this")).toEqual({
      url: "https://example.com/a",
      title: "Story",
      text: "Read this",
    });
  });

  it("finds a URL in shared text and keeps text-only shares", () => {
    expect(parseShareTarget("?text=Read%20https%3A%2F%2Fexample.com%2Fa")).toMatchObject({ url: "https://example.com/a" });
    expect(parseShareTarget("?title=Thought&text=Remember%20this")).toEqual({ title: "Thought", text: "Remember this" });
    expect(parseShareTarget("")).toBeNull();
  });

  it("submits a shared URL to the selected vault", async () => {
    let body = "";
    const result = await submitSharedClip({ url: "https://example.com/a", title: "Story" }, {
      vault: "personal notes",
      folder: "Clips",
      fetch: async (input, init) => {
        expect(String(input)).toBe("/api/v1/vaults/personal%20notes/clip");
        body = String(init?.body);
        return new Response(JSON.stringify({ path: "Clips/a.md", source: "https://example.com/a" }), { status: 200 });
      },
    });
    expect(result.path).toBe("Clips/a.md");
    expect(body).toContain('"title":"Story"');
    expect(body).toContain('"folder":"Clips"');
  });

  it("uploads shared images before referencing their staged paths in the clip", async () => {
    const requests: Array<{ readonly url: string; readonly body: unknown }> = [];
    const result = await submitSharedClip({
      title: "Photo",
      files: [{ name: "photo.png", type: "image/png", bytes: new Uint8Array([1, 2, 3]).buffer }],
    }, {
      vault: "personal",
      fetch: async (input, init) => {
        requests.push({ url: String(input), body: init?.body });
        if (requests.length === 1) {
          return new Response(JSON.stringify({ path: "media/aa/aa/hash.png" }), { status: 201 });
        }
        return new Response(JSON.stringify({ path: "Clips/Photo.md", source: "" }), { status: 200 });
      },
    });

    expect(result.path).toBe("Clips/Photo.md");
    expect(requests[0]?.url).toBe("/api/v1/vaults/personal/media");
    expect(String(requests[1]?.body)).toContain('"path":"media/aa/aa/hash.png"');
  });
});
