/** Picks the tab-switch control for a note, so a scenario never depends on tab order. */

/** What the harness can read off one switch control in the page. */
export interface SwitchTarget {
  /** The desktop tab's `title` attribute, which is the note's path; `null` on mobile. */
  readonly title: string | null;
  /** The control's text: on mobile, the note's name followed by its folder. */
  readonly text: string;
}

/**
 * Returns the index of the one control that opens `path`, or -1 when none or several do.
 *
 * why: the workspace is restored from the server, so its tab order is whatever earlier
 * scenarios left. The diagram page (§21.10) runs first and leaves its tab in front.
 */
export function switchTargetIndex(targets: readonly SwitchTarget[], path: string): number {
  const exact = indexesWhere(targets, (target) => target.title === path);
  if (exact.length > 0) return exact.length === 1 ? (exact[0] ?? -1) : -1;
  const slash = path.lastIndexOf("/");
  if (slash <= 0) return -1;
  const folder = path.slice(0, slash);
  const byFolder = indexesWhere(targets, (target) => target.title === null && target.text.includes(folder));
  return byFolder.length === 1 ? (byFolder[0] ?? -1) : -1;
}

function indexesWhere(targets: readonly SwitchTarget[], test: (target: SwitchTarget) => boolean): number[] {
  return targets.flatMap((target, index) => (test(target) ? [index] : []));
}
