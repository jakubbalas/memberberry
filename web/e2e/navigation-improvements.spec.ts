import { randomUUID } from "node:crypto";
import { expect, signIn, test } from "./fixtures.js";
import type { Page } from "@playwright/test";

async function showNavigation(page: Page): Promise<void> {
  await expect(page.locator(".workspace-shell")).toBeVisible();
  const show = page.getByRole("button", { name: "Show Navigation", exact: true });
  if (await show.isVisible()) await show.click();
}

async function openFolder(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: `Folder actions for ${name}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Open in main panel", exact: true }).click();
  await expect(page.locator(".folder-contents").getByRole("heading", { name, exact: true })).toBeVisible();
}

test("folder menus open note-free contents, nested empty directories and readable notes", async ({ page }, info) => {
  await signIn(page);
  await page.goto("/v/personal");
  await showNavigation(page);
  const navigation = page.getByRole("complementary", { name: "Navigation", exact: true });
  const folder = `Navigation ${info.project.name} ${randomUUID()}`;
  await navigation.getByRole("button", { name: "New folder", exact: true }).click();
  const prompt = page.getByRole("dialog", { name: "New folder", exact: true });
  await prompt.getByLabel("Folder name", { exact: true }).fill(`${folder}/Empty`);
  await prompt.getByRole("button", { name: "Create folder", exact: true }).click();
  await expect(navigation.getByRole("treeitem", { name: folder, exact: true })).toBeVisible();
  await openFolder(page, folder);
  await expect(page.locator(".editor-surface")).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(0);
  if (info.project.name === "mobile") await expect(navigation).toBeHidden();
  await page.screenshot({ path: info.outputPath("folder-contents.png") });
  await page.locator(".folder-contents").getByRole("button", { name: "Open folder Empty", exact: true }).click();
  await expect(page.getByText("This folder is empty.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: `Up to ${folder}`, exact: true }).click();
  await expect(page.locator(".folder-contents").getByRole("heading", { name: folder, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close folder view", exact: true }).click();
  await showNavigation(page);
  await openFolder(page, "Projects");
  await page.locator(".folder-contents").getByRole("button", { name: "Roadmap", exact: true }).click();
  await expect(page.locator(".editor-surface .tiptap")).toBeVisible();
  await expect(page).toHaveURL(/\/v\/personal\/Projects\/Roadmap.md$/);
});

test("File settings keeps Show filenames and its raw basename after reload", async ({ page }) => {
  await signIn(page);
  await page.goto("/v/personal");
  await showNavigation(page);
  const tree = page.getByRole("tree", { name: "Notes", exact: true });
  await tree.getByRole("treeitem", { name: "Themes", exact: true }).click();
  await expect(tree.getByRole("treeitem", { name: "A little space to think", exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Show filenames", exact: true })).toHaveCount(0);
  const settings = page.getByRole("button", { name: "File settings", exact: true });
  const newFolder = page.getByRole("button", { name: "New folder", exact: true });
  const settingsBox = await settings.boundingBox();
  const folderBox = await newFolder.boundingBox();
  expect(settingsBox?.x ?? 0).toBeGreaterThanOrEqual((folderBox?.x ?? 0) + (folderBox?.width ?? 0));
  await settings.focus();
  await page.keyboard.press("Enter");
  const preference = page.getByRole("menuitemcheckbox", { name: "Show filenames", exact: true });
  await expect(preference).not.toBeChecked();
  await expect(preference).toBeFocused();
  await page.keyboard.press("Space");
  await expect(settings).toBeFocused();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(tree.getByRole("treeitem", { name: "Notebook.md", exact: true })).toBeVisible();
  await page.reload();
  await showNavigation(page);
  await settings.click();
  await expect(preference).toBeChecked();
  await expect(tree.getByRole("treeitem", { name: "Notebook.md", exact: true })).toBeVisible();
  await preference.click();
  await expect(tree.getByRole("treeitem", { name: "A little space to think", exact: true })).toBeVisible();
});

test("file and bookmark rows share accessible note actions without opening the note", async ({ page }, info) => {
  await signIn(page);
  const endpoint = "/api/v1/vaults/personal/bookmarks";
  expect((await page.request.put(endpoint, { data: [] })).ok()).toBe(true);
  await page.goto("/v/personal");
  await showNavigation(page);
  const tree = page.getByRole("tree", { name: "Notes", exact: true });
  const row = tree.getByRole("treeitem", { name: "Welcome", exact: true });
  const actions = row.getByRole("button", { name: "Note actions for Welcome", exact: true });
  const menu = page.getByRole("menu", { name: "Note actions", exact: true });
  await expect(actions).toHaveAttribute("tabindex", "-1");
  await expect(page.locator(".tree-bookmark")).toHaveCount(0);
  if (info.project.name === "mobile") {
    const box = await actions.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await actions.tap();
  } else await actions.click();
  await expect(menu.getByRole("menuitem")).toHaveText(["Open in new tab", "Rename", "Delete", "Add bookmark"]);
  await page.keyboard.press("Escape");
  await expect(actions).toBeFocused();
  await expect(actions).toHaveAttribute("aria-expanded", "false");
  await row.click({ button: "right" });
  await expect(menu.getByRole("menuitem", { name: "Add bookmark", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tree).toBeFocused();
  await page.keyboard.press("Shift+F10");
  const add = menu.getByRole("menuitem", { name: "Add bookmark", exact: true });
  if (info.project.name === "mobile") expect((await add.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await add.click();
  await expect(tree).toBeFocused();
  await expect.poll(async () => (await page.request.get(endpoint)).json()).toEqual(["Welcome.md"]);
  const bookmarks = page.getByRole("region", { name: "Bookmarks", exact: true });
  const bookmarkActions = bookmarks.getByRole("button", { name: "Note actions for Welcome", exact: true });
  await bookmarkActions.click();
  await expect(menu.getByRole("menuitem")).toHaveText(["Open in new tab", "Rename", "Delete", "Remove bookmark"]);
  await page.keyboard.press("Escape");
  await expect(bookmarkActions).toBeFocused();
  const bookmark = bookmarks.getByRole("button", { name: "Welcome", exact: true });
  await bookmark.focus();
  await page.keyboard.press("Shift+F10");
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem", { name: "Remove bookmark", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(bookmarks).toHaveCount(0);
  await expect(tree).toBeFocused();
  await expect(page.locator(".editor-surface")).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect.poll(async () => (await page.request.get(endpoint)).json()).toEqual([]);
});

test("sidebars fill mobile width only and keep body top padding at zero", async ({ page }) => {
  await signIn(page);
  await page.goto("/v/personal/Welcome.md");
  await expect(page.locator(".editor-surface .tiptap")).toBeVisible();
  for (const width of [767, 768, 1024, 412]) {
    await page.setViewportSize({ width, height: 900 });
    await showNavigation(page);
    const left = page.getByRole("complementary", { name: "Navigation", exact: true });
    if (width < 768) {
      const bounds = await left.boundingBox();
      expect(bounds?.x).toBe(0);
      expect(bounds?.width).toBe(width);
    } else {
      expect((await left.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(248);
      expect((await left.boundingBox())?.width ?? 0).toBeLessThanOrEqual(560);
    }
    await expect(left.locator(".sidebar-body")).toHaveCSS("padding-top", "0px");
    await page.getByRole("button", { name: "Hide Navigation", exact: true }).click();
    const showContext = page.getByRole("button", { name: "Show Context", exact: true });
    if (await showContext.isVisible()) await showContext.click();
    const right = page.getByRole("complementary", { name: "Context", exact: true });
    if (width < 768) {
      const bounds = await right.boundingBox();
      expect(bounds?.x).toBe(0);
      expect(bounds?.width).toBe(width);
    } else {
      expect((await right.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(248);
      expect((await right.boundingBox())?.width ?? 0).toBeLessThanOrEqual(560);
    }
    await expect(right.locator(".sidebar-body")).toHaveCSS("padding-top", "0px");
    await page.getByRole("button", { name: "Hide Context", exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    // Real pointer focus proves the collapsed full-width frames do not eat editor taps.
    const editor = page.locator(".editor-surface .tiptap");
    await editor.click();
    await expect(editor).toBeFocused();
  }
});

test("desktop panels resize by keyboard and pointer, persist and leave room for main content", async ({ page }, info) => {
  await signIn(page);
  await page.goto("/v/personal");
  await showNavigation(page);
  await page.getByRole("button", { name: "Show Context", exact: true }).click();
  if (info.project.name === "mobile") {
    await expect(page.getByRole("separator", { name: /Resize (Navigation|Context)/ })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
    return;
  }
  const widths = new Map<string, number>();
  for (const [name, direction, key] of [["Navigation", 1, "ArrowRight"], ["Context", -1, "ArrowLeft"]] as const) {
    const handle = page.getByRole("separator", { name: `Resize ${name}`, exact: true });
    const panel = page.getByRole("complementary", { name, exact: true });
    const initial = (await panel.boundingBox())?.width ?? 0;
    await handle.focus();
    await page.keyboard.press(key);
    await expect.poll(async () => (await panel.boundingBox())?.width ?? 0).toBeGreaterThan(initial);
    const rect = await handle.boundingBox();
    expect(rect).not.toBeNull();
    if (rect === null) throw new Error("Missing resize handle bounds");
    const before = Number(await handle.getAttribute("aria-valuenow"));
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width / 2 + 64 * direction, rect.y + rect.height / 2);
    await page.mouse.up();
    await expect.poll(async () => Number(await handle.getAttribute("aria-valuenow"))).toBeGreaterThan(before);
    widths.set(name, Number(await handle.getAttribute("aria-valuenow")));
  }
  await page.reload();
  await page.getByRole("button", { name: "Show Context", exact: true }).click();
  for (const name of ["Navigation", "Context"]) {
    await expect(page.getByRole("separator", { name: `Resize ${name}`, exact: true })).toHaveAttribute("aria-valuenow", String(widths.get(name)));
  }
  await page.setViewportSize({ width: 1024, height: 800 });
  const left = page.getByRole("separator", { name: "Resize Navigation", exact: true });
  await left.focus();
  await page.keyboard.press("End");
  await expect.poll(async () => (await page.locator(".workspace-main").boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024);
  await page.screenshot({ path: info.outputPath("resized-panels.png") });
});
