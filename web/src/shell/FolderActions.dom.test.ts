// @vitest-environment jsdom
import { mount, tick, unmount } from "svelte";
import { beforeEach, expect, it, vi } from "vitest";
import NoteTree from "./NoteTree.svelte";
import { NoteCatalog } from "./note-catalog.svelte.js";
import { Bookmarks } from "./bookmarks.svelte.js";

beforeEach(() => {
  document.body.innerHTML = "";
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});

async function render(empty = false, parent = "") {
  const catalog = new NoteCatalog({ vault: "v", load: async () => ({ kind: "ok", notes: empty ? [] : [{ path: `${parent}ملاحظات ✨/Note.md`, title: "Note", conflicts: 0 }] }), replica: async () => undefined });
  await catalog.refresh();
  const target = document.createElement("div"); document.body.append(target);
  const onmove = vi.fn(async () => undefined as string | undefined);
  const ondeletefolder = vi.fn(async () => undefined as string | undefined);
  const app = mount(NoteTree, { target, props: { catalog, bookmarks: new Bookmarks({ vault: "v", fetch: async () => new Response("[]") }), emptyFolders: empty ? [`${parent}ملاحظات ✨`] : [], onopen: vi.fn(), onmove, ondeletefolder } });
  await tick();
  if (parent !== "") {
    target.querySelector<HTMLElement>('[role="treeitem"]')?.click(); await tick();
  }
  target.querySelector(`[role="treeitem"][title="${parent}ملاحظات ✨"]`)?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  await tick();
  const action = (name: string) => [...target.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent?.trim() === name);
  return { target, app, onmove, ondeletefolder, action };
}

it("renames a folder from its right-click menu without changing its parent", async () => {
  const view = await render(false, "Parent/");
  try {
    expect(view.action("Rename")).toBeDefined();
    view.action("Rename")?.click(); await tick();
    const input = view.target.querySelector<HTMLInputElement>('dialog input');
    expect(input?.value).toBe("ملاحظات ✨");
    if (input) { input.value = "Renamed 📚"; input.dispatchEvent(new Event("input", { bubbles: true })); }
    view.target.querySelector('dialog form')?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    expect(view.onmove).toHaveBeenCalledWith("Parent/ملاحظات ✨", "Parent/Renamed 📚", "folder");
  } finally { await unmount(view.app); }
});

it("requires the exact folder name before deleting a nonempty folder", async () => {
  const view = await render();
  try {
    expect(view.action("Delete")).toBeDefined();
    view.action("Delete")?.click(); await tick();
    const form = view.target.querySelector('dialog form');
    const input = view.target.querySelector<HTMLInputElement>('dialog input');
    const confirm = view.target.querySelector<HTMLButtonElement>('dialog [type="submit"]');
    expect(document.activeElement).toBe(input);
    expect(confirm?.disabled).toBe(true);
    for (const value of ["", "wrong", "ملاحظات ✨ "]) {
      if (input) { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); }
      await tick();
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await tick();
      expect(view.ondeletefolder).not.toHaveBeenCalled();
    }
    if (input) { input.value = "ملاحظات ✨"; input.dispatchEvent(new Event("input", { bubbles: true })); }
    await tick();
    expect(confirm?.disabled).toBe(false);
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await tick();
    expect(view.ondeletefolder).toHaveBeenCalledExactlyOnceWith("ملاحظات ✨", "ملاحظات ✨");
  } finally { await unmount(view.app); }
});

it("deletes a known empty folder without asking for a typed name", async () => {
  const view = await render(true);
  try {
    expect(view.action("Delete")).toBeDefined();
    view.action("Delete")?.click(); await tick();
    expect(view.ondeletefolder).toHaveBeenCalledExactlyOnceWith("ملاحظات ✨", undefined);
    expect(view.target.querySelector('dialog[open]')).toBeNull();
  } finally { await unmount(view.app); }
});

it("keeps a failed delete visible for correction and supports cancellation", async () => {
  const view = await render();
  try {
    view.ondeletefolder.mockResolvedValue("The folder could not be deleted.");
    expect(view.action("Delete")).toBeDefined();
    view.action("Delete")?.click(); await tick();
    const input = view.target.querySelector<HTMLInputElement>('dialog input');
    if (input) { input.value = "ملاحظات ✨"; input.dispatchEvent(new Event("input", { bubbles: true })); }
    await tick();
    view.target.querySelector('dialog form')?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await tick();
    await tick();
    expect(view.target.querySelector('[role="alert"]')?.textContent).toBe("The folder could not be deleted.");
    view.target.querySelector<HTMLButtonElement>('dialog [type="button"]')?.click(); await tick();
    expect(view.target.querySelector('dialog[open]')).toBeNull();
  } finally { await unmount(view.app); }
});


it("refuses invalid folder renames and retains a server refusal", async () => {
  const view = await render();
  try {
    view.onmove.mockResolvedValue("The destination is occupied.");
    view.action("Rename")?.click(); await tick();
    const input = view.target.querySelector<HTMLInputElement>('dialog input');
    const submit = async (value: string) => {
      if (input) { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); }
      await tick();
      view.target.querySelector('dialog form')?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await tick(); await tick();
    };
    for (const value of ["", "../escape", "Other/Folder", "ملاحظات ✨"]) await submit(value);
    expect(view.onmove).not.toHaveBeenCalled();
    await submit("Taken");
    expect(view.target.querySelector('[role="alert"]')?.textContent).toBe("The destination is occupied.");
    expect(view.target.querySelector('dialog[open]')).not.toBeNull();
  } finally { await unmount(view.app); }
});

it("upgrades a stale empty-folder deletion to the name confirmation dialog", async () => {
  const view = await render(true);
  try {
    view.ondeletefolder.mockResolvedValue("The folder is not empty. Type its name to confirm deletion.");
    view.action("Delete")?.click(); await tick(); await tick();
    expect(view.target.querySelector('dialog[open]')?.getAttribute("aria-label")).toBe("Delete folder");
    expect(view.target.querySelector<HTMLInputElement>('dialog input')?.value).toBe("");
    expect(view.target.querySelector<HTMLButtonElement>('dialog [type="submit"]')?.disabled).toBe(true);
  } finally { await unmount(view.app); }
});


it("prevents duplicate deletion and Escape dismissal while the request is pending", async () => {
  const view = await render();
  let finish: ((error: string | undefined) => void) | undefined;
  view.ondeletefolder.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  try {
    view.action("Delete")?.click(); await tick();
    const input = view.target.querySelector<HTMLInputElement>('dialog input');
    if (input) { input.value = "ملاحظات ✨"; input.dispatchEvent(new Event("input", { bubbles: true })); }
    await tick();
    const form = view.target.querySelector('dialog form');
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await tick();
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await tick();
    expect(view.ondeletefolder).toHaveBeenCalledTimes(1);
    const cancel = new Event("cancel", { cancelable: true });
    view.target.querySelector('dialog')?.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(input?.disabled).toBe(true);
    finish?.(undefined); await tick(); await tick();
    expect(view.target.querySelector('dialog[open]')).toBeNull();
  } finally { finish?.(undefined); await unmount(view.app); }
});
