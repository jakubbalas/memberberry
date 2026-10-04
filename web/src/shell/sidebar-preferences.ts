/** Device-local sidebar chrome; never part of synced workspace or note content. */
export interface SidebarPreferenceScope {
  readonly user: string;
  readonly vault: string;
  readonly storage?: Pick<Storage, "getItem" | "setItem"> | undefined;
}

/** Independent widths in CSS pixels, retained when a panel is collapsed. */
export interface SidebarWidths {
  readonly left: number;
  readonly right: number;
}

/** Titles remain the default; filenames include the original extension. */
export interface SidebarPreferences extends SidebarWidths {
  readonly showFilenames: boolean;
}

/** Keep room for the five navigation tools and for a readable center column. */
export const MIN_SIDEBAR_WIDTH = 248;
export const MAX_SIDEBAR_WIDTH = 560;
const MIN_MAIN_WIDTH = 320;
const DEFAULTS: SidebarPreferences = { showFilenames: false, left: MIN_SIDEBAR_WIDTH, right: MIN_SIDEBAR_WIDTH };

function key(scope: SidebarPreferenceScope): string {
  return `memberberry:sidebar-preferences:${JSON.stringify([scope.user, scope.vault])}`;
}

function storedWidth(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= MIN_SIDEBAR_WIDTH && value <= MAX_SIDEBAR_WIDTH
    ? value : MIN_SIDEBAR_WIDTH;
}

/** Restore valid fields only; blocked/corrupt local storage never blocks navigation. */
export function readSidebarPreferences(scope: SidebarPreferenceScope): SidebarPreferences {
  try {
    const raw = (scope.storage ?? localStorage).getItem(key(scope));
    const parsed: unknown = raw === null ? undefined : JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULTS;
    const record = parsed as Record<string, unknown>;
    return { showFilenames: record["showFilenames"] === true, left: storedWidth(record["left"]), right: storedWidth(record["right"]) };
  } catch {
    return DEFAULTS;
  }
}

/** Save best-effort; in-memory preferences continue working after storage failure. */
export function writeSidebarPreferences(scope: SidebarPreferenceScope, value: SidebarPreferences): void {
  try {
    (scope.storage ?? localStorage).setItem(key(scope), JSON.stringify(value));
  } catch {
    // why: preferences are disposable chrome, not a failed content save.
  }
}

/** Maximum width with the other visible panel and a usable main area reserved. */
export function sidebarMaximum(viewport: number, other: number): number {
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, viewport - other - MIN_MAIN_WIDTH));
}

/** Fit restored desktop panels to this viewport without overwriting the saved preference. */
export function clampSidebarWidths(widths: SidebarWidths, viewport: number, collapsed: { readonly left: boolean; readonly right: boolean }): SidebarWidths {
  const clamp = (value: number): number => Number.isFinite(value) ? Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, value)) : MIN_SIDEBAR_WIDTH;
  let left = clamp(widths.left);
  let right = clamp(widths.right);
  // why: reserve each open panel's minimum before assigning the remaining space. Narrowing
  // the viewport must not let one remembered panel push its opposite or the editor offscreen.
  if (!collapsed.left) left = Math.min(left, sidebarMaximum(viewport, collapsed.right ? 0 : MIN_SIDEBAR_WIDTH));
  if (!collapsed.right) right = Math.min(right, sidebarMaximum(viewport, collapsed.left ? 0 : left));
  return { left, right };
}
