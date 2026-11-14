/** Version history and trash through the complete authenticated browser surface (`SPEC.md` §18). */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { expect, signIn, test, openSidebar } from "./fixtures.js";
import { E2E_VAULT, scratchNote } from "./environment.js";

const EDITOR = ".editor-surface .tiptap";

async function appendAfter(page: Page, paragraph: Locator, text: string): Promise<void> {
  await expect(paragraph).toBeVisible();
  const bounds = await paragraph.boundingBox();
  if (bounds === null) throw new Error("The paragraph must be laid out before placing the caret");
  await paragraph.click({ position: { x: bounds.width - 2, y: bounds.height - 2 } });
  await page.keyboard.press("Enter");
  await page.keyboard.type(text);
}

async function showContext(page: import("@playwright/test").Page): Promise<void> {
  await expect(page.locator('.topbar .sidebar-toggle[data-side="right"]')).toBeVisible();
  await openSidebar(page, "Context");
  const history = page.getByRole("region", { name: "History", exact: true });
  if (!(await history.isVisible())) await page.locator(".notebook-section > summary").filter({ hasText: "Note history" }).click();
  await expect(history).toBeVisible();
}

async function hideMobileContext(page: import("@playwright/test").Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 0) > 640) return;
  // why: on a phone the context sheet covers the note. This used to *open* it instead, and
  // only passed while the sheet was short enough to leave the text it clicks reachable.
  const toggle = page.getByRole("button", { name: "Hide Context", exact: true });
  if (await toggle.isVisible()) await toggle.click();
  await expect(page.getByRole("button", { name: "Show Context", exact: true })).toBeVisible();
}

test("restores a saved version, then trashes and restores the Markdown note", async ({ page, isMobile }, info) => {
  if (isMobile) {
    await page.addInitScript(() => {
      document.addEventListener("keydown", (event) => {
        if (event.key === "End") {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      }, { capture: true });
    });
  }
  const note = scratchNote("history-trash", info.project.name);
  const path = join(E2E_VAULT, note);
  await signIn(page);
  await page.goto(`/v/personal/${note}`);

  const editor = page.locator(EDITOR).first();
  await editor.getByText("A note this test may edit.", { exact: true }).click({ position: { x: 50, y: 8 } });
  await appendAfter(page, editor.getByText("A note this test may edit.", { exact: true }), "First saved version.");
  await expect.poll(() => readFileSync(path, "utf8"), { timeout: 15_000, intervals: [100] })
    .toContain("First saved version.");
  expect(readFileSync(path, "utf8")).toContain("A note this test may edit.");
  const savedVersion = readFileSync(path, "utf8");

  await page.reload();
  await expect(editor).toContainText("First saved version.");
  await showContext(page);
  const history = page.getByRole("region", { name: "History", exact: true });
  await expect(history.locator(".history-row")).toHaveCount(1);

  await hideMobileContext(page);
  await appendAfter(page, editor.getByText("First saved version.", { exact: true }), "Unsnapshotted change.");
  await expect.poll(() => readFileSync(path, "utf8"), { timeout: 15_000, intervals: [100] })
    .toContain("Unsnapshotted change.");

  await showContext(page);
  await history.getByRole("button", { name: "Restore" }).click();
  await expect(history.getByRole("status")).toContainText("Version restored as an edit.");
  await expect.poll(() => readFileSync(path, "utf8"), { timeout: 15_000, intervals: [100] })
    .toBe(savedVersion);

  await page.locator(".notebook-section > summary").filter({ hasText: "Deleted notes" }).click();
  const trash = page.getByRole("region", { name: "Trash", exact: true });
  await trash.getByRole("button", { name: "Move current note to trash" }).click();
  await page.getByRole("dialog", { name: "Move note to trash?", exact: true })
    .getByRole("button", { name: "Move to trash", exact: true }).click();
  await expect(trash.getByRole("status")).toContainText("Note moved to trash.");
  const trashRow = trash.locator(".trash-row", { hasText: note });
  await expect(trashRow).toContainText(note);
  expect(() => readFileSync(path, "utf8")).toThrow();

  await trashRow.getByRole("button", { name: "Restore" }).click();
  await expect(trash.getByRole("status")).toContainText("Note restored.");
  await expect.poll(() => readFileSync(path, "utf8"), { timeout: 15_000, intervals: [100] })
    .toBe(savedVersion);
});
