/**
 * The task inbox pane's state (`SPEC.md` §10.3).
 *
 * Fetched once per filter set and kept alive across sidebar collapses, for the same reason
 * the tag tree is: remounting the panel must not re-hit a 10k-note vault's task index on
 * every toggle. Grouping is derived from the answer and the local calendar date — the server
 * returns a flat list ordered by the requested sort.
 */

import {
  EMPTY_INBOX_FILTERS,
  type InboxFilters,
  type InboxTask,
  type TaskGroup,
  fetchInboxTasks,
  groupInboxTasks,
  localToday,
} from "./tasks.js";
import { localReplica } from "../offline/local.js";

/** Injectable loader; filters are always provided by the view (unlike the HTTP helper's default). */
export type LoadInboxTasks = (
  vault: string,
  filters: InboxFilters,
) => Promise<readonly InboxTask[] | undefined>;

export interface InboxViewOptions {
  readonly vault: string;
  /** Injectable for tests; default to the real HTTP call. */
  readonly load?: LoadInboxTasks;
  /** Offline metadata fallback; only rows previously sent by the server are exposed. */
  readonly offline?: LoadInboxTasks;
  /** Injectable calendar date so grouping tests do not depend on the wall clock. */
  readonly today?: () => string;
}

export class InboxView {
  #tasks: readonly InboxTask[] = $state([]);
  #filters: InboxFilters = $state({ ...EMPTY_INBOX_FILTERS });
  #state: "idle" | "loading" | "ready" | "unavailable" = $state("idle");
  #request = 0;
  readonly #vault: string;
  readonly #load: LoadInboxTasks;
  readonly #offline: LoadInboxTasks;
  readonly #today: () => string;

  constructor(options: InboxViewOptions) {
    this.#vault = options.vault;
    this.#load = options.load ?? fetchInboxTasks;
    this.#offline = options.offline ?? loadOfflineTasks;
    this.#today = options.today ?? localToday;
  }

  get filters(): InboxFilters {
    return this.#filters;
  }

  get tasks(): readonly InboxTask[] {
    return this.#tasks;
  }

  /** §10.3 groups for the current answer, relative to the injected calendar date. */
  get groups(): readonly TaskGroup[] {
    if (this.#state !== "ready") return [];
    return groupInboxTasks(this.#tasks, this.#today());
  }

  get loading(): boolean {
    return this.#state === "loading";
  }

  get empty(): boolean {
    return this.#state === "ready" && this.#tasks.length === 0;
  }

  get unavailable(): boolean {
    return this.#state === "unavailable";
  }

  /**
   * Fetches if nothing has yet.
   *
   * Safe to call from a render path: a second call while one is in flight, or after it has
   * arrived, does nothing. Changing a filter always goes through `setFilters` / `refresh`.
   */
  ensure(): void {
    if (this.#state !== "idle") return;
    void this.refresh();
  }

  /** Replaces the filter set and reloads. Unchanged filters are a no-op. */
  setFilters(next: InboxFilters): void {
    if (sameFilters(this.#filters, next)) return;
    this.#filters = next;
    void this.refresh();
  }

  /** Patches one filter field and reloads when the value actually changed. */
  setFilter<K extends keyof InboxFilters>(key: K, value: InboxFilters[K]): void {
    if (this.#filters[key] === value) return;
    this.setFilters({ ...this.#filters, [key]: value });
  }

  /** Re-fetches under the current filters. */
  async refresh(): Promise<void> {
    this.#state = "loading";
    this.#request += 1;
    const request = this.#request;
    const filters = this.#filters;
    const online = await this.#load(this.#vault, filters);
    const tasks = online ?? (this.#filtersAreEmpty() ? await this.#offline(this.#vault, filters) : undefined);
    if (request !== this.#request) return;
    if (tasks === undefined) {
      this.#tasks = [];
      this.#state = "unavailable";
      return;
    }
    this.#tasks = tasks;
    this.#state = "ready";
  }

  #filtersAreEmpty(): boolean {
    return sameFilters(this.#filters, EMPTY_INBOX_FILTERS);
  }
}

async function loadOfflineTasks(vault: string): Promise<readonly InboxTask[] | undefined> {
  const replica = await localReplica();
  if (replica === undefined) return undefined;
  const notes = await replica.reconcile(vault, { kind: "unreachable" });
  if (notes.length === 0) return undefined;
  return notes.flatMap((note) => (note.tasks ?? []).map((task) => ({
    path: note.path,
    title: note.title,
    blockId: task.blockId,
    text: task.text,
    due: task.due,
    scheduled: task.scheduled,
    start: task.start,
    created: task.created,
    priority: task.priority,
    ordinal: task.ordinal,
  })));
}

function sameFilters(left: InboxFilters, right: InboxFilters): boolean {
  return (
    left.folder === right.folder &&
    left.tag === right.tag &&
    left.priority === right.priority &&
    left.dueFrom === right.dueFrom &&
    left.dueTo === right.dueTo &&
    left.note === right.note &&
    left.sort === right.sort
  );
}
