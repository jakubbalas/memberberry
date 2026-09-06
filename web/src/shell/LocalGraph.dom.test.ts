// @vitest-environment jsdom

/**
 * The local graph in the right sidebar (`SPEC.md` §9.4, §8.2).
 *
 * `graph.test.ts` covers what the client accepts from the wire and `graph-layout.test.ts`
 * covers where the nodes end up. These cover what a reader sees and can do: the picture, the
 * hop control, the keyboard, and the three states that are easy to conflate on screen — a
 * note with no neighbours, a note the server would not answer for, and a ghost.
 *
 * **jsdom applies no stylesheet**, so nothing here can see a panel hidden by CSS. That is
 * what `web/e2e/graph.spec.ts` is for, and why it exists (§22.6).
 */

import { mount, tick, unmount } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Workspace from "./Workspace.svelte";
import { Bookmarks } from "./bookmarks.svelte.js";
import type { GraphResponse } from "./graph.js";
import { GraphView } from "./graph.svelte.js";
import { NoteCatalog } from "./note-catalog.svelte.js";
import type { NoteSurface, OpenNoteSurfaceOptions } from "./note-surface.js";
import { WorkspaceStore, sessionIds } from "./workspace-store.svelte.js";
import { createWorkspace } from "./workspace.js";

const openSurface = async (_options: OpenNoteSurfaceOptions): Promise<NoteSurface> => ({
  destroy: async () => undefined,
});

const RESPONSE: GraphResponse = {
  note: "Projects/Roadmap.md",
  hops: 1,
  truncated: false,
  nodes: [
    {
      key: "n:Projects/Roadmap.md",
      path: "Projects/Roadmap.md",
      label: "Roadmap",
      hop: 0,
    },
    { key: "g:someday", path: null, label: "Someday", hop: 1 },
    { key: "n:Q3.md", path: "Q3.md", label: "Third quarter", hop: 1 },
  ],
  edges: [
    { source: "n:Projects/Roadmap.md", target: "g:someday", embed: false },
    { source: "n:Q3.md", target: "n:Projects/Roadmap.md", embed: true },
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
    readonly response?: GraphResponse | undefined;
    readonly responses?: ReadonlyMap<number, GraphResponse> | undefined;
  } = {},
) {
  const ids = sessionIds();
  const store = new WorkspaceStore({
    initial: createWorkspace("personal", ids),
    ids,
  });
  if (options.open !== undefined) store.open(options.open);

  const load = vi.fn(
    async (_vault: string, _note: string, hops: number): Promise<GraphResponse | undefined> =>
      options.responses?.get(hops) ?? options.response,
  );
  const graph = new GraphView({ vault: "personal", load });
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
      graph,
    },
  });
  return { store, load, view: graph, teardown: () => unmount(app) };
}

const panel = (): HTMLElement | null => target.querySelector(".graph-panel");
const canvas = (): HTMLElement | null => target.querySelector(".graph-canvas");
// SVG elements, not HTML ones: `SVGElement` has no `.click()` in jsdom and no `dataset` in
// older DOM typings, so the helpers reach for `dispatchEvent` and `getAttribute` instead.
const nodes = (): Element[] => [...target.querySelectorAll(".graph-node")];
const keyOf = (node: Element): string => node.getAttribute("data-key") ?? "";
const keys = (): string[] => nodes().map(keyOf);
const activate = (node: Element | undefined): void =>
  void node?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
const labels = (): string[] =>
  nodes().map((node) => node.querySelector(".graph-label")?.textContent?.trim() ?? "");
const edges = (): Element[] => [...target.querySelectorAll(".graph-edge")];
const hopButtons = (): HTMLButtonElement[] => [
  ...target.querySelectorAll<HTMLButtonElement>(".graph-hop"),
];
const empty = (): string => panel()?.querySelector(".tree-empty")?.textContent?.trim() ?? "";

describe("the local graph", () => {
  it("draws a node for the note and for everything near it", async () => {
    const { teardown } = render({
      open: "Projects/Roadmap.md",
      response: RESPONSE,
    });
    try {
      await flush();
      // Painted outermost first, so the origin is on top when two rings crowd.
      expect(keys().sort()).toEqual(["g:someday", "n:Projects/Roadmap.md", "n:Q3.md"]);
      expect(labels().sort()).toEqual(["Roadmap", "Someday", "Third quarter"]);
      expect(edges()).toHaveLength(2);
    } finally {
      teardown();
    }
  });

  it("marks the note the panel is about, and marks a ghost as one", async () => {
    const { teardown } = render({
      open: "Projects/Roadmap.md",
      response: RESPONSE,
    });
    try {
      await flush();
      const byKey = new Map(nodes().map((node) => [keyOf(node), node]));
      expect(byKey.get("n:Projects/Roadmap.md")?.classList.contains("is-origin")).toBe(true);
      expect(byKey.get("g:someday")?.classList.contains("is-ghost")).toBe(true);
      expect(byKey.get("n:Q3.md")?.classList.contains("is-ghost")).toBe(false);
    } finally {
      teardown();
    }
  });

  it("marks a transclusion's edge, which is a copy of this note on that page", async () => {
    const { teardown } = render({
      open: "Projects/Roadmap.md",
      response: RESPONSE,
    });
    try {
      await flush();
      const marked = edges().filter((line) => line.classList.contains("is-embed"));
      expect(marked).toHaveLength(1);
    } finally {
      teardown();
    }
  });

  it("names each node for a screen reader, ghost included", async () => {
    // The picture is the only thing on screen; without these the panel is a decoration.
    const { teardown } = render({
      open: "Projects/Roadmap.md",
      response: RESPONSE,
    });
    try {
      await flush();
      const said = new Map(
        nodes().map((node) => [keyOf(node), node.getAttribute("aria-label")]),
      );
      expect(said.get("n:Projects/Roadmap.md")).toBe("Roadmap, this note");
      expect(said.get("n:Q3.md")).toBe("Third quarter, 1 link away");
      expect(said.get("g:someday")).toBe("Someday, no note yet");
    } finally {
      teardown();
    }
  });

  it("opens a note when its node is activated", async () => {
    const { store, teardown } = render({
      open: "Projects/Roadmap.md",
      response: RESPONSE,
    });
    try {
      await flush();
      activate(nodes().find((node) => keyOf(node) === "n:Q3.md"));
      await tick();
      expect(store.activeTab?.note).toBe("Q3.md");
    } finally {
      teardown();
    }
  });

  it("does nothing when a ghost is activated, because there is no note to open", async () => {
    const { store, teardown } = render({
      open: "Projects/Roadmap.md",
      response: RESPONSE,
    });
    try {
      await flush();
      activate(nodes().find((node) => keyOf(node) === "g:someday"));
      await tick();
      expect(store.activeTab?.note).toBe("Projects/Roadmap.md");
    } finally {
      teardown();
    }
  });

  it("is one tab stop with a moving cursor, not one tab stop per node", async () => {
    // §8.4, and the same shape as the note tree and the tag pane: a graph of two hundred
    // nodes must not be two hundred stops between the sidebar and the next control.
    const { teardown } = render({
      open: "Projects/Roadmap.md",
      response: RESPONSE,
    });
    try {
      await flush();
      expect(canvas()?.getAttribute("tabindex")).toBe("0");
      for (const node of nodes()) expect(node.getAttribute("tabindex")).toBe("-1");
      expect(canvas()?.getAttribute("aria-activedescendant")).toBe("graph-node-0");
    } finally {
      teardown();
    }
  });

  it("moves the cursor with the arrows and opens with Enter", async () => {
    const { store, teardown } = render({
      open: "Projects/Roadmap.md",
      response: RESPONSE,
    });
    try {
      await flush();
      canvas()?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
      await tick();
      expect(canvas()?.getAttribute("aria-activedescendant")).toBe("graph-node-1");
      // Node 1 is the ghost; one more step reaches the note.
      canvas()?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
      await tick();
      canvas()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await tick();
      expect(store.activeTab?.note).toBe("Q3.md");
    } finally {
      teardown();
    }
  });

  it("asks for a wider walk when the hop control is used, rather than filtering", async () => {
    // A two-hop graph is not a one-hop graph plus a ring: the outer ring's links to each
    // other come with it, so narrowing by discarding nodes would leave edges behind.
    const responses = new Map([
      [1, RESPONSE],
      [
        2,
        {
          ...RESPONSE,
          hops: 2,
          nodes: [...RESPONSE.nodes, { key: "n:Far.md", path: "Far.md", label: "Far", hop: 2 }],
          edges: [...RESPONSE.edges, { source: "n:Q3.md", target: "n:Far.md", embed: false }],
        },
      ],
    ]);
    const { load, teardown } = render({
      open: "Projects/Roadmap.md",
      responses,
    });
    try {
      await flush();
      expect(keys()).not.toContain("n:Far.md");
      hopButtons()[1]?.click();
      await flush();
      expect(load).toHaveBeenCalledWith("personal", "Projects/Roadmap.md", 2);
      expect(keys()).toContain("n:Far.md");
    } finally {
      teardown();
    }
  });

  it("shows which walk was drawn, not which was asked for", async () => {
    // The server clamps, so a control that showed its own request could disagree with the
    // picture beside it.
    const responses = new Map([[3, { ...RESPONSE, hops: 3 }]]);
    const { teardown } = render({ open: "Projects/Roadmap.md", responses });
    try {
      await flush();
      hopButtons()[2]?.click();
      await flush();
      expect(hopButtons().map((button) => button.getAttribute("aria-checked"))).toEqual([
        "false",
        "false",
        "true",
      ]);
    } finally {
      teardown();
    }
  });

  it("says nothing is near this note when nothing is", async () => {
    const { teardown } = render({
      open: "Projects/Roadmap.md",
      response: {
        note: "Projects/Roadmap.md",
        hops: 1,
        truncated: false,
        nodes: [
          {
            key: "n:Projects/Roadmap.md",
            path: "Projects/Roadmap.md",
            label: "Roadmap",
            hop: 0,
          },
        ],
        edges: [],
      },
    });
    try {
      await flush();
      expect(empty()).toBe("Nothing links to or from this note yet.");
      expect(nodes()).toHaveLength(0);
    } finally {
      teardown();
    }
  });

  it("says the graph is unavailable rather than drawing an empty one", async () => {
    // A refusal drawn as a lone dot is a claim nobody checked: it says this note has no
    // neighbours when what happened is that nobody answered.
    const { teardown } = render({
      open: "Projects/Roadmap.md",
      response: undefined,
    });
    try {
      await flush();
      expect(empty()).toBe("The graph is unavailable for this note.");
    } finally {
      teardown();
    }
  });

  it("asks for nothing until a note is open", async () => {
    const { load, teardown } = render({});
    try {
      await flush();
      expect(load).not.toHaveBeenCalled();
      expect(empty()).toBe("Open a note to see what is near it.");
    } finally {
      teardown();
    }
  });

  it("says so when the node cap cut the neighbourhood short", async () => {
    // §9.4 requires the cap to be visible. A picture that quietly drops half a vault is a
    // picture that lies about the shape of it.
    const { teardown } = render({
      open: "Projects/Roadmap.md",
      response: { ...RESPONSE, truncated: true },
    });
    try {
      await flush();
      expect(panel()?.querySelector(".graph-note")?.textContent?.trim()).toBe(
        "Showing the nearest 3 notes.",
      );
    } finally {
      teardown();
    }
  });

  it("says nothing about a cap when nothing was cut", async () => {
    const { teardown } = render({
      open: "Projects/Roadmap.md",
      response: RESPONSE,
    });
    try {
      await flush();
      expect(panel()?.querySelector(".graph-note")).toBeNull();
    } finally {
      teardown();
    }
  });
});
