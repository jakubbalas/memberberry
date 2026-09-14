// @vitest-environment jsdom

import { mount, unmount } from "svelte";
import { expect, it, vi } from "vitest";
import Home from "./Home.svelte";
import { NoteCatalog } from "./note-catalog.svelte.js";

it.each([
  { path: "Folder/My note.md", title: "My note", label: "Folder / My note" },
  { path: "Folder/My note.md", title: null, label: "Folder / My note" },
  { path: "Projects/Planning/file.md", title: "Roadmap", label: "Projects/Planning / Roadmap" },
  { path: "My note.md", title: "My note", label: "My note" },
  { path: "My note.md", title: null, label: "My note" },
])("shows $label and opens $path", async ({ path, title, label }) => {
  const catalog = new NoteCatalog({
    vault: "personal",
    load: async () => ({ kind: "ok", notes: [{ path, title, conflicts: 0 }] }),
    replica: async () => undefined,
  });
  await catalog.refresh();
  const target = document.createElement("div");
  const onopen = vi.fn();
  const component = mount(Home, { target, props: { catalog, onopen, oncreate: vi.fn() } });
  try {
    const button = target.querySelector<HTMLButtonElement>(".home-notes li button");
    expect(button?.textContent?.trim()).toBe(label);
    button?.click();
    expect(onopen).toHaveBeenCalledWith(path);
  } finally {
    await unmount(component);
  }
});
