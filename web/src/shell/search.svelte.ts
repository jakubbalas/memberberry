/**
 * Full-vault search orchestration (`SPEC.md` §14.3).
 *
 * The server answer is exact Tantivy search; the fallback is the compact index that the
 * transport has already permission-filtered and persisted. This module deliberately never
 * asks the server for bytes on behalf of offline search: `search-index.ts` is the sole owner
 * of that authorization-sensitive transport.
 */

import type { CompactSearchResults } from "../notes.js";
import { localOfflineStore } from "../offline/local.js";
import { storedClientSegments } from "../offline/search-index.js";
import { queryInWorker } from "./search-worker-client.js";

export interface SearchHit {
  readonly path: string;
  readonly title: string | null;
  readonly context: string;
}

export type SearchMode = "online" | "offline";

export interface SearchAnswer {
  readonly mode: SearchMode;
  readonly hits: readonly SearchHit[];
  readonly phraseDegraded: boolean;
}

export interface SearchViewOptions {
  readonly vault: string;
  readonly request?: typeof globalThis.fetch;
  readonly stored?: typeof storedClientSegments;
  readonly openStore?: typeof localOfflineStore;
  readonly queryOffline?: (query: string, bytes: readonly Uint8Array[]) => Promise<CompactSearchResults>;
}

export type OnlineSearchAnswer = readonly SearchHit[] | "denied" | undefined;

/** Fetches exact permission-filtered Tantivy results, or no answer when they are unavailable. */
export async function fetchOnlineSearch(
  vault: string,
  query: string,
  request: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): Promise<OnlineSearchAnswer> {
  let response: Response;
  try {
    response = await request(
      `/api/v1/vaults/${encodeURIComponent(vault)}/search?${new URLSearchParams({ q: query, limit: "100" })}`,
      { headers: { accept: "application/json" } },
    );
  } catch {
    return undefined;
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) return "denied";
  if (!response.ok) return undefined;
  try {
    return readOnlineHits(await response.json());
  } catch {
    return undefined;
  }
}

/** Reactive search state, separated from the component so its fallback behaviour is testable. */
export class SearchView {
  #query = $state("");
  #answer = $state<SearchAnswer | undefined>(undefined);
  #loading = $state(false);
  #unavailable = $state(false);
  #requestId = 0;
  readonly #vault: string;
  readonly #request: typeof globalThis.fetch;
  readonly #stored: typeof storedClientSegments;
  readonly #openStore: typeof localOfflineStore;
  readonly #queryOffline: (query: string, bytes: readonly Uint8Array[]) => Promise<CompactSearchResults>;

  constructor(options: SearchViewOptions) {
    this.#vault = options.vault;
    this.#request = options.request ?? globalThis.fetch.bind(globalThis);
    this.#stored = options.stored ?? storedClientSegments;
    this.#openStore = options.openStore ?? localOfflineStore;
    this.#queryOffline = options.queryOffline ?? queryInWorker;
  }

  get query(): string { return this.#query; }
  get answer(): SearchAnswer | undefined { return this.#answer; }
  get loading(): boolean { return this.#loading; }
  get unavailable(): boolean { return this.#unavailable; }

  /** Starts a search; a later keystroke always wins over an earlier response. */
  search(query: string): Promise<void> {
    this.#query = query;
    this.#answer = undefined;
    this.#unavailable = false;
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      this.#loading = false;
      return Promise.resolve();
    }
    this.#loading = true;
    const requestId = ++this.#requestId;
    return this.#search(trimmed).then((answer) => {
      if (requestId !== this.#requestId) return;
      this.#loading = false;
      if (answer === undefined) this.#unavailable = true;
      else this.#answer = answer;
    });
  }

  async #search(query: string): Promise<SearchAnswer | undefined> {
    const online = await fetchOnlineSearch(this.#vault, query, this.#request);
    if (online === "denied") {
      const store = await this.#openStore();
      await store?.reconcileSearchZones(this.#vault, []);
      return undefined;
    }
    if (online !== undefined) return { mode: "online", hits: online, phraseDegraded: false };

    const store = await this.#openStore();
    if (store === undefined) return undefined;
    const segments = await this.#stored(store, this.#vault);
    try {
      const results = await this.#queryOffline(query, segments.map((segment) => segment.bytes));
      return {
        mode: "offline",
        hits: results.hits.map((hit) => ({ path: hit.path, title: hit.title || null, context: hit.snippet })),
        phraseDegraded: results.phraseDegraded,
      };
    } catch {
      return undefined;
    }
  }
}

function readOnlineHits(value: unknown): readonly SearchHit[] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const hits = (value as Record<string, unknown>)["hits"];
  if (!Array.isArray(hits)) return undefined;
  const parsed: SearchHit[] = [];
  for (const hit of hits) {
    if (typeof hit !== "object" || hit === null) return undefined;
    const { path, title, context } = hit as Record<string, unknown>;
    if (typeof path !== "string" || typeof context !== "string" || (title !== null && typeof title !== "string")) {
      return undefined;
    }
    parsed.push({ path, title, context });
  }
  return parsed;
}
