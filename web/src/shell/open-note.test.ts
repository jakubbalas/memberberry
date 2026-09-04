/**
 * Following a link into the workspace (`SPEC.md` §8.2, §9.2).
 *
 * The store's own operations are tested in `workspace.test.ts`; what is testable here is the
 * mapping — which modifier means which placement, what happens when the layout has no room
 * for a split, and what a reference that resolves to nothing does.
 */

import { describe, expect, it } from "vitest";

import type { OpenNoteDetail } from "../editor/links.js";
import { followLink, placeNote, readResolved, resolveNote } from "./open-note.js";
import { counterIds, WorkspaceStore } from "./workspace-store.svelte.js";
import { createWorkspace, openTab } from "./workspace.js";

function storeWith(...notes: readonly string[]): WorkspaceStore {
  const ids = counterIds();
  let workspace = createWorkspace("personal", ids);
  for (const note of notes) workspace = openTab(workspace, { note }, ids);
  return new WorkspaceStore({ initial: workspace, ids });
}

/** The store's single pane and its active tab. */
function pane(store: WorkspaceStore) {
  const group = store.groups[0];
  if (group === undefined) throw new Error("a workspace always has one pane");
  return { group: group.id, tab: store.activeTab?.id, layout: "desktop" as const, store };
}

const DETAIL: OpenNoteDetail = {
  target: "Roadmap",
  anchorKind: "none",
  anchor: null,
  intent: "here",
  resolved: false,
};

describe("placing a note", () => {
  it("navigates the current tab on a plain click", () => {
    const store = storeWith("Q3.md");
    placeNote(pane(store), "Projects/Roadmap.md", "here");
    expect(store.tabs).toHaveLength(1);
    expect(store.activeTab?.note).toBe("Projects/Roadmap.md");
  });

  it("keeps the tab's history, so back returns to where the reader was", () => {
    const store = storeWith("Q3.md");
    placeNote(pane(store), "Projects/Roadmap.md", "here");
    const tab = store.activeTab;
    if (tab === undefined) throw new Error("a tab");
    store.back(tab.id);
    expect(store.activeTab?.note).toBe("Q3.md");
  });

  it("opens a new tab in the same pane for Mod-click", () => {
    const store = storeWith("Q3.md");
    placeNote(pane(store), "Projects/Roadmap.md", "tab");
    expect(store.tabs.map((tab) => tab.note)).toEqual(["Q3.md", "Projects/Roadmap.md"]);
    expect(store.groups).toHaveLength(1);
  });

  it("splits the pane for Mod-Alt-click", () => {
    const store = storeWith("Q3.md");
    placeNote(pane(store), "Projects/Roadmap.md", "split");
    expect(store.groups).toHaveLength(2);
    expect(store.tabs.map((tab) => tab.note)).toContain("Projects/Roadmap.md");
  });

  it("opens a tab instead of a split the layout has no room for", () => {
    // §8.3 caps how many panes fit, and a click that silently did nothing would look broken
    // rather than adapted.
    const store = storeWith("Q3.md");
    placeNote({ ...pane(store), layout: "mobile" }, "Projects/Roadmap.md", "split");
    expect(store.groups).toHaveLength(1);
    expect(store.tabs.map((tab) => tab.note)).toEqual(["Q3.md", "Projects/Roadmap.md"]);
  });

  it("opens a tab when there is nothing to navigate", () => {
    const store = storeWith();
    placeNote({ ...pane(store), tab: undefined }, "Projects/Roadmap.md", "here");
    expect(store.tabs.map((tab) => tab.note)).toEqual(["Projects/Roadmap.md"]);
  });
});

describe("resolving before placing", () => {
  const resolved = async () => ({ note: "Projects/Roadmap.md", title: "The Plan" });
  const nothing = async () => undefined;

  it("opens the note the server resolved the reference to", async () => {
    const store = storeWith("Q3.md");
    await followLink({ ...pane(store), vault: "v", from: "Q3.md", resolve: resolved }, DETAIL);
    expect(store.activeTab?.note).toBe("Projects/Roadmap.md");
  });

  it("does nothing when the reference resolves to nothing", async () => {
    // Which is also what a target the reader may not see looks like (§6.5), and the two must
    // stay indistinguishable here as well: no tab, no error, no name.
    const store = storeWith("Q3.md");
    await followLink({ ...pane(store), vault: "v", from: "Q3.md", resolve: nothing }, DETAIL);
    expect(store.tabs.map((tab) => tab.note)).toEqual(["Q3.md"]);
  });

  it("does not resolve a path the server already resolved", async () => {
    // An embed's jump-to-source carries the canonical identity. Resolving it again — from a
    // different note, in a vault where two notes may share a name — can land elsewhere.
    let asked = 0;
    const store = storeWith("Q3.md");
    await followLink(
      {
        ...pane(store),
        vault: "v",
        from: "Q3.md",
        resolve: async () => {
          asked += 1;
          return { note: "Archive/Roadmap.md", title: null };
        },
      },
      { ...DETAIL, target: "Projects/Roadmap.md", resolved: true },
    );
    expect(asked).toBe(0);
    expect(store.activeTab?.note).toBe("Projects/Roadmap.md");
  });

  it("resolves relative to the note the reference was written in", async () => {
    const seen: string[] = [];
    const store = storeWith("Q3.md");
    const resolve = async (_vault: string, _target: string, from: string) => {
      seen.push(from);
      return { note: "A.md", title: null };
    };
    await followLink({ ...pane(store), vault: "v", from: "Q3.md", resolve }, DETAIL);
    await followLink(
      { ...pane(store), vault: "v", from: "Q3.md", resolve },
      { ...DETAIL, from: "Projects/Roadmap.md" },
    );
    expect(seen).toEqual(["Q3.md", "Projects/Roadmap.md"]);
  });
});

describe("the request", () => {
  it("names the reference and the note it is read from", async () => {
    const urls: string[] = [];
    const fetch = async (url: RequestInfo | URL): Promise<Response> => {
      urls.push(String(url));
      return new Response(JSON.stringify({ note: "A.md", title: null }), { status: 200 });
    };
    const found = await resolveNote("personal", "../secrets", "Projects/Q3.md", {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(found).toEqual({ note: "A.md", title: null });
    expect(urls).toEqual([
      "/api/v1/vaults/personal/resolve/..%2Fsecrets?from=Projects%2FQ3.md",
    ]);
  });

  it("is undefined for a denial", async () => {
    const fetch = async (): Promise<Response> => new Response("{}", { status: 404 });
    expect(
      await resolveNote("v", "Secret", "A.md", {
        fetch: fetch as unknown as typeof globalThis.fetch,
      }),
    ).toBeUndefined();
  });

  it("is undefined rather than a rejection when the request fails", async () => {
    const fetch = (): Promise<Response> => Promise.reject(new Error("offline"));
    expect(
      await resolveNote("v", "A", "B.md", {
        fetch: fetch as unknown as typeof globalThis.fetch,
      }),
    ).toBeUndefined();
  });

  it("refuses a body of the wrong shape", () => {
    for (const body of [null, [], "x", {}, { note: "" }, { note: "A.md", title: 7 }]) {
      expect(readResolved(body)).toBeUndefined();
    }
    expect(readResolved({ note: "A.md", title: null })).toEqual({ note: "A.md", title: null });
  });
});
