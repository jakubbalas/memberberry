// @vitest-environment jsdom

/**
 * The outline pane in the right sidebar (`SPEC.md` §9.5, §8.2).
 *
 * `outline.test.ts` covers the keyboard as data and `editor/outline.dom.test.ts` covers the
 * document edits. These cover what a reader sees, mounted inside `Workspace` rather than
 * alone — a component that renders correctly in isolation and `display: none` in the shell
 * has already shipped here once (§22.6) — plus the one thing the panel itself has to get
 * right: a request must reach the editor that announced, and no other.
 */

import { mount, tick, unmount } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Workspace from "./Workspace.svelte";
import type { OutlineHeading } from "../editor/outline.js";
import { Bookmarks } from "./bookmarks.svelte.js";
import { NoteCatalog } from "./note-catalog.svelte.js";
import type { NoteSurface, OpenNoteSurfaceOptions } from "./note-surface.js";
import { OutlineView } from "./outline.svelte.js";
import { fromVisiblePane } from "./outline.js";
import { TagView } from "./tags.svelte.js";
import { WorkspaceStore, sessionIds } from "./workspace-store.svelte.js";
import { createWorkspace } from "./workspace.js";

const openSurface = async (_options: OpenNoteSurfaceOptions): Promise<NoteSurface> => ({
  destroy: async () => undefined,
});

const heading = (index: number, level: number, text: string): OutlineHeading => ({
  index,
  block: index * 2 + 1,
  level,
  text,
});

const HEADINGS: readonly OutlineHeading[] = [
  heading(0, 1, "First"),
  heading(1, 2, "Nested"),
  heading(2, 1, "Second"),
];

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
  options: { readonly open?: string | undefined; readonly active?: number | undefined } = {},
) {
  const ids = sessionIds();
  const store = new WorkspaceStore({ initial: createWorkspace("personal", ids), ids });
  if (options.open !== undefined) store.open(options.open);
  const outline = new OutlineView();
  const source = document.createElement("div");
  document.body.append(source);
  const requests: Array<{ name: string; detail: unknown }> = [];
  for (const name of ["memberberry:outline-goto", "memberberry:outline-move"]) {
    source.addEventListener(name, (event) => {
      requests.push({ name, detail: (event as CustomEvent).detail });
    });
  }

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
      catalog: new NoteCatalog({ vault: "personal", load: async () => [] }),
      bookmarks: new Bookmarks({
        vault: "personal",
        fetch: (async () => new Response("[]")) as unknown as typeof globalThis.fetch,
      }),
      tags: new TagView({ vault: "personal", load: async () => [] }),
      outline,
    },
  });
  // The editor is stubbed out here, so the announcement it would make is made by hand — the
  // real one is `editor/outline.dom.test.ts`, and that the two agree is `e2e/outline.spec.ts`.
  outline.receive({ headings: HEADINGS, active: options.active ?? -1 }, source);
  return { store, outline, requests, teardown: () => unmount(app) };
}

const panel = (): HTMLElement | null => target.querySelector(".outline-panel");
const rows = (): HTMLElement[] => [...target.querySelectorAll<HTMLElement>(".outline-row")];
const labels = (): string[] =>
  rows().map((row) => row.querySelector(".tree-label")?.textContent?.trim() ?? "");

describe("the outline pane", () => {
  it("lists the note's headings in document order", async () => {
    const { teardown } = render({ open: "Welcome.md" });
    try {
      await flush();
      expect(labels()).toEqual(["First", "Nested", "Second"]);
    } finally {
      teardown();
    }
  });

  it("indents a row by its heading level, and says the level out loud", async () => {
    const { teardown } = render({ open: "Welcome.md" });
    try {
      await flush();
      expect(rows()[1]?.getAttribute("aria-level")).toBe("2");
      expect(rows()[1]?.getAttribute("style")).toContain("--tree-depth: 1");
    } finally {
      teardown();
    }
  });

  it("marks the section the reader is inside, separately from the cursor", async () => {
    // Three different rows can be the cursor, the current section and the one being dragged
    // at the same time; conflating any two of them is how an outline stops being readable.
    const { teardown } = render({ open: "Welcome.md", active: 2 });
    try {
      await flush();
      expect(rows()[2]?.getAttribute("data-current")).toBe("true");
      expect(rows()[0]?.getAttribute("data-current")).toBe("false");
      expect(rows()[0]?.getAttribute("aria-selected")).toBe("true");
    } finally {
      teardown();
    }
  });

  it("asks the editor to scroll when a row is clicked", async () => {
    const { requests, teardown } = render({ open: "Welcome.md" });
    try {
      await flush();
      rows()[1]?.click();
      await tick();
      expect(requests).toEqual([
        { name: "memberberry:outline-goto", detail: { index: 1 } },
      ]);
    } finally {
      teardown();
    }
  });

  it("scrolls and reorders from the keyboard alone", async () => {
    // §8.4 and §8.2: the drag has to have a keyboard equivalent, and it is a separate
    // implementation rather than the same code path.
    const { requests, teardown } = render({ open: "Welcome.md" });
    try {
      await flush();
      const tree = target.querySelector<HTMLElement>(".outline-tree");
      expect(tree?.getAttribute("tabindex")).toBe("0");
      const press = (key: string, altKey = false): void => {
        tree?.dispatchEvent(new KeyboardEvent("keydown", { key, altKey, bubbles: true }));
      };
      press("ArrowDown");
      press("Enter");
      press("ArrowDown", true);
      await tick();
      expect(requests).toEqual([
        { name: "memberberry:outline-goto", detail: { index: 1 } },
        { name: "memberberry:outline-move", detail: { from: 1, to: 2 } },
      ]);
    } finally {
      teardown();
    }
  });

  it("reorders on a drop, carrying the dragged row's index in the payload", async () => {
    const { requests, teardown } = render({ open: "Welcome.md" });
    try {
      await flush();
      const data = new Map<string, string>();
      const transfer = {
        setData: (kind: string, value: string) => data.set(kind, value),
        getData: (kind: string) => data.get(kind) ?? "",
        types: ["application/x-memberberry-heading"],
        effectAllowed: "move",
        dropEffect: "move",
      };
      const drag = (type: string, row: HTMLElement): void => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "dataTransfer", { value: transfer });
        row.dispatchEvent(event);
      };
      const [first, , third] = rows();
      if (first === undefined || third === undefined) throw new Error("no rows to drag");
      drag("dragstart", third);
      drag("dragover", first);
      await tick();
      expect(first.getAttribute("data-drop-before")).toBe("true");
      drag("drop", first);
      await tick();
      expect(requests).toEqual([
        { name: "memberberry:outline-move", detail: { from: 2, to: 0 } },
      ]);
    } finally {
      teardown();
    }
  });

  it("says a note has no headings without pretending it has none open", async () => {
    const { outline, teardown } = render({ open: "Welcome.md" });
    try {
      await flush();
      outline.clear();
      await tick();
      expect(panel()?.textContent).toContain("This note has no headings.");
      expect(rows()).toHaveLength(0);
    } finally {
      teardown();
    }
  });

  it("says to open a note when no pane has one", async () => {
    const { teardown } = render({});
    try {
      await flush();
      expect(panel()?.textContent).toContain("Open a note to see its outline.");
    } finally {
      teardown();
    }
  });

  it("empties when the pane's note changes, rather than showing the old one's headings", async () => {
    // The new editor announces a moment later; until it does, rows that scroll a document
    // nobody is looking at are worse than no rows.
    const { store, teardown } = render({ open: "Welcome.md" });
    try {
      await flush();
      expect(rows()).toHaveLength(3);
      store.open("Projects/Roadmap.md");
      await tick();
      expect(rows()).toHaveLength(0);
    } finally {
      teardown();
    }
  });
});

describe("which editor the panel listens to", () => {
  const paneWith = (focused: boolean): HTMLElement => {
    const pane = document.createElement("div");
    pane.className = "pane";
    pane.setAttribute("data-focused", String(focused));
    const editor = document.createElement("div");
    pane.append(editor);
    return editor;
  };

  it("takes an announcement from the focused pane", () => {
    expect(fromVisiblePane(paneWith(true))).toBe(true);
  });

  it("ignores the other half of a split", () => {
    // Both editors announce. Without this the panel would show whichever one typed last,
    // which is not the pane the reader is looking at.
    expect(fromVisiblePane(paneWith(false))).toBe(false);
  });

  it("takes an announcement from an editor in no pane at all", () => {
    // The mobile layout renders one editor and marks no pane as focused (§8.3).
    expect(fromVisiblePane(document.createElement("div"))).toBe(true);
  });

  it("ignores something that is not an element", () => {
    expect(fromVisiblePane(null)).toBe(false);
    expect(fromVisiblePane(new EventTarget())).toBe(false);
  });
});

describe("the outline view", () => {
  const source = (): HTMLElement => {
    const element = document.createElement("div");
    document.body.append(element);
    return element;
  };

  it("holds what the editor announced", () => {
    const view = new OutlineView();
    view.receive({ headings: [heading(0, 1, "First")], active: 0 }, source());
    expect(view.headings.map((entry) => entry.text)).toEqual(["First"]);
    expect(view.active).toBe(0);
  });

  it("sends a request back to the editor that announced", () => {
    const view = new OutlineView();
    const element = source();
    const seen: string[] = [];
    element.addEventListener("memberberry:outline-goto", (event) => {
      seen.push(JSON.stringify((event as CustomEvent).detail));
    });
    element.addEventListener("memberberry:outline-move", (event) => {
      seen.push(JSON.stringify((event as CustomEvent).detail));
    });

    view.receive({ headings: [heading(0, 1, "First")], active: -1 }, element);
    view.goto(0);
    view.move(1, 0);
    expect(seen).toEqual(['{"index":0}', '{"from":1,"to":0}']);
  });

  it("does not ask for a move that moves nothing", () => {
    const view = new OutlineView();
    const element = source();
    const listener = vi.fn();
    element.addEventListener("memberberry:outline-move", listener);
    view.receive({ headings: [heading(0, 1, "First")], active: -1 }, element);
    view.move(2, 2);
    expect(listener).not.toHaveBeenCalled();
  });

  it("says nothing to an editor that has been torn down", () => {
    // A pane can close between the announcement and the click. Dispatching at a detached
    // element is silent rather than wrong; not dispatching says so out loud.
    const view = new OutlineView();
    const element = source();
    const listener = vi.fn();
    element.addEventListener("memberberry:outline-goto", listener);
    view.receive({ headings: [heading(0, 1, "First")], active: -1 }, element);
    element.remove();
    view.goto(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it("empties when the pane it was following goes away", () => {
    const view = new OutlineView();
    view.receive({ headings: [heading(0, 1, "First")], active: 0 }, source());
    view.clear();
    expect(view.headings).toEqual([]);
    expect(view.active).toBe(-1);
  });
});
