/**
 * The note tree (`SPEC.md` §8.2).
 *
 * Built from the flat note list the quick switcher already fetches, because a second source
 * of truth for "which notes exist" is a second thing that can be stale or wrongly filtered.
 * The list arrives permission-filtered (§6.4 E5), so an unreadable note has no node, no
 * parent folder created for it, and no count contributed to one — the invisibility rule (§6.5)
 * needs no code here, only the discipline of not fetching anything else.
 *
 * §4.1: "Folders are ordinary folders, not note containers." A folder here is a rendering
 * device inferred from path segments, with no identity of its own beyond its path — there is
 * no folder-as-note magic to model.
 *
 * Rendering and keyboard traversal both work from a **flattened list of visible rows** rather
 * than by walking the tree. A tree walk means the keyboard has to reimplement the same
 * traversal the renderer just did, and the two disagree the moment a folder collapses.
 */

import type { NoteSummary } from "./catalog.js";

export interface FolderNode {
  readonly kind: "folder";
  /** The segment itself, e.g. `Projects`. */
  readonly name: string;
  /** The full path from the vault root, e.g. `Archive/2019`. Unique, so it keys expansion. */
  readonly path: string;
  readonly children: readonly TreeNode[];
}

export interface NoteNode {
  readonly kind: "note";
  /** The filename without its extension. */
  readonly name: string;
  /** The vault-relative path, e.g. `Projects/Roadmap.md`. */
  readonly path: string;
  readonly title: string | null;
}

export type TreeNode = FolderNode | NoteNode;

/**
 * Builds the tree.
 *
 * A path with no separator is a note at the root. A folder exists only because a note inside
 * it does, which is what makes an empty folder impossible to represent — and correct, since a
 * folder holding only unreadable notes must not appear at all (§6.5).
 */
export function buildTree(notes: Iterable<NoteSummary>): readonly TreeNode[] {
  interface Building {
    readonly folders: Map<string, Building>;
    readonly notes: NoteNode[];
  }
  const root: Building = { folders: new Map(), notes: [] };

  for (const note of notes) {
    const segments = note.path.split("/").filter((segment) => segment !== "");
    const filename = segments.pop();
    if (filename === undefined) continue;

    let level = root;
    let prefix = "";
    for (const segment of segments) {
      prefix = prefix === "" ? segment : `${prefix}/${segment}`;
      const existing = level.folders.get(prefix);
      if (existing === undefined) {
        const created: Building = { folders: new Map(), notes: [] };
        level.folders.set(prefix, created);
        level = created;
      } else {
        level = existing;
      }
    }
    level.notes.push({
      kind: "note",
      name: filename.replace(/\.md$/, ""),
      path: note.path,
      title: note.title,
    });
  }

  const assemble = (level: Building): readonly TreeNode[] => {
    const folders: FolderNode[] = [...level.folders.entries()].map(([path, child]) => ({
      kind: "folder",
      name: path.split("/").pop() ?? path,
      path,
      children: assemble(child),
    }));
    // Folders before notes, each ordered the way a file manager does it — the convention
    // people already have, rather than one this application invents.
    return [...folders.sort(byName), ...level.notes.sort(byName)];
  };
  return assemble(root);
}

/** Case-insensitive, digit-aware, so `Note 2` sorts before `Note 10`. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function byName(left: { name: string }, right: { name: string }): number {
  return collator.compare(left.name, right.name);
}

/** One row as the sidebar draws it. */
export interface TreeRow {
  readonly node: TreeNode;
  /** Nesting depth, for indentation. Root rows are zero. */
  readonly depth: number;
  /** Whether this folder is open. `undefined` for a note. */
  readonly expanded?: boolean;
}

/**
 * The rows currently visible, in the order they appear on screen.
 *
 * The single source the renderer and the keyboard both work from: "the next row" means the
 * same thing to each, whatever is collapsed.
 */
export function visibleRows(
  tree: readonly TreeNode[],
  expanded: ReadonlySet<string>,
  depth = 0,
): readonly TreeRow[] {
  const rows: TreeRow[] = [];
  for (const node of tree) {
    if (node.kind === "note") {
      rows.push({ node, depth });
      continue;
    }
    const open = expanded.has(node.path);
    rows.push({ node, depth, expanded: open });
    if (open) rows.push(...visibleRows(node.children, expanded, depth + 1));
  }
  return rows;
}

/** Every folder path in the tree, for "expand all" and for restoring a saved expansion. */
export function folderPaths(tree: readonly TreeNode[]): readonly string[] {
  return tree.flatMap((node) =>
    node.kind === "folder" ? [node.path, ...folderPaths(node.children)] : [],
  );
}

/**
 * The folders that must be open for `notePath` to be visible.
 *
 * Used when a note is opened from somewhere else — the quick switcher, a link — so the tree
 * reveals where it lives rather than leaving the user to find it.
 */
export function ancestorsOf(notePath: string): readonly string[] {
  const segments = notePath.split("/").slice(0, -1);
  const ancestors: string[] = [];
  let prefix = "";
  for (const segment of segments) {
    prefix = prefix === "" ? segment : `${prefix}/${segment}`;
    ancestors.push(prefix);
  }
  return ancestors;
}

/** What a keypress does to the tree. Resolved here so the component stays presentational. */
export type TreeAction =
  | { readonly kind: "move"; readonly to: number }
  | { readonly kind: "expand"; readonly path: string }
  | { readonly kind: "collapse"; readonly path: string }
  | { readonly kind: "open"; readonly path: string }
  | { readonly kind: "none" };

/**
 * Resolves a keypress against the visible rows.
 *
 * The tree is a `tree` widget, and the arrow-key behaviour below is what that role promises:
 * Right opens a closed folder or steps into an open one, Left closes an open folder or steps
 * out to the parent. Getting this wrong is the difference between a tree you can navigate and
 * a list you have to click.
 */
export function treeKeyAction(
  key: string,
  rows: readonly TreeRow[],
  cursor: number,
): TreeAction {
  const row = rows[cursor];
  if (row === undefined) return { kind: "none" };

  switch (key) {
    case "ArrowDown":
      return cursor + 1 < rows.length ? { kind: "move", to: cursor + 1 } : { kind: "none" };
    case "ArrowUp":
      return cursor > 0 ? { kind: "move", to: cursor - 1 } : { kind: "none" };
    case "Home":
      return rows.length > 0 ? { kind: "move", to: 0 } : { kind: "none" };
    case "End":
      return rows.length > 0 ? { kind: "move", to: rows.length - 1 } : { kind: "none" };
    case "ArrowRight":
      if (row.node.kind !== "folder") return { kind: "none" };
      if (row.expanded !== true) return { kind: "expand", path: row.node.path };
      // Already open: step into it, which is the next row by construction.
      return cursor + 1 < rows.length ? { kind: "move", to: cursor + 1 } : { kind: "none" };
    case "ArrowLeft": {
      if (row.node.kind === "folder" && row.expanded === true) {
        return { kind: "collapse", path: row.node.path };
      }
      // Step out: the nearest row above at a shallower depth is the parent.
      for (let above = cursor - 1; above >= 0; above -= 1) {
        const candidate = rows[above];
        if (candidate !== undefined && candidate.depth < row.depth) {
          return { kind: "move", to: above };
        }
      }
      return { kind: "none" };
    }
    case "Enter":
    case " ":
      if (row.node.kind === "note") return { kind: "open", path: row.node.path };
      return row.expanded === true
        ? { kind: "collapse", path: row.node.path }
        : { kind: "expand", path: row.node.path };
    default:
      return { kind: "none" };
  }
}
