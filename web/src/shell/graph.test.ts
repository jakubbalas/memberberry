/**
 * What the client accepts from the graph route, and what a keypress means (§9.4).
 *
 * `graph-layout.test.ts` covers where the nodes end up and `LocalGraph.dom.test.ts` covers
 * what a reader sees. These cover the wire: a response that is not what it claims to be, and
 * the keyboard map the panel drives itself with.
 */

import { describe, expect, it, vi } from "vitest";

import {
  type GraphNode,
  clampHops,
  degrees,
  fetchGraph,
  folderOf,
  graphKeyAction,
  nodeDescription,
  readGraph,
} from "./graph.js";
import { GraphView } from "./graph.svelte.js";

const node = (key: string, hop = 1, path: string | null = `${key}.md`): GraphNode => ({
  key,
  path,
  label: key,
  hop,
});

/** A well-formed response body, in the server's wire shape. */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    note: "A.md",
    hops: 1,
    truncated: false,
    nodes: [
      { key: "n:A.md", path: "A.md", label: "A", hop: 0 },
      { key: "n:B.md", path: "B.md", label: "B", hop: 1 },
    ],
    edges: [{ source: "n:A.md", target: "n:B.md", embed: false }],
    ...overrides,
  };
}

describe("reading a graph response", () => {
  it("keeps a well-formed neighbourhood", () => {
    const graph = readGraph(body());
    expect(graph?.note).toBe("A.md");
    expect(graph?.nodes.map((entry) => entry.key)).toEqual(["n:A.md", "n:B.md"]);
    expect(graph?.edges).toHaveLength(1);
  });

  it("keeps a ghost, which has no path", () => {
    const graph = readGraph(
      body({
        nodes: [
          { key: "n:A.md", path: "A.md", label: "A", hop: 0 },
          { key: "g:someday", path: null, label: "Someday", hop: 1 },
        ],
        edges: [{ source: "n:A.md", target: "g:someday", embed: false }],
      }),
    );
    expect(graph?.nodes[1]?.path).toBeNull();
    expect(graph?.edges).toHaveLength(1);
  });

  it("drops an edge naming a node that is not in the picture", () => {
    // A line to nowhere is the one thing a graph cannot draw honestly, and `layoutGraph`
    // would have no coordinates to give it.
    const graph = readGraph(
      body({
        edges: [{ source: "n:A.md", target: "n:Gone.md", embed: false }],
      }),
    );
    expect(graph?.edges).toEqual([]);
  });

  it("drops a second node claiming a key another node already has", () => {
    const graph = readGraph(
      body({
        nodes: [
          { key: "n:A.md", path: "A.md", label: "A", hop: 0 },
          { key: "n:A.md", path: "Other.md", label: "Other", hop: 1 },
        ],
        edges: [],
      }),
    );
    expect(graph?.nodes).toHaveLength(1);
  });

  it.each([
    [
      "a hop that is not a number",
      { nodes: [{ key: "n:A.md", path: null, label: "A", hop: "1" }] },
    ],
    ["a negative hop", { nodes: [{ key: "n:A.md", path: null, label: "A", hop: -1 }] }],
    ["a key that is not a string", { nodes: [{ key: 7, path: null, label: "A", hop: 0 }] }],
    ["a label that is missing", { nodes: [{ key: "n:A.md", path: null, hop: 0 }] }],
  ])("drops a node with %s", (_, overrides) => {
    // `hop` reaches arithmetic that positions a node, so a string there places it at NaN.
    expect(readGraph(body({ ...overrides, edges: [] }))?.nodes).toEqual([]);
  });

  it.each([
    ["not an object", 7],
    ["missing a note", { hops: 1, truncated: false, nodes: [], edges: [] }],
    ["missing a hop count", { note: "A.md", truncated: false, nodes: [], edges: [] }],
    ["missing the truncation flag", { note: "A.md", hops: 1, nodes: [], edges: [] }],
    [
      "carrying nodes that are not a list",
      { note: "A.md", hops: 1, truncated: false, nodes: {}, edges: [] },
    ],
  ])("refuses a response %s", (_, malformed) => {
    expect(readGraph(malformed)).toBeUndefined();
  });

  it("refuses an edge whose embed flag is not a boolean", () => {
    const graph = readGraph(
      body({ edges: [{ source: "n:A.md", target: "n:B.md", embed: "yes" }] }),
    );
    expect(graph?.edges).toEqual([]);
  });
});

describe("fetching a graph", () => {
  it("asks the graph route for the note, with the hop count in the query", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify(body()), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    await fetchGraph("personal", "Projects/Roadmap.md", 2, { fetch });
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/vaults/personal/graph/Projects/Roadmap.md?hops=2",
      { headers: { accept: "application/json" } },
    );
  });

  it("encodes each path segment but not the separators", async () => {
    // The route is a wildcard, so `/` has to survive; everything else in a segment must not.
    const fetch = vi.fn(
      async () => new Response(JSON.stringify(body()), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    await fetchGraph("personal", "Some Folder/A note #1.md", 1, { fetch });
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/vaults/personal/graph/Some%20Folder/A%20note%20%231.md?hops=1",
      expect.anything(),
    );
  });

  it("clamps the hop count before it reaches the wire", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify(body()), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    await fetchGraph("personal", "A.md", 99, { fetch });
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("hops=3"), expect.anything());
  });

  it("answers undefined rather than an empty graph when the server refuses", async () => {
    // "This note has no neighbours" and "we could not ask" are different statements, and the
    // panel renders them differently.
    const fetch = vi.fn(
      async () => new Response("", { status: 404 }),
    ) as unknown as typeof globalThis.fetch;
    expect(await fetchGraph("personal", "A.md", 1, { fetch })).toBeUndefined();
  });

  it("answers undefined rather than throwing when the request fails", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof globalThis.fetch;
    expect(await fetchGraph("personal", "A.md", 1, { fetch })).toBeUndefined();
  });
});

describe("clamping the hop count", () => {
  it.each([
    [0, 1],
    [1, 1],
    [3, 3],
    [4, 3],
    [-7, 1],
    [2.4, 2],
    [Number.NaN, 1],
    [Number.POSITIVE_INFINITY, 1],
  ])("brings %s into range as %s", (given, expected) => {
    expect(clampHops(given)).toBe(expected);
  });
});

describe("the keyboard", () => {
  it.each([
    ["ArrowDown", 2],
    ["ArrowRight", 2],
    ["ArrowUp", 0],
    ["ArrowLeft", 0],
    ["Home", 0],
    ["End", 3],
  ])("moves the cursor on %s", (key, to) => {
    expect(graphKeyAction(key, 4, 1)).toEqual({ kind: "move", to });
  });

  it("stops at either end rather than wrapping", () => {
    expect(graphKeyAction("ArrowUp", 4, 0)).toEqual({ kind: "move", to: 0 });
    expect(graphKeyAction("ArrowDown", 4, 3)).toEqual({ kind: "move", to: 3 });
  });

  it("opens on Enter and on Space", () => {
    expect(graphKeyAction("Enter", 4, 1)).toEqual({ kind: "open" });
    expect(graphKeyAction(" ", 4, 1)).toEqual({ kind: "open" });
  });

  it("does nothing to an empty picture, so no key is swallowed", () => {
    expect(graphKeyAction("ArrowDown", 0, 0)).toEqual({ kind: "none" });
    expect(graphKeyAction("Enter", 0, 0)).toEqual({ kind: "none" });
  });

  it("leaves every other key alone", () => {
    expect(graphKeyAction("k", 4, 1)).toEqual({ kind: "none" });
    expect(graphKeyAction("Tab", 4, 1)).toEqual({ kind: "none" });
  });

  it("moves from a cursor that is out of range without going further out", () => {
    expect(graphKeyAction("ArrowDown", 3, 99)).toEqual({ kind: "move", to: 2 });
    expect(graphKeyAction("ArrowUp", 3, -4)).toEqual({ kind: "move", to: 0 });
  });
});

describe("what a node is drawn from", () => {
  it("counts an edge for both of the nodes it joins", () => {
    const counted = degrees({
      nodes: [node("a", 0), node("b"), node("c")],
      edges: [
        { source: "a", target: "b", embed: false },
        { source: "a", target: "c", embed: true },
      ],
    });
    expect([...counted]).toEqual([
      ["a", 2],
      ["b", 1],
      ["c", 1],
    ]);
  });

  it("gives a node with no edges a degree of zero rather than no entry", () => {
    expect(degrees({ nodes: [node("a", 0)], edges: [] }).get("a")).toBe(0);
  });

  it("takes a node's folder from its path, and gives a ghost none", () => {
    expect(folderOf(node("n", 1, "Projects/Deep/A.md"))).toBe("Projects/Deep");
    expect(folderOf(node("n", 1, "A.md"))).toBeNull();
    expect(folderOf(node("g", 1, null))).toBeNull();
  });
});

describe("what a node is announced as", () => {
  it("names the note the panel is about", () => {
    expect(nodeDescription(node("A", 0, "A.md"), 0)).toBe("A, this note");
  });

  it("says how far away a neighbour is, in the right plural", () => {
    expect(nodeDescription(node("A", 1, "A.md"), 1)).toBe("A, 1 link away");
    expect(nodeDescription(node("A", 2, "A.md"), 2)).toBe("A, 2 links away");
  });

  it("says a ghost is not a note yet, which is all the client is told", () => {
    // §6.5: the client is not told whether the note is missing or merely not theirs, and
    // must not guess in the one place a reader would believe it.
    expect(nodeDescription(node("Someday", 1, null), 1)).toBe("Someday, no note yet");
  });
});

describe("GraphView", () => {
  const drawn = (note: string, hops: number, keys: readonly string[] = []) => ({
    note,
    hops,
    truncated: false,
    nodes: keys.map((key, index) => ({
      key,
      path: `${key}.md`,
      label: key,
      hop: index,
    })),
    edges: [],
  });

  /** A loader whose answers are released by hand, so ordering is the test's to decide. */
  function deferred() {
    const pending = new Map<string, (value: Awaited<ReturnType<typeof fetchGraph>>) => void>();
    const load = (_vault: string, note: string, hops: number) =>
      new Promise<Awaited<ReturnType<typeof fetchGraph>>>((resolve) => {
        pending.set(`${note}@${hops}`, resolve);
      });
    return { load: load as unknown as typeof fetchGraph, pending };
  }

  it("draws the note it is shown", async () => {
    const load = vi.fn(async () => drawn("A.md", 1, ["n:A.md", "n:B.md"]));
    const view = new GraphView({
      vault: "v",
      load: load as unknown as typeof fetchGraph,
    });
    view.show("A.md");
    expect(view.loading).toBe(true);
    await vi.waitUntil(() => !view.loading);
    expect(view.nodes.map((entry) => entry.key)).toEqual(["n:A.md", "n:B.md"]);
    expect(view.empty).toBe(false);
  });

  it("does not re-fetch the note it is already drawing", async () => {
    const load = vi.fn(async () => drawn("A.md", 1, ["n:A.md"]));
    const view = new GraphView({
      vault: "v",
      load: load as unknown as typeof fetchGraph,
    });
    view.show("A.md");
    await vi.waitUntil(() => !view.loading);
    view.show("A.md");
    view.show("A.md");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("starts at one hop, and refetches when the walk is widened", async () => {
    const load = vi.fn(async (_v: string, _n: string, hops: number) =>
      drawn("A.md", hops, ["n:A.md"]),
    );
    const view = new GraphView({
      vault: "v",
      load: load as unknown as typeof fetchGraph,
    });
    view.show("A.md");
    await vi.waitUntil(() => !view.loading);
    expect(view.hops).toBe(1);
    view.setHops(3);
    await vi.waitUntil(() => !view.loading);
    expect(load).toHaveBeenLastCalledWith("v", "A.md", 3);
    expect(view.hops).toBe(3);
  });

  it("does not refetch when the hop control is set to what it already shows", async () => {
    const load = vi.fn(async () => drawn("A.md", 1, ["n:A.md"]));
    const view = new GraphView({
      vault: "v",
      load: load as unknown as typeof fetchGraph,
    });
    view.show("A.md");
    await vi.waitUntil(() => !view.loading);
    view.setHops(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("shows the walk the server drew, not the one it was asked for", async () => {
    // The server clamps. A control showing its own request would disagree with the picture.
    const load = vi.fn(async () => drawn("A.md", 3, ["n:A.md"]));
    const view = new GraphView({
      vault: "v",
      load: load as unknown as typeof fetchGraph,
    });
    view.setHops(2);
    view.show("A.md");
    await vi.waitUntil(() => !view.loading);
    expect(view.hops).toBe(3);
  });

  it("ignores a late answer for a note that is no longer open", async () => {
    // Switch tabs while the first request is in flight, and the panel would otherwise draw
    // the previous note's neighbourhood around the new note.
    const { load, pending } = deferred();
    const view = new GraphView({ vault: "v", load });
    view.show("First.md");
    view.show("Second.md");
    pending.get("Second.md@1")?.(drawn("Second.md", 1, ["n:Second.md"]));
    pending.get("First.md@1")?.(drawn("First.md", 1, ["n:First.md", "n:Other.md"]));
    await vi.waitUntil(() => !view.loading);
    expect(view.note).toBe("Second.md");
    expect(view.nodes.map((entry) => entry.key)).toEqual(["n:Second.md"]);
  });

  it("ignores a late answer for a hop count that has been changed since", async () => {
    const { load, pending } = deferred();
    const view = new GraphView({ vault: "v", load });
    view.show("A.md");
    view.setHops(3);
    pending.get("A.md@3")?.(drawn("A.md", 3, ["n:A.md"]));
    pending.get("A.md@1")?.(drawn("A.md", 1, ["n:A.md", "n:Stale.md"]));
    await vi.waitUntil(() => !view.loading);
    expect(view.hops).toBe(3);
    expect(view.nodes.map((entry) => entry.key)).toEqual(["n:A.md"]);
  });

  it("reports an unanswered request as unavailable rather than as empty", async () => {
    const load = (async () => undefined) as unknown as typeof fetchGraph;
    const view = new GraphView({ vault: "v", load });
    view.show("A.md");
    await vi.waitUntil(() => view.unavailable);
    expect(view.empty).toBe(false);
    expect(view.nodes).toEqual([]);
  });

  it("calls a picture holding only the note itself empty", async () => {
    const load = vi.fn(async () => drawn("A.md", 1, ["n:A.md"]));
    const view = new GraphView({
      vault: "v",
      load: load as unknown as typeof fetchGraph,
    });
    view.show("A.md");
    await vi.waitUntil(() => !view.loading);
    expect(view.empty).toBe(true);
  });

  it("carries the truncation flag through, because the panel has to say so", async () => {
    const load = vi.fn(async () => ({
      ...drawn("A.md", 1, ["n:A.md", "n:B.md"]),
      truncated: true,
    }));
    const view = new GraphView({
      vault: "v",
      load: load as unknown as typeof fetchGraph,
    });
    view.show("A.md");
    await vi.waitUntil(() => !view.loading);
    expect(view.truncated).toBe(true);
  });

  it("clears when there is no note open", () => {
    const load = vi.fn(async () => drawn("A.md", 1, ["n:A.md"]));
    const view = new GraphView({
      vault: "v",
      load: load as unknown as typeof fetchGraph,
    });
    view.show(undefined);
    expect(view.note).toBeUndefined();
    expect(view.loading).toBe(false);
    expect(view.nodes).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });

  it("re-asks for the same picture on refresh", async () => {
    const load = vi.fn(async () => drawn("A.md", 1, ["n:A.md"]));
    const view = new GraphView({
      vault: "v",
      load: load as unknown as typeof fetchGraph,
    });
    view.show("A.md");
    await vi.waitUntil(() => !view.loading);
    view.refresh();
    await vi.waitUntil(() => !view.loading);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
