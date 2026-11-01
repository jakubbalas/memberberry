import { readFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_VAULT, scratchNote } from "./environment.js";
import { expect, signIn, test } from "./fixtures.js";

test("the emoji picker dismisses on outside clicks and Escape, including after focus moves", async ({ page }, info) => {
  await signIn(page);
  await page.goto("/v/personal/Welcome.md");
  await expect(page.locator(".editor-surface .tiptap")).toBeVisible();
  const toggle = page.getByRole("button", { name: "Insert emoji", exact: true });
  const picker = page.getByRole("dialog", { name: "Emoji picker", exact: true });
  const outside = page.getByRole("button", { name: "Quick find", exact: true });
  await toggle.click();
  await expect(picker).toBeVisible();
  await picker.getByRole("searchbox", { name: "Search emoji" }).fill("wave");
  await picker.getByRole("button", { name: "Show custom emoji", exact: true }).click();
  await expect(picker).toBeVisible();
  if (info.project.name === "mobile") await outside.tap();
  else await outside.click();
  await expect(picker).toBeHidden();
  // The same outside click must still open the requested control.
  const quickFind = page.getByRole("combobox", { name: "Open a note", exact: true });
  await expect(quickFind).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(quickFind).toBeHidden();

  await toggle.click();
  await expect(picker).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await expect(toggle).toBeFocused();

  await toggle.click();
  // Moving focus alone leaves the picker open; Escape must still reach it.
  await outside.focus();
  await expect(picker).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await expect(toggle).toBeFocused();
  await toggle.click();
  await expect(picker).toBeVisible();
  // why: the mobile bottom sheet can cover the toolbar toggle; its keyboard action remains available.
  await toggle.press("Enter");
  await expect(picker).toBeHidden();
});

test("an individual PNG can be selected, imported, rendered and inserted as a Markdown shortcode", async ({ page }, info) => {
  const note = scratchNote("emoji-import", info.project.name);
  const shortcode = `mb-import-${info.project.name}`;
  await signIn(page);
  await page.goto(`/v/personal/${note}`);
  const editor = page.locator(".editor-surface .tiptap");
  await expect(editor).toContainText("A note this test may edit");
  const toggle = page.getByRole("button", { name: "Insert emoji", exact: true });
  await toggle.click();
  const picker = page.getByRole("dialog", { name: "Emoji picker", exact: true });
  await expect(picker.getByRole("button", { name: /Slack/i })).toHaveCount(0);
  const chooseFiles = page.getByRole("button", { name: "Import custom emoji from images or ZIP files", exact: true });
  const choosing = page.waitForEvent("filechooser");
  await chooseFiles.click();
  const chooser = await choosing;
  // why: injecting files into a directory input bypasses the native chooser defect.
  expect(await chooser.element().getAttribute("webkitdirectory")).toBeNull();
  page.once("dialog", (dialog) => dialog.accept(`png-import-${info.project.name}`));
  await chooser.setFiles({
    name: `${shortcode}.png`, mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  });
  const item = picker.getByRole("button", { name: `:${shortcode}:`, exact: true });
  await expect(item).toBeVisible();
  await expect.poll(() => item.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);

  // Reloading exercises the installed pack rather than only the in-memory picker update.
  await page.reload();
  await expect(editor).toContainText("A note this test may edit");
  await toggle.click();
  await picker.getByRole("searchbox", { name: "Search emoji" }).fill(shortcode);
  await expect(item).toBeVisible();
  await expect.poll(() => item.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
  await page.screenshot({ path: info.outputPath("png-imported.png") });
  await item.click();
  await expect.poll(() => readFileSync(join(E2E_VAULT, note), "utf8"), { timeout: 15_000 }).toContain(`:${shortcode}:`);

  await toggle.click();
  const choosingFolder = page.waitForEvent("filechooser");
  await picker.getByRole("button", { name: "Import custom emoji from a folder", exact: true }).click();
  expect(await (await choosingFolder).element().getAttribute("webkitdirectory")).toBe("");
  const choosingAgain = page.waitForEvent("filechooser");
  await chooseFiles.click();
  expect(await (await choosingAgain).element().getAttribute("webkitdirectory")).toBeNull();
});
