/**
 * Task inbox helpers (`SPEC.md` §10.3).
 *
 * The server returns open, permission-filtered rows (E18). This module never filters by
 * permission — it only groups, labels and builds the query the route already understands.
 * Client-side filtering of a readable set would be the wrong boundary (`AGENTS.md` §3.1).
 */

export type TaskPriority = "highest" | "high" | "medium" | "low" | "lowest";

export type TaskSort = "due" | "priority" | "created" | "path";

/** One open task as the inbox route returns it. */
export interface InboxTask {
  readonly path: string;
  readonly title: string | null;
  readonly blockId: string | null;
  readonly text: string;
  readonly due: string | null;
  readonly scheduled: string | null;
  readonly start: string | null;
  readonly created: string | null;
  readonly priority: TaskPriority | null;
  readonly ordinal: number;
}

/** Filters and sort the inbox route accepts. Empty strings are omitted from the request. */
export interface InboxFilters {
  readonly folder: string;
  readonly tag: string;
  readonly priority: TaskPriority | "";
  readonly dueFrom: string;
  readonly dueTo: string;
  readonly note: string;
  readonly sort: TaskSort;
}

export const EMPTY_INBOX_FILTERS: InboxFilters = {
  folder: "",
  tag: "",
  priority: "",
  dueFrom: "",
  dueTo: "",
  note: "",
  sort: "due",
};

export type TaskGroupId = "overdue" | "today" | "this_week" | "later" | "no_date";

export interface TaskGroup {
  readonly id: TaskGroupId;
  readonly label: string;
  readonly tasks: readonly InboxTask[];
}

export interface TasksOptions {
  /** Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

const PRIORITIES = new Set<TaskPriority>(["highest", "high", "medium", "low", "lowest"]);
const SORTS = new Set<TaskSort>(["due", "priority", "created", "path"]);

const GROUP_ORDER: readonly TaskGroupId[] = [
  "overdue",
  "today",
  "this_week",
  "later",
  "no_date",
];

const GROUP_LABEL: Readonly<Record<TaskGroupId, string>> = {
  overdue: "Overdue",
  today: "Today",
  this_week: "This week",
  later: "Later",
  no_date: "No date",
};

/** Local calendar date as `YYYY-MM-DD`. Injectable clock so grouping tests do not drift. */
export function localToday(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Inclusive end of the ISO week (Monday–Sunday) that contains `today`.
 *
 * "This week" means the rest of the current calendar week after today, not a rolling seven
 * days — overdue and today already claim the earlier part of the week.
 */
export function endOfIsoWeek(today: string): string | undefined {
  const parts = parseDate(today);
  if (parts === undefined) return undefined;
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  // getUTCDay: 0 Sunday … 6 Saturday. Distance to Sunday is what closes the ISO week.
  const weekday = date.getUTCDay();
  const daysToSunday = weekday === 0 ? 0 : 7 - weekday;
  date.setUTCDate(date.getUTCDate() + daysToSunday);
  return formatUtcDate(date);
}

/** Which inbox group a due date belongs in, relative to `today`. */
export function taskGroupId(due: string | null, today: string): TaskGroupId {
  if (due === null || due === "") return "no_date";
  if (due < today) return "overdue";
  if (due === today) return "today";
  const weekEnd = endOfIsoWeek(today);
  if (weekEnd !== undefined && due <= weekEnd) return "this_week";
  return "later";
}

/**
 * Groups open tasks in §10.3 order, dropping empty groups.
 *
 * The server's sort is preserved inside each group: regrouping must not invent a second
 * ordering on top of the one the reader asked for.
 */
export function groupInboxTasks(
  tasks: readonly InboxTask[],
  today: string = localToday(),
): readonly TaskGroup[] {
  const buckets: Record<TaskGroupId, InboxTask[]> = {
    overdue: [],
    today: [],
    this_week: [],
    later: [],
    no_date: [],
  };
  for (const task of tasks) {
    buckets[taskGroupId(task.due, today)].push(task);
  }
  return GROUP_ORDER.flatMap((id) => {
    const groupTasks = buckets[id];
    if (groupTasks.length === 0) return [];
    return [{ id, label: GROUP_LABEL[id], tasks: groupTasks }];
  });
}

/** Builds the query string for `GET …/tasks`. Omits empty filters. */
export function inboxQuery(filters: InboxFilters): string {
  const params = new URLSearchParams();
  if (filters.folder.trim() !== "") params.set("folder", filters.folder.trim());
  if (filters.tag.trim() !== "") params.set("tag", filters.tag.trim());
  if (filters.priority !== "") params.set("priority", filters.priority);
  if (filters.dueFrom.trim() !== "") params.set("due_from", filters.dueFrom.trim());
  if (filters.dueTo.trim() !== "") params.set("due_to", filters.dueTo.trim());
  if (filters.note.trim() !== "") params.set("note", filters.note.trim());
  if (filters.sort !== "due") params.set("sort", filters.sort);
  return params.toString();
}

/** Fetches open, readable tasks for the inbox. `undefined` means the server would not say. */
export async function fetchInboxTasks(
  vault: string,
  filters: InboxFilters = EMPTY_INBOX_FILTERS,
  options: TasksOptions = {},
): Promise<readonly InboxTask[] | undefined> {
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  const query = inboxQuery(filters);
  const url =
    `/api/v1/vaults/${encodeURIComponent(vault)}/tasks` + (query === "" ? "" : `?${query}`);
  try {
    const response = await request(url, { headers: { accept: "application/json" } });
    if (!response.ok) return undefined;
    return readInboxTasks(await response.json());
  } catch {
    return undefined;
  }
}

/**
 * Validates the inbox response.
 *
 * The client does not trust the server (`AGENTS.md` §4.3). Every field reaches the DOM; a
 * row of the wrong shape is dropped rather than rendered.
 */
export function readInboxTasks(body: unknown): readonly InboxTask[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const tasks = (body as Record<string, unknown>)["tasks"];
  if (!Array.isArray(tasks)) return undefined;

  const valid: InboxTask[] = [];
  for (const entry of tasks) {
    const task = readTask(entry);
    if (task !== undefined) valid.push(task);
  }
  return valid;
}

/** What a row is labelled with beside the task text: note title, else the filename stem. */
export function inboxSourceLabel(task: InboxTask): string {
  if (task.title !== null && task.title !== "") return task.title;
  const filename = task.path.split("/").pop() ?? task.path;
  return filename.replace(/\.md$/, "");
}

function readTask(entry: unknown): InboxTask | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const record = entry as Record<string, unknown>;
  const path = record["path"];
  const text = record["text"];
  const ordinal = record["ordinal"];
  if (typeof path !== "string" || path === "") return undefined;
  if (typeof text !== "string") return undefined;
  if (typeof ordinal !== "number" || !Number.isFinite(ordinal) || ordinal < 0) return undefined;

  const title = optionalString(record["title"]);
  const blockId = optionalString(record["block_id"]);
  const due = optionalString(record["due"]);
  const scheduled = optionalString(record["scheduled"]);
  const start = optionalString(record["start"]);
  const created = optionalString(record["created"]);
  if (
    title === false ||
    blockId === false ||
    due === false ||
    scheduled === false ||
    start === false ||
    created === false
  ) {
    return undefined;
  }

  const priority = record["priority"];
  if (priority !== null && priority !== undefined) {
    if (typeof priority !== "string" || !PRIORITIES.has(priority as TaskPriority)) {
      return undefined;
    }
  }

  return {
    path,
    title,
    blockId,
    text,
    due,
    scheduled,
    start,
    created,
    priority:
      typeof priority === "string" && PRIORITIES.has(priority as TaskPriority)
        ? (priority as TaskPriority)
        : null,
    ordinal,
  };
}

/** `null` for absent, the string when present, `false` when the field is the wrong type. */
function optionalString(value: unknown): string | null | false {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return false;
  return value;
}

function parseDate(value: string): { year: number; month: number; day: number } | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return undefined;
  return { year, month, day };
}

function formatUtcDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isTaskSort(value: string): value is TaskSort {
  return SORTS.has(value as TaskSort);
}

export function isTaskPriority(value: string): value is TaskPriority {
  return PRIORITIES.has(value as TaskPriority);
}
