// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { describe, expect, it } from "vitest";

import CalendarPane from "./CalendarPane.svelte";
import { DailyView } from "./daily.svelte.js";

describe("calendar pane", () => {
  it("shows readable dates and opens the selected note", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const opened: string[] = [];
    const calendarDate = new Date();
    const date = `${calendarDate.getFullYear()}-${String(calendarDate.getMonth() + 1).padStart(2, "0")}-08`;
    const view = new DailyView({
      vault: "personal",
      load: async () => ({
        folder: "Daily",
        format: "%Y-%m-%d.md",
        notes: [{ date, path: "Daily/08.md" }],
        weekly: { folder: "Weekly", format: "%G-W%V.md", notes: [] },
        monthly: { folder: "Monthly", format: "%Y-%m.md", notes: [] },
      }),
    });
    const app = mount(CalendarPane, {
      target,
      props: { view, onopen: (path: string) => opened.push(path) },
    });
    try {
      await tick();
      await tick();
      const day = target.querySelector<HTMLButtonElement>(".calendar-day.has-note");
      expect(day?.getAttribute("aria-label")).toBe(date);
      day?.click();
      expect(opened).toEqual(["Daily/08.md"]);
    } finally {
      unmount(app);
      target.remove();
    }
  });
});
