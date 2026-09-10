/**
 * The browser entry point.
 *
 * A shim, the same role `mb-cli/src/main.rs` plays: it finds the mount element, reads what
 * the server said about the page, restores the workspace and hands the result to Svelte.
 * Everything worth testing is in the modules it calls, which is why this file is excluded
 * from coverage.
 */

import { mount } from "svelte";

import { localOfflineStore, localReplica } from "./offline/local.js";
import { noteFetcher, prefetchPinned } from "./offline/prefetch.js";
import { syncClientIndex } from "./offline/search-index.js";
import {
  afterLoad,
  registerOfflineShell,
  type ServiceWorkerRegistrar,
} from "./offline/register.js";
import NoteWorkspace from "./shell/NoteWorkspace.svelte";
import Workspace from "./shell/Workspace.svelte";
import { remoteSyncFor, resolveNoteBootstrap } from "./shell/bootstrap.js";
import { startWorkspace } from "./shell/session.js";
import ShareTarget from "./clipper/ShareTarget.svelte";
import { loadShareTarget } from "./clipper/share-target.js";

const target = document.querySelector<HTMLElement>("#app");
if (target === null) {
  throw new Error("the page is missing its #app mount element");
}
// Narrowed above; named so the closure below keeps the narrowing.
const mountPoint: HTMLElement = target;

const bootstrap = resolveNoteBootstrap(
  mountPoint,
  location,
  typeof localStorage === "undefined" ? undefined : localStorage,
);

/**
 * Wrapped in a function rather than written as top-level `await`.
 *
 * why: top-level await needs an ES2022 build target, and raising the browser baseline is a
 * decision worth making on its own rather than as a side effect of restoring a layout. (The
 * CSS already asks for more than the current target admits — `color-mix()` and `dvh` — so
 * that decision is coming; it is not this change.)
 */
async function start(): Promise<void> {
  if (location.pathname === "/share") {
    const draft = await loadShareTarget(location.search);
    if (draft !== null) {
      mount(ShareTarget, { target: mountPoint, props: { draft } });
      return;
    }
  }
  if (bootstrap === undefined) {
    // No server said which note this is: the Vite dev server serving `index.html`
    // unmodified. One local replica, with no vault to restore a layout for (§3.1, layer 2).
    mount(NoteWorkspace, { target: mountPoint, props: {} });
    return;
  }

  const started = await startWorkspace({ vault: bootstrap.vault, note: bootstrap.note });
  mount(Workspace, {
    target: mountPoint,
    props: { store: started.store, session: { vault: bootstrap.vault, user: bootstrap.user } },
  });

  // why: registered only from a page a server bootstrapped, and only after it has loaded.
  // The `npm run dev` inner loop serves `index.html` from Vite with no bootstrap and no
  // `/sw.js` to fetch, and a worker caching dev-server modules is a debugging session nobody
  // asked for. `afterLoad` keeps the precache off the critical path (§21.2).
  //
  // The annotation is what makes the guard mean something: the DOM types declare
  // `navigator.serviceWorker` as always present, and it is absent in an insecure context and
  // in some private windows.
  const workers: ServiceWorkerRegistrar | undefined =
    "serviceWorker" in navigator ? navigator.serviceWorker : undefined;
  afterLoad(window, () => {
    void registerOfflineShell(workers);
    // §7.2's pinned tier: the notes this device promised to keep are fetched now, in the
    // background, one at a time. After the load event for the same reason the precache is —
    // nothing on screen is waiting for it.
    void reconcileOfflineData();
  });

  const reconnect = (): void => {
    void reconcileOfflineData();
  };
  window.addEventListener("online", reconnect);

  /**
   * Downloads whatever is pinned and not already here (§7.2).
   *
   * Failures are swallowed: a device with nowhere to keep a replica has nothing to do, and a
   * sweep that cannot reach the server gives up by itself after two attempts. Neither is
   * something to interrupt a reader with.
   */
  async function keepPinnedNotes(): Promise<void> {
    if (bootstrap === undefined) return;
    const replica = await localReplica();
    if (replica === undefined) return;
    const { endpoint } = remoteSyncFor(bootstrap, location);
    await prefetchPinned({
      vault: bootstrap.vault,
      replica,
      openNote: noteFetcher({ vault: bootstrap.vault, user: bootstrap.user, endpoint }),
    });
  }

  /** Reconciles permissions before any background work can retain stale offline bytes. */
  async function reconcileOfflineData(): Promise<void> {
    if (bootstrap === undefined) return;
    const store = await localOfflineStore();
    if (store !== undefined) {
      // The compact index owns a separate, stricter replica: zone bytes leave IndexedDB
      // before pinned-body work begins, exactly as §7.4 orders reconnection.
      await syncClientIndex({ vault: bootstrap.vault, store }).catch(() => undefined);
    }
    await keepPinnedNotes();
  }

  // why: `pagehide` rather than `beforeunload`. `beforeunload` is unreliable on mobile, where
  // a backgrounded tab is often discarded without it ever firing — and mobile is the primary
  // target (§21.1). The layout is debounced, so without this the last few hundred
  // milliseconds of pane arrangement would be lost on every navigation.
  window.addEventListener("pagehide", () => {
    window.removeEventListener("online", reconnect);
    void started.destroy();
  }, { once: true });
}

void start();
