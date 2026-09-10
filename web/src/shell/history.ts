/** Authenticated note history for the M17 workspace shell. */

export interface HistoryVersion {
  readonly id: string;
  readonly timestamp: number;
  readonly actor: string;
  readonly bytes: number;
  readonly content_hash: string;
  readonly size_delta: number;
}

export type DiffPart =
  | { readonly kind: "equal"; readonly text: string }
  | { readonly kind: "added"; readonly text: string }
  | { readonly kind: "removed"; readonly text: string };

export interface HistoryDiff {
  readonly from: string;
  readonly to: string;
  readonly parts: readonly DiffPart[];
}

export class HistoryView {
  #versions: readonly HistoryVersion[] = [];
  #state: "idle" | "loading" | "ready" | "unavailable" = "idle";
  #request = 0;
  readonly #vault: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: { readonly vault: string; readonly fetch?: typeof globalThis.fetch }) {
    this.#vault = options.vault;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  get versions(): readonly HistoryVersion[] { return this.#versions; }
  get loading(): boolean { return this.#state === "loading"; }
  get unavailable(): boolean { return this.#state === "unavailable"; }

  clear(): void {
    this.#request += 1;
    this.#versions = [];
    this.#state = "idle";
  }

  async refresh(note: string): Promise<void> {
    this.#state = "loading";
    const request = ++this.#request;
    try {
      const response = await this.#fetch(this.endpoint(note), { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("history unavailable");
      const versions = readVersions(await response.json());
      if (request !== this.#request) return;
      this.#versions = versions;
      this.#state = "ready";
    } catch {
      if (request === this.#request) {
        this.#versions = [];
        this.#state = "unavailable";
      }
    }
  }

  async read(note: string, version: string): Promise<string | undefined> {
    try {
      const response = await this.#fetch(`${this.endpoint(note)}?version=${encodeURIComponent(version)}`, { headers: { accept: "text/markdown" } });
      return response.ok ? await response.text() : undefined;
    } catch {
      return undefined;
    }
  }

  async diff(note: string, from: string, to: string): Promise<HistoryDiff | undefined> {
    try {
      const query = `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      const response = await this.#fetch(`${this.endpoint(note)}${query}`, { headers: { accept: "application/json" } });
      if (!response.ok) return undefined;
      return readDiff(await response.json());
    } catch {
      return undefined;
    }
  }

  async restore(note: string, version: string): Promise<boolean> {
    try {
      const response = await this.#fetch(this.endpoint(note), {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ version }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private endpoint(note: string): string {
    return `/api/v1/vaults/${encodeURIComponent(this.#vault)}/history/${note.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`;
  }
}

function readVersions(body: unknown): readonly HistoryVersion[] {
  if (typeof body !== "object" || body === null) return [];
  const versions = (body as Record<string, unknown>)["versions"];
  if (!Array.isArray(versions)) return [];
  const parsed = versions.flatMap((entry): Omit<HistoryVersion, "size_delta">[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    return typeof record["id"] === "string" && typeof record["timestamp"] === "number" &&
      typeof record["actor"] === "string" && typeof record["bytes"] === "number" &&
      typeof record["content_hash"] === "string"
      ? [{ id: record["id"], timestamp: record["timestamp"], actor: record["actor"], bytes: record["bytes"], content_hash: record["content_hash"] }]
      : [];
  });
  return parsed.map((version, index) => ({
    ...version,
    size_delta: version.bytes - (parsed[index - 1]?.bytes ?? version.bytes),
  }));
}

function readDiff(body: unknown): HistoryDiff | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const rawParts = record["parts"];
  if (typeof record["from"] !== "string" || typeof record["to"] !== "string" || !Array.isArray(rawParts)) return undefined;
  const parts = rawParts.flatMap((entry): DiffPart[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const part = entry as Record<string, unknown>;
    const kind = part["kind"];
    return (kind === "equal" || kind === "added" || kind === "removed") && typeof part["text"] === "string"
      ? [{ kind, text: part["text"] }]
      : [];
  });
  return { from: record["from"], to: record["to"], parts };
}
