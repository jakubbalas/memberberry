/**
 * Mermaid `gantt` text as an editable model, and back (SPEC §13.3).
 *
 * The text is the content (C2): this module never invents a second format. It parses the
 * subset the visual editor can edit, keeps every other line verbatim, and writes a task back
 * in one canonical form only when it was edited. Dates are whole UTC days, as Mermaid's
 * `YYYY-MM-DD` charts are.
 *
 * Self-contained by design: nothing here imports from the rest of the app, so the Confluence
 * macro can bundle the same files (A39).
 */

import { chartOptions, sectionColors, taskColors, type ChartOptions, type TaskColor } from "./colors.js";

/** Task tags Mermaid understands, in the order it reads them. */
export const TAGS = ["done", "active", "crit", "milestone", "vert"] as const;
export type Tag = (typeof TAGS)[number];

/** When a task starts. `previous` is Mermaid's one-field form: right after the line above. */
export type Start =
  | { readonly kind: "date"; readonly day: number }
  | { readonly kind: "after"; readonly ids: readonly string[] }
  | { readonly kind: "previous" };

/** When a task ends. A date is exclusive, as in Mermaid: the bar ends at the start of that day. */
export type End =
  | { readonly kind: "date"; readonly day: number }
  | { readonly kind: "hours"; readonly count: number }
  | { readonly kind: "days"; readonly count: number }
  | { readonly kind: "weeks"; readonly count: number };

export interface Task {
  readonly kind: "task";
  /** Stable within one editing session; never written to the text. */
  readonly key: string;
  readonly name: string;
  readonly tags: readonly Tag[];
  readonly id: string | null;
  readonly start: Start;
  readonly end: End;
  /** The source line, while the task is unedited; `null` once it must be re-serialized. */
  readonly original: string | null;
}

export interface Section {
  readonly kind: "section";
  readonly key: string;
  readonly name: string;
  readonly original: string | null;
}

/** A line the editor does not edit: blank lines, comments, `gantt`, directives. */
export interface Raw {
  readonly kind: "raw";
  readonly key: string;
  readonly text: string;
}

export type Line = Task | Section | Raw;

export interface Chart {
  readonly lines: readonly Line[];
  /** Title from a `title` directive, if any. Edited through {@link setTitle}. */
  readonly title: string | null;
  readonly excludesWeekends: boolean;
  /** Task id → colour, from `%% color` lines (A40). */
  readonly colors: ReadonlyMap<string, TaskColor>;
  /** Phase name → colour, from `%% section-color` lines; a phase without one is automatic. */
  readonly sectionColors: ReadonlyMap<string, TaskColor>;
  /** Chart-wide style settings, from `%% option` lines. */
  readonly options: ChartOptions;
  /** Why the visual editor must stay read-only, or `null` when it can edit. */
  readonly readOnly: string | null;
}

const INDENT = "    ";
const ID = /^[A-Za-z_][A-Za-z0-9_-]*$/u;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const LENGTH = /^(\d+)([hdw])$/u;
/** Directives that keep their meaning when the editor leaves them untouched. */
const KEPT = /^(title|axisFormat|tickInterval|todayMarker|topAxis|accTitle|accDescr|weekday|displayMode)\b/iu;

let counter = 0;
/** A fresh session key. Exported for tests that build charts by hand. */
export function nextKey(): string {
  counter += 1;
  return `k${counter}`;
}

/** Days since 1970-01-01 for a `YYYY-MM-DD` string, or `null` if it is not a real date. */
export function parseDay(text: string): number | null {
  const match = DATE.exec(text);
  if (match === null) return null;
  const [, y, m, d] = match;
  const ms = Date.UTC(Number(y), Number(m) - 1, Number(d));
  const date = new Date(ms);
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) {
    return null;
  }
  return Math.round(ms / 86_400_000);
}

/** The `YYYY-MM-DD` string for a day number (the day it falls in, for a fractional one). */
export function formatDay(day: number): string {
  return new Date(Math.floor(day) * 86_400_000).toISOString().slice(0, 10);
}

/** Saturday or Sunday, Mermaid's default weekend. */
export function isWeekend(day: number): boolean {
  const weekday = new Date(Math.floor(day) * 86_400_000).getUTCDay();
  return weekday === 0 || weekday === 6;
}

/**
 * Parses Mermaid `gantt` source. Never throws: anything the editor cannot represent faithfully
 * makes the chart read-only and is kept verbatim.
 */
export function parseChart(source: string): Chart {
  const texts = source.split("\n");
  const lines: Line[] = [];
  let title: string | null = null;
  let excludesWeekends = false;
  let readOnly: string | null = null;
  let seenGantt = false;
  const refuse = (reason: string): void => { readOnly ??= reason; };

  for (const text of texts) {
    const trimmed = text.trim();
    const raw = (): void => { lines.push({ kind: "raw", key: nextKey(), text }); };
    if (!seenGantt) {
      raw();
      if (/^gantt\b/iu.test(trimmed)) seenGantt = true;
      continue;
    }
    if (trimmed === "" || trimmed.startsWith("%%")) { raw(); continue; }
    if (trimmed.includes(";")) { refuse("a line holds more than one statement (;)"); raw(); continue; }
    const directive = /^(\S+)(?:\s+(.*))?$/u.exec(trimmed);
    const word = directive?.[1] ?? "";
    const rest = (directive?.[2] ?? "").trim();
    if (/^dateFormat$/iu.test(word)) {
      if (rest !== "YYYY-MM-DD") refuse(`dates use the format ${rest}`);
      raw(); continue;
    }
    if (/^excludes$/iu.test(word)) {
      if (rest.toLowerCase() === "weekends") excludesWeekends = true;
      else refuse(`it excludes ${rest}`);
      raw(); continue;
    }
    if (/^(inclusiveEndDates|includes|weekend|click|call)$/iu.test(word)) {
      refuse(`it uses ${word}`);
      raw(); continue;
    }
    if (/^accDescr\s*\{/iu.test(trimmed)) { refuse("it has a multi-line accDescr block"); raw(); continue; }
    // why: Mermaid's lexer matches these before task text, so a line starting with one is
    // that directive whatever follows, colon included.
    if (/^title$/iu.test(word)) { title = rest; raw(); continue; }
    if (KEPT.test(trimmed)) { raw(); continue; }
    if (/^section\s/iu.test(trimmed)) {
      lines.push({ kind: "section", key: nextKey(), name: trimmed.slice("section".length).trim(), original: text });
      continue;
    }
    const task = parseTask(text);
    if (typeof task === "string") { refuse(task); raw(); continue; }
    lines.push(task);
  }
  if (!seenGantt) refuse("it is not a gantt chart");
  return { lines, title, excludesWeekends, colors: taskColors(source), sectionColors: sectionColors(source), options: chartOptions(source), readOnly };
}

function parseTask(text: string): Task | string {
  const colon = text.indexOf(":");
  if (colon === -1) return `"${text.trim()}" is not a task line`;
  const name = text.slice(0, colon).trim();
  const data = text.slice(colon + 1);
  if (name === "") return "a task has no name";
  if (data.includes("#")) return "a task line contains #";
  const items = data.split(",").map((item) => item.trim());
  const tags: Tag[] = [];
  while (items.length > 0 && (TAGS as readonly string[]).includes(items[0] ?? "")) {
    tags.push(items.shift() as Tag);
  }
  let id: string | null = null;
  let startText: string | null = null;
  let endText: string;
  if (items.length === 1) {
    endText = items[0] ?? "";
  } else if (items.length === 2) {
    startText = items[0] ?? "";
    endText = items[1] ?? "";
  } else if (items.length === 3) {
    id = items[0] ?? "";
    startText = items[1] ?? "";
    endText = items[2] ?? "";
    if (!ID.test(id)) return `task id "${id}" is not a plain name`;
  } else {
    return `task "${name}" has ${items.length} fields`;
  }
  const start = startText === null ? { kind: "previous" as const } : parseStart(startText);
  if (typeof start === "string") return start;
  const end = parseEnd(endText);
  if (typeof end === "string") return end;
  return { kind: "task", key: nextKey(), name, tags, id, start, end, original: text };
}

function parseStart(text: string): Start | string {
  const after = /^after\s+(.+)$/u.exec(text);
  if (after !== null) {
    const ids = (after[1] ?? "").split(/\s+/u).filter((part) => part !== "");
    if (ids.length === 0 || !ids.every((part) => ID.test(part))) return `"${text}" names an unusual task id`;
    return { kind: "after", ids };
  }
  const day = parseDay(text);
  return day === null ? `"${text}" is not a YYYY-MM-DD start` : { kind: "date", day };
}

function parseEnd(text: string): End | string {
  const day = parseDay(text);
  if (day !== null) return { kind: "date", day };
  const length = LENGTH.exec(text);
  if (length !== null) {
    const count = Number(length[1]);
    const unit = length[2];
    return unit === "w" ? { kind: "weeks", count } : unit === "h" ? { kind: "hours", count } : { kind: "days", count };
  }
  return `"${text}" is not a date or a whole number of hours, days or weeks`;
}

/** The chart's text. Unedited lines come back exactly as they were read. */
export function serializeChart(chart: Chart): string {
  return chart.lines.map((line) => {
    if (line.kind === "raw") return line.text;
    if (line.original !== null) return line.original;
    return line.kind === "section" ? `${INDENT}section ${line.name}` : taskLine(line);
  }).join("\n");
}

function taskLine(task: Task): string {
  const fields: string[] = [...task.tags];
  if (task.id !== null) fields.push(task.id);
  if (task.start.kind !== "previous") fields.push(startText(task.start));
  // why: Mermaid reads two fields as start and end. An id with no explicit start would be
  // taken for a start date, so callers give such a task an explicit start first.
  else if (task.id !== null) throw new Error("a task with an id needs an explicit start");
  fields.push(endText(task.end));
  return `${INDENT}${task.name} :${fields.join(", ")}`;
}

function startText(start: Start): string {
  if (start.kind === "date") return formatDay(start.day);
  if (start.kind === "after") return `after ${start.ids.join(" ")}`;
  return "";
}

function endText(end: End): string {
  if (end.kind === "date") return formatDay(end.day);
  return `${end.count}${end.kind === "weeks" ? "w" : end.kind === "hours" ? "h" : "d"}`;
}

/**
 * Where a task falls, once dates, lengths and dependencies are worked out. Days may be
 * fractional: an hours length ends part-way through a day, and a task after it starts there.
 */
export interface Placed {
  readonly start: number;
  /** Exclusive, as Mermaid's end. */
  readonly end: number;
  readonly error: string | null;
}

/**
 * Works out every task's start and end, the way Mermaid does (SPEC §13.3).
 *
 * A dependency on an unknown id, or a cycle, is an error on that task. The task is still
 * placed, at the start of the chart, so the editor can draw it and the user can fix it.
 */
export function schedule(chart: Chart, today: number): ReadonlyMap<string, Placed> {
  const tasks = chart.lines.filter((line): line is Task => line.kind === "task");
  const byId = new Map<string, Task>();
  for (const task of tasks) if (task.id !== null) byId.set(task.id, task);
  const placed = new Map<string, Placed>();
  const visiting = new Set<string>();
  const firstDate = tasks.find((task) => task.start.kind === "date")?.start;
  const fallback = firstDate?.kind === "date" ? firstDate.day : today;

  const place = (task: Task, index: number): Placed => {
    const done = placed.get(task.key);
    if (done !== undefined) return done;
    if (visiting.has(task.key)) return { start: fallback, end: fallback + 1, error: "its dependencies form a cycle" };
    visiting.add(task.key);
    let start = fallback;
    let error: string | null = null;
    if (task.start.kind === "date") {
      start = task.start.day;
    } else if (task.start.kind === "previous") {
      const previous = index > 0 ? tasks[index - 1] : undefined;
      if (previous === undefined) error = "it starts after the task above, and there is none";
      else {
        const before = place(previous, index - 1);
        start = before.end;
        if (before.error !== null) error = before.error;
      }
    } else {
      let latest: number | null = null;
      for (const id of task.start.ids) {
        const dependency = byId.get(id);
        if (dependency === undefined) { error = `no task has the id ${id}`; continue; }
        const result = place(dependency, tasks.indexOf(dependency));
        if (result.error !== null) error ??= result.error;
        if (latest === null || result.end > latest) latest = result.end;
      }
      start = latest ?? fallback;
    }
    const end = endDay(task, start, chart.excludesWeekends);
    const result = { start, end, error };
    visiting.delete(task.key);
    placed.set(task.key, result);
    return result;
  };
  tasks.forEach((task, index) => place(task, index));
  return placed;
}

function endDay(task: Task, start: number, excludesWeekends: boolean): number {
  if (task.end.kind === "date") return task.end.day;
  const length = task.end.kind === "weeks" ? task.end.count * 7 : task.end.kind === "hours" ? task.end.count / 24 : task.end.count;
  let end = start + length;
  if (excludesWeekends) {
    // why: Mermaid's fixTaskDates, step for step: walk the days after the start up to the
    // (growing) end, and push the end out by one for every weekend day met.
    for (let day = start + 1; day <= end; day += 1) if (isWeekend(day)) end += 1;
  }
  return end;
}
