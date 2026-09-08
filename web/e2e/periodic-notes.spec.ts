/** Weekly and monthly note commands in a real browser (`SPEC.md` §15.1). */

import { CURRENT_PERIODIC_NOTES } from "./environment.js";
import { expect, signIn, test } from "./fixtures.js";

const EDITOR = ".editor-surface .tiptap";

async function openCommand(page: import("@playwright/test").Page, name: string): Promise<void> {
  await page.keyboard.press("ControlOrMeta+Shift+P");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await palette.getByRole("combobox").fill(name);
  await palette.getByRole("option", { name: new RegExp(name, "i") }).click();
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await page.goto("/v/personal/Welcome.md");
  await expect(page.locator(EDITOR).first()).toBeVisible();
});

test("opens this week's readable ISO-week note", async ({ page }) => {
  await openCommand(page, "Open this week’s note");
  await expect(page.getByRole("region", { name: `Note editor: ${CURRENT_PERIODIC_NOTES.weekly}` })).toBeVisible();
  await expect(page.locator(EDITOR).first()).toContainText("Current week");
});

test("opens this month's readable note", async ({ page }) => {
  await openCommand(page, "Open this month’s note");
  await expect(page.getByRole("region", { name: `Note editor: ${CURRENT_PERIODIC_NOTES.monthly}` })).toBeVisible();
  await expect(page.locator(EDITOR).first()).toContainText("Current month");
});
