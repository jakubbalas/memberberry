// @vitest-environment jsdom

/**
 * The task inbox in the left sidebar (`SPEC.md` §10.3, §8.2).
 *
 * Mounted inside `Workspace` rather than alone: a panel that renders correctly in isolation
 * and `display: none` in the shell has already shipped here once (§22.6).
 */

import { mount, tick, unmount } from "svelte";
import { beforeEach, describe, expect, it } from "vitest";

import Workspace from "./Workspace.svelte";
import { Bookmarks } from "./bookmarks.svelte.js";
import { NoteCatalog } from "./note-catalog.svelte.js";
import type { NoteSurface, OpenNoteSurfaceOptions, TaskEditAction } from "./note-surface.js";
import type { InboxTask } from "./tasks.js";
import { InboxView } from "./tasks.svelte.js";
import { TagView } from "./tags.svelte.js";
import { WorkspaceStore, sessionIds } from "./workspace-store.svelte.js";
import { createWorkspace } from "./workspace.js";

const edits: { path: string; ordinal: number; action: TaskEditAction }[] = [];

const openSurface = async (options: OpenNoteSurfaceOptions): Promise<NoteSurface> => ({
  destroy: async () => undefined,
  editTask: (ordinal, action) => {
    edits.push({ path: options.bootstrap?.note ?? "", ordinal, action });
    return true;
  },
});

const TASKS: readonly InboxTask[] = [
  {
    path: "Inbox/Old.md",
    title: "Old",
    blockId: "late",
    text: "Was due last month",
    due: "2026-08-01",
    scheduled: null,
    start: null,
    created: null,
    priority: "high",
    ordinal: 0,
  },
  {
    path: "Inbox/Soon.md",
    title: "Soon",
    blockId: null,
    text: "No date yet",
    due: null,
    scheduled: null,
    start: null,
    created: null,
    priority: null,
    ordinal: 0,
  },
];

let target: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  edits.length = 0;
  target = document.createElement("div");
  document.body.append(target);
});

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  await tick();
};

function render(
  options: {
    readonly tasks?: readonly InboxTask[] | undefined;
    readonly mode?: "desktop" | "mobile";
  } = {},
) {
  const ids = sessionIds();
  const store = new WorkspaceStore({ initial: createWorkspace("personal", ids), ids });
  const inbox = new InboxView({
    vault: "personal",
    today: () => "2026-09-08",
    load: async () => options.tasks,
  });
  const app = mount(Workspace, {
    target,
    props: {
      store,
      session: { vault: "personal", user: "alice" },
      chrome: { getItem: () => null, setItem: () => undefined },
      open: openSurface,
      target: new EventTarget(),
      platform: "mac" as const,
      mode: options.mode ?? "desktop",
      catalog: new NoteCatalog({
        vault: "personal",
        load: async () => ({ kind: "ok", notes: [] }),
        replica: async () => undefined,
      }),
      bookmarks: new Bookmarks({
        vault: "personal",
        fetch: (async () => new Response("[]")) as unknown as typeof globalThis.fetch,
      }),
      tags: new TagView({ vault: "personal", load: async () => [] }),
      inbox,
    },
  });
  return { store, inbox, teardown: () => unmount(app) };
}

const pane = (): HTMLElement | null => target.querySelector(".inbox-panel");

async function taskMenu(): Promise<HTMLElement> {
  const trigger = target.querySelector<HTMLButtonElement>('#navigation-tasks button[aria-label="Task options"]');
  expect(trigger).not.toBeNull();
  trigger?.click();
  await flush();
  const menu = target.querySelector<HTMLElement>('[role="menu"][aria-label="Task options"]');
  if (menu === null) throw new Error("Task options menu missing");
  return menu;
}

function item(menu: HTMLElement, name: string): HTMLButtonElement {
  const button = [...menu.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === name);
  if (button === undefined) throw new Error(`Missing menu item: ${name}`);
  return button;
}

it.each(["Escape", "trigger"] as const)("restores the task-menu trigger after activation without native focus (%s)", async (dismiss) => {
  const { teardown } = render({ tasks: TASKS });
  try {
    await flush();
    target.querySelector<HTMLButtonElement>('button[aria-label="Tasks"]')?.click();
    await flush();
    const elsewhere = target.querySelector<HTMLButtonElement>('button[aria-label="Notes"]');
    elsewhere?.focus();
    const trigger = target.querySelector<HTMLButtonElement>('#navigation-tasks button[aria-label="Task options"]');
    if (trigger === null) throw new Error("missing task-menu trigger");
    // jsdom click() intentionally does not perform native pointer focus.
    trigger.click();
    await flush();
    expect(target.querySelector('[role="menu"][aria-label="Task options"]')).not.toBeNull();
    if (dismiss === "Escape") window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    else {
      trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      await flush();
      trigger.click();
    }
    await flush();
    expect(target.querySelector('[role="menu"][aria-label="Task options"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  } finally { await teardown(); }
});

it("places a labelled completion checkbox before the task text instead of Toggle", async () => {
  const { teardown } = render({ tasks: TASKS });
  try {
    await flush();
    const row = target.querySelector<HTMLElement>('.inbox-task-row[data-path="Inbox/Old.md"]');
    const checkbox = row?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).toBeTruthy();
    expect(checkbox?.getAttribute("aria-label")).toBe("Complete task: Was due last month");
    expect(row?.firstElementChild?.contains(checkbox ?? null)).toBe(true);
    checkbox?.click();
    await flush();
    expect(edits).toEqual([{ path: "Inbox/Old.md", ordinal: 0, action: { kind: "complete" } }]);
  } finally { await teardown(); }
});

it("independently changes task source filenames and full paths from its menu", async () => {
  const { teardown } = render({ tasks: TASKS });
  try {
    await flush();
    expect(target.querySelector(".inbox-task-source")?.textContent).toBe("Old");
    expect(target.querySelector(".inbox-task-path")).toBeNull();
    item(await taskMenu(), "Show filenames").click();
    await flush();
    expect(target.querySelector(".inbox-task-source")?.textContent).toBe("Old.md");
    item(await taskMenu(), "Show file paths").click();
    await flush();
    expect(target.querySelector(".inbox-task-path")?.textContent).toBe("Inbox/Old.md");
    item(await taskMenu(), "Show filenames").click();
    await flush();
    expect(target.querySelector(".inbox-task-source")?.textContent).toBe("Old");
    expect(target.querySelector(".inbox-task-path")?.textContent).toBe("Inbox/Old.md");
  } finally { await teardown(); }
});

it("opens tasks in the main panel without creating a tab and retains shared filters", async () => {
  const { store, inbox, teardown } = render({ tasks: TASKS });
  try {
    await flush();
    inbox.setFilter("sort", "path");
    await flush();
    item(await taskMenu(), "Open in main panel").click();
    await flush();
    const main = target.querySelector<HTMLElement>("main .inbox-main");
    expect(main).not.toBeNull();
    expect(main?.querySelector<HTMLSelectElement>('[aria-label="Sort tasks"]')?.value).toBe("path");
    expect(store.tabs).toEqual([]);
    const ids = [...target.querySelectorAll<HTMLElement>("[id]")].map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    main?.querySelector<HTMLButtonElement>('.inbox-task[data-path="Inbox/Soon.md"]')?.click();
    await flush();
    expect(target.querySelector("main .inbox-main")).toBeNull();
    expect(store.activeTab?.note).toBe("Inbox/Soon.md");
  } finally { await teardown(); }
});

it.each(["desktop", "mobile"] as const)("closes the main tasks view without losing note tabs or keyboard focus (%s)", async (mode) => {
  const { store, teardown } = render({ tasks: TASKS, mode });
  try {
    store.open("Inbox/Old.md");
    await flush();
    const tabs = store.tabs.map((tab) => tab.note);
    target.querySelector<HTMLButtonElement>('button[aria-label="Tasks"]')?.click();
    await flush();
    item(await taskMenu(), "Open in main panel").click();
    await flush();
    expect(document.activeElement?.id).toBe("main-inbox-heading");
    if (mode === "mobile") expect(target.querySelector<HTMLElement>("#sidebar-left")?.hidden).toBe(true);
    target.querySelector<HTMLButtonElement>('button[aria-label="Close tasks main panel"]')?.click();
    await flush();
    expect(target.querySelector(".inbox-main")).toBeNull();
    expect(store.tabs.map((tab) => tab.note)).toEqual(tabs);
    expect(document.activeElement?.getAttribute("aria-label")).toBe(mode === "mobile" ? "Show Navigation" : "Task options");
  } finally { await teardown(); }
});

it("restores focus to visible navigation controls if the sidebar changed views", async () => {
  const { teardown } = render({ tasks: TASKS });
  try {
    await flush();
    target.querySelector<HTMLButtonElement>('button[aria-label="Tasks"]')?.click();
    await flush();
    item(await taskMenu(), "Open in main panel").click();
    await flush();
    target.querySelector<HTMLButtonElement>('button[aria-label="Notes"]')?.click();
    await flush();
    target.querySelector<HTMLButtonElement>('button[aria-label="Close tasks main panel"]')?.click();
    await flush();
    expect(document.activeElement?.getAttribute("aria-controls")).toBe("sidebar-left");
  } finally { await teardown(); }
});

it("shows no note metadata in an unavailable main inbox", async () => {
  const { teardown } = render();
  try {
    await flush();
    item(await taskMenu(), "Open in main panel").click();
    await flush();
    const main = target.querySelector<HTMLElement>(".inbox-main");
    expect(main?.textContent).toContain("Tasks are unavailable for this vault.");
    expect(main?.querySelector(".inbox-task-row")).toBeNull();
  } finally { await teardown(); }
});

it("applies a task completion from the main panel and restores the source editor", async () => {
  const { store, teardown } = render({ tasks: TASKS });
  try {
    await flush();
    item(await taskMenu(), "Open in main panel").click();
    await flush();
    target.querySelector<HTMLInputElement>('main .inbox-task-row[data-path="Inbox/Old.md"] input[type="checkbox"]')?.click();
    await flush();
    expect(target.querySelector("main .inbox-main")).toBeNull();
    expect(store.activeTab?.note).toBe("Inbox/Old.md");
    expect(edits).toEqual([{ path: "Inbox/Old.md", ordinal: 0, action: { kind: "complete" } }]);
  } finally { await teardown(); }
});

describe("the inbox pane", () => {
  it("groups open tasks and opens the source note from a row", async () => {
    const { store, teardown } = render({ tasks: TASKS });
    try {
      await flush();
      expect(pane()).not.toBeNull();
      const overdue = target.querySelector('.inbox-group[data-group="overdue"]');
      const undated = target.querySelector('.inbox-group[data-group="no_date"]');
      expect(overdue?.textContent).toContain("Was due last month");
      expect(undated?.textContent).toContain("No date yet");
      // Assert on the row itself: the heading gives the pane height even when the list is hidden.
      const row = target.querySelector<HTMLButtonElement>('.inbox-task[data-path="Inbox/Old.md"]');
      expect(row).not.toBeNull();
      row?.click();
      await flush();
      expect(store.activeTab?.note).toBe("Inbox/Old.md");
    } finally {
      teardown();
    }
  });

  it("edits the source task through completion, due, and priority controls", async () => {
    const { teardown } = render({ tasks: TASKS });
    try {
      await flush();
      const row = target.querySelector<HTMLElement>('.inbox-task-row[data-path="Inbox/Old.md"]');
      expect(row).not.toBeNull();
      row?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
      await flush();
      const date = row?.querySelector<HTMLInputElement>(".inbox-task-date");
      if (date === null || date === undefined) throw new Error("date control missing");
      date.value = "2026-09-12";
      date.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
      const priority = row?.querySelector<HTMLSelectElement>("select.inbox-task-priority");
      if (priority === null || priority === undefined) throw new Error("priority control missing");
      priority.value = "highest";
      priority.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
      expect(edits).toEqual([
        { path: "Inbox/Old.md", ordinal: 0, action: { kind: "complete" } },
        { path: "Inbox/Old.md", ordinal: 0, action: { kind: "due", value: "2026-09-12" } },
        { path: "Inbox/Old.md", ordinal: 0, action: { kind: "priority", value: "highest" } },
      ]);
    } finally {
      teardown();
    }
  });

  it("keeps empty and unavailable apart", async () => {
    const empty = render({ tasks: [] });
    try {
      await flush();
      expect(pane()?.textContent).toContain("No open tasks");
    } finally {
      empty.teardown();
    }

    const denied = render({ tasks: undefined });
    try {
      await flush();
      expect(pane()?.textContent).toContain("unavailable");
      expect(pane()?.textContent).not.toContain("No open tasks");
    } finally {
      denied.teardown();
    }
  });

  it("exposes filters and sort as labelled controls", async () => {
    const { inbox, teardown } = render({ tasks: TASKS });
    try {
      await flush();
      const sort = target.querySelector<HTMLSelectElement>('select[aria-label="Sort tasks"]');
      expect(sort).not.toBeNull();
      if (sort) {
        sort.value = "path";
        sort.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await flush();
      expect(inbox.filters.sort).toBe("path");

      target.querySelector<HTMLButtonElement>(".inbox-filters-toggle")?.click();
      await flush();
      expect(target.querySelector("#inbox-filters")).not.toBeNull();
      const folder = target.querySelector<HTMLInputElement>('input[aria-label="Filter by folder"]');
      expect(folder).not.toBeNull();
      if (folder) {
        folder.value = "Inbox";
        folder.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await flush();
      expect(inbox.filters.folder).toBe("Inbox");
    } finally {
      teardown();
    }
  });
});
