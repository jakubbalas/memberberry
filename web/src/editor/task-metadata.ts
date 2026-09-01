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
