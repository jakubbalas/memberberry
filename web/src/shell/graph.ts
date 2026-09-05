/**
 * The local graph (`SPEC.md` §9.4).
 *
 * The n-hop neighbourhood of the note in the focused pane: what it links to, what links to
 * it, and the links between those. The picture arrives already filtered by the readable set
 * (E9) — a note the user cannot read is not a node here because the server never sent one,
 * and a link into one arrives as a **ghost**, exactly as a link to a note nobody has written
 * does. There is no permission logic on this side and there must never be one
 * (`AGENTS.md` §3.1).
 *
 * Fetched per note and per hop count, like the backlinks panel and unlike the note index: a
 * neighbourhood changes whenever anyone edits any note near this one, and a stale picture
 * draws a link that has been deleted.
 */

/** How far the walk may go, matching `mb_index::MAX_HOPS` (§9.4 says 1–3). */
export const MAX_HOPS = 3;

/** One node: a readable note, or a link target that resolves to nothing. */
export interface GraphNode {
  /** `n:<path>` or `g:<name>`. Unique within the graph, and what an edge names. */
  readonly key: string;
  /**
   * The note's vault-relative path, or `null` for a ghost.
   *
   * A ghost has no path because there is no note — whether it was never written or cannot
   * be read, which §6.5 makes one state. The client is not told which, and must not guess.
   */
  readonly path: string | null;
  readonly label: string;
  /** Distance from the origin in links, ignoring direction. The origin is `0`. */
  readonly hop: number;
}

/** One edge, in the direction the link points. */
export interface GraphEdge {
  readonly source: string;
  readonly target: string;
  /** Whether any link between this pair is a transclusion (§9.2). */
  readonly embed: boolean;
}

export interface GraphResponse {
  /** The note the server resolved the request to, which may not be what was asked for. */
  readonly note: string;
  /** The walk actually performed, after clamping — what the hop control shows. */
  readonly hops: number;
  /** Whether the node cap cut the neighbourhood short (§9.4). */
  readonly truncated: boolean;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

export interface GraphOptions {
  /** Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Fetches the neighbourhood of `note`.
 *
 * Returns `undefined` on any failure, which the panel renders as "unavailable" rather than
 * as an empty graph — "this note has no neighbours" and "we could not ask" are different
 * statements, and drawing the second as the first is a lie the user cannot see through.
 */
export async function fetchGraph(
  vault: string,
  note: string,
  hops: number,
  options: GraphOptions = {},
): Promise<GraphResponse | undefined> {
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  const path = note
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  try {
    const response = await request(
      `/api/v1/vaults/${encodeURIComponent(vault)}/graph/${path}?hops=${clampHops(hops)}`,
      { headers: { accept: "application/json" } },
    );
    if (!response.ok) return undefined;
    return readGraph(await response.json());
  } catch {
    return undefined;
  }
}

/** `hops` brought into the range §9.4 offers, so a bad control cannot send a bad request. */
export function clampHops(hops: number): number {
  if (!Number.isFinite(hops)) return 1;
  return Math.min(MAX_HOPS, Math.max(1, Math.round(hops)));
}

/**
 * Validates the response.
 *
 * The client does not trust the server any more than the server trusts the client
 * (`AGENTS.md` §4.3). Every field here reaches the DOM, `key` reaches an attribute, and
 * `hop` reaches arithmetic that positions a node — a string there would place it at `NaN`.
 *
 * An edge naming a node that is not in the list is dropped rather than drawn, because a line
 * to nowhere is the one thing a picture cannot render honestly.
 */
export function readGraph(body: unknown): GraphResponse | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const note = record["note"];
  const hops = record["hops"];
  const truncated = record["truncated"];
  if (typeof note !== "string" || note === "") return undefined;
  if (typeof hops !== "number" || !Number.isFinite(hops)) return undefined;
  if (typeof truncated !== "boolean") return undefined;
  if (!Array.isArray(record["nodes"]) || !Array.isArray(record["edges"])) return undefined;

  const nodes: GraphNode[] = [];
  const keys = new Set<string>();
  for (const entry of record["nodes"]) {
    const node = readNode(entry);
    // A duplicate key would make two nodes answer to one edge endpoint.
    if (node !== undefined && !keys.has(node.key)) {
      keys.add(node.key);
      nodes.push(node);
    }
  }
  const edges: GraphEdge[] = [];
  for (const entry of record["edges"]) {
    const edge = readEdge(entry);
    if (edge === undefined) continue;
    if (!keys.has(edge.source) || !keys.has(edge.target)) continue;
    edges.push(edge);
  }
  return { note, hops, truncated, nodes, edges };
}

function readNode(entry: unknown): GraphNode | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const record = entry as Record<string, unknown>;
  const key = record["key"];
  const path = record["path"];
  const label = record["label"];
  const hop = record["hop"];
  if (typeof key !== "string" || key === "") return undefined;
  if (path !== null && path !== undefined && typeof path !== "string") return undefined;
  if (typeof label !== "string") return undefined;
  if (typeof hop !== "number" || !Number.isInteger(hop) || hop < 0) return undefined;
  return { key, path: typeof path === "string" ? path : null, label, hop };
}

function readEdge(entry: unknown): GraphEdge | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const record = entry as Record<string, unknown>;
  const source = record["source"];
  const target = record["target"];
  const embed = record["embed"];
  if (typeof source !== "string" || source === "") return undefined;
  if (typeof target !== "string" || target === "") return undefined;
  if (typeof embed !== "boolean") return undefined;
  return { source, target, embed };
}

/** How many other nodes each node is joined to — what a node's size is drawn from (§9.4). */
export function degrees(graph: Pick<GraphResponse, "nodes" | "edges">): Map<string, number> {
  const counted = new Map<string, number>(graph.nodes.map((node) => [node.key, 0]));
  for (const edge of graph.edges) {
    counted.set(edge.source, (counted.get(edge.source) ?? 0) + 1);
    counted.set(edge.target, (counted.get(edge.target) ?? 0) + 1);
  }
  return counted;
}

/**
 * The folder a node's colour is taken from (§9.4), or `null` for a note at the vault root.
 *
 * A ghost has no folder, because it has no path — and giving it one would mean guessing at
 * where a note that does not exist would live.
 */
export function folderOf(node: GraphNode): string | null {
  if (node.path === null) return null;
  const cut = node.path.lastIndexOf("/");
  return cut === -1 ? null : node.path.slice(0, cut);
}

/** What a keypress does to the graph's cursor. */
export type GraphKeyAction =
  | { readonly kind: "none" }
  | { readonly kind: "move"; readonly to: number }
  | { readonly kind: "open" };

/**
 * What a key means inside the graph (§8.4).
 *
 * Here rather than in the component so it can be tested without mounting anything, exactly
 * as `tagKeyAction` is. Both arrow axes move along the same list: a picture has no rows, so
 * Up and Left are one intention — "the previous node" — and offering only one axis would
 * make the panel feel broken to whichever half of users reached for the other.
 */
export function graphKeyAction(key: string, count: number, cursor: number): GraphKeyAction {
  if (count === 0) return { kind: "none" };
  const at = Math.min(Math.max(cursor, 0), count - 1);
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return { kind: "move", to: Math.min(at + 1, count - 1) };
    case "ArrowUp":
    case "ArrowLeft":
      return { kind: "move", to: Math.max(at - 1, 0) };
    case "Home":
      return { kind: "move", to: 0 };
    case "End":
      return { kind: "move", to: count - 1 };
    case "Enter":
    case " ":
      return { kind: "open" };
    default:
      return { kind: "none" };
  }
}

/**
 * What a screen reader is told a node is.
 *
 * A ghost says so, because "no note yet" is the whole of what a ghost means to a reader —
 * and it is all the client knows: §6.5 does not tell it whether the note is missing or
 * merely not theirs.
 */
export function nodeDescription(node: GraphNode, hop: number): string {
  if (node.path === null) return `${node.label}, no note yet`;
  if (hop === 0) return `${node.label}, this note`;
  return `${node.label}, ${hop} ${hop === 1 ? "link" : "links"} away`;
}
