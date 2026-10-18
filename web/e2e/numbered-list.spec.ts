/** Numbered-list Return regression, including canonical Markdown persistence (SPEC §8.4). */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_VAULT } from "./environment.js";
import { expect, signIn, test } from "./fixtures.js";

test("Return continues numbered items, Shift+Return keeps a line, and an empty item exits", async ({ page }, info) => {
  await signIn(page);
  const path = `Numbered ${info.project.name} ${randomUUID()}.md`;
  const response = await page.request.post("/api/v1/vaults/personal/notes", {
    data: { path, content: "# Numbered list\n\n1. First\n" },
  });
  expect(response.ok(), await response.text()).toBe(true);
  await page.goto(`/v/personal/${encodeURIComponent(path)}`);
  const editor = page.locator(".editor-surface .tiptap");
  const items = editor.locator("ol > li");
  await expect(items).toHaveCount(1);
  await items.locator("p").click();
  await page.keyboard.press("End");
  // why: native selectionchange can arrive after Playwright's next keypress.
  await expect.poll(() => editor.evaluate((root) => {
    const model = (root as HTMLElement & { editor?: { state: { selection: { $head: { parent: { textContent: string } } } } } }).editor;
    return model?.state.selection.$head.parent.textContent;
  })).toBe("First");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Second");
  await expect(items).toHaveText(["First", "Second"]);
  await expect(items.nth(1)).toHaveCSS("display", "list-item");
  await expect(editor.locator("ol")).toHaveCSS("list-style-type", "decimal");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("continued");
  await expect(items).toHaveCount(2);
  await expect(items.nth(1).locator("br")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await page.keyboard.type("Third");
  await expect(items).toHaveCount(3);
  const disk = () => readFileSync(join(E2E_VAULT, path), "utf8");
  await expect.poll(disk, { timeout: 15_000 }).toBe("# Numbered list\n\n1. First\n1. Second\\\n   continued\n1. Third\n");
  await page.keyboard.press("Enter");
  await expect(items).toHaveCount(4);
  await page.keyboard.press("Enter");
  await page.keyboard.type("Outside");
  await expect(items).toHaveCount(3);
  await expect(editor.locator(":scope > p")).toHaveText("Outside");
  await expect.poll(disk, { timeout: 15_000 }).toBe("# Numbered list\n\n1. First\n1. Second\\\n   continued\n1. Third\n\nOutside\n");
  await page.screenshot({ path: info.outputPath("numbered-list.png") });
  await page.reload();
  await expect(items).toHaveText(["First", "Secondcontinued", "Third"]);
  await expect(editor.locator(":scope > p")).toHaveText("Outside");
});
