// @vitest-environment jsdom
import { mount, tick, unmount } from "svelte";
import { expect, it, vi } from "vitest";
import NoteTree from "./NoteTree.svelte";
import { NoteCatalog } from "./note-catalog.svelte.js";
import { Bookmarks } from "./bookmarks.svelte.js";

it("gives empty folders an exact row name separate from the folder menu", async () => {
  const catalog = new NoteCatalog({ vault: "personal", load: async () => ({ kind: "ok", notes: [] }), replica: async () => undefined });
  await catalog.refresh();
  const bookmarks = new Bookmarks({ vault: "personal", fetch: async () => new Response("[]") });
  const target = document.createElement("div");
  const app = mount(NoteTree, { target, props: { catalog, bookmarks, emptyFolders: ["Projects/Empty"], onopen: vi.fn(), onmove: async () => undefined } });
  try {
    await tick();
    const row = target.querySelector<HTMLElement>('[role="treeitem"][title="Projects"]');
    expect(row?.getAttribute("aria-label")).toBe("Projects");
    const menu = target.querySelector<HTMLButtonElement>('[aria-label="Folder actions for Projects"]');
    expect(menu).not.toBeNull();
    menu?.click(); await tick();
    expect(row?.getAttribute("aria-expanded")).toBe("false");
    row?.click(); await tick();
    expect(target.querySelector('[role="treeitem"][title="Projects/Empty"]')).not.toBeNull();
  } finally { await unmount(app); }
});
