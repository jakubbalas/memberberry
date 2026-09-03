/**
 * The user's bookmarked notes (`SPEC.md` §8.2).
 *
 * The list arrives already filtered by what the user can still read — a bookmark outlives the
 * permission that created it, and the server drops the ones that no longer apply (§6.5). So
 * there is no permission logic here, and adding any would be the client-side filtering
 * AGENTS.md §3.1 forbids.
 *
 * Saves are optimistic and coalesced. Toggling a bookmark is a single click that must feel
 * instant, and a rapid run of them — clearing several at once — should be one request rather
 * than a queue that can land out of order.
 */

const ENDPOINT = (vault: string): string =>
  `/api/v1/vaults/${encodeURIComponent(vault)}/bookmarks`;

/** How long the list must stop changing before it is written. Matches the layout's debounce. */
export const BOOKMARK_DEBOUNCE_MS = 500;

export interface BookmarksOptions {
  readonly vault: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly debounceMs?: number;
  readonly setTimer?: (run: () => void, ms: number) => number;
  readonly clearTimer?: (handle: number) => void;
  /** Called when a save fails, so a shell can say the list is not being kept. */
  readonly onSaveError?: (error: unknown) => void;
}

export class Bookmarks {
  #paths: readonly string[] = $state([]);
  #state: "idle" | "loading" | "ready" = $state("idle");

  readonly #vault: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #debounceMs: number;
  readonly #setTimer: (run: () => void, ms: number) => number;
  readonly #clearTimer: (handle: number) => void;
  readonly #onSaveError: (error: unknown) => void;

  #timer: number | undefined;
  #inFlight: Promise<void> = Promise.resolve();

  constructor(options: BookmarksOptions) {
    this.#vault = options.vault;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#debounceMs = options.debounceMs ?? BOOKMARK_DEBOUNCE_MS;
    this.#setTimer =
      options.setTimer ?? ((run, ms) => globalThis.setTimeout(run, ms) as unknown as number);
    this.#clearTimer =
      options.clearTimer ??
      ((handle) => {
        globalThis.clearTimeout(handle);
      });
    this.#onSaveError = options.onSaveError ?? (() => undefined);
  }

  get paths(): readonly string[] {
    return this.#paths;
  }

  get ready(): boolean {
    return this.#state === "ready";
  }

  has(path: string): boolean {
    return this.#paths.includes(path);
  }

  /** Fetches the list if nothing has. Safe to call from a render path. */
  ensure(): void {
    if (this.#state !== "idle") return;
    void this.refresh();
  }

  async refresh(): Promise<void> {
    this.#state = "loading";
    try {
      const response = await this.#fetch(ENDPOINT(this.#vault), {
        headers: { accept: "application/json" },
      });
      this.#paths = response.ok ? readPaths(await response.json()) : [];
    } catch {
      // A sidebar with no bookmarks is a mild disappointment; one that throws takes the shell
      // with it, and every failure here is a denial or a network blip.
      this.#paths = [];
    }
    this.#state = "ready";
  }

  /** Adds or removes a bookmark. Applied immediately, written after the debounce settles. */
  toggle(path: string): void {
    this.#paths = this.#paths.includes(path)
      ? this.#paths.filter((existing) => existing !== path)
      : [...this.#paths, path];
    this.#schedule();
  }

  /** Writes any pending change now. `final` survives the page unloading. */
  async flush(options?: { readonly final?: boolean }): Promise<void> {
    if (this.#timer !== undefined) {
      this.#clearTimer(this.#timer);
      this.#timer = undefined;
      this.#write(this.#paths, options?.final ?? false);
    }
    await this.#inFlight;
  }

  destroy(): void {
    if (this.#timer !== undefined) this.#clearTimer(this.#timer);
    this.#timer = undefined;
  }

  #schedule(): void {
    if (this.#timer !== undefined) this.#clearTimer(this.#timer);
    const wanted = this.#paths;
    this.#timer = this.#setTimer(() => {
      this.#timer = undefined;
      this.#write(wanted, false);
    }, this.#debounceMs);
  }

  #write(paths: readonly string[], final: boolean): void {
    // Chained rather than raced: out of order, the server keeps the *older* list, which only
    // shows up on a slow network — when nobody is looking.
    this.#inFlight = this.#inFlight.then(async () => {
      try {
        const response = await this.#fetch(ENDPOINT(this.#vault), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(paths),
          ...(final ? { keepalive: true } : {}),
        });
        if (!response.ok) throw new Error(`the server refused the bookmarks: ${response.status}`);
      } catch (error) {
        this.#onSaveError(error);
      }
    });
  }
}

/** The client does not trust the server any more than the server trusts the client (§4.3). */
function readPaths(body: unknown): readonly string[] {
  if (!Array.isArray(body)) return [];
  return body.filter((entry): entry is string => typeof entry === "string" && entry !== "");
}
