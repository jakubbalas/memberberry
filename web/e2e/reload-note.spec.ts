import { expect, signIn, test } from "./fixtures.js";

test("reload returns to the note opened from Home and Home remains explicitly reachable", async ({ page }) => {
  await signIn(page);
  await page.goto("/v/personal");
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  const show = page.getByRole("button", { name: "Show Navigation", exact: true });
  if (await show.isVisible()) await show.click();
  const tree = page.getByRole("tree", { name: "Notes", exact: true });
  await tree.getByRole("treeitem", { name: /^Welcome (?:Add|Remove) bookmark for Welcome$/ }).click();
  const editor = page.locator(".editor-surface .tiptap");
  await expect(editor).toContainText("A note that already exists");
  await page.reload();
  await expect(editor).toBeVisible();
  await expect(editor).toContainText("A note that already exists");
  await expect(page).toHaveURL(/\/v\/personal\/Welcome\.md$/);
  await page.getByRole("link", { name: "Memberberry home", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
});
