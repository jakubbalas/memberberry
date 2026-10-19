// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { mountFolderVault } from "./folder-vault.js";
import { installDialogShim } from "./folder-dialog-test.js";
installDialogShim();
const html = readFileSync("add-vault.html", "utf8");
const state = { location_root: false, registration: "available", selectable: true, browsable: true };
let destroy = (): void => {};
afterEach(() => { destroy(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`Missing fixture ${id}`);
  return found as T;
}
function input(id: string, value: string): void {
  element<HTMLInputElement>(id).value = value;
  element(id).dispatchEvent(new Event("input", { bubbles: true }));
}
function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
function mount(error = "") {
  document.body.innerHTML = new DOMParser().parseFromString(html, "text/html").body.innerHTML;
  element("folder-vault").dataset["serverError"] = error;
  let slug = "";
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/vault-locations")) return response({ locations: [{ id: "projects", name: "Projects" }] });
    if (url.includes("/directories?")) {
      const path = new URL(url, "http://localhost").searchParams.get("path") ?? "";
      return response({ path, state: path === "" ? { ...state, location_root: true, selectable: false } : state,
        children: path === "" ? [{ name: "Project 日本", path: "Project 日本", state }] : [] });
    }
    if (url.endsWith("/preview")) return response({ confirmation: "a".repeat(64), expires_in_seconds: 120, mode: "existing", notes_root: "root", read_only: false, storage_check: "bounded_service_identity_probes", scope: "existing-project", recursive_markdown: true });
    if (url.endsWith("/register")) {
      const value: unknown = JSON.parse(String(init?.body));
      if (typeof value !== "object" || value === null || !("slug" in value) || typeof value.slug !== "string") throw new Error("Invalid request");
      slug = value.slug;
      return response({ slug, committed: true, directory_synced: true, audit_recorded: false, watched: true, index_ready: true, index_storage: "memory_until_restart" }, 201);
    }
    if (url.endsWith("/vaults")) return response([{ slug, name: "Notebook" }]);
    throw new Error("Unexpected request");
  });
  vi.stubGlobal("fetch", fetcher);
  destroy = mountFolderVault(element("folder-vault"));
  return fetcher;
}
async function choose(): Promise<void> {
  element<HTMLButtonElement>("choose-folder").click();
  await vi.waitFor(() => expect(element("directories").querySelector("button")).not.toBeNull());
  element("directories").querySelector("button")?.click();
  await vi.waitFor(() => expect(element<HTMLButtonElement>("select-folder").disabled).toBe(false));
  element<HTMLButtonElement>("select-folder").click();
}
function submit(): Event {
  const event = new Event("submit", { bubbles: true, cancelable: true });
  element("details").dispatchEvent(event);
  return event;
}
test("new form offers optional address and folder with a native managed-storage POST", () => {
  mount();
  expect(element<HTMLFormElement>("details").getAttribute("action")).toBe("/vaults/new");
  expect(element<HTMLInputElement>("vault-name").required).toBe(true);
  expect(element<HTMLInputElement>("vault-slug").required).toBe(false);
  expect(element<HTMLButtonElement>("preview").disabled).toBe(false);
  expect(element("folder-selection").hidden).toBe(true);
});
test("no folder and blank address submit managed creation without a folder API call", () => {
  const fetcher = mount(); input("vault-name", "Notebook");
  expect(submit().defaultPrevented).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
  expect(element<HTMLButtonElement>("preview").disabled).toBe(true);
  expect(submit().defaultPrevented).toBe(true);
});
test("invalid optional managed address retains details and focuses the address without writing", () => {
  const fetcher = mount(); input("vault-name", "Notebook"); input("vault-slug", "../invalid");
  expect(submit().defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(element("vault-slug"));
  expect(element<HTMLInputElement>("vault-name").value).toBe("Notebook");
  expect(fetcher).not.toHaveBeenCalled();
});
test("chosen folder uses the typed address without requiring generated entropy", async () => {
  const fetcher = mount(); input("vault-name", "Notebook"); input("vault-slug", "my-address"); await choose();
  vi.spyOn(crypto, "getRandomValues").mockImplementation(() => { throw new Error("Entropy unavailable"); });
  expect(submit().defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(element("result-heading").textContent).toBe("Vault registered"));
  const posts = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
  expect(posts).toHaveLength(2);
  expect(JSON.parse(String(posts[0]?.[1]?.body))).toEqual({ mode: "existing", path: "Project 日本", slug: "my-address", name: "Notebook" });
  expect(JSON.parse(String(posts[1]?.[1]?.body))).toEqual({ mode: "existing", path: "Project 日本", slug: "my-address", name: "Notebook", confirmation: "a".repeat(64) });
});
test("invalid chosen-folder address never sends preview or registration", async () => {
  const fetcher = mount(); input("vault-name", "Notebook"); input("vault-slug", "Invalid address"); await choose(); submit();
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  expect(element<HTMLInputElement>("vault-slug").value).toBe("Invalid address");
  expect(element("message").getAttribute("role")).toBe("alert");
});
test("clear selection returns to default storage without writing or losing name and address", async () => {
  const fetcher = mount(); input("vault-name", "Notebook"); input("vault-slug", "my-address"); await choose();
  element<HTMLButtonElement>("clear-folder").click();
  expect(element("folder-selection").hidden).toBe(true);
  expect(element<HTMLInputElement>("vault-name").value).toBe("Notebook");
  expect(element<HTMLInputElement>("vault-slug").value).toBe("my-address");
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  expect(submit().defaultPrevented).toBe(false);
});
test("cancel picker preserves the selected folder and typed optional address", async () => {
  const fetcher = mount(); input("vault-slug", "my-address"); await choose(); const selected = element("selected-path").textContent;
  element<HTMLButtonElement>("choose-folder").click();
  element<HTMLButtonElement>("cancel-picker").click();
  expect(element("selected-path").textContent).toBe(selected);
  expect(element<HTMLInputElement>("vault-slug").value).toBe("my-address");
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
});
test("server-side managed error stays visible after enhancement mounts", () => {
  mount("Could not create this vault. Try a different address.");
  expect(element("message").textContent).toContain("Try a different address");
  expect(element("message").getAttribute("role")).toBe("alert");
});

test("ignoring non-writable folders is an explicit checkbox bound to both registration requests", async () => {
  const fetcher = mount();
  await choose(); input("vault-name", "Notebook");
  const option = element<HTMLInputElement>("ignore-non-writable-folders");
  expect(option.checked).toBe(false);
  option.checked = true; option.dispatchEvent(new Event("change", { bubbles: true }));
  submit();
  await vi.waitFor(() => expect(element("result-heading").textContent).toBe("Vault registered"));
  const bodies = fetcher.mock.calls.filter(([url]) => url.endsWith("/preview") || url.endsWith("/register")).map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
  expect(bodies).toHaveLength(2);
  for (const body of bodies) expect(body["ignore_non_writable_folders"]).toBe(true);
});
