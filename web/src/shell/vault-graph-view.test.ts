/**
 * The global graph's state (§9.4).
 *
 * What is checked here is the sequencing, which is where this kind of view goes wrong: a
 * second request landing after a first, a layout frame arriving for a graph the reader has
 * already filtered away, and the camera — which has to frame the picture while it settles
 * and then stop the moment the reader takes hold of it.
 */

import { describe, expect, it, vi } from "vitest";

import { NO_FILTERS } from "./graph-filters.js";
import type { LayoutFrame } from "./graph-layout-run.js";
import { type LayoutRunner, VaultGraphView } from "./vault-graph.svelte.js";
import type { VaultGraphData, VaultGraphNode } from "./vault-graph.js";

function note(path: string, extra: Partial<VaultGraphNode> = {}): VaultGraphNode {
  return {
    key: `n:${path}`,
    path,
    label: path,
    icon: null,
    degree: 0,
    words: 0,
    created: null,
    tags: [],
    ...extra,
  };
}

function graph(nodes: readonly VaultGraphNode[], edges: readonly number[] = []): VaultGraphData {
  return {
    nodes,
    edges: Uint32Array.from(edges),
    total: nodes.length,
    truncated: false,
  };
}

/** A runner a test drives by hand, so a "frame" arrives exactly when it says. */
function fakeRunner(): LayoutRunner & {
  frame: (x: readonly number[], y: readonly number[], settled?: boolean) => void;
  started: number;
  stopped: number;
  count: number;
} {
  let onframe: ((frame: LayoutFrame) => void) | undefined;
  const runner = {
    started: 0,
    stopped: 0,
    count: 0,
    start(count: number, _edges: Uint32Array, handler: (frame: LayoutFrame) => void) {
      runner.started += 1;
      runner.count = count;
      onframe = handler;
    },
    stop() {
      runner.stopped += 1;
      onframe = undefined;
    },
    frame(x: readonly number[], y: readonly number[], settled = false) {
      onframe?.({
        kind: "frame",
        run: 1,
        x: Float32Array.from(x).buffer as ArrayBuffer,
        y: Float32Array.from(y).buffer as ArrayBuffer,
        ticks: 1,
        settled,
      });
    },
  };
  return runner;
}

/** A view over a fixed payload, with a runner the test drives. */
function viewOver(data: VaultGraphData | undefined) {
  const runner = fakeRunner();
  const load = vi.fn(async () => data);
  const view = new VaultGraphView({
    vault: "personal",
    load: load as never,
    runner,
  });
  return { view, runner, load };
}

describe("loading", () => {
  it("starts idle, with nothing to draw", () => {
    const { view } = viewOver(graph([]));
    expect(view.loading).toBe(false);
    expect(view.nodes).toEqual([]);
    expect(view.total).toBe(0);
  });

  it("reports what came back", async () => {
    const { view } = viewOver(graph([note("A.md"), note("B.md")], [0, 1, 0]));
    view.load();
    expect(view.loading).toBe(true);
    await vi.waitFor(() => expect(view.nodes).toHaveLength(2));
    expect(Array.from(view.edges)).toEqual([0, 1, 0]);
    expect(view.total).toBe(2);
    expect(view.loading).toBe(false);
  });

  it("asks once, however many times it is told to load", async () => {
    const { view, load } = viewOver(graph([note("A.md")]));
    view.load();
    await vi.waitFor(() => expect(view.nodes).toHaveLength(1));
    view.load();
    view.load();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not ask again after a failure, however often it is told to load", async () => {
    // why: this is a loop, not a retry. The view calls `load` from an effect, and an effect
    // that reads the status and writes it re-runs itself — so a `load` that tried again on
    // `unavailable` issued one request per frame for as long as the pane was open. Retrying
    // is a button (see `GlobalGraph.svelte`).
    const { view, load } = viewOver(undefined);
    view.load();
    await vi.waitFor(() => expect(view.unavailable).toBe(true));
    view.load();
    view.load();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("asks again when it is told to reload", async () => {
    const { view, load } = viewOver(graph([note("A.md")]));
    view.load();
    await vi.waitFor(() => expect(view.nodes).toHaveLength(1));
    view.reload();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it("says the server would not answer, rather than drawing an empty vault", async () => {
    const { view } = viewOver(undefined);
    view.load();
    await vi.waitFor(() => expect(view.unavailable).toBe(true));
    expect(view.empty).toBe(false);
  });

  it("tells an empty vault apart from an unavailable one", async () => {
    const { view } = viewOver(graph([]));
    view.load();
    await vi.waitFor(() => expect(view.empty).toBe(true));
    expect(view.unavailable).toBe(false);
  });

  it("ignores an answer to a question it has stopped asking", async () => {
    // Two loads in flight, the first slower. The picture must be the second one's.
    let release: ((value: VaultGraphData) => void) | undefined;
    const slow = new Promise<VaultGraphData>((resolve) => {
      release = resolve;
    });
    const responses = [slow, Promise.resolve(graph([note("Second.md")]))];
    let at = 0;
    const view = new VaultGraphView({
      vault: "v",
      load: (async () => responses[at++]) as never,
      runner: fakeRunner(),
    });
    view.reload();
    view.reload();
    await vi.waitFor(() => expect(view.nodes).toHaveLength(1));
    expect(view.nodes[0]?.key).toBe("n:Second.md");
    release?.(graph([note("First.md"), note("Also.md")]));
    // A macrotask, not a microtask: the slow answer is behind an `async` wrapper and its own
    // `then`, and waiting one turn is not waiting long enough to see it land.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(view.nodes.map((entry) => entry.key)).toEqual(["n:Second.md"]);
  });
});

describe("laying out", () => {
  it("starts a layout over what is filtered in", async () => {
    const { view, runner } = viewOver(graph([note("A.md"), note("B.md")], [0, 1, 0]));
    view.load();
    await vi.waitFor(() => expect(runner.started).toBe(1));
    expect(runner.count).toBe(2);
  });

  it("takes the positions from a frame", async () => {
    const { view, runner } = viewOver(graph([note("A.md"), note("B.md")]));
    view.load();
    await vi.waitFor(() => expect(runner.started).toBe(1));
    runner.frame([1, 2], [3, 4]);
    expect(Array.from(view.x)).toEqual([1, 2]);
    expect(Array.from(view.y)).toEqual([3, 4]);
    expect(view.settled).toBe(false);
    runner.frame([1, 2], [3, 4], true);
    expect(view.settled).toBe(true);
  });

  it("is settled from the start when there is nothing to lay out", async () => {
    // Otherwise the view asks for an animation frame forever over an empty vault.
    const { view } = viewOver(graph([]));
    view.load();
    await vi.waitFor(() => expect(view.settled).toBe(true));
  });

  it("restarts rather than patching when a filter changes", async () => {
    // A force simulation whose node set changed under it is a picture that jumps.
    const { view, runner } = viewOver(graph([note("A.md", { tags: ["hide"] }), note("B.md")]));
    view.load();
    await vi.waitFor(() => expect(runner.started).toBe(1));
    view.setFilters({ ...NO_FILTERS, excludeTags: ["hide"] });
    expect(runner.started).toBe(2);
    expect(runner.count).toBe(1);
    expect(view.nodes.map((entry) => entry.key)).toEqual(["n:B.md"]);
  });

  it("stops the worker when it is disposed", () => {
    const { view, runner } = viewOver(graph([note("A.md")]));
    view.dispose();
    expect(runner.stopped).toBe(1);
  });
});

describe("the camera", () => {
  it("frames the picture as it settles", async () => {
    const { view, runner } = viewOver(graph([note("A.md"), note("B.md")]));
    view.load();
    await vi.waitFor(() => expect(runner.started).toBe(1));
    view.resize(400, 400);
    runner.frame([-100, 100], [0, 0]);
    expect(view.camera.x).toBe(0);
    expect(view.camera.scale).toBeGreaterThan(0);
    expect(view.camera.scale).toBeLessThan(400 / 200);
  });

  it("stops reframing once a reader has moved it", async () => {
    // Refitting under a drag would drag the picture out from under the reader's hand.
    const { view, runner } = viewOver(graph([note("A.md"), note("B.md")]));
    view.load();
    await vi.waitFor(() => expect(runner.started).toBe(1));
    view.resize(400, 400);
    view.setCamera({ x: 5, y: 6, scale: 3 });
    runner.frame([-1000, 1000], [0, 0]);
    expect(view.camera).toEqual({ x: 5, y: 6, scale: 3 });
  });

  it("frames again on demand", async () => {
    const { view, runner } = viewOver(graph([note("A.md"), note("B.md")]));
    view.load();
    await vi.waitFor(() => expect(runner.started).toBe(1));
    view.resize(400, 400);
    view.setCamera({ x: 5, y: 6, scale: 3 });
    runner.frame([-100, 100], [0, 0]);
    view.fit();
    expect(view.camera.x).toBe(0);
  });

  it("does not frame anything before it knows how big it is", () => {
    const { view } = viewOver(graph([note("A.md")]));
    view.fit();
    expect(view.camera).toEqual({ x: 0, y: 0, scale: 1 });
  });
});

describe("what the view says about itself", () => {
  it("counts what the filters are hiding", async () => {
    const { view } = viewOver(graph([note("A.md", { tags: ["hide"] }), note("B.md")]));
    view.load();
    await vi.waitFor(() => expect(view.nodes).toHaveLength(2));
    expect(view.hidden).toBe(0);
    view.setFilters({ ...NO_FILTERS, excludeTags: ["hide"] });
    expect(view.hidden).toBe(1);
  });

  it("reports the biggest value of whatever nodes are sized by", async () => {
    const { view } = viewOver(
      graph([note("A.md", { degree: 3, words: 500 }), note("B.md", { degree: 7, words: 20 })]),
    );
    view.load();
    await vi.waitFor(() => expect(view.nodes).toHaveLength(2));
    expect(view.largest).toBe(7);
    view.setSizeBy("words");
    expect(view.sizeBy).toBe("words");
    expect(view.largest).toBe(500);
  });

  it("offers the vault's tags, most used first", async () => {
    const { view } = viewOver(
      graph([
        note("A.md", { tags: ["project"] }),
        note("B.md", { tags: ["project", "archive"] }),
        note("C.md", { tags: ["archive"] }),
      ]),
    );
    view.load();
    await vi.waitFor(() => expect(view.nodes).toHaveLength(3));
    expect(view.tags).toEqual(["archive", "project"]);
  });

  it("keeps offering a tag that its own filter has hidden", async () => {
    // Otherwise excluding a tag removes the button that excluded it, and a reader can hide
    // something they then cannot un-hide without clearing every filter.
    const { view } = viewOver(graph([note("A.md", { tags: ["project"] })]));
    view.load();
    await vi.waitFor(() => expect(view.nodes).toHaveLength(1));
    view.setFilters({ ...view.filters, excludeTags: ["project"] });
    expect(view.nodes).toHaveLength(0);
    expect(view.tags).toEqual(["project"]);
  });

  it("keeps a selection inside the picture", async () => {
    const { view } = viewOver(graph([note("A.md"), note("B.md")]));
    view.load();
    await vi.waitFor(() => expect(view.nodes).toHaveLength(2));
    view.select(1);
    expect(view.selected).toBe(1);
    view.select(9);
    expect(view.selected).toBe(-1);
    view.select(-3);
    expect(view.selected).toBe(-1);
  });

  it("drops the selection when the filters change under it", async () => {
    // The index means a different node afterwards, and a highlight on the wrong note is
    // worse than none.
    const { view } = viewOver(graph([note("A.md", { tags: ["hide"] }), note("B.md")]));
    view.load();
    await vi.waitFor(() => expect(view.nodes).toHaveLength(2));
    view.select(1);
    view.setFilters({ ...NO_FILTERS, excludeTags: ["hide"] });
    expect(view.selected).toBe(-1);
  });
});
