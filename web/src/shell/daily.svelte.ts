/** The permission-filtered daily-note calendar (`SPEC.md` §15.1, E20). */

import { periodicPath, type CalendarPeriod } from "../notes.js";
import type { CreateResult, createNote } from "./create.js";
import { expandTemplate } from "../notes.js";
import { readTemplate } from "./templates.js";

export interface DailyNote {
  readonly date: string;
  readonly path: string;
}

export interface PeriodicIndex {
  readonly folder: string;
  readonly format: string;
  readonly notes: readonly DailyNote[];
  readonly template?: string | null;
}

export interface DailyIndex extends PeriodicIndex {
  readonly weekly: PeriodicIndex;
  readonly monthly: PeriodicIndex;
}

function parsePeriod(value: unknown): PeriodicIndex | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const folder = record["folder"];
  const format = record["format"];
  const entries = record["notes"];
  const template = record["template"];
  if (typeof folder !== "string" || typeof format !== "string" || !Array.isArray(entries) || (template !== undefined && template !== null && typeof template !== "string")) return undefined;
  const notes = entries.flatMap((entry): DailyNote[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const note = entry as Record<string, unknown>;
    return typeof note["date"] === "string" && typeof note["path"] === "string"
      ? [{ date: note["date"], path: note["path"] }]
      : [];
  });
  return { folder, format, notes: [...notes].sort((left, right) => left.date.localeCompare(right.date)), ...(template === undefined ? {} : { template: template as string | null }) };
}

export async function fetchDaily(
  vault: string,
  fetcher: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): Promise<DailyIndex> {
  const response = await fetcher(`/api/v1/vaults/${encodeURIComponent(vault)}/daily`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error("The daily calendar is unavailable.");
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null) throw new Error("The daily calendar is unavailable.");
  const record = body as Record<string, unknown>;
  const daily = parsePeriod(record);
  const weekly = parsePeriod(record["weekly"]);
  const monthly = parsePeriod(record["monthly"]);
  if (daily === undefined || weekly === undefined || monthly === undefined) {
    throw new Error("The daily calendar is unavailable.");
  }
  return { ...daily, weekly, monthly };
}

export interface DailyViewOptions {
  readonly vault: string;
  readonly load?: typeof fetchDaily;
  readonly formatPath?: typeof periodicPath;
}

export class DailyView {
  readonly #vault: string;
  readonly #load: typeof fetchDaily;
  readonly #formatPath: typeof periodicPath;
  #state: "idle" | "loading" | "ready" | "unavailable" = $state("idle");
  #index: DailyIndex | undefined = $state(undefined);

  constructor(options: DailyViewOptions) {
    this.#vault = options.vault;
    this.#load = options.load ?? fetchDaily;
    this.#formatPath = options.formatPath ?? periodicPath;
  }

  async create(date: string, user: string, create: typeof createNote): Promise<CreateResult | undefined> {
    return this.createPeriod("daily", date, user, create);
  }

  async createPeriod(period: CalendarPeriod, date: string, user: string, create: typeof createNote): Promise<CreateResult | undefined> {
    const index = this.#index;
    if (index === undefined) return undefined;
    const config = this.period(period);
    const path = await this.pathFor(period, date);
    if (path === undefined) return undefined;
    let content: string | undefined;
    if (config.template !== undefined && config.template !== null) {
      const body = await readTemplate(this.#vault, config.template);
      const title = path.split("/").at(-1)?.replace(/\.md$/, "") ?? date;
      content = (await expandTemplate(body, {
        date, time: "00:00:00", title, selection: "", uuid: crypto.randomUUID(), user,
      })).text;
    }
    return create(this.#vault, path, content === undefined ? {} : { content });
  }

  get loading(): boolean { return this.#state === "loading"; }
  get unavailable(): boolean { return this.#state === "unavailable"; }
  get ready(): boolean { return this.#state === "ready"; }
  get index(): DailyIndex | undefined { return this.#index; }
  get notes(): readonly DailyNote[] { return this.#index?.notes ?? []; }

  ensure(): void {
    if (this.#state !== "idle") return;
    void this.refresh();
  }

  async refresh(): Promise<void> {
    this.#state = "loading";
    try {
      this.#index = await this.#load(this.#vault);
      this.#state = "ready";
    } catch {
      this.#index = undefined;
      this.#state = "unavailable";
    }
  }

  async path(date: string): Promise<string | undefined> {
    return this.pathFor("daily", date);
  }

  async pathFor(period: CalendarPeriod, date: string): Promise<string | undefined> {
    const index = this.#index;
    if (index === undefined) return undefined;
    const config = this.period(period);
    try { return await this.#formatPath(period, config.folder + "/", config.format, date); }
    catch { return undefined; }
  }

  period(period: CalendarPeriod): PeriodicIndex {
    const index = this.#index;
    if (index === undefined) return { folder: "", format: "", notes: [] };
    if (period === "weekly") return index.weekly;
    if (period === "monthly") return index.monthly;
    return index;
  }

  async existing(period: CalendarPeriod, date: string): Promise<DailyNote | undefined> {
    const path = await this.pathFor(period, date);
    return path === undefined ? undefined : this.period(period).notes.find((entry) => entry.path === path);
  }

  note(date: string): DailyNote | undefined { return this.notes.find((entry) => entry.date === date); }

  /** Returns the nearest existing daily note before or after the note at `path`. */
  neighbourForPath(path: string, direction: -1 | 1): DailyNote | undefined {
    const current = this.notes.find((entry) => entry.path === path);
    return current === undefined ? undefined : this.neighbour(current.date, direction);
  }

  neighbour(date: string, direction: -1 | 1): DailyNote | undefined {
    const candidates = this.notes.filter((entry) => direction < 0 ? entry.date < date : entry.date > date);
    return direction < 0 ? candidates.at(-1) : candidates[0];
  }
}
