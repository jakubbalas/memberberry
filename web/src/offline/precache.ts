/**
 * What a first visit has to keep so a later one can start with no network (`SPEC.md` §7.4).
 *
 * Pure on purpose: the service worker itself is a boundary with no decisions in it, and the
 * build script that fills this list in is another. Everything that decides *what* is cached
 * and *when a cache is stale* lives here, where a test can see it.
 */

/**
 * The unbootstrapped application shell.
 *
 * `mb-server` serves the Vite `index.html` verbatim at this path — the same bytes, with the
 * bootstrap element still empty. It is what a navigation falls back to when the network is
 * gone: the vault and note come from the URL and the user from `localStorage`
 * (`shell/bootstrap.ts`), because offline there is no server to inject them.
 *
 * A shell rather than the cached note page it was asked for. Caching the server's answer
 * would put one user's note path and display name in a cache the next user of that browser
 * profile shares, and would only work for notes already visited. One shell, carrying no
 * vault data at all, works for every note and leaks nothing.
 */
export const SHELL_URL = "/app.html";

/**
 * Precached regardless of what the build emitted.
 *
 * The manifest and its icon are what make the application installable; without them in the
 * cache an installed window that starts offline has no manifest to read.
 */
export const ALWAYS: readonly string[] = [SHELL_URL, "/manifest.webmanifest", "/icon.svg"];

/** A cache name and the exact set of URLs it should hold. */
export interface PrecachePlan {
  /** Changes whenever the URL list does, which is what retires the previous cache. */
  readonly version: string;
  readonly urls: readonly string[];
}

/**
 * The plan for a set of built files, named relative to the build root.
 *
 * Everything under `assets/` is precached, including the lazy chunks and the WebAssembly
 * module. The bundle budget (§21.2) counts what a *first paint* needs and deliberately
 * excludes a chunk behind a command; an offline cache is the opposite question — a graph
 * that cannot open on a train is a feature that does not work offline. The whole build is
 * ~1.6 MB and this happens once per version.
 *
 * Source maps are skipped: they are a debugging aid fetched only when devtools is open, and
 * they are larger than the code they describe.
 */
export function planPrecache(files: readonly string[]): PrecachePlan {
  const urls = new Set<string>(ALWAYS);
  for (const file of files) {
    if (!file.startsWith("assets/") || file.endsWith(".map")) continue;
    urls.add(`/${file}`);
  }
  const sorted = [...urls].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { version: fingerprint(sorted), urls: sorted };
}

/** The cache one plan owns. Versioned, so an older plan's cache is a different cache. */
export function cacheName(version: string): string {
  return `${CACHE_PREFIX}${version}`;
}

/**
 * The caches this application owns that are not `current`.
 *
 * Scoped by prefix rather than deleting everything: a browser profile's cache storage is
 * shared with whatever else the origin does, and `caches.delete` on a name we do not
 * recognise is somebody else's data.
 */
export function staleCaches(names: readonly string[], current: string): string[] {
  return names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== current);
}

const CACHE_PREFIX = "memberberry-app-";

/**
 * A short, stable fingerprint of the URL list.
 *
 * FNV-1a rather than a real digest: this runs in a build script and in no security context —
 * it only has to change when the list does. `SubtleCrypto` is async and would make the plan
 * a promise for nothing.
 */
function fingerprint(urls: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const character of urls.join("\n")) {
    hash ^= character.codePointAt(0) ?? 0;
    // FNV's 32-bit prime, as shifts: `hash * 16777619` overflows a double's integer range.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(36);
}
