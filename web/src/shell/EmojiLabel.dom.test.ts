// @vitest-environment jsdom
import { mount, unmount } from "svelte";
import { expect, it, vi } from "vitest";
import NoteTree from "./NoteTree.svelte";
import { NoteCatalog } from "./note-catalog.svelte.js";
import { Bookmarks } from "./bookmarks.svelte.js";
vi.mock("../emoji-catalog.js", () => ({ emojiCatalog: async () => [{ shortcode: "tada", glyph: "🎉", aliases: ["party"], category: "activities", supportsSkinTone: false }] }));
it("renders folder shortcodes as glyphs while opening the original path", async () => {
  const target = document.createElement("div"); document.body.append(target);
  const request: typeof fetch = async () => new Response("[]");
  const catalog = new NoteCatalog({ vault: "personal", load: async () => ({ kind: "ok", notes: [] }), replica: async () => undefined });
  const bookmarks = new Bookmarks({ vault: "personal", fetch: request });
  const onopenfolder = vi.fn();
  const app = mount(NoteTree, { target, props: { catalog, bookmarks, emptyFolders: [":tada: Party", ":missing: Unknown"], onopen: vi.fn(), onopenfolder } });
  try {
    await vi.waitFor(() => expect(target.querySelector('.tree-label')?.textContent).toBe(":missing: Unknown"));
    await vi.waitFor(() => expect(target.textContent).toContain("🎉 Party"));
    const row = target.querySelector<HTMLElement>('[title=":tada: Party"]');
    expect(row?.getAttribute("aria-label")).toBe("🎉 Party");
    row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await vi.waitFor(() => expect(target.querySelector('[role="menuitem"]')).not.toBeNull());
    [...target.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(b => b.textContent === "Open in main panel")?.click();
    expect(onopenfolder).toHaveBeenCalledWith(":tada: Party");
  } finally { await unmount(app); target.remove(); }
});
