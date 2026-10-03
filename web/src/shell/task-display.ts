/** Task presentation preferences; local to this user, vault and device, never note content. */
export interface TaskDisplayPreferences {
  readonly showFilenames: boolean;
  readonly showPaths: boolean;
}

/** Minimal storage boundary shared by both task surfaces. */
export interface TaskDisplayScope {
  readonly user: string;
  readonly vault: string;
  readonly storage?: Pick<Storage, "getItem"> | undefined;
}

const DEFAULTS: TaskDisplayPreferences = { showFilenames: false, showPaths: false };

function key(scope: TaskDisplayScope): string {
  return `memberberry:task-display:${JSON.stringify([scope.user, scope.vault])}`;
}

/** Restore valid flags independently; unavailable storage falls back to headings. */
export function readTaskDisplay(scope: TaskDisplayScope): TaskDisplayPreferences {
  try {
    const raw = (scope.storage ?? localStorage).getItem(key(scope));
    const value: unknown = raw === null ? undefined : JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return DEFAULTS;
    const record = value as Record<string, unknown>;
    return { showFilenames: record["showFilenames"] === true, showPaths: record["showPaths"] === true };
  } catch {
    return DEFAULTS;
  }
}

/** Best-effort chrome persistence; callers retain working in-memory settings on failure. */
export function writeTaskDisplay(scope: TaskDisplayScope & { readonly storage?: Pick<Storage, "getItem" | "setItem"> | undefined }, value: TaskDisplayPreferences): void {
  try {
    (scope.storage ?? localStorage).setItem(key(scope), JSON.stringify(value));
  } catch {
    // why: blocked/full local storage must not disable task navigation or editing.
  }
}
