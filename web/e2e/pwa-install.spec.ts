import { expect, signIn, test } from "./fixtures.js";
import { chromium } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2E_ORIGIN } from "./environment.js";

test("Chrome can discover the manifest and raster installation icons", async ({}, info) => {
  // Installability is deliberately disabled in incognito contexts. Use a disposable real
  // browser profile, keeping the exact installability assertion instead of filtering it.
  const profile = mkdtempSync(join(tmpdir(), "memberberry-pwa-install-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true, baseURL: E2E_ORIGIN,
    viewport: info.project.name === "mobile" ? { width: 412, height: 915 } : { width: 1280, height: 800 },
    ...(info.project.name === "mobile" ? { isMobile: true, hasTouch: true } : {}),
  });
  try {
  const page = context.pages()[0] ?? await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", error => { problems.push(error.message); });
  page.on("console", message => { if (message.type() === "error") problems.push(message.text()); });
  await signIn(page);
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  const initialSearch = page.waitForResponse(response => response.url().endsWith("/search/segments") && response.status() === 200);
  await page.goto("/v/personal/Welcome.md");
  await initialSearch;
  await expect(page.getByText("A note that already exists")).toBeVisible();
  const manifest = await page.request.get("/manifest.webmanifest");
  const parsed = await manifest.json() as { icons: { src: string; sizes: string; type: string }[] };
  expect(parsed).toMatchObject({ id: "/", start_url: "/app.html?launch=1", display: "standalone" });
  for (const size of [192, 512]) {
    const source = parsed.icons.find(icon => icon.sizes === `${size}x${size}` && icon.type === "image/png")?.src;
    if (source === undefined) throw new Error(`missing ${size}px installation icon`);
    const icon = await page.request.get(source);
    expect(icon.headers()["content-type"]).toBe("image/png");
    expect((await icon.body()).subarray(1, 4).toString()).toBe("PNG");
  }
  const cdp = await context.newCDPSession(page);
  const errors = await cdp.send("Page.getInstallabilityErrors");
  expect(errors.installabilityErrors).toEqual([]);
  expect(problems).toEqual([]);
  } finally { await context.close(); rmSync(profile, { recursive: true }); }
});

test("the installed launch resumes this device's last workspace online and offline", async ({ page, context, failures }) => {
  await signIn(page);
  await page.goto("/v/personal/Welcome.md");
  await expect(page.getByText("A note that already exists")).toBeVisible();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.goto("/app.html?launch=1");
  await expect(page).toHaveURL(/\/v\/personal\/Welcome.md$/);
  await expect(page.getByText("A note that already exists")).toBeVisible();
  failures.allow(/ERR_INTERNET_DISCONNECTED|Failed to fetch|Failed to load resource|WebSocket/);
  await context.setOffline(true);
  await page.goto("/app.html?launch=1");
  await expect(page).toHaveURL(/\/v\/personal\/Welcome.md$/);
  await expect(page.getByText("A note that already exists")).toBeVisible();
});

test("installation action appears only for a native prompt and invokes it once", async ({ page }) => {
  await signIn(page);
  await page.goto("/v/personal/Welcome.md");
  await expect(page.getByText("A note that already exists")).toBeVisible();
  await page.evaluate(() => {
    const event = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(event, { prompt: async () => { document.documentElement.dataset["installInvoked"] = "true"; } });
    window.dispatchEvent(event);
  });
  await expect(page.getByRole("button", { name: "Install Memberberry", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Install Memberberry", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-install-invoked", "true");
  await expect(page.getByRole("button", { name: "Install Memberberry", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
