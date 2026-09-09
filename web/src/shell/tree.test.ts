/**
 * The note tree (`SPEC.md` §8.2).
 *
 * Two things are worth pinning. The **shape**: folders are inferred from paths and cannot
 * exist without a readable note inside them, which is what makes §6.5 free rather than
 * something to remember. And the **keyboard**: the arrow behaviour of a `tree` widget is what
 * separates a tree you can navigate from a list you have to click, and it is entirely
 * conventional — which means getting it wrong is invisible to anyone who wrote it.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { NoteSummary } from "./catalog.js";
import {
  type TreeNode,
  ancestorsOf,
  buildTree,
  folderPaths,
  treeKeyAction,
  visibleRows,
} from "./tree.js";

function notes(...paths: readonly string[]): readonly NoteSummary[] {
  return paths.map((path) => ({ path, title: null, conflicts: 0 }));
}

/** The tree as an indented outline, which is far easier to read than nested objects. */
function outline(tree: readonly TreeNode[], depth = 0): string {
  return tree
    .map((node) => {
      const line = `${"  ".repeat(depth)}${node.name}${node.kind === "folder" ? "/" : ""}`;
      return node.kind === "folder" ? [line, outline(node.children, depth + 1)].join("\n") : line;
    })
    .join("\n");
}

describe("building the tree", () => {
  it("nests notes under the folders their paths imply", () => {
    const tree = buildTree(
      notes("Welcome.md", "Projects/Roadmap.md", "Projects/Sprint.md", "Archive/2019/Old.md"),
    );
    expect(outline(tree)).toBe(
      ["Archive/", "  2019/", "    Old", "Projects/", "  Roadmap", "  Sprint", "Welcome"].join(
        "\n",
      ),
    );
  });

  it("puts folders before notes at every level", () => {
    // The convention every file manager uses. Mixing them reads as unsorted.
    const tree = buildTree(notes("Zebra.md", "Alpha/One.md"));
    expect(tree.map((node) => node.name)).toEqual(["Alpha", "Zebra"]);
  });

  it("orders names the way a person would, digits included", () => {
    // `Note 10` after `Note 2`, not before it, which a plain string sort gets wrong.
    const tree = buildTree(notes("Note 10.md", "Note 2.md", "note 1.md"));
    expect(tree.map((node) => node.name)).toEqual(["note 1", "Note 2", "Note 10"]);
  });

  it("cannot represent an empty folder", () => {
    // Which is the point: a folder holding only notes this user cannot read is absent from
    // the list they were given, so it never appears — §6.5 with no code of its own.
    const tree = buildTree(notes("Private/Visible.md"));
    expect(folderPaths(tree)).toEqual(["Private"]);
    expect(buildTree(notes())).toEqual([]);
  });

  it("keeps the note's title alongside its name", () => {
    const tree = buildTree([
      { path: "Projects/2024-01-15.md", title: "Sprint planning", conflicts: 2 },
    ]);
    const folder = tree[0];
    if (folder?.kind !== "folder") throw new Error("expected a folder");
    const note = folder.children[0];
    expect(note?.kind === "note" && note.title).toBe("Sprint planning");
    expect(note?.kind === "note" && note.conflicts).toBe(2);
    expect(note?.name).toBe("2024-01-15");
  });

  it("keeps the note's icon alongside its title", () => {
    const tree = buildTree([
      { path: "Ideas.md", title: "Ideas", icon: ":bulb:", conflicts: 0 },
    ]);
    const note = tree[0];
    expect(note?.kind === "note" && note.icon).toBe(":bulb:");
  });

  it("survives paths that are not shaped like paths", () => {
    // The list comes from the server, but a client that falls over on a leading slash or a
    // doubled separator is a client that falls over on someone's real vault.
    expect(() => buildTree(notes("/Leading.md", "Double//Separator.md", "", "Trailing/"))).not.toThrow();
    const tree = buildTree(notes("/Leading.md", "Double//Separator.md"));
    expect(outline(tree)).toContain("Leading");
  });

  it("never loses a note, whatever the paths are", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc
            .array(fc.stringMatching(/^[A-Za-z0-9 _-]{1,8}$/), { minLength: 1, maxLength: 4 })
            .map((segments) => `${segments.join("/")}.md`),
          { maxLength: 25 },
        ),
        (paths) => {
          const unique = [...new Set(paths)];
          const count = (tree: readonly TreeNode[]): number =>
            tree.reduce(
              (total, node) => total + (node.kind === "note" ? 1 : count(node.children)),
              0,
            );
          expect(count(buildTree(notes(...unique)))).toBe(unique.length);
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("visible rows", () => {
  const tree = buildTree(notes("Welcome.md", "Projects/Roadmap.md", "Archive/2019/Old.md"));

  it("show only the top level when nothing is expanded", () => {
    const rows = visibleRows(tree, new Set());
    expect(rows.map((row) => row.node.name)).toEqual(["Archive", "Projects", "Welcome"]);
    expect(rows.every((row) => row.depth === 0)).toBe(true);
  });

  it("reveal a folder's children when it is expanded, with their depth", () => {
    const rows = visibleRows(tree, new Set(["Projects"]));
    expect(rows.map((row) => `${row.depth}:${row.node.name}`)).toEqual([
      "0:Archive",
      "0:Projects",
      "1:Roadmap",
      "0:Welcome",
    ]);
  });

  it("do not reveal a grandchild whose parent is closed", () => {
    // Expanding `Archive/2019` without `Archive` must not leak its contents to the top level.
    const rows = visibleRows(tree, new Set(["Archive/2019"]));
    expect(rows.map((row) => row.node.name)).toEqual(["Archive", "Projects", "Welcome"]);
  });

  it("report whether a folder is open, and nothing for a note", () => {
    const rows = visibleRows(tree, new Set(["Projects"]));
    const projects = rows.find((row) => row.node.name === "Projects");
    const welcome = rows.find((row) => row.node.name === "Welcome");
    expect(projects?.expanded).toBe(true);
    expect(welcome?.expanded).toBeUndefined();
  });
});

describe("revealing a note", () => {
  it("names every folder that has to be open", () => {
    expect(ancestorsOf("Archive/2019/Old.md")).toEqual(["Archive", "Archive/2019"]);
  });

  it("names none for a note at the root", () => {
    expect(ancestorsOf("Welcome.md")).toEqual([]);
  });
});

describe("the keyboard", () => {
  const tree = buildTree(notes("Welcome.md", "Projects/Roadmap.md", "Projects/Sprint.md"));
  const closed = visibleRows(tree, new Set());
  const open = visibleRows(tree, new Set(["Projects"]));

  it("moves down and up, and stops at the ends", () => {
    expect(treeKeyAction("ArrowDown", closed, 0)).toEqual({ kind: "move", to: 1 });
    expect(treeKeyAction("ArrowUp", closed, 1)).toEqual({ kind: "move", to: 0 });
    expect(treeKeyAction("ArrowUp", closed, 0)).toEqual({ kind: "none" });
    expect(treeKeyAction("ArrowDown", closed, closed.length - 1)).toEqual({ kind: "none" });
  });

  it("jumps to the ends with Home and End", () => {
    expect(treeKeyAction("Home", open, 2)).toEqual({ kind: "move", to: 0 });
    expect(treeKeyAction("End", open, 0)).toEqual({ kind: "move", to: open.length - 1 });
  });

  it("opens a closed folder with Right, then steps into it", () => {
    // The `tree` role promises exactly this, and it is entirely conventional — which means
    // getting it wrong is invisible to whoever wrote it and obvious to everyone else.
    expect(treeKeyAction("ArrowRight", closed, 0)).toEqual({ kind: "expand", path: "Projects" });
    expect(treeKeyAction("ArrowRight", open, 0)).toEqual({ kind: "move", to: 1 });
  });

  it("closes an open folder with Left, then steps out to the parent", () => {
    expect(treeKeyAction("ArrowLeft", open, 0)).toEqual({ kind: "collapse", path: "Projects" });
    // From a child, Left goes to the parent rather than collapsing anything.
    expect(treeKeyAction("ArrowLeft", open, 1)).toEqual({ kind: "move", to: 0 });
  });

  it("does nothing on Left at the top level, rather than wrapping", () => {
    expect(treeKeyAction("ArrowLeft", closed, closed.length - 1)).toEqual({ kind: "none" });
  });

  it("does nothing on Right for a note", () => {
    const welcome = closed.findIndex((row) => row.node.name === "Welcome");
    expect(treeKeyAction("ArrowRight", closed, welcome)).toEqual({ kind: "none" });
  });

  it("opens a note with Enter and toggles a folder with it", () => {
    const welcome = closed.findIndex((row) => row.node.name === "Welcome");
    expect(treeKeyAction("Enter", closed, welcome)).toEqual({
      kind: "open",
      path: "Welcome.md",
    });
    expect(treeKeyAction("Enter", closed, 0)).toEqual({ kind: "expand", path: "Projects" });
    expect(treeKeyAction("Enter", open, 0)).toEqual({ kind: "collapse", path: "Projects" });
  });

  it("ignores keys it does not own, so the shell's shortcuts still work", () => {
    expect(treeKeyAction("k", closed, 0)).toEqual({ kind: "none" });
    expect(treeKeyAction("Escape", closed, 0)).toEqual({ kind: "none" });
  });

  it("does nothing when the cursor is off the end of a list that shrank", () => {
    expect(treeKeyAction("ArrowDown", closed, 99)).toEqual({ kind: "none" });
    expect(treeKeyAction("Enter", [], 0)).toEqual({ kind: "none" });
  });
});
