import { describe, expect, it } from "vitest";

import {
  type CreateResult,
  createNote,
  createRefusal,
  newNotePathFor,
  newNoteSubject,
  readCreated,
} from "./create.js";

describe("newNotePathFor", () => {
  it("puts a bare name beside the note that is open", () => {
    expect(newNotePathFor("Projects/Roadmap.md", "Plan")).toBe("Projects/Plan.md");
  });

  it("puts a bare name at the vault root when nothing is open", () => {
    expect(newNotePathFor(undefined, "Plan")).toBe("Plan.md");
    expect(newNotePathFor("", "Plan")).toBe("Plan.md");
  });

  it("treats a name containing a slash as a path from the vault root", () => {
    expect(newNotePathFor("Projects/Roadmap.md", "Archive/Old")).toBe("Archive/Old.md");
  });

  it("does not add a second extension to a name that has one", () => {
    expect(newNotePathFor(undefined, "Plan.md")).toBe("Plan.md");
  });

  it("trims what was typed", () => {
    expect(newNotePathFor(undefined, "  Plan  ")).toBe("Plan.md");
  });

  it("rejects a name that is not a name", () => {
    for (const typed of ["", "   ", "\t"]) {
      expect(newNotePathFor(undefined, typed)).toBeUndefined();
    }
  });

  it("rejects a name whose segments could climb out of the vault", () => {
    for (const typed of ["../Escaped", "a/../../Escaped", "a//b", "./Hidden", ".hidden/Note"]) {
      expect(newNotePathFor(undefined, typed)).toBeUndefined();
    }
  });

  it("keeps unicode and emoji, which are ordinary in a note name", () => {
    expect(newNotePathFor(undefined, "Ünïcode ✨")).toBe("Ünïcode ✨.md");
  });
});

describe("newNoteSubject", () => {
  it("names the folder the note will land in", () => {
    expect(newNoteSubject("Projects/Roadmap.md")).toBe("In Projects/");
  });

  it("says so plainly when that is the vault root", () => {
    expect(newNoteSubject(undefined)).toBe("At the vault root");
    expect(newNoteSubject("Roadmap.md")).toBe("At the vault root");
  });
});

describe("readCreated", () => {
  it("accepts a well-formed reply", () => {
    expect(readCreated({ path: "Plan.md" })).toEqual({ path: "Plan.md" });
  });

  it("rejects anything else, because the client does not trust the server", () => {
    for (const body of [undefined, null, 42, "Plan.md", {}, { path: "" }, { path: 7 }]) {
      expect(readCreated(body)).toBeUndefined();
    }
  });
});

describe("createRefusal", () => {
  it("keeps a 404 vague, because the server merged four cases into it", () => {
    const message = createRefusal(404, { error: "Private/Salary.md already exists" });
    expect(message).not.toContain("Salary");
    expect(message).toContain("access");
  });

  it("passes a 400 through, because the caller sent the name it names", () => {
    expect(createRefusal(400, { error: "`Plan.md` already exists" })).toBe(
      "`Plan.md` already exists",
    );
  });

  it("falls back to a sentence when the body says nothing usable", () => {
    expect(createRefusal(500, undefined)).toBe("The note could not be created.");
  });
});

describe("createNote", () => {
  function respond(status: number, body: unknown): typeof globalThis.fetch {
    return (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;
  }

  it("posts the path and returns where the note landed", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetch = (async (url: string, init: RequestInit) => {
      seen.url = url;
      seen.init = init;
      return new Response(JSON.stringify({ path: "Projects/Plan.md" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    const result = await createNote("personal", "Projects/Plan.md", { fetch });

    expect(result).toEqual({ ok: { path: "Projects/Plan.md" } });
    expect(seen.url).toBe("/api/v1/vaults/personal/notes");
    expect(seen.init?.method).toBe("POST");
    expect(seen.init?.body).toBe(JSON.stringify({ path: "Projects/Plan.md" }));
  });

  it("escapes a vault slug on its way into the URL", async () => {
    let url = "";
    const fetch = (async (seen: string) => {
      url = seen;
      return new Response(JSON.stringify({ path: "A.md" }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await createNote("a/b", "A.md", { fetch });

    expect(url).toBe("/api/v1/vaults/a%2Fb/notes");
  });

  it("refuses vaguely on a 404", async () => {
    const result = await createNote("personal", "A.md", { fetch: respond(404, {}) });
    expect(result).toEqual({ refused: expect.stringContaining("access") as unknown as string });
  });

  it("reports a reply it cannot understand rather than trusting it", async () => {
    const result = await createNote("personal", "A.md", { fetch: respond(200, { path: 7 }) });
    expect("refused" in result).toBe(true);
  });

  it("reports an unreachable server rather than throwing", async () => {
    const fetch = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof globalThis.fetch;

    const result: CreateResult = await createNote("personal", "A.md", { fetch });

    expect(result).toEqual({ refused: "The server could not be reached." });
  });
});
