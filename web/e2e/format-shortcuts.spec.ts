/** Real keyboard formatting, persisted as Markdown, on desktop and mobile viewports. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_VAULT } from "./environment.js";
import { expect, signIn, test } from "./fixtures.js";

test("formatting shortcuts toggle selections, format new typing, open links and survive reload", async ({ page }, info) => {
  await signIn(page);
  const path = `Formatting keys ${info.project.name} ${randomUUID()}.md`;
  const initial = "# Title\n\nBody words\n";
  expect((await page.request.post("/api/v1/vaults/personal/notes", { data: { path, content: initial } })).ok()).toBe(true);
  await page.goto(`/v/personal/${encodeURIComponent(path)}`);
  const editor = page.locator(".editor-surface .tiptap");
  const paragraph = editor.locator("p");
  const disk = () => readFileSync(join(E2E_VAULT, path), "utf8");
  await expect(editor).toBeFocused();
  await paragraph.click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe("Body words");
  for (const [key, selector] of [["b", "strong"], ["i", "em"], ["u", ".mb-underline"], ["e", "code"], ["Shift+x", "s"], ["Shift+h", "mark"]] as const) {
    await page.keyboard.press(`ControlOrMeta+${key}`);
    await expect(paragraph.locator(selector)).toHaveText("Body words");
    await page.keyboard.press(`ControlOrMeta+${key}`);
    await expect(paragraph.locator(selector)).toHaveCount(0);
  }
  await expect.poll(disk).toBe(initial);
  await page.keyboard.press("ControlOrMeta+k");
  const destination = page.getByRole("textbox", { name: "Link destination", exact: true });
  await expect(destination).toBeFocused();
  await destination.fill("https://example.com");
  await page.keyboard.press("Enter");
  await expect(paragraph.locator("a")).toHaveAttribute("href", "https://example.com");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(paragraph.locator("a")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(paragraph.locator("a")).toHaveCount(1);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("End");
  await page.keyboard.type(" ");
  await page.keyboard.press("ControlOrMeta+b");
  await page.keyboard.type("Bold");
  await page.keyboard.press("ControlOrMeta+b");
  await page.keyboard.type(" plain");
  await expect(paragraph.locator("strong")).toHaveText("Bold");
  // The caret is inside the authored link: toggling Bold preserves that independent mark.
  await expect.poll(disk).toBe("# Title\n\n[Body words ](https://example.com)**[Bold](https://example.com)**[ plain](https://example.com)\n");
  await page.reload();
  await expect(paragraph.locator("strong")).toHaveText("Bold");
  await expect(paragraph).toContainText(" plain");
  await expect(paragraph.locator("a").first()).toHaveAttribute("href", "https://example.com");
});
