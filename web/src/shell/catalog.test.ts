/**
 * The note index, and which kind of nothing it returned (`SPEC.md` §7.4, §6.5).
 *
 * The three-way answer is the load-bearing part. A `fetch` that returned an empty list for
 * both a refusal and a dead network would force `replica.ts` to choose between two bugs: a
 * revoked user going on reading titles from a stored copy, or a tunnel wiping the offline
 * replica of a 10 000-note vault.
 */

import { describe, expect, it } from "vitest";

import { fetchNotes, noteHint, noteLabel } from "./catalog.js";

function responding(init: { status?: number; body?: unknown } = {}): typeof globalThis.fetch {
  const status = init.status ?? 200;
  return (async () =>
    new Response(status === 204 ? null : JSON.stringify(init.body ?? { notes: [] }), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof globalThis.fetch;
}

describe("fetching the note index", () => {
  it("returns what the server listed", async () => {
    const answer = await fetchNotes("personal", {
      fetch: responding({ body: { notes: [{ path: "One.md", title: "One" }] } }),
    });
    expect(answer).toEqual({ kind: "ok", notes: [{ path: "One.md", title: "One" }] });
  });

  it("drops an entry with the wrong shape rather than rendering it", async () => {
    // AGENTS.md §4.3: a `path` that is not a string reaches a DOM attribute.
    const answer = await fetchNotes("personal", {
      fetch: responding({ body: { notes: [{ path: 7 }, { path: "One.md", title: null }] } }),
    });
    expect(answer).toEqual({ kind: "ok", notes: [{ path: "One.md", title: null }] });
  });

  it.each([404, 401, 403])("reads %d as a refusal", async (status) => {
    // 404 is what a denial looks like here, and what an unknown vault looks like — the
    // invisibility rule requires those to be identical (§6.5).
    expect(await fetchNotes("personal", { fetch: responding({ status }) })).toEqual({
      kind: "denied",
    });
  });

  it("reads a network failure as unreachable, not as a refusal", async () => {
    const failing = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof globalThis.fetch;
    expect(await fetchNotes("personal", { fetch: failing })).toEqual({ kind: "unreachable" });
  });

  it("reads a broken server as unreachable", async () => {
    // A 500 is not a statement about permissions, and neither is a 200 that will not parse.
    // Keeping the replica is the safe direction: it holds nothing this user was not sent.
    expect(await fetchNotes("personal", { fetch: responding({ status: 500 }) })).toEqual({
      kind: "unreachable",
    });
    const garbage = (async () =>
      new Response("{not json", { status: 200 })) as typeof globalThis.fetch;
    expect(await fetchNotes("personal", { fetch: garbage })).toEqual({ kind: "unreachable" });
  });

  it("percent-encodes the vault into the URL", async () => {
    let asked = "";
    const spy = (async (url: string) => {
      asked = url;
      return new Response(JSON.stringify({ notes: [] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    await fetchNotes("a vault/with slashes", { fetch: spy });
    expect(asked).toBe("/api/v1/vaults/a%20vault%2Fwith%20slashes/notes");
  });
});

describe("labelling a note", () => {
  it("prefers the title and falls back to the path", () => {
    expect(noteLabel({ path: "Projects/Roadmap.md", title: "Roadmap" })).toBe("Roadmap");
    expect(noteLabel({ path: "Projects/Roadmap.md", title: null })).toBe("Projects/Roadmap");
  });

  it("hints at the folder only when that adds something", () => {
    expect(noteHint({ path: "Roadmap.md", title: "Roadmap" })).toBeUndefined();
    expect(noteHint({ path: "Projects/Roadmap.md", title: "Roadmap" })).toBe("Projects");
    expect(noteHint({ path: "Projects/2024-01-15.md", title: "Sprint planning" })).toBe(
      "Projects/2024-01-15",
    );
  });
});
