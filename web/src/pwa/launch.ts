/** Installed startup remembers only a same-origin workspace route, never an authority. */
export const LAUNCH_URL = "/app.html?launch=1";
const LAST_WORKSPACE = "memberberry.pwa.last-workspace";
type Store = Pick<Storage, "getItem" | "setItem">;

function workspaceRoute(path: string): boolean {
  try {
    const url = new URL(path, "https://memberberry.invalid");
    return path.startsWith("/v/") && url.origin === "https://memberberry.invalid" &&
      url.pathname === path && !url.search && !url.hash &&
      /^\/v\/[^/]+(?:\/.*)?$/.test(path) && !decodeURIComponent(path).includes("\\");
  } catch { return false; }
}

/** Records the last workspace opened on this device. A later request still authenticates. */
export function rememberLaunch(path: string, storage: Store | undefined): void {
  if (!workspaceRoute(path)) return;
  try { storage?.setItem(LAST_WORKSPACE, path); } catch { /* storage is optional */ }
}

/** Returns a safe local destination, including when storage is unavailable or corrupted. */
export function launchDestination(storage: Store | undefined): string {
  try {
    const path = storage?.getItem(LAST_WORKSPACE);
    return path !== undefined && path !== null && workspaceRoute(path) ? path : "/";
  } catch { return "/"; }
}
