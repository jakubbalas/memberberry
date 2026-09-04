/**
 * Opening a note the reader asked for from inside a note (`SPEC.md` §8.2, §9.2).
 *
 * The other half of `editor/links.ts`. The editor dispatches a *reference* — the text a
 * wikilink was written with — and this turns it into a note and a place to put it.
 *
 * **Resolution is the server's.** §4.3 resolves a name collision by nearest path *among the
 * notes the asking user may read*, so `[[Roadmap]]` means different notes for two people
 * (§9.1, E9), and there is no answer this side could compute. What is here is one request
 * and its validation.
 *
 * **Placing it is not.** Whether a split is even allowed is a fact about the viewport (§8.3),
 * and the note the reader came from is a fact about this pane — neither is something the
 * server knows, and neither belongs in the editor.
 */

import type { OpenNoteDetail, OpenNoteIntent } from "../editor/links.js";
import { splitLimitFor, type LayoutMode } from "./layout.js";
import type { WorkspaceStore } from "./workspace-store.svelte.js";
import type { GroupId, TabId } from "./workspace.js";

/** The note a reference resolved to. */
export interface ResolvedNote {
  readonly note: string;
  readonly title: string | null;
}

export interface ResolveNoteOptions {
  /** Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}

/**
 * Asks which note `target` means when read from `from`.
 *
 * Returns `undefined` for anything that is not an answer — a denial, a reference to nothing,
 * a body of the wrong shape, a failed request. All of those are the same thing to the reader
 * (the link goes nowhere) and, for the first two, the same thing by design: §6.5 does not
 * allow "you may not read it" to be distinguishable from "it is not there".
 */
export async function resolveNote(
  vault: string,
  target: string,
  from: string,
  options: ResolveNoteOptions = {},
): Promise<ResolvedNote | undefined> {
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  // The whole reference is encoded, separators included: a target is note text and can be
  // `../secrets`, and a `..` left as a path segment is resolved by the browser before the
  // request is sent. See `editor/embed.ts` for the route's side of this.
  const url =
    `/api/v1/vaults/${encodeURIComponent(vault)}/resolve/${encodeURIComponent(target)}` +
    `?${new URLSearchParams({ from }).toString()}`;
  try {
    const response = await send(url, {
      headers: { accept: "application/json" },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) return undefined;
    return readResolved(await response.json());
  } catch {
    return undefined;
  }
}

/** Validates the response. `note` reaches a tab id and an attribute, so it is checked. */
export function readResolved(body: unknown): ResolvedNote | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const note = record["note"];
  const title = record["title"];
  if (typeof note !== "string" || note === "") return undefined;
  if (title !== null && title !== undefined && typeof title !== "string") return undefined;
  return { note, title: typeof title === "string" ? title : null };
}

export interface PlaceNoteOptions {
  readonly store: WorkspaceStore;
  /** The pane the reader was reading in. */
  readonly group: GroupId;
  /** The tab they were reading, if any — what a plain click navigates. */
  readonly tab?: TabId | undefined;
  readonly layout: LayoutMode;
}

/**
 * Puts `note` where the intent asks for it.
 *
 * A plain click *navigates the current tab*, so back and forward work as a reader expects
 * (§8.1's per-tab history); it does not open a second tab on the same note. A split that the
 * layout does not allow degrades to a new tab rather than doing nothing: §8.3 caps how many
 * panes fit on a phone, and a Cmd-Alt-click that silently ignored the reader would look
 * broken rather than adapted.
 */
export function placeNote(
  { store, group, tab, layout }: PlaceNoteOptions,
  note: string,
  intent: OpenNoteIntent,
): void {
  if (intent === "split" && store.groups.length <= splitLimitFor(layout)) {
    // "Split right", the same direction `Mod+\` takes (§8.4).
    store.split(group, "vertical", note);
    return;
  }
  if (intent === "here" && tab !== undefined) {
    store.navigate(tab, note);
    return;
  }
  store.open(note, { group });
}

export interface FollowLinkOptions extends PlaceNoteOptions {
  readonly vault: string;
  /** The note the reference was written in, which resolution is relative to. */
  readonly from: string;
  readonly resolve?: typeof resolveNote;
  readonly signal?: AbortSignal;
}

/**
 * Resolves a reference if it needs it, then opens it.
 *
 * `detail.resolved` is why the check exists rather than always asking: an embed's
 * jump-to-source carries the canonical path the server already resolved, and resolving it
 * again — from a different note, in a vault where two notes may share a name — can land
 * somewhere else.
 */
export async function followLink(
  options: FollowLinkOptions,
  detail: OpenNoteDetail,
): Promise<void> {
  if (detail.resolved) {
    placeNote(options, detail.target, detail.intent);
    return;
  }
  const resolve = options.resolve ?? resolveNote;
  // `detail.from` wins: a link inside transcluded content was written in the embedded note.
  const from = detail.from ?? options.from;
  const found = await resolve(options.vault, detail.target, from, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (found === undefined) return;
  placeNote(options, found.note, detail.intent);
}
