import { describe, expect, it } from "vitest";

import { parseNaturalDate, todayDate } from "./task-metadata.js";

const NOW = new Date(2026, 8, 1, 14, 30);

describe("parseNaturalDate", () => {
  it("parses the documented relative date forms", () => {
    expect(parseNaturalDate("tomorrow", NOW)?.value).toBe("2026-09-02");
    expect(parseNaturalDate("next friday", NOW)?.value).toBe("2026-09-04");
    expect(parseNaturalDate("in 3 days", NOW)?.value).toBe("2026-09-04");
  });

  it("accepts canonical dates and rejects ambiguous input", () => {
    expect(parseNaturalDate("2026-12-31", NOW)?.value).toBe("2026-12-31");
    expect(parseNaturalDate("soon", NOW)).toBeNull();
    expect(parseNaturalDate("2026-99-99", NOW)).toBeNull();
  });

  it("uses the local calendar day rather than UTC", () => {
    expect(todayDate(new Date(2026, 0, 2, 0, 5))).toBe("2026-01-02");
  });
});
