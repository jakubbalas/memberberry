import type { OfflineStore } from "../offline/db.js";

interface State { readonly pending: number; readonly synced: boolean }
const connections = new Set<() => State>();

/** Live transport state covers writes that have not reached IndexedDB bookkeeping yet. */
export function trackPending(read: () => State): () => void {
  connections.add(read);
  return () => { connections.delete(read); };
}

/** Includes restored documents that have not completed server reconciliation yet. */
export function hasPendingConnections(): boolean {
  return [...connections].some(read => { const state = read(); return state.pending > 0 || !state.synced; });
}

/** Checks closed-note dirty records as well as live editors, and fails closed on storage errors. */
export async function canReload(store: OfflineStore | undefined, pending: () => boolean = hasPendingConnections): Promise<boolean> {
  if (store === undefined || pending()) return false;
  try {
    for (const vault of await store.vaults()) {
      if ((await store.residents(vault)).some(body => body.dirty !== false)) return false;
    }
    // A user may have typed while the asynchronous storage reads were running.
    return !pending();
  } catch { return false; }
}
