/**
 * What the outline pane does with a keypress, and what a row is called (`SPEC.md` §9.5).
 *
 * The headings themselves come from the editor (`editor/outline.ts`) because reordering
 * sections is a document edit. What is left here is presentation: a flat list of rows
 * indented by level, one tab stop, and the keyboard equivalent of the drag — §8.2 is explicit
 * that native drag-and-drop is not keyboard-operable at all, so the two are separate
 * implementations of one feature rather than one implementation with two entry points.
 */

import type { OutlineHeading } from "../editor/outline.js";

/** What a row is labelled with. A heading nobody has typed into yet still needs a name. */
export function headingLabel(heading: OutlineHeading): string {
  return heading.text === "" ? "Untitled heading" : heading.text;
}

/** What a keypress does in the outline. */
export type OutlineAction =
  | { readonly kind: "move"; readonly to: number }
  | { readonly kind: "goto"; readonly index: number }
  | {
      readonly kind: "reorder";
      readonly from: number;
      readonly to: number;
      /** Where the cursor lands, so it stays on the section that moved. */
      readonly cursor: number;
    }
  | { readonly kind: "none" };

/**
 * Resolves a keypress against the headings.
 *
 * `Alt` with an arrow *moves the section*, matching the editor's own `Move up`/`Move down`
 * controls; the bare arrows move the cursor. Alt is the modifier because Shift-arrow selects
 * and Mod-arrow is a word or line jump in every text field the reader has ever used, and the
 * pane sits beside a text editor.
 */
export function outlineKeyAction(
  key: string,
  modifiers: { readonly altKey: boolean },
  headings: readonly OutlineHeading[],
  cursor: number,
): OutlineAction {
  const count = headings.length;
  if (count === 0 || cursor < 0 || cursor >= count) return { kind: "none" };

  switch (key) {
    case "ArrowDown":
      if (modifiers.altKey) return reorder(headings, cursor, "down");
      return cursor + 1 < count ? { kind: "move", to: cursor + 1 } : { kind: "none" };
    case "ArrowUp":
      if (modifiers.altKey) return reorder(headings, cursor, "up");
      return cursor > 0 ? { kind: "move", to: cursor - 1 } : { kind: "none" };
    case "Home":
      return { kind: "move", to: 0 };
    case "End":
      return { kind: "move", to: count - 1 };
    case "Enter":
    case " ":
      return { kind: "goto", index: cursor };
    default:
      return { kind: "none" };
  }
}

/**
 * The reorder an Alt-arrow means.
 *
 * Downward, the target is the next heading **not inside the section being moved** — moving
 * `## Alpha` down means past `## Beta`, not into `### Alpha detail`, which is one of the
 * blocks travelling. The editor refuses a move into itself anyway (`moveSection`), but a
 * keypress that is refused looks broken: the row would highlight and nothing would happen.
 * Upward every previous heading is outside the section by construction.
 */
function reorder(
  headings: readonly OutlineHeading[],
  cursor: number,
  direction: "up" | "down",
): OutlineAction {
  const moved = headings[cursor];
  if (moved === undefined) return { kind: "none" };
  if (direction === "up") {
    return cursor > 0
      ? { kind: "reorder", from: cursor, to: cursor - 1, cursor: cursor - 1 }
      : { kind: "none" };
  }
  const to = headings.findIndex(
    (heading, index) => index > cursor && heading.level <= moved.level,
  );
  if (to === -1) return { kind: "none" };
  return { kind: "reorder", from: cursor, to, cursor: cursorAfterReorder(headings, cursor, to) };
}

/**
 * Where the moved section's own row ends up.
 *
 * A section carries its subsections, so moving it down past `n` rows moves it up the list by
 * however many rows travelled with it. Without this the cursor is left on whichever heading
 * happened to land underneath, and the next Alt-arrow moves the wrong section.
 */
export function cursorAfterReorder(
  headings: readonly OutlineHeading[],
  from: number,
  to: number,
): number {
  if (to < from) return to;
  const moved = headings[from];
  if (moved === undefined) return from;
  let travelling = 1;
  for (let index = from + 1; index < headings.length; index += 1) {
    const heading = headings[index];
    if (heading === undefined || heading.level <= moved.level) break;
    travelling += 1;
  }
  return to - travelling + 1;
}

/**
 * Whether an outline announcement should be listened to.
 *
 * A split has two editors and both announce; the panel follows the focused pane, which is
 * the same rule §9.5 gives the backlinks panel. A target with no `.pane` ancestor is the
 * mobile layout, which renders exactly one editor and marks no pane as focused (§8.3).
 */
export function fromVisiblePane(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const pane = target.closest(".pane");
  return pane === null || pane.getAttribute("data-focused") === "true";
}
