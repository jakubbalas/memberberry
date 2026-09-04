/**
 * The tag tree the pane renders, and what the client accepts from the server (§9.3).
 *
 * `TagPane.dom.test.ts` covers what a reader sees; these cover the shape of it — the tree
 * assembled from flat prefix rows, the keyboard, and a response that is not what it claims.
 */

import { describe, expect, it, vi } from "vitest";

import {
  type TagCount,
  type TagNode,
  buildTagTree,
  fetchTaggedNotes,
  fetchTags,
  readTaggedNotes,
  readTags,
  tagKeyAction,
  taggedLabel,
  visibleTagRows,
} from "./tags.js";

const count = (key: string, notes: number, tag = key): TagCount => ({ key, tag, notes });

/** `key(count)` for every node, depth-first — the shape of the tree in one line. */
function outline(tree: readonly TagNode[]): string[] {
  return tree.flatMap((node) => [`${node.key}(${node.notes})`, ...outline(node.children)]);
}

describe("the tag tree", () => {
  it("nests a tag under every prefix of itself", () => {
    expect(
      outline(
        buildTagTree([
          count("project", 2),
          count("project/memberberry", 1),
          count("project/memberberry/spec", 1),
        ]),
      ),
    ).toEqual(["project(2)", "project/memberberry(1)", "project/memberberry/spec(1)"]);
  });

  it("labels a node with its own segment, as somebody wrote it", () => {
    const [root] = buildTagTree([
      count("project", 1, "Project"),
      count("project/memberberry", 1, "Project/Memberberry"),
    ]);
    expect(root?.name).toBe("Project");
    expect(root?.children[0]?.name).toBe("Memberberry");
  });

  it("sorts siblings the way a file manager does, digits included", () => {
    expect(
      outline(buildTagTree([count("q10", 1), count("q2", 1), count("alpha", 1, "Alpha")])),
    ).toEqual([
      "alpha(1)",
      "q2(1)",
      "q10(1)",
    ]);
  });

  it("keeps a child whose parent row is missing, by inventing the parent", () => {
    // The server sends every prefix, so this should not happen — and a child that vanished
    // because of it would be a tag the pane silently cannot reach.
    expect(outline(buildTagTree([count("project/memberberry", 3)]))).toEqual([
      "project(0)",
      "project/memberberry(3)",
    ]);
  });

  it("is empty for a vault with no tags", () => {
    expect(buildTagTree([])).toEqual([]);
  });
});

describe("the visible rows", () => {
  const tree = buildTagTree([
    count("project", 2),
    count("project/memberberry", 1),
    count("zeta", 1),
  ]);

  it("hides the children of a collapsed node", () => {
    const rows = visibleTagRows(tree, new Set());
    expect(rows.map((row) => row.node.key)).toEqual(["project", "zeta"]);
    expect(rows[0]?.expanded).toBe(false);
  });

  it("shows them when it is expanded, one level deeper", () => {
    const rows = visibleTagRows(tree, new Set(["project"]));
    expect(rows.map((row) => row.node.key)).toEqual([
      "project",
      "project/memberberry",
      "zeta",
    ]);
    expect(rows[1]?.depth).toBe(1);
  });

  it("marks a leaf as neither expanded nor collapsed", () => {
    // `undefined` rather than `false`: a node with no children has nothing to open, and the
    // pane draws a twisty for exactly the rows that do.
    expect(visibleTagRows(tree, new Set())[1]?.expanded).toBeUndefined();
  });
});

describe("the tag tree keyboard", () => {
  const tree = buildTagTree([
    count("project", 2),
    count("project/memberberry", 1),
    count("zeta", 1),
  ]);
  const collapsed = visibleTagRows(tree, new Set());
  const expanded = visibleTagRows(tree, new Set(["project"]));

  it("moves down, up, and to either end", () => {
    expect(tagKeyAction("ArrowDown", collapsed, 0)).toEqual({ kind: "move", to: 1 });
    expect(tagKeyAction("ArrowUp", collapsed, 1)).toEqual({ kind: "move", to: 0 });
    expect(tagKeyAction("End", collapsed, 0)).toEqual({ kind: "move", to: 1 });
    expect(tagKeyAction("Home", collapsed, 1)).toEqual({ kind: "move", to: 0 });
  });

  it("stops at the ends rather than wrapping", () => {
    expect(tagKeyAction("ArrowUp", collapsed, 0)).toEqual({ kind: "none" });
    expect(tagKeyAction("ArrowDown", collapsed, collapsed.length - 1)).toEqual({
      kind: "none",
    });
  });

  it("opens a closed node with Right and steps into an open one", () => {
    expect(tagKeyAction("ArrowRight", collapsed, 0)).toEqual({
      kind: "expand",
      key: "project",
    });
    expect(tagKeyAction("ArrowRight", expanded, 0)).toEqual({ kind: "move", to: 1 });
  });

  it("closes an open node with Left and steps out to the parent", () => {
    expect(tagKeyAction("ArrowLeft", expanded, 0)).toEqual({
      kind: "collapse",
      key: "project",
    });
    expect(tagKeyAction("ArrowLeft", expanded, 1)).toEqual({ kind: "move", to: 0 });
  });

  it("does nothing at a leaf that has no parent above it", () => {
    expect(tagKeyAction("ArrowRight", collapsed, 1)).toEqual({ kind: "none" });
    expect(tagKeyAction("ArrowLeft", collapsed, 1)).toEqual({ kind: "none" });
  });

  it("selects the tag on Enter or Space, whether or not it has children", () => {
    // why: pinned. In the note tree Enter *toggles* a folder, and a tag pane that inherited
    // that would leave every parent tag unselectable from the keyboard — §8.4 does not allow
    // a mouse-only feature.
    for (const key of ["Enter", " "]) {
      expect(tagKeyAction(key, expanded, 0)).toEqual({ kind: "select", key: "project" });
      expect(tagKeyAction(key, expanded, 2)).toEqual({ kind: "select", key: "zeta" });
    }
  });

  it("ignores a key it has no meaning for, and a cursor off the end", () => {
    expect(tagKeyAction("a", collapsed, 0)).toEqual({ kind: "none" });
    expect(tagKeyAction("ArrowDown", collapsed, 99)).toEqual({ kind: "none" });
  });
});

describe("reading the tag tree response", () => {
  it("accepts the shape the server sends", () => {
    expect(readTags({ tags: [{ tag: "Project", key: "project", notes: 3 }] })).toEqual([
      { tag: "Project", key: "project", notes: 3 },
    ]);
  });

  it("drops an entry of the wrong shape rather than rendering it", () => {
    expect(
      readTags({
        tags: [
          { tag: "ok", key: "ok", notes: 1 },
          { tag: 7, key: "bad", notes: 1 },
          { tag: "bad", key: "", notes: 1 },
          { tag: "bad", key: "bad", notes: "many" },
          { tag: "bad", key: "bad", notes: -1 },
          null,
        ],
      }),
    ).toEqual([{ tag: "ok", key: "ok", notes: 1 }]);
  });

  it("refuses a body that is not a tag list at all", () => {
    expect(readTags(null)).toBeUndefined();
    expect(readTags({})).toBeUndefined();
    expect(readTags({ tags: "project" })).toBeUndefined();
  });
});

describe("reading the notes under a tag", () => {
  it("accepts the shape the server sends", () => {
    expect(
      readTaggedNotes({ tag: "project", notes: [{ path: "A.md", title: null }] }),
    ).toEqual({ tag: "project", notes: [{ path: "A.md", title: null }] });
  });

  it("drops a note of the wrong shape", () => {
    expect(
      readTaggedNotes({
        tag: "project",
        notes: [{ path: "A.md", title: "A" }, { path: 1 }, { path: "B.md", title: 2 }],
      }),
    ).toEqual({ tag: "project", notes: [{ path: "A.md", title: "A" }] });
  });

  it("refuses a body that is not an answer about a tag", () => {
    expect(readTaggedNotes({ notes: [] })).toBeUndefined();
    expect(readTaggedNotes({ tag: "project" })).toBeUndefined();
  });

  it("labels a note by its title, and by its filename when it has none", () => {
    expect(taggedLabel({ path: "Projects/A.md", title: "The A Note" })).toBe("The A Note");
    expect(taggedLabel({ path: "Projects/A.md", title: null })).toBe("A");
    expect(taggedLabel({ path: "Projects/A.md", title: "" })).toBe("A");
  });
});

describe("fetching", () => {
  const ok = (body: unknown): typeof globalThis.fetch =>
    vi.fn(async () => new Response(JSON.stringify(body))) as unknown as typeof globalThis.fetch;

  it("asks the vault's tag route", async () => {
    const fetch = ok({ tags: [{ tag: "a", key: "a", notes: 1 }] });
    await fetchTags("my vault", { fetch });
    expect(fetch).toHaveBeenCalledWith("/api/v1/vaults/my%20vault/tags", expect.anything());
  });

  it("encodes a nested tag whole, separator included", () => {
    // why: whole rather than segment by segment. A `..` left as a path segment is resolved
    // by the browser before the request is sent, which would ask a different route entirely.
    const fetch = ok({ tag: "project/memberberry", notes: [] });
    void fetchTaggedNotes("personal", "project/memberberry", { fetch });
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/vaults/personal/tags/project%2Fmemberberry",
      expect.anything(),
    );
  });

  it("answers undefined when the server refuses, rather than an empty tree", async () => {
    const refused = vi.fn(
      async () => new Response("{}", { status: 404 }),
    ) as unknown as typeof globalThis.fetch;
    expect(await fetchTags("personal", { fetch: refused })).toBeUndefined();
    expect(await fetchTaggedNotes("personal", "a", { fetch: refused })).toBeUndefined();
  });

  it("answers undefined when the request throws, rather than taking the shell down", async () => {
    const broken = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof globalThis.fetch;
    expect(await fetchTags("personal", { fetch: broken })).toBeUndefined();
    expect(await fetchTaggedNotes("personal", "a", { fetch: broken })).toBeUndefined();
  });
});
