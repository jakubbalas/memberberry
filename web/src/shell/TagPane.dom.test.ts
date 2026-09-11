// @vitest-environment jsdom

/**
 * The tag pane in the left sidebar (`SPEC.md` §9.3, §8.2).
 *
 * `tags.test.ts` covers the tree and the keyboard as data. These cover what a reader sees:
 * the counts, what selecting a tag does, and the three states that are easy to conflate on
 * screen — a vault with no tags, a tag with no notes, and a server that would not answer.
 *
 * The pane is mounted inside `Workspace` rather than alone, because that is what the sidebar
 * layout is: a component that renders correctly in isolation and `display: none` in the shell
 * has already shipped here once (§22.6).
 */

import { mount, tick, unmount } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Workspace from "./Workspace.svelte";
import { Bookmarks } from "./bookmarks.svelte.js";
import { NoteCatalog } from "./note-catalog.svelte.js";
import type { NoteSurface, OpenNoteSurfaceOptions } from "./note-surface.js";
import type { TagCount, TaggedNotes } from "./tags.js";
import { TagView } from "./tags.svelte.js";
import { WorkspaceStore, sessionIds } from "./workspace-store.svelte.js";
import { createWorkspace } from "./workspace.js";

const openSurface = async (_options: OpenNoteSurfaceOptions): Promise<NoteSurface> => ({
  destroy: async () => undefined,
});

const COUNTS: readonly TagCount[] = [
  { tag: "Project", key: "project", notes: 2 },
  { tag: "Project/Memberberry", key: "project/memberberry", notes: 1 },
  { tag: "reading", key: "reading", notes: 1 },
];

const NOTES: TaggedNotes = {
  tag: "project",
  notes: [
    { path: "Projects/Roadmap.md", title: "The Roadmap" },
    { path: "Untitled.md", title: null },
  ],
};

let target: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  target = document.createElement("div");
  document.body.append(target);
});

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  await tick();
};

function render(
  options: {
    readonly counts?: readonly TagCount[] | undefined;
    readonly notes?: TaggedNotes | undefined;
  } = {},
) {
  const ids = sessionIds();
  const store = new WorkspaceStore({ initial: createWorkspace("personal", ids), ids });
  const loadNotes = vi.fn(async (): Promise<TaggedNotes | undefined> => options.notes);
  const tags = new TagView({
    vault: "personal",
    load: async () => options.counts,
    loadNotes,
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
      tags,
    },
  });
  return { store, tags, loadNotes, teardown: () => unmount(app) };
}

const pane = (): HTMLElement | null => target.querySelector(".tag-pane");
const rows = (): HTMLElement[] => [...target.querySelectorAll<HTMLElement>(".tag-row")];
const labels = (): string[] =>
  rows().map((row) => row.querySelector(".tree-label")?.textContent?.trim() ?? "");
const counts = (): string[] =>
  rows().map((row) => row.querySelector(".tag-count")?.textContent?.trim() ?? "");
const noteRows = (): HTMLElement[] => [
  ...target.querySelectorAll<HTMLElement>(".tree-row.is-tagged"),
];
const emptyText = (): string =>
  pane()?.querySelector(".tree-empty")?.textContent?.trim() ?? "";

describe("the tag pane", () => {
  it("shows the top level of the tree with its counts", async () => {
    const { teardown } = render({ counts: COUNTS });
    try {
      await flush();
      expect(labels()).toEqual(["Project", "reading"]);
      expect(counts()).toEqual(["2", "1"]);
    } finally {
      teardown();
    }
  });

  it("reveals a nested tag when its twisty is used", async () => {
    const { teardown } = render({ counts: COUNTS });
    try {
      await flush();
      const twisty = target.querySelector<HTMLElement>(".tag-twisty");
      expect(twisty?.getAttribute("aria-expanded")).toBe("false");
      twisty?.click();
      await tick();
      expect(labels()).toEqual(["Project", "Memberberry", "reading"]);
    } finally {
      teardown();
    }
  });

  it("gives a leaf no twisty to press", async () => {
    const { teardown } = render({ counts: COUNTS });
    try {
      await flush();
      const controls = [...target.querySelectorAll(".tag-twisty")].filter(
        (element) => element.tagName === "BUTTON",
      );
      expect(controls).toHaveLength(1);
    } finally {
      teardown();
    }
  });

  it("lists the notes under a tag when its row is selected", async () => {
    const { loadNotes, teardown } = render({ counts: COUNTS, notes: NOTES });
    try {
      await flush();
      rows()[0]?.click();
      await flush();
      expect(loadNotes).toHaveBeenCalledWith("personal", "project");
      // The row's text is the note's name and nothing else. It used to include a `·`,
      // because the mark in front of the name was a character in the text; it is a drawn
      // icon now, so this asserts the label rather than the decoration.
      expect(noteRows().map((row) => row.textContent?.trim())).toEqual([
        "The Roadmap",
        "Untitled",
      ]);
    } finally {
      teardown();
    }
  });

  it("opens a note when its row is activated", async () => {
    const { store, teardown } = render({ counts: COUNTS, notes: NOTES });
    try {
      await flush();
      rows()[0]?.click();
      await flush();
      noteRows()[0]?.click();
      await tick();
      expect(store.activeTab?.note).toBe("Projects/Roadmap.md");
    } finally {
      teardown();
    }
  });

  it("puts the list away when the selected tag is clicked again", async () => {
    const { teardown } = render({ counts: COUNTS, notes: NOTES });
    try {
      await flush();
      rows()[0]?.click();
      await flush();
      expect(noteRows()).toHaveLength(2);
      rows()[0]?.click();
      await flush();
      expect(noteRows()).toHaveLength(0);
    } finally {
      teardown();
    }
  });

  it("selects a tag from the keyboard, and expands one with the arrow keys", async () => {
    // §8.4: no mouse-only feature ships. The tree is one tab stop, so selection has to come
    // off the container's own key handling.
    const { loadNotes, teardown } = render({ counts: COUNTS, notes: NOTES });
    try {
      await flush();
      const tree = target.querySelector<HTMLElement>(".tag-tree");
      expect(tree?.getAttribute("tabindex")).toBe("0");
      tree?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
      await tick();
      expect(labels()).toEqual(["Project", "Memberberry", "reading"]);
      tree?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await flush();
      expect(loadNotes).toHaveBeenCalledWith("personal", "project");
      expect(noteRows()).toHaveLength(2);
    } finally {
      teardown();
    }
  });

  it("marks the selected row for a screen reader as well as for the eye", async () => {
    const { teardown } = render({ counts: COUNTS, notes: NOTES });
    try {
      await flush();
      rows()[0]?.click();
      await flush();
      expect(rows()[0]?.getAttribute("aria-selected")).toBe("true");
      expect(rows()[1]?.getAttribute("aria-selected")).toBe("false");
    } finally {
      teardown();
    }
  });

  it("says a tag has no notes without claiming the server refused", async () => {
    const { teardown } = render({
      counts: COUNTS,
      notes: { tag: "project", notes: [] },
    });
    try {
      await flush();
      rows()[0]?.click();
      await flush();
      expect(pane()?.textContent).toContain("No notes carry this tag.");
    } finally {
      teardown();
    }
  });

  it("says the notes are unavailable when the server would not answer", async () => {
    const { teardown } = render({ counts: COUNTS, notes: undefined });
    try {
      await flush();
      rows()[0]?.click();
      await flush();
      expect(pane()?.textContent).toContain("Notes for this tag are unavailable.");
    } finally {
      teardown();
    }
  });

  it("distinguishes a vault with no tags from one that would not say", async () => {
    // The two are one state on screen in every implementation that forgets them, and
    // reporting a refusal as "no tags" is a claim nobody checked.
    const withNone = render({ counts: [] });
    try {
      await flush();
      expect(emptyText()).toBe("No tags in the notes you can read.");
    } finally {
      withNone.teardown();
    }

    document.body.innerHTML = "";
    target = document.createElement("div");
    document.body.append(target);

    const refused = render({ counts: undefined });
    try {
      await flush();
      expect(emptyText()).toBe("Tags are unavailable for this vault.");
      expect(rows()).toHaveLength(0);
    } finally {
      refused.teardown();
    }
  });

  it("fetches the tree once, however often the pane re-renders", async () => {
    const load = vi.fn(async (): Promise<readonly TagCount[]> => COUNTS);
    const view = new TagView({ vault: "personal", load, loadNotes: async () => NOTES });
    view.ensure();
    view.ensure();
    await flush();
    view.ensure();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not let a late answer land under a tag that is no longer selected", async () => {
    // Two selections in flight at once: the first is slower, and without the guard its notes
    // appear under the second tag as if they carried it.
    const answers = new Map<string, TaggedNotes>([
      ["project", { tag: "project", notes: [{ path: "Slow.md", title: "Slow" }] }],
      ["reading", { tag: "reading", notes: [{ path: "Fast.md", title: "Fast" }] }],
    ]);
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const view = new TagView({
      vault: "personal",
      load: async () => COUNTS,
      loadNotes: async (_vault, key) => {
        if (key === "project") await held;
        return answers.get(key);
      },
    });

    view.select("project");
    view.select("reading");
    await flush();
    expect(view.notes.map((note) => note.path)).toEqual(["Fast.md"]);

    release?.();
    await flush();
    expect(view.notes.map((note) => note.path)).toEqual(["Fast.md"]);
    expect(view.selected).toBe("reading");
  });
});
