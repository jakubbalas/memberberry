/**
 * Inbound links to the open note (`SPEC.md` §9.5).
 *
 * The list arrives already filtered by the readable set (E8): a note the user cannot read is
 * not a row here because the server never sent it. There is no permission logic on this side
 * and there must never be one — `AGENTS.md` §3.1 makes client-side filtering a UX
 * affordance, never a boundary.
 *
 * Fetched per note rather than cached per vault, unlike the note index. Backlinks change
 * whenever anyone edits any note that mentions this one, and the response is small: one entry
 * per inbound link, not one per note in the vault.
 */

/** Which part of the target a link pointed at (§9.1 `anchor_kind`). */
export type BacklinkAnchorKind = "none" | "heading" | "block";

/** One inbound link, with the context a reader needs to recognise it. */
export interface Backlink {
  /** Visible text of the block the link sits in. `null` when that block has no text. */
  readonly context: string | null;
  /** `^block-id` of that block, for a jump straight to it. */
  readonly sourceBlock: string | null;
  /** `![[…]]` rather than `[[…]]`: the source transcludes this note (§9.2). */
  readonly embed: boolean;
  readonly anchorKind: BacklinkAnchorKind;
  readonly anchor: string | null;
}

/** The inbound links from one note, grouped as §9.5 asks. */
export interface BacklinkSource {
  readonly path: string;
  /** `null` when the linking note has nothing titleable. */
  readonly title: string | null;
  readonly links: readonly Backlink[];
}

/**
 * One note that names this one in its text without linking to it (§9.5).
 *
 * Never a note that also links here — the server puts each note in one list or the other, so
 * this side does no de-duplication and must not start: a note appearing in both would mean
 * the server changed its mind about what a backlink is, which is not something to paper over.
 */
export interface MentionSource {
  readonly path: string;
  /** `null` when the mentioning note has nothing titleable. */
  readonly title: string | null;
  /** Visible text of each mentioning block, in document order. */
  readonly contexts: readonly string[];
}

export interface BacklinksResponse {
  /** The note the server resolved the request to, which may not be what was asked for. */
  readonly note: string;
  readonly sources: readonly BacklinkSource[];
  readonly mentions: readonly MentionSource[];
}

export interface BacklinksOptions {
  /** Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

/** What a source row is labelled with: its title if it has one, else its filename. */
export function sourceLabel(source: {
  readonly path: string;
  readonly title: string | null;
}): string {
  if (source.title !== null && source.title !== "") return source.title;
  const filename = source.path.split("/").pop() ?? source.path;
  return filename.replace(/\.md$/, "");
}

/**
 * Fetches the notes linking to `note`.
 *
 * Returns `undefined` on any failure, which the panel renders as nothing rather than as an
 * empty list — "no backlinks" and "we could not ask" are different statements, and a denial
 * is not something the user can act on. A thrown error would take the shell down with it.
 */
export async function fetchBacklinks(
  vault: string,
  note: string,
  options: BacklinksOptions = {},
): Promise<BacklinksResponse | undefined> {
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  const path = note
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  try {
    const response = await request(
      `/api/v1/vaults/${encodeURIComponent(vault)}/backlinks/${path}`,
      { headers: { accept: "application/json" } },
    );
    if (!response.ok) return undefined;
    return readBacklinks(await response.json());
  } catch {
    return undefined;
  }
}

/**
 * Validates the response.
 *
 * The client does not trust the server any more than the server trusts the client
 * (`AGENTS.md` §4.3). Every field here reaches the DOM, and a `path` that is not a string
 * reaches an attribute; entries of the wrong shape are dropped rather than rendered.
 */
export function readBacklinks(body: unknown): BacklinksResponse | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const note = record["note"];
  const sources = record["sources"];
  const mentions = record["mentions"];
  if (typeof note !== "string" || note === "") return undefined;
  // why: a missing `mentions` is refused rather than defaulted to empty. The bundle is served
  // by the server it talks to, so there is no version skew to be tolerant of — a response
  // without the field is a server that is broken, and "no mentions" would hide that.
  if (!Array.isArray(sources) || !Array.isArray(mentions)) return undefined;

  const validSources: BacklinkSource[] = [];
  for (const entry of sources) {
    const source = readSource(entry);
    if (source !== undefined) validSources.push(source);
  }
  const validMentions: MentionSource[] = [];
  for (const entry of mentions) {
    const mention = readMention(entry);
    if (mention !== undefined) validMentions.push(mention);
  }
  return { note, sources: validSources, mentions: validMentions };
}

function readMention(entry: unknown): MentionSource | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const record = entry as Record<string, unknown>;
  const path = record["path"];
  const title = record["title"];
  const contexts = record["contexts"];
  if (typeof path !== "string" || path === "") return undefined;
  if (title !== null && typeof title !== "string") return undefined;
  if (!Array.isArray(contexts)) return undefined;

  const text = contexts.filter((value): value is string => typeof value === "string");
  // A mention with no readable sentence is not a row: it would name a note without saying
  // why it is there, which is exactly the difference between a mention and a backlink.
  if (text.length === 0) return undefined;
  return { path, title, contexts: text };
}

function readSource(entry: unknown): BacklinkSource | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const record = entry as Record<string, unknown>;
  const path = record["path"];
  const title = record["title"];
  const links = record["links"];
  if (typeof path !== "string" || path === "") return undefined;
  if (title !== null && typeof title !== "string") return undefined;
  if (!Array.isArray(links)) return undefined;

  const valid: Backlink[] = [];
  for (const link of links) {
    const parsed = readLink(link);
    if (parsed !== undefined) valid.push(parsed);
  }
  // A source with no usable link is not a row: it would name a note without saying why.
  if (valid.length === 0) return undefined;
  return { path, title, links: valid };
}

function readLink(entry: unknown): Backlink | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const record = entry as Record<string, unknown>;
  const context = optionalString(record["context"]);
  const sourceBlock = optionalString(record["source_block"]);
  const anchor = optionalString(record["anchor"]);
  if (context === false || sourceBlock === false || anchor === false) return undefined;
  if (typeof record["embed"] !== "boolean") return undefined;
  const anchorKind = record["anchor_kind"];
  if (anchorKind !== "none" && anchorKind !== "heading" && anchorKind !== "block") {
    return undefined;
  }
  return { context, sourceBlock, embed: record["embed"], anchorKind, anchor };
}

/** `null` for absent, the string for a string, `false` for "this is not either". */
function optionalString(value: unknown): string | null | false {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : false;
}
