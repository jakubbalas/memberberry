import { describe, expect, it } from "vitest";

import {
  EMPTY_INBOX_FILTERS,
  endOfIsoWeek,
  fetchInboxTasks,
  groupInboxTasks,
  inboxQuery,
  inboxSourceLabel,
  readInboxTasks,
  taskGroupId,
} from "./tasks.js";
import { InboxView } from "./tasks.svelte.js";

const TASK = {
  path: "Inbox/Due.md",
  title: "Due",
  block_id: "ship",
  text: "Ship it",
  due: "2026-09-10",
  scheduled: null,
  start: null,
  created: "2026-09-01",
  priority: "high",
  ordinal: 0,
};

describe("inbox response validation", () => {
  it("accepts a complete task row and drops malformed ones", () => {
    const tasks = readInboxTasks({
      tasks: [
        TASK,
        { ...TASK, path: "" },
        { ...TASK, priority: "urgent" },
        { ...TASK, ordinal: -1 },
        { path: "A.md", text: "ok", ordinal: 1, title: null, block_id: null, due: null, scheduled: null, start: null, created: null, priority: null },
      ],
    });
    expect(tasks).toEqual([
      {
        path: "Inbox/Due.md",
        title: "Due",
        blockId: "ship",
        text: "Ship it",
        due: "2026-09-10",
        scheduled: null,
        start: null,
        created: "2026-09-01",
        priority: "high",
        ordinal: 0,
      },
      {
        path: "A.md",
        title: null,
        blockId: null,
        text: "ok",
        due: null,
        scheduled: null,
        start: null,
        created: null,
        priority: null,
        ordinal: 1,
      },
    ]);
  });

  it("refuses a body that is not a task list", () => {
    expect(readInboxTasks({})).toBeUndefined();
    expect(readInboxTasks({ tasks: "nope" })).toBeUndefined();
  });
});

describe("inbox query building", () => {
  it("omits empty filters and the default sort", () => {
    expect(inboxQuery(EMPTY_INBOX_FILTERS)).toBe("");
    expect(
      inboxQuery({
        folder: " Inbox ",
        tag: "#work",
        priority: "high",
        dueFrom: "2026-09-01",
        dueTo: "2026-09-30",
        note: "Inbox/Due.md",
        sort: "priority",
      }),
    ).toBe(
      "folder=Inbox&tag=%23work&priority=high&due_from=2026-09-01&due_to=2026-09-30&note=Inbox%2FDue.md&sort=priority",
    );
  });
});

describe("grouping", () => {
  it("places tasks into overdue / today / this week / later / no date", () => {
    // Tuesday 2026-09-08: ISO week ends Sunday 2026-09-13.
    expect(endOfIsoWeek("2026-09-08")).toBe("2026-09-13");
    expect(taskGroupId("2026-09-01", "2026-09-08")).toBe("overdue");
    expect(taskGroupId("2026-09-08", "2026-09-08")).toBe("today");
    expect(taskGroupId("2026-09-13", "2026-09-08")).toBe("this_week");
    expect(taskGroupId("2026-09-14", "2026-09-08")).toBe("later");
    expect(taskGroupId(null, "2026-09-08")).toBe("no_date");

    const groups = groupInboxTasks(
      [
        task({ path: "A.md", text: "late", due: "2026-09-01" }),
        task({ path: "B.md", text: "now", due: "2026-09-08" }),
        task({ path: "C.md", text: "soon", due: "2026-09-10" }),
        task({ path: "D.md", text: "far", due: "2026-10-01" }),
        task({ path: "E.md", text: "undated", due: null }),
      ],
      "2026-09-08",
    );
    expect(groups.map((group) => [group.id, group.tasks.map((row) => row.text)])).toEqual([
      ["overdue", ["late"]],
      ["today", ["now"]],
      ["this_week", ["soon"]],
      ["later", ["far"]],
      ["no_date", ["undated"]],
    ]);
  });

  it("drops empty groups and keeps the server's order inside a group", () => {
    const groups = groupInboxTasks(
      [
        task({ path: "Second.md", text: "second", due: "2026-09-20", ordinal: 1 }),
        task({ path: "First.md", text: "first", due: "2026-09-15", ordinal: 0 }),
      ],
      "2026-09-08",
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.id).toBe("later");
    expect(groups[0]?.tasks.map((row) => row.text)).toEqual(["second", "first"]);
  });
});

describe("fetchInboxTasks", () => {
  it("asks the route with the filter query and validates the answer", async () => {
    const tasks = await fetchInboxTasks(
      "personal",
      { ...EMPTY_INBOX_FILTERS, folder: "Inbox", sort: "path" },
      {
        fetch: async (url) => {
          expect(String(url)).toBe("/api/v1/vaults/personal/tasks?folder=Inbox&sort=path");
          return new Response(JSON.stringify({ tasks: [TASK] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
    );
    expect(tasks).toHaveLength(1);
    expect(tasks?.[0]?.text).toBe("Ship it");
  });

  it("treats a refused or broken answer as unavailable, not empty", async () => {
    await expect(
      fetchInboxTasks("personal", EMPTY_INBOX_FILTERS, {
        fetch: async () => new Response("{}", { status: 403 }),
      }),
    ).resolves.toBeUndefined();
    await expect(
      fetchInboxTasks("personal", EMPTY_INBOX_FILTERS, {
        fetch: async () => {
          throw new Error("offline");
        },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("InboxView", () => {
  it("loads once, groups, and reloads when a filter changes", async () => {
    const calls: string[] = [];
    const view = new InboxView({
      vault: "personal",
      today: () => "2026-09-08",
      load: async (_vault, filters) => {
        calls.push(filters.folder);
        return [task({ path: "Inbox/A.md", text: "late", due: "2026-09-01" })];
      },
    });
    view.ensure();
    view.ensure();
    await flush();
    expect(calls).toEqual([""]);
    expect(view.groups[0]?.id).toBe("overdue");

    view.setFilter("folder", "Inbox");
    await flush();
    expect(calls).toEqual(["", "Inbox"]);
  });

  it("does not let a stale response overwrite a newer filter set", async () => {
    let releaseFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const view = new InboxView({
      vault: "personal",
      today: () => "2026-09-08",
      load: async (_vault, filters) => {
        if (filters.folder === "") {
          await first;
          return [task({ path: "Old.md", text: "old", due: null })];
        }
        return [task({ path: "New.md", text: "new", due: null })];
      },
    });
    view.ensure();
    view.setFilter("folder", "Inbox");
    await flush();
    expect(view.tasks.map((row) => row.text)).toEqual(["new"]);
    releaseFirst?.();
    await flush();
    expect(view.tasks.map((row) => row.text)).toEqual(["new"]);
  });

  it("keeps empty and unavailable apart", async () => {
    const empty = new InboxView({
      vault: "personal",
      load: async () => [],
    });
    empty.ensure();
    await flush();
    expect(empty.empty).toBe(true);
    expect(empty.unavailable).toBe(false);

    const denied = new InboxView({
      vault: "personal",
      load: async () => undefined,
    });
    denied.ensure();
    await flush();
    expect(denied.empty).toBe(false);
    expect(denied.unavailable).toBe(true);
  });

  it("uses replicated task metadata when the route is unreachable", async () => {
    const view = new InboxView({
      vault: "personal",
      today: () => "2026-09-08",
      load: async () => undefined,
      offline: async () => [task({ path: "Inbox.md", text: "Cached", due: null })],
    });
    view.ensure();
    await flush();
    expect(view.unavailable).toBe(false);
    expect(view.tasks.map((row) => row.text)).toEqual(["Cached"]);
  });
});

describe("inboxSourceLabel", () => {
  it("prefers the title and falls back to the filename stem", () => {
    expect(inboxSourceLabel(task({ path: "A.md", title: "Named", text: "x" }))).toBe("Named");
    expect(inboxSourceLabel(task({ path: "Folder/Bare.md", title: null, text: "x" }))).toBe("Bare");
  });
});

function task(
  partial: Partial<ReturnType<typeof readRequired>> & { path: string; text: string },
): ReturnType<typeof readRequired> {
  return {
    path: partial.path,
    title: partial.title ?? null,
    blockId: partial.blockId ?? null,
    text: partial.text,
    due: partial.due === undefined ? null : partial.due,
    scheduled: partial.scheduled ?? null,
    start: partial.start ?? null,
    created: partial.created ?? null,
    priority: partial.priority ?? null,
    ordinal: partial.ordinal ?? 0,
  };
}

function readRequired() {
  const tasks = readInboxTasks({ tasks: [TASK] });
  if (tasks === undefined || tasks[0] === undefined) throw new Error("fixture");
  return tasks[0];
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
