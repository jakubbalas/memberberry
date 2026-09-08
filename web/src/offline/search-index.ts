/**
 * Permission-first transport for compact client-search segments (§7.4, §14.2, E6).
 *
 * A manifest says exactly which ACL epochs this browser may hold. It is reconciled in
 * IndexedDB before a segment request begins; therefore a revocation removes prior bytes
 * before pinned-note work, sync, or any future search query can use them.
 */

import { validateSearchSegment } from "../notes.js";
import type { OfflineStore, SearchSegment, SearchZone } from "./db.js";

export type SearchManifestAnswer =
  | { readonly kind: "ok"; readonly zones: readonly SearchZone[] }
  | { readonly kind: "denied" }
  | { readonly kind: "unreachable" };

export interface ClientIndexOptions {
  readonly vault: string;
  readonly store: OfflineStore;
  readonly fetch?: typeof globalThis.fetch;
  /** Injectable because tests do not load the generated WASM module. */
  readonly validate?: (bytes: Uint8Array) => Promise<void>;
}

export type ClientIndexResult = "synced" | "denied" | "unreachable";

const HEX = /^[a-f0-9]{64}$/;

/** Fetches the current permission-filtered zone manifest. */
export async function fetchSearchManifest(
  vault: string,
  request: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): Promise<SearchManifestAnswer> {
  let response: Response;
  try {
    response = await request(endpoint(vault), { headers: { accept: "application/json" } });
  } catch {
    return { kind: "unreachable" };
  }
  if (denied(response)) return { kind: "denied" };
  if (!response.ok) return { kind: "unreachable" };
  try {
    const zones = readManifest(vault, await response.json());
    return zones === undefined ? { kind: "unreachable" } : { kind: "ok", zones };
  } catch {
    return { kind: "unreachable" };
  }
}

/**
 * Reconciles the permitted manifest, then downloads only missing current epochs.
 *
 * A binary refusal after a successful manifest is a policy race. Dropping every segment is
 * the fail-closed answer: a stale manifest cannot justify retaining any bytes.
 */
export async function syncClientIndex(options: ClientIndexOptions): Promise<ClientIndexResult> {
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  const manifest = await fetchSearchManifest(options.vault, request);
  if (manifest.kind === "unreachable") return "unreachable";
  if (manifest.kind === "denied") {
    await options.store.reconcileSearchZones(options.vault, []);
    return "denied";
  }

  const missing = await options.store.reconcileSearchZones(options.vault, manifest.zones);
  for (const zone of missing) {
    const bytes = await fetchSegment(options.vault, zone, request);
    if (bytes === "denied") {
      await options.store.reconcileSearchZones(options.vault, []);
      return "denied";
    }
    if (bytes === "unreachable") return "unreachable";
    try {
      await (options.validate ?? validateSearchSegment)(bytes);
    } catch {
      // Invalid bytes are not stored. The manifest remains, so a later reconnect retries;
      // keeping an older same-epoch segment is safe, accepting malformed new bytes is not.
      return "unreachable";
    }
    const stored = await options.store.putSearchSegment({ ...zone, bytes });
    if (!stored) return "denied";
  }
  return "synced";
}

/** Returns current stored bytes; the store filters them against its own manifest. */
export function storedClientSegments(
  store: OfflineStore,
  vault: string,
): Promise<readonly SearchSegment[]> {
  return store.searchSegments(vault);
}

function endpoint(vault: string): string {
  return `/api/v1/vaults/${encodeURIComponent(vault)}/search/segments`;
}

async function fetchSegment(
  vault: string,
  zone: SearchZone,
  request: typeof globalThis.fetch,
): Promise<Uint8Array | "denied" | "unreachable"> {
  let response: Response;
  try {
    response = await request(
      `${endpoint(vault)}/${encodeURIComponent(zone.zoneId)}?acl_hash=${encodeURIComponent(zone.aclHash)}`,
      { headers: { accept: "application/vnd.memberberry.search-index;version=1" } },
    );
  } catch {
    return "unreachable";
  }
  if (denied(response)) return "denied";
  if (!response.ok) return "unreachable";
  try {
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return "unreachable";
  }
}

function denied(response: Response): boolean {
  return response.status === 401 || response.status === 403 || response.status === 404;
}

function readManifest(vault: string, body: unknown): readonly SearchZone[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const entries = (body as Record<string, unknown>)["segments"];
  if (!Array.isArray(entries)) return undefined;
  const zones = new Map<string, SearchZone>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const { zoneId, aclHash } = entry as Record<string, unknown>;
    if (typeof zoneId !== "string" || typeof aclHash !== "string") return undefined;
    if (!HEX.test(zoneId) || !HEX.test(aclHash) || zones.has(zoneId)) return undefined;
    zones.set(zoneId, { vault, zoneId, aclHash });
  }
  return [...zones.values()];
}
