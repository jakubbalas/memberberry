/**
 * Nested tags and the tag tree (`SPEC.md` §9.3).
 *
 * `#project/memberberry/spec` is one tag with three nodes, and every node carries the number
 * of notes tagged at or below it. Both the tree and the per-node counts arrive from the
 * server already filtered by the readable set (E16): a tag only an unreadable note carries
 * has no row, and a shared tag's count names only notes this user may read. There is no
 * filtering here and there must never be one — `AGENTS.md` §3.1 makes client-side filtering a
 * UX affordance, never a boundary.
 *
 * Case is not identity. `#Project` and `#project` are one tag, decided server-side, so `key`
 * is what identifies a node and `tag` is only ever a label.
 */

/** One node of the tag tree, as the server counts it. */
export interface TagCount {
  /** The prefix as somebody wrote it — the spelling most notes use. */
  readonly tag: string;
  /** Its folded form: the node's identity, and what the notes route is asked by. */
  readonly key: string;
  /** How many readable notes carry this tag or one nested under it. */
  readonly notes: number;
}

/** A note carrying a tag. */
export interface TaggedNote {
  readonly path: string;
  /** `null` when the note has nothing titleable. */
  readonly title: string | null;
}

export interface TaggedNotes {
  /** The prefix the server answered for, echoed as it was asked. */
  readonly tag: string;
  readonly notes: readonly TaggedNote[];
}

export interface TagsOptions {
  /** Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

/** A node of the assembled tree. */
export interface TagNode {
  /** The folded full prefix, e.g. `project/memberberry`. Unique, so it keys expansion. */
  readonly key: string;
  /** The last segment, as written — what the row is labelled with. */
  readonly name: string;
  readonly notes: number;
  readonly children: readonly TagNode[];
}

/**
 * Assembles the flat prefix rows into a tree.
 *
 * The server sends every prefix of every tag, so a parent is normally already a row; one is
 * synthesized anyway when it is missing, because a child with no parent would otherwise
 * vanish from a pane that renders from the roots down. A synthesized parent counts zero,
 * which is visibly different from a real count and is never a claim about a note.
 */
export function buildTagTree(counts: Iterable<TagCount>): readonly TagNode[] {
  interface Building {
    name: string;
    notes: number;
    readonly children: Map<string, Building>;
  }
  const roots = new Map<string, Building>();

  for (const count of counts) {
    const segments = count.key.split("/").filter((segment) => segment !== "");
    if (segments.length === 0) continue;
    // The label's segments, which the server spells as somebody wrote them. A response whose
    // `tag` has fewer segments than its `key` falls back to the key's, so the row is still
    // labelled with something rather than with `undefined`.
    const written = count.tag.split("/");
    let level = roots;
    let node: Building | undefined;
    segments.forEach((segment, depth) => {
      const existing = level.get(segment);
      node = existing ?? { name: written[depth] ?? segment, notes: 0, children: new Map() };
      if (existing === undefined) level.set(segment, node);
      level = node.children;
    });
    if (node !== undefined) {
      node.notes = count.notes;
      node.name = written[segments.length - 1] ?? node.name;
    }
  }

  const assemble = (level: Map<string, Building>, prefix: string): readonly TagNode[] =>
    [...level.entries()]
      .map(([segment, node]) => {
        const key = prefix === "" ? segment : `${prefix}/${segment}`;
        return {
          key,
          name: node.name,
          notes: node.notes,
          children: assemble(node.children, key),
        };
      })
      .sort((left, right) => collator.compare(left.name, right.name));
  return assemble(roots, "");
}

/** Case-insensitive and digit-aware, so `#q2` sorts before `#q10`. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** One row as the pane draws it. */
export interface TagRow {
  readonly node: TagNode;
  /** Nesting depth, for indentation. Root rows are zero. */
  readonly depth: number;
  /** Whether this node's children are showing. `undefined` when it has none. */
  readonly expanded?: boolean;
}

/**
 * The rows currently visible, in the order they appear on screen.
 *
 * The one list the renderer and the keyboard both work from, for the reason `tree.ts` gives:
 * walk the tree twice and the two disagree the moment a node collapses.
 */
export function visibleTagRows(
  tree: readonly TagNode[],
  expanded: ReadonlySet<string>,
  depth = 0,
): readonly TagRow[] {
  const rows: TagRow[] = [];
  for (const node of tree) {
    if (node.children.length === 0) {
      rows.push({ node, depth });
      continue;
    }
    const open = expanded.has(node.key);
    rows.push({ node, depth, expanded: open });
    if (open) rows.push(...visibleTagRows(node.children, expanded, depth + 1));
  }
  return rows;
}

/** What a keypress does to the tag tree. */
export type TagAction =
  | { readonly kind: "move"; readonly to: number }
  | { readonly kind: "expand"; readonly key: string }
  | { readonly kind: "collapse"; readonly key: string }
  | { readonly kind: "select"; readonly key: string }
  | { readonly kind: "none" };

/**
 * Resolves a keypress against the visible rows.
 *
 * why: not `treeKeyAction` from `tree.ts`, though the arrow keys agree. In the note tree a
 * row is *either* a folder to open *or* a note to open; here every node is selectable and a
 * node with children is also expandable, so Enter selects the tag rather than toggling it and
 * the toggle belongs to the arrows alone. Sharing one function would mean a parameter that
 * changes what Enter means, which is two behaviours wearing one name.
 */
export function tagKeyAction(
  key: string,
  rows: readonly TagRow[],
  cursor: number,
): TagAction {
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
      if (row.expanded === undefined) return { kind: "none" };
      if (!row.expanded) return { kind: "expand", key: row.node.key };
      return cursor + 1 < rows.length ? { kind: "move", to: cursor + 1 } : { kind: "none" };
    case "ArrowLeft": {
      if (row.expanded === true) return { kind: "collapse", key: row.node.key };
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
      return { kind: "select", key: row.node.key };
    default:
      return { kind: "none" };
  }
}

/**
 * Fetches the tag tree.
 *
 * Returns `undefined` on any failure, which the pane renders as "unavailable" rather than as
 * an empty tree: a vault with no tags and a server that would not answer are different facts,
 * and reporting the second as the first is a claim nobody checked.
 */
export async function fetchTags(
  vault: string,
  options: TagsOptions = {},
): Promise<readonly TagCount[] | undefined> {
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  try {
    const response = await request(`/api/v1/vaults/${encodeURIComponent(vault)}/tags`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return undefined;
    return readTags(await response.json());
  } catch {
    return undefined;
  }
}

/** Fetches the readable notes carrying `key` or any tag nested under it. */
export async function fetchTaggedNotes(
  vault: string,
  key: string,
  options: TagsOptions = {},
): Promise<TaggedNotes | undefined> {
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  // why: the whole tag, encoded whole. A nested tag's separator survives as `%2F`, which the
  // route accepts — and encoding segment by segment would leave a `..` typed into a tag as a
  // path segment the browser resolves away before the request is sent.
  const path = encodeURIComponent(key);
  try {
    const response = await request(
      `/api/v1/vaults/${encodeURIComponent(vault)}/tags/${path}`,
      { headers: { accept: "application/json" } },
    );
    if (!response.ok) return undefined;
    return readTaggedNotes(await response.json());
  } catch {
    return undefined;
  }
}

/**
 * Validates the tag tree response.
 *
 * The client does not trust the server any more than the server trusts the client
 * (`AGENTS.md` §4.3). Every field here reaches the DOM, and a count that is not a number
 * reaches a row's label; entries of the wrong shape are dropped rather than rendered.
 */
export function readTags(body: unknown): readonly TagCount[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const tags = (body as Record<string, unknown>)["tags"];
  if (!Array.isArray(tags)) return undefined;

  const valid: TagCount[] = [];
  for (const entry of tags) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const tag = record["tag"];
    const key = record["key"];
    const notes = record["notes"];
    if (typeof tag !== "string" || tag === "") continue;
    if (typeof key !== "string" || key === "") continue;
    if (typeof notes !== "number" || !Number.isFinite(notes) || notes < 0) continue;
    valid.push({ tag, key, notes });
  }
  return valid;
}

/** Validates the notes-under-a-tag response, on the same terms as `readTags`. */
export function readTaggedNotes(body: unknown): TaggedNotes | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const tag = record["tag"];
  const notes = record["notes"];
  if (typeof tag !== "string") return undefined;
  if (!Array.isArray(notes)) return undefined;

  const valid: TaggedNote[] = [];
  for (const entry of notes) {
    if (typeof entry !== "object" || entry === null) continue;
    const note = entry as Record<string, unknown>;
    const path = note["path"];
    const title = note["title"];
    if (typeof path !== "string" || path === "") continue;
    if (title !== null && typeof title !== "string") continue;
    valid.push({ path, title });
  }
  return { tag, notes: valid };
}

/** What a note row is labelled with: its title if it has one, else its filename. */
export function taggedLabel(note: TaggedNote): string {
  if (note.title !== null && note.title !== "") return note.title;
  const filename = note.path.split("/").pop() ?? note.path;
  return filename.replace(/\.md$/, "");
}
