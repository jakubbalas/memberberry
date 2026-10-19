import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { E2E_VAULT, REPO, scratchNote } from "./environment.js";
import { expect, signIn, test } from "./fixtures.js";
import type { Page } from "@playwright/test";

const schema: unknown = JSON.parse(readFileSync(join(REPO, "crates/mb-core/schema.json"), "utf8"));
if (typeof schema !== "object" || schema === null || !("version" in schema) || typeof schema.version !== "number") throw new Error("missing editor schema version");
const SCHEMA_VERSION = schema.version;

async function openedAt(page: Page, note: string): Promise<number> {
  return page.evaluate(async ({ note, revision }) => new Promise<number>((resolve, reject) => {
    const open = indexedDB.open(`memberberry:offline:schema:${revision}`);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = db.transaction("bodies").objectStore("bodies").get(["personal", note]);
      request.onsuccess = () => { const row: unknown = request.result; db.close(); resolve(typeof row === "object" && row !== null && "openedAt" in row && typeof row.openedAt === "number" ? row.openedAt : 0); };
      request.onerror = () => { db.close(); reject(request.error); };
    };
  }), { note, revision: SCHEMA_VERSION });
}

test("workspace focus discovers server changes without reloading the editor", async ({ page, context }, info) => {
  await signIn(page);
  await page.goto("/v/personal/Welcome.md");
  await expect(page.getByText("A note that already exists")).toBeVisible();
  await page.evaluate(() => { document.documentElement.dataset["sameEditor"] = "yes"; });
  const other = await context.newPage();
  await other.goto("about:blank");
  await other.bringToFront();
  const note = `Pwa/Remote-${info.project.name}.md`;
  const path = join(E2E_VAULT, note);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "# Fresh server note\n\nDiscovered on return.\n");
  await expect.poll(async () => (await (await page.request.get("/api/v1/vaults/personal/notes")).json() as { notes: { path: string }[] }).notes.some(row => row.path === note), { timeout: 15_000 }).toBe(true);
  await page.bringToFront();
  // Headless Chromium does not consistently emit OS focus when activating a tab. Drive
  // that lifecycle input explicitly; the resulting storage, HTTP and sync are real.
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
  const navigation = page.getByRole("button", { name: "Show Navigation", exact: true });
  if (await navigation.isVisible()) await navigation.click();
  await page.getByRole("treeitem", { name: "Pwa", exact: true }).click();
  await expect(page.locator(`[role="treeitem"][title="${note}"]`)).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-same-editor", "yes");
  await expect(page.getByText("A note that already exists")).toBeVisible();
  await other.close();
});

test("return refresh updates closed pinned text and offline search before the next disconnect", async ({ page, context, failures }, info) => {
  await signIn(page);
  const note = scratchNote("pwa-pinned", info.project.name);
  await page.goto(`/v/personal/${note}`);
  await expect(page.getByText("A note this test may edit")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+P");
  await page.getByRole("option", { name: /Keep this note available offline/ }).click();
  await page.keyboard.press("ControlOrMeta+P");
  await page.getByRole("option", { name: /Close note/ }).click();
  await page.goto("/v/personal/Welcome.md");
  await expect(page.getByText("A note that already exists")).toBeVisible();
  const before = await openedAt(page, note);
  const other = await context.newPage();
  await other.goto("about:blank"); await other.bringToFront();
  writeFileSync(join(E2E_VAULT, note), "# Fresh pinned note\n\nsaffronpwa content refreshed on return.\n");
  await expect.poll(async () => (await (await page.request.get("/api/v1/vaults/personal/notes")).json() as { notes: { path: string; title: string }[] }).notes.find(row => row.path === note)?.title, { timeout: 15_000 }).toBe("Fresh pinned note");
  // The title catalog and full-text index publish independently. Wait for the server's
  // search snapshot before asking the returning client to replicate that snapshot.
  await expect.poll(async () => (await (await page.request.get("/api/v1/vaults/personal/search?q=saffronpwa")).json() as { hits: { path: string }[] }).hits.some(hit => hit.path === note), { timeout: 15_000 }).toBe(true);
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
  await expect.poll(() => openedAt(page, note), { timeout: 15_000 }).toBeGreaterThan(before);
  await other.close();
  failures.allow(/ERR_INTERNET_DISCONNECTED|Failed to fetch|Failed to load resource|WebSocket/);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller === null) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
  });
  await context.setOffline(true);
  await page.goto(`/v/personal/${note}`);
  await expect(page.getByText("saffronpwa content refreshed on return.")).toBeVisible();
  const navigation = page.getByRole("button", { name: "Show Navigation", exact: true });
  if (await navigation.isVisible()) await navigation.click();
  await page.getByRole("group", { name: "Navigation views" }).getByRole("button", { name: "Search", exact: true }).click();
  await page.locator('.search-panel input[type="search"]').fill("saffronpwa");
  await expect(page.locator(".search-mode")).toHaveText("Offline — prefix search");
  await expect(page.locator(`.search-result[data-path="${note}"]`)).toBeVisible();
});
