/** Autosave is server Markdown plus a separate device, not just this tab's IndexedDB. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { E2E_ORIGIN, E2E_VAULT } from "./environment.js";
import { expect, signIn, test } from "./fixtures.js";

const EDITOR = ".editor-surface .tiptap";

async function showNavigation(page: Page): Promise<void> {
  const show = page.getByRole("button", { name: "Show Navigation", exact: true });
  if (await show.isVisible()) await show.click();
}

function disk(path: string): string {
  return readFileSync(join(E2E_VAULT, path), "utf8");
}

/** Reads the actual browser's eviction guard, not an in-memory transport status. */
async function residentDirty(page: Page, note: string): Promise<boolean | undefined> {
  return page.evaluate((path) => new Promise<boolean | undefined>((resolve, reject) => {
    const open = indexedDB.open("memberberry:offline");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction("bodies", "readonly");
      const record = transaction.objectStore("bodies").get(["personal", path]);
      record.onerror = () => { database.close(); reject(record.error); };
      record.onsuccess = () => {
        const value: unknown = record.result;
        database.close();
        resolve(typeof value === "object" && value !== null && "dirty" in value && typeof value.dirty === "boolean"
          ? value.dirty : undefined);
      };
    };
  }), note);
}

test("a newly created note autosaves to Markdown and a clean independent device, including reconnect and reload", async ({ page, context, browser, failures }, info) => {
  const name = `Autosave ${info.project.name} ${randomUUID()}`;
  const path = `${name}.md`;
  const initial = "Café 🧠 — written immediately on device A.";
  const offline = " An offline addition survives reconnect.";
  await signIn(page);
  await page.goto("/v/personal");
  await showNavigation(page);
  await page.getByRole("complementary", { name: "Navigation", exact: true }).getByRole("button", { name: "New note", exact: true }).click();
  const prompt = page.getByRole("dialog", { name: "New note", exact: true });
  await prompt.getByLabel("Name", { exact: true }).fill(name);
  await prompt.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator(EDITOR).getByRole("heading", { name, exact: true })).toBeVisible();
  await page.keyboard.insertText(initial);
  await expect(page.locator(EDITOR)).toContainText(initial);
  await expect.poll(() => disk(path), { timeout: 15_000 }).toContain(initial);
  expect(disk(path)).not.toContain("[!conflict]");
  await expect.poll(() => residentDirty(page, path)).toBe(false);

  // No copied cookies, storageState, IndexedDB or page: this is genuinely another device.
  const secondContext = await browser.newContext({ baseURL: E2E_ORIGIN });
  const second = await secondContext.newPage();
  const problems: string[] = [];
  second.on("pageerror", (error) => problems.push(error.message));
  second.on("console", (message) => { if (message.type() === "error") problems.push(message.text()); });
  try {
    await signIn(second);
    await second.goto("/v/personal");
    await showNavigation(second);
    // Discover it through the permission-filtered catalog, never by guessing the known URL.
    const entry = second.getByRole("tree", { name: "Notes", exact: true }).locator(`[role="treeitem"][title="${path}"]`);
    await expect(entry).toBeVisible();
    await entry.click();
    await expect(second.locator(EDITOR)).toContainText(initial);

    failures.allow(/net::ERR_INTERNET_DISCONNECTED|net::ERR_NETWORK_CHANGED|WebSocket/);
    failures.allow(/console error: Failed to load resource/);
    await context.setOffline(true);
    await expect(page.locator(".connection-status")).toContainText("Offline");
    await page.locator(`${EDITOR} p`).first().click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.insertText(offline);
    await expect(page.locator(EDITOR)).toContainText(initial + offline);
    expect(disk(path)).not.toContain(offline);
    await expect.poll(() => residentDirty(page, path)).toBe(true);
    await expect(second.locator(EDITOR)).not.toContainText(offline);
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => disk(path), { timeout: 15_000 }).toContain(initial + offline);
    await expect(second.locator(EDITOR)).toContainText(initial + offline);
    await expect.poll(() => residentDirty(page, path)).toBe(false);

    expect(disk(path)).not.toContain("[!conflict]");
    await expect(page.locator(".conflict-action")).toHaveCount(0);
    await expect(second.locator(".conflict-action")).toHaveCount(0);

    await page.reload();
    await second.reload();
    await expect(page.locator(EDITOR)).toContainText(initial + offline);
    await expect(second.locator(EDITOR)).toContainText(initial + offline);
    expect(disk(path)).toContain(`# ${name}\n`);
    expect(disk(path)).not.toContain("[!conflict]");
    await expect(page.locator(".conflict-action")).toHaveCount(0);
    await expect(second.locator(".conflict-action")).toHaveCount(0);
    expect(problems).toEqual([]);
  } finally {
    await context.setOffline(false);
    await secondContext.close();
  }
});

test("an already open device discovers another device's new note when it regains focus", async ({ page, browser }, info) => {
  const name = `Cross-device catalog ${info.project.name} ${randomUUID()}`;
  await signIn(page);
  await page.goto("/v/personal");
  await showNavigation(page);
  await expect(page.getByRole("tree", { name: "Notes", exact: true })).toBeVisible();
  // The existing tree is loaded before device B creates the note.
  await expect(page.locator('[role="treeitem"][title="Welcome.md"]')).toBeVisible();
  const secondContext = await browser.newContext({ baseURL: E2E_ORIGIN });
  const second = await secondContext.newPage();
  try {
    await signIn(second);
    const created = await second.request.post("/api/v1/vaults/personal/notes", {
      data: { path: `${name}.md`, content: `# ${name}\n\nAvailable on the server.\n` },
    });
    expect(created.ok()).toBe(true);
    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const entry = page.getByRole("tree", { name: "Notes", exact: true }).locator(`[role="treeitem"][title="${name}.md"]`);
    await expect(entry).toBeVisible();
    await entry.click();
    await expect(page.locator(EDITOR)).toContainText("Available on the server.");
  } finally {
    await secondContext.close();
  }
});
