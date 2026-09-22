/**
 * Renaming a note or a tag, from the client's side (`SPEC.md` §6.6).
 *
 * Everything that matters happens on the server: it decides who may rename what, which links
 * resolve to the note, and whether a rewrite is safe. What lives here is the small amount of
 * work that is genuinely the client's — turning what somebody typed into a vault-relative
 * path, and turning the server's reply into a sentence.
 *
 * The refusals are deliberately thin, and the reason is §6.5. A `404` here means *any* of
 * "you may not", "it is not there" and "you are not in this vault", and it must keep meaning
 * all three: a client that guessed between them would be reporting the existence of notes
 * the server refused to admit to.
 */

/** What the server says a completed rename did — see the note on counts below. */
export interface Renamed {
  /** The new note path, or the new tag. */
  readonly to: string;
  /**
   * How many notes *this user can read* had a reference rewritten.
   *
   * Not how many were rewritten. The server touched notes this user cannot see, on purpose
   * (§6.6), and reporting that number would answer how many notes exist (§6.5).
   */
  readonly notes: number;
  /** References rewritten in those notes. */
  readonly references: number;
}

/** A rename that did not happen, with something the user can act on. */
export interface RenameRefused {
  readonly error: string;
}

export type RenameResult = { readonly ok: Renamed } | { readonly refused: string };

export interface RenameOptions {
  /** Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Title to store in the renamed note's first heading. */
  readonly title?: string | undefined;
}

export const RENAME_EVENT = "memberberry:rename";

export function requestRename(path: string, target: EventTarget = window): void {
  target.dispatchEvent(new CustomEvent<string>(RENAME_EVENT, { detail: path }));
}

export function renameRequest(event: Event): string | undefined {
  if (!(event instanceof CustomEvent)) return undefined;
  return typeof event.detail === "string" && event.detail !== "" ? event.detail : undefined;
}

/**
 * The vault-relative path a typed name means for a note currently at `from`.
 *
 * A bare name keeps the note where it is — renaming `Projects/Roadmap.md` to `Plan` means
 * `Projects/Plan.md`, because somebody renaming a note is not usually moving it. A name
 * containing a `/` is taken as a path from the vault root, which is how a rename doubles as
 * a move. `.md` is added when it is missing, because the extension is not part of the name
 * anybody thinks they are typing.
 *
 * Returns `undefined` for a name that is not a name: empty, all whitespace, or one whose
 * segments could climb out of the vault. The server refuses these too — this is the message
 * arriving before the round trip, not the check.
 */
export function notePathFor(from: string, typed: string): string | undefined {
  const name = typed.trim();
  if (name === "") return undefined;
  const raw = name.endsWith(".md") ? name.slice(0, -3) : name;
  const normalizedSegments: string[] = [];
  for (const segment of raw.split("/")) {
    const normalized = normalizeFilenameSegment(segment);
    if (normalized === undefined) return undefined;
    normalizedSegments.push(normalized);
  }
  const withExtension = `${normalizedSegments.join("/")}.md`;
  const relative = withExtension.includes("/")
    ? withExtension
    : `${folderOf(from)}${withExtension}`;
  const segments = relative.split("/");
  const usable = segments.every(
    (segment) => segment !== "" && segment !== "." && segment !== ".." && !segment.startsWith("."),
  );
  return usable ? relative : undefined;
}

/** Converts a title segment into a safe filesystem segment without changing its display text. */
export function normalizeFilenameSegment(value: string): string | undefined {
  const normalized = value
    .replace(/:([A-Za-z0-9_+-]+):/g, "_$1_")
    .replace(/[<>:"\\|?*]/g, "_")
    .trim();
  return normalized === "" || normalized === "." || normalized === ".." ? undefined : normalized;
}

/** The folder part of a vault-relative path, with its trailing slash, or `""` at the root. */
export function folderOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut + 1);
}

/** What the rename prompt starts with: the note's filename, without its extension. */
export function noteNameOf(path: string): string {
  const filename = path.slice(folderOf(path).length);
  return filename.endsWith(".md") ? filename.slice(0, -".md".length) : filename;
}

/** Renames a note and repoints its inbound links. */
export async function renameNote(
  vault: string,
  from: string,
  to: string,
  options: RenameOptions = {},
): Promise<RenameResult> {
  return send(vault, { kind: "note", from, to, ...(options.title === undefined ? {} : { title: options.title }) }, options);
}

/** Renames a tag, and every tag nested under it (§9.3). */
export async function renameTag(
  vault: string,
  from: string,
  to: string,
  options: RenameOptions = {},
): Promise<RenameResult> {
  return send(vault, { kind: "tag", from, to }, options);
}

/** Moves an entire folder through the server's permission-checked rename operation. */
export async function renameFolder(vault: string, from: string, to: string, options: RenameOptions = {}): Promise<RenameResult> {
  return send(vault, { kind: "folder", from, to }, options);
}

async function send(
  vault: string,
  body: Record<string, string>,
  options: RenameOptions,
): Promise<RenameResult> {
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  try {
    response = await request(`/api/v1/vaults/${encodeURIComponent(vault)}/rename`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { refused: "The server could not be reached." };
  }
  if (response.ok) {
    const renamed = readRenamed(await response.json().catch(() => undefined));
    return renamed === undefined
      ? { refused: "The server answered something this version does not understand." }
      : { ok: renamed };
  }
  return { refused: refusal(response.status, await response.json().catch(() => undefined)) };
}

/**
 * Turns a refusal into a sentence, without inventing detail the server withheld.
 *
 * The `404` line is load-bearing: the server answers it for a note that is not there, one
 * this user may not read, one they may read but not write, and a vault they are not in
 * (§6.5). Naming any of those apart would undo the reason the server merged them.
 */
export function refusal(status: number, body: unknown): string {
  if (status === 404) {
    return "That item cannot be moved or renamed — it may not exist, or you may not have access to it.";
  }
  if (typeof body === "object" && body !== null) {
    const message = (body as Record<string, unknown>)["error"];
    if (typeof message === "string" && message !== "") return message;
  }
  if (status === 409) return "The rename was refused because a note could not be rewritten safely.";
  return "The rename failed.";
}

/** Validates the reply. The client does not trust the server (`AGENTS.md` §4.3). */
export function readRenamed(body: unknown): Renamed | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const to = record["to"];
  const notes = record["notes"];
  const references = record["references"];
  if (typeof to !== "string" || to === "") return undefined;
  if (typeof notes !== "number" || !Number.isFinite(notes) || notes < 0) return undefined;
  if (typeof references !== "number" || !Number.isFinite(references) || references < 0) {
    return undefined;
  }
  return { to, notes, references };
}

/**
 * What to tell the user after a rename succeeded.
 *
 * Phrased as "notes you can see" rather than "notes", because that is what the number is: the
 * rewrite reached further and the reply does not say how much further (§6.6).
 */
export function renamedMessage(renamed: Renamed): string {
  if (renamed.notes === 0) return `Renamed to ${renamed.to}.`;
  const notes = renamed.notes === 1 ? "1 note" : `${renamed.notes} notes`;
  const references = renamed.references === 1 ? "1 reference" : `${renamed.references} references`;
  return `Renamed to ${renamed.to}. Updated ${references} in ${notes} you can see.`;
}
