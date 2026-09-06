/**
 * The global graph's filters (`SPEC.md` §9.4).
 *
 * §9.4 lists six: tag include and exclude, a path glob, orphans only, ghost nodes on or off,
 * link versus embed edges, and a creation-date scrubber. They run **on the client**, over a
 * picture the server already filtered by permission — which is the ordinary shape and not a
 * violation of `AGENTS.md` §3.1: the readable set decides what the browser is *sent*, and
 * these decide what a reader wants to look at within it. Nothing here can reveal a note that
 * was not in the payload, and nothing here is a boundary.
 *
 * They run on the client because a scrubber is a control you drag. A round trip per frame
 * would make the vault's shape over time something you request rather than something you
 * watch, and the whole payload is already here.
 *
 * **A filter removes nodes; edges follow.** An edge whose end has been filtered out is not
 * drawn, for the same reason the server drops one whose end was cut by the cap: a line to
 * nowhere is the one thing a picture cannot render honestly.
 */

import { EDGE_STRIDE, type VaultGraphData, type VaultGraphNode } from "./vault-graph.js";

/** Which kinds of edge to draw — §9.4's "link vs embed edges". */
export interface EdgeKinds {
  readonly link: boolean;
  readonly embed: boolean;
}

export interface GraphFilters {
  /** Tags a note must carry one of. Empty means "no tag requirement". */
  readonly includeTags: readonly string[];
  /** Tags that hide a note, whatever else it carries. Exclusion wins over inclusion. */
  readonly excludeTags: readonly string[];
  /** A glob over the note's path — `Projects/*`, `**\/Q3.md`. Empty means everything. */
  readonly pathGlob: string;
  /** Show only notes nothing links to and that link to nothing (§9.4). */
  readonly orphansOnly: boolean;
  /** Whether unresolved links are drawn at all. */
  readonly ghosts: boolean;
  readonly edges: EdgeKinds;
  /** Earliest creation date to show, `YYYY-MM-DD`. Empty means no lower bound. */
  readonly createdFrom: string;
  /** Latest creation date to show, `YYYY-MM-DD`. Empty means no upper bound. */
  readonly createdTo: string;
}

/** Everything shown: what the view starts at, and what "clear filters" returns to. */
export const NO_FILTERS: GraphFilters = {
  includeTags: [],
  excludeTags: [],
  pathGlob: "",
  orphansOnly: false,
  ghosts: true,
  edges: { link: true, embed: true },
  createdFrom: "",
  createdTo: "",
};

/** Whether `filters` would hide anything at all — what a "filters are on" badge reads. */
export function filtersAreActive(filters: GraphFilters): boolean {
  return (
    filters.includeTags.length > 0 ||
    filters.excludeTags.length > 0 ||
    filters.pathGlob !== "" ||
    filters.orphansOnly ||
    !filters.ghosts ||
    !filters.edges.link ||
    !filters.edges.embed ||
    filters.createdFrom !== "" ||
    filters.createdTo !== ""
  );
}

/** A filtered picture, plus the map back to where each node came from. */
export interface FilteredGraph {
  readonly nodes: readonly VaultGraphNode[];
  /** Flat triples, re-indexed against `nodes`. */
  readonly edges: Uint32Array;
  /** For each kept node, its index in the unfiltered graph — what a selection is kept as. */
  readonly source: Uint32Array;
  /** How many nodes the unfiltered picture had, so the view can say what it is hiding. */
  readonly of: number;
}

/**
 * Applies `filters` to `graph`.
 *
 * Returns the whole graph untouched — same node objects, re-indexed edges — when nothing is
 * filtering, so the common case allocates one array rather than copying a vault.
 */
export function filterGraph(graph: VaultGraphData, filters: GraphFilters): FilteredGraph {
  const glob = compileGlob(filters.pathGlob);
  const linked = filters.orphansOnly ? degreesWithin(graph) : undefined;
  const keep = new Uint32Array(graph.nodes.length);
  const nodes: VaultGraphNode[] = [];
  const source = new Uint32Array(graph.nodes.length);
  let kept = 0;
  graph.nodes.forEach((node, at) => {
    if (!shows(node, filters, glob, linked?.[at] ?? 0)) {
      keep[at] = NOT_KEPT;
      return;
    }
    keep[at] = kept;
    source[kept] = at;
    nodes.push(node);
    kept += 1;
  });

  const edges = new Uint32Array(graph.edges.length);
  let at = 0;
  for (let i = 0; i + EDGE_STRIDE <= graph.edges.length; i += EDGE_STRIDE) {
    const embed = (graph.edges[i + 2] ?? 0) === 1;
    if (embed ? !filters.edges.embed : !filters.edges.link) continue;
    const from = keep[graph.edges[i] ?? 0] ?? NOT_KEPT;
    const to = keep[graph.edges[i + 1] ?? 0] ?? NOT_KEPT;
    if (from === NOT_KEPT || to === NOT_KEPT) continue;
    edges[at] = from;
    edges[at + 1] = to;
    edges[at + 2] = embed ? 1 : 0;
    at += EDGE_STRIDE;
  }

  return {
    nodes,
    edges: edges.subarray(0, at),
    source: source.subarray(0, kept),
    of: graph.nodes.length,
  };
}

/** A node index that survived nothing. `Uint32Array` has no `-1`, so it is the top of it. */
const NOT_KEPT = 0xffff_ffff;

function shows(
  node: VaultGraphNode,
  filters: GraphFilters,
  glob: RegExp | undefined,
  links: number,
): boolean {
  if (node.path === null) {
    // A ghost carries no tags, no path and no date, so every filter except its own switch
    // would hide it by default — and a picture that dropped every unresolved link the
    // moment a reader typed a folder name would be lying about what is in that folder.
    return filters.ghosts;
  }
  if (filters.orphansOnly && links > 0) return false;
  if (glob !== undefined && !glob.test(node.path)) return false;
  if (filters.excludeTags.some((tag) => carries(node, tag))) return false;
  if (filters.includeTags.length > 0 && !filters.includeTags.some((tag) => carries(node, tag))) {
    return false;
  }
  if (filters.createdFrom !== "" && (node.created === null || node.created < filters.createdFrom)) {
    return false;
  }
  if (filters.createdTo !== "" && (node.created === null || node.created > filters.createdTo)) {
    return false;
  }
  return true;
}

/**
 * Whether a note carries `tag` or anything nested under it (§9.3).
 *
 * A string prefix, because the server sends folded full tags and §9.3's nesting is spelled
 * with `/`. `project` matches `project/mb` and not `projects`, which is the whole reason the
 * separator is part of the test rather than a bare `startsWith`.
 */
export function carries(node: VaultGraphNode, tag: string): boolean {
  const wanted = tag.trim().replace(/^#/, "").toLowerCase();
  if (wanted === "") return false;
  return node.tags.some((carried) => carried === wanted || carried.startsWith(`${wanted}/`));
}

/** How many *drawn* edges touch each node — what "orphan" is decided by. */
function degreesWithin(graph: VaultGraphData): Uint32Array {
  const counted = new Uint32Array(graph.nodes.length);
  for (let i = 0; i + EDGE_STRIDE <= graph.edges.length; i += EDGE_STRIDE) {
    const source = graph.edges[i] ?? 0;
    const target = graph.edges[i + 1] ?? 0;
    counted[source] = (counted[source] ?? 0) + 1;
    counted[target] = (counted[target] ?? 0) + 1;
  }
  return counted;
}

/**
 * Compiles a path glob, or `undefined` when there is nothing to match.
 *
 * `*` matches within one path segment, `**` across them, `?` matches one character — the
 * three every editor's file filter uses, and the same vocabulary `access.toml` paths are
 * read with. Everything else is escaped, so a folder called `Notes (2024)` is a folder and
 * not a regular expression somebody has to escape by hand.
 */
export function compileGlob(pattern: string): RegExp | undefined {
  const trimmed = pattern.trim();
  if (trimmed === "") return undefined;
  let expression = "";
  for (let at = 0; at < trimmed.length; at += 1) {
    const char = trimmed[at] ?? "";
    if (char === "*") {
      if (trimmed[at + 1] === "*") {
        expression += ".*";
        at += 1;
      } else {
        expression += "[^/]*";
      }
    } else if (char === "?") {
      expression += "[^/]";
    } else {
      expression += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  // why: case-insensitive. A reader typing `projects/` is naming a folder, not spelling a
  // path exactly, and the note tree they read the name off is not case-sensitive either.
  //
  // No `try` around this: every character is either translated or escaped above, so there is
  // no input that reaches here as an invalid expression — a `catch` would be a branch no
  // test could reach (`AGENTS.md` §4.1).
  return new RegExp(`^${expression}$`, "i");
}
