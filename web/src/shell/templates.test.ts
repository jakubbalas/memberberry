import { describe, expect, it } from "vitest";

import { fetchTemplates, readTemplate } from "./templates.js";

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), init);
}

describe("templates", () => {
  it("validates the template index shape and preserves server order", async () => {
    const result = await fetchTemplates("personal", async (input) => {
      expect(input).toBe("/api/v1/vaults/personal/templates");
      return response({ folder: "Templates", templates: [{ path: "Templates/meeting.md", name: "meeting" }] });
    });
    expect(result).toEqual({ folder: "Templates", templates: [{ path: "Templates/meeting.md", name: "meeting" }] });
  });

  it("encodes every path segment when reading a template", async () => {
    const body = await readTemplate("my vault", "Templates/Team Notes/meeting.md", async (input) => {
      expect(input).toBe("/api/v1/vaults/my%20vault/templates/Templates/Team%20Notes/meeting.md");
      return response("# Meeting");
    });
    expect(body).toBe("# Meeting");
  });

  it("rejects an unavailable template index", async () => {
    await expect(fetchTemplates("personal", async () => response({}, { status: 404 }))).rejects.toThrow("unavailable");
  });
});
