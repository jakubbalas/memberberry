// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mount, tick, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import Workspace from "./Workspace.svelte";
import { NoteCatalog } from "./note-catalog.svelte.js";
import { Bookmarks } from "./bookmarks.svelte.js";
import { WorkspaceStore, sessionIds } from "./workspace-store.svelte.js";
import { createWorkspace } from "./workspace.js";
import type { OpenNoteSurfaceOptions } from "./note-surface.js";
import type { createNote } from "./create.js";

const navigationCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "navigation.css"), "utf8");

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
  await tick();
};
const memory = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function render(options: { chrome?: Pick<Storage, "getItem" | "setItem">; user?: string; mode?: "desktop" | "mobile"; noNotes?: boolean; createNote?: typeof createNote } = {}) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).endsWith("/folders") ? { folders: ["Empty/Nested", "Projects/Empty"] } : []))));
  const ids = sessionIds();
  const store = new WorkspaceStore({ initial: createWorkspace("personal", ids), ids });
  const catalog = new NoteCatalog({ vault: "personal", load: async () => ({ kind: "ok", notes: options.noNotes ? [] : [{ path: "Projects/raw.md", title: "Readable heading", conflicts: 0 }] }), replica: async () => undefined });
  const bookmarks = new Bookmarks({ vault: "personal", fetch: async () => new Response(JSON.stringify(options.noNotes ? [] : ["Projects/raw.md"])) });
  const target = document.createElement("div");
  document.body.append(target);
  const opened: string[] = [];
  const app = mount(Workspace, { target, props: { createNote: options.createNote, home: true, store, catalog, bookmarks, session: { user: options.user ?? "alice", vault: "personal" }, mode: options.mode ?? "desktop", chrome: options.chrome ?? memory(), open: async (options: OpenNoteSurfaceOptions) => { opened.push(options.bootstrap?.note ?? ""); return { destroy: async () => undefined }; } } });
  await flush();
  return { target, store, opened, teardown: () => unmount(app) };
}
function button(target: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...target.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent?.trim() === label);
}

it("labels folders independently of actions and renders nested empty folders without notes", async () => {
  const view = await render({ noNotes: true });
  try {
    const row = view.target.querySelector<HTMLElement>('[role="treeitem"][title="Empty"]');
    expect(row?.getAttribute("aria-label")).toBe("Empty");
    row?.click(); await flush();
    expect(view.target.querySelector('[role="treeitem"][title="Empty/Nested"]')).not.toBeNull();
  } finally { await view.teardown(); }
});

it("opens folder contents and nested empty folders without opening an editor or creating a tab", async () => {
  const view = await render();
  try {
    button(view.target, "Folder actions for Projects")?.click(); await flush();
    expect(button(view.target, "Open in main panel")).toBeDefined();
    button(view.target, "Open in main panel")?.click(); await flush();
    expect(view.target.querySelector(".folder-contents h1")?.textContent).toBe("Projects");
    expect(view.target.querySelector(".folder-contents")?.textContent).toContain("Readable heading");
    expect(view.opened).toEqual([]);
    expect(view.store.tabs).toEqual([]);
    const folder = view.target.querySelector<HTMLElement>(".folder-contents");
    button(folder ?? view.target, "Open folder Empty")?.click(); await flush();
    expect(view.target.querySelector(".folder-contents")?.textContent).toContain("This folder is empty.");
    button(view.target, "Up to Projects")?.click(); await flush();
    button(view.target.querySelector<HTMLElement>(".folder-contents") ?? view.target, "Readable heading")?.click(); await flush();
    expect(view.store.activeTab?.note).toBe("Projects/raw.md");
    expect(view.target.querySelector(".folder-contents")).toBeNull();
  } finally { await view.teardown(); }
});

it("remembers Show filenames for tree and bookmarks only within this user and vault", async () => {
  const chrome = memory();
  let view = await render({ chrome });
  try {
    expect(view.target.querySelector('input[aria-label="Show filenames"]')).toBeNull();
    const settings = button(view.target, "File settings");
    expect(settings).toBeDefined();
    expect(settings?.previousElementSibling?.getAttribute("aria-label")).toBe("New folder");
    settings?.click(); await flush();
    const checkbox = view.target.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]');
    expect(checkbox?.textContent?.trim()).toBe("Show filenames");
    expect(checkbox?.getAttribute("aria-checked")).toBe("false");
    checkbox?.click(); await flush();
    expect(view.target.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(settings);
    expect(view.target.querySelector(".bookmark-list .tree-label")?.textContent).toBe("raw.md");
    view.target.querySelector<HTMLElement>('[role="treeitem"][title="Projects"]')?.click(); await flush();
    expect(view.target.querySelector('[role="treeitem"][title="Projects/raw.md"] .tree-label')?.textContent).toBe("raw.md");
    await view.teardown(); view = await render({ chrome });
    button(view.target, "File settings")?.click(); await flush();
    expect(view.target.querySelector('[role="menuitemcheckbox"]')?.getAttribute("aria-checked")).toBe("true");
    await view.teardown(); view = await render({ chrome, user: "bob" });
    button(view.target, "File settings")?.click(); await flush();
    expect(view.target.querySelector('[role="menuitemcheckbox"]')?.getAttribute("aria-checked")).toBe("false");
  } finally { await view.teardown(); }
});

it("offers keyboard resizing for both desktop panels and remembers widths", async () => {
  const chrome = memory();
  let view = await render({ chrome });
  try {
    button(view.target, "Show Context")?.click(); await flush();
    for (const [name, key] of [["Navigation", "ArrowRight"], ["Context", "ArrowLeft"]] as const) {
      const separator = view.target.querySelector<HTMLElement>(`[role="separator"][aria-label="Resize ${name}"]`);
      expect(separator).not.toBeNull();
      const before = Number(separator?.getAttribute("aria-valuenow"));
      separator?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); await flush();
      expect(Number(separator?.getAttribute("aria-valuenow"))).toBeGreaterThan(before);
    }
    const width = view.target.querySelector('[aria-label="Resize Navigation"]')?.getAttribute("aria-valuenow");
    await view.teardown(); view = await render({ chrome });
    expect(view.target.querySelector('[aria-label="Resize Navigation"]')?.getAttribute("aria-valuenow")).toBe(width);
  } finally { await view.teardown(); }
});

async function submitNewNote(target: HTMLElement): Promise<void> {
  if (typeof HTMLDialogElement.prototype.showModal !== "function") {
    HTMLDialogElement.prototype.showModal = function (): void { this.open = true; };
    HTMLDialogElement.prototype.close = function (): void { this.open = false; this.dispatchEvent(new Event("close")); };
  }
  const navigation = target.querySelector<HTMLElement>("#sidebar-left");
  button(navigation ?? target, "New note")?.click(); await flush();
  const dialog = target.querySelector<HTMLDialogElement>('dialog[aria-label="New note"]');
  const input = dialog?.querySelector<HTMLInputElement>("input");
  if (input === null || input === undefined) throw new Error("missing new-note prompt");
  input.value = "Created on mobile"; input.dispatchEvent(new Event("input", { bubbles: true }));
  dialog?.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await flush();
}

it.each([false, true])("closes the mobile navigation overlay after successful creation (folder view: %s)", async (folderView) => {
  const view = await render({ mode: "mobile", createNote: async (_vault, path) => ({ ok: { path } }) });
  try {
    button(view.target, "Show Navigation")?.click(); await flush();
    if (folderView) {
      button(view.target, "Folder actions for Empty")?.click(); await flush();
      button(view.target, "Open in main panel")?.click(); await flush();
      expect(view.target.querySelector(".folder-contents")).not.toBeNull();
      button(view.target, "Show Navigation")?.click(); await flush();
    }
    expect(view.target.querySelector<HTMLElement>("#sidebar-left")?.hidden).toBe(false);
    await submitNewNote(view.target);
    expect(view.store.activeTab?.note).toBe("Created on mobile.md");
    expect(view.target.querySelector(".folder-contents")).toBeNull();
    expect(view.target.querySelector<HTMLElement>("#sidebar-left")?.hidden).toBe(true);
    expect(view.opened).toEqual(["Created on mobile.md"]);
  } finally { await view.teardown(); }
});

it("keeps the creation dialog and navigation available after a refused mobile create", async () => {
  const view = await render({ mode: "mobile", createNote: async () => ({ refused: "You cannot create a note here." }) });
  try {
    button(view.target, "Show Navigation")?.click(); await flush();
    await submitNewNote(view.target);
    expect(view.target.querySelector<HTMLElement>("#sidebar-left")?.hidden).toBe(false);
    expect(view.target.querySelector('dialog[aria-label="New note"] [role="alert"]')?.textContent).toBe("You cannot create a note here.");
    expect(view.store.tabs).toEqual([]);
  } finally { await view.teardown(); }
});

it("removes only sidebar-body top padding without changing the shared spacing scale", () => {
  const style = document.createElement("style");
  style.textContent = `.sidebar-body { padding: 16px 12px 24px; } ${navigationCss}`;
  const body = document.createElement("div"); body.className = "sidebar-body";
  const sidebar = document.createElement("aside"); sidebar.className = "sidebar"; sidebar.append(body);
  document.body.append(style, sidebar);
  const computed = getComputedStyle(body);
  expect([computed.paddingTop, computed.paddingRight, computed.paddingBottom, computed.paddingLeft]).toEqual(["0px", "12px", "24px", "12px"]);
});

it("omits mobile resizing handles and closes navigation after opening folder contents", async () => {
  const view = await render({ mode: "mobile" });
  try {
    expect(view.target.querySelector('[aria-label="Resize Navigation"]')).toBeNull();
    button(view.target, "Show Navigation")?.click(); await flush();
    button(view.target, "Folder actions for Empty")?.click(); await flush();
    button(view.target, "Open in main panel")?.click(); await flush();
    expect(view.target.querySelector(".folder-contents h1")?.textContent).toBe("Empty");
    expect(view.target.querySelector<HTMLElement>("#sidebar-left")?.hidden).toBe(true);
  } finally { await view.teardown(); }
});
