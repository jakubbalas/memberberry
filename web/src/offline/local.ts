/**
 * This page's local replica, opened once (`SPEC.md` §7.2).
 *
 * A module-level handle rather than something threaded from `main.ts`, for the same reason
 * `localStorage` is not threaded: it is one per document, it has no configuration, and the
 * things that need it — the note catalog, a note pane — are constructed deep inside Svelte
 * components that would otherwise each grow a parameter for it.
 *
 * Every consumer takes it as an injectable option defaulting to this, so no test touches a
 * real IndexedDB by accident and no component holds a reference it cannot replace.
 */

import { openOfflineStore, type Factory, type OfflineStore } from "./db.js";
import { createReplica, dropBodyWith, type Replica } from "./replica.js";

let opening: Promise<Replica | undefined> | undefined;
let localStore: OfflineStore | undefined;

/**
 * The replica, or `undefined` where there is nowhere to keep one.
 *
 * `undefined` is a working application without an offline copy — a private window that
 * refuses IndexedDB, an origin whose quota is exhausted, a test environment. Every caller
 * treats it as "no stored answer", which degrades to exactly the online-only behaviour the
 * application had before §7.2.
 */
export function localReplica(): Promise<Replica | undefined> {
  opening ??= open(factory());
  return opening;
}

/** Replaces the page's replica. For tests, and for nothing else. */
export function setLocalReplica(replica: Promise<Replica | undefined> | undefined): void {
  opening = replica;
  localStore = undefined;
}

/** The page's IndexedDB store, for the compact-index owner (§14.2). */
export async function localOfflineStore(): Promise<OfflineStore | undefined> {
  await localReplica();
  return localStore;
}

async function open(available: Factory | undefined): Promise<Replica | undefined> {
  if (available === undefined) return undefined;
  try {
    const store = await openOfflineStore(available);
    localStore = store;
    return createReplica({
      store,
      dropBody: dropBodyWith(available),
    });
  } catch {
    // why: silent. There is nothing a user can do about a refused database, the application
    // works without one, and an error on every page load in a private window is noise that
    // teaches people to ignore the console.
    return undefined;
  }
}

function factory(): Factory | undefined {
  return typeof indexedDB === "undefined" ? undefined : indexedDB;
}
