// @vitest-environment jsdom
import { mount, tick, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import FolderContents from "./FolderContents.svelte";
import { NoteCatalog } from "./note-catalog.svelte.js";
import type { CatalogAnswer } from "./catalog.js";

const apps: ReturnType<typeof mount>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await unmount(app); document.body.replaceChildren(); });
async function render(catalog: NoteCatalog, path = "Projects", emptyFolders: readonly string[] = []) {
  const target = document.createElement("div"); document.body.append(target);
  const onfolder = vi.fn(); const onopen = vi.fn(); const onclose = vi.fn();
  const app = mount(FolderContents, { target, props: { path, catalog, emptyFolders, onfolder, onopen, onclose } });
  apps.push(app); await tick();
  return { target, onfolder, onopen, onclose };
}

it("requests a not-yet-loaded catalog and shows loading until its contents arrive", async () => {
  let resolve: (answer: CatalogAnswer) => void = () => { throw new Error("uninitialized request"); };
  const pending = new Promise<CatalogAnswer>((done) => { resolve = done; });
  const load = vi.fn(() => pending);
  const catalog = new NoteCatalog({ vault: "personal", load, replica: async () => undefined });
  const view = await render(catalog);
  expect(view.target.querySelector('[role="status"]')?.textContent).toBe("Loading folder contents…");
  expect(load).toHaveBeenCalledTimes(1);
  resolve({ kind: "ok", notes: [{ path: "Projects/Plan.md", title: "Plan", conflicts: 0 }] });
  await vi.waitFor(() => expect(catalog.ready).toBe(true)); await tick();
  expect(view.target.querySelector('[role="status"]')).toBeNull();
  expect(view.target.querySelector('button[title="Projects/Plan.md"]')?.textContent).toContain("Plan");
});

it("removes listed notes and reports an unavailable folder after access is denied", async () => {
  let answer: CatalogAnswer = { kind: "ok", notes: [{ path: "Projects/Private.md", title: "Private", conflicts: 0 }] };
  const catalog = new NoteCatalog({ vault: "personal", load: async () => answer, replica: async () => undefined });
  await catalog.refresh();
  const view = await render(catalog);
  expect(view.target.querySelector('button[title="Projects/Private.md"]')).not.toBeNull();
  answer = { kind: "denied" }; await catalog.refresh(); await tick();
  expect(view.target.querySelector('button[title="Projects/Private.md"]')).toBeNull();
  expect(view.target.querySelector('[role="status"]')?.textContent).toBe("This folder is no longer available.");
});

it("distinguishes an existing empty folder from a missing folder and offers parent navigation", async () => {
  const catalog = new NoteCatalog({ vault: "personal", load: async () => ({ kind: "ok", notes: [] }), replica: async () => undefined });
  await catalog.refresh();
  const view = await render(catalog, "Projects/Empty", ["Projects/Empty"]);
  expect(view.target.textContent).toContain("This folder is empty.");
  expect(document.activeElement).toBe(view.target.querySelector("h1"));
  view.target.querySelector<HTMLButtonElement>("nav button")?.click();
  expect(view.onfolder).toHaveBeenCalledWith("Projects");
  view.target.querySelector<HTMLButtonElement>('[aria-label="Close folder view"]')?.click();
  expect(view.onclose).toHaveBeenCalledTimes(1);
  expect(view.onopen).not.toHaveBeenCalled();
});
