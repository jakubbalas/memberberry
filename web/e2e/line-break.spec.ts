/** Shift-Enter adds a line inside the same block, saved as a Markdown hard break (SPEC §8.4). */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_VAULT } from "./environment.js";
import type { Page } from "@playwright/test";
import { expect, signIn, test } from "./fixtures.js";

const EDITOR = ".editor-surface .tiptap";

/** The text of the block holding the editor model's caret (Tiptap exposes itself on its root). */
function modelCaretBlock(page: Page): Promise<string | undefined> {
  return page.locator(EDITOR).evaluate((root) => {
    const editor = (root as HTMLElement & { editor?: { state: { selection: { $head: { parent: { textContent: string } } } } } }).editor;
    return editor?.state.selection.$head.parent.textContent;
  });
}

test("Shift+Enter keeps a second line in the same block and on disk", async ({ page }, info) => {
  await signIn(page);
  const path = `Line break ${info.project.name} ${randomUUID()}.md`;
  expect((await page.request.post("/api/v1/vaults/personal/notes", { data: { path, content: "# Title\n\nFirst line\n\n- item\n\n## Section\n" } })).ok()).toBe(true);
  await page.goto(`/v/personal/${encodeURIComponent(path)}`);
  const editor = page.locator(EDITOR);
  await expect(editor).toContainText("First line");
  const disk = () => readFileSync(join(E2E_VAULT, path), "utf8");

  await editor.getByText("First line", { exact: true }).click();
  await page.keyboard.press("End");
  await expect.poll(() => modelCaretBlock(page)).toBe("First line");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("second line");
  await editor.getByText("item", { exact: true }).click();
  await page.keyboard.press("End");
  // why: Playwright can press the next key before the browser's selectionchange reaches
  // ProseMirror, which then edits at the pre-click caret. Wait for the model to catch up.
  await expect.poll(() => modelCaretBlock(page)).toBe("item");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("more");
  await expect.poll(disk, { timeout: 15_000 }).toBe("# Title\n\nFirst line\\\nsecond line\n\n- item\\\n  more\n\n## Section\n");

  const paragraph = editor.locator("p", { hasText: "First line" });
  await expect(paragraph.locator("br")).toHaveCount(1);
  await expect(paragraph).toContainText("second line");
  await expect(editor.locator("li")).toHaveCount(1);
  await page.screenshot({ path: info.outputPath("line-break.png") });

  // A heading is one line in Markdown: Shift+Enter must not leave a break the file cannot hold.
  await editor.getByText("Section", { exact: true }).click();
  await page.keyboard.press("End");
  await expect.poll(() => modelCaretBlock(page)).toBe("Section");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("!");
  await expect(editor.locator("h2 br")).toHaveCount(0);
  await expect.poll(disk, { timeout: 15_000 }).toContain("\n## Section!\n");

  await page.reload();
  await expect(editor.locator("p", { hasText: "First line" })).toContainText("second line");
});
