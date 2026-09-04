/**
 * Resolving one transclusion (`SPEC.md` §9.2).
 *
 * The pure half of the client side: what to ask the server, what its answer is allowed to
 * look like, and — §9.2's mandatory part — when to refuse to expand an embed at all. None
 * of it touches the DOM, so the resolution stack can be tested without mounting an editor.
 *
 * **Why the stack is here rather than on the server.** The recursion is the client's: the
 * server answers for exactly one reference, and an embed inside an embed is a second
 * request made by the view that mounted the first. So the chain of notes from the open note
 * down to this embed only exists on this side, and that chain is what stops a cycle.
 * A crafted note therefore cannot make the server loop, and it cannot make this loop
 * either — every expansion is bounded by {@link MAX_EMBED_DEPTH} before any request is
 * sent.
 *
 * **What is deliberately *not* here: permissions.** The server resolves a reference against
 * the readable set (E7) and answers a target the caller may not read exactly as it answers
 * one that does not exist. Neither this module nor the view can tell those apart, which is
 * §6.5 holding: there is nothing on this side to filter, and adding a filter here would be
 * the client-side boundary `AGENTS.md` §3.1 forbids.
 */

/** Which part of the target a reference names (§9.1 `anchor_kind`). */
export type EmbedAnchorKind = "none" | "heading" | "block";

/** One `![[…]]` reference, as the wikilink node holds it. */
export interface EmbedRequest {
  /** The target exactly as the note spells it. */
  readonly target: string;
  readonly anchorKind: EmbedAnchorKind;
  /** The heading text or `^block-id`, without its caret. `null` when there is no anchor. */
  readonly anchor: string | null;
}

/** The server's answer for a reference it resolved and read. */
export interface EmbedContent {
  /** The canonical identity the reference resolved to — what the stack compares. */
  readonly note: string;
  readonly title: string | null;
  /** The slice, as an HTML fragment. Empty when `found` is false. */
  readonly html: string;
  /** Whether the anchor named anything in that note. */
  readonly found: boolean;
}

/**
 * What to render for one reference.
 *
 * Five states rather than "content or nothing", because they call for five different things
 * on screen and collapsing any two of them would be a claim nobody checked:
 *
 * - `content` — expand it.
 * - `unavailable` — absent *or* unreadable, and by design indistinguishable (§6.5). The
 *   placeholder must be neutral: it is the one state where saying more would be a leak.
 * - `no-section` — the note is there and readable, and has no such heading or block. Not a
 *   permission boundary, so it does not have to be blurred into one.
 * - `cycle` — this note is already on the stack. §9.2: render as a plain link.
 * - `depth` — deeper than §9.2 allows. Also a plain link, and never a request.
 */
export type EmbedOutcome =
  | { readonly state: "content"; readonly content: EmbedContent }
  | { readonly state: "unavailable" }
  | { readonly state: "no-section"; readonly note: string; readonly title: string | null }
  | { readonly state: "cycle"; readonly note: string }
  | { readonly state: "depth" };

/**
 * How many embeds may nest before one renders as a link instead (§9.2).
 *
 * Counted in embeds, not in notes: the open note is depth 0, the embed written in it is
 * depth 1, and depth 4 is refused.
 */
export const MAX_EMBED_DEPTH = 3;

export interface ResolveEmbedOptions {
  /** Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Cancels the request when the view is destroyed. */
  readonly signal?: AbortSignal;
}

/**
 * The notes an embed is nested inside, outermost first.
 *
 * Always non-empty in practice — element 0 is the note the reader has open — and that is
 * what makes a self-embed a cycle rather than an infinite regress.
 */
export type EmbedStack = readonly string[];

/**
 * Whether a reference at this depth may be expanded at all.
 *
 * Separate from {@link resolveEmbed} because it is the check that has to happen *before* a
 * request: the point of a depth limit is that a chain of embeds cannot make an unbounded
 * number of them.
 */
export function tooDeep(stack: EmbedStack): boolean {
  return stack.length > MAX_EMBED_DEPTH;
}

/** Whether expanding `note` here would revisit a note already being rendered (§9.2). */
export function revisits(stack: EmbedStack, note: string): boolean {
  return stack.includes(note);
}

/**
 * Asks the server what one reference stands for, and decides what to render.
 *
 * Never throws and never rejects: an embed that cannot be resolved is a placeholder, not an
 * error that takes the editor down with it. A refusal and a failure both come back as
 * `unavailable`, which is also what the server's own denial looks like.
 */
export async function resolveEmbed(
  vault: string,
  request: EmbedRequest,
  stack: EmbedStack,
  options: ResolveEmbedOptions = {},
): Promise<EmbedOutcome> {
  if (tooDeep(stack)) return { state: "depth" };
  const from = stack.at(-1);
  if (from === undefined || from === "") return { state: "unavailable" };

  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  let body: unknown;
  try {
    const response = await send(embedUrl(vault, request, from), {
      headers: { accept: "application/json" },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) return { state: "unavailable" };
    body = await response.json();
  } catch {
    return { state: "unavailable" };
  }

  const content = readEmbed(body);
  if (content === undefined) return { state: "unavailable" };
  // The identity comes from the server, so the comparison is against the note the reference
  // *actually* means — not against the name it was written by, which two notes may share.
  if (revisits(stack, content.note)) return { state: "cycle", note: content.note };
  if (!content.found) {
    return { state: "no-section", note: content.note, title: content.title };
  }
  return { state: "content", content };
}

/**
 * The route for one reference.
 *
 * why: the whole target is percent-encoded, separators included, rather than encoded
 * segment by segment as the backlinks client does. A wikilink target is note *text* — it can
 * be `../secrets` — and a `..` left as a path segment is normalised by the browser before
 * the request is sent, so the request would arrive at a different route than the one this
 * function names. `%2F` routes exactly as `/` does here, which is not a guess: axum matches
 * the raw path and percent-decodes the captured segment afterwards, and
 * `embeds_accept_a_target_with_its_separators_encoded` in `mb-server/tests/http.rs` pins it.
 */
export function embedUrl(vault: string, request: EmbedRequest, from: string): string {
  const target = encodeURIComponent(request.target);
  const query = new URLSearchParams({ from });
  if (request.anchorKind !== "none" && request.anchor !== null && request.anchor !== "") {
    query.set("anchor_kind", request.anchorKind);
    query.set("anchor", request.anchor);
  }
  return `/api/v1/vaults/${encodeURIComponent(vault)}/embed/${target}?${query.toString()}`;
}

/**
 * Validates the response.
 *
 * `html` reaches the page as markup, so this is the last place anything can be said about
 * its shape. What makes that safe is not this function: the fragment is built by the same
 * Rust renderer the share-link path uses, which escapes every text node and neutralises
 * every URL scheme that executes (`mb-core/src/html.rs`). What this does is refuse a body
 * that is not the shape the route promises, rather than reading `undefined` into the DOM.
 */
export function readEmbed(body: unknown): EmbedContent | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const note = record["note"];
  const title = record["title"];
  const html = record["html"];
  const found = record["found"];
  if (typeof note !== "string" || note === "") return undefined;
  if (title !== null && title !== undefined && typeof title !== "string") return undefined;
  if (typeof html !== "string") return undefined;
  if (typeof found !== "boolean") return undefined;
  return { note, title: typeof title === "string" ? title : null, html, found };
}

/** What an embed is labelled with: the target's title if it has one, else its filename. */
export function embedLabel(note: string, title: string | null): string {
  if (title !== null && title !== "") return title;
  const filename = note.split("/").pop() ?? note;
  return filename.replace(/\.md$/, "");
}
