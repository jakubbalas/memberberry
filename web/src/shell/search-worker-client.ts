/** Browser wrapper around the compact-search worker. */

import { querySearchSegments, type CompactSearchResults } from "../notes.js";

let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<number, { resolve: (result: CompactSearchResults) => void; reject: (error: Error) => void }>();

/** Queries off the main thread when workers exist, with a correct in-thread fallback. */
export function queryInWorker(
  query: string,
  segments: readonly Uint8Array[],
): Promise<CompactSearchResults> {
  if (typeof Worker === "undefined") return querySearchSegments(query, segments);
  try {
    worker ??= spawnWorker();
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      // Copying is intentional: transfer would detach IndexedDB-owned bytes while a search is
      // in flight. The worker owns the CPU work, not the permission-sensitive replica.
      worker?.postMessage({ id, query, segments: segments.map((segment) => segment.slice().buffer) });
    });
  } catch {
    return querySearchSegments(query, segments);
  }
}

function spawnWorker(): Worker {
  const spawned = new Worker(new URL("./search-worker.ts", import.meta.url), { type: "module" });
  spawned.onmessage = (event: MessageEvent<WorkerReply>): void => {
    const reply = event.data;
    const request = pending.get(reply.id);
    if (request === undefined) return;
    pending.delete(reply.id);
    if ("error" in reply) request.reject(new Error(reply.error));
    else request.resolve(reply.result);
  };
  spawned.onerror = (): void => {
    for (const request of pending.values()) request.reject(new Error("search worker failed"));
    pending.clear();
    worker = undefined;
  };
  return spawned;
}

type WorkerReply =
  | { readonly id: number; readonly result: CompactSearchResults }
  | { readonly id: number; readonly error: string };
