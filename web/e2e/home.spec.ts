import { expect, signIn, test } from "./fixtures.js";

test("the vault opens Home with compact file actions and a brand link back home", async ({ page }, info) => {
  await signIn(page);
  await page.goto("/v/personal");
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  const show = page.getByRole("button", { name: "Show Navigation", exact: true });
  if (info.project.name === "mobile") await show.click();
  const navigation = page.getByRole("complementary", { name: "Navigation", exact: true });
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Search notes", exact: true })).toHaveCount(0);
  await expect(navigation.getByRole("link", { name: "Home", exact: true })).toHaveCount(0);
  const actions = navigation.getByRole("group", { name: "File actions", exact: true });
  for (const name of ["New note", "New folder"]) {
    const button = actions.getByRole("button", { name, exact: true });
    const box = await button.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(info.project.name === "mobile" ? 44 : 32);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(info.project.name === "mobile" ? 44 : 32);
  }
  await actions.getByRole("button", { name: "New note", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "New note", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(navigation.getByRole("button", { name: "New note", exact: true })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "New folder", exact: true })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Search", exact: true })).toBeVisible();
  const tree = navigation.getByRole("tree", { name: "Notes", exact: true });
  await expect(tree.getByRole("treeitem", { name: "Projects", exact: true })).toBeVisible();
  await page.screenshot({ path: `/tmp/memberberry-home-${info.project.name}.png` });
  await tree.getByRole("treeitem", { name: "Projects", exact: true }).click();
  await tree.getByRole("treeitem", { name: /Roadmap/ }).click();
  await expect(page.locator(".editor-surface .tiptap").first()).toContainText("Ship the workspace shell");
  const home = page.getByRole("link", { name: "Memberberry home", exact: true });
  await expect(home).toBeVisible();
  await home.click();
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
});

test("creates a real empty folder from the file actions and keeps it after reload", async ({ page }, info) => {
  await signIn(page);
  await page.goto("/v/personal");
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  const show = page.getByRole("button", { name: "Show Navigation", exact: true });
  if (await show.isVisible()) await show.click();
  const navigation = page.getByRole("complementary", { name: "Navigation", exact: true });
  await navigation.getByRole("button", { name: "New folder", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New folder", exact: true });
  const name = `Ideas-${info.project.name}`;
  await dialog.getByLabel("Folder name", { exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Create folder", exact: true }).click();
  await expect(navigation.getByRole("treeitem", { name, exact: true })).toBeVisible();
  await page.reload();
  if (await show.isVisible()) await show.click();
  await expect(navigation.getByRole("treeitem", { name, exact: true })).toBeVisible();
});
