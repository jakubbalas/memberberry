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
  // why: mobile drawers start closed; click waits for mounting, while isVisible can
  // return false before the shell renders and silently skip opening the drawer.
  if (info.project.name === "mobile") await show.click();
  const bookmarks = page.getByRole("region", { name: "Bookmarks", exact: true });
  const actions = bookmarks.getByRole("button", { name: "Note actions for Welcome", exact: true });
  await expect(actions).toBeVisible();
  const box = await actions.boundingBox();
  const labelBox = await bookmarks.getByRole("button", { name: "Welcome", exact: true }).boundingBox();
  expect(box?.x ?? 0).toBeGreaterThanOrEqual((labelBox?.x ?? 0) + (labelBox?.width ?? 0));
  await expect(bookmarks.locator("li")).toHaveText(/^\s*Welcome\s*$/);
  await expect(bookmarks.locator(".tree-bookmark")).toHaveCount(0);
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  await actions.click();
  const remove = page.getByRole("menuitem", { name: "Remove bookmark", exact: true });
  await expect(remove).toBeVisible();
  if (info.project.name === "mobile") expect((await remove.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: info.outputPath("bookmark-remove.png") });
  if (info.project.name === "desktop") {
    await remove.focus();
    await page.keyboard.press("Enter");
  } else {
    await remove.click();
  }
  await expect(bookmarks).toHaveCount(0);
  await expect.poll(async () => (await page.request.get(endpoint)).json()).toEqual([]);
  await expect(page.getByRole("tree", { name: "Notes", exact: true })).toBeFocused();
  await expect(page.locator(".workspace-home")).toBeVisible();
  await page.reload();
  if (info.project.name === "mobile") await show.click();
  const tree = page.getByRole("tree", { name: "Notes", exact: true });
  await expect(tree.getByRole("treeitem", { name: "Welcome", exact: true })).toBeVisible();
  await tree.getByRole("button", { name: "Note actions for Welcome", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Add bookmark", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Remove bookmark", exact: true })).toHaveCount(0);
  await expect(bookmarks).toHaveCount(0);
});
