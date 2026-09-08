/**
 * The task inbox in a real browser (`SPEC.md` §10.3).
 *
 * What only a browser can say: that the pane is reachable, that groups render with real
 * layout, and that a row opens its source note. Grouping arithmetic for "today" / "this week"
 * is unit-tested with an injected calendar; the fixtures here use absolute dates that stay
 * overdue / later / undated for years.
 */

import { expect, signIn, test } from "./fixtures.js";

const EDITOR = ".editor-surface .tiptap";
const PANE = ".inbox-panel";

/** Opens the workspace with the Navigation sidebar showing, which is where the pane lives. */
async function openWithNavigation(page: import("@playwright/test").Page): Promise<void> {
  await signIn(page);
  await page.goto("/v/personal/Welcome.md");
  await expect(page.locator(EDITOR).first()).toBeVisible();
  const toggle = page.getByRole("button", { name: /^Show Navigation$/ });
  if (await toggle.isVisible()) await toggle.click();
  await expect(page.locator(PANE)).toBeVisible();
}

test("groups open tasks and opens the source note from a row", async ({ page }) => {
  await openWithNavigation(page);

  const overdue = page.locator('.inbox-group[data-group="overdue"]');
  const later = page.locator('.inbox-group[data-group="later"]');
  const undated = page.locator('.inbox-group[data-group="no_date"]');
  // Assert on the row, not the pane: the heading alone would give the pane a height (§22.6).
  await expect(overdue.locator('.inbox-task[data-path="Inbox/Overdue.md"]')).toBeVisible();
  await expect(overdue).toContainText("Pay the invoice");
  await expect(later.locator('.inbox-task[data-path="Inbox/Later.md"]')).toBeVisible();
  await expect(undated.locator('.inbox-task[data-path="Inbox/Open.md"]')).toBeVisible();
  await expect(undated).toContainText("Capture the idea");
  await expect(page.locator(PANE)).not.toContainText("Already done");

  await overdue.locator('.inbox-task[data-path="Inbox/Overdue.md"]').click();
  await expect(page.locator(EDITOR).first()).toContainText("Pay the invoice");
});

test("filters by folder and sorts from labelled controls", async ({ page }) => {
  await openWithNavigation(page);

  await page.getByRole("button", { name: /^Filters$/ }).click();
  const folder = page.getByLabel("Filter by folder");
  await folder.fill("Inbox");
  await folder.blur();
  // Wait for a row that only the Inbox fixtures provide.
  await expect(page.locator('.inbox-task[data-path="Inbox/Overdue.md"]')).toBeVisible();
  await expect(page.locator('.inbox-task[data-path="Projects/Roadmap.md"]')).toHaveCount(0);

  await page.getByLabel("Sort tasks").selectOption("path");
  const paths = page.locator(".inbox-task");
  await expect(paths.first()).toHaveAttribute("data-path", /Inbox\//);
});

test("offers controls a finger can press", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "touch-floor assertion is for the phone layout");
  await openWithNavigation(page);

  await page.getByRole("button", { name: /^Filters$/ }).click();
  const controls = [
    page.getByLabel("Sort tasks"),
    page.getByRole("button", { name: /^Hide filters$/ }),
    page.getByLabel("Filter by folder"),
    page.locator('.inbox-task[data-path="Inbox/Overdue.md"]'),
  ];
  for (const control of controls) {
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    expect(box, "control should have a box").not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
});
