/** Typed client for deleted-note trash (`SPEC.md` §4.3, §18.2). */

export interface TrashEntry {
  readonly id: string;
  readonly path: string;
  readonly deleted_at: number;
  readonly actor: string;
}

interface TrashResponse {
  readonly entries: readonly TrashEntry[];
}

export class TrashView {
  readonly #vault: string;
  #entries: readonly TrashEntry[] = [];
  #request: typeof fetch;

  constructor(options: { readonly vault: string; readonly request?: typeof fetch }) {
    this.#vault = options.vault;
    this.#request = options.request ?? globalThis.fetch.bind(globalThis);
  }

  get entries(): readonly TrashEntry[] {
    return this.#entries;
  }

  async refresh(): Promise<void> {
    const response = await this.#request(`/api/v1/vaults/${encodeURIComponent(this.#vault)}/trash`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error("trash unavailable");
    const body: unknown = await response.json();
    if (!isTrashResponse(body)) throw new Error("invalid trash response");
    this.#entries = body.entries;
  }

  async delete(path: string): Promise<boolean> {
    try {
      const response = await this.#request(
        `/api/v1/vaults/${encodeURIComponent(this.#vault)}/notes/${encodePath(path)}`,
        { method: "DELETE" },
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  async restore(id: string): Promise<boolean> {
    try {
      const response = await this.#request(
        `/api/v1/vaults/${encodeURIComponent(this.#vault)}/trash/${encodeURIComponent(id)}`,
        { method: "POST" },
      );
      return response.ok;
    } catch {
      return false;
    }
  }
}

function encodePath(path: string): string {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function isTrashResponse(value: unknown): value is TrashResponse {
  if (typeof value !== "object" || value === null || !("entries" in value)) return false;
  const entries: unknown = value.entries;
  return Array.isArray(entries) && entries.every(isTrashEntry);
}

function isTrashEntry(value: unknown): value is TrashEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry["id"] === "string" &&
    typeof entry["path"] === "string" &&
    typeof entry["deleted_at"] === "number" &&
    typeof entry["actor"] === "string"
  );
}
