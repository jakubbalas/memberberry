/** Authenticated share-link management for the workspace shell (`SPEC.md` §17). */

export interface ShareLink {
  readonly id: number;
  readonly note: string;
  readonly include_embeds: boolean;
  readonly password_protected: boolean;
  readonly expires_at: number | null;
  readonly access_count: number;
  readonly last_accessed_at: number | null;
  readonly revoked_at: number | null;
}

export interface CreatedShareLink {
  readonly url: string;
  readonly note: string;
  readonly include_embeds: boolean;
  readonly expires_at: number | null;
}

export interface CreateShareInput {
  readonly note: string;
  readonly include_embeds: boolean;
  readonly password?: string;
  readonly expires_at?: number;
  readonly never_expires?: boolean;
}

export interface ShareViewOptions {
  readonly vault: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class ShareView {
  #links: readonly ShareLink[] = [];
  #state: "idle" | "loading" | "ready" | "unavailable" = "idle";
  #request = 0;
  readonly #vault: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: ShareViewOptions) {
    this.#vault = options.vault;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  get links(): readonly ShareLink[] { return this.#links; }
  get loading(): boolean { return this.#state === "loading"; }
  get unavailable(): boolean { return this.#state === "unavailable"; }
  get empty(): boolean { return this.#state === "ready" && this.#links.length === 0; }

  ensure(): void {
    if (this.#state === "idle") void this.refresh();
  }

  async refresh(): Promise<void> {
    this.#state = "loading";
    const request = ++this.#request;
    try {
      const response = await this.#fetch(this.endpoint(), { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("share list unavailable");
      const body: unknown = await response.json();
      if (request !== this.#request) return;
      this.#links = readLinks(body);
      this.#state = "ready";
    } catch {
      if (request === this.#request) {
        this.#links = [];
        this.#state = "unavailable";
      }
    }
  }

  async create(input: CreateShareInput): Promise<CreatedShareLink | undefined> {
    const body: Record<string, unknown> = {
      note: input.note,
      include_embeds: input.include_embeds,
      ...(input.password === undefined || input.password === "" ? {} : { password: input.password }),
      ...(input.expires_at === undefined ? {} : { expires_at: input.expires_at }),
    };
    if (input.never_expires === true) body["never_expires"] = true;
    try {
      const response = await this.#fetch(this.endpoint(), {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) return undefined;
      const created = readCreated(await response.json());
      if (created !== undefined) await this.refresh();
      return created;
    } catch {
      return undefined;
    }
  }

  async revoke(id: number): Promise<boolean> {
    try {
      const response = await this.#fetch(`${this.endpoint()}/${encodeURIComponent(String(id))}`, {
        method: "DELETE",
        headers: { accept: "application/json" },
      });
      if (!response.ok) return false;
      this.#links = this.#links.filter((link) => link.id !== id);
      return true;
    } catch {
      return false;
    }
  }

  private endpoint(): string {
    return `/api/v1/vaults/${encodeURIComponent(this.#vault)}/shares`;
  }
}

function readLinks(body: unknown): readonly ShareLink[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((entry): ShareLink[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const id = record["id"];
    const note = record["note"];
    const expires = record["expires_at"];
    if (typeof id !== "number" || !Number.isInteger(id) || typeof note !== "string" || note === "" || (expires !== null && typeof expires !== "number")) return [];
    return [{
      id,
      note,
      include_embeds: record["include_embeds"] === true,
      password_protected: record["password_protected"] === true,
      expires_at: expires,
      access_count: typeof record["access_count"] === "number" ? record["access_count"] : 0,
      last_accessed_at: typeof record["last_accessed_at"] === "number" ? record["last_accessed_at"] : null,
      revoked_at: typeof record["revoked_at"] === "number" ? record["revoked_at"] : null,
    }];
  });
}

function readCreated(body: unknown): CreatedShareLink | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const expires = record["expires_at"];
  return typeof record["url"] === "string" && typeof record["note"] === "string" && (expires === null || typeof expires === "number")
    ? { url: record["url"], note: record["note"], include_embeds: record["include_embeds"] === true, expires_at: expires }
    : undefined;
}
