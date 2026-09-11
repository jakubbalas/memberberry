/** Authenticated public-share management in a real browser (`SPEC.md` §17). */

import { expect, signIn, test } from "./fixtures.js";

async function openSharePanel(page: import("@playwright/test").Page): Promise<import("@playwright/test").Locator> {
  await expect(page.locator(".editor-surface .tiptap")).toBeVisible();
  const panel = page.getByRole("region", { name: "Public shares" });
  if (await page.getByRole("button", { name: "Show Navigation" }).count() > 0) {
    await page.getByRole("button", { name: "Show Navigation" }).click();
  }
  await page.locator(".notebook-section > summary").filter({ hasText: "Share a note" }).click();
  await expect(panel).toBeVisible();
  return panel;
}

test("creates and displays a public share URL", async ({ page }) => {
  await signIn(page);
  await page.goto("/v/personal/Welcome.md");
  const panel = await openSharePanel(page);
  await panel.getByLabel("Note").fill("Welcome.md");
  await panel.getByRole("button", { name: "Create share" }).click();

  const created = panel.getByLabel("New share URL");
  await expect(created).toHaveValue(/\/s\/[A-Za-z0-9_-]+/);
  await expect(panel).toContainText("Copy the URL now");
});

test("warns before creating a never-expiring share", async ({ page }) => {
  await signIn(page);
  await page.goto("/v/personal/Welcome.md");
  const panel = await openSharePanel(page);
  await panel.getByLabel("Never expires").check();
  await expect(panel.getByRole("note")).toContainText("active until revoked");
  await panel.getByRole("button", { name: "Create share" }).click();
  await expect(panel.getByLabel("New share URL")).toHaveValue(/\/s\/[A-Za-z0-9_-]+/);
  await expect(panel).toContainText("Never expires");
});

test("unlocks a password-protected share without exposing its token", async ({ page }) => {
  await signIn(page);
  await page.goto("/v/personal/Welcome.md");
  const panel = await openSharePanel(page);
  await panel.getByLabel("Note").fill("Welcome.md");
  await panel.getByLabel("Password (optional)").fill("share password");
  await panel.getByRole("button", { name: "Create share" }).click();

  const shareUrl = await panel.getByLabel("New share URL").inputValue();
  const token = shareUrl.split("/s/")[1];
  expect(token).toBeTruthy();
  await page.goto(shareUrl);
  await expect(page.getByText("This link requires a password.")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  expect(await page.locator("body").textContent()).not.toContain(token ?? "");

  await page.getByLabel("Password").fill("share password");
  await page.getByRole("button", { name: "Open" }).click();
  await expect(page.locator("article.mb-note")).toContainText("A note that already exists");
  expect(await page.locator("body").textContent()).not.toContain(token ?? "");
});
