/** Excalidraw preview, editor activation, and export persistence (§13, §22.6). */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, signIn, test } from "./fixtures.js";
import { E2E_VAULT } from "./environment.js";

const EDITOR = ".editor-surface .tiptap";

test.describe.configure({ mode: "serial" });

test("renders a drawing preview and opens the full editor", async ({ page }, testInfo) => {
  await signIn(page);
  await page.goto(`/v/personal/Drawings/Host.${testInfo.project.name}.md`);
  await expect(page.locator(EDITOR)).toBeVisible();

  const drawing = page.locator(".note-drawing");
  await expect(drawing).toHaveAttribute("data-drawing-state", "ready");
  const preview = drawing.locator("[data-drawing-preview]");
  await expect(preview.locator("svg")).toBeVisible();
  expect((await preview.boundingBox())?.height ?? 0).toBeGreaterThan(0);

  await drawing.locator(".drawing-preview").click();
  await expect(drawing.locator(".excalidraw")).toBeVisible();
  await expect(drawing.locator("canvas").first()).toBeVisible();
});

test("saves Markdown and adjacent SVG/PNG exports after a drawing edit", async ({ page }, testInfo) => {
  let exports = 0;
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().includes("/drawing-exports/")) exports += 1;
  });
  await signIn(page);
  await page.goto(`/v/personal/Drawings/Host.${testInfo.project.name}.md`);
  const drawing = page.locator(".note-drawing");
  const source = join(E2E_VAULT, `drawings/Diagram.${testInfo.project.name}.excalidraw.md`);
  const before = readFileSync(source, "utf8");
  await drawing.locator(".drawing-preview").click();
  await expect(drawing.locator(".excalidraw")).toBeVisible();

  const canvas = drawing.locator("canvas.excalidraw__canvas.interactive");
  await canvas.click({ position: { x: 80, y: 80 } });

  await expect.poll(() => readFileSync(source, "utf8")).not.toBe(before);
  await expect.poll(() => exports).toBeGreaterThan(0);
  expect(existsSync(join(E2E_VAULT, `drawings/Diagram.${testInfo.project.name}.excalidraw.svg`))).toBe(true);
  expect(existsSync(join(E2E_VAULT, `drawings/Diagram.${testInfo.project.name}.excalidraw.png`))).toBe(true);
});
