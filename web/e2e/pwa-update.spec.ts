import { cpSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_WEB_ROOT, scratchNote } from "./environment.js";
import { expect, signIn, test } from "./fixtures.js";

/** Publish a second coherent asset identity inside this spec's disposable build only. */
function nextBuild(): { entry: string; restore: () => void } {
  const htmlFile = join(E2E_WEB_ROOT, "index.html");
  const workerFile = join(E2E_WEB_ROOT, "sw.js");
  const html = readFileSync(htmlFile, "utf8");
  const worker = readFileSync(workerFile, "utf8");
  const manifestFile = join(E2E_WEB_ROOT, "manifest.webmanifest");
  const manifest = readFileSync(manifestFile, "utf8");
  const entry = /src="([^\"]+\.js)"/.exec(html)?.[1];
  if (entry === undefined) throw new Error("missing built application entry");
  // Move the complete module graph together. Renaming just the entry would make lazy
  // chunks import a second copy of Yjs through their unchanged entry references.
  const prefix = "/assets/pwa-update-test/";
  const next = entry.replace("/assets/", prefix);
  const staging = mkdtempSync(join(E2E_WEB_ROOT, "pwa-update-"));
  cpSync(join(E2E_WEB_ROOT, "assets"), staging, { recursive: true });
  const rewrite = (directory: string): void => {
    for (const file of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, file.name);
      if (file.isDirectory()) rewrite(path);
      else if (/\.(js|css)$/.test(file.name)) writeFileSync(path, readFileSync(path, "utf8").replaceAll("/assets/", prefix));
    }
  };
  rewrite(staging);
  const asset = join(E2E_WEB_ROOT, "assets", "pwa-update-test");
  renameSync(staging, asset);
  const nextWorker = worker.replace(/version:"([^\"]+)"/, 'version:"$1-update-test"').replaceAll("/assets/", prefix);
  if (nextWorker === worker || !nextWorker.includes(next)) throw new Error("missing worker precache identity");
  writeFileSync(htmlFile, html.replaceAll("/assets/", prefix));
  writeFileSync(manifestFile, manifest.replaceAll("/assets/", prefix));
  writeFileSync(workerFile, nextWorker);
  return { entry: next, restore: () => { writeFileSync(htmlFile, html); writeFileSync(workerFile, worker); writeFileSync(manifestFile, manifest); rmSync(asset, { recursive: true }); } };
}

test("an update waits for a click, reloads the new build and leaves another window working", async ({ page, context }) => {
  await signIn(page);
  await page.goto("/v/personal/Welcome.md");
  await expect(page.getByText("A note that already exists")).toBeVisible();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  const other = await context.newPage();
  await other.goto("/v/personal/Welcome.md");
  await expect(other.getByText("A note that already exists")).toBeVisible();
  await other.evaluate(() => { document.documentElement.dataset["keptWindow"] = "yes"; });
  const build = nextBuild();
  try {
    await page.evaluate(async () => { await (await navigator.serviceWorker.ready).update(); });
    await expect(page.getByRole("button", { name: "Reload to update" })).toBeVisible();
    expect(await page.locator('script[type="module"][src]').getAttribute("src")).not.toBe(build.entry);
    await page.screenshot({ path: test.info().outputPath("update-ready.png") });
    await page.getByRole("button", { name: "Reload to update" }).click();
    await expect(page.locator('script[type="module"][src]')).toHaveAttribute("src", build.entry);
    await expect(page.getByText("A note that already exists")).toBeVisible();
    await expect(page.getByRole("button", { name: "Reload to update" })).toHaveCount(0);
    await expect(other.locator("html")).toHaveAttribute("data-kept-window", "yes");
    await expect(other.getByText("A note that already exists")).toBeVisible();
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state)).toBe("installed");
  } finally { await other.close(); build.restore(); }
});

test("an update cannot reload over unsent offline edits", async ({ page, context, failures }, info) => {
  await signIn(page);
  const note = scratchNote("pwa-update", info.project.name);
  await page.goto(`/v/personal/${note}`);
  const editor = page.locator(".ProseMirror").first();
  await expect(editor).toContainText("A note this test may edit");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  const build = nextBuild();
  try {
    await page.evaluate(async () => { await (await navigator.serviceWorker.ready).update(); });
    await expect(page.getByRole("button", { name: "Reload to update" })).toBeVisible();
    failures.allow(/ERR_INTERNET_DISCONNECTED|Failed to fetch|Failed to load resource|WebSocket/);
    await context.setOffline(true);
    await editor.getByText("A note this test may edit").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Kept while updating.");
    await page.getByRole("button", { name: "Reload to update" }).click();
    await expect(page.getByText("Reconnect and sync your notes before updating.")).toBeVisible();
    await expect(editor).toContainText("Kept while updating.");
    expect(await page.locator('script[type="module"][src]').getAttribute("src")).not.toBe(build.entry);
    await context.setOffline(false);
    await expect(page.locator(".connection-status")).toBeHidden({ timeout: 15_000 });
  } finally { await context.setOffline(false); build.restore(); }
});
