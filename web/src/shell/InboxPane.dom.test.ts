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
      mode: "desktop" as const,
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

  it("edits the source task through toggle, due, and priority controls", async () => {
    const { teardown } = render({ tasks: TASKS });
    try {
      await flush();
      const row = target.querySelector<HTMLElement>('.inbox-task-row[data-path="Inbox/Old.md"]');
      expect(row).not.toBeNull();
      row?.querySelector<HTMLButtonElement>(".inbox-task-action")?.click();
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
        { path: "Inbox/Old.md", ordinal: 0, action: { kind: "toggle" } },
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
