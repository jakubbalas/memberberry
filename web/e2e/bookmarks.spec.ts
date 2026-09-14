import { expect, signIn, test } from "./fixtures.js";
import { emptyVaultSlug } from "./environment.js";

test("removes a bookmark from its section and keeps the note after reload", async ({ page }, info) => {
  await signIn(page);
  const vault = emptyVaultSlug(info.project.name, "bookmarks");
  const created = await page.request.post(`/api/v1/vaults/${vault}/notes`, { data: { path: "Welcome.md", content: "# Welcome\n" } });
  expect(created.ok()).toBe(true);
  const endpoint = `/api/v1/vaults/${vault}/bookmarks`;
  const saved = await page.request.put(endpoint, { data: ["Welcome.md"] });
  expect(saved.ok()).toBe(true);
  await page.goto(`/v/${vault}`);
  const show = page.getByRole("button", { name: "Show Navigation", exact: true });
  if (await show.isVisible()) await show.click();
  const bookmarks = page.getByRole("region", { name: "Bookmarks", exact: true });
  const remove = bookmarks.getByRole("button", { name: "Remove bookmark for Welcome" });
  await expect(remove).toBeVisible();
  const box = await remove.boundingBox();
  const labelBox = await bookmarks.getByRole("button", { name: "Welcome", exact: true }).boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(labelBox?.x ?? 0);
  await expect(bookmarks.locator("li")).toHaveText(/^\s*★\s*Welcome\s*$/);
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: info.outputPath("bookmark-remove.png") });
  if (info.project.name === "desktop") {
    await remove.focus();
    await page.keyboard.press("Enter");
  } else {
    await remove.click();
  }
  await expect(bookmarks).toHaveCount(0);
  await expect.poll(async () => (await page.request.get(endpoint)).json()).toEqual([]);
  await expect(page.locator(".workspace-home")).toBeVisible();
  await page.reload();
  if (await show.isVisible()) await show.click();
  await expect(page.getByRole("tree", { name: "Notes", exact: true }).getByRole("button", { name: "Add bookmark for Welcome" })).toBeAttached();
  await expect(bookmarks).toHaveCount(0);
});
