// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { mountFolderVault } from "./folder-vault.js";
import { installDialogShim } from "./folder-dialog-test.js";
installDialogShim();
const html = readFileSync("add-vault.html", "utf8");
const state = { location_root: true, registration: "available", selectable: false, browsable: true };
let destroy = (): void => {};
afterEach(() => { destroy(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
function button(name: string): HTMLButtonElement {
  const b = [...document.querySelectorAll("button")].find(b => b.textContent === name);
  if (!b) throw new Error(`missing button ${name}`);
  return b;
}
test("explicit mode intent loads configured directories without any preview and selects only an eligible non-root", async () => {
  document.body.innerHTML = new DOMParser().parseFromString(html,"text/html").body.innerHTML;
  let call = 0;
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(++call === 1
    ? { locations: [{ id: "projects", name: "Projects" }] }
    : { path: "", state, children: [{name: "日本: 100%", path: "日本: 100%", state: {...state, location_root:false, selectable:true}}] }), {status:200,headers:{"Content-Type":"application/json"}}));
  vi.stubGlobal("fetch", fetcher);
  const root = document.querySelector<HTMLElement>("#folder-vault");
  if (!root) throw new Error("fixture");
  destroy = mountFolderVault(root);
  button("Choose folder").click();
  await vi.waitFor(() => expect(button("日本: 100%" )).toBeDefined());
  expect(button("Use this folder").disabled).toBe(true);
  expect(fetcher.mock.calls).toHaveLength(2);
  expect(fetcher.mock.calls.map(c => c[0])).not.toContain(expect.stringContaining("preview"));
});
