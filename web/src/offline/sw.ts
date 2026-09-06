/// <reference lib="webworker" />
/**
 * The service worker (`SPEC.md` §7.4).
 *
 * An entry shim, like `graph-worker.ts` and `main.ts`: it holds the browser's install,
 * activate and fetch events and nothing that decides anything. What to cache is
 * `precache.ts`, how to serve a request is `routing.ts`, and what an offline navigation
 * renders is `offline-page.ts` — all three are pure and tested. This file is excluded from
 * the coverage floors because a service worker scope does not exist under jsdom, and a mock
 * of one would test the mock (`AGENTS.md` §2.3). What exercises it is `make e2e`, which
 * disconnects a real browser and loads a note.
 *
 * `__PRECACHE__` is replaced at build time by `scripts/build-sw.ts` with the plan for the
 * build sitting next to it. It is injected rather than fetched so that **the worker's own
 * bytes change whenever the asset list does** — a browser only installs a new worker when
 * the script differs, so a worker that read its list from a file would never notice a new
 * build and would go on serving the previous one from cache forever.
 */

import { offlinePage, offlinePageHeaders } from "./offline-page.js";
import { SHELL_URL, cacheName, staleCaches, type PrecachePlan } from "./precache.js";
import { offlineFallbackFor, strategyFor } from "./routing.js";

declare const __PRECACHE__: PrecachePlan;

const PLAN: PrecachePlan = __PRECACHE__;
const CACHE = cacheName(PLAN.version);
const PRECACHED: ReadonlySet<string> = new Set(PLAN.urls);

// why: the same guard `graph-worker.ts` uses. A window has a `self` too, so importing this
// module for its types anywhere else must not install a fetch handler on the page.
if (
  typeof ServiceWorkerGlobalScope !== "undefined" &&
  self instanceof ServiceWorkerGlobalScope
) {
  const scope: ServiceWorkerGlobalScope = self;

  scope.addEventListener("install", (event: ExtendableEvent) => {
    event.waitUntil(install());
  });

  scope.addEventListener("activate", (event: ExtendableEvent) => {
    event.waitUntil(activate(scope));
  });

  scope.addEventListener("fetch", (event: FetchEvent) => {
    const strategy = strategyFor(event.request, {
      origin: scope.location.origin,
      precached: PRECACHED,
    });
    // Not calling `respondWith` at all, rather than calling it with `fetch(request)`. They
    // are not the same: the second makes the worker a proxy for every request in the
    // application, including the ones it has no opinion about.
    if (strategy === "network-only") return;
    event.respondWith(strategy === "cache-first" ? fromCache(event.request) : navigate(event.request));
  });
}

/**
 * Fills the cache for this build.
 *
 * `cache: "reload"` on every request: without it the browser may satisfy the precache from
 * its own HTTP cache, which is how a worker ends up storing the asset it was installed to
 * replace. A failure here fails the install and leaves the previous worker in place — the
 * right direction to be wrong in, since a half-filled cache is a page that loads offline
 * with one chunk missing.
 */
async function install(): Promise<void> {
  const cache = await caches.open(CACHE);
  await cache.addAll(PLAN.urls.map((url) => new Request(url, { cache: "reload" })));
}

async function activate(scope: ServiceWorkerGlobalScope): Promise<void> {
  const names = await caches.keys();
  await Promise.all(staleCaches(names, CACHE).map((name) => caches.delete(name)));
  // why: claim, so the page that registered this worker is controlled without a second
  // navigation. Without it a first visit followed by losing the network has a precache and
  // nothing reading it.
  await scope.clients.claim();
}

/** Precached URLs are content-hashed build output, so the cache is the authority. */
async function fromCache(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  return hit ?? fetch(request);
}

/**
 * A page load: the server if it answers, the shell or the offline page if it cannot.
 *
 * Only a network *error* falls back. A 404 or a 500 is the server saying something — and in
 * this application a 404 is frequently a permission denial (§6.5), which must never be
 * papered over with a cached page.
 */
async function navigate(request: Request): Promise<Response> {
  try {
    return await fetch(request);
  } catch {
    if (offlineFallbackFor(new URL(request.url).pathname) === "shell") {
      const cache = await caches.open(CACHE);
      const shell = await cache.match(SHELL_URL);
      if (shell !== undefined) return shell;
    }
    return new Response(offlinePage(), { status: 503, headers: offlinePageHeaders() });
  }
}
