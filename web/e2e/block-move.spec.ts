/** Block movement through the real handles, gate, CRDT and disk (SPEC §8.4). */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_VAULT } from "./environment.js";
import { expect, signIn, test } from "./fixtures.js";

const EDITOR = ".editor-surface .tiptap";

test("the block menu moves a block, saves it, and undo puts it and the caret back", async ({ page }, info) => {
  await signIn(page);
  const path = `Block move ${info.project.name} ${randomUUID()}.md`;
  const initial = "# Title\n\nAlpha\n\nBeta\n\nGamma\n";
  expect((await page.request.post("/api/v1/vaults/personal/notes", { data: { path, content: initial } })).ok()).toBe(true);
  await page.goto(`/v/personal/${encodeURIComponent(path)}`);
  const editor = page.locator(EDITOR);
  await expect(editor).toContainText("Gamma");
  const disk = () => readFileSync(join(E2E_VAULT, path), "utf8");

  await editor.getByText("Alpha", { exact: true }).click();
  await page.keyboard.press("Alt+Shift+F10");
  const menu = page.getByRole("menu", { name: "Move paragraph", exact: true });
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("Single-editor rearrangement only");
  await expect(menu).toBeInViewport();
  await page.screenshot({ path: info.outputPath("block-menu.png") });
  await menu.getByRole("menuitem", { name: "Move down", exact: true }).click();
  await expect.poll(disk, { timeout: 15_000 }).toBe("# Title\n\nBeta\n\nAlpha\n\nGamma\n");

  await editor.focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(disk, { timeout: 15_000 }).toBe(initial);
  await expect.poll(() => page.evaluate(() => {
    const selection = document.getSelection();
    return selection?.anchorNode?.parentElement?.closest("p")?.textContent;
  })).toBe("Alpha");
});
