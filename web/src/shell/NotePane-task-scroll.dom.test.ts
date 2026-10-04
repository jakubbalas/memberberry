// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { flushSync, mount, unmount } from "svelte";
import { fromStore, writable } from "svelte/store";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { applyUpdate } from "yjs";
import { createMemberberryExtensions } from "../editor/schema.js";

import { load, updateFromMarkdown } from "../notes.js";
import MobileMain from "./MobileMain.svelte";
import PaneTree from "./PaneTree.svelte";
import { openNoteSurface, type TaskEditAction } from "./note-surface.js";
import { counterIds, emptyWorkspaceStore } from "./workspace-store.svelte.js";

const contract: unknown = JSON.parse(readFileSync("../crates/mb-core/schema.json", "utf8"));
const components: ReturnType<typeof mount>[] = [];
const surfaces: Awaited<ReturnType<typeof openNoteSurface>>[] = [];
const restoreLayout: (() => void)[] = [];

beforeAll(async () => { await load(readFileSync("src/wasm/mb_bg.wasm")); });
afterEach(async () => {
  await Promise.all(components.splice(0).map((component) => unmount(component)));
  await Promise.all(surfaces.splice(0).map((surface) => surface.destroy()));
  for (const restore of restoreLayout.splice(0)) restore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function setup(layout: "mobile" | "desktop", delayed = false) {
  // Real pane wrappers, immutable workspace, editor, node view and editTask implementation.
  // Only persistence/network and jsdom's missing layout APIs are supplied at the boundary.
  const initial = await updateFromMarkdown("# Scroll tasks\n\n- [ ] Keep completed 📅 2026-10-10\n");
  // jsdom does not implement these methods at all, so install and later restore descriptors.
  const rects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
  const bounds = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => new DOMRect() });
  restoreLayout.push(() => {
    if (rects === undefined) Reflect.deleteProperty(Range.prototype, "getClientRects");
    else Object.defineProperty(Range.prototype, "getClientRects", rects);
    if (bounds === undefined) Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    else Object.defineProperty(Range.prototype, "getBoundingClientRect", bounds);
  });
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => { frames.push(run); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const store = emptyWorkspaceStore("v", { ids: counterIds() });
  store.open("Tasks.md");
  const request = writable({ path: "Tasks.md", ordinal: 0, action: { kind: "toggle" } as TaskEditAction });
  const current = fromStore(request);
  const target = document.createElement("div");
  document.body.append(target);
  let release = (): void => undefined;
  const ready = delayed ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve();
  const open = vi.fn<typeof openNoteSurface>(async (options) => {
    await ready;
    const surface = await openNoteSurface({ ...options,
      loadExtensions: async () => createMemberberryExtensions(contract),
      replica: async () => undefined,
      createPersistence: (_key, doc) => {
        applyUpdate(doc, initial);
        return { whenSynced: Promise.resolve(), destroy: async () => undefined };
      },
      createRemoteSync: () => ({ connected: false, pending: 0, synced: false, sendAwareness: () => undefined, destroy: () => undefined }),
    });
    surfaces.push(surface);
    return surface;
  });
  const shared = { store, open, session: { vault: "v", user: "alice" }, get taskEdit() { return current.current; } };
  components.push(layout === "mobile"
    ? mount(MobileMain, { target, props: shared })
    : mount(PaneTree, { target, props: { ...shared, get taskEdit() { return current.current; },
      get node() { return store.current.root; }, get panes() { return store.groups.map((group) => group.id); },
    } }));
  flushSync();
  if (!delayed) {
    await vi.waitFor(() => expect(target.querySelector(".task-checkbox")?.getAttribute("aria-checked")).toBe("true"));
    // Finish the intentional edit's scheduled focus before measuring scroll-only mutations.
    for (const frame of frames.splice(0)) frame(0);
    await Promise.resolve();
  }
  const scroll = (offset: number): void => {
    const pane = target.querySelector<HTMLElement>(".note-pane");
    if (pane === null) throw new Error("missing note pane");
    pane.scrollTop = offset;
    pane.dispatchEvent(new Event("scroll"));
    for (const frame of frames.splice(0)) frame(0);
    flushSync();
    expect(store.activeTab?.scroll).toBe(offset);
  };
  return { target, store, request, open, scroll, release };
}

describe("task edits and immutable scroll updates", () => {
  it.each(["mobile", "desktop"] as const)("does not replay an inbox toggle or mutate the editor while %s scrolls", async (layout) => {
    const app = await setup(layout);
    const editor = app.target.querySelector(".tiptap");
    const checkbox = app.target.querySelector(".task-checkbox");
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    if (editor === null) throw new Error("missing real editor");
    observer.observe(editor, { subtree: true, childList: true, attributes: true, characterData: true });
    try {
      for (const offset of [100, 250, 450, 300]) {
        app.scroll(offset);
        await Promise.resolve();
        expect(checkbox?.getAttribute("aria-checked")).toBe("true");
      }
      expect(app.target.querySelector(".tiptap")).toBe(editor);
      expect(app.open).toHaveBeenCalledTimes(1);
      expect(mutations).toEqual([]);
    } finally { observer.disconnect(); }
  });

  it("accepts a second intentional toggle with the same ordinal and action values", async () => {
    const app = await setup("mobile");
    app.request.set({ path: "Tasks.md", ordinal: 0, action: { kind: "toggle" } });
    flushSync();
    expect(app.target.querySelector(".task-checkbox")?.getAttribute("aria-checked")).toBe("false");
    app.scroll(200);
    expect(app.target.querySelector(".task-checkbox")?.getAttribute("aria-checked")).toBe("false");
  });

  it("applies a pending toggle only once after asynchronous editor startup", async () => {
    const app = await setup("mobile", true);
    app.scroll(100);
    app.scroll(200);
    app.release();
    await vi.waitFor(() => expect(app.target.querySelector(".task-checkbox")?.getAttribute("aria-checked")).toBe("true"));
    app.scroll(300);
    expect(app.target.querySelector(".task-checkbox")?.getAttribute("aria-checked")).toBe("true");
    expect(app.open).toHaveBeenCalledTimes(1);
  });
});
