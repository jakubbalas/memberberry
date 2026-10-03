import type { NoteAnchor } from "../editor/note-anchor.js";
import type { TabId } from "./workspace.js";

/** Sent to the destination pane after Svelte mounts it, before its editor may be ready. */
export const NOTE_ANCHOR_EVENT = "memberberry:note-anchor";

/** Delivers a transient jump only to the matching vault, tab and note, never to another split. */
export function requestNoteAnchor(vault: string, tab: TabId, note: string, anchor: NoteAnchor): void {
  if (typeof document === "undefined") return;
  // why: compare attribute values rather than interpolating user note names into a selector.
  for (const pane of document.querySelectorAll<HTMLElement>(".note-pane[data-note-tab]")) {
    if (pane.dataset["noteTab"] !== tab || pane.dataset["noteVault"] !== vault || pane.dataset["notePath"] !== note) continue;
    pane.dispatchEvent(new CustomEvent<NoteAnchor>(NOTE_ANCHOR_EVENT, { detail: anchor }));
  }
}
