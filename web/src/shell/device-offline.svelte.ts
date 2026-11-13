/**
 * The desktop app's offline state for one server vault, kept current for the tree
 * (`SPEC.md` §7.6.10). The rules are in `device-offline.ts`; this only fetches and holds.
 */

import { readOfflineState, type OfflineAction, type OfflineSnapshot } from "./device-offline.js";

export interface DeviceOfflineOptions {
  readonly vault: string;
  /** Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

/** How often the state is re-read while a vault is open: a download finishes on its own. */
const REFRESH_MS = 3000;

export class DeviceOffline {
  #snapshot = $state<OfflineSnapshot | undefined>(undefined);
  readonly #vault: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: DeviceOfflineOptions) {
    this.#vault = options.vault;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** `undefined` for anything but a server vault in the desktop app. */
  get snapshot(): OfflineSnapshot | undefined {
    return this.#snapshot;
  }

  #url(): string {
    return `/api/v1/vaults/${encodeURIComponent(this.#vault)}/offline`;
  }

  async refresh(): Promise<void> {
    try {
      const response = await this.#fetch(this.#url(), { headers: { accept: "application/json" } });
      this.#snapshot = response.ok ? readOfflineState(await response.json()) : undefined;
    } catch {
      // Unreachable or not the desktop app: no offline state, nothing offered.
      this.#snapshot = undefined;
    }
  }

  /** Applies a menu entry. Resolves to a message for the user when it was refused. */
  async apply(action: OfflineAction): Promise<string | undefined> {
    let response: Response;
    try {
      response = await this.#fetch(this.#url(), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ kind: action.kind, path: action.path, offline: action.offline }),
      });
    } catch {
      return "Memberberry could not change this. Try again.";
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["error"] : undefined;
      return typeof error === "string" ? error : "Memberberry could not change this. Try again.";
    }
    this.#snapshot = readOfflineState(body) ?? this.#snapshot;
    return undefined;
  }

  /**
   * Acts on the user's choice for a recovered note (§7.6.7): create it again where it was
   * (`to` absent), or make a new note at `to`. Resolves to a message when it was refused.
   */
  async place(path: string, to?: string): Promise<string | undefined> {
    let response: Response;
    try {
      response = await this.#fetch(`/api/v1/vaults/${encodeURIComponent(this.#vault)}/recovered`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(to === undefined ? { path } : { path, to }),
      });
    } catch {
      return "Memberberry could not do this. Try again.";
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      await this.refresh();
      const error = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["error"] : undefined;
      return typeof error === "string" ? error : "Memberberry could not do this. Try again.";
    }
    this.#snapshot = readOfflineState(body) ?? this.#snapshot;
    return undefined;
  }

  /** Loads now and keeps re-reading until the returned teardown runs. */
  watch(setTimer: typeof setInterval = setInterval, clearTimer: typeof clearInterval = clearInterval): () => void {
    void this.refresh();
    const timer = setTimer(() => void this.refresh(), REFRESH_MS);
    return () => clearTimer(timer);
  }
}
