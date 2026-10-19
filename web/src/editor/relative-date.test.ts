import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { fullDateLabel, localDateSource, parseLocalDate, relativeDateLabel, resolveDateKeyword } from "./relative-date.js";

const now = new Date(2026, 9, 19, 11, 20);
function label(source: string, reference = now): string {
  const value = parseLocalDate(source);
  if (!value) throw new Error(`invalid fixture ${source}`);
  return relativeDateLabel(value, reference, "en-US");
}

describe("local relative dates", () => {
  it.each([
    ["now", "2026-10-19 11:20"], ["today", "2026-10-19"],
    ["yesterday", "2026-10-18"], ["tomorrow", "2026-10-20"],
  ] as const)("resolves @%s into fixed local source", (keyword, source) => {
    expect(resolveDateKeyword(keyword, now)).toBe(source);
  });
  it.each([
    ["2026-10-19", "Today"], ["2026-10-18", "Yesterday"], ["2026-10-20", "Tomorrow"],
    ["2026-10-12", "Last Monday"], ["2026-10-26", "Next Monday"], ["2026-10-25", "Next Sunday"],
    ["2026-10-11", "October 11, 2026"], ["2026-10-27", "October 27, 2026"], ["2027-07-01", "July 1, 2027"],
    ["2026-10-19 11:19", "Today 11:19 AM"],
  ])("renders %s as %s", (source, expected) => { expect(label(source)).toBe(expected); });
  it("compares calendar days across a daylight-saving transition", () => {
    expect(label("2026-10-25", new Date(2026, 9, 26, 0, 5))).toBe("Yesterday");
    expect(label("2026-10-19", new Date(2026, 9, 26, 23, 55))).toBe("Last Monday");
  });
  it("handles year boundaries using the local calendar", () => {
    expect(resolveDateKeyword("yesterday", new Date(2027, 0, 1, 0, 5))).toBe("2026-12-31");
    expect(label("2027-01-01", new Date(2026, 11, 31, 23, 55))).toBe("Tomorrow");
  });
  it.each(["2026-02-29", "2026-13-01", "2026-10-00", "2026-10-19 24:00", "2026-10-19 11:60", "0000-01-01", "2026-1-1", "2026-10-19junk", "", "2026-10-19T11:20Z"])("rejects malformed or impossible date %s", source => {
    expect(parseLocalDate(source)).toBeUndefined();
  });
  it("includes the absolute date and optional time in hover details", () => {
    const value = parseLocalDate("2026-10-19 11:20");
    if (!value) throw new Error("missing date");
    expect(fullDateLabel(value, "en-US")).toBe("Monday, October 19, 2026 at 11:20 AM");
  });
  it("round-trips local calendar fields without UTC date shifts", () => {
    fc.assert(fc.property(fc.date({ min: new Date(2000, 0, 1), max: new Date(2099, 11, 31), noInvalidDate: true }), date => {
      const source = localDateSource(date, true);
      const parsed = parseLocalDate(source);
      expect(parsed && localDateSource(parsed.date, true)).toBe(source);
    }), { seed: 19102026, numRuns: 500 });
  });
});
