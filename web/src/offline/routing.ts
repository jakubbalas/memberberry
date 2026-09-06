/**
 * Which requests the service worker answers, and how (`SPEC.md` §7.4).
 *
 * Pure, and separate from the worker for the reason `graph-colours.ts` is separate from
 * `graph-gl.ts`: a service worker has no testable scope outside a browser, so nothing that
 * makes a decision may live in one.
 *
 * The rule that matters most is the last one. **Nothing under `/api/` is ever cached.**
 * Those answers are permission-filtered for the user who asked (§6.4), and a cached copy is
 * a filtered answer replayed after the filter changed — the offline half of the revocation
 * problem §6.7 already admits to. What a client may keep offline is replicated deliberately
 * through IndexedDB (§7.2), where reconnect can drop what it may no longer read (§7.4). An
 * HTTP cache has no such hook, so it gets nothing.
 */

/** How one request is served. */
export type Strategy =
  /** Network first; the cached shell or the offline page if the network is gone. */
  | "navigate"
  /** Served from the precache, which holds only content-hashed build output. */
  | "cache-first"
  /** Passed through untouched. The service worker adds nothing and stores nothing. */
  | "network-only";

/** The parts of a `Request` the decision reads. */
export interface RequestFacts {
  readonly url: string;
  readonly method: string;
  /** `"navigate"` for a page load; a browser sets this, not us. */
  readonly mode: string;
}

/** What the worker knows about itself when it decides. */
export interface RoutingContext {
  readonly origin: string;
  /** Exactly the URLs the install step stored, as same-origin paths. */
  readonly precached: ReadonlySet<string>;
}

/**
 * Chooses a strategy for one request.
 *
 * Deny by default in the caching sense: anything not recognised is passed straight to the
 * network, so a route added later is served correctly — never stale — until somebody decides
 * otherwise here.
 */
export function strategyFor(request: RequestFacts, context: RoutingContext): Strategy {
  // A cache is a store of GET answers. A POST is a `/login` or a rename, and replaying one
  // offline would be a write the user did not ask for twice.
  if (request.method !== "GET") return "network-only";
  const url = parseUrl(request.url);
  if (url === undefined || url.origin !== context.origin) return "network-only";
  if (request.mode === "navigate") return "navigate";
  return context.precached.has(url.pathname) ? "cache-first" : "network-only";
}

/** What a navigation gets when the network cannot answer it. */
export type OfflineFallback =
  /** The application shell: this URL names a note, and the client boots from the URL. */
  | "shell"
  /** A page saying the network is required. Nothing offline can render this route. */
  | "offline-page";

/**
 * The fallback for a path the network refused to answer.
 *
 * Only `/v/<vault>/<note>` gets the shell, because only that route is the application. `/`
 * is a server-rendered vault list and `/login` is a form that needs a server to post to;
 * handing either the shell would render an editor over a URL that has never been one.
 */
export function offlineFallbackFor(pathname: string): OfflineFallback {
  return /^\/v\/[^/]+\/.+/.test(pathname) ? "shell" : "offline-page";
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
