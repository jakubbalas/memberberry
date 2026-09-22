/** Device-local folder expansion preferences, isolated by account and vault. */
export interface TreeExpansion {
  readonly vault: string;
  readonly user: string;
  readonly storage?: Pick<Storage, "getItem" | "setItem"> | undefined;
}

function key(scope: TreeExpansion): string {
  return `memberberry:tree-expansion:${JSON.stringify([scope.user, scope.vault])}`;
}

/** Restores preferences without adding any entries to the server-filtered tree. */
export function readTreeExpansion(scope: TreeExpansion | undefined): ReadonlySet<string> {
  if (scope === undefined) return new Set();
  try {
    const stored = (scope.storage ?? localStorage).getItem(key(scope));
    const paths: unknown = stored === null ? [] : JSON.parse(stored);
    return Array.isArray(paths) && paths.every((path: unknown) => typeof path === "string")
      ? new Set<string>(paths)
      : new Set();
  } catch {
    return new Set();
  }
}

/** Saves expansion best-effort; unavailable storage must not prevent tree navigation. */
export function writeTreeExpansion(scope: TreeExpansion | undefined, paths: ReadonlySet<string>): void {
  if (scope === undefined) return;
  try {
    (scope.storage ?? localStorage).setItem(key(scope), JSON.stringify([...paths]));
  } catch {
    return;
  }
}
