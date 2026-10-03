// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { readFileSync } from "node:fs";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { applyUpdate, type Doc } from "yjs";
import { createMemberberryExtensions } from "../editor/schema.js";
import { load, updateFromMarkdown } from "../notes.js";
import { followLink } from "./open-note.js";
import { openNoteSurface } from "./note-surface.js";
import { counterIds, emptyWorkspaceStore } from "./workspace-store.svelte.js";
import NotePane from "./NotePane.svelte";

const contract: unknown = JSON.parse(readFileSync("../crates/mb-core/schema.json", "utf8"));
const text = "# Destination\n\nIntro\n\n## Café goals\n\nDetails\n\nPinned text ^pinned\n";
const components: ReturnType<typeof mount>[] = [];
const sessions: Awaited<ReturnType<typeof openNoteSurface>>[] = [];

beforeAll(async () => { await load(readFileSync("src/wasm/mb_bg.wasm")); });
afterEach(async () => {
  await Promise.all(components.splice(0).map((component) => unmount(component)));
  await Promise.all(sessions.splice(0).map((session) => session.destroy()));
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

async function setup(delayed = false) {
  const initial = await updateFromMarkdown(text);
  const store = emptyWorkspaceStore("v", { ids: counterIds() });
  store.open("Source.md");
  const pending: Doc[] = [];
  const scrolled: HTMLElement[] = [];
  // jsdom has no Range layout; supply only that browser boundary, not editor behavior.
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  // Record the actual target passed to the browser scroll API.
  vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => window.setTimeout(() => run(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  const previous = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this); };
  const target = document.createElement("div");
  document.body.append(target);
  let opens = 0;
  const open: typeof openNoteSurface = async (options) => {
    opens += 1;
    const session = await openNoteSurface({ ...options,
      loadExtensions: async () => createMemberberryExtensions(contract),
      replica: async () => undefined,
      createPersistence: (_key, doc) => {
        if (delayed && options.bootstrap?.note !== "Source.md") pending.push(doc);
        else applyUpdate(doc, initial);
        return { whenSynced: Promise.resolve(), destroy: async () => undefined };
      },
      createRemoteSync: () => ({ connected: false, pending: 0, synced: false, sendAwareness: () => undefined, destroy: () => undefined }),
    });
    sessions.push(session);
    return session;
  };
  components.push(mount(NotePane, { target, props: {
    get tab() { return store.activeTab; }, session: { vault: "v", user: "alice" }, open,
  } }));
  flushSync();
  await vi.waitFor(() => expect(sessions).toHaveLength(1));
  const navigate = async (anchorKind: "heading" | "block", anchor: string, note = "Destination.md") => {
    await followLink({ store, group: store.focusedGroup, tab: store.activeTab?.id, layout: "desktop", vault: "v", from: store.activeTab?.note ?? "", resolve: async () => ({ note, title: null }) }, {
      target: note, anchorKind, anchor, intent: "here", resolved: false,
    });
    flushSync();
  };
  return { store, target, pending, scrolled, navigate, opens: () => opens,
    cleanup: () => { HTMLElement.prototype.scrollIntoView = previous; vi.unstubAllGlobals(); } };
}

describe("following anchors into a real note pane", () => {
  it.each([
    ["heading", "  CAFE\u0301 GOALS ", "Café goals"],
    ["block", "pinned", "Pinned text"],
  ] as const)("scrolls to the %s target after a different note mounts", async (kind, anchor, visible) => {
    const app = await setup();
    try {
      await app.navigate(kind, anchor);
      await vi.waitFor(() => expect(app.scrolled.at(-1)?.textContent).toBe(visible));
      expect(app.store.activeTab?.note).toBe("Destination.md");
    } finally { app.cleanup(); }
  });

  it("scrolls repeated same-note anchors without remounting the editor", async () => {
    const app = await setup();
    try {
      await app.navigate("heading", "Café goals", "Source.md");
      await vi.waitFor(() => expect(app.scrolled.at(-1)?.textContent).toBe("Café goals"));
      await app.navigate("block", "pinned", "Source.md");
      await vi.waitFor(() => expect(app.scrolled.at(-1)?.textContent).toBe("Pinned text"));
      expect(app.opens()).toBe(1);
    } finally { app.cleanup(); }
  });

  it("waits for the note body to arrive rather than dropping the anchor", async () => {
    const app = await setup(true);
    try {
      await app.navigate("block", "pinned");
      await vi.waitFor(() => expect(app.pending).toHaveLength(1));
      expect(app.scrolled).toHaveLength(0);
      const doc = app.pending[0];
      if (doc === undefined) throw new Error("missing pending replica");
      applyUpdate(doc, await updateFromMarkdown(text));
      await vi.waitFor(() => expect(app.scrolled.at(-1)?.textContent).toBe("Pinned text"));
    } finally { app.cleanup(); }
  });

  it("does not scroll stale targets after navigation", async () => {
    const app = await setup();
    try {
      await app.navigate("block", "absent", "Source.md");
      const editor = (app.target.querySelector(".tiptap") as HTMLElement & { editor?: Editor })?.editor;
      expect(editor).toBeInstanceOf(Editor);
      await app.navigate("heading", "Café goals");
      await vi.waitFor(() => expect(app.scrolled.at(-1)?.textContent).toBe("Café goals"));
      expect(app.scrolled).toHaveLength(1);
    } finally { app.cleanup(); }
  });
});
