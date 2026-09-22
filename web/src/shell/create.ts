/**
 * Creating a note, from the client's side (`SPEC.md` §6.10).
 *
 * The same shape as `rename.ts` and for the same reasons: the server decides who may create
 * what and where, and what lives here is turning a typed name into a vault-relative path and
 * the server's reply into a sentence.
 *
 * The refusals stay thin for the reason §6.5 gives. A `404` means *any* of "you may not
 * write there", "you are not in this vault" and "there is no such vault", and it must keep
 * meaning all three — a client that guessed between them would be reporting which vaults and
 * folders exist to somebody the server refused to tell.
 */

import { folderOf, normalizeFilenameSegment } from "./rename.js";

/** What the server says it created. */
export interface Created {
  /** The vault-relative path the note landed at, ending in `.md`. */
  readonly path: string;
}

export type CreateResult = { readonly ok: Created } | { readonly refused: string };

export interface CreateOptions {
  /** Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  readonly content?: string | undefined;
}

/**
 * The vault-relative path a typed name means for a new note.
 *
 * A bare name lands **beside the note that is open**, which is where the note somebody is
 * writing about the thing they are reading belongs; with nothing open it lands at the vault
 * root. A name containing a `/` is taken as a path from the root, which is how the same
 * prompt doubles as "put it in this folder".
 * A selected tree folder is passed as `from` with a trailing slash.
 *
 * Returns `undefined` for a name that is not a name — empty, all whitespace, or one whose
 * segments could climb out of the vault. The server refuses these too; this is the message
 * arriving without the round trip, not the check.
 */
export function newNotePathFor(from: string | undefined, typed: string): string | undefined {
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
    : `${folderOf(from ?? "")}${withExtension}`;
  const segments = relative.split("/");
  const usable = segments.every(
    (segment) => segment !== "" && segment !== "." && segment !== ".." && !segment.startsWith("."),
  );
  return usable ? relative : undefined;
}

/** The title stored in a new note for a typed note path. */
export function titleForNoteName(typed: string): string {
  return typed.trim().replace(/\.md$/, "").split("/").pop() ?? typed.trim();
}

/** What the prompt says the new note's home will be, in words rather than a path fragment. */
export function newNoteSubject(from: string | undefined): string {
  const folder = folderOf(from ?? "");
  return folder === "" ? "At the vault root" : `In ${folder}`;
}

/** Creates a note and returns where it landed. */
export async function createNote(
  vault: string,
  path: string,
  options: CreateOptions = {},
): Promise<CreateResult> {
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  try {
    response = await request(`/api/v1/vaults/${encodeURIComponent(vault)}/notes`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(options.content === undefined ? { path } : { path, content: options.content }),
    });
  } catch {
    return { refused: "The server could not be reached." };
  }
  if (response.ok) {
    const created = readCreated(await response.json().catch(() => undefined));
    return created === undefined
      ? { refused: "The server answered something this version does not understand." }
      : { ok: created };
  }
  return { refused: createRefusal(response.status, await response.json().catch(() => undefined)) };
}

/**
 * Turns a refusal into a sentence, without inventing detail the server withheld.
 *
 * The `404` line carries the same load as `rename`'s: the server answers it for a folder this
 * user may not write in and for a vault they are not in, and naming those apart would undo
 * the reason it merged them.
 */
export function createRefusal(status: number, body: unknown): string {
  if (status === 404) {
    return "That note cannot be created — you may not have access to write there.";
  }
  if (typeof body === "object" && body !== null) {
    const message = (body as Record<string, unknown>)["error"];
    if (typeof message === "string" && message !== "") return message;
  }
  return "The note could not be created.";
}

/** Validates the reply. The client does not trust the server (`AGENTS.md` §4.3). */
export function readCreated(body: unknown): Created | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const path = (body as Record<string, unknown>)["path"];
  if (typeof path !== "string" || path === "") return undefined;
  return { path };
}
