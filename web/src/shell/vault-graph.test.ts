/**
 * Reading the whole-vault payload (§9.4).
 *
 * The edge encoding is what most of this is about. Nodes are ordinary JSON and validated the
 * way every other response on this side is; edges are flat index triples, which is the one
 * place in the project where the wire format cannot be read by eye — so the interesting
 * cases are all the ones where an index means something it should not.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { EDGE_STRIDE, fetchVaultGraph, folderOf, readVaultGraph } from "./vault-graph.js";

/** A node as the server writes one. */
const node = (key: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  key,
  path: key.startsWith("g:") ? null : key.slice(2),
  label: key.slice(2),
  icon: null,
  degree: 0,
  words: 0,
  created: null,
  tags: [],
  ...extra,
});

const body = (
  nodes: readonly Record<string, unknown>[],
  edges: readonly number[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  total: nodes.length,
  truncated: false,
  nodes,
  edges,
  ...extra,
});

describe("reading a payload", () => {
  it("keeps the nodes in the order the server sent them", () => {
    const graph = readVaultGraph(body([node("n:A.md"), node("n:B.md")], [0, 1, 0]));
    expect(graph?.nodes.map((entry) => entry.key)).toEqual(["n:A.md", "n:B.md"]);
    expect(Array.from(graph?.edges ?? [])).toEqual([0, 1, 0]);
  });

  it("reads what a node is drawn from", () => {
    const graph = readVaultGraph(
      body(
        [
          node("n:A.md", {
            label: "The Plan",
            icon: "🗺️",
            degree: 4,
            words: 120,
            created: "2026-08-28",
            tags: ["project/mb"],
          }),
        ],
        [],
      ),
    );
    expect(graph?.nodes[0]).toEqual({
      key: "n:A.md",
      path: "A.md",
      label: "The Plan",
      icon: "🗺️",
      degree: 4,
      words: 120,
      created: "2026-08-28",
      tags: ["project/mb"],
    });
  });

  it("reads a ghost as a node with no path", () => {
    const graph = readVaultGraph(body([node("g:someday", { label: "Someday" })], []));
    expect(graph?.nodes[0]?.path).toBeNull();
    expect(graph?.nodes[0]?.label).toBe("Someday");
  });

  it("carries the total and the truncation flag", () => {
    const graph = readVaultGraph(body([node("n:A.md")], [], { total: 10_431, truncated: true }));
    expect(graph?.total).toBe(10_431);
    expect(graph?.truncated).toBe(true);
  });

  it("refuses a body that is not a graph at all", () => {
    for (const bad of [undefined, null, 7, "graph", [], {}]) {
      expect(readVaultGraph(bad)).toBeUndefined();
    }
  });

  it("refuses a total that is not a count", () => {
    for (const total of [-1, 1.5, "10", null, Number.NaN]) {
      expect(readVaultGraph(body([], [], { total }))).toBeUndefined();
    }
  });

  it("refuses a truncation flag that is not a flag", () => {
    expect(readVaultGraph(body([], [], { truncated: "yes" }))).toBeUndefined();
  });

  it("refuses a payload whose nodes or edges are not lists", () => {
    expect(readVaultGraph({ total: 0, truncated: false, nodes: {}, edges: [] })).toBeUndefined();
    expect(readVaultGraph({ total: 0, truncated: false, nodes: [], edges: {} })).toBeUndefined();
  });
});

describe("a node it should not trust", () => {
  it("drops one with no key", () => {
    const graph = readVaultGraph(body([node("n:A.md", { key: "" }), node("n:B.md")], []));
    expect(graph?.nodes.map((entry) => entry.key)).toEqual(["n:B.md"]);
  });

  it("drops a second node with the same key", () => {
    // Two nodes answering to one index is an edge that draws to whichever won.
    const graph = readVaultGraph(body([node("n:A.md"), node("n:A.md")], []));
    expect(graph?.nodes).toHaveLength(1);
  });

  it("drops one whose degree or word count is not a count", () => {
    for (const bad of [{ degree: -1 }, { degree: "4" }, { words: 1.5 }, { words: null }]) {
      const graph = readVaultGraph(body([node("n:A.md", bad)], []));
      expect(graph?.nodes, JSON.stringify(bad)).toHaveLength(0);
    }
  });

  it("drops one whose label or path is the wrong shape", () => {
    for (const bad of [
      { label: 7 },
      { path: 7 },
      { tags: "project" },
      { created: 20260828 },
      { icon: 7 },
    ]) {
      const graph = readVaultGraph(body([node("n:A.md", bad)], []));
      expect(graph?.nodes, JSON.stringify(bad)).toHaveLength(0);
    }
  });

  it("keeps only the tags that are strings", () => {
    const graph = readVaultGraph(body([node("n:A.md", { tags: ["a", 7, null, "b"] })], []));
    expect(graph?.nodes[0]?.tags).toEqual(["a", "b"]);
  });

  it("renumbers nothing when it drops a node, because indices are the server's", () => {
    // A dropped node shifts every index after it, so an edge naming index 1 would silently
    // become an edge to what used to be index 2. Dropping the edges that no longer resolve
    // is the only honest answer: the alternative draws a line between two notes that are
    // not linked.
    const graph = readVaultGraph(
      body([node("n:A.md"), node("n:B.md", { key: "" }), node("n:C.md")], [0, 2, 0, 0, 1, 0]),
    );
    expect(graph?.nodes.map((entry) => entry.key)).toEqual(["n:A.md", "n:C.md"]);
    expect(Array.from(graph?.edges ?? [])).toEqual([0, 1, 0]);
  });
});

describe("an edge it should not trust", () => {
  const two = [node("n:A.md"), node("n:B.md")];

  it("drops one whose index is not a node", () => {
    expect(Array.from(readVaultGraph(body(two, [0, 5, 0]))?.edges ?? [])).toEqual([]);
    expect(Array.from(readVaultGraph(body(two, [7, 1, 0]))?.edges ?? [])).toEqual([]);
  });

  it("drops one whose index is not a whole number", () => {
    for (const bad of [[0.5, 1, 0], [-1, 1, 0], ["0", 1, 0], [null, 1, 0]]) {
      expect(Array.from(readVaultGraph(body(two, bad as number[]))?.edges ?? [])).toEqual([]);
    }
  });

  it("drops one whose embed flag is neither yes nor no", () => {
    for (const flag of [2, -1, 0.5, "1"]) {
      expect(Array.from(readVaultGraph(body(two, [0, 1, flag] as number[]))?.edges ?? [])).toEqual(
        [],
      );
    }
  });

  it("drops a self-loop, which nothing can draw", () => {
    expect(Array.from(readVaultGraph(body(two, [1, 1, 0]))?.edges ?? [])).toEqual([]);
  });

  it("ignores a trailing part-triple rather than reading past the end", () => {
    const graph = readVaultGraph(body(two, [0, 1, 0, 1]));
    expect(Array.from(graph?.edges ?? [])).toEqual([0, 1, 0]);
  });

  it("keeps the good edges either side of a bad one", () => {
    const three = [node("n:A.md"), node("n:B.md"), node("n:C.md")];
    const graph = readVaultGraph(body(three, [0, 1, 0, 0, 9, 0, 1, 2, 1]));
    expect(Array.from(graph?.edges ?? [])).toEqual([0, 1, 0, 1, 2, 1]);
  });

  it("hands back a typed array, which is what the worker is given", () => {
    const graph = readVaultGraph(body(two, [0, 1, 1]));
    expect(graph?.edges).toBeInstanceOf(Uint32Array);
    expect(graph?.edges.length).toBe(EDGE_STRIDE);
  });
});

describe("fetching", () => {
  const ok = (payload: unknown): typeof globalThis.fetch =>
    (async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;

  it("asks the vault's own route", async () => {
    const seen: string[] = [];
    const request = (async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify(body([], [])), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    await fetchVaultGraph("my vault", { fetch: request });
    expect(seen).toEqual(["/api/v1/vaults/my%20vault/graph"]);
  });

  it("passes a cap on when it is given one", async () => {
    const seen: string[] = [];
    const request = (async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify(body([], [])), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    await fetchVaultGraph("v", { fetch: request, limit: 2000 });
    await fetchVaultGraph("v", { fetch: request, limit: 12.7 });
    expect(seen).toEqual(["/api/v1/vaults/v/graph?limit=2000", "/api/v1/vaults/v/graph?limit=12"]);
  });

  it("answers nothing when the server refuses, rather than an empty vault", async () => {
    // "This vault has no notes" and "we could not ask" are different statements, and the
    // view renders them differently — drawing the second as the first is a lie the reader
    // cannot see through.
    const refused = (async () => new Response("no", { status: 404 })) as typeof globalThis.fetch;
    expect(await fetchVaultGraph("v", { fetch: refused })).toBeUndefined();
  });

  it("answers nothing when the request throws", async () => {
    const broken = (async () => {
      throw new Error("offline");
    }) as unknown as typeof globalThis.fetch;
    expect(await fetchVaultGraph("v", { fetch: broken })).toBeUndefined();
  });

  it("answers nothing when the body is not a graph", async () => {
    expect(await fetchVaultGraph("v", { fetch: ok({ nodes: "lots" }) })).toBeUndefined();
  });

  it("reads a graph the server did send", async () => {
    const graph = await fetchVaultGraph("v", {
      fetch: ok(body([node("n:A.md"), node("n:B.md")], [0, 1, 0])),
    });
    expect(graph?.nodes).toHaveLength(2);
  });
});

describe("a node's folder", () => {
  it("is the path above the file, and null at the vault root", () => {
    expect(folderOf({ ...node("n:Projects/Q3.md") } as never)).toBe("Projects");
    expect(folderOf({ ...node("n:A.md") } as never)).toBeNull();
  });

  it("is null for a ghost, which has no note to be anywhere", () => {
    expect(folderOf({ ...node("g:someday") } as never)).toBeNull();
  });
});

// ------------------------------------------------------------------ properties

describe("every payload", () => {
  it("leaves every edge pointing at a node it drew", () => {
    // The invariant the rest of the client is allowed to assume, so that nothing downstream
    // has to check an index again: the layout writes into typed arrays sized by node count,
    // and an index past the end there is a silent no-op rather than an error.
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 30 }),
        fc.array(fc.integer({ min: -3, max: 40 }), { maxLength: 90 }),
        (keys, numbers) => {
          const graph = readVaultGraph(
            body(
              keys.map((key) => node(`n:${key}`)),
              numbers,
            ),
          );
          expect(graph).toBeDefined();
          const edges = graph?.edges ?? new Uint32Array(0);
          expect(edges.length % EDGE_STRIDE).toBe(0);
          for (let at = 0; at < edges.length; at += EDGE_STRIDE) {
            expect(edges[at]).toBeLessThan(graph?.nodes.length ?? 0);
            expect(edges[at + 1]).toBeLessThan(graph?.nodes.length ?? 0);
            expect(edges[at]).not.toBe(edges[at + 1]);
            expect([0, 1]).toContain(edges[at + 2]);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
