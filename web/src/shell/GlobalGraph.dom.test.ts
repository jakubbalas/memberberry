// @vitest-environment jsdom

/**
 * The global graph pane in jsdom (`SPEC.md` §9.4, §8.4).
 *
 * **What this can see, and what it cannot.** jsdom has no WebGL and no 2D canvas context, so
 * `GraphRenderer.create` answers `undefined` here and nothing is painted — which is exactly
 * the arrangement worth testing: the pane has to stay usable when the picture cannot be
 * drawn, and it must not throw on a machine that will not give it a context. What a reader
 * *sees* is `web/e2e/global-graph.spec.ts`, which reads the pixels back out of the canvas,
 * and it exists because a suite like this one has twice been green over a blank page (§22.6).
 *
 * So the assertions here are the chrome and the wiring: the three states that are easy to
 * conflate on screen, the filters, the count, and §8.4's keyboard — one tab stop, arrows,
 * Enter.
 */

import { mount, tick, unmount } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import GlobalGraph from "./GlobalGraph.svelte";
import type { LayoutFrame } from "./graph-layout-run.js";
import { type LayoutRunner, VaultGraphView } from "./vault-graph.svelte.js";
import type { VaultGraphData, VaultGraphNode } from "./vault-graph.js";

function note(path: string, extra: Partial<VaultGraphNode> = {}): VaultGraphNode {
  return {
    key: `n:${path}`,
    path,
    label: path.replace(/\.md$/, ""),
    icon: null,
    degree: 0,
    words: 0,
    created: null,
    tags: [],
    ...extra,
  };
}

const ghost = (name: string): VaultGraphNode => ({
  key: `g:${name}`,
  path: null,
  label: name,
  icon: null,
  degree: 1,
  words: 0,
  created: null,
  tags: [],
});

function graph(nodes: readonly VaultGraphNode[], edges: readonly number[] = []): VaultGraphData {
  return { nodes, edges: Uint32Array.from(edges), total: nodes.length, truncated: false };
}

/** A runner the test drives, so positions arrive exactly when it says. */
function fakeRunner() {
  let onframe: ((frame: LayoutFrame) => void) | undefined;
  let count = 0;
  const runner: LayoutRunner & { settle: () => void } = {
    start(nodes, _edges, handler) {
      count = nodes;
      onframe = handler;
    },
    stop() {
      onframe = undefined;
    },
    settle() {
      // A line of nodes, so every arrow key has somewhere to go.
      onframe?.({
        kind: "frame",
        run: 1,
        x: Float32Array.from({ length: count }, (_, at) => at * 40).buffer as ArrayBuffer,
        y: new Float32Array(count).buffer as ArrayBuffer,
        ticks: 1,
        settled: true,
      });
    },
  };
  return runner;
}

let host: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  // jsdom does not implement it, and the pane measures itself with one.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
});

interface Mounted {
  readonly view: VaultGraphView;
  readonly runner: ReturnType<typeof fakeRunner>;
  readonly opened: string[];
  readonly closed: { count: number };
}

async function render(data: VaultGraphData | undefined): Promise<Mounted> {
  const runner = fakeRunner();
  const view = new VaultGraphView({
    vault: "personal",
    load: (async () => data) as never,
    runner,
  });
  const opened: string[] = [];
  const closed = { count: 0 };
  mount(GlobalGraph, {
    target: host,
    props: {
      view,
      onopen: (path: string) => opened.push(path),
      onclose: () => (closed.count += 1),
    },
  });
  await tick();
  await vi.waitFor(() => expect(view.loading).toBe(false));
  await tick();
  return { view, runner, opened, closed };
}

const surface = (): HTMLElement => {
  const element = host.querySelector<HTMLElement>(".graph-view-surface");
  if (element === null) throw new Error("no graph surface");
  return element;
};

const status = (): string => host.querySelector(".graph-view-count")?.textContent?.trim() ?? "";
const selection = (): string =>
  host.querySelector(".graph-view-selection")?.textContent?.trim() ?? "";

describe("what the pane says", () => {
  it("counts the notes it is showing", async () => {
    await render(graph([note("A.md"), note("B.md")]));
    expect(status()).toBe("2 notes.");
  });

  it("says a vault with one note in the singular", async () => {
    await render(graph([note("A.md")]));
    expect(status()).toBe("1 note.");
  });

  it("says a vault with nothing in it has nothing to draw", async () => {
    await render(graph([]));
    expect(host.textContent).toContain("nothing in this vault to draw");
  });

  it("says the server would not answer, which is a different statement", async () => {
    // Drawing "we could not ask" as "there is nothing here" is a lie the reader cannot see
    // through — the same distinction every other panel in the shell makes.
    await render(undefined);
    expect(host.textContent).toContain("unavailable");
    expect(host.textContent).not.toContain("nothing in this vault");
  });

  it("says so when the server capped the picture", async () => {
    // §9.4 requires the cap to be visible rather than silent.
    const capped: VaultGraphData = {
      nodes: [note("A.md"), note("B.md")],
      edges: new Uint32Array(0),
      total: 10_431,
      truncated: true,
    };
    await render(capped);
    expect(status()).toBe("Showing the 2 most connected of 10431 notes.");
  });

  it("says how much the filters are hiding", async () => {
    const { view } = await render(graph([note("A.md", { tags: ["hide"] }), note("B.md")]));
    view.setFilters({ ...view.filters, excludeTags: ["hide"] });
    await tick();
    expect(status()).toBe("Showing 1 of 2 notes.");
  });

  it("describes the selected node for a screen reader", async () => {
    const { view, runner } = await render(graph([note("A.md", { degree: 3 }), ghost("someday")]));
    runner.settle();
    await tick();
    expect(selection()).toBe("Nothing selected.");
    // The client keeps the order the server sent, so an index means this fixture's order.
    view.select(0);
    await tick();
    expect(selection()).toBe("A — 3 links.");
    view.select(1);
    await tick();
    expect(selection()).toBe("someday — no note yet.");
  });
});

describe("the keyboard (§8.4)", () => {
  it("is one tab stop for the whole picture", async () => {
    await render(graph([note("A.md"), note("B.md"), note("C.md")]));
    const stops = host.querySelectorAll('[tabindex="0"]');
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBe(surface());
  });

  it("moves the selection with an arrow and opens with Enter", async () => {
    const { runner, opened } = await render(graph([note("A.md"), note("B.md")]));
    runner.settle();
    await tick();

    surface().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await tick();
    expect(selection()).toContain("A");

    surface().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await tick();
    expect(selection()).toContain("B");

    surface().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(opened).toEqual(["B.md"]);
  });

  it("opens nothing for a ghost, which is a node with no note behind it", async () => {
    const { view, runner, opened } = await render(graph([ghost("someday"), note("A.md")]));
    runner.settle();
    await tick();
    view.select(0);
    surface().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(opened).toEqual([]);
  });

  it("closes on Escape", async () => {
    const { closed } = await render(graph([note("A.md")]));
    surface().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(closed.count).toBe(1);
  });

  it("leaves a key it does not use alone", async () => {
    const { runner } = await render(graph([note("A.md"), note("B.md")]));
    runner.settle();
    await tick();
    const event = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
    surface().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("the controls", () => {
  it("hides the filters until they are asked for", async () => {
    await render(graph([note("A.md")]));
    expect(host.querySelector("#graph-filters")).toBeNull();
    host.querySelector<HTMLButtonElement>(".graph-view-button")?.click();
  });

  it("says when a filter is on", async () => {
    const { view } = await render(graph([note("A.md")]));
    const filters = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Filters"),
    );
    expect(filters?.textContent?.trim()).toBe("Filters");
    view.setFilters({ ...view.filters, orphansOnly: true });
    await tick();
    expect(filters?.textContent?.trim()).toBe("Filters (on)");
  });

  it("offers the tags in the picture, most used first", async () => {
    const { view } = await render(
      graph([
        note("A.md", { tags: ["project"] }),
        note("B.md", { tags: ["project", "archive"] }),
      ]),
    );
    const toggle = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Filters"),
    );
    toggle?.click();
    await tick();
    const tags = [...host.querySelectorAll(".graph-filter-tag")].map((tag) =>
      tag.textContent?.trim(),
    );
    expect(tags).toEqual(["#project", "#archive"]);

    // §8.4: one control, three states, all of them reachable by activating it. A right-click
    // to exclude would be a mouse-only half of this feature.
    //
    // Re-queried before each press rather than held: a filter change relays the graph out,
    // and a stale element reference would be pressing a button that is no longer the one on
    // screen — which is what a person does not do.
    const press = async (): Promise<HTMLButtonElement | null> => {
      const button = host.querySelector<HTMLButtonElement>(".graph-filter-tag");
      button?.click();
      await tick();
      return host.querySelector<HTMLButtonElement>(".graph-filter-tag");
    };

    const included = await press();
    expect(view.filters.includeTags).toEqual(["project"]);
    expect(included?.getAttribute("aria-label")).toContain("activate to hide");

    const excluded = await press();
    expect(view.filters.includeTags).toEqual([]);
    expect(view.filters.excludeTags).toEqual(["project"]);
    expect(excluded?.getAttribute("aria-label")).toContain("show everything again");

    const cleared = await press();
    expect(view.filters.excludeTags).toEqual([]);
    expect(cleared?.getAttribute("aria-label")).toContain("show only these");
  });

  it("switches what a node is sized by", async () => {
    const { view } = await render(graph([note("A.md", { degree: 1, words: 400 })]));
    const select = host.querySelector<HTMLSelectElement>(".graph-view-control select");
    expect(select?.value).toBe("degree");
    if (select !== null) {
      select.value = "words";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await tick();
    expect(view.sizeBy).toBe("words");
  });

  it("closes when the close button is used", async () => {
    const { closed } = await render(graph([note("A.md")]));
    const close = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Close",
    );
    close?.click();
    expect(closed.count).toBe(1);
  });
});

describe("without a canvas context", () => {
  it("renders and stays usable, which is what a machine with no WebGL gets", async () => {
    // jsdom gives no context for either canvas, so this is the no-WebGL path. It must not
    // throw, and the pane must still count, select and close — the graph is unusable there,
    // and an application that crashed instead would take the whole page with it.
    const { runner, closed } = await render(graph([note("A.md"), note("B.md")], [0, 1, 0]));
    runner.settle();
    await tick();
    expect(host.querySelector(".graph-view-gl")).not.toBeNull();
    expect(status()).toBe("2 notes.");
    surface().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(closed.count).toBe(1);
  });

  it("stops the layout when it is unmounted", async () => {
    const stopped = vi.fn();
    const runner: LayoutRunner = { start: () => undefined, stop: stopped };
    const view = new VaultGraphView({
      vault: "v",
      load: (async () => graph([note("A.md")])) as never,
      runner,
    });
    const mounted = mount(GlobalGraph, {
      target: host,
      props: { view, onopen: () => undefined, onclose: () => undefined },
    });
    await tick();
    await unmount(mounted, { outro: false });
    expect(stopped).toHaveBeenCalled();
  });
});
