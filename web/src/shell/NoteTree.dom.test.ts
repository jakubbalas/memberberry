// @vitest-environment jsdom

/**
 * The note tree, bookmarks and breadcrumbs (`SPEC.md` §8.2).
 *
 * `tree.ts` already covers what a keypress *means*; these cover that the component routes it,
 * and the accessibility structure that makes the tree usable at all — one tab stop, roles,
 * levels, and a keyboard cursor that is visibly a different thing from the open note.
 */

import { mount, tick, unmount } from "svelte";
import { beforeEach, describe, expect, it } from "vitest";

import Workspace from "./Workspace.svelte";
import { Bookmarks } from "./bookmarks.svelte.js";
import type { NoteSummary } from "./catalog.js";
import { NoteCatalog } from "./note-catalog.svelte.js";
import type { NoteSurface, OpenNoteSurfaceOptions } from "./note-surface.js";
import { WorkspaceStore, sessionIds } from "./workspace-store.svelte.js";
import { createWorkspace } from "./workspace.js";

const NOTES: readonly NoteSummary[] = [
  { path: "Welcome.md", title: "Welcome" },
  { path: "Projects/Roadmap.md", title: "Product roadmap" },
  { path: "Projects/Sprint.md", title: null },
  { path: "Archive/2019/Old.md", title: null },
];

const openSurface = async (_options: OpenNoteSurfaceOptions): Promise<NoteSurface> => ({
  destroy: async () => undefined,
});

/** A `fetch` for the bookmark endpoint that records what was written. */
function bookmarkServer(initial: readonly string[] = []) {
  let stored = [...initial];
  const writes: string[][] = [];
  const fetch = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (init?.method === "PUT") {
      const paths = JSON.parse(String(init.body)) as string[];
      writes.push(paths);
      stored = paths;
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify(stored));
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, writes };
}

let target: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  target = document.createElement("div");
  document.body.append(target);
});

/**
 * Lets the catalog and bookmark fetches settle, then lets Svelte render.
 *
 * why: a fixed pair of microtasks is not enough. Each fetch resolves a `Response` and then
 * `response.json()`, which is several turns, and a test that guesses the number reads a frame
 * from before the data arrived — as three of these did.
 */
const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  await tick();
};

function render(
  options: { notes?: readonly NoteSummary[]; bookmarked?: readonly string[]; open?: string[] } = {},
) {
  const ids = sessionIds();
  const store = new WorkspaceStore({ initial: createWorkspace("personal", ids), ids });
  for (const note of options.open ?? []) store.open(note);

  const server = bookmarkServer(options.bookmarked ?? []);
  const catalog = new NoteCatalog({
    vault: "personal",
    load: async () => ({ kind: "ok", notes: options.notes ?? NOTES }),
    // No replica: these tests are about the tree, and one that reconciled a real IndexedDB
    // would be testing §7.2 by accident (`note-catalog.test.ts` tests it on purpose).
    replica: async () => undefined,
  });
  const bookmarks = new Bookmarks({
    vault: "personal",
    fetch: server.fetch,
    // Immediate, so a test asserts on the write rather than on a timer.
    setTimer: (run) => {
      run();
      return 0;
    },
    clearTimer: () => undefined,
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
      catalog,
      bookmarks,
    },
  });
  return { store, bookmarks, server, teardown: () => unmount(app) };
}

const tree = (): HTMLElement | null => target.querySelector('[role="tree"]');
const rows = (): HTMLElement[] => [...target.querySelectorAll<HTMLElement>('[role="treeitem"]')];
const names = (): string[] =>
  rows().map((row) => row.querySelector(".tree-label")?.textContent?.trim() ?? "");

async function press(key: string): Promise<void> {
  tree()?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  await tick();
}

describe("the tree", () => {
  it("renders the top level, collapsed, with folders first", async () => {
    const { teardown } = render();
    try {
      await flush();
      expect(names()).toEqual(["Archive", "Projects", "Welcome"]);
    } finally {
      teardown();
    }
  });

  it("shows a note's title rather than its filename when it has one", async () => {
    const { teardown } = render();
    try {
      await flush();
      await press("ArrowDown");
      await press("ArrowRight");
      // `Projects/Roadmap.md` is titled "Product roadmap"; `Sprint.md` has no title.
      expect(names()).toContain("Product roadmap");
      expect(names()).toContain("Sprint");
    } finally {
      teardown();
    }
  });

  it("says so when there is nothing readable, rather than rendering an empty box", async () => {
    // Which is also what a member with no note-level access sees, and it must not read as a
    // broken sidebar.
    const { teardown } = render({ notes: [] });
    try {
      await flush();
      expect(target.querySelector(".tree-empty")?.textContent).toContain("no notes you can read");
    } finally {
      teardown();
    }
  });

  it("opens a note when it is clicked", async () => {
    const { store, teardown } = render();
    try {
      await flush();
      rows().find((row) => row.textContent?.includes("Welcome"))?.click();
      await tick();
      expect(store.activeTab?.note).toBe("Welcome.md");
    } finally {
      teardown();
    }
  });

  it("expands and collapses a folder when it is clicked", async () => {
    const { teardown } = render();
    try {
      await flush();
      const projects = rows().find((row) => row.textContent?.includes("Projects"));
      projects?.click();
      await tick();
      expect(names()).toContain("Sprint");

      rows().find((row) => row.textContent?.includes("Projects"))?.click();
      await tick();
      expect(names()).not.toContain("Sprint");
    } finally {
      teardown();
    }
  });

  it("marks the note showing in the focused pane", async () => {
    // A different thing from the keyboard cursor, and it has to look like one: the cursor is
    // where you are about to act, the marker is what you are already reading.
    const { teardown } = render({ open: ["Welcome.md"] });
    try {
      await flush();
      const current = rows().filter((row) => row.getAttribute("data-current") === "true");
      expect(current).toHaveLength(1);
      expect(current[0]?.textContent).toContain("Welcome");
    } finally {
      teardown();
    }
  });
});

describe("the tree's accessibility structure", () => {
  it("is one tab stop, not one per row", async () => {
    // A list where Tab walks through four hundred notes is not navigable by anyone.
    const { teardown } = render();
    try {
      await flush();
      expect(tree()?.getAttribute("tabindex")).toBe("0");
      expect(rows().every((row) => row.getAttribute("tabindex") === "-1")).toBe(true);
    } finally {
      teardown();
    }
  });

  it("names the current row with aria-activedescendant", async () => {
    const { teardown } = render();
    try {
      await flush();
      expect(tree()?.getAttribute("aria-activedescendant")).toBe(rows()[0]?.id);
      await press("ArrowDown");
      expect(tree()?.getAttribute("aria-activedescendant")).toBe(rows()[1]?.id);
    } finally {
      teardown();
    }
  });

  it("reports nesting depth and whether a folder is open", async () => {
    const { teardown } = render();
    try {
      await flush();
      const projects = rows().find((row) => row.textContent?.includes("Projects"));
      expect(projects?.getAttribute("aria-level")).toBe("1");
      expect(projects?.getAttribute("aria-expanded")).toBe("false");

      await press("ArrowDown");
      await press("ArrowRight");
      const child = rows().find((row) => row.textContent?.includes("Sprint"));
      expect(child?.getAttribute("aria-level")).toBe("2");
      // A note is not expandable, and must not claim to be.
      expect(child?.hasAttribute("aria-expanded")).toBe(false);
    } finally {
      teardown();
    }
  });

  it("walks and opens from the keyboard alone", async () => {
    // §8.4: no mouse-only feature ships.
    const { store, teardown } = render();
    try {
      await flush();
      await press("End");
      expect(rows().at(-1)?.getAttribute("aria-selected")).toBe("true");
      await press("Enter");
      expect(store.activeTab?.note).toBe("Welcome.md");
    } finally {
      teardown();
    }
  });
});

describe("bookmarks", () => {
  it("are listed above the tree once there are any", async () => {
    const { teardown } = render({ bookmarked: ["Projects/Roadmap.md"] });
    try {
      await flush();
      expect(target.querySelector("#bookmarks-heading")).not.toBeNull();
      expect(target.querySelector(".bookmark-list")?.textContent).toContain("Product roadmap");
    } finally {
      teardown();
    }
  });

  it("are hidden entirely when there are none, rather than showing an empty heading", async () => {
    const { teardown } = render();
    try {
      await flush();
      expect(target.querySelector("#bookmarks-heading")).toBeNull();
    } finally {
      teardown();
    }
  });

  it("toggle from the star, and write the new list", async () => {
    const { bookmarks, server, teardown } = render();
    try {
      await flush();
      const star = target.querySelector<HTMLButtonElement>(".tree-bookmark");
      expect(star?.getAttribute("aria-pressed")).toBe("false");

      star?.click();
      await flush();
      expect(bookmarks.paths).toHaveLength(1);
      expect(server.writes.at(-1)).toEqual(bookmarks.paths);
    } finally {
      teardown();
    }
  });

  it("do not also open the note when the star is clicked", async () => {
    // The star sits inside the row, so without `stopPropagation` reaching for it opens the
    // note as well — which is not what someone bookmarking meant.
    const { store, teardown } = render();
    try {
      await flush();
      target.querySelector<HTMLButtonElement>(".tree-bookmark")?.click();
      await flush();
      expect(store.tabs).toEqual([]);
    } finally {
      teardown();
    }
  });

  it("open the note when the bookmark itself is clicked", async () => {
    const { store, teardown } = render({ bookmarked: ["Projects/Roadmap.md"] });
    try {
      await flush();
      target.querySelector<HTMLButtonElement>(".bookmark-list .tree-row")?.click();
      await tick();
      expect(store.activeTab?.note).toBe("Projects/Roadmap.md");
    } finally {
      teardown();
    }
  });

  it("say what the star will do, for a reader who cannot see it", async () => {
    const { teardown } = render();
    try {
      await flush();
      // The first two rows are folders, which have no star — only a note can be bookmarked.
      const star = target.querySelector<HTMLButtonElement>(".tree-bookmark");
      expect(star?.getAttribute("aria-label")).toBe("Add bookmark for Welcome");
    } finally {
      teardown();
    }
  });
});

describe("breadcrumbs", () => {
  it("show the folders and the note's title", async () => {
    const { teardown } = render({ open: ["Projects/Roadmap.md"] });
    try {
      await flush();
      const crumbs = target.querySelector('[aria-label="Note location"]');
      expect(crumbs?.textContent).toContain("Projects");
      expect(crumbs?.textContent).toContain("Product roadmap");
    } finally {
      teardown();
    }
  });

  it("do not render at all when no note is open", async () => {
    const { teardown } = render();
    try {
      await flush();
      expect(target.querySelector('[aria-label="Note location"]')).toBeNull();
    } finally {
      teardown();
    }
  });

  it("mark the note as the current page and leave folders unlinked", async () => {
    // §4.1: folders are ordinary folders, not note containers — there is nothing to open at
    // `Projects/`, so marking one up as a link would promise something the app cannot do.
    const { teardown } = render({ open: ["Projects/Roadmap.md"] });
    try {
      await flush();
      const crumbs = target.querySelector('[aria-label="Note location"]');
      expect(crumbs?.querySelector('[aria-current="page"]')?.textContent).toBe("Product roadmap");
      expect(crumbs?.querySelectorAll("a")).toHaveLength(0);
    } finally {
      teardown();
    }
  });

  it("fall back to the filename for a note with no title", async () => {
    const { teardown } = render({ open: ["Projects/Sprint.md"] });
    try {
      await flush();
      expect(
        target.querySelector('[aria-label="Note location"] [aria-current="page"]')?.textContent,
      ).toBe("Sprint");
    } finally {
      teardown();
    }
  });
});
