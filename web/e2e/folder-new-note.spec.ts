/** Folder-menu note creation, including empty nested folders (SPEC §6.10, §8.2). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_VAULT } from "./environment.js";
import { expect, signIn, test, openSidebar } from "./fixtures.js";

for (const gesture of ["pointer", "keyboard"] as const) {
  test(`folder New note creates editable Markdown in an empty nested folder via ${gesture}`, async ({ page }, info) => {
    await signIn(page);
    const parent = `Folder creation ${gesture} ${info.project.name}`;
    const folder = `${parent}/ملاحظات ✨`;
    const response = await page.request.post("/api/v1/vaults/personal/folders", { data: { path: folder } });
    expect(response.ok()).toBe(true);
    await page.goto("/v/personal/Projects/Roadmap.md");
    await expect(page.locator(".editor-surface .tiptap")).toBeVisible();
    await openSidebar(page, "Navigation");
    const tree = page.getByRole("tree", { name: "Notes", exact: true });
    await tree.getByRole("treeitem", { name: parent, exact: true }).click();
    const row = tree.getByRole("treeitem", { name: "ملاحظات ✨", exact: true });
    if (gesture === "keyboard") {
      await tree.focus();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Shift+F10");
    } else if (info.project.name === "mobile") {
      await row.getByRole("button", { name: "Folder actions for ملاحظات ✨", exact: true }).tap();
    } else {
      await row.click({ button: "right" });
    }
    const menu = page.getByRole("menu", { name: "Folder actions", exact: true });
    await expect(menu).toBeVisible();
    await page.screenshot({ path: info.outputPath("folder-new-note-menu.png") });
    const create = menu.getByRole("menuitem", { name: "New note", exact: true });
    if (gesture === "keyboard") {
      await page.keyboard.press("Home");
      await expect(create).toBeFocused();
      await page.keyboard.press("Enter");
    } else await create.click();
    const prompt = page.getByRole("dialog", { name: "New note", exact: true });
    await expect(menu).toBeHidden();
    await expect(prompt.locator(".rename-subject")).toHaveText(`In ${folder}/`);
    await expect(prompt.getByLabel("Name", { exact: true })).toBeFocused();
    await prompt.getByLabel("Name", { exact: true }).fill("Folder note");
    await prompt.getByRole("button", { name: "Create", exact: true }).click();
    const editor = page.getByRole("region", { name: `Note editor: ${folder}/Folder note.md`, exact: true });
    await expect(editor.getByRole("heading", { name: "Folder note", exact: true })).toBeVisible();
    const disk = (): string => readFileSync(join(E2E_VAULT, folder, "Folder note.md"), "utf8");
    expect(disk()).toBe("# Folder note\n");
    await page.keyboard.type("Written inside the folder.");
    await expect(editor.locator(".tiptap p")).toContainText("Written inside the folder.");
    await expect.poll(disk, { timeout: 15_000 }).toContain("Written inside the folder.");
  });
}
