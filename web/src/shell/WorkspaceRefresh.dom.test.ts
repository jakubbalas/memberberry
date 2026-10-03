// @vitest-environment jsdom
/** Lifecycle-driven discovery must not require a page reload or poll the whole vault. */
import { mount, tick, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import Workspace from "./Workspace.svelte";
import { NoteCatalog } from "./note-catalog.svelte.js";
import { WorkspaceStore, sessionIds } from "./workspace-store.svelte.js";
import { createWorkspace } from "./workspace.js";

const apps: ReturnType<typeof mount>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await unmount(app);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  document.body.replaceChildren();
});
const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
  await tick();
};
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("uninitialized deferred"); };
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function render(session = true, firstFolders?: Promise<Response>) {
  let notes = [{ path: "Existing.md", title: "Existing", conflicts: 0 }];
  let folders = ["Existing folder"];
  const load = vi.fn(async () => ({ kind: "ok" as const, notes }));
  const folderLoad = vi.fn(async () => new Response(JSON.stringify({ folders })));
  if (firstFolders !== undefined) folderLoad.mockReturnValueOnce(firstFolders);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/folders") ? folderLoad() : new Response("[]")));
  const catalog = new NoteCatalog({ vault: "personal", load, replica: async () => undefined });
  const ids = sessionIds();
  const store = new WorkspaceStore({ initial: createWorkspace("personal", ids), ids });
  const target = document.createElement("div"); document.body.append(target);
  const app = mount(Workspace, { target, props: {
    store, catalog, home: true, mode: "desktop",
    ...(session ? { session: { vault: "personal", user: "alice" } } : {}),
    chrome: { getItem: () => null, setItem: () => undefined },
    open: async () => ({ destroy: async () => undefined }),
  } });
  apps.push(app);
  await flush();
  return { target, app, load, folderLoad, catalog, change: () => {
    notes = [...notes, { path: "Other device.md", title: "Other device", conflicts: 0 }];
    folders = [...folders, "Other device folder"];
  } };
}

it.each(["focus", "online", "visibilitychange"])("discovers remote notes and folders on %s", async (event) => {
  const view = await render();
  expect(view.target.querySelector('[role="treeitem"][title="Existing.md"]')).not.toBeNull();
  view.change();
  if (event === "visibilitychange") document.dispatchEvent(new Event(event));
  else window.dispatchEvent(new Event(event));
  await flush();
  expect(view.target.querySelector('[role="treeitem"][title="Other device.md"]')).not.toBeNull();
  expect(view.target.querySelector('[role="treeitem"][title="Other device folder"]')).not.toBeNull();
  expect(view.load).toHaveBeenCalledTimes(2);
  expect(view.folderLoad).toHaveBeenCalledTimes(2);
});

it("coalesces a resume burst and events during its pending requests without polling", async () => {
  vi.useFakeTimers();
  const view = await render();
  const response = deferred<Response>();
  view.folderLoad.mockReturnValueOnce(response.promise);
  window.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("online"));
  await flush();
  window.dispatchEvent(new Event("focus"));
  await flush();
  expect(view.load).toHaveBeenCalledTimes(2);
  expect(view.folderLoad).toHaveBeenCalledTimes(2);
  response.resolve(new Response(JSON.stringify({ folders: [] })));
  await flush();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(view.load).toHaveBeenCalledTimes(2);
  expect(view.folderLoad).toHaveBeenCalledTimes(2);
});

it("ignores hidden visibility changes and element focus events", async () => {
  const view = await render();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));
  view.target.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
  await flush();
  expect(view.load).toHaveBeenCalledTimes(1);
  expect(view.folderLoad).toHaveBeenCalledTimes(1);
});

it("does not refresh a local-only workspace on browser lifecycle events", async () => {
  const view = await render(false);
  window.dispatchEvent(new Event("focus"));
  window.dispatchEvent(new Event("online"));
  document.dispatchEvent(new Event("visibilitychange"));
  await flush();
  expect(view.load).toHaveBeenCalledTimes(1);
  expect(view.folderLoad).not.toHaveBeenCalled();
});

it("removes live listeners and cancels an already queued refresh on unmount", async () => {
  const view = await render();
  window.dispatchEvent(new Event("focus")); await flush();
  expect(view.load).toHaveBeenCalledTimes(2);
  window.dispatchEvent(new Event("focus"));
  await unmount(view.app); apps.splice(apps.indexOf(view.app), 1);
  window.dispatchEvent(new Event("focus"));
  window.dispatchEvent(new Event("online"));
  document.dispatchEvent(new Event("visibilitychange"));
  await flush();
  expect(view.load).toHaveBeenCalledTimes(2);
  expect(view.folderLoad).toHaveBeenCalledTimes(2);
});

it("keeps folder contents loading until both independent lists finish refreshing", async () => {
  const view = await render();
  view.target.querySelector<HTMLButtonElement>('[aria-label="Folder actions for Existing folder"]')?.click();
  await flush();
  [...view.target.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === "Open in main panel")?.click();
  await flush();
  expect(view.target.querySelector(".folder-contents")?.textContent).toContain("This folder is empty.");
  const response = deferred<Response>();
  view.folderLoad.mockReturnValueOnce(response.promise);
  window.dispatchEvent(new Event("online")); await flush();
  expect(view.catalog.ready).toBe(true);
  expect(view.target.querySelector('.folder-contents [role="status"]')?.textContent).toBe("Loading folder contents…");
  response.resolve(new Response(JSON.stringify({ folders: [] }))); await flush();
  expect(view.target.querySelector('.folder-contents [role="status"]')?.textContent).toBe("This folder is no longer available.");
});

it("clears denied folders and cannot restore them from an older successful response", async () => {
  const first = deferred<Response>();
  // Keep the mount's folder read pending, then deny the newer lifecycle read.
  const view = await render(true, first.promise);
  view.folderLoad.mockResolvedValueOnce(new Response(null, { status: 403 }));
  window.dispatchEvent(new Event("focus")); await flush();
  expect(view.target.textContent).toContain("Empty folders are unavailable.");
  first.resolve(new Response(JSON.stringify({ folders: ["Revoked folder"] })));
  await flush();
  expect(view.target.querySelector('[role="treeitem"][title="Revoked folder"]')).toBeNull();
  expect(view.target.textContent).toContain("Empty folders are unavailable.");
});

it("removes previously displayed empty folders when the server denies their refresh", async () => {
  const view = await render();
  expect(view.target.querySelector('[role="treeitem"][title="Existing folder"]')).not.toBeNull();
  view.folderLoad.mockResolvedValueOnce(new Response(null, { status: 404 }));
  window.dispatchEvent(new Event("online")); await flush();
  expect(view.target.querySelector('[role="treeitem"][title="Existing folder"]')).toBeNull();
});
