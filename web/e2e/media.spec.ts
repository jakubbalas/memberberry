/** Media upload, browser downscaling, thumbnail rendering, and C2 persistence (§12). */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { expect, signIn, test } from "./fixtures.js";
import { E2E_VAULT, scratchNote } from "./environment.js";

const EDITOR = ".editor-surface .tiptap";

test("downscales an image, retains its original, and renders an authorized thumbnail", async ({ page }, testInfo) => {
  let uploads = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/v1/vaults/personal/media")) {
      uploads += 1;
    }
  });
  await signIn(page);
  const note = scratchNote("media", testInfo.project.name);
  await page.goto(`/v/personal/${note}`);
  await expect(page.locator(EDITOR)).toBeVisible();

  const picker = page.locator('input[type="file"][accept*="application/pdf"]');
  await picker.evaluate(async (element) => {
    const canvas = document.createElement("canvas");
    canvas.width = 3000;
    canvas.height = 1500;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("canvas unavailable");
    context.fillStyle = "#7c3aed";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => value === null ? reject(new Error("PNG encoding failed")) : resolve(value), "image/png");
    });
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], "large.png", { type: "image/png" }));
    const input = element as HTMLInputElement;
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

  await expect.poll(() => uploads).toBe(2);
  const image = page.locator(`${EDITOR} img`).last();
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(2560);
  const imageWidth = await image.evaluate((element) => element.getBoundingClientRect().width);
  const editorWidth = await page.locator(EDITOR).evaluate((element) => element.getBoundingClientRect().width);
  expect(imageWidth).toBeLessThanOrEqual(editorWidth);

  await page.getByRole("button", { name: "Toggle Markdown source view" }).click();
  await expect(page.locator(".source-view")).toBeVisible();
  await page.getByRole("button", { name: "Toggle Markdown source view" }).click();
  await expect(image).toBeVisible();

  await image.click();
  const edit = page.getByRole("button", { name: "Edit selected image" });
  await expect(edit).toBeEnabled();
  await edit.click();
  await expect(page.getByRole("dialog", { name: "Edit image" })).toBeVisible();
  await page.getByRole("button", { name: "Rotate right" }).click();
  await page.getByRole("button", { name: "Save edited display" }).click();
  await expect(page.getByRole("dialog", { name: "Edit image" })).toBeHidden();
  await expect(image).toBeVisible();

  const notePath = join(E2E_VAULT, note);
  await expect.poll(() => readFileSync(notePath, "utf8")).toMatch(/!\[large\.png\]\(media\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}\.png\)/);
  const markdown = readFileSync(notePath, "utf8");
  const display = /\((media\/[a-f0-9/]+\.png)\)/.exec(markdown)?.[1];
  expect(display, "Markdown media path").toBeDefined();
  const originals = JSON.parse(readFileSync(join(E2E_VAULT, ".memberberry/media-originals.json"), "utf8")) as Record<string, unknown>;
  const original = display === undefined ? undefined : originals[display];
  expect(typeof original).toBe("string");
  expect(existsSync(join(E2E_VAULT, String(original)))).toBe(true);
  expect(statSync(join(E2E_VAULT, String(original))).size).toBeGreaterThan(
    statSync(join(E2E_VAULT, String(display))).size,
  );
});

test("inserts an image dragged from the desktop", async ({ page }, testInfo) => {
  await signIn(page);
  const note = scratchNote("media-drop", testInfo.project.name);
  await page.goto(`/v/personal/${note}`);
  await expect(page.locator(EDITOR)).toBeVisible();

  await page.locator(EDITOR).evaluate((element) => {
    const bytes = Uint8Array.from(atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    ), (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "desktop.png", { type: "" }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(page.locator(`${EDITOR} img`).last()).toBeVisible();
});

test("queues an offline image and swaps its blob URL after reconnection", async ({ page, failures }, testInfo) => {
  failures.allow(/request failed: POST .*\/api\/v1\/vaults\/personal\/media/);
  failures.allow(/console error: Failed to load resource: net::ERR_INTERNET_DISCONNECTED/);
  await signIn(page);
  const note = scratchNote("media-offline", testInfo.project.name);
  await page.goto(`/v/personal/${note}`);
  await expect(page.locator(EDITOR)).toBeVisible();
  const endpoint = "**/api/v1/vaults/personal/media";
  await page.route(endpoint, (route) => route.abort("internetdisconnected"));
  const picker = page.locator('input[type="file"][accept*="application/pdf"]');
  await picker.setInputFiles({
    name: "offline.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  });
  const image = page.locator(`${EDITOR} img`).last();
  await expect(image).toHaveAttribute("src", /^blob:/);
  await expect(page.locator(".offline-status").last()).toContainText("queued", { ignoreCase: true });

  await page.unroute(endpoint);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(image).toHaveAttribute("src", /\/api\/v1\/vaults\/personal\/media\/media\//);
  await expect(image).toBeVisible();
  await expect.poll(() => readFileSync(join(E2E_VAULT, note), "utf8")).toContain("![offline.png](media/");
});
