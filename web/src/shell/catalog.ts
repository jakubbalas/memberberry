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

import { readReplicatedTasks, type ReplicatedNote } from "../offline/db.js";
import type { CatalogAnswer } from "../offline/replica.js";

/**
 * One note, as the server's index reports it.
 *
 * The same shape the offline replica stores, and deliberately the *same type*: what is
 * replicated is exactly what the index answered (§7.2), and two structurally identical
 * declarations would be two things that can drift apart when a field is added.
 */
export type NoteSummary = ReplicatedNote;

export type { CatalogAnswer };

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
 * Never throws: a quick switcher that shows nothing is a mild disappointment, one that
 * throws takes the shell down with it. What it does instead is say *which* kind of nothing,
 * because §7.4's reconciliation turns on the difference. A refusal means this user may no
 * longer see this vault and the local replica has to go; no answer at all means a tunnel,
 * and wiping a 10 000-note replica because of a tunnel is the other bug. `replica.ts`
 * decides; this only reports.
 */
export async function fetchNotes(
  vault: string,
  options: CatalogOptions = {},
): Promise<CatalogAnswer> {
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  try {
    response = await request(`/api/v1/vaults/${encodeURIComponent(vault)}/notes`, {
      headers: { accept: "application/json" },
    });
  } catch {
    // A `fetch` rejects for a network failure and nothing else. Every refusal arrives as a
    // response, so this branch is always "there was no server".
    return { kind: "unreachable" };
  }
  // 404 is what a denial looks like here, and it is the same answer an unknown vault gets —
  // the invisibility rule (§6.5) requires that. 401 is a session that has expired.
  if (response.status === 404 || response.status === 401 || response.status === 403) {
    return { kind: "denied" };
  }
  if (!response.ok) return { kind: "unreachable" };
  try {
    return { kind: "ok", notes: readNotes(await response.json()) };
  } catch {
    // A 200 whose body will not parse is a broken server, not a denial. Keeping the replica
    // is the safe direction: it holds nothing this user was not already sent.
    return { kind: "unreachable" };
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
    const icon = record["icon"];
    const conflicts = record["conflicts"];
    const tasks = record["tasks"];
    if (typeof path !== "string" || path === "") continue;
    if (title !== null && typeof title !== "string") continue;
    if (icon !== null && icon !== undefined && typeof icon !== "string") continue;
    // A count that is not a number is dropped to zero rather than rejecting the note: the
    // note still has to be listed, and no badge is better than a wrong one (§3.5).
    valid.push({
      path,
      title,
      ...(icon === undefined ? {} : { icon }),
      ...(Array.isArray(tasks) ? { tasks: readReplicatedTasks(tasks) } : {}),
      conflicts: typeof conflicts === "number" && conflicts > 0 ? Math.floor(conflicts) : 0,
    });
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
