// @vitest-environment jsdom

/**
 * The tree's offline affordances in the desktop app (`SPEC.md` §7.6.10): the context-menu
 * entries, the downloaded mark, and greyed notes while the server is away. The tree is
 * mounted on its own; the rules behind the entries are in `device-offline.test.ts`.
 */

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";

import NoteTree from "./NoteTree.svelte";
import { Bookmarks } from "./bookmarks.svelte.js";
import type { OfflineAction, OfflineSnapshot } from "./device-offline.js";
import { NoteCatalog } from "./note-catalog.svelte.js";

let app: ReturnType<typeof mount> | undefined;
afterEach(() => {
  if (app !== undefined) void unmount(app);
  app = undefined;
  document.body.innerHTML = "";
});

async function tree(offline: OfflineSnapshot | undefined, applied: OfflineAction[] = []): Promise<HTMLElement> {
  const target = document.createElement("div");
  document.body.append(target);
  const catalog = new NoteCatalog({
    vault: "work",
    load: async () => ({
      kind: "ok",
      notes: [
        { path: "Hello.md", title: "Hello", conflicts: 0 },
        { path: "Plan.md", title: "Plan", conflicts: 0 },
      ],
    }),
    replica: async () => undefined,
  });
  await catalog.refresh();
  const bookmarks = new Bookmarks({
    vault: "work",
    fetch: (async () => new Response("[]")) as unknown as typeof globalThis.fetch,
    setTimer: (run) => {
      run();
      return 0;
    },
    clearTimer: () => undefined,
  });
  app = mount(NoteTree, {
    target,
    props: { catalog, bookmarks, onopen: () => undefined, offline, onoffline: (action: OfflineAction) => applied.push(action) },
  });
  await tick();
  return target;
}

function row(target: HTMLElement, label: string): HTMLElement {
  const found = target.querySelector<HTMLElement>(`[role="treeitem"][aria-label="${label}"]`);
  if (found === null) throw new Error(`no row ${label}`);
  return found;
}

async function menuFor(target: HTMLElement, label: string): Promise<string[]> {
  row(target, label).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  await tick();
  return [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((item) => item.textContent ?? "");
}

const online: OfflineSnapshot = {
  online: true,
  pins: { vault: false, folders: [], notes: ["Hello.md"] },
  downloaded: ["Hello.md"],
  held: [],
  recovered: [],
};

describe("offline in the tree", () => {
  it("offers to make a note available offline", async () => {
    const target = await tree(online);
    expect(await menuFor(target, "Plan")).toContain("Make available offline");
  });

  it("offers online only for a downloaded note", async () => {
    const target = await tree(online);
    expect(await menuFor(target, "Hello")).toContain("Online only");
  });

  it("hands the chosen entry to the workspace", async () => {
    const applied: OfflineAction[] = [];
    const target = await tree(online, applied);
    await menuFor(target, "Plan");
    const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === "Make available offline");
    item?.click();
    expect(applied).toEqual([{ label: "Make available offline", kind: "note", path: "Plan.md", offline: true }]);
  });

  it("marks a downloaded note", async () => {
    const target = await tree(online);
    expect(row(target, "Hello").querySelector(".tree-offline")).not.toBeNull();
  });

  it("greys a note that is not on this device while the server is away", async () => {
    const target = await tree({ ...online, online: false });
    expect([row(target, "Plan").dataset["unavailable"], row(target, "Hello").dataset["unavailable"]]).toEqual(["true", "false"]);
  });

  it("offers nothing offline-related outside the desktop app", async () => {
    const target = await tree(undefined);
    expect(await menuFor(target, "Plan")).not.toContain("Make available offline");
  });
});
