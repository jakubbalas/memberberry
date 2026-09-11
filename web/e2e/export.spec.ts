/** Browser export coverage for `SPEC.md` §19.2. */

import { readFile } from "node:fs/promises";

import { expect, signIn, test } from "./fixtures.js";

test("prints one note and downloads its rendered standalone HTML", async ({ page }) => {
  await page.addInitScript(() => {
    window.print = (): void => {
      document.documentElement.dataset["printCalled"] = "true";
    };
  });
  await signIn(page);
  await page.goto("/v/personal/Welcome.md");
  const editor = page.locator(".editor-surface .tiptap");
  await expect(editor).toContainText("A note that already exists");

  await page.locator(".editor-more > summary").click();
  await page.getByRole("button", { name: "Print note or save it as PDF" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-print-called", "true");
  await expect(page.locator("body")).toHaveClass(/memberberry-printing/);
  await expect(page.locator(".editor-panel[data-printing='true']")).toHaveCount(1);
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await expect(page.locator("body")).not.toHaveClass(/memberberry-printing/);

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export note as self-contained HTML" }).click();
  const artifact = await download;
  const path = await artifact.path();
  expect(path).not.toBeNull();
  const html = await readFile(path ?? "", "utf8");
  expect(html).toContain("A note that already exists");
  expect(html).toContain("<style>");
  expect(html.slice(html.indexOf("<body"))).not.toContain("contenteditable");
  await expect(page.locator(".offline-status")).toContainText("Self-contained HTML exported");
});
