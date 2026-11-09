/**
 * Edits to a parsed Gantt chart (SPEC §13.3). Pure: each returns a new chart, or a reason it
 * refused, and never touches a line it does not change, so untouched lines keep their text.
 */
import { chartOptions, COLOR_LINE, colorText, DEFAULT_OPTIONS, OPTION_KEYS, OPTION_LINE, SECTION_COLOR_LINE, sectionColors, taskColors, type ChartOptions, type TaskColor } from "./colors.js";
import {
  isWeekend,
  nextKey,
  schedule,
  type Chart,
  type End,
  type Line,
  type Placed,
  type Section,
  type Start,
  type Tag,
  type Task,
} from "./model.js";

/** An edit that could not be made, in words for the status line. */
export interface Refused {
  readonly refused: string;
}

export type Outcome = Chart | Refused;

export function isRefused(outcome: Outcome): outcome is Refused {
  return "refused" in outcome;
}

/** Directive words a task name may not start with: Mermaid would read the line as one. */
const RESERVED = /^(gantt|section|title|dateFormat|axisFormat|tickInterval|excludes|includes|todayMarker|inclusiveEndDates|topAxis|weekday|weekend|click|call|accTitle|accDescr|displayMode)\b/iu;

/** Why `name` cannot be a task or section name, or `null` if it can. */
export function nameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "A name cannot be empty.";
  if (/[:#;\n\r]/u.test(trimmed)) return "A name cannot contain : # or ;.";
  if (trimmed.startsWith("%%")) return "A name cannot start with %%.";
  if (RESERVED.test(trimmed)) return `A name cannot start with “${trimmed.split(/\s/u)[0] ?? ""}”.`;
  return null;
}

function tasksOf(chart: Chart): Task[] {
  return chart.lines.filter((line): line is Task => line.kind === "task");
}

function find(chart: Chart, key: string): Task | undefined {
  return tasksOf(chart).find((task) => task.key === key);
}

function replace(chart: Chart, key: string, next: Line): Chart {
  return { ...chart, lines: chart.lines.map((line) => (line.key === key ? next : line)) };
}

function edited(task: Task, patch: Partial<Omit<Task, "kind" | "key" | "original">>): Task {
  return { ...task, ...patch, original: null };
}

/** Sets or clears the chart title; a cleared title removes the directive line. */
export function setTitle(chart: Chart, title: string): Outcome {
  const text = title.trim();
  if (/[\n\r;]/u.test(text)) return { refused: "A title cannot contain a line break or ;." };
  const index = chart.lines.findIndex((line) => line.kind === "raw" && /^\s*title\b/iu.test(line.text));
  const lines = [...chart.lines];
  if (index !== -1) {
    if (text === "") lines.splice(index, 1);
    else lines[index] = { kind: "raw", key: nextKey(), text: `    title ${text}` };
  } else if (text !== "") {
    const gantt = lines.findIndex((line) => line.kind === "raw" && /^\s*gantt\b/iu.test(line.text));
    lines.splice(gantt + 1, 0, { kind: "raw", key: nextKey(), text: `    title ${text}` });
  }
  return { ...chart, lines, title: text === "" ? null : text };
}

export function renameLine(chart: Chart, key: string, name: string): Outcome {
  const problem = nameProblem(name);
  if (problem !== null) return { refused: problem };
  const line = chart.lines.find((candidate) => candidate.key === key);
  if (line === undefined || line.kind === "raw") return { refused: "That row no longer exists." };
  const next: Line = line.kind === "task"
    ? edited(line, { name: name.trim() })
    : { ...line, name: name.trim(), original: null };
  const renamed = replace(chart, key, next);
  if (line.kind !== "section") return renamed;
  // why: a phase colour is keyed by the phase's name, so it follows the rename.
  const color = chart.sectionColors.get(line.name);
  if (color === undefined) return renamed;
  const shared = renamed.lines.some((other) => other.kind === "section" && other.name === line.name);
  const lines = shared ? renamed.lines : withoutSectionColor(renamed.lines, line.name);
  return recolored({ ...renamed, lines: withColorLine(lines, `    %% section-color ${colorText(color)} ${name.trim()}`) });
}

/** Sets a task's progress tag (none, active or done), keeping its other tags. */
export function setProgress(chart: Chart, key: string, progress: "todo" | "active" | "done"): Outcome {
  const task = find(chart, key);
  if (task === undefined) return { refused: "That task no longer exists." };
  const others = task.tags.filter((tag) => tag !== "active" && tag !== "done");
  const tags: Tag[] = progress === "todo" ? others : [progress, ...others];
  return replace(chart, key, edited(task, { tags }));
}

/** Turns `crit` or `milestone` on or off. A milestone gets a zero length. */
export function setFlag(chart: Chart, key: string, flag: "crit" | "milestone", on: boolean): Outcome {
  const task = find(chart, key);
  if (task === undefined) return { refused: "That task no longer exists." };
  const without = task.tags.filter((tag) => tag !== flag);
  const tags = on ? [...without, flag] : without;
  return replace(chart, key, edited(task, { tags, end: flaggedEnd(task.end, flag, on) }));
}

/** A milestone is zero days long; un-marking one gives it a day back. */
function flaggedEnd(end: End, flag: "crit" | "milestone", on: boolean): End {
  if (flag !== "milestone") return end;
  if (on) return { kind: "days", count: 0 };
  return end.kind !== "date" && end.count === 0 ? { kind: "days", count: 1 } : end;
}

/** Pins a task's start to `day`. A dependency it had is dropped; `pinned` says so. */
export function moveTo(chart: Chart, key: string, day: number, today: number): { chart: Outcome; pinned: boolean } {
  const task = find(chart, key);
  if (task === undefined) return { chart: { refused: "That task no longer exists." }, pinned: false };
  const placed = schedule(chart, today).get(key);
  if (placed === undefined) return { chart: { refused: "That task no longer exists." }, pinned: false };
  // why: a start date is a whole day, but a task after an hours-long one may start mid-day, so
  // the target is floored and an end date moves by whole days.
  const target = Math.floor(day);
  if (target === placed.start) return { chart, pinned: false };
  const delta = target - Math.floor(placed.start);
  const start: Start = { kind: "date", day: target };
  const end: End = task.end.kind === "date" ? { kind: "date", day: task.end.day + delta } : task.end;
  const pinned = task.start.kind !== "date";
  return { chart: replace(chart, key, edited(task, { start, end })), pinned };
}

/** Sets where a task ends (exclusive day), keeping the kind of end it had. */
export function endAt(chart: Chart, key: string, day: number, today: number): Outcome {
  const task = find(chart, key);
  if (task === undefined) return { refused: "That task no longer exists." };
  if (task.tags.includes("milestone")) return { refused: "A milestone has no length." };
  const placed = schedule(chart, today).get(key);
  if (placed === undefined) return { refused: "That task no longer exists." };
  if (task.end.kind === "hours") {
    const hours = Math.max(1, Math.round((day - placed.start) * 24));
    return replace(chart, key, edited(task, { end: { kind: "hours", count: hours } }));
  }
  const target = Math.max(day, Math.floor(placed.start) + 1);
  if (task.end.kind === "date") return replace(chart, key, edited(task, { end: { kind: "date", day: target } }));
  return replace(chart, key, edited(task, { end: { kind: "days", count: lengthFor(placed.start, target, chart.excludesWeekends) } }));
}

/** The day count Mermaid needs to end at `end` from `start`; weekends skipped if excluded. */
export function lengthFor(start: number, end: number, excludesWeekends: boolean): number {
  if (!excludesWeekends) return Math.max(1, end - start);
  let count = 0;
  for (let day = start + 1; day <= end; day += 1) if (!isWeekend(day)) count += 1;
  return Math.max(1, count);
}

export function setStart(chart: Chart, key: string, start: Start): Outcome {
  const task = find(chart, key);
  if (task === undefined) return { refused: "That task no longer exists." };
  if (start.kind === "after") {
    const ids = new Set(tasksOf(chart).map((candidate) => candidate.id));
    const missing = start.ids.find((id) => !ids.has(id));
    if (missing !== undefined) return { refused: `No task has the id ${missing}.` };
    if (task.id !== null && start.ids.includes(task.id)) return { refused: "A task cannot start after itself." };
  }
  if (start.kind === "previous" && task.id !== null) return { refused: "A task with an id needs its own start." };
  const next = replace(chart, key, edited(task, { start }));
  return cycleCheck(next, key);
}

export function setEnd(chart: Chart, key: string, end: End): Outcome {
  const task = find(chart, key);
  if (task === undefined) return { refused: "That task no longer exists." };
  if (end.kind !== "date" && (!Number.isSafeInteger(end.count) || end.count < 0 || end.count > MAX_COUNT[end.kind])) {
    return { refused: "A length is a whole number of hours, days or weeks." };
  }
  return replace(chart, key, edited(task, { end }));
}

const MAX_COUNT = { hours: 24 * 3650, days: 3650, weeks: 520 } as const;

/** How a task's end can be given in the editor. */
export type EndKind = End["kind"];

/**
 * Switches how a task's end is written (an end date, or hours, days or weeks) keeping the bar
 * where it is, rounded to the new unit (at least one).
 */
export function setEndKind(chart: Chart, key: string, kind: EndKind, today: number): Outcome {
  const task = find(chart, key);
  if (task === undefined) return { refused: "That task no longer exists." };
  if (task.end.kind === kind) return chart;
  if (task.tags.includes("milestone")) return { refused: "A milestone has no length." };
  const placed = schedule(chart, today).get(key);
  if (placed === undefined) return { refused: "That task no longer exists." };
  const span = placed.end - placed.start;
  const end: End = kind === "date" ? { kind: "date", day: Math.max(Math.ceil(placed.end), Math.floor(placed.start) + 1) }
    : kind === "hours" ? { kind: "hours", count: Math.max(1, Math.round(span * 24)) }
    : kind === "weeks" ? { kind: "weeks", count: Math.max(1, Math.round(span / 7)) }
    : { kind: "days", count: chart.excludesWeekends ? lengthFor(placed.start, placed.end, true) : Math.max(1, Math.round(span)) };
  return replace(chart, key, edited(task, { end }));
}

function cycleCheck(chart: Chart, key: string): Outcome {
  const placed = schedule(chart, 0).get(key);
  return placed?.error === "its dependencies form a cycle" ? { refused: "That would make the tasks depend on each other in a loop." } : chart;
}

/** A name-derived id no other task uses. */
function freshId(chart: Chart, name: string): string {
  const used = new Set(tasksOf(chart).map((task) => task.id));
  const stem = name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 16);
  const base = /^[a-z]/u.test(stem) ? stem : `t-${stem}`.replace(/-+$/u, "");
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * Gives a task an id so another can start after it. A task in Mermaid's one-field form
 * cannot carry an id, so it first starts explicitly after the task above, exactly where it was.
 */
export function ensureId(chart: Chart, key: string, today: number): { chart: Chart; id: string } | Refused {
  const task = find(chart, key);
  if (task === undefined) return { refused: "That task no longer exists." };
  if (task.id !== null) return { chart, id: task.id };
  let next = chart;
  let start = task.start;
  if (start.kind === "previous") {
    const tasks = tasksOf(chart);
    const above = tasks[tasks.findIndex((candidate) => candidate.key === key) - 1];
    if (above === undefined) {
      const placed = schedule(chart, today).get(key);
      start = { kind: "date", day: placed?.start ?? today };
    } else {
      const named = ensureId(chart, above.key, today);
      if ("refused" in named) return named;
      next = named.chart;
      start = { kind: "after", ids: [named.id] };
    }
  }
  const current = find(next, key);
  if (current === undefined) return { refused: "That task no longer exists." };
  const id = freshId(next, current.name);
  return { chart: replace(next, key, edited(current, { id, start })), id };
}

/** Makes `target` start after `source`, the connector drag of SPEC §13.3. */
export function link(chart: Chart, source: string, target: string, today: number): Outcome {
  if (source === target) return { refused: "A task cannot start after itself." };
  const named = ensureId(chart, source, today);
  if ("refused" in named) return named;
  let next = named.chart;
  const task = find(next, target);
  if (task === undefined) return { refused: "That task no longer exists." };
  next = replace(next, target, edited(task, { start: { kind: "after", ids: [named.id] } }));
  return cycleCheck(next, target);
}

/**
 * Moves a task to just before `beforeKey` (a task or section line), or to the end when it is
 * `null`. Which section a task is in is only where it sits, so this is also how a task changes
 * phase (SPEC §13.3).
 *
 * Moving never changes a date. Mermaid's one-field form starts a task right after the line
 * above it, so three tasks can be affected by a move: the moved one, the one that was below
 * it, and the one that ends up below it. Each of those is given an explicit `after` (or a date
 * when there is nothing above) for the task it really followed.
 */
export function moveTask(chart: Chart, key: string, beforeKey: string | null, today: number): Outcome {
  const moving = find(chart, key);
  if (moving === undefined) return { refused: "That task no longer exists." };
  if (beforeKey === key) return chart;
  if (beforeKey !== null && !chart.lines.some((line) => line.key === beforeKey)) return { refused: "That row no longer exists." };
  if (sameOrder(chart, reordered(chart.lines, key, beforeKey))) return chart;
  const placed = schedule(chart, today);
  let next = chart;

  // why: each step re-reads the chart, because ensureId may rewrite the task above.
  const follow = (taskKey: string, above: Task | undefined): Refused | null => {
    const task = find(next, taskKey);
    if (task === undefined || task.start.kind !== "previous") return null;
    if (above === undefined) {
      next = replace(next, taskKey, edited(task, { start: { kind: "date", day: placed.get(taskKey)?.start ?? today } }));
      return null;
    }
    const named = ensureId(next, above.key, today);
    if ("refused" in named) return named;
    next = named.chart;
    const current = find(next, taskKey);
    if (current !== undefined) next = replace(next, taskKey, edited(current, { start: { kind: "after", ids: [named.id] } }));
    return null;
  };

  const tasks = tasksOf(chart);
  const at = tasks.findIndex((task) => task.key === key);
  const above = tasks[at - 1];
  const below = tasks[at + 1];
  // The task that will sit right below the moved one, and the one it follows today.
  const lines = chart.lines;
  const insertAt = beforeKey === null ? lines.length : lines.findIndex((line) => line.key === beforeKey);
  const landing = lines.slice(insertAt).find((line): line is Task => line.kind === "task" && line.key !== key);
  const landingAbove = landing === undefined ? undefined : tasks[tasks.findIndex((task) => task.key === landing.key) - 1];

  for (const [taskKey, followed] of [
    [key, above],
    [below?.key, moving],
    [landing?.key, landingAbove?.key === key ? above : landingAbove],
  ] as const) {
    if (taskKey === undefined) continue;
    const refused = follow(taskKey, followed === undefined ? undefined : find(next, followed.key) ?? followed);
    if (refused !== null) return refused;
  }

  return { ...next, lines: reordered(next.lines, key, beforeKey) };
}

function reordered(lines: readonly Line[], key: string, beforeKey: string | null): Line[] {
  const moved = lines.find((line) => line.key === key);
  const without = lines.filter((line) => line.key !== key);
  if (moved === undefined) return without;
  const target = beforeKey === null ? without.length : without.findIndex((line) => line.key === beforeKey);
  without.splice(target === -1 ? without.length : target, 0, moved);
  return without;
}

function sameOrder(chart: Chart, lines: readonly Line[]): boolean {
  return lines.every((line, index) => chart.lines[index]?.key === line.key);
}

/** Where a task lands one step up or down, crossing into the next phase at a section line. */
export function stepTarget(chart: Chart, key: string, direction: "up" | "down"): string | null | undefined {
  const order = chart.lines.filter((line) => line.kind !== "raw");
  const at = order.findIndex((line) => line.key === key);
  if (at === -1) return undefined;
  if (direction === "up") {
    const previous = order[at - 1];
    return previous === undefined ? undefined : previous.key;
  }
  const next = order[at + 1];
  if (next === undefined) return undefined;
  return order[at + 2]?.key ?? null;
}

/** The chart with its task and phase colours read again from its colour lines. */
function recolored(chart: Chart): Chart {
  const text = chart.lines.filter((line) => line.kind === "raw").map((line) => (line.kind === "raw" ? line.text : "")).join("\n");
  return { ...chart, colors: taskColors(text), sectionColors: sectionColors(text), options: chartOptions(text) };
}

/** Drops every phase colour line for `name`. */
function withoutSectionColor(lines: readonly Line[], name: string): Line[] {
  return lines.filter((line) => line.kind !== "raw" || SECTION_COLOR_LINE.exec(line.text)?.[2] !== name);
}

/**
 * Puts a colour line with the others: after the chart's directives and any colour lines,
 * above the first row, and not between a comment and the row it introduces.
 */
function withColorLine(lines: readonly Line[], text: string): Line[] {
  const next = [...lines];
  const firstRow = next.findIndex((line) => line.kind !== "raw");
  let at = firstRow === -1 ? next.length : firstRow;
  while (at > 0) {
    const above = next[at - 1];
    const trimmed = above?.kind === "raw" ? above.text.trim() : null;
    const colourLine = above?.kind === "raw" && (COLOR_LINE.test(above.text) || SECTION_COLOR_LINE.test(above.text) || OPTION_LINE.test(above.text));
    if (trimmed !== null && (trimmed === "" || (trimmed.startsWith("%%") && !colourLine))) at -= 1;
    else break;
  }
  next.splice(at, 0, { kind: "raw", key: nextKey(), text });
  return next;
}

/**
 * Sets a chart-wide option. The default writes no line, so a chart only carries the settings
 * that differ from it (SPEC §13.3).
 */
export function setOption<K extends keyof ChartOptions>(chart: Chart, option: K, value: ChartOptions[K]): Outcome {
  const { key, values } = OPTION_KEYS[option];
  if (!(values as readonly string[]).includes(value)) return { refused: `“${value}” is not a ${key} setting.` };
  const lines = chart.lines.filter((line) => line.kind !== "raw" || OPTION_LINE.exec(line.text)?.[1]?.toLowerCase() !== key);
  const next = value === DEFAULT_OPTIONS[option] ? lines : withColorLine(lines, `    %% option ${key} ${value}`);
  return recolored({ ...chart, lines: next });
}

/** Colours a phase, or returns it to its automatic colour with `null` (SPEC §13.3). */
export function setSectionColor(chart: Chart, key: string, color: TaskColor | null): Outcome {
  const section = chart.lines.find((line): line is Section => line.kind === "section" && line.key === key);
  if (section === undefined) return { refused: "That phase no longer exists." };
  const lines = withoutSectionColor(chart.lines, section.name);
  return recolored({ ...chart, lines: color === null ? lines : withColorLine(lines, `    %% section-color ${colorText(color)} ${section.name}`) });
}

/** Drops every colour line for `id`. */
function withoutColor(lines: readonly Line[], id: string): Line[] {
  return lines.filter((line) => line.kind !== "raw" || COLOR_LINE.exec(line.text)?.[1] !== id);
}

/**
 * Colours a task, or clears its colour with `null` (A40). The colour is a `%% color` comment
 * keyed by the task's id, so the task gets an id if it has none. Colour lines sit together after
 * the chart's directives, so moving tasks between phases never leaves one behind.
 */
export function setColor(chart: Chart, key: string, color: TaskColor | null, today: number): Outcome {
  const named = ensureId(chart, key, today);
  if ("refused" in named) return named;
  const lines = withoutColor(named.chart.lines, named.id);
  const next = color === null ? lines : withColorLine(lines, `    %% color ${named.id} ${colorText(color)}`);
  return recolored({ ...named.chart, lines: next });
}

/** A new task after `afterKey` (or at the end), starting where that task ends. */
export function addTask(chart: Chart, afterKey: string | null, today: number): { chart: Chart; key: string } {
  const placed = schedule(chart, today);
  const lines = [...chart.lines];
  const index = afterKey === null ? -1 : lines.findIndex((line) => line.key === afterKey);
  const anchor = index === -1 ? tasksOf(chart).at(-1) : lines[index];
  const startDay = anchor?.kind === "task" ? placed.get(anchor.key)?.end ?? today : today;
  const key = nextKey();
  const task: Task = { kind: "task", key, name: "New task", tags: [], id: null, start: { kind: "date", day: startDay }, end: { kind: "days", count: 5 }, original: null };
  if (index === -1) lines.push(task);
  else lines.splice(index + 1, 0, task);
  return { chart: { ...chart, lines }, key };
}

/** A new section after `afterKey`, or at the end. */
export function addSection(chart: Chart, afterKey: string | null): { chart: Chart; key: string } {
  const lines = [...chart.lines];
  const index = afterKey === null ? -1 : lines.findIndex((line) => line.key === afterKey);
  const key = nextKey();
  const section: Section = { kind: "section", key, name: "New section", original: null };
  if (index === -1) lines.push(section);
  else lines.splice(index + 1, 0, section);
  return { chart: { ...chart, lines }, key };
}

/**
 * Removes a task or section. Tasks that started after a removed task keep their place: they
 * are pinned to the date they had, rather than left pointing at an id that no longer exists.
 */
export function remove(chart: Chart, key: string, today: number): Chart {
  const target = chart.lines.find((line) => line.key === key);
  if (target === undefined) return chart;
  const placed = schedule(chart, today);
  const tasks = tasksOf(chart);
  const index = tasks.findIndex((task) => task.key === key);
  const below = index === -1 ? undefined : tasks[index + 1];
  const lines = chart.lines.filter((line) => line.key !== key).map((line): Line => {
    if (line.kind !== "task" || target.kind !== "task") return line;
    const dependsById = target.id !== null && line.start.kind === "after" && line.start.ids.includes(target.id);
    const dependsByOrder = below?.key === line.key && line.start.kind === "previous";
    if (!dependsById && !dependsByOrder) return line;
    const day = placed.get(line.key)?.start ?? today;
    const ids = line.start.kind === "after" ? line.start.ids.filter((id) => id !== target.id) : [];
    return edited(line, { start: ids.length > 0 ? { kind: "after", ids } : { kind: "date", day } });
  });
  const uncoloured = target.kind === "task" && target.id !== null ? withoutColor(lines, target.id)
    : target.kind === "section" && !lines.some((line) => line.kind === "section" && line.name === target.name) ? withoutSectionColor(lines, target.name)
    : lines;
  return recolored({ ...chart, lines: uncoloured });
}

/** The tasks in drawing order, with where each falls. */
export function rows(chart: Chart, today: number): readonly { readonly line: Task | Section; readonly placed: Placed | null }[] {
  const placed = schedule(chart, today);
  return chart.lines
    .filter((line): line is Task | Section => line.kind !== "raw")
    .map((line) => ({ line, placed: line.kind === "task" ? placed.get(line.key) ?? null : null }));
}
