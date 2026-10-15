/** The catalogue must draw, accept keyboard/touch input and persist ordinary Markdown. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_VAULT } from "./environment.js";
import { expect, signIn, test } from "./fixtures.js";
import type { Page } from "@playwright/test";

async function createNote(page: Page, project: string): Promise<{ path: string; disk: () => string }> {
  const path = `Catalogue actions ${project} ${randomUUID()}.md`;
  expect((await page.request.post("/api/v1/vaults/personal/notes", { data: { path, content: "# Title\n\nBody\n\nAfter\n" } })).ok()).toBe(true);
  await page.goto(`/v/personal/${encodeURIComponent(path)}`);
  const editor = page.locator(".editor-surface .tiptap");
  await expect(editor).toContainText("Body");
  await editor.getByText("Body", { exact: true }).click();
  await expect.poll(() => editor.evaluate(root => (root as HTMLElement & { editor?: { state: { selection: { $head: { parent: { textContent: string } } } } } }).editor?.state.selection.$head.parent.textContent)).toBe("Body");
  return { path, disk: () => readFileSync(join(E2E_VAULT, path), "utf8") };
}

test("block catalogue filters and inserts a web bookmark and date on disk", async ({ page }, info) => {
  await signIn(page);
  const path = `Block catalogue ${info.project.name} ${randomUUID()}.md`;
  expect((await page.request.post("/api/v1/vaults/personal/notes", { data: { path, content: "# Title\n\nBody\n" } })).ok()).toBe(true);
  await page.goto(`/v/personal/${encodeURIComponent(path)}`);
  const editor = page.locator(".editor-surface .tiptap");
  await expect(editor).toContainText("Body");
  await editor.getByText("Body", { exact: true }).click();
  await expect.poll(() => editor.evaluate(root => (root as HTMLElement & { editor?: { state: { selection: { $head: { parent: { textContent: string } } } } } }).editor?.state.selection.$head.parent.textContent)).toBe("Body");
  await page.getByRole("button", { name: "Insert block", exact: true }).click();
  const menu = page.getByRole("dialog", { name: "Block menu", exact: true });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Heading 4", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("block-catalog-open.png") });
  await menu.getByRole("searchbox", { name: "Filter blocks" }).fill("bookmark");
  await menu.getByRole("menuitem", { name: "Web bookmark", exact: true }).click();
  await menu.getByRole("textbox", { name: "URL", exact: true }).fill("https://example.com/guide");
  await menu.getByRole("textbox", { name: "Link label", exact: true }).fill("Guide 🫐");
  await menu.getByRole("button", { name: "Insert", exact: true }).click();
  await expect(menu).toBeHidden();
  const disk = () => readFileSync(join(E2E_VAULT, path), "utf8");
  await expect.poll(disk).toContain("[Guide 🫐](https://example.com/guide)");
  await page.getByRole("button", { name: "Insert block", exact: true }).click();
  await menu.getByRole("searchbox", { name: "Filter blocks" }).fill("date");
  await menu.getByRole("searchbox", { name: "Filter blocks" }).press("ArrowDown");
  await page.keyboard.press("Enter");
  const bounds = await menu.boundingBox();
  expect(bounds).not.toBeNull();
  expect((bounds?.y ?? -1)).toBeGreaterThanOrEqual(0);
  expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(page.viewportSize()?.height ?? 0);
  await menu.locator('input[aria-label="Date"]').fill("2026-12-24");
  await menu.getByRole("button", { name: "Insert", exact: true }).click();
  await expect.poll(disk).toContain("2026-12-24");
  await page.reload();
  await expect(editor).toContainText("Guide 🫐");
  await expect(editor).toContainText("2026-12-24");
  await page.screenshot({ path: info.outputPath("block-catalog.png") });
});

test("block actions insert below and convert through desktop handles or mobile tools", async ({ page }, info) => {
  await signIn(page);
  const { disk } = await createNote(page, info.project.name);
  const editor = page.locator(".editor-surface .tiptap");
  if (info.project.name === "desktop") {
    await editor.getByText("Body", { exact: true }).hover();
    await page.locator(".block-handles").getByRole("button", { name: "Block actions", exact: true }).click();
    await page.locator(".block-move-menu").getByRole("menuitem", { name: "Insert below…", exact: true }).click();
  } else await page.getByRole("button", { name: "Insert block", exact: true }).click();
  const menu = page.getByRole("dialog", { name: "Block menu", exact: true });
  await menu.getByRole("menuitem", { name: "Heading 4", exact: true }).click();
  await page.keyboard.type("New section");
  await expect.poll(disk).toContain("Body\n\n#### New section\n\nAfter");
  await expect(editor.locator("h4")).toHaveText("New section");
  if (info.project.name === "desktop") {
    await editor.getByText("New section", { exact: true }).hover();
    await expect(page.locator(".block-handles")).toBeVisible();
    await page.locator(".block-handles").getByRole("button", { name: "Block actions", exact: true }).click();
    await page.locator(".block-move-menu").getByRole("menuitem", { name: "Turn into…", exact: true }).click();
  } else {
    await page.getByLabel("More editing tools", { exact: true }).click();
    await page.getByRole("button", { name: "Turn current block into another type", exact: true }).click();
  }
  await expect(menu.getByRole("menuitem", { name: "Heading 2", exact: true })).toBeEnabled();
  await menu.getByRole("menuitem", { name: "Heading 2", exact: true }).click();
  await expect.poll(disk).toContain("Body\n\n## New section\n\nAfter");
  await page.reload(); await expect(editor.locator("h2")).toHaveText("New section");
});

test("catalogue routes note links through the existing authorized document chooser", async ({ page }, info) => {
  await signIn(page); const { disk } = await createNote(page, info.project.name);
  await page.getByRole("button", { name: "Insert block", exact: true }).click();
  const menu = page.getByRole("dialog", { name: "Block menu", exact: true });
  await menu.getByRole("searchbox", { name: "Filter blocks" }).fill("note");
  await menu.getByRole("menuitem", { name: "Link to note", exact: true }).click();
  await page.keyboard.type("road");
  const suggestions = page.getByRole("listbox", { name: "Document suggestions" });
  await expect(suggestions).toBeVisible();
  await suggestions.getByRole("option").filter({ hasText: "Projects/Roadmap.md" }).click();
  await expect.poll(disk).toContain("[Roadmap](Projects/Roadmap.md)");
});

test("slash insertion consumes its trigger and Escape stays dismissed", async ({ page }, info) => {
  await signIn(page); const { disk } = await createNote(page, info.project.name);
  const editor = page.locator(".editor-surface .tiptap");
  const body = editor.getByText("Body", { exact: true }); const bounds = await body.boundingBox();
  if (!bounds) throw new Error("body is not laid out");
  await body.click({ position: { x: bounds.width - 2, y: bounds.height - 2 } });
  await page.keyboard.type(" /date");
  const menu = page.getByRole("dialog", { name: "Block menu", exact: true });
  await expect(menu).toBeVisible(); await page.keyboard.press("Escape"); await expect(menu).toBeHidden();
  await page.keyboard.press("Backspace"); await page.keyboard.type("e");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Date", exact: true }).click();
  await menu.locator('input[aria-label="Date"]').fill("2026-12-24");
  await menu.getByRole("button", { name: "Insert", exact: true }).click();
  await expect.poll(disk).toBe("# Title\n\nBody 2026-12-24\n\nAfter\n");
});

test("catalogue inserts equations, code, emoji and an uploaded image", async ({ page }, info) => {
  await signIn(page); const { disk } = await createNote(page, info.project.name);
  const menu = page.getByRole("dialog", { name: "Block menu", exact: true });
  const choose = async (name: string): Promise<void> => {
    await page.getByRole("button", { name: "Insert block", exact: true }).click();
    await menu.getByRole("searchbox", { name: "Filter blocks" }).fill(name);
    await menu.getByRole("menuitem", { name, exact: true }).click();
  };
  await choose("Inline equation"); await menu.getByRole("textbox", { name: "Equation", exact: true }).fill("x^2");
  await menu.getByRole("button", { name: "Insert", exact: true }).click();
  await expect.poll(disk).toContain("$x^2$");
  await choose("Emoji");
  await page.getByRole("searchbox", { name: "Search emoji", exact: true }).fill("tada");
  await page.getByRole("button", { name: ":tada:", exact: true }).click();
  await expect.poll(disk).toContain("🎉");
  await choose("Image");
  await page.locator('.media-controls input[type="file"]').setInputFiles({ name: "catalogue.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64") });
  await expect.poll(disk).toMatch(/!\[catalogue\.png\]\(media\//u);
  await choose("Block equation"); await menu.getByRole("textbox", { name: "Equation", exact: true }).fill("a+b");
  await menu.getByRole("button", { name: "Insert", exact: true }).click();
  await expect.poll(disk).toContain("$$\na+b\n$$");
  await choose("Code"); await menu.getByRole("textbox", { name: "Language", exact: true }).fill("typescript");
  await menu.getByRole("button", { name: "Insert", exact: true }).click();
  await page.keyboard.type("const value = 1;");
  await expect.poll(disk).toContain("```typescript\nconst value = 1;\n```");
});
