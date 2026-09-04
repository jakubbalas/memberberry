/**
 * Following a link from inside the editor (`SPEC.md` §8.2, §9.2).
 *
 * Clicking a wikilink navigates; Cmd/Ctrl-click opens a new tab; Cmd/Ctrl-Alt-click opens a
 * split. Until this existed a wikilink rendered as inert text — the one thing a note full of
 * links is for.
 *
 * **The editor asks; the shell decides.** A click becomes an {@link OPEN_NOTE_EVENT} raised
 * from the link itself, and whatever mounted the editor listens for it. That is the same
 * shape `task-view.ts` uses for its chips, and for the same reason: the editor is created by
 * `note-surface.ts` with no access to the workspace store, and giving it one would mean the
 * editor could not be mounted without a workspace around it. It would also put the §8.3
 * split rules — which are facts about the viewport — inside the document.
 *
 * **The reference travels as a reference, not as a path.** A wikilink names a note; which
 * note that is depends on §4.3's nearest-path rule *and* on which notes the reader may see
 * (E9), so only the server can answer it. Nothing here resolves anything.
 */

import type { EmbedAnchorKind } from "./embed.js";

/**
 * Fired at the editor's DOM when the reader asks to follow a link.
 *
 * An event rather than a callback: an embed's jump-to-source affordance is nested inside a
 * node view inside the editor, and threading a callback down to it would be a prop chain
 * through every layer that happens to sit between.
 */
export const OPEN_NOTE_EVENT = "memberberry:open-note";

/** Where the note should open (§8.2). */
export type OpenNoteIntent = "here" | "tab" | "split";

/** The `detail` of an {@link OPEN_NOTE_EVENT}. */
export interface OpenNoteDetail {
  /**
   * What to open: a wikilink target as the note spells it, or a canonical path.
   *
   * `resolved` says which. A path the server already resolved — an embed's own identity —
   * must not be resolved a second time: resolution is relative to the note it is read from,
   * and re-resolving `Archive/Roadmap.md` from a different folder can land elsewhere.
   */
  readonly target: string;
  readonly anchorKind: EmbedAnchorKind;
  readonly anchor: string | null;
  readonly intent: OpenNoteIntent;
  /** True when `target` is already a canonical vault-relative path. */
  readonly resolved: boolean;
  /**
   * The note the reference was written in, when that is not the note the pane is showing.
   *
   * Set by an embed for a link inside the content it transcluded: that link was written in
   * the *embedded* note, and §4.3 breaks a name collision by nearest path to the note the
   * reference is read from. Absent means "this pane's note", which is every other case.
   */
  readonly from?: string | undefined;
}

/** The modifiers a pointer event carried, as §8.2's three intents. */
export function openIntent(event: {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
}): OpenNoteIntent {
  // Either modifier counts as `Mod`. The platform question §8.4 answers for *keyboard*
  // bindings does not arise here: a click carries whichever key the user actually held, and
  // accepting both is what makes a Ctrl-click work for someone on a Mac with a PC keyboard.
  const mod = event.metaKey || event.ctrlKey;
  if (!mod) return "here";
  return event.altKey ? "split" : "tab";
}

/** Asks whoever mounted the editor to open a note. */
export function requestOpenNote(from: EventTarget, detail: OpenNoteDetail): void {
  from.dispatchEvent(
    // `composed` so the event still crosses out of a shadow root, which the editor is not in
    // today and which is not worth being fragile about.
    new CustomEvent<OpenNoteDetail>(OPEN_NOTE_EVENT, {
      bubbles: true,
      composed: true,
      detail,
    }),
  );
}

/** The reference a rendered wikilink carries, from `mb-core`'s data attributes. */
export function referenceOf(
  element: HTMLElement,
): Pick<OpenNoteDetail, "target" | "anchorKind" | "anchor"> | undefined {
  const target = element.dataset["target"];
  if (target === undefined || target === "") return undefined;
  const kind = element.dataset["anchorKind"];
  const anchor = element.dataset["anchor"];
  if (kind === "heading" || kind === "block") {
    return { target, anchorKind: kind, anchor: anchor ?? null };
  }
  return { target, anchorKind: "none", anchor: null };
}
