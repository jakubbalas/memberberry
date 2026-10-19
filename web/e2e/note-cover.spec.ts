import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, signIn, test } from "./fixtures.js";
import { E2E_VAULT, scratchNote } from "./environment.js";

test("uploads, positions, reloads and removes a Markdown-backed cover", async ({ page }, testInfo) => {
  await signIn(page);
  const note = scratchNote("note-cover", testInfo.project.name);
  await page.goto(`/v/personal/${note}`);
  await expect(page.locator(".editor-surface .tiptap")).toBeVisible();
  const empty = page.getByRole("region", { name: "Note cover", exact: true });
  const add = page.locator(".note-cover-menu > summary");
  const alignment = await add.evaluate(element => {
    const button = element.getBoundingClientRect();
    const area = element.closest(".note-cover")?.getBoundingClientRect();
    if (area === undefined) throw new Error("missing empty cover area");
    return { button: button.x + button.width / 2, area: area.x + area.width / 2 };
  });
  expect(Math.abs(alignment.button - alignment.area)).toBeLessThanOrEqual(1);
  if (testInfo.project.name === "desktop") {
    await page.mouse.move(0, 0);
    await expect(add).toHaveCSS("opacity", "0");
    await empty.hover();
    await expect(add).toHaveCSS("opacity", "1");
  }
  await add.click();
  await expect(page.getByRole("button", { name: "Paste from clipboard", exact: true })).toBeVisible();
  await page.evaluate(() => {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement) focused.blur();
  });
  await page.keyboard.press("Escape");
  await expect(page.locator(".note-cover-menu")).not.toHaveAttribute("open");
  await expect(add).toBeFocused();
  await add.click();
  const choices = page.locator(".note-cover-actions");
  const menuLayout = await choices.evaluate(element => {
    const files = element.querySelector("button")?.getBoundingClientRect();
    const clipboard = element.querySelectorAll("button")[1]?.getBoundingClientRect();
    const hint = element.querySelector(".note-cover-hint")?.getBoundingClientRect();
    if (!files || !clipboard || !hint) throw new Error("missing source options");
    return { stacked: clipboard.y >= files.y + files.height, buttonInset: files.x - hint.x, equalWidth: Math.abs(files.width - clipboard.width) <= 1 };
  });
  expect(menuLayout).toEqual({ stacked: true, buttonInset: 0, equalWidth: true });
  await page.locator(".tiptap p").first().click({ position: { x: 2, y: 2 } });
  await expect(page.locator(".note-cover-menu")).not.toHaveAttribute("open");
  await expect(choices).toBeHidden();
  await add.click();
  await page.screenshot({ path: testInfo.outputPath("cover-source-options.png"), fullPage: true });
  await page.getByRole("button", { name: "Choose from files", exact: true }).click();
  const landscape = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 1200; canvas.height = 500;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("canvas unavailable");
    const sky = context.createLinearGradient(0, 0, 0, 500);
    sky.addColorStop(0, "#6c91b5"); sky.addColorStop(1, "#efc5a1");
    context.fillStyle = sky; context.fillRect(0, 0, 1200, 500);
    context.fillStyle = "#f8e4bd"; context.beginPath(); context.arc(850, 140, 48, 0, Math.PI * 2); context.fill();
    for (const [offset, color] of [[0, "#6b7d8b"], [160, "#3d6067"]] as const) {
      context.fillStyle = color; context.beginPath(); context.moveTo(0, 500);
      context.lineTo(0, 300 + offset); context.lineTo(240, 140 + offset);
      context.lineTo(500, 340 + offset); context.lineTo(720, 220 + offset);
      context.lineTo(1000, 330 + offset); context.lineTo(1200, 260 + offset); context.lineTo(1200, 500); context.fill();
    }
    return canvas.toDataURL("image/png").split(",")[1] ?? "";
  });
  await page.getByLabel("Upload cover image").setInputFiles({
    name: "cover.png", mimeType: "image/png",
    buffer: Buffer.from(landscape, "base64"),
  });
  const cover = page.getByRole("img", { name: "Note cover", exact: true });
  await expect(cover).toBeVisible();
  await expect.poll(() => cover.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  const toggle = page.locator(".note-cover-menu > summary");
  const menu = page.locator(".note-cover-menu");
  await expect(menu).not.toHaveAttribute("open");
  await expect(page.getByRole("button", { name: "Remove cover", exact: true })).toBeHidden();
  await page.mouse.move(0, 0);
  if (testInfo.project.name === "desktop") {
    await expect(toggle).toHaveCSS("opacity", "0");
    await toggle.focus();
    await expect(toggle).toHaveCSS("opacity", "1");
    await toggle.press("Enter");
  } else {
    await expect(toggle).toHaveCSS("opacity", "1");
    await toggle.tap();
  }
  await expect(menu).toHaveAttribute("open", "");
  const position = page.getByRole("slider", { name: "Cover vertical position" });
  await position.focus();
  await position.press("Home");
  await expect(cover).toHaveCSS("object-position", "50% 0%");
  await expect.poll(() => readFileSync(join(E2E_VAULT, note), "utf8")).toMatch(/cover: media\/.*\.png/);
  await expect.poll(() => readFileSync(join(E2E_VAULT, note), "utf8")).toMatch(/cover_position: ["']?0/);
  const geometry = await cover.boundingBox();
  const title = await page.locator(".tiptap > h1").first().boundingBox();
  expect(geometry !== null && title !== null && geometry.y + geometry.height <= title.y).toBe(true);
  await page.reload();
  await expect(cover).toBeVisible();
  await expect(cover).toHaveCSS("object-position", "50% 0%");
  await expect(menu).not.toHaveAttribute("open");
  if (testInfo.project.name === "desktop") {
    await page.mouse.move(0, 0);
    await expect(toggle).toHaveCSS("opacity", "0");
    await cover.hover();
    await expect(toggle).toHaveCSS("opacity", "1");
  }
  await page.screenshot({ path: testInfo.outputPath("note-cover.png"), fullPage: true });
  await toggle.click();
  const previous = await cover.getAttribute("src");
  await page.getByRole("button", { name: "Change cover", exact: true }).click();
  await page.getByLabel("Upload cover image").setInputFiles({
    name: "replacement.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  });
  await expect(cover).not.toHaveAttribute("src", previous ?? "");
  await expect(cover).toHaveCSS("object-position", "50% 50%");
  await expect(menu).not.toHaveAttribute("open");
  await toggle.click();
  await position.focus();
  await position.press("Escape");
  await expect(menu).not.toHaveAttribute("open");
  await expect(toggle).toBeFocused();
  await toggle.press("Space");
  await page.getByRole("button", { name: "Remove cover", exact: true }).click();
  await expect(cover).toBeHidden();
  await expect.poll(() => readFileSync(join(E2E_VAULT, note), "utf8")).not.toContain("cover:");
  await expect(add).toHaveAttribute("aria-label", "Add cover");
  await add.focus();
  await add.press("Enter");
  await expect(page.getByRole("button", { name: "Choose from files", exact: true })).toBeVisible();
  await add.press("Escape");
  await expect(menu).not.toHaveAttribute("open");
  await page.screenshot({ path: testInfo.outputPath("empty-cover.png"), fullPage: true });

  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), character => character.charCodeAt(0));
    data.items.add(new File([bytes], "dropped.png", { type: "image/png" }));
    return data;
  });
  await page.locator(".editor-surface").dispatchEvent("dragenter", { dataTransfer: transfer });
  await expect(empty).toHaveAttribute("data-dragging", "true");
  await expect(page.getByText("Drop image to set cover", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("cover-drop-target.png"), fullPage: true });
  await empty.dispatchEvent("dragover", { dataTransfer: transfer });
  await empty.dispatchEvent("drop", { dataTransfer: transfer });
  await expect(empty).not.toHaveAttribute("data-dragging");
  await expect(cover).toBeVisible();
  await expect(page.locator(".tiptap img")).toHaveCount(0);
  await toggle.click();
  await page.getByRole("button", { name: "Remove cover", exact: true }).click();

  await add.focus();
  await add.evaluate((element, data) => {
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
  }, transfer);
  await expect(cover).toBeVisible();
  await expect(page.locator(".tiptap img")).toHaveCount(0);
  await transfer.dispose();
  await toggle.click();
  await page.getByRole("button", { name: "Remove cover", exact: true }).click();

  await page.evaluate(() => {
    // why: exercise the browser clipboard boundary without changing the user's OS clipboard.
    Object.defineProperty(navigator.clipboard, "read", { configurable: true, value: async () => [{
      types: ["image/png"], getType: async () => {
        const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), character => character.charCodeAt(0));
        return new Blob([bytes], { type: "image/png" });
      },
    }] });
  });
  await add.click();
  await page.getByRole("button", { name: "Paste from clipboard", exact: true }).click();
  await expect(cover).toBeVisible();
  await expect.poll(() => cover.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect.poll(() => readFileSync(join(E2E_VAULT, note), "utf8")).toMatch(/cover: media\//);
  const savedCover = await cover.getAttribute("src");
  const body = page.locator(".editor-surface .tiptap");
  await body.locator("p").first().click();
  await body.evaluate((element, png) => {
    const bytes = Uint8Array.from(atob(png), character => character.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "inline-landscape.png", { type: "image/png" }));
    element.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: data }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
  }, landscape);
  await expect(body.getByRole("img", { name: "inline-landscape.png", exact: true })).toBeVisible();
  await expect(cover).toHaveAttribute("src", savedCover ?? "");
  await expect(empty).not.toHaveAttribute("data-dragging");
});
