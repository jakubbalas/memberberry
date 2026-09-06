/**
 * Registering the service worker from the page (`SPEC.md` §7.4).
 *
 * Small, and separate from `main.ts`, because two decisions in it are worth a test: *when*
 * to register, and what to do when registration fails.
 */

/** Where `mb-server` serves the worker. Root-scoped, so it controls `/v/<vault>/<note>`. */
export const SERVICE_WORKER_URL = "/sw.js";

/** The part of `navigator.serviceWorker` this needs. Narrow, so a test can supply it. */
export interface ServiceWorkerRegistrar {
  register(url: string, options: { readonly scope: string; readonly updateViaCache: "none" }): Promise<unknown>;
}

/**
 * Registers the worker, and reports whether it took.
 *
 * A failure is swallowed on purpose. Offline support is an enhancement: a browser with
 * service workers disabled, a private window that refuses to register one, or a server
 * without a `web_root` must all still run the application. It is also deliberately silent —
 * a `console.error` here would be an error on every page load in exactly those browsers,
 * and an error nobody can act on trains people to ignore the console.
 */
export async function registerOfflineShell(
  registrar: ServiceWorkerRegistrar | undefined,
  url: string = SERVICE_WORKER_URL,
): Promise<boolean> {
  if (registrar === undefined) return false;
  try {
    // `updateViaCache: "none"` so the browser revalidates the worker script itself. The
    // default lets an HTTP cache answer for it, which would pin a browser to one build's
    // precache list for as long as that cache entry lived.
    await registrar.register(url, { scope: "/", updateViaCache: "none" });
    return true;
  } catch {
    return false;
  }
}

/** The part of `window` `afterLoad` reads. */
export interface LoadTarget {
  readonly document: { readonly readyState: string };
  addEventListener(type: "load", listener: () => void, options: { once: true }): void;
}

/**
 * Runs `task` once the page has finished loading, or immediately if it already has.
 *
 * why: installing the worker downloads the whole build — around 1.6 MB including the
 * WebAssembly module. Doing that while the page is still fetching its own critical path
 * competes with it, and §21.2 budgets that path on a mid-range phone. Nothing about offline
 * support is urgent on the visit that sets it up; it is for the *next* visit.
 */
export function afterLoad(target: LoadTarget, task: () => void): void {
  if (target.document.readyState === "complete") {
    task();
    return;
  }
  target.addEventListener("load", task, { once: true });
}
