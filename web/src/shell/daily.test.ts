import { describe, expect, it } from "vitest";

import { DailyView, fetchDaily } from "./daily.svelte.js";

const weekly = { folder: "Weekly", format: "%G-W%V.md", notes: [] };
const monthly = { folder: "Monthly", format: "%Y-%m.md", notes: [] };

function response(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 503,
    headers: { "content-type": "application/json" },
  });
}

describe("daily metadata", () => {
  it("validates and sorts the permission-filtered route response", async () => {
    const load: typeof globalThis.fetch = async (input): Promise<Response> => {
      expect(String(input)).toBe("/api/v1/vaults/my%20vault/daily");
      return response({
        folder: "Daily",
        format: "%Y-%m-%d.md",
        notes: [
          { date: "2026-09-08", path: "Daily/2026-09-08.md" },
          { date: "2026-09-01", path: "Daily/2026-09-01.md" },
        ],
        weekly,
        monthly,
      });
    };

    await expect(fetchDaily("my vault", load)).resolves.toEqual({
      folder: "Daily",
      format: "%Y-%m-%d.md",
      notes: [
        { date: "2026-09-01", path: "Daily/2026-09-01.md" },
        { date: "2026-09-08", path: "Daily/2026-09-08.md" },
      ],
      weekly,
      monthly,
    });
  });

  it("marks a failed route unavailable without retaining old dates", async () => {
    const view = new DailyView({
      vault: "personal",
      load: async () => { throw new Error("offline"); },
    });
    await view.refresh();
    expect(view.unavailable).toBe(true);
    expect(view.notes).toEqual([]);
  });

  it("navigates to the nearest existing note across gaps", async () => {
    const view = new DailyView({
      vault: "personal",
      load: async () => ({
        folder: "Daily",
        format: "%Y-%m-%d.md",
        notes: [
          { date: "2026-09-01", path: "Daily/2026-09-01.md" },
          { date: "2026-09-08", path: "Daily/2026-09-08.md" },
        ],
        weekly,
        monthly,
      }),
    });
    await view.refresh();
    expect(view.neighbour("2026-09-05", -1)?.path).toBe("Daily/2026-09-01.md");
    expect(view.neighbour("2026-09-05", 1)?.path).toBe("Daily/2026-09-08.md");
  });

  it("navigates from an existing path and refuses non-daily notes", async () => {
    const view = new DailyView({
      vault: "personal",
      load: async () => ({
        folder: "Daily",
        format: "%Y-%m-%d.md",
        notes: [
          { date: "2026-09-01", path: "Daily/2026-09-01.md" },
          { date: "2026-09-08", path: "Daily/2026-09-08.md" },
          { date: "2026-09-12", path: "Daily/2026-09-12.md" },
        ],
        weekly,
        monthly,
      }),
    });
    await view.refresh();
    expect(view.neighbourForPath("Daily/2026-09-08.md", -1)?.date).toBe("2026-09-01");
    expect(view.neighbourForPath("Daily/2026-09-08.md", 1)?.date).toBe("2026-09-12");
    expect(view.neighbourForPath("Projects/plan.md", 1)).toBeUndefined();
  });

  it("resolves existing weekly and monthly notes through shared Rust path rules", async () => {
    const view = new DailyView({
      vault: "personal",
      formatPath: async (period, folder, _format, date) => period === "weekly"
        ? `${folder}2020-W53.md`
        : `${folder}${date.slice(0, 7)}.md`,
      load: async () => ({
        folder: "Daily",
        format: "%Y-%m-%d.md",
        notes: [],
        weekly: {
          folder: "Weekly",
          format: "%G-W%V.md",
          notes: [{ date: "2020-12-28", path: "Weekly/2020-W53.md" }],
        },
        monthly: {
          folder: "Monthly",
          format: "%Y-%m.md",
          notes: [{ date: "2021-01-01", path: "Monthly/2021-01.md" }],
        },
      }),
    });
    await view.refresh();
    await expect(view.existing("weekly", "2021-01-01")).resolves.toEqual({
      date: "2020-12-28",
      path: "Weekly/2020-W53.md",
    });
    await expect(view.existing("monthly", "2021-01-31")).resolves.toEqual({
      date: "2021-01-01",
      path: "Monthly/2021-01.md",
    });
  });
});
