/** Task metadata helpers for the editor controls (SPEC.md §10.2). */

export type TaskPriority = "lowest" | "low" | "medium" | "high" | "highest";

export interface ParsedDate {
  readonly value: string;
  readonly label: string;
}

const WEEKDAYS: Readonly<Record<string, number>> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/** Parses the natural-language dates supported by `/due` without depending on locale. */
export function parseNaturalDate(input: string, now = new Date()): ParsedDate | null {
  const normalized = input.trim().toLowerCase();
  const today = atMidnight(now);
  if (normalized === "today") return dateResult(today, "Today");
  if (normalized === "tomorrow") return dateResult(addDays(today, 1), "Tomorrow");

  const inDays = /^in (\d+) days?$/.exec(normalized);
  if (inDays?.[1] !== undefined) {
    const days = Number(inDays[1]);
    if (Number.isSafeInteger(days)) return dateResult(addDays(today, days), `In ${days} days`);
  }

  const weekday = /^next (sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/.exec(normalized);
  if (weekday?.[1] !== undefined) {
    const target = WEEKDAYS[weekday[1]];
    if (target === undefined) return null;
    const offset = ((target - today.getDay() + 6) % 7) + 1;
    return dateResult(addDays(today, offset), `Next ${capitalize(weekday[1])}`);
  }

  const canonical = isoDate(normalized);
  return canonical === null ? null : { value: canonical, label: canonical };
}

/** Returns today's canonical task date in the user's local calendar. */
export function todayDate(now = new Date()): string {
  const date = atMidnight(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dateResult(date: Date, label: string): ParsedDate {
  return { value: todayDate(date), label };
}

function atMidnight(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  const value = new Date(date);
  value.setDate(value.getDate() + days);
  return value;
}

function isoDate(value: string | Date): string | null {
  const text = typeof value === "string" ? value : `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00`)) ? text : null;
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

/* ------------------------------------------------------------------ the inline task view

   `SPEC.md` §10.2 says task metadata "renders as inline chips, not raw emoji". The two
   functions below are the whole of that decision, kept here rather than in the view because
   they are pure: what a task's chips say, and what completing one does to its attributes.
   The node view and the toolbar's inspector both go through them, so a task toggled by
   clicking its checkbox and one toggled from the inspector cannot diverge. */

/** The statuses `schema.json` declares for `task_item`. */
export type TaskStatus = "todo" | "done" | "cancelled";

/** Which piece of task metadata a chip stands for. `unknown` is §10.4's inert chip. */
export type TaskChipField =
  | "created"
  | "start"
  | "scheduled"
  | "due"
  | "done"
  | "cancelled"
  | "priority"
  | "unknown";

/** One rendered chip. `label` is empty for a chip that is only a value (§10.4). */
export interface TaskChip {
  readonly field: TaskChipField;
  readonly label: string;
  readonly value: string;
  /** The chip's accessible name, which must stand alone without the surrounding row. */
  readonly description: string;
}

/** Date fields in the fixed serialization order of §10.1, with the words a chip shows. */
const DATE_CHIPS: readonly (readonly [TaskChipField, string])[] = [
  ["created", "Added"],
  ["start", "Start"],
  ["scheduled", "Scheduled"],
  ["due", "Due"],
  ["done", "Done"],
  ["cancelled", "Cancelled"],
];

/**
 * The chips for one `task_item`'s attributes, in §10.1's serialization order.
 *
 * Order matches the Markdown deliberately: the chips a reader sees and the markers in the
 * file they would see in a text editor are then the same sequence, which is the whole of
 * what C2 promises about this feature.
 */
export function taskChips(attrs: Readonly<Record<string, unknown>>): readonly TaskChip[] {
  const chips: TaskChip[] = [];
  for (const [field, label] of DATE_CHIPS) {
    const value = attrs[field];
    if (typeof value !== "string" || value.length === 0) continue;
    chips.push({ field, label, value, description: `${label} ${value}` });
  }

  const priority = attrs["priority"];
  if (typeof priority === "string" && priority.length > 0) {
    chips.push({
      field: "priority",
      label: "Priority",
      value: capitalize(priority),
      description: `Priority ${priority}`,
    });
  }

  // §10.4: a marker this version does not model — recurrence above all — is preserved
  // verbatim and rendered inert. It gets no label because we do not know what it means; the
  // accessible name says exactly that rather than implying we parsed it.
  const unknown = attrs["unknown"];
  if (Array.isArray(unknown)) {
    for (const marker of unknown) {
      if (typeof marker !== "string" || marker.length === 0) continue;
      chips.push({
        field: "unknown",
        label: "",
        value: marker,
        description: `Kept as written, not interpreted by this version: ${marker}`,
      });
    }
  }
  return chips;
}

/**
 * The attribute changes that completing or reopening a task makes (§10.2).
 *
 * Only ever moves between `todo` and `done`: `cancelled` is reached by writing `[-]`, not by
 * a checkbox, and this deliberately leaves an existing `❌` date alone rather than deciding
 * on the user's behalf that cancelling is undone by completing.
 */
export function toggledTaskAttributes(
  attrs: Readonly<Record<string, unknown>>,
  now?: Date,
): { readonly status: TaskStatus; readonly done: string | null } {
  const complete = attrs["status"] === "done";
  return {
    status: complete ? "todo" : "done",
    done: complete ? null : todayDate(now),
  };
}

/** Whether a status renders as a ticked box. */
export function isTaskComplete(status: unknown): boolean {
  return status === "done";
}
