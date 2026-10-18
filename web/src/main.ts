/**
 * The browser entry point.
 *
 * A shim, the same role `mb-cli/src/main.rs` plays: it finds the mount element, reads what
 * the server said about the page, restores the workspace and hands the result to Svelte.
 * Everything worth testing is in the modules it calls, which is why this file is excluded
 * from coverage.
 */

import { mount, tick } from "svelte";
import { launchDestination } from "./pwa/launch.js";
import { RESUME_SYNC, WORKSPACE_REFRESH } from "./pwa/events.js";
import { canReload } from "./pwa/pending.js";
import { serialRefresh } from "./pwa/refresh.js";

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
import { offlineHomeBootstrap, readHomeBootstrap, remoteSyncFor, resolveNoteBootstrap } from "./shell/bootstrap.js";
import { startWorkspace } from "./shell/session.js";
import ShareTarget from "./clipper/ShareTarget.svelte";
import { loadShareTarget } from "./clipper/share-target.js";
import { applyTheme, readThemeChoice, resolveTheme } from "./shell/theme.js";

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
const homeBootstrap = readHomeBootstrap(mountPoint) ?? offlineHomeBootstrap(location.pathname, typeof localStorage === "undefined" ? undefined : localStorage);
const session = bootstrap ?? homeBootstrap;
if (session !== undefined) {
  const preferences = typeof localStorage === "undefined" ? undefined : localStorage;
  applyTheme(
    document.documentElement,
    resolveTheme(readThemeChoice(preferences, session.vault), session.theme ?? "system"),
  );
}

/**
 * Wrapped in a function rather than written as top-level `await`.
 *
 * why: top-level await needs an ES2022 build target, and raising the browser baseline is a
 * decision worth making on its own rather than as a side effect of restoring a layout. (The
 * CSS already asks for more than the current target admits — `color-mix()` and `dvh` — so
 * that decision is coming; it is not this change.)
 */
async function start(): Promise<void> {
  if (location.pathname === "/app.html" && new URLSearchParams(location.search).get("launch") === "1") {
    location.replace(launchDestination(typeof localStorage === "undefined" ? undefined : localStorage));
    return;
  }
  if (location.pathname === "/share") {
    const draft = await loadShareTarget(location.search);
    if (draft !== null) {
      mount(ShareTarget, { target: mountPoint, props: { draft } });
      return;
    }
  }
  if (session === undefined) {
    // No server said which note this is: the Vite dev server serving `index.html`
    // unmodified. One local replica, with no vault to restore a layout for (§3.1, layer 2).
    mount(NoteWorkspace, { target: mountPoint, props: {} });
    return;
  }

  const started = await startWorkspace({ vault: session.vault, note: bootstrap?.note });
  const refresh = serialRefresh(reconcileOfflineData);
  mount(Workspace, {
    target: mountPoint,
    props: {
      store: started.store,
      session: { vault: session.vault, user: session.user },
      vaultTheme: session.theme,
      home: homeBootstrap !== undefined,
      onresume: async () => { refresh.refresh(); },
      onupdate: async (): Promise<boolean> => {
        if (!navigator.onLine || !await canReload(await localOfflineStore())) return false;
        started.transport.save(started.store.current);
        await started.transport.flush({ final: true });
        if (started.transport.saved === false || !await canReload(await localOfflineStore())) return false;
        location.reload();
        return true;
      },
    },
  });
  // why: mount schedules effects. A completed load must not dispatch the first refresh
  // before the workspace has installed its lifecycle listener.
  await tick();

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
    window.dispatchEvent(new Event(WORKSPACE_REFRESH));
  });

  /**
   * Downloads whatever is pinned and not already here (§7.2).
   *
   * Failures are swallowed: a device with nowhere to keep a replica has nothing to do, and a
   * sweep that cannot reach the server gives up by itself after two attempts. Neither is
   * something to interrupt a reader with.
   */
  async function keepPinnedNotes(): Promise<void> {
    if (session === undefined) return;
    const replica = await localReplica();
    if (replica === undefined) return;
    const { endpoint } = remoteSyncFor({ ...session, note: "" }, location);
    await prefetchPinned({
      vault: session.vault,
      replica,
      openNote: noteFetcher({ vault: session.vault, user: session.user, endpoint }),
      refreshResident: true,
    });
  }

  /** Reconciles permissions before any background work can retain stale offline bytes. */
  async function reconcileOfflineData(): Promise<void> {
    if (session === undefined) return;
    const store = await localOfflineStore();
    if (store !== undefined) {
      // The compact index owns a separate, stricter replica: zone bytes leave IndexedDB
      // before pinned-body work begins, exactly as §7.4 orders reconnection.
      const answer = await syncClientIndex({ vault: session.vault, store }).catch(() => "unreachable");
      if (answer !== "synced") return;
    }
    window.dispatchEvent(new CustomEvent(RESUME_SYNC, { detail: { vault: session.vault } }));
    await keepPinnedNotes();
  }

  // why: `pagehide` rather than `beforeunload`. `beforeunload` is unreliable on mobile, where
  // a backgrounded tab is often discarded without it ever firing — and mobile is the primary
  // target (§21.1). The layout is debounced, so without this the last few hundred
  // milliseconds of pane arrangement would be lost on every navigation.
  const hide = (event: PageTransitionEvent): void => {
    if (event.persisted) {
      // A BFCache document will return with the same editors and listeners.
      started.transport.save(started.store.current);
      void started.transport.flush({ final: true });
      return;
    }
    window.removeEventListener("pagehide", hide);
    refresh.destroy();
    void started.destroy();
  };
  window.addEventListener("pagehide", hide);
}

void start();
