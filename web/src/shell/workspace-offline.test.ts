import { expect, it } from "vitest";
import { createWorkspaceTransport } from "./workspace-sync.js";
import { counterIds, createWorkspace, openTab, tabs } from "./workspace.js";
import { USER_KEY } from "./bootstrap.js";

function storage() {
  const values = new Map<string, string>([[USER_KEY, "alice"]]);
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
const unavailable: typeof fetch = async () => { throw new TypeError("offline"); };
const layout = () => openTab(createWorkspace("personal", counterIds()), { note: "Welcome.md" }, counterIds("tab-"));

it("restores the latest workspace offline before a debounced network save", async () => {
  const store = storage();
  const writer = createWorkspaceTransport({ vault: "personal", device: "phone", ids: counterIds(), storage: store, fetch: unavailable });
  writer.save(layout());
  writer.destroy();
  const reader = createWorkspaceTransport({ vault: "personal", device: "phone", ids: counterIds(), storage: store, fetch: unavailable });
  const restored = await reader.load();
  expect(tabs(restored.workspace.root).map(tab => tab.note)).toEqual(["Welcome.md"]);
  reader.destroy();
});

it.each([401, 403, 404])("does not replay cached workspace names after an authoritative %s", async status => {
  const store = storage();
  const writer = createWorkspaceTransport({ vault: "personal", device: "phone", ids: counterIds(), storage: store, fetch: unavailable });
  writer.save(layout());
  writer.destroy();
  const refused = createWorkspaceTransport({ vault: "personal", device: "phone", ids: counterIds(), storage: store, fetch: async () => new Response("", { status }) });
  expect(tabs((await refused.load()).workspace.root)).toEqual([]);
  refused.destroy();
  const offline = createWorkspaceTransport({ vault: "personal", device: "phone", ids: counterIds(), storage: store, fetch: unavailable });
  expect(tabs((await offline.load()).workspace.root)).toEqual([]);
  offline.destroy();
});

it("does not restore a different user's workspace in the same browser", async () => {
  const store = storage();
  const writer = createWorkspaceTransport({ vault: "personal", device: "phone", ids: counterIds(), storage: store, fetch: unavailable });
  writer.save(layout());
  writer.destroy();
  store.setItem(USER_KEY, "bob");
  const reader = createWorkspaceTransport({ vault: "personal", device: "phone", ids: counterIds(), storage: store, fetch: unavailable });
  expect(tabs((await reader.load()).workspace.root)).toEqual([]);
  reader.destroy();
});
