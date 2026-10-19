/** Local calendar values stored as ordinary, independently readable Markdown text. */
export interface LocalDateValue {
  readonly source: string;
  readonly date: Date;
  readonly hasTime: boolean;
}

export const dateKeywords = ["now", "today", "yesterday", "tomorrow"] as const;
export type DateKeyword = typeof dateKeywords[number];
const pad = (value: number): string => String(value).padStart(2, "0");

/** Serializes calendar fields without shifting date-only values through UTC. */
export function localDateSource(date: Date, hasTime = false): string {
  const day = `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return hasTime ? `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}` : day;
}

/** Rejects impossible dates, overflow times and local times inside a DST gap. */
export function parseLocalDate(source: string): LocalDateValue | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/.exec(source);
  if (!match) return undefined;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const hasTime = match[4] !== undefined;
  const hour = hasTime ? Number(match[4]) : 12; const minute = hasTime ? Number(match[5]) : 0;
  const date = new Date(0);
  // why: the multi-argument Date constructor interprets years 00–99 as 1900–1999.
  date.setFullYear(year, month - 1, day); date.setHours(hour, minute, 0, 0);
  if (year < 1 || date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
    || date.getHours() !== hour || date.getMinutes() !== minute) return undefined;
  return { source, date, hasTime };
}

/** Resolves a mention once at confirmation; later rendering never changes its source. */
export function resolveDateKeyword(keyword: DateKeyword, now = new Date()): string {
  const date = new Date(now);
  if (keyword === "yesterday" || keyword === "tomorrow") date.setDate(date.getDate() + (keyword === "yesterday" ? -1 : 1));
  return localDateSource(date, keyword === "now");
}

function calendarDay(date: Date): number {
  const utc = new Date(0);
  utc.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate()); utc.setUTCHours(0, 0, 0, 0);
  return utc.getTime() / 86_400_000;
}

/** Relative labels are bounded by seven calendar days, including across DST changes. */
export function relativeDateLabel(value: LocalDateValue, now = new Date(), locale?: string): string {
  const days = calendarDay(value.date) - calendarDay(now);
  let label = days === 0 ? "Today" : days === -1 ? "Yesterday" : days === 1 ? "Tomorrow" : undefined;
  if (label === undefined && Math.abs(days) <= 7) {
    label = `${days < 0 ? "Last" : "Next"} ${value.date.toLocaleDateString(locale, { weekday: "long" })}`;
  }
  label ??= value.date.toLocaleDateString(locale, { year: "numeric", month: "long", day: "numeric" });
  if (value.hasTime) label += ` ${value.date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })}`;
  return label;
}

/** The hover and accessible label always include the absolute calendar date. */
export function fullDateLabel(value: LocalDateValue, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "full", ...(value.hasTime ? { timeStyle: "short" as const } : {}),
  }).format(value.date);
}
