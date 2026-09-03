/**
 * What the quick switcher and vault switcher search over (`SPEC.md` §8.4).
 *
 * Both lists come from the server already permission-filtered — the client never receives a
 * note or a vault it may not see, and never filters (AGENTS.md §3.1). So there is no
 * permission logic here at all, which is the point: the only safe place for it is the one
 * place it already is.
 *
 * The note list is fetched **once per vault per session** and ranked client-side, because
 * §21.2 budgets the switcher at 80 ms and a round trip per keystroke cannot meet that. The
 * cost is that a note created in another window is missing until the page reloads; `refresh`
 * exists for when there is something to trigger it, which today there is not.
 */

/** One note, as the server's index reports it. */
export interface NoteSummary {
  readonly path: string;
  /** `null` when the note has nothing titleable. */
  readonly title: string | null;
}

/** One vault this user can open. */
export interface VaultSummary {
  readonly slug: string;
  readonly name: string;
}

export interface CatalogOptions {
  /** Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

/** What the switcher matches against: the title if there is one, else the path. */
export function noteLabel(note: NoteSummary): string {
  return note.title ?? stripExtension(note.path);
}

/**
 * The trailing hint: where the note lives, when that adds something.
 *
 * Three cases, and the third is why this is a function rather than a field. A note titled
 * "Sprint planning" at `Projects/2024-01-15.md` needs the whole path, because the filename
 * looks nothing like the title. A note at the root titled the same as its file needs nothing —
 * repeating the label beside itself is noise. Everything else needs its folder.
 */
export function noteHint(note: NoteSummary): string | undefined {
  const withoutExtension = stripExtension(note.path);
  const folder = note.path.split("/").slice(0, -1).join("/");
  if (note.title === null || note.title === withoutExtension) {
    return folder === "" ? undefined : folder;
  }
  const filename = withoutExtension.split("/").pop() ?? withoutExtension;
  if (note.title === filename) return folder === "" ? undefined : folder;
  return withoutExtension;
}

function stripExtension(path: string): string {
  return path.replace(/\.md$/, "");
}

/**
 * Fetches the readable notes for a vault.
 *
 * Returns an empty list rather than throwing on any failure. A quick switcher that shows
 * nothing is a mild disappointment; one that throws takes the shell down with it, and every
 * failure here is either a denial (which the user cannot act on) or a network blip (which
 * retrying the keystroke fixes).
 */
export async function fetchNotes(
  vault: string,
  options: CatalogOptions = {},
): Promise<readonly NoteSummary[]> {
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  try {
    const response = await request(`/api/v1/vaults/${encodeURIComponent(vault)}/notes`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return [];
    const body: unknown = await response.json();
    return readNotes(body);
  } catch {
    return [];
  }
}

/** Fetches the vaults this user can open, for the vault switcher. */
export async function fetchVaults(options: CatalogOptions = {}): Promise<readonly VaultSummary[]> {
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  try {
    const response = await request("/api/v1/vaults", { headers: { accept: "application/json" } });
    if (!response.ok) return [];
    return readVaults(await response.json());
  } catch {
    return [];
  }
}

/**
 * Validates the note index.
 *
 * The client does not trust the server any more than the server trusts the client
 * (AGENTS.md §4.3). Entries that do not have the right shape are dropped rather than
 * rendered — a `path` that is not a string reaches a DOM attribute otherwise.
 */
function readNotes(body: unknown): readonly NoteSummary[] {
  if (typeof body !== "object" || body === null) return [];
  const notes = (body as Record<string, unknown>)["notes"];
  if (!Array.isArray(notes)) return [];

  const valid: NoteSummary[] = [];
  for (const entry of notes) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const path = record["path"];
    const title = record["title"];
    if (typeof path !== "string" || path === "") continue;
    if (title !== null && typeof title !== "string") continue;
    valid.push({ path, title });
  }
  return valid;
}

function readVaults(body: unknown): readonly VaultSummary[] {
  if (!Array.isArray(body)) return [];
  const valid: VaultSummary[] = [];
  for (const entry of body) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const slug = record["slug"];
    const name = record["name"];
    if (typeof slug !== "string" || slug === "") continue;
    valid.push({ slug, name: typeof name === "string" && name !== "" ? name : slug });
  }
  return valid;
}
