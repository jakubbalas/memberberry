import { expect, signIn, test } from "./fixtures.js";

test("the backend shell references compiled assets and renders without Vite", async ({ page }) => {
  const response = await page.goto("/app.html");
  expect(response?.ok()).toBe(true);
  await expect(page.locator('script[type="module"]').first()).toHaveAttribute("src", /^\/assets\/.+\.js$/);
  await expect(page.locator(".ProseMirror")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a signed-in vault home renders the built shell without source-module 404s", async ({ page }) => {
  await signIn(page);
  await page.goto("/v/personal");
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  await expect(page.locator('script[type="module"]').first()).toHaveAttribute("src", /^\/assets\/.+\.js$/);
});
