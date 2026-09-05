/**
 * The client's half of a rename (`SPEC.md` §6.6).
 *
 * The interesting assertion here is a *negative* one: `refusal` must not turn a `404` into a
 * more helpful sentence. The server merged "does not exist", "you may not read it" and "you
 * are not in this vault" into one reply on purpose (§6.5), and a client that guessed between
 * them would hand back the distinction the server refused to make.
 */

import { describe, expect, it, vi } from "vitest";

import {
  folderOf,
  noteNameOf,
  notePathFor,
  readRenamed,
  refusal,
  renameNote,
  renameTag,
  renamedMessage,
} from "./rename.js";

describe("notePathFor", () => {
  it("keeps a note in its folder when only a name is typed", () => {
    expect(notePathFor("Projects/Roadmap.md", "Plan")).toBe("Projects/Plan.md");
    expect(notePathFor("Roadmap.md", "Plan")).toBe("Plan.md");
  });

  it("treats a typed path as a move from the vault root", () => {
    expect(notePathFor("Projects/Roadmap.md", "Archive/Plan")).toBe("Archive/Plan.md");
  });

  it("does not add a second extension to a name that has one", () => {
    expect(notePathFor("Roadmap.md", "Plan.md")).toBe("Plan.md");
  });

  it("refuses a name that is not one", () => {
    for (const typed of ["", "   ", "..", "../escape", "a//b", ".hidden", "sub/../up"]) {
      expect(notePathFor("Projects/Roadmap.md", typed), typed).toBeUndefined();
    }
  });

  it("trims what somebody typed, because a trailing space is not part of a name", () => {
    expect(notePathFor("Roadmap.md", "  Plan  ")).toBe("Plan.md");
  });
});

describe("folderOf and noteNameOf", () => {
  it("split a path into the part that stays and the part being renamed", () => {
    expect(folderOf("Projects/Sub/Roadmap.md")).toBe("Projects/Sub/");
    expect(folderOf("Roadmap.md")).toBe("");
    expect(noteNameOf("Projects/Roadmap.md")).toBe("Roadmap");
    expect(noteNameOf("Notes")).toBe("Notes");
  });
});

describe("refusal", () => {
  it("keeps a 404 ambiguous", () => {
    // The three cases the server merged must stay merged. A message naming any one of them
    // would report the existence of a note the server declined to admit to (§6.5).
    const message = refusal(404, {});
    expect(message).toContain("may not exist");
    expect(message).toContain("may not have access");
  });

  it("repeats a message about the name the caller sent", () => {
    expect(refusal(400, { error: "`Plan.md` already exists" })).toBe("`Plan.md` already exists");
  });

  it("falls back rather than showing an empty sentence", () => {
    expect(refusal(500, undefined)).toBe("The rename failed.");
    expect(refusal(409, { error: "" })).toContain("could not be rewritten safely");
  });
});

describe("readRenamed", () => {
  it("accepts a well-formed reply", () => {
    expect(readRenamed({ to: "Plan.md", notes: 2, references: 3 })).toEqual({
      to: "Plan.md",
      notes: 2,
      references: 3,
    });
  });

  it("rejects anything that would reach the DOM as nonsense", () => {
    for (const body of [
      undefined,
      null,
      "Plan.md",
      { to: "", notes: 1, references: 1 },
      { to: "Plan.md", notes: "2", references: 1 },
      { to: "Plan.md", notes: -1, references: 1 },
      { to: "Plan.md", notes: Number.NaN, references: 1 },
      { to: "Plan.md", notes: 1 },
    ]) {
      expect(readRenamed(body), JSON.stringify(body) ?? "undefined").toBeUndefined();
    }
  });
});

describe("renamedMessage", () => {
  it("says what the count actually means", () => {
    // "notes you can see", not "notes": the rewrite reached further and the reply does not
    // say how much further (§6.6).
    expect(renamedMessage({ to: "Plan.md", notes: 2, references: 3 })).toBe(
      "Renamed to Plan.md. Updated 3 references in 2 notes you can see.",
    );
    expect(renamedMessage({ to: "Plan.md", notes: 1, references: 1 })).toBe(
      "Renamed to Plan.md. Updated 1 reference in 1 note you can see.",
    );
  });

  it("does not claim to have updated nothing", () => {
    expect(renamedMessage({ to: "Plan.md", notes: 0, references: 0 })).toBe("Renamed to Plan.md.");
  });
});

describe("renameNote and renameTag", () => {
  function respond(status: number, body: unknown): typeof globalThis.fetch {
    return vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof globalThis.fetch;
  }

  it("posts the note form and returns what the server counted", async () => {
    const fetch = respond(200, { to: "Plan.md", notes: 1, references: 2 });
    const result = await renameNote("personal", "Roadmap.md", "Plan.md", { fetch });
    expect(result).toEqual({ ok: { to: "Plan.md", notes: 1, references: 2 } });
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/v1/vaults/personal/rename");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      kind: "note",
      from: "Roadmap.md",
      to: "Plan.md",
    });
  });

  it("posts the tag form", async () => {
    const fetch = respond(200, { to: "work", notes: 1, references: 1 });
    await renameTag("personal", "project", "work", { fetch });
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(String(init.body))).toEqual({ kind: "tag", from: "project", to: "work" });
  });

  it("reports a refusal rather than throwing", async () => {
    const result = await renameNote("personal", "A.md", "B.md", {
      fetch: respond(404, {}),
    });
    expect(result).toEqual({ refused: refusal(404, {}) });
  });

  it("reports a reply it cannot understand instead of pretending it worked", async () => {
    const result = await renameNote("personal", "A.md", "B.md", {
      fetch: respond(200, { to: 7 }),
    });
    expect(result).toEqual({
      refused: "The server answered something this version does not understand.",
    });
  });

  it("survives a network that is not there", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof globalThis.fetch;
    const result = await renameNote("personal", "A.md", "B.md", { fetch });
    expect(result).toEqual({ refused: "The server could not be reached." });
  });
});
