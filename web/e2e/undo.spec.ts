import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, signIn, test } from "./fixtures.js";
import { E2E_VAULT, scratchNote } from "./environment.js";

test("typing can be undone and redone with keyboard shortcuts and saved to Markdown", async ({ page }, info) => {
  const note = scratchNote("undo", info.project.name);
  await signIn(page);
  await page.goto(`/v/personal/${note}`);
  const editor = page.locator(".editor-surface .tiptap");
  await expect(editor).toBeVisible();
  await expect(editor).toHaveAttribute("contenteditable", "true");
  const paragraph = editor.locator("p").filter({ hasText: "A note this test may edit." });
  await paragraph.click();
  const original = await editor.innerText();
  const marker = "UNDO-REGRESSION";
  const path = join(E2E_VAULT, ...note.split("/"));
  await page.keyboard.type(marker);
  await expect(editor).toContainText(marker);
  await expect.poll(() => readFileSync(path, "utf8")).toContain(marker);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editor).toHaveText(original, { useInnerText: true });
  await expect.poll(() => readFileSync(path, "utf8")).not.toContain(marker);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(editor).toContainText(marker);
  await expect.poll(() => readFileSync(path, "utf8")).toContain(marker);
});
