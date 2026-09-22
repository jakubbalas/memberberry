import type { Page } from "@playwright/test";

import { expect, signIn, test } from "./fixtures.js";

async function renderedColors(page: Page, source: string, size: number): Promise<number[][]> {
  return page.evaluate(async ({ source, size }) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas rendering is unavailable");
    context.drawImage(image, 0, 0, size, size);
    return [[0.1, 0.1], [0.5, 0.45], [0.3, 0.55], [0.5, 0.72], [0.6, 0.24]].map(
      ([horizontal = 0, vertical = 0]) => Array.from(
        context.getImageData(Math.floor(size * horizontal), Math.floor(size * vertical), 1, 1).data,
      ),
    );
  }, { source, size });
}

const berryColors = [
  [102, 81, 163, 255],
  [102, 81, 163, 255],
  [247, 247, 245, 255],
  [247, 247, 245, 255],
  [247, 247, 245, 255],
];

test("sign-in favicon renders the bookmark berry at tab and app sizes", async ({ page }) => {
  await page.goto("/");
  const source = await page.locator('link[rel="icon"]').getAttribute("href");
  if (source === null) throw new Error("Sign-in favicon is missing");
  for (const size of [16, 32, 192]) {
    const colors = (await renderedColors(page, source, size)).flat();
    for (const [index, channel] of berryColors.flat().entries()) {
      // why: the leaf spans fractional pixels at tab sizes, so rasterization blends its edge.
      expect(Math.abs((colors[index] ?? -255) - channel), `favicon at ${size}px, channel ${index}`).toBeLessThanOrEqual(12);
    }
  }
});

test("editor and installed app share the bookmark berry offline", async ({ page, context }, testInfo) => {
  await signIn(page);
  await page.goto("/v/personal/Welcome.md");
  const source = await page.locator('link[rel="icon"]').getAttribute("href");
  if (source === null) throw new Error("Editor favicon is missing");
  const manifest = await page.request.get("/manifest.webmanifest");
  expect(await manifest.json()).toMatchObject({
    theme_color: "#6651a3",
    icons: [{ src: source, purpose: "any" }, { src: source, purpose: "maskable" }],
  });
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller === null) {
      await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener(
        "controllerchange", () => resolve(), { once: true },
      ));
    }
  });
  await context.setOffline(true);
  expect(await renderedColors(page, source, 192)).toEqual(berryColors);
  await page.evaluate((source) => {
    document.body.replaceChildren();
    for (const size of [16, 32, 192]) {
      const image = document.createElement("img");
      image.src = source;
      image.width = size;
      image.height = size;
      image.alt = `Memberberry at ${size}px`;
      document.body.append(image);
    }
  }, source);
  await expect(page.getByRole("img", { name: "Memberberry at 192px", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("bookmark-berry.png") });
});
