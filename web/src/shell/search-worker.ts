/** The compact-index worker shim; all query semantics remain in Rust/WASM (§14.2). */

import { querySearchSegments } from "../notes.js";

interface QueryRequest {
  readonly id: number;
  readonly query: string;
  readonly segments: readonly ArrayBuffer[];
}

const scope: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<QueryRequest>): void => {
  const request = event.data;
  void querySearchSegments(request.query, request.segments.map((segment) => new Uint8Array(segment)))
    .then((result) => scope.postMessage({ id: request.id, result }))
    .catch((error: unknown) => scope.postMessage({ id: request.id, error: String(error) }));
};
