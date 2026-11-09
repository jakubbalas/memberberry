/**
 * The task inbox in a real browser (`SPEC.md` §10.3).
 *
 * What only a browser can say: that the pane is reachable, that groups render with real
 * layout, and that a row opens its source note. Grouping arithmetic for "today" / "this week"
 * is unit-tested with an injected calendar; the fixtures here use absolute dates that stay
 * overdue / later / undated for years.
 */

import { expect, signIn, test, openSidebar } from "./fixtures.js";

const EDITOR = ".editor-surface .tiptap";
const PANE = ".inbox-panel";

/** Opens the workspace with the Navigation sidebar showing, which is where the pane lives. */
async function openWithNavigation(page: import("@playwright/test").Page): Promise<void> {
  await signIn(page);
  await page.goto("/v/personal/Welcome.md");
  await expect(page.locator(EDITOR).first()).toBeVisible();
  await openSidebar(page, "Navigation");
  await page.getByRole("group", { name: "Navigation views" }).getByRole("button", { name: "Tasks", exact: true }).click();
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

test("draws a page of a large group and shows the rest on request", async ({ page }, testInfo) => {
  const folder = `Paged ${testInfo.project.name} ${Date.now()}`;
  await signIn(page);
  const tasks = Array.from({ length: 60 }, (_, index) => `- [ ] Paged task ${index}`).join("\n");
  expect((await page.request.post("/api/v1/vaults/personal/notes", { data: { path: `${folder}/Many.md`, content: `# Many\n\n${tasks}\n` } })).ok()).toBe(true);
  await page.goto("/v/personal/Welcome.md");
  await expect(page.locator(EDITOR).first()).toBeVisible();
  await openSidebar(page, "Navigation");
  await page.getByRole("group", { name: "Navigation views" }).getByRole("button", { name: "Tasks", exact: true }).click();
  const pane = page.locator(`#navigation-tasks ${PANE}`);
  await pane.getByRole("button", { name: "Filters", exact: true }).click();
  const field = pane.getByLabel("Filter by folder");
  await field.fill(folder);
  await field.blur();

  const undated = pane.locator('.inbox-group[data-group="no_date"]');
  await expect(undated.locator(".inbox-group-count")).toHaveText("60");
  await expect(undated.locator(".inbox-task-row")).toHaveCount(50);
  const more = undated.getByRole("button", { name: "Show 10 more no date tasks; 10 not shown", exact: true });
  await expect(more).toBeVisible();
  const box = await more.boundingBox();
  const paneBox = await pane.boundingBox();
  if (box === null || paneBox === null) throw new Error("Missing Show more geometry");
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.x + box.width).toBeLessThanOrEqual(paneBox.x + paneBox.width + 1);
  await more.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("inbox-show-more.png") });

  if (testInfo.project.name === "mobile") await more.tap();
  else await more.click();
  await expect(undated.locator(".inbox-task-row")).toHaveCount(60);
  await expect(undated.locator(".inbox-more")).toHaveCount(0);
});
