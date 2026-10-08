import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator } from "@playwright/test";
import { expect, signIn, test } from "./fixtures.js";
import { E2E_VAULT } from "./environment.js";

const EDITOR = ".editor-surface .tiptap";

async function endOfLine(line: Locator): Promise<void> {
  const bounds = await line.boundingBox();
  if (bounds === null) throw new Error("editor line not laid out");
  await line.click({ position: { x: bounds.width - 2, y: bounds.height - 2 } });
}

test("bullets continue and nest with keyboard input, and typed inline code saves as Markdown", async ({ page }, info) => {
  await signIn(page);
  const source = `EditorInput/Keyboard-${info.project.name}.md`;
  const response = await page.request.post("/api/v1/vaults/personal/notes", {
    data: { path: source, content: "# Keyboard input\n\n- First\n- Second\n\nType here.\n" },
  });
  expect(response.ok(), await response.text()).toBe(true);
  await page.goto(`/v/personal/${source}`);
  const editor = page.locator(EDITOR);
  await expect(editor).toContainText("Second");
  await endOfLine(editor.locator("ul > li > p").filter({ hasText: "Second" }));
  await page.keyboard.press("Enter");
  await page.keyboard.type("Third");
  await expect(editor.locator("ul > li > p").filter({ hasText: "Third" })).toBeVisible();
  await expect(editor.locator("ul").first().locator(":scope > li")).toHaveCount(3);
  await page.keyboard.press("Tab");
  await expect(editor.locator("ul > li > ul > li > p").filter({ hasText: "Third" })).toBeVisible();
  const path = join(E2E_VAULT, source);
  await expect.poll(() => readFileSync(path, "utf8"), { timeout: 15_000 }).toContain("  - Third");
  await page.keyboard.press("Shift+Tab");
  await expect(editor.locator("ul").first().locator(":scope > li")).toHaveCount(3);

  await endOfLine(editor.getByText("Type here.", { exact: true }));
  await page.keyboard.type(" `code`");
  await expect(editor.locator("p code")).toHaveText("code");
  await expect.poll(() => readFileSync(path, "utf8"), { timeout: 15_000 }).toContain("- Third");
  await expect.poll(() => readFileSync(path, "utf8"), { timeout: 15_000 }).toContain("`code`");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editor.locator("p code")).toHaveCount(0);
  await expect.poll(() => readFileSync(path, "utf8"), { timeout: 15_000 }).not.toContain("`code`");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(editor.locator("p code")).toHaveText("code");
});
