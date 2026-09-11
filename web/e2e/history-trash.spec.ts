/** Version history and trash through the complete authenticated browser surface (`SPEC.md` §18). */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, signIn, test } from "./fixtures.js";
import { E2E_VAULT, scratchNote } from "./environment.js";

const EDITOR = ".editor-surface .tiptap";

async function showContext(page: import("@playwright/test").Page): Promise<void> {
  await expect(page.locator('.topbar .sidebar-toggle[data-side="right"]')).toBeVisible();
  const toggle = page.getByRole("button", { name: /^Show Context$/ });
  if (await toggle.isVisible()) await toggle.click();
  const history = page.getByRole("region", { name: "History", exact: true });
  if (!(await history.isVisible())) await page.locator(".notebook-section > summary").filter({ hasText: "Note history" }).click();
  await expect(history).toBeVisible();
}

async function hideMobileContext(page: import("@playwright/test").Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 0) > 640) return;
  const toggle = page.getByRole("button", { name: /^Hide Context$/ });
  if (await toggle.isVisible()) await toggle.click();
}

test("restores a saved version, then trashes and restores the Markdown note", async ({ page }, info) => {
  const note = scratchNote("history-trash", info.project.name);
  const path = join(E2E_VAULT, note);
  await signIn(page);
  await page.goto(`/v/personal/${note}`);

  const editor = page.locator(EDITOR).first();
  await editor.getByText("A note this test may edit.", { exact: true }).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("First saved version.");
  await expect.poll(() => readFileSync(path, "utf8"), { timeout: 15_000, intervals: [100] })
    .toContain("First saved version.");

  await page.reload();
  await showContext(page);
  const history = page.getByRole("region", { name: "History", exact: true });
  await expect(history.locator(".history-row")).toHaveCount(1);

  await hideMobileContext(page);
  await editor.getByText("A note this test may edit.", { exact: true }).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Unsnapshotted change.");
  await expect.poll(() => readFileSync(path, "utf8"), { timeout: 15_000, intervals: [100] })
    .toContain("Unsnapshotted change.");

  await showContext(page);
  await history.getByRole("button", { name: "Restore" }).click();
  await expect(history.getByRole("status")).toContainText("Version restored as an edit.");
  await expect.poll(() => readFileSync(path, "utf8"), { timeout: 15_000, intervals: [100] })
    .not.toContain("Unsnapshotted change.");

  await page.locator(".notebook-section > summary").filter({ hasText: "Deleted notes" }).click();
  const trash = page.getByRole("region", { name: "Trash", exact: true });
  page.once("dialog", (dialog) => void dialog.accept());
  await trash.getByRole("button", { name: "Move current note to trash" }).click();
  await expect(trash.getByRole("status")).toContainText("Note moved to trash.");
  const trashRow = trash.locator(".trash-row", { hasText: note });
  await expect(trashRow).toContainText(note);
  expect(() => readFileSync(path, "utf8")).toThrow();

  await trashRow.getByRole("button", { name: "Restore" }).click();
  await expect(trash.getByRole("status")).toContainText("Note restored.");
  await expect.poll(() => readFileSync(path, "utf8"), { timeout: 15_000, intervals: [100] })
    .toContain("First saved version.");
});
