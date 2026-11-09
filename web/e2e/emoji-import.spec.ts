import { readFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_VAULT, scratchNote } from "./environment.js";
import { expect, signIn, test, openSidebar } from "./fixtures.js";

test("colon plus one character opens inline emoji suggestions and a bare colon stays closed", async ({ page }, info) => {
  const note = scratchNote("emoji-colon", info.project.name);
  await signIn(page);
  await page.goto(`/v/personal/${note}`);
  const editor = page.locator(".editor-surface .tiptap");
  const paragraph = editor.getByText("A note this test may edit.", { exact: true });
  await expect(paragraph).toBeVisible();
  const line = await paragraph.boundingBox();
  if (line === null) throw new Error("note body is not laid out");
  await paragraph.click({ position: { x: line.width - 2, y: line.height / 2 } });
  await page.keyboard.type(" :");
  const suggestions = page.getByRole("listbox", { name: "Emoji suggestions", exact: true });
  await expect(suggestions).toBeHidden();
  await page.keyboard.type("t");
  await expect(suggestions).toBeVisible();
  await expect(suggestions.getByRole("option")).toHaveCount(8);
  const bounds = await suggestions.boundingBox();
  const viewport = page.viewportSize();
  if (bounds === null || viewport === null) throw new Error("suggestion bounds missing");
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
  await page.screenshot({ path: info.outputPath("colon-suggestions.png") });
  await expect(suggestions).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(suggestions).toBeHidden();
  await expect(editor).toContainText(":t");
  await page.keyboard.press("Backspace");
  await expect(suggestions).toBeHidden();
  await page.keyboard.type("tada");
  await expect(suggestions.getByRole("option").first()).toContainText(":tada:");
  await page.keyboard.press("Enter");
  await expect(suggestions).toBeHidden();
  await expect.poll(() => readFileSync(join(E2E_VAULT, note), "utf8"), { timeout: 15_000 }).toContain("🎉");
});

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
  const shortcode = `3d-printer-${info.project.name}`;
  await signIn(page);
  await page.goto(`/v/personal/${note}`);
  const editor = page.locator(".editor-surface .tiptap");
  await expect(editor).toContainText("A note this test may edit");
  const toggle = page.getByRole("button", { name: "Insert emoji", exact: true });
  await toggle.click();
  const picker = page.getByRole("dialog", { name: "Emoji picker", exact: true });
  await expect(picker.getByRole("button", { name: /Slack|Manage.*packs|Import emoji folder/i })).toHaveCount(0);
  const chooseFiles = page.getByRole("button", { name: "Import custom emoji from an image", exact: true });
  const choosing = page.waitForEvent("filechooser");
  await chooseFiles.click();
  const chooser = await choosing;
  // why: injecting files into a directory input bypasses the native chooser defect.
  expect(await chooser.element().getAttribute("webkitdirectory")).toBeNull();
  expect(chooser.isMultiple()).toBe(false);
  const prompts: string[] = [];
  page.on("dialog", async (dialog) => {
    prompts.push(dialog.message());
    expect(dialog.defaultValue()).toBe("filename-suggestion");
    await dialog.accept(shortcode);
  });
  await chooser.setFiles({
    name: "filename-suggestion.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  });
  const item = picker.getByRole("button", { name: `:${shortcode}:`, exact: true });
  await expect(item).toBeVisible();
  expect(prompts).toEqual(["Emoji shortcode"]);
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
  const rendered = editor.locator(`img[alt=":${shortcode}:"]`);
  await expect(rendered).toHaveCount(3);
  await expect.poll(() => rendered.evaluateAll((images) => images.every((image) => image instanceof HTMLImageElement && image.naturalWidth === 1))).toBe(true);
  const body = editor.locator(":scope > p").first();
  const bounds = await body.boundingBox();
  if (bounds === null) throw new Error("body paragraph missing");
  await body.click({ position: { x: bounds.width - 2, y: bounds.height / 2 } });
  await page.keyboard.type(` :${shortcode}:`);
  await expect(rendered).toHaveCount(4);
  await page.keyboard.type(" :3d");
  const suggestions = page.getByRole("listbox", { name: "Emoji suggestions", exact: true });
  const customOption = suggestions.getByRole("option").filter({ hasText: `:${shortcode}:` });
  await expect(customOption).toBeVisible();
  if (info.project.name === "mobile") await customOption.tap();
  else await customOption.click();
  await expect(rendered).toHaveCount(5);
  await expect.poll(() => readFileSync(join(E2E_VAULT, note), "utf8"), { timeout: 15_000 }).toContain(`:${shortcode}:A note this test may edit.`);
  expect(readFileSync(join(E2E_VAULT, note), "utf8").split(`\\:${shortcode}:`)).toHaveLength(2);
  await page.reload();
  await expect(rendered).toHaveCount(5);
  const inline = await editor.locator("h1").evaluate((heading) => {
    const image = heading.querySelector("img");
    const text = heading.firstChild;
    if (image === null || text === null) throw new Error("emoji heading is incomplete");
    const range = heading.ownerDocument.createRange(); range.selectNodeContents(text);
    const letters = range.getBoundingClientRect(); const artwork = image.getBoundingClientRect();
    return { display: getComputedStyle(image).display, overlaps: artwork.top < letters.bottom && artwork.bottom > letters.top };
  });
  expect(inline).toEqual({ display: "inline-block", overlaps: true });
  await openSidebar(page, "Navigation");
  const scratchFolder = page.getByRole("tree", { name: "Notes", exact: true }).getByRole("treeitem", { name: "Scratch", exact: true });
  if (await scratchFolder.getAttribute("aria-expanded") === "false") await scratchFolder.click();
  await expect(page.locator(`.tree-label img[alt=":${shortcode}:"]`).first()).toBeVisible();
  if (info.project.name === "mobile") await page.getByRole("button", { name: "Hide Navigation", exact: true }).click();
  else await expect(page.locator(`.tab-label img[alt=":${shortcode}:"]`)).toBeVisible();
  await page.screenshot({ path: info.outputPath("custom-emoji-in-note.png") });

});
