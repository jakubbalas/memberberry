/**
 * The whole-vault graph, as the client receives it (`SPEC.md` §9.4).
 *
 * The local graph's counterpart, and the same permission story: the picture arrives already
 * filtered by the readable set (E9), a note the user cannot read is not a node because the
 * server never sent one, and a link into one arrives as a **ghost** exactly as a link to a
 * note nobody has written does. There is no permission logic on this side and there must
 * never be one (`AGENTS.md` §3.1).
 *
 * **The edge encoding is the one unusual thing here.** Edges arrive as flat triples of
 * indices — `[source, target, embed, source, target, embed, …]` — rather than as objects
 * naming their endpoints by key, because at §21's ten thousand notes the object form is
 * megabytes of repeated path strings. What that buys on this side is a `Uint32Array` that
 * goes to the layout worker as a transfer rather than a copy, with no object allocated per
 * edge. What it costs is that the format has to be *validated* rather than trusted: an index
 * out of range would otherwise be drawn as an edge to whichever node happened to land at
 * that position, which is a line the reader has no way to know is wrong.
 */

/** How many nodes a phone asks for — §9.4's "showing 2,000 of 10,431". */
export const MOBILE_NODE_CAP = 2000;

/** One node: a readable note, or a link target that resolves to nothing. */
export interface VaultGraphNode {
  /** `n:<path>` or `g:<name>`. Unique within the graph. */
  readonly key: string;
  /**
   * The note's vault-relative path, or `null` for a ghost.
   *
   * A ghost has no path because there is no note — whether it was never written or cannot
   * be read, which §6.5 makes one state. The client is not told which, and must not guess.
   */
  readonly path: string | null;
  readonly label: string;
  /**
   * The note's frontmatter `icon` (§4.2), or `null` — drawn on the node above §9.4's zoom
   * threshold, where there is room for it and few enough nodes to draw it for.
   */
  readonly icon: string | null;
  /** Edges touching this node in the whole vault, not in the drawn picture (§9.4). */
  readonly degree: number;
  /** Words in the note; `0` for a ghost. §9.4's other node size. */
  readonly words: number;
  /** `YYYY-MM-DD`, or `null` when the note says nothing — a real state, not a default. */
  readonly created: string | null;
  /** The note's full tags, folded. A prefix filter is a string prefix; see `graph-filters`. */
  readonly tags: readonly string[];
}

/** How many numbers one edge occupies in {@link VaultGraphData.edges}. */
export const EDGE_STRIDE = 3;

export interface VaultGraphData {
  /** Ordered by key, which is what an edge's index refers to. */
  readonly nodes: readonly VaultGraphNode[];
  /**
   * Flat triples: source index, target index, `1` for an embed and `0` for a link.
   *
   * Every index is in range for `nodes` — that is what {@link readVaultGraph} guarantees, so
   * nothing downstream has to check it again.
   */
  readonly edges: Uint32Array;
  /** How many nodes the readable vault has before the cap — §9.4's "of 10,431". */
  readonly total: number;
  /** Whether the cap cut the picture short, which it has to say on screen. */
  readonly truncated: boolean;
}

export interface VaultGraphOptions {
  /** Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** The most nodes to draw. Absent asks for as many as the server will give. */
  readonly limit?: number | undefined;
}

/**
 * Fetches the whole readable vault.
 *
 * Returns `undefined` on any failure, which the view renders as "unavailable" rather than as
 * an empty graph — "this vault has no notes" and "we could not ask" are different statements,
 * and drawing the second as the first is a lie the user cannot see through.
 */
export async function fetchVaultGraph(
  vault: string,
  options: VaultGraphOptions = {},
): Promise<VaultGraphData | undefined> {
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  const limit = options.limit;
  const query =
    limit === undefined ? "" : `?limit=${encodeURIComponent(String(Math.floor(limit)))}`;
  try {
    const response = await request(
      `/api/v1/vaults/${encodeURIComponent(vault)}/graph${query}`,
      { headers: { accept: "application/json" } },
    );
    if (!response.ok) return undefined;
    return readVaultGraph(await response.json());
  } catch {
    return undefined;
  }
}

/**
 * Validates the response.
 *
 * The client does not trust the server any more than the server trusts the client
 * (`AGENTS.md` §4.3). Every field here reaches the DOM or arithmetic that positions a node —
 * a string where a number belongs would place a dot at `NaN`, which draws nothing and
 * reports nothing.
 *
 * An edge whose indices are not both nodes is **dropped rather than drawn**, the same rule
 * the local graph applies to an edge naming an unknown key: a line to nowhere is the one
 * thing a picture cannot render honestly.
 */
export function readVaultGraph(body: unknown): VaultGraphData | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const total = record["total"];
  const truncated = record["truncated"];
  if (typeof total !== "number" || !Number.isInteger(total) || total < 0) return undefined;
  if (typeof truncated !== "boolean") return undefined;
  if (!Array.isArray(record["nodes"]) || !Array.isArray(record["edges"])) return undefined;

  const nodes: VaultGraphNode[] = [];
  const keys = new Set<string>();
  for (const entry of record["nodes"]) {
    const node = readNode(entry);
    // A duplicate key would make two nodes answer to one edge endpoint.
    if (node !== undefined && !keys.has(node.key)) {
      keys.add(node.key);
      nodes.push(node);
    }
  }

  const raw = record["edges"];
  const edges = new Uint32Array(raw.length - (raw.length % EDGE_STRIDE));
  let at = 0;
  for (let i = 0; i + EDGE_STRIDE <= raw.length; i += EDGE_STRIDE) {
    const source = raw[i];
    const target = raw[i + 1];
    const embed = raw[i + 2];
    if (!isIndex(source, nodes.length) || !isIndex(target, nodes.length)) continue;
    if (embed !== 0 && embed !== 1) continue;
    // A self-loop is not drawable and the server does not send one; an index pair that says
    // otherwise is a payload this cannot render rather than one to render wrongly.
    if (source === target) continue;
    edges[at] = source;
    edges[at + 1] = target;
    edges[at + 2] = embed;
    at += EDGE_STRIDE;
  }
  return { nodes, edges: edges.subarray(0, at), total, truncated };
}

function isIndex(value: unknown, count: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < count;
}

function readNode(entry: unknown): VaultGraphNode | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const record = entry as Record<string, unknown>;
  const key = record["key"];
  const path = record["path"];
  const label = record["label"];
  const icon = record["icon"];
  const degree = record["degree"];
  const words = record["words"];
  const created = record["created"];
  const tags = record["tags"];
  if (typeof key !== "string" || key === "") return undefined;
  if (path !== null && path !== undefined && typeof path !== "string") return undefined;
  if (typeof label !== "string") return undefined;
  if (icon !== null && icon !== undefined && typeof icon !== "string") return undefined;
  if (!isCount(degree) || !isCount(words)) return undefined;
  if (created !== null && created !== undefined && typeof created !== "string") return undefined;
  if (!Array.isArray(tags)) return undefined;
  return {
    key,
    path: typeof path === "string" ? path : null,
    label,
    icon: typeof icon === "string" ? icon : null,
    degree,
    words,
    created: typeof created === "string" ? created : null,
    tags: tags.filter((tag): tag is string => typeof tag === "string"),
  };
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * The folder a node's colour is taken from (§9.4), or `null` for a note at the vault root.
 *
 * A ghost has no folder, because it has no path — and giving it one would mean guessing at
 * where a note that does not exist would live.
 */
export function folderOf(node: VaultGraphNode): string | null {
  if (node.path === null) return null;
  const cut = node.path.lastIndexOf("/");
  return cut === -1 ? null : node.path.slice(0, cut);
}
