/** Folder rename and guarded deletion, on desktop and touch (SPEC §8.2). */
import { expect, signIn, test, openSidebar } from "./fixtures.js";

test("folder actions open rename and require an exact name for nonempty deletion", async ({ page }, info) => {
  await signIn(page);
  await page.goto("/v/personal/Projects/Roadmap.md");
  await expect(page.locator(".editor-surface .tiptap")).toBeVisible();
  await openSidebar(page, "Navigation");
  const row = page.getByRole("treeitem", { name: "Projects", exact: true });
  const openMenu = async () => {
    if (info.project.name === "mobile") await row.getByRole("button", { name: "Folder actions for Projects", exact: true }).tap();
    else await row.click({ button: "right" });
  };
  await openMenu();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  const rename = page.getByRole("dialog", { name: "Rename folder", exact: true });
  await expect(rename.getByLabel("Name", { exact: true })).toHaveValue("Projects");
  await expect(rename.getByLabel("Name", { exact: true })).toBeFocused();
  await rename.getByRole("button", { name: "Cancel", exact: true }).click();
  await openMenu();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  const prompt = page.getByRole("dialog", { name: "Delete folder", exact: true });
  await expect(prompt.getByLabel("Folder name", { exact: true })).toBeFocused();
  const confirm = prompt.getByRole("button", { name: "Delete", exact: true });
  await expect(confirm).toBeDisabled();
  await prompt.getByLabel("Folder name", { exact: true }).fill("Projects ");
  await expect(confirm).toBeDisabled();
  await prompt.getByLabel("Folder name", { exact: true }).fill("Projects");
  await expect(confirm).toBeEnabled();
  await page.screenshot({ path: info.outputPath("folder-delete-confirmation.png") });
  await prompt.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(prompt).toBeHidden();
  await expect(row).toBeVisible();
});

test("folder rename persists and confirmed deletion trashes notes and removes empty descendants", async ({ page }, info) => {
  const { existsSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { E2E_VAULT } = await import("./environment.js");
  await signIn(page);
  const parent = `Folder actions ${info.project.name}`;
  const folder = `${parent}/Original`;
  const renamed = `${parent}/ملاحظات ✨`;
  expect((await page.request.post("/api/v1/vaults/personal/folders", { data: { path: `${folder}/Nested empty` } })).ok()).toBe(true);
  expect((await page.request.post("/api/v1/vaults/personal/folders", { data: { path: `${parent}/Empty` } })).ok()).toBe(true);
  expect((await page.request.post("/api/v1/vaults/personal/notes", { data: { path: `${folder}/Keep.md`, content: "# Custom title\n" } })).ok()).toBe(true);
  await page.goto(`/v/personal/${encodeURIComponent(parent)}/Original/Keep.md`);
  await expect(page.locator(".editor-surface .tiptap")).toBeVisible();
  const showNavigation = async () => {
    await openSidebar(page, "Navigation");
  };
  await showNavigation();
  const tree = page.getByRole("tree", { name: "Notes", exact: true });
  const parentRow = tree.getByRole("treeitem", { name: parent, exact: true });
  if (await parentRow.getAttribute("aria-expanded") !== "true") await parentRow.click();
  const openMenu = async (name: string) => {
    const row = tree.getByRole("treeitem", { name, exact: true });
    if (info.project.name === "mobile") await row.getByRole("button", { name: `Folder actions for ${name}`, exact: true }).tap();
    else await row.click({ button: "right" });
  };
  // The keyboard menu shares the same actions as pointer/touch.
  await tree.getByRole("treeitem", { name: "Original", exact: true }).click();
  await tree.focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  const rename = page.getByRole("dialog", { name: "Rename folder", exact: true });
  await rename.getByLabel("Name", { exact: true }).fill("ملاحظات ✨");
  await rename.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(rename).toBeHidden();
  await expect(page.getByRole("region", { name: `Note editor: ${renamed}/Keep.md`, exact: true })).toBeVisible();
  expect(readFileSync(join(E2E_VAULT, renamed, "Keep.md"), "utf8")).toBe("# Custom title\n");
  expect(existsSync(join(E2E_VAULT, folder))).toBe(false);
  // Empty folders delete directly, without a typed confirmation.
  await showNavigation();
  await openMenu("Empty");
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await expect(tree.getByRole("treeitem", { name: "Empty", exact: true })).toHaveCount(0);
  expect(existsSync(join(E2E_VAULT, parent, "Empty"))).toBe(false);
  await openMenu("ملاحظات ✨");
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  const prompt = page.getByRole("dialog", { name: "Delete folder", exact: true });
  await prompt.getByLabel("Folder name", { exact: true }).fill("ملاحظات ✨");
  await prompt.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(prompt).toBeHidden();
  await expect(tree.getByRole("treeitem", { name: "ملاحظات ✨", exact: true })).toHaveCount(0);
  expect(existsSync(join(E2E_VAULT, renamed))).toBe(false);
  const trash = await page.request.get("/api/v1/vaults/personal/trash");
  const body: unknown = await trash.json();
  if (typeof body !== "object" || body === null || !("entries" in body) || !Array.isArray(body.entries)) throw new Error("Invalid trash response");
  const entry: unknown = body.entries.find((entry: unknown) => typeof entry === "object" && entry !== null && "path" in entry && entry.path === `${renamed}/Keep.md`);
  if (typeof entry !== "object" || entry === null || !("id" in entry) || typeof entry.id !== "string") throw new Error("Deleted note is missing from trash");
  expect(readFileSync(join(E2E_VAULT, ".trash", `${entry.id}.md`), "utf8")).toBe("# Custom title\n");
  expect((await page.request.post(`/api/v1/vaults/personal/trash/${entry.id}`)).ok()).toBe(true);
  expect(readFileSync(join(E2E_VAULT, renamed, "Keep.md"), "utf8")).toBe("# Custom title\n");
});
