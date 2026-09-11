/**
 * The shell's icon set (`SPEC.md` §8.2).
 *
 * Plain data rather than a component per icon, and **no dependency**: an icon library on the
 * critical path costs §21.1's bundle budget for a dozen paths that never change, and a font
 * icon would be a network request C1 forbids. Every glyph is drawn on the same 24-unit grid
 * with `currentColor` and a single stroke width, which is what makes a row of them line up
 * and inherit a theme without any icon knowing which theme is in force.
 *
 * Only what the chrome actually draws is here. An icon arrives with the control that needs
 * it, for the same reason a token does (§20.1).
 */

/** Every icon the shell can draw. A name outside this union does not compile. */
export type IconName =
  | "panel-left"
  | "panel-right"
  | "search"
  | "tags"
  | "tasks"
  | "calendar"
  | "chevron-down"
  | "chevron-right"
  | "note"
  | "note-plus"
  | "folder-plus"
  | "folder"
  | "folder-open"
  | "vault"
  | "appearance"
  | "plus"
  | "close";

/**
 * The path commands for each icon, outermost shape first.
 *
 * Separate paths rather than one `d`, so a stroke join never appears where two unrelated
 * strokes happen to meet.
 */
export const ICON_PATHS: Readonly<Record<IconName, readonly string[]>> = {
  "panel-left": ["M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", "M9.5 5v14"],
  "panel-right": ["M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", "M14.5 5v14"],
  search: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z", "m16.2 16.2 4.3 4.3"],
  tags: ["M3 3h8l10 10-8 8L3 11z", "M7 7h.01"],
  tasks: ["M9 6h12", "M9 12h12", "M9 18h12", "m2 6 2 2 3-4", "m2 17 2 2 3-4"],
  calendar: ["M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z", "M7 3v4", "M17 3v4", "M3 11h18", "M8 15h2", "M14 15h2"],
  "chevron-down": ["m6 9.5 6 6 6-6"],
  "chevron-right": ["m9.5 6 6 6-6 6"],
  note: ["M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z", "M14 3v5h5", "M9 13h6", "M9 17h4"],
  "note-plus": ["M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z", "M14 3v5h5", "M9 14h6", "M12 11v6"],
  "folder-plus": ["M4 7.5A2 2 0 0 1 6 5.5h3a2 2 0 0 1 1.4.6l1.1 1.1h6.5a2 2 0 0 1 2 2v7.3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z", "M9 13h6", "M12 10v6"],
  folder: ["M4 7.5A2 2 0 0 1 6 5.5h3a2 2 0 0 1 1.4.6l1.1 1.1h6.5a2 2 0 0 1 2 2v7.3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"],
  "folder-open": [
    "M4 7.5A2 2 0 0 1 6 5.5h3a2 2 0 0 1 1.4.6l1.1 1.1h6.5a2 2 0 0 1 2 2v1.3H4z",
    "M4 10.5h17l-1.6 7a2 2 0 0 1-2 1.5H6a2 2 0 0 1-2-2z",
  ],
  vault: ["M5.5 5.5A2.5 2.5 0 0 1 8 3h10.5v18H8a2.5 2.5 0 0 1-2.5-2.5z", "M9.5 3v18"],
  // A circle whose right half is ruled: appearance is one thing shown two ways, which is
  // what a theme is. Read as a swatch rather than as a sun, so it does not promise that the
  // control only chooses between light and dark.
  appearance: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M12 3v18", "M12 7.5h6.4", "M12 12h8.9", "M12 16.5h6.4"],
  plus: ["M12 5.5v13", "M5.5 12h13"],
  close: ["m6.5 6.5 11 11", "m17.5 6.5-11 11"],
};
