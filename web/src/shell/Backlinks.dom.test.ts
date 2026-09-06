// @vitest-environment jsdom

/**
 * The backlinks panel in the right sidebar (`SPEC.md` §9.5, §8.2).
 *
 * `backlinks.test.ts` covers what the client accepts and what happens when two notes race.
 * These cover what a reader sees, and the two states that are easy to conflate on screen: a
 * note nothing links to, and a note the server would not answer for.
 */

import { mount, tick, unmount } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Workspace from "./Workspace.svelte";
import type { BacklinksResponse } from "./backlinks.js";
import { BacklinkView } from "./backlinks.svelte.js";
import { Bookmarks } from "./bookmarks.svelte.js";
import { NoteCatalog } from "./note-catalog.svelte.js";
import type { NoteSurface, OpenNoteSurfaceOptions } from "./note-surface.js";
import { WorkspaceStore, sessionIds } from "./workspace-store.svelte.js";
import { createWorkspace } from "./workspace.js";

const openSurface = async (_options: OpenNoteSurfaceOptions): Promise<NoteSurface> => ({
  destroy: async () => undefined,
});

const RESPONSE: BacklinksResponse = {
  note: "Projects/Roadmap.md",
  sources: [
    {
      path: "Q3.md",
      title: "Third quarter",
      links: [
        {
          context: "We should ship Roadmap this quarter.",
          sourceBlock: null,
          embed: false,
          anchorKind: "none",
          anchor: null,
        },
        {
          context: "Roadmap again, under a heading.",
          sourceBlock: "s2",
          embed: true,
          anchorKind: "heading",
          anchor: "Goals",
        },
      ],
    },
    {
      path: "Archive/Old.md",
      title: null,
      links: [
        {
          context: null,
          sourceBlock: null,
          embed: false,
          anchorKind: "block",
          anchor: "b1",
        },
      ],
    },
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
    readonly open?: string | undefined;
    readonly response?: BacklinksResponse | undefined;
  } = {},
) {
  const ids = sessionIds();
  const store = new WorkspaceStore({ initial: createWorkspace("personal", ids), ids });
  if (options.open !== undefined) store.open(options.open);

  const load = vi.fn(
    async (_vault: string, _note: string): Promise<BacklinksResponse | undefined> =>
      options.response,
  );
  const backlinks = new BacklinkView({ vault: "personal", load });
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
      backlinks,
    },
  });
  return { store, load, teardown: () => unmount(app) };
}

const panel = (): HTMLElement | null => target.querySelector(".backlinks-panel");
const sourceRows = (): HTMLElement[] => [
  ...target.querySelectorAll<HTMLElement>(".backlink-row"),
];
const labels = (): string[] =>
  sourceRows().map((row) => row.querySelector(".tree-label")?.textContent?.trim() ?? "");
const contexts = (): string[] =>
  [...target.querySelectorAll<HTMLElement>(".backlink-text")].map(
    (line) => line.textContent?.trim() ?? "",
  );
const empty = (): string => panel()?.querySelector(".tree-empty")?.textContent?.trim() ?? "";

describe("the backlinks panel", () => {
  it("names every note that links here, titled where there is a title", async () => {
    const { teardown } = render({ open: "Projects/Roadmap.md", response: RESPONSE });
    try {
      await flush();
      expect(labels()).toEqual(["Third quarter", "Old"]);
    } finally {
      teardown();
    }
  });

  it("shows the block each link sits in", async () => {
    const { teardown } = render({ open: "Projects/Roadmap.md", response: RESPONSE });
    try {
      await flush();
      expect(contexts()).toEqual([
        "We should ship Roadmap this quarter.",
        "Roadmap again, under a heading.",
        "—",
      ]);
    } finally {
      teardown();
    }
  });

  it("marks a transclusion and the anchor a link pointed at", async () => {
    const { teardown } = render({ open: "Projects/Roadmap.md", response: RESPONSE });
    try {
      await flush();
      const badges = [...target.querySelectorAll<HTMLElement>(".backlink-badge")].map(
        (badge) => badge.textContent?.trim() ?? "",
      );
      expect(badges).toEqual(["embed", "#Goals", "^b1"]);
    } finally {
      teardown();
    }
  });

  it("opens the linking note when its row is activated", async () => {
    const { store, teardown } = render({ open: "Projects/Roadmap.md", response: RESPONSE });
    try {
      await flush();
      sourceRows()[0]?.click();
      await tick();
      expect(store.activeTab?.note).toBe("Q3.md");
    } finally {
      teardown();
    }
  });

  it("is keyboard reachable, because every row is a button", async () => {
    // §8.4: no mouse-only feature ships. A panel of clickable divs passes a click test and
    // is unusable without a pointer.
    const { teardown } = render({ open: "Projects/Roadmap.md", response: RESPONSE });
    try {
      await flush();
      for (const row of sourceRows()) {
        expect(row.tagName).toBe("BUTTON");
        expect(row.getAttribute("disabled")).toBeNull();
      }
    } finally {
      teardown();
    }
  });

  it("says nothing links here when nothing does", async () => {
    const { teardown } = render({
      open: "Projects/Roadmap.md",
      response: { note: "Projects/Roadmap.md", sources: [] },
    });
    try {
      await flush();
      expect(empty()).toBe("Nothing links here yet.");
      expect(sourceRows()).toHaveLength(0);
    } finally {
      teardown();
    }
  });

  it("distinguishes a refused answer from an empty one", async () => {
    // The whole reason `unavailable` exists: "nothing links here" is a claim, and the server
    // did not make it.
    const { teardown } = render({ open: "Projects/Roadmap.md", response: undefined });
    try {
      await flush();
      expect(empty()).toBe("Backlinks are unavailable for this note.");
    } finally {
      teardown();
    }
  });

  it("asks for nothing when no note is open", async () => {
    const { load, teardown } = render({ response: RESPONSE });
    try {
      await flush();
      expect(load).not.toHaveBeenCalled();
      expect(empty()).toBe("Open a note to see what links to it.");
    } finally {
      teardown();
    }
  });

  it("follows the focused pane to another note", async () => {
    const { store, load, teardown } = render({ open: "Projects/Roadmap.md", response: RESPONSE });
    try {
      await flush();
      expect(load).toHaveBeenCalledWith("personal", "Projects/Roadmap.md");
      store.open("Other.md");
      await flush();
      expect(load).toHaveBeenCalledWith("personal", "Other.md");
    } finally {
      teardown();
    }
  });

  it("does not re-fetch when an unrelated part of the shell changes", async () => {
    // The effect that drives the fetch re-runs on any state the component reads. Fetching
    // the backlinks of a 10 000-note vault's open note on every keystroke is the failure
    // mode; `show` being idempotent is what prevents it, and this is what proves it.
    const { store, load, teardown } = render({ open: "Projects/Roadmap.md", response: RESPONSE });
    try {
      await flush();
      expect(load).toHaveBeenCalledTimes(1);
      store.split(store.current.focusedGroup, "vertical");
      await flush();
      store.activate(store.activeTab?.id ?? "");
      await flush();
      expect(load).toHaveBeenCalledTimes(1);
    } finally {
      teardown();
    }
  });
});
