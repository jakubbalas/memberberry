import { describe, expect, it } from "vitest";

import { drawingExportsUrl, drawingUrl, loadDrawing, readDrawing, replaceScene } from "./drawing.js";

const markdown = "# Drawing\n```compressed-json\n{\"type\":\"excalidraw\",\"elements\":[]}\n```\n";

describe("drawing transport", () => {
  it("encodes the complete target as one route value", () => {
    expect(drawingUrl("personal space", "drawings/Plans/roadmap.excalidraw")).toBe(
      "/api/v1/vaults/personal%20space/drawings/Plans%2Froadmap.excalidraw.md",
    );
    expect(drawingExportsUrl("v", "plan.excalidraw")).toBe(
      "/api/v1/vaults/v/drawing-exports/plan.excalidraw.md",
    );
  });

  it("accepts only a valid scene payload", () => {
    expect(
      readDrawing({ markdown, revision: "abc", scene: { type: "excalidraw", elements: [] } })
        .markdown,
    ).toBe(markdown);
    expect(() =>
      readDrawing({ markdown, revision: "abc", scene: { type: "other", elements: [] } }),
    ).toThrow("invalid drawing scene");
  });

  it("loads through the requested endpoint and rejects HTTP failures", async () => {
    const requests: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      requests.push(String(input));
      return new Response(
        JSON.stringify({ markdown, revision: "abc", scene: { type: "excalidraw", elements: [] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const drawing = await loadDrawing({ vault: "v", target: "plan.excalidraw", fetch: fetcher });
    expect(drawing.scene["type"]).toBe("excalidraw");
    expect(requests).toEqual(["/api/v1/vaults/v/drawings/plan.excalidraw.md"]);
    await expect(
      loadDrawing({
        vault: "v",
        target: "plan.excalidraw",
        fetch: async () => new Response("", { status: 404 }),
      }),
    ).rejects.toThrow("drawing unavailable");
  });
});

describe("drawing Markdown", () => {
  it("replaces one scene while retaining the surrounding document", () => {
    const updated = replaceScene(markdown, { type: "excalidraw", elements: [{ id: "one" }] });
    expect(updated).toContain("# Drawing");
    expect(updated).toContain('{"type":"excalidraw","elements":[{"id":"one"}]}');
    expect(updated).toContain("```\n");
  });

  it("refuses an incomplete scene fence", () => {
    expect(() => replaceScene("```json\n{}", {})).toThrow("incomplete");
  });
});
